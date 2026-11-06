import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vault } from '../../dist/core/vault.js';
import { startDatabaseBroker } from '../../dist/core/broker.js';
import { startRelay } from './relay.mjs';
import { dockerArguments, validateBrokerDirectory, validateRelayDirectory } from './sandbox.mjs';

const linux = process.platform === 'linux';
test(
  'sandbox exports only the dedicated broker, never a vault or extra host files',
  { skip: !linux },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'ak-mount-'));
    const vault = new Vault(directory);
    vault.initialize('synthetic mount-check passphrase');
    const broker = await startDatabaseBroker(vault);
    t.after(async () => {
      await broker.close();
      vault.lock();
      rmSync(directory, { recursive: true, force: true });
    });
    assert.equal(validateBrokerDirectory(broker.directory), broker.directory);
    assert.throws(() => validateBrokerDirectory(directory));
    writeFileSync(join(broker.directory, 'unexpected.txt'), 'synthetic canary');
    assert.throws(() => validateBrokerDirectory(broker.directory), /anything except/);
    rmSync(join(broker.directory, 'unexpected.txt'));
    const alias = join(directory, 'alias');
    symlinkSync(broker.directory, alias);
    assert.throws(() => validateBrokerDirectory(alias), /Invalid broker/);
    chmodSync(join(broker.directory, 'agent-connection.json'), 0o644);
    assert.throws(() => validateBrokerDirectory(broker.directory), /Invalid broker/);
  },
);
test(
  'inference mount cannot include provider credentials or unexpected files',
  { skip: !linux },
  async (t) => {
    const relay = await startRelay(async () => {
      throw new Error('not used');
    });
    t.after(() => relay.close());
    assert.equal(validateRelayDirectory(relay.directory), relay.directory);
    writeFileSync(join(relay.directory, 'auth.json'), '{}', { mode: 0o600 });
    assert.throws(() => validateRelayDirectory(relay.directory), /unexpected/);
  },
);
test(
  'Docker invocation fixes isolation flags and passes no host environment or Docker socket',
  { skip: !linux || !process.getuid?.() },
  () => {
    const args = dockerArguments('agentkey-test-00000000-0000-4000-a000-000000000000', [
      '/tmp/ak-db-example',
    ]);
    for (const [name, value] of [
      ['--network', 'none'],
      ['--cap-drop', 'ALL'],
      ['--security-opt', 'no-new-privileges'],
      ['--log-driver', 'none'],
      ['--pull', 'never'],
      ['--pids-limit', '64'],
    ])
      assert.equal(args[args.indexOf(name) + 1], value);
    assert.ok(args.includes('--read-only'));
    assert.equal(args[args.indexOf('--user') + 1], `${process.getuid()}:${process.getgid()}`);
    assert.ok(!args.includes('--privileged'));
    assert.ok(!args.join(' ').includes('apparmor=unconfined'));
    assert.ok(!args.join(' ').includes('/var/run/docker.sock'));
    assert.equal(args[args.indexOf('--env') + 1], 'HOME=/tmp/agentkey-pi');
    assert.match(args[args.indexOf('--mount') + 1], /readonly$/);
    assert.throws(() => dockerArguments('test', ['/tmp/dir,readonly=false']), /Invalid mount/);
  },
);
