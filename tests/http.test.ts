import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vault } from '../core/vault';
import { projectResponse, resolveHttpRequest, validateResponseFields } from '../core/http-policy';
import { validateOperation, type SendOperation } from '../core/transport';
import { startBroker } from '../core/broker';
import type { OperationInput } from '../shared/contracts';

const secret = 'synthetic-http-secret-92847';
const item = {
  name: 'service-key',
  kind: 'secret' as const,
  fields: [{ name: 'value', value: secret }],
};
const operation: OperationInput = {
  name: 'catalog',
  item: item.name,
  method: 'GET',
  url: 'https://api.example.com/v1/products',
  auth: 'headers',
  bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
  body: '',
  responseFields: ['data[].id', 'data[].name'],
};
function fixture(
  t: TestContext,
  send: SendOperation = async () => ({
    status: 200,
    body: { data: [{ id: 'prod_1', name: 'Demo' }] },
  }),
) {
  const directory = mkdtempSync(join(tmpdir(), 'ak-http-'));
  const vault = new Vault(directory, send);
  t.after(() => {
    vault.lock();
    rmSync(directory, { recursive: true, force: true });
  });
  vault.initialize('synthetic-http-master-passphrase');
  vault.saveItem(item);
  return vault;
}
function proposal(vault: Vault, input = operation) {
  vault.proposeOperation(input);
  return vault.snapshot().proposals[0]!;
}

test('proposals are inert, bounded, coalesced, immutable and unavailable through agent metadata', async (t) => {
  let sends = 0;
  const vault = fixture(t, async () => {
    sends++;
    return 200;
  });
  const pending = proposal(vault);
  assert.equal(vault.snapshot().operations.length, 0);
  await assert.rejects(vault.run('catalog'), /Unknown/);
  assert.throws(() => vault.approve('catalog', 'once'), /Unknown/);
  assert.throws(
    () => vault.proposeOperation({ ...operation, scope: { paths: ['/'], methods: ['GET'] } }),
    /Invalid/,
  );
  proposal(vault);
  assert.equal(vault.snapshot().proposals.length, 1);
  assert.throws(
    () => proposal(vault, { ...operation, url: 'https://evil.example/x' }),
    /different request/,
  );
  assert.equal(vault.snapshot().proposals[0]!.revision, pending.revision);
  assert.equal(JSON.stringify(await vault.dispatch({ action: 'list-operations' })), '[]');
  assert.ok(!JSON.stringify(vault.snapshot()).includes(secret));
  for (let i = 1; i < 32; i++) vault.proposeOperation({ ...operation, name: `request-${i}` });
  assert.throws(() => vault.proposeOperation({ ...operation, name: 'overflow' }), /Too many/);
  vault.dismissProposal(pending.revision);
  assert.throws(
    () =>
      vault.approveProposal({
        revision: pending.revision,
        duration: 'once',
        dataSharingAccepted: true,
      }),
    /expired/,
  );
  assert.equal(sends, 0);
});

test('approval atomically saves an exact request, requires consent and allows one attempt', async (t) => {
  const vault = fixture(t, async (sent, headers) => {
    assert.equal(sent.url, operation.url);
    assert.equal(headers.authorization, `Bearer ${secret}`);
    return {
      status: 200,
      body: { data: [{ id: 'prod_1', name: secret, private: 'not approved' }], ignored: secret },
    };
  });
  const pending = proposal(vault);
  const approval = { revision: pending.revision, duration: 'once', dataSharingAccepted: true };
  assert.throws(
    () => vault.approveProposal({ ...approval, dataSharingAccepted: false }),
    /Consent/,
  );
  assert.equal(vault.snapshot().operations.length, 0);
  vault.approveProposal(approval);
  assert.throws(() => vault.approveProposal(approval), /expired/);
  await assert.rejects(
    vault.run('catalog', { url: operation.url, method: 'GET', body: '' }),
    /only the saved exact/,
  );
  const [first, replay] = await Promise.allSettled([vault.run('catalog'), vault.run('catalog')]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(replay.status, 'rejected');
  if (first.status === 'fulfilled') {
    assert.deepEqual(JSON.parse(JSON.stringify(first.value.data)), {
      'data[].id': ['prod_1'],
      'data[].name': ['[REDACTED]'],
    });
    assert.ok(!JSON.stringify(first.value).includes(secret));
    assert.ok(!JSON.stringify(first.value).includes('private'));
  }
  assert.ok(!readFileSync(join(vault.storage.directory, 'vault.json'), 'utf8').includes(secret));
});

test('proposal approval rejects stale item rotations, locks, expiry and saved-name collisions', (t) => {
  const vault = fixture(t);
  const approve = (revision: string) =>
    vault.approveProposal({ revision, duration: 'once', dataSharingAccepted: true });
  let pending = proposal(vault);
  vault.saveItem({ ...item, fields: [{ name: 'value', value: 'rotated-synthetic-secret' }] });
  assert.throws(() => approve(pending.revision), /expired/);
  pending = proposal(vault);
  vault.lock();
  vault.unlock('synthetic-http-master-passphrase');
  assert.throws(() => approve(pending.revision), /expired/);
  pending = proposal(vault);
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 600_001);
  assert.throws(() => approve(pending.revision), /expired/);
  clock.mock.restore();
  pending = proposal(vault);
  vault.saveOperation({ ...operation, url: 'https://api.example.com/changed' });
  assert.throws(() => approve(pending.revision), /now has a policy/);
  assert.throws(() => vault.proposeOperation(operation), /cannot replace/);
});

test('advanced permissions constrain origin, path boundaries and methods while fixing auth and output', async (t) => {
  const vault = fixture(t, async (sent) => {
    assert.equal(sent.body, 'name=Updated');
    assert.equal(sent.bodyFormat, 'form');
    assert.deepEqual(sent.responseFields, ['id']);
    return { status: 200, body: { id: 'prod_2', ignored: 'no' } };
  });
  const input: OperationInput = {
    ...operation,
    method: 'POST',
    bodyFormat: 'form',
    body: 'name=Demo',
    responseFields: ['id'],
  };
  const pending = proposal(vault, input);
  vault.approveProposal({
    revision: pending.revision,
    duration: 'hour',
    dataSharingAccepted: true,
    scope: { paths: ['/v1/products', '/v1/products/*'], methods: ['GET', 'POST'] },
  });
  const request = {
    method: 'POST',
    url: 'https://api.example.com/v1/products/prod_2?expand=name',
    body: 'name=Updated',
  };
  const result = await vault.dispatch({ action: 'run', operation: 'catalog', request });
  assert.ok(JSON.stringify(result).includes('prod_2'));
  for (const url of [
    'http://api.example.com/v1/products',
    'https://evil.example/v1/products',
    'https://api.example.com:8443/v1/products',
    'https://api.example.com/v1/products-evil',
    'https://api.example.com/v1/products/../customers',
    'https://api.example.com/v1/products/%2e%2e/customers',
    'https://api.example.com/v1/products/%2Fcustomers',
    'https://api.example.com/v1/products//extra',
    'https://user:password@api.example.com/v1/products',
    'https://api.example.com/v1/products#fragment',
    'https://api.example.com/v1/products\\..\\customers',
  ])
    await assert.rejects(vault.run('catalog', { ...request, url }), /outside/);
  await assert.rejects(vault.run('catalog', { ...request, method: 'DELETE' }), /outside/);
  await assert.rejects(vault.run('catalog', { ...request, bindings: [] }), /Invalid/);
  vault.revoke('catalog');
  await assert.rejects(vault.run('catalog', request), /Approval/);
});

test('selected API output requires fresh consent and late results are suppressed after revocation', async (t) => {
  let finish!: (value: { status: number; body: unknown }) => void;
  const vault = fixture(
    t,
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vault.saveOperation(operation);
  assert.throws(() => vault.approve('catalog', 'once'), /consent/);
  vault.approve('catalog', 'until-revoked', undefined, true);
  const running = vault.run('catalog');
  vault.revoke('catalog');
  vault.approve('catalog', 'until-revoked', undefined, true);
  finish({ status: 200, body: { data: [{ id: 'late', name: 'Late' }] } });
  await assert.rejects(running, /Access ended/);
});

test('scalar projection rejects objects, oversized arrays/cells, unsafe paths and redacts selected secrets', () => {
  for (const fields of [
    ['__proto__'],
    ['a.constructor.x'],
    ['$'],
    ['data[*]'],
    ['id', 'id'],
    ['a.b.c.d.e.f.g.h.i'],
  ])
    assert.throws(() => validateResponseFields(fields));
  assert.throws(() => projectResponse({ data: { secret } }, ['data'], [secret]), /not a scalar/);
  assert.throws(
    () => projectResponse({ data: Array(101).fill({ id: 'x' }) }, ['data[].id'], []),
    /100 entries/,
  );
  assert.throws(() => projectResponse({ id: 'x'.repeat(4097) }, ['id'], []), /size limit/);
  assert.throws(() => projectResponse({ data: {} }, ['data[].id'], []), /unexpected type/);
  const output = projectResponse(
    {
      data: [
        { id: 1, name: `echo:${secret}` },
        { id: 2, name: Buffer.from(secret).toString('base64') },
      ],
      missing: null,
    },
    ['data[].id', 'data[].name', 'missing'],
    [secret],
  );
  assert.deepEqual(output['data[].id'], [1, 2]);
  assert.deepEqual(output['data[].name'], ['echo:[REDACTED]', '[REDACTED]']);
  assert.equal(output.missing, null);
  const fields = Array.from({ length: 16 }, (_, index) => `field${index}`);
  assert.throws(
    () =>
      projectResponse(
        Object.fromEntries(fields.map((field) => [field, 'x'.repeat(4096)])),
        fields,
        [],
      ),
    /response limit/,
  );
  for (const path of ['/v1/../x', '/v1/%2f', '/v1/**', '/*/x'])
    assert.throws(() =>
      validateOperation({ ...operation, scope: { paths: [path], methods: ['GET'] } }, item),
    );
  assert.equal(resolveHttpRequest(operation).url, operation.url);
});

test('redaction never rescans markers and enforces scalar and aggregate limits incrementally', () => {
  const secrets = ['R', 'E', 'D', 'A', 'C', 'T'];
  const output = projectResponse({ value: 'R'.repeat(10) }, ['value'], secrets);
  assert.equal(output.value, '[REDACTED]'.repeat(10));
  assert.equal(Buffer.byteLength(String(output.value)), 100);
  const rows = projectResponse(
    { data: Array.from({ length: 100 }, () => ({ value: 'R'.repeat(10) })) },
    ['data[].value'],
    secrets,
  );
  assert.deepEqual(rows['data[].value'], Array(100).fill('[REDACTED]'.repeat(10)));
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) <= 65536);
  assert.throws(
    () => projectResponse({ value: 'R'.repeat(410) }, ['value'], secrets),
    /size limit after redaction/,
  );
  assert.throws(
    () => projectResponse({ value: 'R'.repeat(4096) }, ['value'], secrets),
    /size limit after redaction/,
  );
  const body = {
    data: Array.from({ length: 20 }, () => ({ value: 'R'.repeat(400) })),
    get later() {
      throw new Error('Later fields must not be processed after exhausting the budget.');
    },
  };
  assert.throws(() => projectResponse(body, ['data[].value', 'later'], secrets), /response limit/);
  assert.equal(
    projectResponse({ value: 'prefix:a+b[0].*\\suffix' }, ['value'], ['a+b[0].*\\suffix']).value,
    'prefix:[REDACTED]',
  );
  assert.throws(
    () =>
      projectResponse(
        { data: Array.from({ length: 3 }, () => ({ value: '\u0000'.repeat(4096) })) },
        ['data[].value'],
        [],
      ),
    /response limit/,
  );
});

test('failed projection consumes a one-attempt grant without returning the raw object', async (t) => {
  const vault = fixture(t, async () => ({ status: 200, body: { id: { secret } } }));
  const pending = proposal(vault, { ...operation, responseFields: ['id'] });
  vault.approveProposal({
    revision: pending.revision,
    duration: 'once',
    dataSharingAccepted: true,
  });
  await assert.rejects(
    vault.run('catalog'),
    (error: Error) => /not a scalar/.test(error.message) && !error.message.includes(secret),
  );
  await assert.rejects(vault.run('catalog'), /Approval required/);
});

test('failed proposal persistence leaves neither policy nor grant active', (t) => {
  const vault = fixture(t);
  const pending = proposal(vault);
  t.mock.method(vault.storage, 'save', () => {
    throw new Error('synthetic failure');
  });
  assert.throws(
    () =>
      vault.approveProposal({
        revision: pending.revision,
        duration: 'hour',
        dataSharingAccepted: true,
      }),
    /vault was locked/,
  );
  assert.equal(vault.snapshot().unlocked, false);
  assert.equal(vault.snapshot().proposals.length, 0);
  assert.equal(vault.snapshot().grants.length, 0);
});

test('real stdio MCP proposes and runs approved selected-output requests without revealing credentials', async (t) => {
  const vault = fixture(t);
  const broker = await startBroker(vault);
  const client = new Client({ name: 'http-test', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/agent/cli.js'), 'mcp', '--data-dir', vault.storage.directory],
        stderr: 'pipe',
      }),
    );
    const result = await client.callTool({
      name: 'agentkey_propose_operation',
      arguments: { ...operation },
    });
    assert.ok(JSON.stringify(result).includes('awaiting-approval'));
    assert.equal(
      (
        await client.callTool({
          name: 'agentkey_run_operation',
          arguments: { operation: 'catalog' },
        })
      ).isError,
      true,
    );
    vault.approveProposal({
      revision: vault.snapshot().proposals[0]!.revision,
      duration: 'once',
      dataSharingAccepted: true,
    });
    const response = await client.callTool({
      name: 'agentkey_run_operation',
      arguments: { operation: 'catalog' },
    });
    assert.ok(JSON.stringify(response).includes('prod_1'));
    assert.ok(!JSON.stringify(response).includes(secret));
  } finally {
    await client.close();
    await broker.close();
  }
});
