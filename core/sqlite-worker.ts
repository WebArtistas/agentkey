// Trusted fixed-purpose worker, never an agent shell. Input/output travel only over private pipes.
import { DatabaseSync, constants } from 'node:sqlite';
import { z } from 'zod';
import { databaseReadSchema, databaseSchema, sqlIdentifierSchema } from './database-schema';
import type { DatabaseTable } from '../shared/contracts';

const requestSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('demo'), path: z.string().max(8192) }),
  z.strictObject({ mode: z.literal('inspect'), path: z.string().max(8192) }),
  z.strictObject({
    mode: z.literal('read'),
    path: z.string().max(8192),
    database: databaseSchema,
    query: databaseReadSchema,
  }),
]);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function catalog(db: DatabaseSync): DatabaseTable[] {
  const relations = db.prepare('PRAGMA main.table_list').all();
  if (relations.length > 130) throw new Error();
  const tables: DatabaseTable[] = [];
  for (const relation of relations) {
    if (
      relation.type !== 'table' ||
      relation.schema !== 'main' ||
      typeof relation.name !== 'string' ||
      relation.name.startsWith('sqlite_') ||
      !sqlIdentifierSchema.safeParse(relation.name).success
    )
      continue;
    const columns = db.prepare(`PRAGMA main.table_xinfo(${quote(relation.name)})`).all();
    if (columns.length > 64 || columns.some((column) => column.hidden !== 0)) continue;
    const names = columns.flatMap((column) => {
      const name = sqlIdentifierSchema.safeParse(column.name);
      return name.success ? [name.data] : [];
    });
    if (names.length) tables.push({ schema: 'main', table: relation.name, columns: names });
  }
  return tables.sort((a, b) => a.table.localeCompare(b.table));
}
async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error();
  }
  const request = requestSchema.parse(JSON.parse(input));
  const db = new DatabaseSync(request.path, {
    readOnly: request.mode !== 'demo',
    defensive: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    timeout: 500,
  });
  try {
    db.exec(
      'PRAGMA hard_heap_limit=67108864; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA cache_size=-2048;',
    );
    db.limits.length = 1024 * 1024;
    db.limits.sqlLength = 64 * 1024;
    db.limits.attach = 0;
    if (request.mode === 'demo') {
      db.exec(
        "CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, internal_note TEXT); INSERT INTO products VALUES (1,'Notebook','Synthetic private note'),(2,'Desk lamp','Synthetic private note'),(3,'Pen set','Synthetic private note');",
      );
      process.stdout.write(JSON.stringify({ ok: true }));
      return;
    }
    db.exec('PRAGMA query_only=ON');
    const tables = catalog(db);
    if (request.mode === 'inspect') {
      process.stdout.write(JSON.stringify(tables));
      return;
    }
    const { query, database } = request;
    const policy = database.tables.find(
      (table) => table.schema === 'main' && table.table === query.table,
    );
    const actual = tables.find((table) => table.table === query.table);
    const required = [...query.columns, ...query.filters.map((filter) => filter.column)];
    if (
      database.engine !== 'sqlite' ||
      query.schema !== 'main' ||
      query.connection !== database.name ||
      !policy ||
      !actual ||
      required.some(
        (column) => !policy.columns.includes(column) || !actual.columns.includes(column),
      )
    )
      throw new Error();
    db.setAuthorizer((action, table, column, schema, origin) => {
      if (origin) return constants.SQLITE_DENY;
      if (action === constants.SQLITE_SELECT) return constants.SQLITE_OK;
      if (
        action === constants.SQLITE_READ &&
        schema === 'main' &&
        table === query.table &&
        column !== null &&
        required.includes(column)
      )
        return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    });
    const values: (string | number)[] = [];
    const filters = query.filters.map(({ column, value }) => {
      if (value === null) return `${quote(column)} IS NULL`;
      values.push(typeof value === 'boolean' ? Number(value) : value);
      return `${quote(column)} = ?`;
    });
    values.push(query.limit);
    const statement = db.prepare(
      `SELECT ${query.columns.map(quote).join(',')} FROM main.${quote(query.table)}${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} LIMIT ?`,
    );
    statement.setReadBigInts(true);
    const rows = [];
    let bytes = 0;
    for (const row of statement.iterate(...values)) {
      const cells = query.columns.map((column) => {
        const value = row[column];
        if (value === null) return null;
        if (!['string', 'number', 'bigint'].includes(typeof value)) throw new Error();
        const text = String(value);
        if (Buffer.byteLength(text) > 4096) throw new Error();
        return text;
      });
      bytes += Buffer.byteLength(JSON.stringify(cells));
      if (bytes > 250 * 1024) throw new Error();
      rows.push(cells);
    }
    process.stdout.write(
      JSON.stringify({
        connection: database.name,
        columns: query.columns,
        rows,
        limit: query.limit,
      }),
    );
  } finally {
    db.close();
  }
}
void main().catch(() => {
  process.stderr.write('SQLite operation failed.\n');
  process.exitCode = 1;
});
