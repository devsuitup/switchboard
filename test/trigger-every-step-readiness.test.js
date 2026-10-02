// test/trigger-every-step-readiness.test.js
//
// The descriptor readiness wait before EVERY chain step, and the descriptor as
// the authority for the busy-fall wait. See
// .ai/contexts/trigger-watcher.md, "Readiness before every step".
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '400';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '50';
process.env.SWITCHBOARD_BUSY_RISE_WAIT_MS = '100';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { start, waitForBusyFall, waitForCliIdleAfter } = require('../trigger-watcher');

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-every-')));
}

function recordingLog() {
  const lines = [];
  const mk = (level) => (...args) => { lines.push({ level, text: args.join(' ') }); };
  return { lines, info: mk('info'), warn: mk('warn'), error: mk('error'), debug: () => {} };
}

function chainSession(sessionId, { log, onEnter, withDescriptor = true }) {
  const written = [];
  const desc = { status: 'idle', statusUpdatedAt: Date.now() - 10_000 };
  const ptyProcess = {
    pid: process.pid,
    write(data) {
      written.push({ data, at: Date.now() });
      if (data === '\r') onEnter(written.filter((w) => w.data === '\r').length, desc);
    },
  };
  let busy = false;
  const ctx = {
    log,
    getPtyForSession: (id) => (id === sessionId ? { ptyProcess } : null),
    isSessionBusy: () => busy,
    isPtyAlive: () => true,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
  };
  if (withDescriptor) ctx.getCliStatus = (id) => (id === sessionId ? { ...desc } : undefined);
  return { ctx, written, desc, setBusy(v) { busy = v; } };
}

async function runChain(chain, session, uuid, timeoutMs = 20000) {
  const tmp = mkTmp();
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';
  const watcher = start(session.ctx);
  try {
    fs.writeFileSync(path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: uuid, wait: 'idle', chain, timeout_ms: timeoutMs }), 'utf8');
    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline) throw new Error('no result file');
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } finally {
    watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function quickTurn(session) {
  return (_n, desc) => {
    desc.status = 'busy'; desc.statusUpdatedAt = Date.now();
    setTimeout(() => { desc.status = 'idle'; desc.statusUpdatedAt = Date.now(); }, 100);
  };
}

test('step 0 while the descriptor reads busy: nothing is written until it reads idle', async () => {
  {
    const uuid = 'sess-every-busy-' + Date.now();
    const session = chainSession(uuid, { log: recordingLog(), onEnter: (n, d) => quickTurn(session)(n, d) });
    session.desc.status = 'busy';
    session.desc.statusUpdatedAt = Date.now();
    let idleAt = null;
    setTimeout(() => { session.desc.status = 'idle'; session.desc.statusUpdatedAt = Date.now(); idleAt = Date.now(); }, 700);

    const result = await runChain([{ command: 'first step' }], session, uuid);

    assert.ok(idleAt, 'the descriptor never went idle');
    assert.equal(session.written[0].data, 'first step');
    assert.ok(session.written[0].at >= idleAt, `step 0 written ${idleAt - session.written[0].at} ms before the descriptor read idle`);
    assert.equal(result.ok, true);
  }
});

test('a dialog open ("waiting"): never written into, the step fails at the deadline with the dialog reason', async () => {
  {
    const uuid = 'sess-every-waiting-' + Date.now();
    const session = chainSession(uuid, { log: recordingLog(), onEnter: () => {} });
    session.desc.status = 'waiting';
    session.desc.statusUpdatedAt = Date.now();

    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], session, uuid, 1500);

    assert.deepEqual(session.written, []);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not sent');
    assert.match(result.reason, /dialog/);
    assert.equal(result.steps_completed, 0);
    assert.equal(result.steps[0].submitted, 'no');
  }
});

test('#360: _cliBusy stuck true but the descriptor idle after the Enter -> the chain proceeds to step 1', async () => {
  const uuid = 'sess-every-stuck-' + Date.now();
  const session = chainSession(uuid, {
    log: recordingLog(),
    onEnter(n, desc) {
      session.setBusy(true);
      quickTurn(session)(n, desc);
    },
  });

  const result = await runChain([{ command: 'first step' }, { command: 'second step' }], session, uuid, 4000);

  assert.ok(session.written.some((w) => w.data === 'second step'), 'step 1 was never written');
  assert.equal(result.ok, true);
});

test('no descriptor: the chain behaves as before, nothing waits before step 0', async () => {
  const uuid = 'sess-every-none-' + Date.now();
  const session = chainSession(uuid, {
    log: recordingLog(),
    withDescriptor: false,
    onEnter(n) {
      session.setBusy(true);
      setTimeout(() => session.setBusy(false), 100);
    },
  });

  const started = Date.now();
  const result = await runChain([{ command: 'first step' }, { command: 'second step' }], session, uuid);

  assert.ok(session.written[0].at - started < 1000, 'step 0 was held although no descriptor exists');
  assert.deepEqual(session.written.map((w) => w.data).filter((d) => d !== '\r'), ['first step', 'second step']);
  assert.equal(result.ok, true);
});

test('waitForBusyFall: a descriptor idle that predates the Enter does not end the wait', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const ctx = {
    getPtyForSession: () => ({}),
    isSessionBusy: () => true,
    getCliStatus: () => ({ status: 'idle', statusUpdatedAt: 999_000 }),
  };
  const p = waitForBusyFall('sid', ctx, 1_000_000 + 2000, 1_000_000);
  let result;
  p.then((r) => { result = r; });
  for (let i = 0; i < 600 && !result; i += 1) {
    t.mock.timers.tick(5);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(result.timedOut, true);
});

for (const status of ['busy', 'shell']) {
  test(`step 0 while the descriptor reads "${status}" to the deadline: never written, the step fails "not sent" with a reason`, async () => {
    const uuid = 'sess-every-never-' + status + Date.now();
    const session = chainSession(uuid, { log: recordingLog(), onEnter: () => {} });
    session.desc.status = status;
    session.desc.statusUpdatedAt = Date.now();

    const started = Date.now();
    const result = await runChain([{ command: 'first step' }], session, uuid, 1500);
    await new Promise((r) => setTimeout(r, 300));

    assert.deepEqual(session.written, []);
    assert.ok(Date.now() - started >= 1400, 'the wait must run to the step deadline, not stop early');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not sent');
    assert.ok(result.reason && result.reason.length > 0);
    assert.equal(result.steps_completed, 0);
  });
}

test('a later step held by a busy descriptor to the deadline: not written, "chain timeout", the first step stays completed', async () => {
  const uuid = 'sess-every-later-' + Date.now();
  const session = chainSession(uuid, {
    log: recordingLog(),
    onEnter(n, desc) {
      desc.status = 'busy'; desc.statusUpdatedAt = Date.now();
      session.setBusy(true);
      setTimeout(() => session.setBusy(false), 100);
    },
  });

  const result = await runChain([{ command: 'first step' }, { command: 'second step' }], session, uuid, 2500);

  assert.ok(!session.written.some((w) => w.data === 'second step'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chain timeout');
  assert.match(result.reason, /busy/);
  assert.equal(result.steps_completed, 1);
});

test('a step not confirmed with the recovery Enter withheld stops the chain: nothing more is typed', async () => {
  const uuid = 'sess-every-stop-' + Date.now();
  const session = chainSession(uuid, {
    log: recordingLog(),
    onEnter(n, desc) { desc.status = 'busy'; },
  });

  const result = await runChain([{ command: 'first step' }, { command: 'second step' }], session, uuid, 4000);

  assert.deepEqual(session.written.map((w) => w.data), ['first step', '\r']);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'step not confirmed');
  assert.ok(result.reason && result.reason.length > 0);
  assert.equal(result.steps_completed, 0);
  assert.equal(result.steps[0].submit_confirmed, false);
});

function fakeClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
}

async function settleRun(t, promise, maxMs = 5000) {
  let done = false;
  let value;
  promise.then((v) => { done = true; value = v; });
  for (let i = 0; i < maxMs && !done; i += 5) {
    t.mock.timers.tick(5);
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(done, 'still pending');
  return value;
}

function stateCtx(state) {
  return { getPtyForSession: () => ({}), getCliStatus: () => ({ ...state }) };
}

test('readiness settle: an idle followed by busy inside the settle window is not ready; ready only once idle has held', async (t) => {
  fakeClock(t);
  const state = { status: 'idle', statusUpdatedAt: 1_000_000 };
  setTimeout(() => { state.status = 'busy'; state.statusUpdatedAt = Date.now(); }, 150);
  setTimeout(() => { state.status = 'idle'; state.statusUpdatedAt = Date.now(); }, 400);
  const r = await settleRun(t, waitForCliIdleAfter('sid', stateCtx(state), -Infinity, 1_000_000 + 5000, 300));
  assert.equal(r.ready, true);
  assert.ok(r.waited_ms >= 700, 'ready after ' + r.waited_ms + ' ms, expected the settle to restart at the second idle');
});

test('readiness settle: a new statusUpdatedAt while idle restarts the settle window', async (t) => {
  fakeClock(t);
  const state = { status: 'idle', statusUpdatedAt: 1_000_000 };
  setTimeout(() => { state.statusUpdatedAt = Date.now(); }, 200);
  const r = await settleRun(t, waitForCliIdleAfter('sid', stateCtx(state), -Infinity, 1_000_000 + 5000, 300));
  assert.equal(r.ready, true);
  assert.ok(r.waited_ms >= 500, 'ready after ' + r.waited_ms + ' ms, expected the settle to restart at the new timestamp');
});

test('readiness: a dialog seen anywhere in the final settle window is reported even when the last sample is busy', async (t) => {
  fakeClock(t);
  const state = { status: 'busy', statusUpdatedAt: 1_000_000 };
  setTimeout(() => { state.status = 'waiting'; state.statusUpdatedAt = Date.now(); }, 1800);
  setTimeout(() => { state.status = 'busy'; state.statusUpdatedAt = Date.now(); }, 1900);
  const r = await settleRun(t, waitForCliIdleAfter('sid', stateCtx(state), -Infinity, 1_000_000 + 2000, 300));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.lastStatus, 'busy');
  assert.equal(r.waitingSeen, true);
});

test('readiness: an unknown status is not idle', async (t) => {
  fakeClock(t);
  const state = { status: 'shell', statusUpdatedAt: 1_000_000 };
  const r = await settleRun(t, waitForCliIdleAfter('sid', stateCtx(state), -Infinity, 1_000_000 + 1000, 0));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
});

test('waitForBusyFall: an idle that flickers back to busy inside the settle window does not end the wait early', async (t) => {
  fakeClock(t);
  const state = { status: 'idle', statusUpdatedAt: 1_000_000 };
  setTimeout(() => { state.status = 'busy'; state.statusUpdatedAt = Date.now(); }, 20);
  setTimeout(() => { state.status = 'idle'; state.statusUpdatedAt = Date.now(); }, 200);
  const ctx = { getPtyForSession: () => ({}), isSessionBusy: () => true, getCliStatus: () => ({ ...state }) };
  const r = await settleRun(t, waitForBusyFall('sid', ctx, 1_000_000 + 5000, 1_000_000));
  assert.equal(r.timedOut, false);
  assert.ok(r.waited_ms >= 240, 'ended after ' + r.waited_ms + ' ms, before the second idle had held');
});

test('a descriptor that vanishes after it was read keeps the wait going to the deadline: nothing is written', async () => {
  const uuid = 'sess-every-vanish-' + Date.now();
  const session = chainSession(uuid, { log: recordingLog(), onEnter: () => {} });
  session.desc.status = 'busy';
  session.desc.statusUpdatedAt = Date.now();
  setTimeout(() => { session.ctx.getCliStatus = () => undefined; }, 500);

  const started = Date.now();
  const result = await runChain([{ command: 'first step' }], session, uuid, 1800);
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(session.written, []);
  assert.ok(Date.now() - started >= 1700, 'the wait must run to the deadline');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not sent');
});

test('a descriptor that vanishes and reappears idle: the wait resumes and the step is written', async () => {
  const uuid = 'sess-every-reappear-' + Date.now();
  const session = chainSession(uuid, { log: recordingLog(), onEnter: (n, d) => quickTurn(session)(n, d) });
  session.desc.status = 'busy';
  session.desc.statusUpdatedAt = Date.now();
  const started = Date.now();
  const original = session.ctx.getCliStatus;
  setTimeout(() => { session.ctx.getCliStatus = () => undefined; }, 200);
  setTimeout(() => {
    session.desc.status = 'idle'; session.desc.statusUpdatedAt = Date.now();
    session.ctx.getCliStatus = original;
  }, 700);

  const result = await runChain([{ command: 'first step' }], session, uuid, 5000);

  assert.equal(result.ok, true);
  assert.ok(session.written[0].at - started >= 650, 'written before the descriptor reappeared idle');
});

test('readiness: a settle that completes after the deadline is a timeout, never ready', async (t) => {
  fakeClock(t);
  const state = { status: 'idle', statusUpdatedAt: 1_000_000 };
  const r = await settleRun(t, waitForCliIdleAfter('sid', stateCtx(state), -Infinity, 1_000_000 + 290, 300));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
});

test('readiness: a deadline already passed is a timeout even for an idle descriptor with no settle', async (t) => {
  fakeClock(t);
  const state = { status: 'idle', statusUpdatedAt: 1_000_000 };
  const r = await settleRun(t, waitForCliIdleAfter('sid', stateCtx(state), -Infinity, 1_000_000, 0));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
});

test('a step whose deadline has passed is not written, even with no descriptor to wait for', async () => {
  const uuid = 'sess-every-expired-' + Date.now();
  const session = chainSession(uuid, { log: recordingLog(), withDescriptor: false, onEnter: () => {} });
  session.ctx.getComposerState = () => {
    const t = Date.now();
    while (Date.now() - t < 5) { /* let the 1 ms step budget lapse */ }
    return { pending: 0, lastInputAt: 0 };
  };
  const tmp = mkTmp();
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const watcher = start(session.ctx);
  try {
    fs.writeFileSync(path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: uuid, wait: 'none', chain: [{ command: 'first step', timeout_ms: 1 }], timeout_ms: 20000 }), 'utf8');
    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline) throw new Error('no result file');
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.deepEqual(session.written, []);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not sent');
  } finally {
    watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('post-compact readiness is anchored on the compact\'s own Enter, not on when the step began', async () => {
  process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '250';
  try {
    const uuid = 'sess-every-anchor-' + Date.now();
    const session = chainSession(uuid, { log: recordingLog(), onEnter: () => {} });
    const realWrite = session.ctx.getPtyForSession(uuid).ptyProcess.write;
    session.ctx.getPtyForSession(uuid).ptyProcess.write = function (data) {
      realWrite.call(this, data);
      if (data === '/compact') {
        setTimeout(() => { session.desc.status = 'idle'; session.desc.statusUpdatedAt = Date.now(); }, 60);
      }
    };

    const result = await runChain([{ command: '/compact' }, { command: 'second step' }], session, uuid, 3500);

    assert.ok(!session.written.some((w) => w.data === 'second step'), 'an idle older than the compact Enter must not release the next step');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'chain timeout');
  } finally {
    process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
  }
});

test('the only readable sample is the first one, then the descriptor is unreadable: the wait owns the start decision, nothing is written', async () => {
  const uuid = 'sess-every-first-read-' + Date.now();
  const session = chainSession(uuid, { log: recordingLog(), onEnter: () => {} });
  let reads = 0;
  session.ctx.getCliStatus = () => {
    reads += 1;
    return reads === 1 ? { status: 'busy', statusUpdatedAt: Date.now() } : undefined;
  };

  const result = await runChain([{ command: 'first step' }], session, uuid, 1500);
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(session.written, []);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not sent');
});
