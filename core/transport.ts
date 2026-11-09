import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { ItemInput, OperationInput } from '../shared/contracts';
import { SafeError } from './schema';
import { validateHttpScope, validateResponseFields } from './http-policy';

export function destination(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeError('Use an absolute HTTPS URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.') ||
    isIP(url.hostname) ||
    url.hostname.startsWith('[') ||
    /\s/.test(raw) ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local') ||
    url.hostname.endsWith('.internal')
  ) {
    throw new SafeError(
      'Use a public HTTPS hostname on port 443, without user info or a fragment.',
    );
  }
  return url;
}
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}
const forbiddenHeaders = new Set([
  'host',
  'content-type',
  'content-length',
  'connection',
  'transfer-encoding',
  'trailer',
  'te',
  'upgrade',
  'expect',
  'accept-encoding',
]);
export function validateOperation(operation: OperationInput, item: ItemInput): void {
  destination(operation.url);
  validateResponseFields(operation.responseFields ?? []);
  validateHttpScope(operation);
  if (operation.method === 'GET' && operation.body)
    throw new SafeError('GET operations cannot have a request body.');
  if (operation.body && operation.bodyFormat !== 'form') {
    try {
      JSON.parse(operation.body);
    } catch {
      throw new SafeError('The fixed request body must be valid JSON.');
    }
  }
  if (operation.auth === 'basic') {
    if (item.kind !== 'login' || operation.bindings.length)
      throw new SafeError('Basic authentication requires a Login and no header bindings.');
  } else {
    if (!operation.bindings.length) throw new SafeError('Add at least one secret header binding.');
    const headers = new Set<string>();
    for (const binding of operation.bindings) {
      const header = binding.header.toLowerCase();
      if (
        headers.has(header) ||
        forbiddenHeaders.has(header) ||
        header.startsWith('proxy-') ||
        header.startsWith('sec-') ||
        !item.fields.some((field) => field.name === binding.field)
      ) {
        throw new SafeError(
          'Header bindings must be unique, safe headers referencing existing fields.',
        );
      }
      headers.add(header);
    }
  }
}
export function secretHeaders(operation: OperationInput, item: ItemInput): Record<string, string> {
  validateOperation(operation, item);
  const fields = new Map(item.fields.map((field) => [field.name, field.value]));
  if (operation.auth === 'basic') {
    const username = fields.get('username')!;
    if (username.includes(':'))
      throw new SafeError('Basic authentication usernames cannot contain a colon.');
    return {
      authorization: `Basic ${Buffer.from(`${username}:${fields.get('password')!}`, 'utf8').toString('base64')}`,
    };
  }
  const headers: Record<string, string> = Object.create(null);
  for (const binding of operation.bindings) {
    const value = `${binding.prefix}${fields.get(binding.field)!}`;
    if (!/^[\x20-\x7e]+$/.test(value))
      throw new SafeError('This secret cannot be used in an HTTP header.');
    headers[binding.header.toLowerCase()] = value;
  }
  return headers;
}
export type SendOperation = (
  operation: OperationInput,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<number | { status: number; body: unknown }>;

/** Pinned public HTTPS only; no redirects, proxy environment, cookies or response headers. */
export const sendOperation: SendOperation = async (operation, headers, parentSignal) => {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15_000)]);
  const url = destination(operation.url);
  // Validate every DNS answer, then connect to one checked address. Never resolve again at connect time.
  signal.throwIfAborted();
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = (): void => reject(new SafeError('The request was cancelled before connection.'));
    signal.addEventListener('abort', abort, { once: true });
    void lookup(url.hostname, { all: true, verbatim: true })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new SafeError('The destination resolved to a private or reserved address.');
  }
  const target = addresses[0]!;
  return new Promise<number | { status: number; body: unknown }>((resolve, reject) => {
    const req = request(
      {
        protocol: 'https:',
        hostname: target.address,
        family: target.family,
        port: 443,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: operation.method,
        agent: false,
        rejectUnauthorized: true,
        signal,
        maxHeaderSize: 16_384,
        headers: {
          ...headers,
          host: url.host,
          'accept-encoding': 'identity',
          ...(operation.body
            ? {
                'content-type':
                  operation.bodyFormat === 'form'
                    ? 'application/x-www-form-urlencoded'
                    : 'application/json',
              }
            : {}),
        },
      },
      (res) => {
        const status = res.statusCode;
        if (status === undefined) {
          res.destroy();
          reject(new SafeError('The API did not return a status.'));
          return;
        }
        if (!operation.responseFields?.length || status < 200 || status >= 300 || status === 204) {
          res.destroy();
          resolve(status);
          return;
        }
        if (
          !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(
            res.headers['content-type'] ?? '',
          ) ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
        ) {
          res.destroy();
          reject(
            new SafeError(
              'Expected an uncompressed JSON response. The API may have processed the request.',
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let ended = false;
        res.once('close', () => {
          for (const chunk of chunks) chunk.fill(0);
          if (!ended) reject(new SafeError('Response interrupted. Check the API before retrying.'));
        });
        res.on('error', () =>
          reject(new SafeError('Response interrupted. Check the API before retrying.')),
        );
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) {
            chunk.fill(0);
            res.destroy();
            reject(new SafeError('API response exceeds 1 MiB. Request fewer records.'));
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          ended = true;
          const bytes = Buffer.concat(chunks);
          try {
            resolve({ status, body: JSON.parse(bytes.toString('utf8')) as unknown });
          } catch {
            reject(
              new SafeError('The API returned invalid JSON. No response content was returned.'),
            );
          } finally {
            bytes.fill(0);
            for (const chunk of chunks) chunk.fill(0);
          }
        });
      },
    );
    req.on('error', () =>
      reject(
        new SafeError(
          'The request failed or was cancelled. It may already have reached the API; check before retrying.',
        ),
      ),
    );
    req.end(operation.body || undefined);
  });
};
