import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vault } from '../../dist/core/vault.js';
import { startBroker, startDatabaseBroker } from '../../dist/core/broker.js';
import { postgresFixture } from '../../dist/tests/integration/fixture.js';
import { startRelay } from './relay.mjs';
import { dockerArguments, dockerProcess, launchSandbox, preflight } from './sandbox.mjs';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content, stopReason = 'stop') => ({
  role: 'assistant',
  content,
  api: 'agentkey-relay',
  provider: 'agentkey-relay',
  model: 'host-model',
  usage,
  stopReason,
  timestamp: Date.now(),
});
const call = (name, args, id) =>
  assistant([{ type: 'toolCall', id, name, arguments: args }], 'toolUse');

test(
  'isolated Pi → stdio MCP → host broker → real PostgreSQL, without host credentials or network',
  { timeout: 180_000 },
  async (t) => {
    await preflight(); // Fails closed on incompatible kernels; never relax AppArmor/seccomp here.
    const postgres = await postgresFixture(t);
    const directory = mkdtempSync(join(tmpdir(), 'ak-ci-'));
    const canaryPath = join(directory, 'host-provider-credential.txt');
    const canary = 'synthetic-host-provider-credential';
    writeFileSync(canaryPath, canary, { mode: 0o600 });
    let httpCalls = 0;
    const vault = new Vault(directory, async () => {
      httpCalls++;
      return 204;
    });
    vault.initialize('synthetic isolated test passphrase');
    vault.saveItem({
      name: 'db-url',
      kind: 'secret',
      fields: [{ name: 'value', value: postgres.readerUrl }],
    });
    vault.saveDatabase({
      name: 'fixture-db',
      item: 'db-url',
      field: 'value',
      tables: [{ schema: 'public', table: 'products', columns: ['id', 'name'] }],
    });
    vault.saveItem({
      name: 'api-key',
      kind: 'secret',
      fields: [{ name: 'value', value: 'synthetic-api-secret' }],
    });
    vault.saveOperation({
      name: 'http-test',
      item: 'api-key',
      method: 'POST',
      url: 'https://api.example.com/jobs',
      auth: 'headers',
      bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
      body: '',
    });
    vault.approve('http-test', 'until-revoked');
    vault.approve('fixture-db', 'until-revoked', undefined, true);
    const regular = await startBroker(vault);
    const broker = await startDatabaseBroker(vault);
    const query = {
      connection: 'fixture-db',
      schema: 'public',
      table: 'products',
      columns: ['id', 'name'],
      filters: [{ column: 'id', value: 1 }],
      limit: 1,
    };
    let turn = 0;
    const relay = await startRelay(async (context) => {
      const serialized = JSON.stringify(context);
      for (const secret of [
        postgres.readerUrl,
        postgres.readerPassword,
        canary,
        'synthetic-api-secret',
        'synthetic-private-data',
      ])
        assert.ok(!serialized.includes(secret));
      turn++;
      if (turn === 1) return call('agentkey_list_databases', {}, 'discover');
      if (turn === 2) return call('agentkey_request_access', { operation: 'fixture-db' }, 'access');
      if (turn === 3)
        return call(
          'agentkey_read_database',
          { ...query, columns: ['internal_token'] },
          'forbidden',
        );
      if (turn === 4) {
        assert.match(JSON.stringify(context.messages.at(-1)), /not allowed/);
        return call('agentkey_read_database', query, 'read');
      }
      assert.match(JSON.stringify(context.messages.at(-1)), /Notebook/);
      return assistant([{ type: 'text', text: 'The permitted product is Notebook.' }]);
    });
    try {
      const probe = `
      const fs = require('node:fs'); const assert = require('node:assert/strict');
      for (const path of process.argv.slice(1,4)) assert.throws(() => fs.readFileSync(path));
      assert.throws(() => fs.writeFileSync(process.argv[4] + '/unexpected.txt', 'test'));
      assert.ok(!fs.existsSync('/var/run/docker.sock'));
      assert.ok(!Object.keys(process.env).some(key => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)));
      process.stdout.write('host-files-unavailable');
    `;
      const output = await dockerProcess(
        [
          ...dockerArguments(`agentkey-test-${randomUUID()}`, [broker.directory, relay.directory]),
          '-e',
          probe,
          vault.storage.path,
          canaryPath,
          join(directory, 'agent-connection.json'),
          broker.directory,
        ],
        '',
      );
      assert.equal(output, 'host-files-unavailable');
      const result = await launchSandbox({
        brokerDirectory: broker.directory,
        relayDirectory: relay.directory,
        prompt: 'Read the permitted product.',
      });
      assert.match(result.answer, /Notebook/);
      assert.equal(relay.calls, 5);
      assert.ok(!JSON.stringify(result).includes(postgres.readerPassword));
      vault.revoke('fixture-db');
      const hostile = `
      const assert = require('node:assert/strict');
      const {callBroker} = require('/app/dist/agent/client.js');
      const directory = process.argv[1]; const query = JSON.parse(process.argv[2]);
      (async () => {
        for (const command of [
          {action:'run',operation:'http-test'},
          {action:'approve',operation:'fixture-db',duration:'until-revoked'},
          {action:'read-database',query},
          {action:'list-items'},
        ]) assert.equal((await callBroker(directory, command)).ok, false);
        process.stdout.write('broker-denied-escalation');
      })().catch(() => process.exit(1));
    `;
      assert.equal(
        await dockerProcess(
          [
            ...dockerArguments(`agentkey-test-${randomUUID()}`, [broker.directory]),
            '-e',
            hostile,
            broker.directory,
            JSON.stringify(query),
          ],
          '',
        ),
        'broker-denied-escalation',
      );
      assert.equal(httpCalls, 0);
      assert.equal(
        vault.snapshot().grants.some((grant) => grant.operation === 'fixture-db'),
        false,
      );
    } finally {
      await relay.close();
      await broker.close();
      await regular.close();
      vault.lock();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
