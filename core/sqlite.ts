import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type {
  DatabaseInput,
  DatabaseRead,
  DatabaseResult,
  DatabaseTable,
} from '../shared/contracts';
import { sqlIdentifierSchema } from './database-schema';
import { SafeError } from './schema';

export const MAX_SQLITE_BYTES = 16 * 1024 * 1024;
const failure = () =>
  new SafeError(
    'SQLite operation failed. Choose a closed, exported SQLite file (maximum 16 MiB), without WAL or journal sidecars. No file details were returned.',
  );
export const sqliteTablesSchema = z
  .array(
    z.strictObject({
      schema: z.literal('main'),
      table: sqlIdentifierSchema,
      columns: z.array(sqlIdentifierSchema).min(1).max(64),
    }),
  )
  .max(128);
const resultSchema = z.strictObject({
  connection: z.string(),
  columns: z.array(z.string()).max(16),
  rows: z.array(z.array(z.string().nullable()).max(16)).max(100),
  limit: z.number(),
});
type SQLiteRequest =
  { mode: 'demo' | 'inspect' } | { mode: 'read'; database: DatabaseInput; query: DatabaseRead };
async function worker(
  request: SQLiteRequest,
  bytes?: Buffer,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) throw failure();
  return new Promise((resolve, reject) => {
    // Fixed code and private pipes only: no source paths, keys or provider credentials in argv/env.
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=96', join(__dirname, 'sqlite-worker.js')],
      {
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    let failed = false;
    const abort = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(abort, 5000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on('error', abort);
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > (request.mode === 'demo' ? MAX_SQLITE_BYTES : 256 * 1024)) abort();
      else chunks.push(chunk);
    });
    child.on('error', () => {
      failed = true;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failed || code !== 0 || signal?.aborted) {
        for (const chunk of chunks) chunk.fill(0);
        return reject(failure());
      }
      const output = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      resolve(output);
    });
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end(bytes);
  });
}
async function jsonWorker(
  request: SQLiteRequest,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<unknown> {
  const output = await worker(request, bytes, signal);
  try {
    return JSON.parse(output.toString('utf8'));
  } catch {
    throw failure();
  } finally {
    output.fill(0);
  }
}
async function noSidecars(path: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await lstat(path + suffix);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw failure();
    }
    throw failure();
  }
}
export function validateSQLiteBytes(bytes: Buffer): void {
  // SQLite deserialize cannot load WAL-mode images. Never rewrite the user's header to bypass it.
  if (
    bytes.length < 100 ||
    bytes.length > MAX_SQLITE_BYTES ||
    bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
    bytes[18] !== 1 ||
    bytes[19] !== 1
  )
    throw failure();
}
export async function readSQLiteFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  let bytes: Buffer | undefined;
  try {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || signal?.aborted) throw failure();
    if (!(await lstat(path)).isFile()) throw failure();
    await noSidecars(path);
    const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await source.stat();
      if (!before.isFile() || before.size < 100 || before.size > MAX_SQLITE_BYTES) throw failure();
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        if (signal?.aborted) throw failure();
        const { bytesRead } = await source.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw failure();
        offset += bytesRead;
      }
      const after = await source.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw failure();
    } finally {
      await source.close();
    }
    await noSidecars(path);
    validateSQLiteBytes(bytes);
    if (signal?.aborted) throw failure();
    return bytes;
  } catch {
    bytes?.fill(0);
    throw failure();
  }
}
export async function inspectSQLiteBytes(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<DatabaseTable[]> {
  validateSQLiteBytes(bytes);
  return sqliteTablesSchema.parse(await jsonWorker({ mode: 'inspect' }, bytes, signal));
}
export async function inspectSQLite(path: string, signal?: AbortSignal): Promise<DatabaseTable[]> {
  const bytes = await readSQLiteFile(path, signal);
  try {
    return await inspectSQLiteBytes(bytes, signal);
  } finally {
    bytes.fill(0);
  }
}
export async function createSQLiteDemo(signal?: AbortSignal): Promise<Buffer> {
  const bytes = await worker({ mode: 'demo' }, undefined, signal);
  try {
    validateSQLiteBytes(bytes);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
export async function readSQLiteBytes(
  bytes: Buffer,
  database: DatabaseInput,
  query: DatabaseRead,
  signal: AbortSignal,
): Promise<DatabaseResult> {
  validateSQLiteBytes(bytes);
  const result = resultSchema.parse(
    await jsonWorker({ mode: 'read', database, query }, bytes, signal),
  );
  if (
    result.connection !== database.name ||
    result.limit !== query.limit ||
    JSON.stringify(result.columns) !== JSON.stringify(query.columns) ||
    result.rows.length > query.limit ||
    result.rows.some(
      (row) =>
        row.length !== query.columns.length ||
        row.some((cell) => cell !== null && Buffer.byteLength(cell) > 4096),
    )
  )
    throw failure();
  return result;
}
export async function readSQLite(
  path: string,
  database: DatabaseInput,
  query: DatabaseRead,
  signal: AbortSignal,
): Promise<DatabaseResult> {
  const bytes = await readSQLiteFile(path, signal);
  try {
    const result = await readSQLiteBytes(bytes, database, query, signal);
    if (result.rows.some((row) => row.some((cell) => cell?.includes(path)))) throw failure();
    return result;
  } finally {
    bytes.fill(0);
  }
}
