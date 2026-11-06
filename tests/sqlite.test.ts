import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Vault } from '../core/vault';
import { startBroker } from '../core/broker';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SQLiteSetup } from '../core/sqlite-setup';
import { inspectSQLite, readSQLite } from '../core/sqlite';
import type { DatabaseRead } from '../shared/contracts';
const password = 'synthetic sqlite test passphrase';
const query: DatabaseRead = {
  connection: 'demo',
  schema: 'main',
  table: 'products',
  columns: ['id', 'name'],
  filters: [],
  limit: 10,
};
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ak-sqlite-test-'));
  const vault = new Vault(directory);
  vault.initialize(password);
  const setup = new SQLiteSetup(vault);
  t.after(() => {
    setup.clear();
    vault.lock();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, vault, setup };
}
test('SQLite guided demo performs real bounded reads through approvals without exposing paths', async (t) => {
  const { vault, setup, directory } = fixture(t);
  const selection = await setup.prepare();
  assert.deepEqual(selection.tables, [
    { schema: 'main', table: 'products', columns: ['id', 'name', 'internal_note'] },
  ]);
  setup.save({
    token: selection.token,
    name: 'demo',
    tables: [{ schema: 'main', table: 'products', columns: ['id', 'name'] }],
  });
  assert.ok(!JSON.stringify(vault.snapshot()).includes(directory));
  assert.ok(!readFileSync(vault.storage.path, 'utf8').includes(directory));
  await assert.rejects(vault.readRows(query), /Approval required/);
  vault.approve('demo', 'once');
  assert.deepEqual((await vault.readRows(query)).rows, [
    ['1', 'Notebook'],
    ['2', 'Desk lamp'],
    ['3', 'Pen set'],
  ]);
  await assert.rejects(vault.readRows(query), /Approval required/);
  vault.approve('demo', 'until-revoked');
  await assert.rejects(vault.readRows({ ...query, columns: ['internal_note'] }), /not allowed/);
  await assert.rejects(
    vault.readRows({ ...query, filters: [{ column: 'internal_note', value: 'guess' }] }),
    /not allowed/,
  );
  assert.deepEqual(
    (
      await vault.readRows({
        ...query,
        filters: [{ column: 'name', value: "'; DROP TABLE products;--" }],
      })
    ).rows,
    [],
  );
  vault.lock();
  vault.unlock(password);
  assert.equal((await vault.readRows({ ...query, limit: 1 })).rows.length, 1);
  const cancelled = vault.readRows(query);
  vault.revoke('demo');
  await assert.rejects(cancelled, /No database error details/);
  await assert.rejects(vault.readRows(query), /Approval required/);
});
test('SQLite selection rejects forged columns, expired tokens and lock/reunlock races', async (t) => {
  const { vault, setup } = fixture(t);
  const first = await setup.prepare();
  assert.throws(() =>
    setup.save({
      token: first.token,
      name: 'demo',
      tables: [{ schema: 'main', table: 'products', columns: ['secret'] }],
    }),
  );
  vault.lock();
  vault.unlock(password);
  assert.throws(
    () =>
      setup.save({
        token: first.token,
        name: 'demo',
        tables: [{ schema: 'main', table: 'products', columns: ['id'] }],
      }),
    /expired/,
  );
  const second = await setup.prepare();
  assert.throws(
    () => setup.save({ token: first.token, name: 'demo', tables: second.tables }),
    /expired/,
  );
  const pending = setup.prepare();
  vault.lock();
  vault.unlock(password);
  await assert.rejects(pending, /expired/);
});
test('SQLite inspection and reads leave original files unchanged and reject views, generated columns, binary/large cells', async (t) => {
  const { vault, setup, directory } = fixture(t);
  const path = join(directory, 'source.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE products(id INTEGER, name TEXT, internal_note TEXT); INSERT INTO products VALUES (9223372036854775807,'example',NULL); CREATE VIEW hidden_view AS SELECT * FROM products; CREATE TABLE generated(a INTEGER,b INTEGER GENERATED ALWAYS AS (a+1));",
  );
  db.close();
  const before = readFileSync(path);
  const selection = await setup.prepare(path);
  assert.deepEqual(
    selection.tables.map((table) => table.table),
    ['products'],
  );
  setup.save({
    token: selection.token,
    name: 'demo',
    tables: [{ schema: 'main', table: 'products', columns: ['id', 'name', 'internal_note'] }],
  });
  vault.approve('demo', 'until-revoked');
  assert.deepEqual(
    (await vault.readRows({ ...query, filters: [{ column: 'internal_note', value: null }] })).rows,
    [['9223372036854775807', 'example']],
  );
  assert.deepEqual(readFileSync(path), before);
  const update = new DatabaseSync(path);
  update.prepare('UPDATE products SET name=?').run('x'.repeat(4097));
  update.close();
  await assert.rejects(vault.readRows(query), /No database error details/);
  const blob = new DatabaseSync(path);
  blob.exec("UPDATE products SET name=x'001122';");
  blob.close();
  await assert.rejects(vault.readRows(query));
  const policy = vault.snapshot().databases[0]!;
  await assert.rejects(
    readSQLite(path, policy, { ...query, table: 'hidden_view' }, new AbortController().signal),
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(readSQLite(path, policy, query, abort.signal));
  const changed = new DatabaseSync(path);
  changed.exec(
    'ALTER TABLE products RENAME TO private_products; CREATE VIEW products AS SELECT * FROM private_products;',
  );
  changed.close();
  await assert.rejects(vault.readRows(query));
  writeFileSync(path + '-wal', 'synthetic sidecar');
  await assert.rejects(inspectSQLite(path), /closed, exported/);
});
test('SQLite rows traverse real stdio MCP while source paths and unapproved columns stay hidden', async (t) => {
  const { vault, setup, directory } = fixture(t);
  const selection = await setup.prepare();
  setup.save({
    token: selection.token,
    name: 'demo',
    tables: [{ schema: 'main', table: 'products', columns: ['id', 'name'] }],
  });
  const broker = await startBroker(vault);
  const client = new Client({ name: 'sqlite-test', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(__dirname, '../agent/cli.js'), 'mcp', '--data-dir', directory],
        stderr: 'pipe',
      }),
    );
    const metadata = await client.callTool({ name: 'agentkey_list_databases', arguments: {} });
    assert.ok(!JSON.stringify(metadata).includes(directory));
    const denied = await client.callTool({
      name: 'agentkey_read_database',
      arguments: { ...query },
    });
    assert.equal(denied.isError, true);
    vault.approve('demo', 'once');
    const rows = await client.callTool({ name: 'agentkey_read_database', arguments: { ...query } });
    assert.equal(rows.isError, false);
    assert.ok(JSON.stringify(rows).includes('Notebook'));
    assert.ok(!JSON.stringify(rows).includes('Synthetic private note'));
    assert.ok(!JSON.stringify(rows).includes(directory));
    assert.equal(
      (await client.callTool({ name: 'agentkey_read_database', arguments: { ...query } })).isError,
      true,
    );
  } finally {
    await client.close();
    await broker.close();
  }
});
test('SQLite rejects malformed, oversized and symlink sources without returning file details', async (t) => {
  const { directory } = fixture(t);
  const path = join(directory, 'not-sqlite');
  writeFileSync(path, 'sensitive-looking synthetic text'.repeat(10));
  await assert.rejects(
    inspectSQLite(path),
    (error) => error instanceof Error && !error.message.includes(path),
  );
  writeFileSync(path, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(1024)]));
  await assert.rejects(inspectSQLite(path), /No file details/);
  writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(inspectSQLite(path), /maximum 16 MiB/);
  if (process.platform !== 'win32') {
    const link = join(directory, 'link');
    symlinkSync(path, link);
    await assert.rejects(inspectSQLite(link));
  }
});
