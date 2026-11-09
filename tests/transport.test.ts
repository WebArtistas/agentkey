import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createConnection } from 'node:net';
import { sendOperation } from '../core/transport';
import { Vault } from '../core/vault';
import { startBroker } from '../core/broker';
import type { OperationInput } from '../shared/contracts';

const operation: OperationInput = {
  name: 'check',
  item: 'key',
  url: 'https://api.example.com/status?mode=check',
  method: 'GET',
  auth: 'headers',
  bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
  body: '',
};

test('transport refuses a mixed public/private DNS answer before sending', async (t) => {
  t.mock.method(dns, 'lookup', async () => [
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  const send = t.mock.method(https, 'request', () => {
    throw new Error('Network must not be reached');
  });
  await assert.rejects(
    sendOperation(operation, { authorization: 'test-only' }, new AbortController().signal),
    /private or reserved/,
  );
  assert.equal(send.mock.callCount(), 0);
});

test('transport pins validated DNS with original TLS identity and discards redirects/bodies', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }]);
  let destroyed = false;
  let count = 0;
  t.mock.method(
    https,
    'request',
    (options: https.RequestOptions, respond: (response: unknown) => void) => {
      count++;
      assert.equal(options.hostname, '1.1.1.1');
      assert.equal(options.servername, 'api.example.com');
      assert.equal(options.path, '/status?mode=check');
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      assert.deepEqual(options.headers, {
        authorization: 'Bearer synthetic',
        host: 'api.example.com',
        'accept-encoding': 'identity',
      });
      const request = new EventEmitter();
      Object.assign(request, {
        end: () => {
          respond({
            statusCode: 302,
            headers: { location: 'https://evil.example/steal', 'x-echo': 'synthetic' },
            destroy: () => {
              destroyed = true;
            },
          });
        },
      });
      return request;
    },
  );
  assert.equal(
    await sendOperation(
      operation,
      { authorization: 'Bearer synthetic' },
      new AbortController().signal,
    ),
    302,
  );
  assert.equal(count, 1);
  assert.equal(destroyed, true);
});

test('revocation during DNS lookup prevents a later connection', async (t) => {
  let resolveLookup!: (value: { address: string; family: number }[]) => void;
  t.mock.method(
    dns,
    'lookup',
    () =>
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
  );
  const send = t.mock.method(https, 'request', () => {
    throw new Error('Must not connect');
  });
  const controller = new AbortController();
  const result = sendOperation(operation, { authorization: 'synthetic' }, controller.signal);
  controller.abort();
  await assert.rejects(result, /cancelled/);
  resolveLookup([{ address: '1.1.1.1', family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(send.mock.callCount(), 0);
});

test('a persistence failure locks the vault instead of retaining usable approval state', async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'ak-disk-'));
  const vault = new Vault(directory, async () => 200);
  t.after(() => {
    vault.lock();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  vault.initialize('synthetic-test-passphrase');
  vault.saveItem({ name: 'key', kind: 'secret', fields: [{ name: 'value', value: 'synthetic' }] });
  vault.saveOperation(operation);
  vault.approve('check', 'until-revoked');
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('Synthetic disk failure');
  });
  assert.throws(() => vault.revoke('check'), /vault was locked/);
  assert.equal(vault.snapshot().unlocked, false);
  await assert.rejects(vault.run('check'), /Unlock/);
});

test('broker rejects forged capabilities and privileged commands', async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'ak-broker-'));
  const vault = new Vault(directory);
  t.after(() => {
    vault.lock();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const broker = await startBroker(vault);
  try {
    const descriptor = JSON.parse(
      fs.readFileSync(join(directory, 'agent-connection.json'), 'utf8'),
    );
    const exchange = (request: unknown): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = createConnection(descriptor.endpoint);
        let output = '';
        socket.setTimeout(2000, () => {
          socket.destroy();
          reject(new Error('Timed out'));
        });
        socket.on('error', reject);
        socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on('data', (data) => {
          output += data.toString();
        });
        socket.on('end', () => resolve(output));
      });
    assert.equal(
      JSON.parse(await exchange({ token: '00'.repeat(32), command: { action: 'status' } })).ok,
      false,
    );
    assert.equal(
      JSON.parse(
        await exchange({
          token: descriptor.token,
          command: { action: 'approve', operation: 'check' },
        }),
      ).ok,
      false,
    );
  } finally {
    await broker.close();
  }
});
