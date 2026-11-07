import { Client, type ClientConfig } from 'pg';
import type { DatabaseInput, DatabaseRead, DatabaseResult, ItemInput } from '../shared/contracts';
import { SafeError } from './schema';
import { isAbsolute } from 'node:path';
import { readSQLite } from './sqlite';

const failure = () =>
  new SafeError(
    'Database read failed. Check the local connection, restricted role and allowed columns. No database error details were returned.',
  );
const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** URL options cannot override the transport, TLS, timeouts or startup settings. */
export function databaseConfig(value: string): ClientConfig {
  try {
    const url = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.search ||
      url.hash ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.username ||
      !url.password ||
      !/^\/[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(url.pathname)
    )
      throw new Error();
    const port = url.port ? Number(url.port) : 5432;
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      Buffer.byteLength(user) > 63 ||
      /[\x00-\x1f\x7f]/.test(user + password)
    )
      throw new Error();
    return {
      host: url.hostname === '[::1]' ? '::1' : '127.0.0.1',
      port,
      database: url.pathname.slice(1),
      user,
      password,
      ssl: false,
      application_name: 'agentkey-readonly',
      connectionTimeoutMillis: 3000,
      query_timeout: 5000,
      statement_timeout: 3000,
      lock_timeout: 1000,
      idle_in_transaction_session_timeout: 5000,
      options: '-c default_transaction_read_only=on -c search_path=pg_catalog',
      // Treat every result as text: no user-defined JS parsers, precision loss or JSON revival.
      types: { getTypeParser: () => (text: string) => text },
    };
  } catch {
    throw new SafeError(
      'Use a local PostgreSQL URL with username, password and database, without URL options. Remote databases are not enabled.',
    );
  }
}
export function databaseSecret(database: DatabaseInput, item: ItemInput): string {
  if (database.source === 'snapshot')
    throw new SafeError('Managed SQLite imports do not use vault item fields.');
  const value = item.fields.find((field) => field.name === database.field)?.value;
  if (!value) throw new SafeError('Choose an existing database source field.');
  if (database.engine === 'sqlite') {
    if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))
      throw new SafeError('Choose a local SQLite file through the desktop setup.');
  } else databaseConfig(value);
  return value;
}
export function readStatement(
  database: DatabaseInput,
  query: DatabaseRead,
): { text: string; values: (string | number | boolean | null)[] } {
  const table = database.tables.find(
    (table) => table.schema === query.schema && table.table === query.table,
  );
  if (
    query.connection !== database.name ||
    !table ||
    [...query.columns, ...query.filters.map((filter) => filter.column)].some(
      (column) => !table.columns.includes(column),
    )
  )
    throw new SafeError('This table or column is not allowed for the named connection.');
  const values: (string | number | boolean | null)[] = [];
  const where = query.filters.map(({ column, value }) => {
    if (value === null) return `${quote(column)} IS NULL`;
    values.push(value);
    return `${quote(column)} = $${values.length}`;
  });
  const expressions = query.columns.map((column) => `${quote(column)}::pg_catalog.text`);
  // Bound each cell on the server, before node-postgres buffers it. Oversized rows fail closed.
  const projections = expressions.map(
    (value) => `CASE WHEN pg_catalog.octet_length(${value}) <= 4096 THEN ${value} ELSE NULL END`,
  );
  projections.push(
    `(${expressions.map((value) => `COALESCE(pg_catalog.octet_length(${value}) > 4096, false)`).join(' OR ')})`,
  );
  values.push(query.limit);
  return {
    text: `SELECT ${projections.join(', ')} FROM ${quote(table.schema)}.${quote(table.table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} LIMIT $${values.length}`,
    values,
  };
}
export type ReadDatabase = (
  database: DatabaseInput,
  secret: string,
  query: DatabaseRead,
  signal: AbortSignal,
) => Promise<DatabaseResult>;
export const readDatabase: ReadDatabase = async (database, secret, query, signal) => {
  const statement = readStatement(database, query);
  if (database.engine === 'sqlite') return readSQLite(secret, database, query, signal);
  const config = databaseConfig(secret);
  const client = new Client(config);
  // Socket/driver errors must never escape into logs, MCP or the desktop renderer.
  client.on('error', () => {});
  const abort = () => {
    void client.end().catch(() => {});
  };
  if (signal.aborted) throw failure();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 8000);
  try {
    await client.connect();
    if (signal.aborted) throw failure();
    await client.query('BEGIN READ ONLY');
    const role = await client.query<{ unsafe: string }>(
      `SELECT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles privileged WHERE (privileged.rolsuper OR privileged.rolcreaterole OR privileged.rolcreatedb OR privileged.rolreplication OR privileged.rolbypassrls) AND pg_catalog.pg_has_role(current_user, privileged.oid, 'MEMBER')))::text AS unsafe FROM pg_catalog.pg_roles WHERE rolname = current_user`,
    );
    if (role.rows.length !== 1 || role.rows[0]?.unsafe !== 'false') throw failure();
    const relation = `${quote(query.schema)}.${quote(query.table)}`;
    const permission = await client.query<{ unsafe: string }>(
      `SELECT (pg_catalog.has_table_privilege(current_user, $1, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(current_user, $1, 'INSERT,UPDATE,REFERENCES') OR pg_catalog.has_schema_privilege(current_user, $2, 'CREATE') OR pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE,TEMP'))::text AS unsafe`,
      [relation, query.schema],
    );
    if (permission.rows[0]?.unsafe !== 'false') throw failure();
    const result = await client.query<(string | null)[]>({ ...statement, rowMode: 'array' });
    const password = typeof config.password === 'string' ? config.password : '';
    const rows = result.rows.map((row) => {
      if (row.at(-1) !== 'false' && row.at(-1) !== 'f') throw failure();
      const cells = row.slice(0, -1);
      if (
        cells.some(
          (value) =>
            value !== null &&
            (Buffer.byteLength(value) > 4096 ||
              value.includes(secret) ||
              (password && value.includes(password))),
        )
      )
        throw failure();
      return cells;
    });
    const response: DatabaseResult = {
      connection: database.name,
      columns: query.columns,
      rows,
      limit: query.limit,
    };
    if (Buffer.byteLength(JSON.stringify(response)) > 256 * 1024 || signal.aborted) throw failure();
    await client.query('ROLLBACK');
    return response;
  } catch {
    throw failure();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    await client.end().catch(() => {});
  }
};
