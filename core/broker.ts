import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { agentCommandSchema, publicError } from './schema';
import { atomicWrite } from './storage';
import type { Vault } from './vault';

export const descriptorName = 'agent-connection.json';

/** Export only a fresh capability and socket, never the vault's containing directory. */
export async function startDatabaseBroker(vault: Vault, notify: () => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ak-db-'));
  try {
    atomicWrite(
      join(directory, 'sandbox.json'),
      JSON.stringify({ version: 1, scope: 'database-only' }),
    );
    const broker = await startBroker(vault, notify, { directory, databaseOnly: true });
    return {
      directory,
      async close() {
        try {
          await broker.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

const requestSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  command: agentCommandSchema,
});
export async function startBroker(
  vault: Vault,
  notify: () => void = () => {},
  options: { directory?: string; databaseOnly?: boolean } = {},
): Promise<{ close(): Promise<void> }> {
  const directory = options.directory ?? vault.storage.directory;
  const token = randomBytes(32).toString('hex');
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agentkey-${randomUUID()}`
      : join(directory, `${randomBytes(8).toString('hex')}.sock`);
  if (process.platform !== 'win32' && Buffer.byteLength(endpoint) > 100)
    throw new Error('Vault directory path is too long for a local socket.');
  const descriptor = join(directory, descriptorName);
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    if (clients.size >= 32) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => clients.delete(socket));
    socket.setTimeout(20_000, () => socket.destroy());
    let pending = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) {
        socket.destroy();
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 16384) {
        socket.destroy();
        return;
      }
      const newline = pending.indexOf(10);
      if (newline < 0) return;
      handled = true;
      const reply = (value: unknown): void => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`);
      };
      let input: z.infer<typeof requestSchema>;
      try {
        input = requestSchema.parse(JSON.parse(pending.subarray(0, newline).toString('utf8')));
        if (!timingSafeEqual(Buffer.from(input.token, 'hex'), Buffer.from(token, 'hex')))
          throw new Error('Unauthorized');
      } catch {
        reply({ ok: false, error: 'Invalid or unauthorized request.' });
        return;
      }
      if (options.databaseOnly) {
        const command = input.command;
        const allowed =
          command.action === 'status' ||
          command.action === 'list-databases' ||
          command.action === 'read-database' ||
          (command.action === 'request-access' &&
            vault.snapshot().databases.some((database) => database.name === command.operation));
        if (!allowed) {
          reply({ ok: false, error: 'This connection permits database tools only.' });
          return;
        }
      }
      void vault
        .dispatch(input.command)
        .then(
          (value) => reply({ ok: true, value }),
          (error: unknown) => reply({ ok: false, error: publicError(error) }),
        )
        .finally(() => {
          if (input.command.action === 'request-access') notify();
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('error', () => {});
  try {
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600);
    atomicWrite(descriptor, JSON.stringify({ version: 1, endpoint, token }));
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (existsSync(descriptor)) {
        try {
          if (JSON.parse(readFileSync(descriptor, 'utf8')).token === token) unlinkSync(descriptor);
        } catch {
          /* A replaced or unreadable descriptor is not ours to remove. */
        }
      }
    },
  };
}
