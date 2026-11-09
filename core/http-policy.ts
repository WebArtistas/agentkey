import type { HttpRequest, OperationInput, RunResult } from '../shared/contracts';
import { SafeError } from './schema';

/** No JSONPath expressions or whole-object selection: only bounded scalar leaves. */
export function validateResponseFields(fields: string[]): void {
  if (new Set(fields).size !== fields.length)
    throw new SafeError('Response fields must be unique.');
  for (const field of fields) {
    const parts = field.split('.');
    if (
      parts.length > 8 ||
      parts.some(
        (part) =>
          !/^[a-zA-Z_][a-zA-Z0-9_-]*(\[\])?$/.test(part) ||
          ['__proto__', 'constructor', 'prototype'].includes(part.replace(/\[\]$/, '')),
      )
    )
      throw new SafeError('Use scalar JSON paths such as id or data[].name (up to eight levels).');
  }
}

function safePath(path: string): boolean {
  return (
    /^\/[a-zA-Z0-9_./~-]*$/.test(path) &&
    !path.includes('//') &&
    !path.split('/').some((part) => part === '.' || part === '..')
  );
}
function pathMatches(path: string, rule: string): boolean {
  return rule.endsWith('/*') ? path.startsWith(rule.slice(0, -1)) : path === rule;
}
export function validateHttpScope(operation: OperationInput): void {
  if (!operation.scope) return;
  for (const rule of operation.scope.paths) {
    const path = rule.endsWith('/*') ? rule.slice(0, -1) : rule;
    if (!safePath(path))
      throw new SafeError(
        'Allowed paths must be literal paths, optionally ending in /*. No encoded or dot segments.',
      );
  }
  resolveHttpRequest(operation, operation);
}

export function resolveHttpRequest(
  operation: OperationInput,
  request?: HttpRequest,
): OperationInput {
  if (!request) return structuredClone(operation);
  if (!operation.scope) throw new SafeError('This approval permits only the saved exact request.');
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new SafeError('Use an absolute HTTPS URL.');
  }
  const origin = new URL(operation.url).origin;
  // Compare the raw path too: URL parsing normalizes dot segments and backslashes.
  const rawPath =
    request.url
      .slice(request.url.indexOf('://') + 3)
      .replace(/^[^/\?#]*/, '')
      .split(/[?#]/)[0] || '/';
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    /[\s\\]/.test(request.url) ||
    !safePath(rawPath) ||
    rawPath !== url.pathname ||
    !operation.scope.methods.includes(request.method) ||
    !operation.scope.paths.some((rule) => pathMatches(url.pathname, rule))
  ) {
    throw new SafeError('Request is outside the approved HTTPS origin, paths or methods.');
  }
  return {
    ...structuredClone(operation),
    url: request.url,
    method: request.method,
    body: request.body,
  };
}

type Scalar = string | number | boolean | null;
export function projectResponse(
  body: unknown,
  fields: string[],
  secrets: string[],
): NonNullable<RunResult['data']> {
  validateResponseFields(fields);
  const output: NonNullable<RunResult['data']> = Object.create(null);
  const hidden = [
    ...new Set(
      secrets.flatMap((secret) => [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString('base64'),
      ]),
    ),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  // Literal alternatives match only the original input, never inserted redaction markers.
  // Values longer than a permitted scalar cannot occur inside one.
  const patterns = hidden
    .filter((secret) => secret.length <= 4096)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const redactor = patterns.length ? new RegExp(patterns.join('|'), 'g') : undefined;
  let outputBytes = 2; // JSON object braces; charge keys, separators and values before retaining them.
  const charge = (bytes: number): void => {
    outputBytes += bytes;
    if (outputBytes > 65536) throw new SafeError('Selected JSON data exceeds the response limit.');
  };
  const scalar = (value: unknown): Scalar => {
    if (value === undefined || value === null) {
      charge(4);
      return null;
    }
    if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number')
      throw new SafeError(
        'A selected JSON field is not a scalar. Select its individual child fields.',
      );
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new SafeError('Invalid JSON number.');
    const original = String(value);
    let scalarBytes = Buffer.byteLength(original);
    if (scalarBytes > 4096) throw new SafeError('A selected JSON field exceeds the size limit.');
    const text = redactor
      ? original.replace(redactor, (match) => {
          scalarBytes += 10 - Buffer.byteLength(match); // ASCII [REDACTED]
          if (scalarBytes > 4096)
            throw new SafeError('A selected JSON field exceeds the size limit after redaction.');
          return '[REDACTED]';
        })
      : original;
    const result = text === original ? value : text;
    charge(Buffer.byteLength(JSON.stringify(result)));
    return result;
  };
  for (const field of fields) {
    let values: unknown[] = [body];
    let array = false;
    for (const part of field.split('.')) {
      const many = part.endsWith('[]');
      const key = many ? part.slice(0, -2) : part;
      const next: unknown[] = [];
      for (const value of values) {
        const child: unknown =
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.hasOwn(value, key)
            ? (value as Record<string, unknown>)[key]
            : undefined;
        if (many) {
          array = true;
          if (child !== undefined && child !== null && !Array.isArray(child))
            throw new SafeError('A selected JSON array has an unexpected type.');
          if (Array.isArray(child)) {
            if (next.length + child.length > 100)
              throw new SafeError('Selected JSON arrays exceed 100 entries.');
            next.push(...child);
          }
        } else next.push(child);
      }
      values = next;
    }
    charge(
      Buffer.byteLength(JSON.stringify(field)) +
        1 +
        (Object.keys(output).length ? 1 : 0) +
        (array ? 2 : 0),
    );
    output[field] = array
      ? values.map((value, index) => {
          if (index) charge(1);
          return scalar(value);
        })
      : scalar(values[0]);
  }
  return output;
}
