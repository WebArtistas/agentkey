import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  | { mode: 'demo' | 'inspect'; path: string }
  | { mode: 'read'; path: string; database: DatabaseInput; query: DatabaseRead };
async function worker(request: SQLiteRequest, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw failure();
  return new Promise((resolve, reject) => {
    // No provider credentials, NODE_OPTIONS, or database path in environment/argv.
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
    let output = Buffer.alloc(0);
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
      if (output.length + chunk.length > 256 * 1024) abort();
      else output = Buffer.concat([output, chunk]);
    });
    child.on('error', () => {
      failed = true;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failed || code !== 0 || signal?.aborted) return reject(failure());
      try {
        resolve(JSON.parse(output.toString('utf8')));
      } catch {
        reject(failure());
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
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
async function withCopy<T>(
  path: string,
  action: (copy: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let directory: string | undefined;
  try {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || signal?.aborted) throw failure();
    if (!(await lstat(path)).isFile()) throw failure();
    await noSidecars(path);
    const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const before = await source.stat();
      if (!before.isFile() || before.size < 100 || before.size > 16 * 1024 * 1024) throw failure();
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
    if (bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || signal?.aborted)
      throw failure();
    directory = await mkdtemp(join(tmpdir(), 'agentkey-sqlite-'));
    const copy = join(directory, 'copy.sqlite');
    try {
      await writeFile(copy, bytes, { mode: 0o600, flag: 'wx' });
    } finally {
      bytes.fill(0);
    }
    return await action(copy);
  } catch {
    throw failure();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
export async function inspectSQLite(path: string, signal?: AbortSignal): Promise<DatabaseTable[]> {
  return withCopy(
    path,
    async (copy) => sqliteTablesSchema.parse(await worker({ mode: 'inspect', path: copy }, signal)),
    signal,
  );
}
export async function createSQLiteDemo(directory: string): Promise<string> {
  const path = join(directory, 'demo.sqlite');
  await worker({ mode: 'demo', path });
  return path;
}
export async function readSQLite(
  path: string,
  database: DatabaseInput,
  query: DatabaseRead,
  signal: AbortSignal,
): Promise<DatabaseResult> {
  return withCopy(
    path,
    async (copy) => {
      const result = resultSchema.parse(
        await worker({ mode: 'read', path: copy, database, query }, signal),
      );
      if (
        result.connection !== database.name ||
        result.limit !== query.limit ||
        JSON.stringify(result.columns) !== JSON.stringify(query.columns) ||
        result.rows.length > query.limit ||
        result.rows.some(
          (row) =>
            row.length !== query.columns.length ||
            row.some(
              (cell) => cell !== null && (Buffer.byteLength(cell) > 4096 || cell.includes(path)),
            ),
        )
      )
        throw failure();
      return result;
    },
    signal,
  );
}
