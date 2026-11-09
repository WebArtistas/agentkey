import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { sendOperation } from '../core/transport';
import type { OperationInput } from '../shared/contracts';

const operation: OperationInput = {
  name: 'request',
  item: 'key',
  method: 'POST',
  url: 'https://api.example.com/v1/products',
  auth: 'headers',
  bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
  body: 'name=Demo',
  bodyFormat: 'form',
  responseFields: ['id'],
};
test('HTTPS JSON reader enforces format, size and redirect boundaries without exposing raw errors', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }]);
  let content = '{"id":"prod_1"}';
  let contentType = 'application/json; charset=utf-8';
  let encoding = 'identity';
  let status = 200;
  let response: Readable;
  t.mock.method(
    https,
    'request',
    (options: https.RequestOptions, respond: (response: unknown) => void) => {
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.servername, 'api.example.com');
      assert.deepEqual(options.headers, {
        host: 'api.example.com',
        authorization: 'Bearer synthetic',
        'accept-encoding': 'identity',
        'content-type': 'application/x-www-form-urlencoded',
      });
      const request = new EventEmitter();
      Object.assign(request, {
        end(body: string) {
          assert.equal(body, 'name=Demo');
          response = Readable.from([Buffer.from(content)]);
          Object.assign(response, {
            statusCode: status,
            headers: { 'content-type': contentType, 'content-encoding': encoding },
          });
          respond(response);
        },
      });
      return request;
    },
  );
  const run = () =>
    sendOperation(operation, { authorization: 'Bearer synthetic' }, new AbortController().signal);
  assert.deepEqual(await run(), { status: 200, body: { id: 'prod_1' } });
  content = 'SYNTHETIC-UNPARSEABLE-PRIVATE-BODY';
  await assert.rejects(
    run(),
    (error: Error) => /invalid JSON/.test(error.message) && !error.message.includes(content),
  );
  contentType = 'text/html';
  await assert.rejects(run(), /uncompressed JSON/);
  contentType = 'application/json';
  encoding = 'gzip';
  await assert.rejects(run(), /uncompressed JSON/);
  encoding = 'identity';
  content = JSON.stringify({ large: 'x'.repeat(1_048_576) });
  await assert.rejects(run(), /1 MiB/);
  status = 302;
  assert.equal(await run(), 302);
  assert.equal(response!.destroyed, true);
  status = 204;
  assert.equal(await run(), 204);
});
