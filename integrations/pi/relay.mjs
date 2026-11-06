import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const text = z.object({
  type: z.literal('text'),
  text: z.string(),
  textSignature: z.string().optional(),
});
const thinking = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const toolCall = z.object({
  type: z.literal('toolCall'),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  thoughtSignature: z.string().optional(),
});
const usage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});
export const assistantSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(z.union([text, thinking, toolCall])).max(64),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  responseId: z.string().optional(),
  responseModel: z.string().optional(),
  usage,
  stopReason: z.enum(['stop', 'length', 'toolUse']),
  timestamp: z.number(),
});
// Images and URLs-as-resources are deliberately unsupported. Nothing the agent sends
// may make the host resolve arbitrary files/URLs, provider options or credentials.
export const contextSchema = z.strictObject({
  messages: z
    .array(
      z.discriminatedUnion('role', [
        z.object({
          role: z.literal('system'),
          content: z.union([z.string(), z.array(text)]),
          sections: z.record(z.string(), z.string().nullable()).optional(),
          toolsAdded: z
            .array(
              z.object({
                name: z.string(),
                description: z.string(),
                parameters: z.record(z.string(), z.unknown()),
              }),
            )
            .max(16)
            .optional(),
          toolsRemoved: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
          timestamp: z.number(),
        }),
        z.object({
          role: z.literal('user'),
          content: z.union([z.string(), z.array(text)]),
          timestamp: z.number(),
        }),
        assistantSchema,
        z.object({
          role: z.literal('toolResult'),
          toolCallId: z.string(),
          toolName: z.string(),
          content: z.array(text),
          isError: z.boolean(),
          timestamp: z.number(),
        }),
      ]),
    )
    .min(1)
    .max(128),
});
const requestSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  context: contextSchema,
});
export const maxFrameBytes = 256 * 1024;
const failed = { ok: false, error: 'Inference relay refused or could not complete the request.' };

/** Fixed provider/model closure on the host. Never returns credentials or provider errors. */
export async function startRelay(complete, { maxCalls = 12, lifetimeMs = 180_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ak-ai-'));
  const endpoint = join(directory, 'inference.sock');
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  const controllers = new Set();
  let calls = 0;
  let closed = false;
  const server = createServer((socket) => {
    if (closed || sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    controllers.add(controller);
    socket.on('error', () => {});
    socket.once('close', () => {
      controller.abort();
      sockets.delete(socket);
      controllers.delete(controller);
    });
    socket.setTimeout(65_000, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) {
        socket.destroy();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > maxFrameBytes) {
        socket.destroy();
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      handled = true;
      const reply = (response) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
      };
      let request;
      try {
        if (end !== bytes.length - 1) throw new Error();
        request = requestSchema.parse(JSON.parse(bytes.subarray(0, end).toString('utf8')));
        if (
          !timingSafeEqual(Buffer.from(request.token, 'hex'), Buffer.from(token, 'hex')) ||
          calls >= maxCalls ||
          controllers.size > 1
        )
          throw new Error();
      } catch {
        reply(failed);
        return;
      }
      calls++;
      const timeout = setTimeout(() => controller.abort(), 60_000);
      void (async () => {
        try {
          const message = assistantSchema.parse(await complete(request.context, controller.signal));
          if (
            controller.signal.aborted ||
            Buffer.byteLength(JSON.stringify(message)) > maxFrameBytes
          )
            throw new Error();
          reply({ ok: true, message });
        } catch {
          reply(failed);
        } finally {
          clearTimeout(timeout);
        }
      })();
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', () => {});
    chmodSync(endpoint, 0o600);
    writeFileSync(join(directory, 'relay.json'), JSON.stringify({ version: 1, endpoint, token }), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    server.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const timer = setTimeout(() => {
    void close();
  }, lifetimeMs);
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    directory,
    close,
    get calls() {
      return calls;
    },
  };
}
