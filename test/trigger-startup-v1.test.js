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

test('startup: an idle the CLI rewrites after the Enter, with no busy and no own entry, is not a submission', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const desc = { status: 'idle', statusUpdatedAt: 1000 };
  const f = fixture(() => ({ ...desc }));
  f.ctx.getTranscriptTurn = () => ({ prompts: [] });
  f.handle.write = data => {
    f.writes.push(data);
    if (data === '\r' && f.writes.length === 2) setTimeout(() => { desc.statusUpdatedAt = Date.now(); }, 20);
  };
  const pending = watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle', v1: true,
    deliveryDeadline: 3000, startup: true, launchStartedAt: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 300; i++) { t.mock.timers.tick(5); await new Promise(resolve => setImmediate(resolve)); }
  const r = await pending;
  assert.equal(r.submit_confirmed, false);
  assert.equal(r.turn_observed, false);
  assert.deepEqual(f.writes, ['hello', '\r', '\r'], 'the recovery Enter applies');
});

test('startup: a descriptor idle from boot does not release the prompt before the CLI attaches its input', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture(() => ({ status: 'idle', statusUpdatedAt: 1000 }));
  let attachedAt = null;
  f.ctx.getInputAttachedAt = () => attachedAt;
  setTimeout(() => { attachedAt = Date.now(); }, 400);
  let firstWriteAt = null;
  f.handle.write = data => { if (firstWriteAt === null) firstWriteAt = Date.now(); f.writes.push(data); };
  const pending = watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle', v1: true,
    deliveryDeadline: 3000, startup: true, launchStartedAt: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 300; i++) { t.mock.timers.tick(5); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
  assert.ok(attachedAt !== null, 'the input attached');
  assert.ok(firstWriteAt !== null && firstWriteAt >= attachedAt + 10, `written at ${firstWriteAt}, input attached at ${attachedAt}`);
});

test('startup: input never attached within its bound falls back to the descriptor and says so', async t => {
  const previous = process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS;
  process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS = '200';
  t.after(() => { if (previous === undefined) delete process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS; else process.env.SWITCHBOARD_STARTUP_INPUT_WAIT_MS = previous; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture(() => ({ status: 'idle', statusUpdatedAt: 1000 }));
  const warnings = [];
  f.ctx.log.warn = (...args) => warnings.push(args.join(' '));
  f.ctx.getInputAttachedAt = () => null;
  let firstWriteAt = null;
  f.handle.write = data => { if (firstWriteAt === null) firstWriteAt = Date.now(); f.writes.push(data); };
  const pending = watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle', v1: true,
    deliveryDeadline: 3000, startup: true, launchStartedAt: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 300; i++) { t.mock.timers.tick(5); await new Promise(resolve => setImmediate(resolve)); }
  await pending;
  assert.ok(firstWriteAt >= 1200, `written at ${firstWriteAt}`);
  assert.ok(warnings.some(w => /never showed its input attached/.test(w)), warnings.join('\n'));
});

test('startup: input not attached at the deadline refuses with the starting reason', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture(() => ({ status: 'idle', statusUpdatedAt: 1000 }));
  f.ctx.getInputAttachedAt = () => null;
  const pending = watcher.deliverSingle({ ...f, sessionId: 'id', command: 'hello', wait: 'idle', v1: true,
    deliveryDeadline: 1300, startup: true, launchStartedAt: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 100; i++) { t.mock.timers.tick(5); await new Promise(resolve => setImmediate(resolve)); }
  const r = await pending;
  assert.equal(r.reason, 'the CLI had not finished starting (its input was not attached yet) at the deadline; nothing was written');
  assert.deepEqual(f.writes, []);
});
