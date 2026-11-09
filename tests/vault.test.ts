import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vault } from '../core/vault';
import { startBroker } from '../core/broker';
import { callBroker } from '../agent/client';
import { destination, isPublicAddress, secretHeaders, type SendOperation } from '../core/transport';
import { publicError } from '../core/schema';
import type { ItemInput, OperationInput } from '../shared/contracts';

const password = 'a test passphrase not for real use';
const secret = 'test-only-canary-9e55e8';
const item: ItemInput = {
  name: 'example-key',
  kind: 'secret',
  fields: [{ name: 'value', value: secret }],
};
const operation: OperationInput = {
  name: 'trigger-job',
  item: item.name,
  url: 'https://api.example.com/v1/jobs',
  method: 'POST',
  auth: 'headers',
  bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
  body: '{"job":"example"}',
};
function fixture(t: TestContext, send: SendOperation = async () => 202): Vault {
  const directory = mkdtempSync(join(tmpdir(), 'ak-'));
  const vault = new Vault(directory, send);
  t.after(() => {
    vault.lock();
    rmSync(directory, { recursive: true, force: true });
  });
  vault.initialize(password);
  vault.saveItem(item);
  vault.saveOperation(operation);
  return vault;
}

test('values stay encrypted on disk and absent from all snapshots', (t) => {
  const vault = fixture(t);
  const disk = readFileSync(vault.storage.path, 'utf8');
  assert.ok(!disk.includes(secret));
  assert.ok(!disk.includes(item.name));
  assert.ok(!JSON.stringify(vault.snapshot()).includes(secret));
  assert.ok(!JSON.stringify(vault.snapshot()).includes('"job"'));
  if (process.platform !== 'win32') assert.equal(statSync(vault.storage.path).mode & 0o777, 0o600);
  vault.lock();
  assert.equal(vault.snapshot().items.length, 0);
  assert.throws(() => vault.unlock('wrong password'), /Unable to unlock/);
  vault.unlock(password);
  assert.equal(vault.snapshot().items[0]?.fields[0], 'value');
});

test('tampering and malformed envelopes fail closed', (t) => {
  const vault = fixture(t);
  const envelope = JSON.parse(readFileSync(vault.storage.path, 'utf8'));
  envelope.tag = '00'.repeat(16);
  writeFileSync(vault.storage.path, JSON.stringify(envelope));
  assert.throws(() => vault.unlock(password), /Unable to unlock/);
  assert.equal(vault.snapshot().unlocked, false);
});

test('no request before approval; once is consumed even on failure', async (t) => {
  let sends = 0;
  const vault = fixture(t, async () => {
    sends++;
    throw new Error(secret);
  });
  await assert.rejects(vault.run(operation.name), /Approval required/);
  assert.equal(sends, 0);
  assert.equal(vault.requestAccess(operation.name).state, 'awaiting-approval');
  vault.requestAccess(operation.name);
  assert.equal(vault.snapshot().pending.length, 1);
  vault.approve(operation.name, 'once');
  await assert.rejects(
    vault.run(operation.name),
    (error: unknown) => !publicError(error).includes(secret),
  );
  await assert.rejects(vault.run(operation.name), /Approval required/);
  assert.equal(sends, 1);
});

test('single-use approval cannot be replayed by concurrent requests', async (t) => {
  let sends = 0;
  const vault = fixture(t, async () => {
    sends++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 204;
  });
  vault.approve(operation.name, 'once');
  const results = await Promise.allSettled([vault.run(operation.name), vault.run(operation.name)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(sends, 1);
});

test('repeat grants survive unlock, but revocation and rotation end access', async (t) => {
  const vault = fixture(t, async (_operation, headers) => {
    assert.equal(headers['authorization'], `Bearer ${secret}`);
    return 202;
  });
  vault.approve(operation.name, 'until-revoked');
  await vault.run(operation.name);
  vault.lock();
  await assert.rejects(vault.run(operation.name), /Unlock/);
  vault.unlock(password);
  assert.deepEqual(await vault.run(operation.name), {
    operation: operation.name,
    status: 202,
    successful: true,
  });
  vault.revoke(operation.name);
  await assert.rejects(vault.run(operation.name), /Approval required/);
  vault.approve(operation.name, 'day');
  vault.saveItem({ ...item, fields: [{ name: 'value', value: 'rotated-test-value' }] });
  await assert.rejects(vault.run(operation.name), /Approval required/);
});

test('operation changes invalidate grants and item deletion cascades', async (t) => {
  const vault = fixture(t);
  vault.approve(operation.name, 'hour');
  vault.saveOperation({ ...operation, url: 'https://api.example.com/v2/jobs' });
  await assert.rejects(vault.run(operation.name), /Approval required/);
  vault.approve(operation.name, 'hour');
  vault.deleteItem(item.name);
  assert.equal(vault.snapshot().operations.length, 0);
  assert.equal(vault.snapshot().grants.length, 0);
});

test('expiry is checked at execution, not only when access was requested', async (t) => {
  const vault = fixture(t);
  const now = Date.now();
  vault.approve(operation.name, 'hour');
  t.mock.method(Date, 'now', () => now + 3_600_001);
  await assert.rejects(vault.run(operation.name), /Approval required/);
});

test('locking aborts an active request and suppresses its late result', async (t) => {
  let finish!: (status: number) => void;
  let signal!: AbortSignal;
  const vault = fixture(t, (_operation, _headers, currentSignal) => {
    signal = currentSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  vault.approve(operation.name, 'until-revoked');
  const result = vault.run(operation.name);
  vault.lock();
  assert.equal(signal.aborted, true);
  vault.unlock(password);
  finish(200);
  await assert.rejects(result, /Access ended/);
});

test('login and grouped field values are only used in bound headers', (t) => {
  const vault = fixture(t);
  const login: ItemInput = {
    name: 'login',
    kind: 'login',
    fields: [
      { name: 'username', value: 'test-user' },
      { name: 'password', value: secret },
    ],
  };
  vault.saveItem(login);
  assert.equal(
    secretHeaders({ ...operation, item: 'login', auth: 'basic', bindings: [] }, login)[
      'authorization'
    ],
    `Basic ${Buffer.from(`test-user:${secret}`).toString('base64')}`,
  );
  vault.saveItem({
    name: 'group',
    kind: 'group',
    fields: [
      { name: 'FIRST', value: 'one' },
      { name: 'SECOND', value: 'two' },
    ],
  });
  assert.deepEqual(vault.snapshot().items.find((entry) => entry.name === 'group')?.fields, [
    'FIRST',
    'SECOND',
  ]);
  assert.throws(
    () =>
      vault.saveItem({
        ...item,
        fields: [
          { name: 'value', value: 'a' },
          { name: 'value', value: 'b' },
        ],
      }),
    /Invalid input/,
  );
});

test('unsafe destinations, header injection, missing fields and GET bodies are rejected', (t) => {
  const vault = fixture(t);
  for (const url of [
    'http://example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://user:password@example.com',
    'https://api.example.com:444/',
    'https://example.com/#fragment',
  ]) {
    assert.throws(() => vault.saveOperation({ ...operation, url }));
  }
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.0.2',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '100.64.0.1',
    '224.0.0.1',
  ])
    assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(destination('https://api.example.com/v1').hostname, 'api.example.com');
  assert.throws(() => vault.saveOperation({ ...operation, method: 'GET' }));
  assert.throws(() =>
    vault.saveOperation({
      ...operation,
      bindings: [{ header: 'Host', field: 'value', prefix: '' }],
    }),
  );
  assert.throws(() =>
    secretHeaders(operation, {
      ...item,
      fields: [{ name: 'value', value: 'test\r\nX-Evil: yes' }],
    }),
  );
});

test('agent boundary rejects admin operations and extra request arguments', async (t) => {
  const vault = fixture(t);
  for (const action of ['approve', 'unlock', 'get-secret', 'exec', 'save-item'])
    await assert.rejects(vault.dispatch({ action }));
  await assert.rejects(
    vault.dispatch({ action: 'run', operation: operation.name, url: 'https://attacker.example' }),
  );
});

test('real local broker and stdio MCP round trip never return a canary secret', async (t) => {
  const vault = fixture(t);
  const broker = await startBroker(vault);
  const client = new Client({ name: 'agentkey-test', version: '1.0.0' });
  try {
    const status = await callBroker(vault.storage.directory, { action: 'status' });
    assert.equal(status.ok, true);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/agent/cli.js'), 'mcp', '--data-dir', vault.storage.directory],
        stderr: 'pipe',
      }),
    );
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    assert.ok(tools.some((tool) => tool.name === 'agentkey_propose_command'));
    assert.ok(tools.some((tool) => tool.name === 'agentkey_run_command'));
    assert.ok(tools.some((tool) => tool.name === 'agentkey_wait_for_approval'));
    assert.ok(tools.some((tool) => tool.name === 'agentkey_propose_operation'));
    assert.ok(!tools.some((tool) => /get_secret|approve|unlock/.test(tool.name)));
    for (const name of ['agentkey_status', 'agentkey_list_items', 'agentkey_list_operations']) {
      const result = await client.callTool({ name, arguments: {} });
      assert.ok(!JSON.stringify(result).includes(secret));
    }
    const requested = await client.callTool({
      name: 'agentkey_request_access',
      arguments: { operation: operation.name },
    });
    assert.ok(JSON.stringify(requested).includes('awaiting-approval'));
    vault.approve(operation.name, 'once');
    const result = await client.callTool({
      name: 'agentkey_run_operation',
      arguments: { operation: operation.name },
    });
    assert.ok(JSON.stringify(result).includes('202'));
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(
      (
        await client.callTool({
          name: 'agentkey_run_operation',
          arguments: { operation: operation.name },
        })
      ).isError,
      true,
    );
  } finally {
    await client.close();
    await broker.close();
  }
});
