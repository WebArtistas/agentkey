import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { databaseConfig, readStatement, type ReadDatabase } from '../core/database';
import { databaseReadSchema } from '../core/database-schema';
import { Vault } from '../core/vault';
import { publicError } from '../core/schema';
import type { DatabaseInput, DatabaseRead } from '../shared/contracts';

const passphrase = 'synthetic test vault passphrase';
const secret = 'postgresql://ak_reader:synthetic-only-db-password@127.0.0.1:5432/agentkey_fixture';
const database: DatabaseInput = {
  name: 'test-db',
  item: 'database-url',
  field: 'value',
  tables: [{ schema: 'public', table: 'products', columns: ['id', 'name'] }],
};
const query: DatabaseRead = {
  connection: 'test-db',
  schema: 'public',
  table: 'products',
  columns: ['id', 'name'],
  filters: [],
  limit: 10,
};
function fixture(
  t: TestContext,
  read: ReadDatabase = async (_database, _secret, query) => ({
    connection: query.connection,
    columns: query.columns,
    rows: [['1', 'Notebook']],
    limit: query.limit,
  }),
): Vault {
  const directory = mkdtempSync(join(tmpdir(), 'ak-db-'));
  const vault = new Vault(directory, undefined, read);
  t.after(() => {
    vault.lock();
    rmSync(directory, { recursive: true, force: true });
  });
  vault.initialize(passphrase);
  vault.saveItem({
    name: 'database-url',
    kind: 'secret',
    fields: [{ name: 'value', value: secret }],
  });
  vault.saveDatabase(database);
  return vault;
}
test('database URLs are loopback-only and cannot override driver security settings', () => {
  const config = databaseConfig(secret);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.ssl, false);
  assert.match(config.options!, /default_transaction_read_only=on/);
  for (const value of [
    'postgres://user:password@db.example.com/db',
    'postgres://user:password@169.254.169.254/db',
    'postgres://user:password@127.0.0.1/db?options=-c%20default_transaction_read_only=off',
    'postgres://user:password@127.0.0.1/db?sslmode=disable',
    'postgres://user@127.0.0.1/db',
    'postgres://user:password@127.0.0.1/db#fragment',
    'https://user:password@127.0.0.1/db',
  ])
    assert.throws(() => databaseConfig(value));
});
test('database reads use allowlisted identifiers and bound equality values, never SQL from agents', () => {
  const injection = "'; DROP TABLE products; --";
  const statement = readStatement(database, {
    ...query,
    filters: [{ column: 'name', value: injection }],
  });
  assert.ok(!statement.text.includes(injection));
  assert.deepEqual(statement.values, [injection, 10]);
  assert.match(statement.text, /"name" = \$1/);
  assert.match(statement.text, /LIMIT \$2$/);
  assert.throws(() => readStatement(database, { ...query, columns: ['password'] }), /not allowed/);
  assert.throws(
    () => readStatement(database, { ...query, filters: [{ column: 'password', value: 'guess' }] }),
    /not allowed/,
  );
  assert.throws(() => readStatement(database, { ...query, schema: 'pg_catalog' }), /not allowed/);
  for (const input of [
    { ...query, sql: 'SELECT 1' },
    { ...query, limit: 101 },
    { ...query, table: 'products;DROP TABLE products' },
    { ...query, columns: [] },
    { ...query, filters: [{ column: 'name', value: { $gt: '' } }] },
  ])
    assert.equal(databaseReadSchema.safeParse(input).success, false);
});
test('database metadata and persisted vault do not expose the connection URL', async (t) => {
  const vault = fixture(t);
  assert.deepEqual(await vault.dispatch({ action: 'list-databases' }), vault.snapshot().databases);
  for (const text of [JSON.stringify(vault.snapshot()), readFileSync(vault.storage.path, 'utf8')])
    assert.ok(!text.includes(secret));
  vault.lock();
  await assert.rejects(vault.dispatch({ action: 'list-databases' }), /Unlock/);
  vault.unlock(passphrase);
  assert.deepEqual(
    vault.snapshot().databases.map(({ revision, ...policy }) => {
      assert.match(revision, /^[a-f0-9-]{36}$/);
      return policy;
    }),
    [database],
  );
});
test('stale desktop reviews cannot approve changed policies, rotated secrets or revoked access', (t) => {
  const vault = fixture(t);
  const revision = () => vault.snapshot().databases[0]!.revision;
  assert.equal(revision(), revision());
  for (const change of [
    () => vault.saveDatabase(database),
    () =>
      vault.saveItem({
        name: database.item,
        kind: 'secret',
        fields: [{ name: 'value', value: secret }],
      }),
    () => vault.revoke(database.name),
    () => {
      vault.lock();
      vault.unlock(passphrase);
    },
  ]) {
    const old = revision();
    change();
    assert.notEqual(revision(), old);
    assert.throws(() => vault.approve(database.name, 'day', old), /settings changed/);
    assert.equal(vault.snapshot().grants.length, 0);
    const current = revision();
    vault.approve(database.name, 'once', current, true);
    assert.throws(() => vault.approve(database.name, 'day', current), /settings changed/);
    vault.revoke(database.name);
  }
  const operation = {
    name: 'api-review',
    item: database.item,
    url: 'https://api.example.com/v1',
    method: 'GET',
    auth: 'headers',
    bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
    body: '',
  };
  vault.saveOperation(operation);
  const old = vault.snapshot().operations[0]!.revision;
  vault.saveOperation({ ...operation, url: 'https://api.example.com/v2' });
  assert.throws(() => vault.approve(operation.name, 'hour', old), /settings changed/);
});
test('database reads require approval and atomically consume once before I/O', async (t) => {
  let reads = 0;
  const vault = fixture(t, async (_database, received) => {
    reads++;
    assert.equal(received, secret);
    throw new Error(secret);
  });
  await assert.rejects(vault.readRows(query), /Approval required/);
  assert.equal(reads, 0);
  assert.equal(vault.requestAccess(database.name).state, 'awaiting-approval');
  vault.approve(database.name, 'once', undefined, true);
  const results = await Promise.allSettled([vault.readRows(query), vault.readRows(query)]);
  assert.equal(reads, 1);
  assert.ok(results.every((result) => result.status === 'rejected'));
  for (const result of results)
    if (result.status === 'rejected') assert.ok(!publicError(result.reason).includes(secret));
  await assert.rejects(vault.readRows(query), /Approval required/);
});
test('database edits, rotation, deletion and expiry invalidate access', async (t) => {
  const vault = fixture(t);
  vault.approve(database.name, 'until-revoked', undefined, true);
  assert.deepEqual((await vault.readRows(query)).rows, [['1', 'Notebook']]);
  vault.saveDatabase(database);
  await assert.rejects(vault.readRows(query), /Approval required/);
  vault.approve(database.name, 'hour', undefined, true);
  vault.saveItem({
    name: database.item,
    kind: 'secret',
    fields: [{ name: 'value', value: secret }],
  });
  await assert.rejects(vault.readRows(query), /Approval required/);
  vault.approve(database.name, 'hour', undefined, true);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 3_600_001);
  await assert.rejects(vault.readRows(query), /Approval required/);
  vault.deleteItem(database.item);
  assert.equal(vault.snapshot().databases.length, 0);
  assert.equal(vault.snapshot().grants.length, 0);
});
test('revocation aborts database reads and suppresses late rows even after reapproval', async (t) => {
  let finish!: (value: Awaited<ReturnType<ReadDatabase>>) => void;
  let signal!: AbortSignal;
  const vault = fixture(t, (_database, _secret, _query, current) => {
    signal = current;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  vault.approve(database.name, 'until-revoked', undefined, true);
  const pending = vault.readRows(query);
  vault.revoke(database.name);
  assert.equal(signal.aborted, true);
  vault.approve(database.name, 'until-revoked', undefined, true);
  finish({
    connection: query.connection,
    columns: query.columns,
    rows: [['1', 'late']],
    limit: query.limit,
  });
  await assert.rejects(pending, /access ended/);
});
test('an HTTP grant cannot be retargeted to a database with the same name', (t) => {
  const vault = fixture(t);
  assert.throws(
    () =>
      vault.saveOperation({
        name: database.name,
        item: database.item,
        url: 'https://api.example.com',
        method: 'GET',
        auth: 'headers',
        bindings: [],
        body: '',
      }),
    /different names/,
  );
  vault.saveOperation({
    name: 'api',
    item: database.item,
    url: 'https://api.example.com',
    method: 'GET',
    auth: 'headers',
    bindings: [{ header: 'Authorization', field: 'value', prefix: '' }],
    body: '',
  });
  assert.throws(() => vault.saveDatabase({ ...database, name: 'api' }), /different names/);
});
