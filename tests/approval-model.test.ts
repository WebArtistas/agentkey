import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalEntries } from '../src/app/approval-model';
import type { VaultSnapshot } from '../shared/contracts';

const operation = {
  name: 'saved-api',
  revision: 'saved-review',
  item: 'api-key',
  url: 'https://api.example.com/v1/products',
  method: 'GET' as const,
  auth: 'headers' as const,
  bindings: [],
  hasBody: false,
};
function snapshot(): VaultSnapshot {
  return {
    initialized: true,
    unlocked: true,
    items: [],
    commands: [],
    operations: [operation],
    proposals: [
      {
        revision: 'proposal-review',
        requestedAt: 20,
        operation: { ...operation, name: 'new-api', body: '' },
      },
    ],
    databases: [
      {
        name: 'catalog',
        source: 'snapshot',
        engine: 'sqlite',
        snapshot: 'private-snapshot-id',
        revision: 'database-review',
        tables: [{ schema: 'main', table: 'products', columns: ['id', 'name'] }],
      },
    ],
    grants: [],
    pending: [],
    audit: [],
  };
}

test('approval categories distinguish new requests, requested saved policies and active grants', () => {
  const data = snapshot();
  data.pending = [{ operation: 'catalog', requestedAt: 10 }];
  data.grants = [{ operation: 'saved-api', remainingUses: null, expiresAt: 1000 }];
  const before = structuredClone(data);
  const entries = approvalEntries(data);
  assert.deepEqual(
    entries.map(({ name, category, kind }) => ({ name, category, kind })),
    [
      { name: 'catalog', category: 'pending', kind: 'database' },
      { name: 'new-api', category: 'pending', kind: 'api' },
      { name: 'saved-api', category: 'active', kind: 'api' },
    ],
  );
  assert.deepEqual(data, before);
  data.grants = [];
  data.pending = [];
  assert.equal(
    approvalEntries(data).find((entry) => entry.name === 'saved-api')?.category,
    'inactive',
  );
  assert.equal(
    approvalEntries(data).find((entry) => entry.name === 'catalog')?.category,
    'inactive',
  );
});

test('search uses public names, destinations, item references and selected table metadata only', () => {
  const data = snapshot();
  data.databases.push({
    name: 'local-pg',
    item: 'db-key',
    field: 'value',
    tables: [],
    revision: 'pg-review',
  });
  const entries = approvalEntries(data);
  assert.ok(entries.find((entry) => entry.name === 'local-pg')?.search.includes('postgresql'));
  assert.ok(entries.find((entry) => entry.name === 'saved-api')?.search.includes('api-key'));
  assert.ok(
    entries.find((entry) => entry.name === 'saved-api')?.search.includes('api.example.com'),
  );
  assert.ok(entries.find((entry) => entry.name === 'catalog')?.search.includes('main.products'));
  assert.ok(!JSON.stringify(entries).includes('private-snapshot-id'));
  assert.equal(entries.find((entry) => entry.name === 'catalog')?.destination, 'SQLite');
});
