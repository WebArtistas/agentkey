import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Vault } from '../core/vault';
import { startBroker } from '../core/broker';
import { callBroker } from '../agent/client';
import { ApprovalNotifications } from '../desktop/notifications';

const operation = {
  name: 'check',
  item: 'key',
  url: 'https://api.example.com/status',
  method: 'GET' as const,
  auth: 'headers' as const,
  bindings: [{ header: 'Authorization', field: 'value', prefix: 'Bearer ' }],
  body: '',
};
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ak-wait-'));
  const vault = new Vault(directory, async () => 200);
  vault.initialize('synthetic-notification-passphrase');
  vault.saveItem({
    name: 'key',
    kind: 'secret',
    fields: [{ name: 'value', value: 'synthetic-wait-secret' }],
  });
  t.after(() => {
    vault.lock();
    rmSync(directory, { recursive: true, force: true });
  });
  return vault;
}

test('approval waits resolve only after durable decisions and never consume a grant', async (t) => {
  const vault = fixture(t);
  vault.proposeOperation(operation);
  let settled = false;
  const waiting = vault.waitForApproval({ operation: 'check' }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  vault.approveProposal({
    revision: vault.snapshot().proposals[0]!.revision,
    duration: 'once',
    dataSharingAccepted: false,
  });
  assert.equal((await waiting).state, 'approved');
  assert.equal(vault.snapshot().grants[0]?.remainingUses, 1);
  assert.equal((await vault.waitForApproval({ operation: 'check' })).state, 'approved');
  await vault.run('check');
  vault.requestAccess('check');
  const again = vault.waitForApproval({ operation: 'check' });
  vault.approve('check', 'once');
  assert.equal((await again).state, 'approved');
});

test('waits stop on dismissal, change, revocation, locking, timeout, expiry and cancellation', async (t) => {
  const vault = fixture(t);
  vault.proposeOperation(operation);
  let waiting = vault.waitForApproval({ operation: 'check' });
  vault.dismissProposal(vault.snapshot().proposals[0]!.revision);
  assert.equal((await waiting).state, 'dismissed');
  vault.proposeOperation(operation);
  waiting = vault.waitForApproval({ operation: 'check' });
  vault.saveOperation({ ...operation, url: 'https://api.example.com/changed' });
  assert.equal((await waiting).state, 'changed');
  vault.dismissProposal(vault.snapshot().proposals[0]!.revision);
  vault.requestAccess('check');
  waiting = vault.waitForApproval({ operation: 'check' });
  vault.revoke('check');
  assert.equal((await waiting).state, 'revoked');
  vault.requestAccess('check');
  assert.equal(
    (await vault.waitForApproval({ operation: 'check', timeoutMs: 1 })).state,
    'timeout',
  );
  const controller = new AbortController();
  waiting = vault.waitForApproval({ operation: 'check' }, controller.signal);
  controller.abort();
  assert.equal((await waiting).state, 'cancelled');
  waiting = vault.waitForApproval({ operation: 'check' });
  vault.lock();
  assert.equal((await waiting).state, 'locked');
  vault.unlock('synthetic-notification-passphrase');
  vault.proposeOperation({ ...operation, name: 'expires' });
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 599_999);
  assert.equal(
    (await vault.waitForApproval({ operation: 'expires', timeoutMs: 100 })).state,
    'expired',
  );
  clock.mock.restore();
});

test('bounded waits release slots on cancellation and reject missing requests and invalid deadlines', async (t) => {
  const vault = fixture(t);
  assert.throws(() => vault.waitForApproval({ operation: 'missing' }), /No pending/);
  assert.throws(() => vault.waitForApproval({ operation: 'check', timeoutMs: 45001 }), /Invalid/);
  vault.proposeOperation(operation);
  const controller = new AbortController();
  const waits = Array.from({ length: 16 }, () =>
    vault.waitForApproval({ operation: 'check' }, controller.signal),
  );
  assert.throws(() => vault.waitForApproval({ operation: 'check' }), /Too many/);
  controller.abort();
  assert.ok((await Promise.all(waits)).every((result) => result.state === 'cancelled'));
  assert.equal(
    (await vault.waitForApproval({ operation: 'check', timeoutMs: 1 })).state,
    'timeout',
  );
});

test('broker notifies only new successful requests, and notification failures do not fail requests', async (t) => {
  const vault = fixture(t);
  let notifications = 0;
  const broker = await startBroker(vault, () => {
    notifications++;
    throw new Error('synthetic OS failure');
  });
  try {
    const directory = vault.storage.directory;
    assert.equal(
      (await callBroker(directory, { action: 'request-access', operation: 'missing' })).ok,
      false,
    );
    assert.equal(notifications, 0);
    await callBroker(directory, { action: 'propose-operation', operation });
    await callBroker(directory, { action: 'propose-operation', operation });
    assert.equal(notifications, 1);
    const waiting = callBroker(directory, { action: 'wait-for-approval', operation: 'check' });
    vault.approveProposal({
      revision: vault.snapshot().proposals[0]!.revision,
      duration: 'once',
      dataSharingAccepted: false,
    });
    assert.deepEqual(await waiting, { ok: true, value: { operation: 'check', state: 'approved' } });
    await callBroker(directory, { action: 'request-access', operation: 'check' });
    assert.equal(notifications, 1);
    vault.revoke('check');
    await callBroker(directory, { action: 'request-access', operation: 'check' });
    await callBroker(directory, { action: 'request-access', operation: 'check' });
    assert.equal(notifications, 2);
  } finally {
    await broker.close();
  }
});

test('cancelled broker clients release their server-side wait slot', async (t) => {
  const vault = fixture(t);
  vault.proposeOperation(operation);
  let registered!: () => void;
  const registration = new Promise<void>((resolve) => {
    registered = resolve;
  });
  let serverSignal: AbortSignal | undefined;
  const wait = vault.waitForApproval.bind(vault);
  t.mock.method(vault, 'waitForApproval', (input: unknown, signal?: AbortSignal) => {
    serverSignal = signal;
    const result = wait(input, signal);
    registered();
    return result;
  });
  const broker = await startBroker(vault);
  try {
    const controller = new AbortController();
    const result = callBroker(
      vault.storage.directory,
      { action: 'wait-for-approval', operation: 'check' },
      controller.signal,
    );
    const rejected = assert.rejects(result, /connection ended/);
    await registration;
    const cancelled = new Promise<void>((resolve) =>
      serverSignal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    controller.abort();
    await rejected;
    await cancelled;
    const waits = Array.from({ length: 16 }, () => wait({ operation: 'check' }));
    vault.lock();
    assert.ok((await Promise.all(waits)).every((entry) => entry.state === 'locked'));
  } finally {
    await broker.close();
  }
});

test('a failed approval commit wakes waiting clients as locked, never approved', async (t) => {
  const vault = fixture(t);
  vault.proposeOperation(operation);
  const waiting = vault.waitForApproval({ operation: 'check' });
  t.mock.method(vault.storage, 'save', () => {
    throw new Error('synthetic disk failure');
  });
  assert.throws(
    () =>
      vault.approveProposal({
        revision: vault.snapshot().proposals[0]!.revision,
        duration: 'once',
        dataSharingAccepted: false,
      }),
    /locked/,
  );
  assert.equal((await waiting).state, 'locked');
});

test('desktop notifications are generic, throttled, navigate only and tolerate unsupported systems', (t) => {
  let opened = 0;
  let flashes = 0;
  let shown = 0;
  let closed = 0;
  const handles: EventEmitter[] = [];
  const notices = new ApprovalNotifications({
    supported: () => true,
    flash: () => {
      flashes++;
    },
    openApprovals: () => {
      opened++;
    },
    create: (options) => {
      assert.deepEqual(options, {
        title: 'AgentKey approval needed',
        body: 'A new request is waiting. Open AgentKey to review it.',
        silent: false,
      });
      const handle = Object.assign(new EventEmitter(), {
        show: () => {
          shown++;
        },
        close: () => {
          closed++;
        },
      });
      handles.push(handle);
      return handle;
    },
  });
  notices.notify();
  notices.notify();
  assert.equal(shown, 1);
  assert.equal(flashes, 2);
  handles[0]!.emit('click');
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  handles[0]!.emit('click');
  assert.equal(opened, 1);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 5001);
  notices.notify();
  assert.equal(shown, 2);
  notices.clear();
  handles[1]!.emit('click');
  assert.equal(opened, 1);
  assert.doesNotThrow(() =>
    new ApprovalNotifications({
      supported: () => false,
      flash: () => {},
      openApprovals: () => {},
      create: () => {
        throw new Error('must not create');
      },
    }).notify(),
  );
  assert.doesNotThrow(() =>
    new ApprovalNotifications({
      supported: () => true,
      flash: () => {},
      openApprovals: () => {},
      create: () => {
        throw new Error('OS failure');
      },
    }).notify(),
  );
});
