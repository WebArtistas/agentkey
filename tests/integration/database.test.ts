import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from 'pg';
import { Vault } from '../../core/vault';
import { startBroker } from '../../core/broker';
import { callBroker } from '../../agent/client';
import { databaseConfig, readDatabase } from '../../core/database';
import type { DatabaseInput, DatabaseRead } from '../../shared/contracts';
import { postgresFixture } from './fixture';

const database: DatabaseInput = {
  name: 'fixture-db',
  item: 'db-url',
  field: 'value',
  tables: [{ schema: 'public', table: 'products', columns: ['id', 'name'] }],
};
const query: DatabaseRead = {
  connection: database.name,
  schema: 'public',
  table: 'products',
  columns: ['id', 'name'],
  filters: [{ column: 'id', value: 1 }],
  limit: 10,
};
const signal = () => new AbortController().signal;

test('real PostgreSQL boundary and stdio MCP workflow', { timeout: 120_000 }, async (t) => {
  const fixture = await postgresFixture(t);
  await t.test('reads allowed rows as text and binds injection attempts as data', async () => {
    assert.deepEqual((await readDatabase(database, fixture.readerUrl, query, signal())).rows, [
      ['1', 'Notebook'],
    ]);
    assert.deepEqual(
      (
        await readDatabase(
          database,
          fixture.readerUrl,
          { ...query, filters: [{ column: 'name', value: "'; DROP TABLE public.products; --" }] },
          signal(),
        )
      ).rows,
      [],
    );
  });
  await t.test(
    'database role itself rejects writes and forbidden columns without the broker',
    async () => {
      const client = new Client({
        ...databaseConfig(fixture.readerUrl),
        options: '-c default_transaction_read_only=off',
        statement_timeout: 3000,
      });
      await client.connect();
      try {
        await assert.rejects(
          client.query("UPDATE public.products SET name = 'changed'"),
          /permission denied/,
        );
        await assert.rejects(
          client.query('SELECT internal_token FROM public.products'),
          /permission denied/,
        );
      } finally {
        await client.end();
      }
    },
  );
  await t.test('administrator credentials and write-capable readers fail closed', async () => {
    await assert.rejects(
      readDatabase(database, fixture.adminUrl, query, signal()),
      /Database read failed/,
    );
    await fixture.admin.query('GRANT UPDATE(name) ON public.products TO agentkey_reader');
    try {
      await assert.rejects(
        readDatabase(database, fixture.readerUrl, query, signal()),
        /Database read failed/,
      );
    } finally {
      await fixture.admin.query('REVOKE UPDATE(name) ON public.products FROM agentkey_reader');
    }
  });
  await t.test(
    'oversized cells, oversized total results and reflected credentials are suppressed',
    async () => {
      for (const name of ['x'.repeat(5000), fixture.readerUrl, fixture.readerPassword]) {
        await fixture.admin.query('UPDATE public.products SET name=$1 WHERE id=1', [name]);
        await assert.rejects(
          readDatabase(database, fixture.readerUrl, query, signal()),
          /Database read failed/,
        );
      }
      await fixture.admin.query("UPDATE public.products SET name='Notebook' WHERE id=1");
      await fixture.admin.query(
        "INSERT INTO public.products SELECT n, repeat('x',4000), 'test' FROM generate_series(3,82) n",
      );
      try {
        await assert.rejects(
          readDatabase(
            database,
            fixture.readerUrl,
            { ...query, filters: [], limit: 100 },
            signal(),
          ),
          /Database read failed/,
        );
      } finally {
        await fixture.admin.query('DELETE FROM public.products WHERE id>2');
      }
    },
  );
  await t.test('server timeouts and cancellation stop slow reads', async () => {
    await fixture.admin.query(
      "CREATE VIEW public.slow AS SELECT 'slow'::text AS name FROM pg_catalog.pg_sleep(10); GRANT SELECT ON public.slow TO agentkey_reader",
    );
    const slowDatabase = {
      ...database,
      tables: [{ schema: 'public', table: 'slow', columns: ['name'] }],
    };
    const slowQuery = { ...query, table: 'slow', columns: ['name'], filters: [] };
    const start = Date.now();
    await assert.rejects(
      readDatabase(slowDatabase, fixture.readerUrl, slowQuery, signal()),
      /Database read failed/,
    );
    assert.ok(Date.now() - start < 7000, 'statement timeout must bound a slow read');
    const controller = new AbortController();
    const pending = readDatabase(slowDatabase, fixture.readerUrl, slowQuery, controller.signal);
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(pending, /Database read failed/);
    } finally {
      clearTimeout(timer);
    }
  });
  await t.test(
    'MCP reads require approval; isolated broker rejects non-database capabilities',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'ak-i-'));
      const isolatedDirectory = mkdtempSync(join(tmpdir(), 'ak-b-'));
      const vault = new Vault(directory);
      vault.initialize('synthetic integration passphrase');
      vault.saveItem({
        name: database.item,
        kind: 'secret',
        fields: [{ name: 'value', value: fixture.readerUrl }],
      });
      vault.saveDatabase(database);
      const broker = await startBroker(vault, undefined, {
        directory: isolatedDirectory,
        databaseOnly: true,
      });
      const client = new McpClient({ name: 'agentkey-database-test', version: '1.0.0' });
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [resolve('dist/agent/cli.js'), 'mcp', '--data-dir', isolatedDirectory],
            stderr: 'pipe',
          }),
        );
        const metadata = await client.callTool({ name: 'agentkey_list_databases', arguments: {} });
        assert.ok(!JSON.stringify(metadata).includes(fixture.readerUrl));
        assert.equal(
          (await client.callTool({ name: 'agentkey_read_database', arguments: { ...query } }))
            .isError,
          true,
        );
        const request = await client.callTool({
          name: 'agentkey_request_access',
          arguments: { operation: database.name },
        });
        assert.match(JSON.stringify(request), /awaiting-approval/);
        vault.approve(database.name, 'once');
        const result = await client.callTool({
          name: 'agentkey_read_database',
          arguments: { ...query },
        });
        assert.equal(result.isError, false);
        assert.match(JSON.stringify(result), /Notebook/);
        assert.ok(!JSON.stringify(result).includes(fixture.readerPassword));
        assert.equal(
          (await client.callTool({ name: 'agentkey_read_database', arguments: { ...query } }))
            .isError,
          true,
        );
        for (const action of ['list-items', 'list-operations'] as const) {
          const denied = await callBroker(isolatedDirectory, { action });
          assert.equal(denied.ok, false);
        }
        vault.approve(database.name, 'until-revoked');
        vault.revoke(database.name);
        assert.equal(
          (await client.callTool({ name: 'agentkey_read_database', arguments: { ...query } }))
            .isError,
          true,
        );
      } finally {
        await client.close();
        await broker.close();
        vault.lock();
        rmSync(directory, { recursive: true, force: true });
        rmSync(isolatedDirectory, { recursive: true, force: true });
      }
    },
  );
});
