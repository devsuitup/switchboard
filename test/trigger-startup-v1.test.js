'use strict';
process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '50';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '10';
process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const watcher = require('../src/main/triggers/trigger-watcher');
const hold = setInterval(() => {}, 1000);
test.after(() => clearInterval(hold));
function fixture(getStatus) {
  const writes = [];
  const handle = { isAlive: () => true, write: data => writes.push(data) };
  const entry = { ptyProcess: { pid: process.pid }, handle };
  const ctx = { getPtyForSession: () => entry, isSessionBusy: () => false, getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
    getCliStatus: getStatus, log: { info() {}, warn() {}, error() {} } };
  return { writes, handle, entry, ctx };
}
test('startup without descriptor polls until deadline rather than falling back', async () => {
  const f = fixture(() => undefined);
  const start = Date.now();
  const r = await watcher.waitForCliIdleAfter('id', f.ctx, start, start + 45, 5, false, null, { startup: true });
  assert.equal(r.timedOut, true); assert.ok(Date.now() >= start + 45);
});
test('startup descriptor at launchStartedAt is fresh and settles continuously', async () => {
  const start = Date.now(); const f = fixture(() => ({ status: 'idle', statusUpdatedAt: start }));
  const r = await watcher.waitForCliIdleAfter('id', f.ctx, start, start + 150, 10, false, null, { startup: true });
  assert.equal(r.ready, true);
});
test('legacy equality retains the strict boundary', async () => {
  const start = Date.now(); const f = fixture(() => ({ status: 'idle', statusUpdatedAt: start }));
  const r = await watcher.waitForCliIdleAfter('id', f.ctx, start, start + 40, 5);
  assert.equal(r.timedOut, true);
});
test('new launch with no fresh status refuses without any prompt bytes', async () => {
  const f = fixture(() => ({ status: 'idle', statusUpdatedAt: 1 }));
  assert.equal(typeof watcher.deliverSingle, 'function', 'shared single-command delivery must be callable');
  const r = await watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle',
    deliveryDeadline: Date.now() + 70, startup: true, launchStartedAt: Date.now() });
  assert.equal(r.reason, 'session readiness unavailable'); assert.deepEqual(f.writes, []);
});
test('open-here keeps descriptor-absent fallback and v1 bounds verification', async () => {
  const f = fixture(() => undefined);
  assert.equal(typeof watcher.deliverSingle, 'function', 'shared single-command delivery must be callable');
  const r = await watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle',
    deliveryDeadline: Date.now() + 30, v1: true });
  assert.equal(r.timedOut, true); assert.equal(r.enter_written, true);
  assert.equal(r.submitted, 'assumed'); assert.deepEqual(f.writes, ['hello', '\r']);
});

test('startup cannot shorten the configured continuous idle interval to fit the remaining budget', async t => {
  const previous = process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS;
  process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '300';
  try {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const start = Date.now(); const f = fixture(() => ({ status: 'idle', statusUpdatedAt: start }));
    const pending = watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle', v1: true,
      deliveryDeadline: start + 101, startup: true, launchStartedAt: start });
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 50; i++) { t.mock.timers.tick(5); await new Promise(resolve => setImmediate(resolve)); }
    const r = await pending;
    assert.deepEqual(f.writes, [], 'startup must withhold even text until the full idle interval has held');
    assert.equal(r.reason, 'the CLI was idle only briefly before the deadline; it never held long enough to settle; nothing was written');
  } finally { process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = previous; }
});

for (const [status, reason] of [
  ['waiting', 'the CLI reports a dialog open (waiting); nothing was written into it'],
  ['busy', 'the CLI still reported a turn running (busy) at the deadline; nothing was written'],
  ['shell', 'the CLI never reported idle before the deadline; nothing was written'],
]) {
  test(`startup with fresh ${status} status retains the exact delivery refusal`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const f = fixture(() => ({ status, statusUpdatedAt: 1000 }));
    const pending = watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle', v1: true,
      deliveryDeadline: 1150, startup: true, launchStartedAt: 1000 });
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 50; i++) { t.mock.timers.tick(5); await new Promise(resolve => setImmediate(resolve)); }
    const result = await pending;
    assert.equal(result.reason, reason); assert.deepEqual(f.writes, []);
  });
}

for (const withFreshBusy of [false, true]) {
  test(`startup busy flag preserves readiness evidence (fresh busy=${withFreshBusy})`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const f = fixture(() => withFreshBusy ? { status: 'busy', statusUpdatedAt: 1000 } : undefined);
    f.ctx.isSessionBusy = () => true;
    const pending = watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle', v1: true,
      deliveryDeadline: 1150, startup: true, launchStartedAt: 1000 });
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 50; i++) { t.mock.timers.tick(5); await new Promise(resolve => setImmediate(resolve)); }
    const result = await pending;
    assert.equal(result.reason, withFreshBusy ? 'the CLI still reported a turn running (busy) at the deadline; nothing was written' : 'session readiness unavailable');
    assert.deepEqual(f.writes, []);
  });
}
