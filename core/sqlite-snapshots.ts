import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { parseInput, SafeError, snapshotRecordSchema, type SnapshotRecord } from './schema';
import { atomicWrite } from './storage';
import { MAX_SQLITE_BYTES, validateSQLiteBytes } from './sqlite';

const magic = Buffer.from('AKSQL001');
const headerSize = 8 + 12 + 16;
const failure = () =>
  new SafeError(
    'Unable to access the encrypted SQLite import. No file or key details were returned.',
  );
function snapshotPath(directory: string, id: string): string {
  const root = join(directory, 'sqlite-snapshots');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
  return join(root, `${id}.aks`);
}
export function saveSQLiteSnapshot(directory: string, bytes: Buffer): SnapshotRecord {
  validateSQLiteBytes(bytes);
  const id = randomUUID();
  const key = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`AgentKey:SQLite:v1:${id}`));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    atomicWrite(
      snapshotPath(directory, id),
      Buffer.concat([magic, iv, cipher.getAuthTag(), ciphertext]),
    );
    return { id, key: key.toString('hex') };
  } catch {
    throw failure();
  } finally {
    key.fill(0);
  }
}
export async function loadSQLiteSnapshot(
  directory: string,
  input: SnapshotRecord,
  signal: AbortSignal,
): Promise<Buffer> {
  let key: Buffer | undefined;
  let clear: Buffer | undefined;
  try {
    const record = parseInput(snapshotRecordSchema, input);
    if (signal.aborted) throw failure();
    const path = snapshotPath(directory, record.id);
    if (!lstatSync(path).isFile()) throw failure();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let encoded: Buffer;
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.size < headerSize + 100 ||
        before.size > headerSize + MAX_SQLITE_BYTES
      )
        throw failure();
      encoded = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < encoded.length) {
        if (signal.aborted) throw failure();
        const { bytesRead } = await file.read(encoded, offset, encoded.length - offset, offset);
        if (!bytesRead) throw failure();
        offset += bytesRead;
      }
      const after = await file.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw failure();
    } finally {
      await file.close();
    }
    if (!encoded.subarray(0, 8).equals(magic) || signal.aborted) throw failure();
    key = Buffer.from(record.key, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(8, 20));
    decipher.setAAD(Buffer.from(`AgentKey:SQLite:v1:${record.id}`));
    decipher.setAuthTag(encoded.subarray(20, headerSize));
    clear = decipher.update(encoded.subarray(headerSize));
    // Never pass unauthenticated plaintext to SQLite, even when decryption produced bytes.
    if (decipher.final().length) throw failure();
    validateSQLiteBytes(clear);
    if (signal.aborted) throw failure();
    return clear;
  } catch {
    clear?.fill(0);
    throw failure();
  } finally {
    key?.fill(0);
  }
}
