import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Vault } from '../core/vault';
import { startBroker, startDatabaseBroker } from '../core/broker';
import { callBroker } from '../agent/client';
import { executeCommand, type ExecuteCommand } from '../core/command';
import { agentCommandSchema } from '../core/schema';
import type { CommandInput } from '../shared/contracts';

const secret = 'synthetic-command-secret-78104';
const password = 'synthetic-command-master-passphrase';
function fixture(t: TestContext, execute?: ExecuteCommand) {
  const directory = mkdtempSync(join(tmpdir(), 'ak-cmd-'));
  const vault = new Vault(directory, undefined, undefined, execute);
  vault.initialize(password);
  vault.saveItem({ name: 'key', kind: 'secret', fields: [{ name: 'value', value: secret }] });
  t.after(() => {
    vault.lock();
    rmSync(directory, { recursive: true, force: true });
  });
  const command: CommandInput = {
    name: 'local-check',
    executable: process.execPath,
    cwd: directory,
    args: ['-e', 'process.stdout.write("ok")'],
    bindings: [{ env: 'APP_TOKEN', item: 'key', field: 'value' }],
    timeoutMs: 5000,
  };
  return { vault, command, directory };
}
function approve(vault: Vault, command: CommandInput) {
  const request = vault.proposeCommand(command);
  vault.approveCommand({
    revision: request.revision,
    executionAccepted: true,
    dataSharingAccepted: true,
  });
  return { operation: request.operation, revision: request.revision };
}

test('exact proposals require both consents, cannot use generic grants, and execute once', async (t) => {
  const { vault, command } = fixture(t);
  const request = vault.proposeCommand(command);
  assert.equal(request.state, 'awaiting-approval');
  assert.equal(vault.proposeCommand(command).revision, request.revision);
  assert.throws(() => vault.proposeCommand({ ...command, args: ['changed'] }), /different/);
  assert.throws(() => vault.approve(command.name, 'until-revoked'), /Unknown/);
  for (const approval of [
    { revision: request.revision, executionAccepted: false, dataSharingAccepted: true },
    { revision: request.revision, executionAccepted: true, dataSharingAccepted: false },
    {
      revision: request.revision,
      executionAccepted: true,
      dataSharingAccepted: true,
      duration: 'hour',
    },
  ])
    assert.throws(() => vault.approveCommand(approval), /Invalid/);
  const run = { operation: command.name, revision: request.revision };
  await assert.rejects(vault.runCommand(run), /approval/);
  const waiting = vault.waitForApproval({ operation: command.name });
  vault.approveCommand({
    revision: request.revision,
    executionAccepted: true,
    dataSharingAccepted: true,
  });
  assert.equal((await waiting).state, 'approved');
  assert.throws(
    () =>
      vault.approveCommand({
        revision: request.revision,
        executionAccepted: true,
        dataSharingAccepted: true,
      }),
    /changed/,
  );
  assert.equal(vault.snapshot().grants.length, 0);
  const running = vault.runCommand(run);
  await assert.rejects(vault.runCommand(run), /approval/);
  assert.deepEqual(await running, {
    operation: command.name,
    exitCode: 0,
    successful: true,
    stdout: 'ok',
    stderr: '',
  });
  await assert.rejects(vault.runCommand(run), /approval/);
  assert.equal(vault.snapshot().commands.length, 0);
  assert.equal(vault.snapshot().audit.filter((entry) => entry.event === 'attempted').length, 1);
});

test('real subprocess receives child-only env and redacts split, encoded and URL-component secrets', async (t) => {
  const { vault, command, directory } = fixture(t);
  const file = join(directory, 'fixture.cjs');
  writeFileSync(
    file,
    `const s=process.env.APP_TOKEN; process.stdout.write(s.slice(0,8)); setTimeout(()=>{process.stdout.write(s.slice(8)+' '+Buffer.from(s).toString('base64')+' '+encodeURIComponent(s)); process.stderr.write(new URL(process.env.DB_URL).password); console.log(' inherited:'+Boolean(process.env.AGENTKEY_TEST_PARENT_ONLY)+' arg:'+process.argv[2]);},10);`,
  );
  vault.saveItem({
    name: 'database',
    kind: 'secret',
    fields: [{ name: 'value', value: 'postgres://tester:synthetic-db-password@localhost/db' }],
  });
  const previous = process.env.AGENTKEY_TEST_PARENT_ONLY;
  process.env.AGENTKEY_TEST_PARENT_ONLY = 'must-not-inherit';
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTKEY_TEST_PARENT_ONLY;
    else process.env.AGENTKEY_TEST_PARENT_ONLY = previous;
  });
  const input = {
    ...command,
    args: [file, '$(do-not-expand)'],
    bindings: [...command.bindings, { env: 'DB_URL', item: 'database', field: 'value' }],
  };
  const result = await vault.runCommand(approve(vault, input));
  assert.equal(result.successful, true);
  assert.match(result.stdout, /^\[REDACTED\] \[REDACTED\] \[REDACTED\]/);
  assert.match(result.stdout, /inherited:false arg:\$\(do-not-expand\)/);
  assert.equal(result.stderr, '[REDACTED]');
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(vault.snapshot()).includes(secret));
});

test('validation rejects overrides, relative paths, unknown fields and loader bindings', (t) => {
  const { vault, command } = fixture(t);
  for (const invalid of [
    { ...command, executable: 'node' },
    { ...command, cwd: '.' },
    { ...command, shell: true },
    { ...command, timeoutMs: 120001 },
    { ...command, args: ['\0'] },
    { ...command, bindings: [{ env: 'NODE_OPTIONS', item: 'key', field: 'value' }] },
    { ...command, bindings: [command.bindings[0], command.bindings[0]] },
    { ...command, bindings: [{ env: 'APP_TOKEN', item: 'missing', field: 'value' }] },
  ])
    assert.throws(() => vault.proposeCommand(invalid));
  const run = approve(vault, command);
  assert.equal(
    agentCommandSchema.safeParse({ action: 'run-command', ...run, args: [] }).success,
    false,
  );
  assert.equal(
    agentCommandSchema.safeParse({ action: 'approve-command', revision: run.revision }).success,
    false,
  );
});

test('rotation, deletion, revocation, expiry and restart invalidate command approvals', async (t) => {
  const { vault, command } = fixture(t);
  let run = approve(vault, command);
  vault.saveItem({ name: 'key', kind: 'secret', fields: [{ name: 'value', value: secret }] });
  await assert.rejects(vault.runCommand(run), /approval/);
  run = approve(vault, command);
  vault.revoke(command.name);
  await assert.rejects(vault.runCommand(run), /approval/);
  run = approve(vault, command);
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 600_001);
  await assert.rejects(vault.runCommand(run), /approval/);
  clock.mock.restore();
  run = approve(vault, command);
  vault.lock();
  vault.unlock(password);
  await assert.rejects(vault.runCommand(run), /approval/);
  run = approve(vault, command);
  vault.deleteItem('key');
  await assert.rejects(vault.runCommand(run), /approval/);
});

test('spawn failure, nonzero exit, timeout and output overflow consume approvals without retries', async (t) => {
  const { vault, command, directory } = fixture(t);
  for (const input of [
    { ...command, executable: join(directory, 'missing') },
    { ...command, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 },
    { ...command, args: ['-e', 'process.stdout.write("x".repeat(70000))'] },
  ]) {
    const run = approve(vault, input);
    await assert.rejects(vault.runCommand(run), /could not run|timed out|exceeded/);
    await assert.rejects(vault.runCommand(run), /approval/);
  }
  const result = await vault.runCommand(
    approve(vault, { ...command, args: ['-e', 'process.stderr.write("failed");process.exit(7)'] }),
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.successful, false);
  assert.equal(result.stderr, 'failed');
});

test('lock and revoke suppress late results even if an executor ignores cancellation', async (t) => {
  let finish!: (result: Awaited<ReturnType<ExecuteCommand>>) => void;
  const { vault, command } = fixture(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  for (const action of ['revoke', 'lock'] as const) {
    const running = vault.runCommand(approve(vault, command));
    if (action === 'revoke') vault.revoke(command.name);
    else vault.lock();
    finish({
      operation: command.name,
      exitCode: 0,
      successful: true,
      stdout: 'late data',
      stderr: '',
    });
    await assert.rejects(running, /access ended/);
  }
});

test('audit persistence failure prevents spawn and locks the vault', async (t) => {
  let calls = 0;
  const { vault, command } = fixture(t, async () => {
    calls++;
    throw new Error('must not run');
  });
  const run = approve(vault, command);
  t.mock.method(vault.storage, 'save', () => {
    throw new Error('disk failed');
  });
  await assert.rejects(vault.runCommand(run), /persist/);
  assert.equal(calls, 0);
  assert.equal(vault.snapshot().unlocked, false);
});

test('broker transports proposals and cancellation while database-only brokers deny command tools', async (t) => {
  const { vault, command, directory } = fixture(t);
  let notices = 0;
  const broker = await startBroker(vault, () => notices++);
  const databaseOnly = await startDatabaseBroker(vault);
  t.after(async () => {
    await broker.close();
    await databaseOnly.close();
  });
  const input = { ...command, args: ['-e', 'setInterval(()=>{},1000)'] };
  const proposed = await callBroker(directory, { action: 'propose-command', command: input });
  assert.equal(proposed.ok, true);
  assert.equal(notices, 1);
  assert.equal(
    (await callBroker(databaseOnly.directory, { action: 'propose-command', command: input })).ok,
    false,
  );
  const request = vault.snapshot().commands[0]!;
  vault.approveCommand({
    revision: request.revision,
    executionAccepted: true,
    dataSharingAccepted: true,
  });
  const controller = new AbortController();
  const running = callBroker(
    directory,
    { action: 'run-command', operation: command.name, revision: request.revision },
    controller.signal,
  );
  const rejection = assert.rejects(running, /connection ended/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await rejection;
  for (let n = 0; n < 100 && vault.snapshot().commands.length; n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(vault.snapshot().commands.length, 0);
});

test(
  'MCP stdin EOF cancels the child without forcibly terminating the adapter',
  { timeout: 10_000 },
  async (t) => {
    const { vault, command, directory } = fixture(t);
    const broker = await startBroker(vault);
    const started = join(directory, 'started');
    const late = join(directory, 'late');
    const script = join(directory, 'disconnect.cjs');
    writeFileSync(
      script,
      'const fs=require("node:fs");fs.writeFileSync("started","yes");setTimeout(()=>fs.writeFileSync("late","must not happen"),1500);',
    );
    const run = approve(vault, { ...command, args: [script] });
    const adapter = spawn(
      process.execPath,
      [resolve('dist/agent/cli.js'), 'mcp', '--data-dir', directory],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const closed = once(adapter, 'close');
    const lines = createInterface({ input: adapter.stdout });
    adapter.stderr.resume();
    t.after(async () => {
      lines.close();
      if (adapter.exitCode === null && adapter.signalCode === null) adapter.kill('SIGKILL');
      await closed;
      await broker.close();
    });
    const initialized = once(lines, 'line');
    adapter.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eof-regression', version: '1' } } })}\n`,
    );
    await initialized;
    adapter.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    adapter.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agentkey_run_command', arguments: run } })}\n`,
    );
    for (let n = 0; n < 200 && !existsSync(started); n++) await delay(10);
    assert.equal(existsSync(started), true, 'the approved child actually started');
    adapter.stdin.end(); // Raw EOF only: no SDK client.close() or forced termination.
    for (let n = 0; n < 60 && vault.snapshot().commands.length; n++) await delay(10);
    assert.equal(
      vault.snapshot().commands.length,
      0,
      'EOF must cancel the running command promptly',
    );
    await closed;
    await delay(1600);
    assert.equal(
      existsSync(late),
      false,
      'the cancelled child must not perform its delayed effect',
    );
    await assert.rejects(vault.runCommand(run), /approval/);
  },
);

test('runner cancels a real process and discards output', async (t) => {
  const { command } = fixture(t);
  const controller = new AbortController();
  const running = executeCommand(
    { ...command, args: ['-e', 'process.stdout.write("partial");setInterval(()=>{},1000)'] },
    { APP_TOKEN: secret },
    [secret],
    controller.signal,
  );
  const rejected = assert.rejects(running, /cancelled/);
  controller.abort();
  await rejected;
});
