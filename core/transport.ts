import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { ItemInput, OperationInput } from '../shared/contracts';
import { SafeError } from './schema';

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
  if (operation.method === 'GET' && operation.body)
    throw new SafeError('GET operations cannot have a request body.');
  if (operation.body) {
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
) => Promise<number>;

/** No redirects, proxy environment, cookies, response bodies, or caller-controlled URLs. */
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
  return new Promise<number>((resolve, reject) => {
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
          ...(operation.body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const status = res.statusCode;
        res.destroy();
        if (status === undefined) reject(new SafeError('The API did not return a status.'));
        else resolve(status);
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
