import { lstatSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentCommand, Result } from '../shared/contracts';
import { SafeError } from '../core/schema';

const descriptorSchema = z.strictObject({
  version: z.literal(1),
  endpoint: z.string().max(256),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});
const responseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: z.string().max(512) }),
]);
export async function callBroker(
  directory: string,
  command: AgentCommand,
  signal?: AbortSignal,
): Promise<Result<unknown>> {
  if (signal?.aborted) throw new SafeError('AgentKey request cancelled.');
  let descriptor: z.infer<typeof descriptorSchema>;
  try {
    const path = join(directory, 'agent-connection.json');
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('Invalid descriptor');
    descriptor = descriptorSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (process.platform === 'win32') {
      if (!/^\\\\\.\\pipe\\agentkey-[a-f0-9-]{36}$/.test(descriptor.endpoint))
        throw new Error('Invalid pipe');
    } else if (
      dirname(descriptor.endpoint) !== resolve(directory) ||
      !/^[a-f0-9]{16}\.sock$/.test(basename(descriptor.endpoint))
    ) {
      throw new Error('Invalid socket');
    }
  } catch {
    throw new SafeError('AgentKey is unavailable. Open the desktop app and check --data-dir.');
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.endpoint);
    let pending = Buffer.alloc(0);
    let finished = false;
    const fail = (): void => {
      if (!finished) {
        finished = true;
        reject(
          new SafeError(
            'AgentKey connection ended. If a request was running, check the target before retrying; effects may already have occurred.',
          ),
        );
      }
      signal?.removeEventListener('abort', fail);
      socket.destroy();
    };
    signal?.addEventListener('abort', fail, { once: true });
    socket.setTimeout(
      command.action === 'run-command'
        ? 127_000
        : command.action === 'wait-for-approval'
          ? 52_000
          : 22_000,
      fail,
    );
    socket.once('error', fail);
    socket.once('end', () => {
      if (!finished) fail();
    });
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ token: descriptor.token, command })}\n`),
    );
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 2 * 1024 * 1024) {
        fail();
        return;
      }
      const newline = pending.indexOf(10);
      if (newline < 0) return;
      try {
        const result = responseSchema.parse(
          JSON.parse(pending.subarray(0, newline).toString('utf8')),
        );
        finished = true;
        signal?.removeEventListener('abort', fail);
        resolve(result);
        socket.destroy();
      } catch {
        fail();
      }
    });
  });
}
