import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import type { TestContext } from 'node:test';

export const postgresImage =
  'postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5';
export async function postgresFixture(t: TestContext) {
  const password = randomBytes(24).toString('hex');
  const name = `agentkey-test-${randomUUID()}`;
  const id = execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--label',
      'org.agentkey.disposable-test=true',
      '--user',
      '70:70',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql:rw,nosuid,size=256m,uid=70,gid=70',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_DB=agentkey_demo',
      postgresImage,
    ],
    { encoding: 'utf8', timeout: 60_000 },
  ).trim();
  let admin: Client | undefined;
  t.after(async () => {
    try {
      await admin?.end();
    } finally {
      execFileSync('docker', ['stop', '--timeout', '3', id], { stdio: 'ignore', timeout: 15_000 });
    }
  });
  const address = execFileSync('docker', ['port', id, '5432/tcp'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const port = Number(address.split(':')[1]);
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: 'agentkey_demo',
      connectionTimeoutMillis: 500,
    });
    try {
      await client.connect();
      admin = client;
      break;
    } catch {
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!admin) throw new Error('Disposable PostgreSQL did not become ready.');
  const connection = admin;
  await connection.query(readFileSync(resolve('examples/postgres/init.sql'), 'utf8'));
  return {
    admin: connection,
    port,
    readerPassword: 'agentkey-demo-reader-only',
    readerUrl: `postgresql://agentkey_reader:agentkey-demo-reader-only@127.0.0.1:${port}/agentkey_demo`,
    adminUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/agentkey_demo`,
  };
}
