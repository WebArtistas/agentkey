import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { dataSchema, parseInput, SafeError, type VaultData } from './schema';

const MAX_FILE_SIZE = 4 * 1024 * 1024;
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  salt: z.string().regex(/^[0-9a-f]{32}$/),
  iv: z.string().regex(/^[0-9a-f]{24}$/),
  tag: z.string().regex(/^[0-9a-f]{32}$/),
  ciphertext: z
    .string()
    .max(MAX_FILE_SIZE)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export function atomicWrite(path: string, content: string | Uint8Array): void {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    // Persist the rename where directory fsync is supported. Windows lacks it.
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export class VaultStorage {
  readonly path: string;
  #key: Buffer | undefined;
  #salt: Buffer | undefined;

  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
      throw new SafeError('The vault directory must be a real directory.');
    }
    this.path = join(directory, 'vault.json');
  }
  get initialized(): boolean {
    return existsSync(this.path);
  }
  get unlocked(): boolean {
    return this.#key !== undefined;
  }

  initialize(password: string, data: VaultData): void {
    if (this.initialized) throw new SafeError('A vault already exists. Unlock it instead.');
    if (typeof password !== 'string' || password.length < 14 || password.length > 1024) {
      throw new SafeError('Use a master passphrase of 14–1024 characters.');
    }
    this.#salt = randomBytes(16);
    this.#key = this.deriveKey(password, this.#salt);
    try {
      this.save(data);
    } catch (error) {
      this.lock();
      throw error;
    }
  }
  unlock(password: string): VaultData {
    this.lock();
    if (!this.initialized) throw new SafeError('Create a vault in the desktop app first.');
    if (typeof password !== 'string' || password.length > 1024)
      throw new SafeError('Unable to unlock the vault.');
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_SIZE)
        throw new Error('Invalid file');
      const envelope = envelopeSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      this.#salt = Buffer.from(envelope.salt, 'hex');
      this.#key = this.deriveKey(password, this.#salt);
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(envelope.iv, 'hex'));
      decipher.setAAD(Buffer.from('AgentKey:v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      try {
        return dataSchema.parse(JSON.parse(plaintext.toString('utf8')));
      } finally {
        plaintext.fill(0);
      }
    } catch {
      this.lock();
      throw new SafeError('Unable to unlock the vault. Check your passphrase and vault file.');
    }
  }
  save(data: VaultData): void {
    if (!this.#key || !this.#salt) throw new SafeError('The vault is locked.');
    parseInput(dataSchema, data);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from('AgentKey:v1'));
    const plaintext = Buffer.from(JSON.stringify(data));
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const content = JSON.stringify({
        version: 1,
        salt: this.#salt.toString('hex'),
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        ciphertext: ciphertext.toString('base64'),
      });
      if (Buffer.byteLength(content) > MAX_FILE_SIZE) throw new SafeError('The vault is full.');
      atomicWrite(this.path, content);
    } finally {
      plaintext.fill(0);
    }
  }
  lock(): void {
    this.#key?.fill(0);
    this.#key = undefined;
    this.#salt = undefined;
  }
  private deriveKey(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  }
}
