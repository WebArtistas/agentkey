import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Vault } from '../core/vault';
import { startBroker } from '../core/broker';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SQLiteSetup } from '../core/sqlite-setup';
import { createSQLiteDemo, inspectSQLite, MAX_SQLITE_BYTES, readSQLite } from '../core/sqlite';
import { loadSQLiteSnapshot, saveSQLiteSnapshot } from '../core/sqlite-snapshots';
import { dataSchema, type VaultData } from '../core/schema';
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
  vault.approve('demo', 'once', undefined, true);
  assert.deepEqual((await vault.readRows(query)).rows, [
    ['1', 'Notebook'],
    ['2', 'Desk lamp'],
    ['3', 'Pen set'],
  ]);
  await assert.rejects(vault.readRows(query), /Approval required/);
  vault.approve('demo', 'until-revoked', undefined, true);
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
test('SQLite cancellation requires its selection token and cannot cancel a newer import', async (t) => {
  const { vault, setup } = fixture(t);
  const first = await setup.prepare();
  const pending = setup.prepare();
  setup.cancel(first.token);
  const second = await pending;
  setup.cancel(first.token);
  assert.throws(() => setup.cancel(undefined), /Invalid input/);
  setup.save({ token: second.token, name: 'demo', tables: second.tables });
  assert.equal(vault.snapshot().databases.length, 1);
  const owned = await setup.prepare();
  setup.cancel(owned.token);
  assert.throws(
    () => setup.save({ token: owned.token, name: 'cancelled', tables: owned.tables }),
    /expired/,
  );
  assert.deepEqual(
    vault.snapshot().databases.map((database) => database.name),
    ['demo'],
  );
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
  vault.approve('demo', 'until-revoked', undefined, true);
  assert.deepEqual(
    (await vault.readRows({ ...query, filters: [{ column: 'internal_note', value: null }] })).rows,
    [['9223372036854775807', 'example']],
  );
  assert.deepEqual(readFileSync(path), before);
  const update = new DatabaseSync(path);
  update.prepare('UPDATE products SET name=?').run('x'.repeat(4097));
  update.close();
  // Managed imports are immutable snapshots, not live references to the original.
  assert.deepEqual((await vault.readRows(query)).rows, [['9223372036854775807', 'example']]);
  const policy = vault.snapshot().databases[0]!;
  await assert.rejects(readSQLite(path, policy, query, new AbortController().signal));
  const blob = new DatabaseSync(path);
  blob.exec("UPDATE products SET name=x'001122';");
  blob.close();
  await assert.rejects(readSQLite(path, policy, query, new AbortController().signal));
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
  await assert.rejects(readSQLite(path, policy, query, new AbortController().signal));
  assert.deepEqual((await vault.readRows(query)).rows, [['9223372036854775807', 'example']]);
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
    vault.approve('demo', 'once', undefined, true);
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

test('managed imports encrypt database bytes and survive removal of the original', async (t) => {
  const { vault, setup, directory } = fixture(t);
  const path = join(directory, 'original.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE products(id INTEGER, name TEXT); INSERT INTO products VALUES (1,'snapshot-sensitive-row');",
  );
  db.close();
  const selected = await setup.prepare(path);
  setup.save({ token: selected.token, name: 'demo', tables: selected.tables });
  rmSync(path);
  assert.deepEqual(readdirSync(directory).sort(), ['sqlite-snapshots', 'vault.json']);
  const database = vault.snapshot().databases[0]!;
  assert.ok(database.source === 'snapshot');
  const blob = join(directory, 'sqlite-snapshots', `${database.snapshot}.aks`);
  for (const file of [blob, vault.storage.path]) {
    const content = readFileSync(file);
    assert.ok(!content.includes('snapshot-sensitive-row'));
    assert.ok(!content.includes('SQLite format 3\0'));
    assert.ok(!content.includes(path));
  }
  assert.equal(vault.snapshot().items.length, 0);
  const data = vault.storage.unlock(password);
  assert.ok(data.snapshots.length === 1);
  assert.ok(!JSON.stringify(vault.snapshot()).includes(data.snapshots[0]!.key));
  vault.lock();
  vault.unlock(password);
  vault.approve('demo', 'once', undefined, true);
  assert.deepEqual((await vault.readRows(query)).rows, [['1', 'snapshot-sensitive-row']]);
  const original = readFileSync(blob);
  const corrupted = Buffer.from(original);
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  writeFileSync(blob, corrupted);
  vault.approve('demo', 'once', undefined, true);
  await assert.rejects(vault.readRows(query), /No database error details/);
  writeFileSync(blob, original);
  await assert.rejects(vault.readRows(query), /Approval required/);
});

test('re-import refreshes data, revokes consent/grants and invalidates stale policy reviews', async (t) => {
  const { vault, setup, directory } = fixture(t);
  const path = join(directory, 'original.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE products(id INTEGER, name TEXT, note TEXT); INSERT INTO products VALUES (1,'first','private');",
  );
  db.close();
  const tables = [{ schema: 'main', table: 'products', columns: ['id', 'name'] }];
  const first = await setup.prepare(path);
  setup.save({ token: first.token, name: 'demo', tables });
  vault.approve('demo', 'until-revoked', undefined, true);
  const oldPolicy = vault.snapshot().databases[0]!;
  assert.ok(oldPolicy.source === 'snapshot');
  const second = await setup.prepare(path);
  // Save binds the bytes inspected, not a path that may have changed during review.
  const update = new DatabaseSync(path);
  update.exec("UPDATE products SET name='second';");
  update.close();
  setup.save({ token: second.token, name: 'demo', tables });
  assert.throws(() => vault.approve('demo', 'once', oldPolicy.revision, true), /settings changed/);
  await assert.rejects(vault.readRows(query), /Approval required/);
  vault.approve('demo', 'once', undefined, true);
  assert.deepEqual((await vault.readRows(query)).rows, [['1', 'first']]);
  const third = await setup.prepare(path);
  setup.save({ token: third.token, name: 'demo', tables });
  vault.approve('demo', 'once', undefined, true);
  assert.deepEqual((await vault.readRows(query)).rows, [['1', 'second']]);
  const current = vault.snapshot().databases[0]!;
  const { revision: _revision, ...policy } = current;
  assert.throws(
    () => vault.saveDatabase({ ...policy, tables: [{ ...tables[0], columns: ['note'] }] }),
    /Re-import/,
  );
  assert.throws(() => vault.saveDatabase({ ...policy, snapshot: oldPolicy.snapshot }), /Import/);
  vault.saveDatabase({ ...policy, tables: [{ ...tables[0], columns: ['id'] }] });
  await assert.rejects(vault.readRows(query), /Approval required/);
  assert.equal(vault.storage.unlock(password).snapshots.length, 1);
});

test('snapshot persistence failure locks the vault and leaves no plaintext import', async (t) => {
  const { vault, setup, directory } = fixture(t);
  const selected = await setup.prepare();
  t.mock.method(vault.storage, 'save', () => {
    throw new Error('synthetic disk failure');
  });
  assert.throws(
    () => setup.save({ token: selected.token, name: 'demo', tables: selected.tables }),
    /vault was locked/,
  );
  assert.equal(vault.snapshot().unlocked, false);
  assert.deepEqual(readdirSync(directory).sort(), ['sqlite-snapshots', 'vault.json']);
  const files = readdirSync(join(directory, 'sqlite-snapshots'));
  assert.equal(files.length, 1);
  assert.ok(!readFileSync(join(directory, 'sqlite-snapshots', files[0]!)).includes('Notebook'));
  vault.unlock(password);
  assert.equal(vault.snapshot().databases.length, 0);
  assert.throws(
    () => setup.save({ token: selected.token, name: 'demo', tables: selected.tables }),
    /expired/,
  );
  t.mock.restoreAll();
  const retry = await setup.prepare();
  const persist = vault.storage.save.bind(vault.storage);
  t.mock.method(vault.storage, 'save', (data: VaultData) => {
    persist(data);
    throw new Error('synthetic failure after an ambiguous commit');
  });
  assert.throws(
    () => setup.save({ token: retry.token, name: 'demo', tables: retry.tables }),
    /vault was locked/,
  );
  t.mock.restoreAll();
  vault.unlock(password);
  // The dependency must remain even when the vault committed before reporting failure.
  vault.approve('demo', 'once', undefined, true);
  assert.equal((await vault.readRows(query)).rows.length, 3);
});

test('legacy external SQLite policies remain external and old database grants require consent', async (t) => {
  const { vault, directory } = fixture(t);
  const path = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE products(id INTEGER, name TEXT); INSERT INTO products VALUES (1,'legacy');",
  );
  db.close();
  const before = readFileSync(path);
  vault.saveItem({
    name: 'legacy-source',
    kind: 'secret',
    fields: [{ name: 'value', value: path }],
  });
  vault.saveDatabase({
    engine: 'sqlite',
    name: 'demo',
    item: 'legacy-source',
    field: 'value',
    tables: [{ schema: 'main', table: 'products', columns: ['id', 'name'] }],
  });
  const old = vault.storage.unlock(password);
  const { snapshots: _snapshots, ...oldFormat } = old;
  assert.deepEqual(dataSchema.parse(oldFormat).snapshots, []);
  // Older grants carry no explicit data-sharing consent.
  old.grants = [{ operation: 'demo', expiresAt: null, remainingUses: null }];
  vault.storage.save(old);
  vault.lock();
  vault.unlock(password);
  assert.equal(vault.snapshot().databases[0]!.source, undefined);
  assert.equal(vault.snapshot().grants.length, 0);
  assert.equal(vault.requestAccess('demo').state, 'awaiting-approval');
  await assert.rejects(vault.readRows(query), /Approval required/);
  for (const consent of [undefined, false, 'true', 1])
    assert.throws(() => vault.approve('demo', 'once', undefined, consent), /data-sharing consent/);
  vault.approve('demo', 'once', undefined, true);
  assert.deepEqual((await vault.readRows(query)).rows, [['1', 'legacy']]);
  assert.deepEqual(readFileSync(path), before);
  assert.ok(!readdirSync(directory).includes('sqlite-snapshots'));
});

test('snapshot authentication binds its ID and rejects substituted, missing and oversized files', async (t) => {
  const { directory } = fixture(t);
  const bytes = await createSQLiteDemo();
  const first = saveSQLiteSnapshot(directory, bytes);
  const second = saveSQLiteSnapshot(directory, bytes);
  bytes.fill(0);
  const path = (id: string) => join(directory, 'sqlite-snapshots', `${id}.aks`);
  const encrypted = readFileSync(path(first.id));
  const signal = new AbortController().signal;
  // Same key and ciphertext under another valid ID must still fail authentication.
  writeFileSync(path(second.id), encrypted);
  await assert.rejects(
    loadSQLiteSnapshot(directory, { ...second, key: first.key }, signal),
    /No file or key details/,
  );
  writeFileSync(path(first.id), encrypted.subarray(0, 30));
  await assert.rejects(loadSQLiteSnapshot(directory, first, signal), /No file or key details/);
  writeFileSync(path(first.id), Buffer.alloc(MAX_SQLITE_BYTES + 37));
  await assert.rejects(loadSQLiteSnapshot(directory, first, signal), /No file or key details/);
  rmSync(path(first.id));
  await assert.rejects(loadSQLiteSnapshot(directory, first, signal), /No file or key details/);
  if (process.platform !== 'win32') {
    symlinkSync(path(second.id), path(first.id));
    await assert.rejects(loadSQLiteSnapshot(directory, first, signal), /No file or key details/);
  }
});
