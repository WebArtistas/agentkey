import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { Vault } from '../../dist/core/vault.js';
import { startDatabaseBroker } from '../../dist/core/broker.js';
import { contextSchema, startRelay } from './relay.mjs';
import { relayCall, runPi, toolNames } from './runner.mjs';

export const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export function assistant(content, stopReason = 'stop') {
  return {
    role: 'assistant',
    content,
    api: 'agentkey-relay',
    provider: 'agentkey-relay',
    model: 'host-model',
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}
const call = (name, args, id) =>
  assistant([{ type: 'toolCall', id, name, arguments: args }], 'toolUse');
const secret = 'postgresql://reader:synthetic-pi-password@127.0.0.1:5432/fixture';
const database = {
  name: 'fixture-db',
  item: 'db-url',
  field: 'value',
  tables: [{ schema: 'public', table: 'products', columns: ['id', 'name'] }],
};
const query = {
  connection: database.name,
  schema: 'public',
  table: 'products',
  columns: ['id', 'name'],
  filters: [],
  limit: 1,
};
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ak-pi-'));
  const agentDirectory = join(directory, 'agent');
  const vault = new Vault(directory, undefined, async (_db, url) => {
    assert.equal(url, secret);
    return {
      connection: database.name,
      columns: query.columns,
      rows: [['1', 'Notebook']],
      limit: 1,
    };
  });
  vault.initialize('synthetic Pi fixture passphrase');
  vault.saveItem({
    name: database.item,
    kind: 'secret',
    fields: [{ name: 'value', value: secret }],
  });
  vault.saveDatabase(database);
  const broker = await startDatabaseBroker(vault);
  t.after(async () => {
    await broker.close();
    vault.lock();
    rmSync(directory, { recursive: true, force: true });
  });
  return { vault, broker, agentDirectory };
}

test('real Pi SDK uses only whitelisted stdio MCP tools and loads the portable skill', async (t) => {
  const fixtureData = await fixture(t);
  fixtureData.vault.approve(database.name, 'until-revoked');
  let turn = 0;
  const relay = await startRelay(async (context) => {
    assert.ok(!JSON.stringify(context).includes(secret));
    assert.deepEqual(
      getCurrentTools(context.messages)
        .map((tool) => tool.name)
        .sort(),
      [...toolNames].sort(),
    );
    assert.match(JSON.stringify(context.messages), /Portable AgentKey usage skill/);
    turn++;
    if (turn === 1) return call('agentkey_list_databases', {}, 'list');
    if (turn === 2) {
      assert.match(JSON.stringify(context.messages.at(-1)), /products/);
      return call('agentkey_request_access', { operation: database.name }, 'request');
    }
    if (turn === 3) return call('agentkey_read_database', query, 'read');
    assert.match(JSON.stringify(context.messages.at(-1)), /Notebook/);
    return assistant([{ type: 'text', text: 'The permitted product is Notebook.' }]);
  });
  t.after(() => relay.close());
  const result = await runPi({
    brokerDirectory: fixtureData.broker.directory,
    relayDirectory: relay.directory,
    prompt: 'Read the permitted product.',
    agentDirectory: fixtureData.agentDirectory,
  });
  assert.match(result.answer, /Notebook/);
  assert.deepEqual(result.tools, [
    'agentkey_list_databases',
    'agentkey_request_access',
    'agentkey_read_database',
  ]);
  assert.equal(relay.calls, 4);
  assert.ok(!JSON.stringify(result).includes('synthetic-pi-password'));
});

test('a model request for a hidden shell tool is denied by the actual Pi runtime', async (t) => {
  const fixtureData = await fixture(t);
  let turn = 0;
  const relay = await startRelay(async (context) => {
    if (++turn === 1) return call('bash', { command: 'echo SHOULD_NOT_RUN' }, 'forbidden');
    const last = context.messages.at(-1);
    assert.equal(last.role, 'toolResult');
    assert.equal(last.isError, true);
    return assistant([{ type: 'text', text: 'Shell access is not available.' }]);
  });
  t.after(() => relay.close());
  const result = await runPi({
    brokerDirectory: fixtureData.broker.directory,
    relayDirectory: relay.directory,
    prompt: 'Try a forbidden shell tool.',
    agentDirectory: fixtureData.agentDirectory,
  });
  assert.deepEqual(result.tools, []);
  assert.match(result.answer, /not available/);
});

test('inference relay bounds requests, sanitizes errors and accepts text-only context', async (t) => {
  const context = { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] };
  const relay = await startRelay(async () => assistant([{ type: 'text', text: 'ok' }]), {
    maxCalls: 1,
  });
  t.after(() => relay.close());
  assert.equal((await relayCall(relay.directory, context)).content[0].text, 'ok');
  await assert.rejects(relayCall(relay.directory, context), /refused/);
  assert.equal(contextSchema.safeParse({ ...context, provider: 'attacker' }).success, false);
  assert.equal(
    contextSchema.safeParse({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'file:///private', mimeType: 'image/png' }],
          timestamp: Date.now(),
        },
      ],
    }).success,
    false,
  );
  const failing = await startRelay(async () => {
    throw new Error('synthetic-host-provider-secret');
  });
  t.after(() => failing.close());
  await assert.rejects(
    relayCall(failing.directory, context),
    (error) => !String(error).includes('synthetic-host-provider-secret'),
  );
  const stored = readFileSync(join(failing.directory, 'relay.json'), 'utf8');
  assert.ok(!stored.includes('synthetic-host-provider-secret'));
});
