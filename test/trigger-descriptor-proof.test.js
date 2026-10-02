// test/trigger-descriptor-proof.test.js
//
// Readiness after /compact and proof of submission by edge, both read from the
// CLI's own descriptor (ctx.getCliStatus). See
// .ai/contexts/trigger-watcher.md, "Readiness and edge proof from the CLI descriptor".
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '400';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '50';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
  submitWithVerify, waitForCliIdleAfter, isCompactCommand, start,
} = require('../trigger-watcher');

const T0 = 1_000_000;

function fakeSession({ levelBusy = false, withDescriptor = true, onEnter } = {}) {
  const desc = { status: 'idle', statusUpdatedAt: T0 - 10_000 };
  const writes = [];
  let enters = 0;
  const handle = {
    write(data) {
      writes.push(data);
      if (data === '\r') {
        enters += 1;
        if (onEnter) onEnter(enters, desc);
      }
    },
    isAlive() { return true; },
  };
  const ctx = {
    getPtyForSession: () => ({ ptyProcess: {}, handle }),
    isSessionBusy: () => levelBusy,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
  };
  if (withDescriptor) ctx.getCliStatus = () => ({ ...desc });
  return { desc, writes, handle, ctx };
}

async function settle(t, promise, maxMs = 5000) {
  let done = false;
  let value;
  let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let elapsed = 0; elapsed < maxMs && !done; elapsed += 5) {
    t.mock.timers.tick(5);
    await new Promise((r) => setImmediate(r));
  }
  if (error) throw error;
  assert.ok(done, `promise still pending after ${maxMs} mocked ms`);
  return value;
}

function enableClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
}

function busyEdgeAfter(ms) {
  return (_n, desc) => {
    setTimeout(() => { desc.status = 'busy'; desc.statusUpdatedAt = Date.now(); }, ms);
  };
}

test('edge: descriptor goes busy after our Enter -> confirmed, no recovery Enter', async (t) => {
  enableClock(t);
  const s = fakeSession({ onEnter: busyEdgeAfter(120) });
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.deepEqual(s.writes, ['hello', '\r']);
  assert.equal(v.confirmed, true);
  assert.equal(v.composerConfirmed, true);
  assert.equal(v.submit_retries, 0);
});

test('edge: a spinner on the level probe and a stale idle descriptor prove nothing -> one recovery Enter, then unconfirmed', async (t) => {
  enableClock(t);
  const s = fakeSession({ levelBusy: true });
  s.desc.statusUpdatedAt = T0 - 500;
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.deepEqual(s.writes, ['hello', '\r', '\r']);
  assert.equal(v.confirmed, false);
  assert.equal(v.composerConfirmed, false);
  assert.equal(v.sawBusy, false);
  assert.equal(v.submit_retries, 1);
});

test('edge: first Enter absorbed, the recovery Enter starts the turn -> confirmed after one retry', async (t) => {
  enableClock(t);
  const s = fakeSession({ onEnter: (n, desc) => { if (n === 2) busyEdgeAfter(120)(n, desc); } });
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.deepEqual(s.writes, ['hello', '\r', '\r']);
  assert.equal(v.confirmed, true);
  assert.equal(v.submit_retries, 1);
});

test('edge: a fast turn seen only as idle with a newer timestamp still proves the CLI reacted', async (t) => {
  enableClock(t);
  const s = fakeSession({ onEnter: (_n, desc) => {
    setTimeout(() => { desc.status = 'idle'; desc.statusUpdatedAt = Date.now(); }, 120);
  } });
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.deepEqual(s.writes, ['hello', '\r']);
  assert.equal(v.confirmed, true);
  assert.equal(v.submit_retries, 0);
});

test('edge: a dialog opened by our Enter (waiting, newer timestamp) is a submission and gets no recovery Enter', async (t) => {
  enableClock(t);
  const s = fakeSession({ onEnter: (_n, desc) => {
    setTimeout(() => { desc.status = 'waiting'; desc.statusUpdatedAt = Date.now(); }, 120);
  } });
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.deepEqual(s.writes, ['hello', '\r']);
  assert.equal(v.confirmed, true);
});

for (const status of ['waiting', 'busy']) {
  test(`recovery: the descriptor reading "${status}" without a reaction to our Enter never gets a recovery Enter`, async (t) => {
    enableClock(t);
    const s = fakeSession();
    s.desc.status = status;
    s.desc.statusUpdatedAt = T0 - 500;
    const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
    assert.deepEqual(s.writes, ['hello', '\r']);
    assert.equal(v.recoverySkipped, true);
    assert.equal(v.confirmed, false);
  });
}

test('recovery: a descriptor without a usable timestamp still forbids the recovery Enter while a dialog is open', async (t) => {
  enableClock(t);
  const s = fakeSession();
  s.ctx.getCliStatus = () => ({ status: 'waiting', statusUpdatedAt: null });
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.deepEqual(s.writes, ['hello', '\r']);
  assert.equal(v.recoverySkipped, true);
  assert.equal(v.confirmed, null);
});

test('fallback: a descriptor whose statusUpdatedAt is not an integer is treated as no descriptor', async (t) => {
  enableClock(t);
  const s = fakeSession({ levelBusy: true });
  s.ctx.getCliStatus = () => ({ status: 'idle', statusUpdatedAt: null });
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.equal(v.confirmed, null);
  assert.equal(v.sawBusy, true);
  const r = await settle(t, waitForCliIdleAfter('sid', s.ctx, T0, T0 + 60_000));
  assert.equal(r.available, false);
});

test('fallback: no ctx.getCliStatus -> the level probe still decides and confirmed stays null', async (t) => {
  enableClock(t);
  const s = fakeSession({ levelBusy: true, withDescriptor: false });
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.deepEqual(s.writes, ['hello', '\r']);
  assert.equal(v.sawBusy, true);
  assert.equal(v.confirmed, null);
  assert.equal(v.submit_retries, 0);
});

test('fallback: a descriptor unknown for this session behaves like no descriptor', async (t) => {
  enableClock(t);
  const s = fakeSession({ levelBusy: true });
  s.ctx.getCliStatus = () => undefined;
  const v = await settle(t, submitWithVerify(s.handle, 'sid', 'hello', s.ctx));
  assert.equal(v.confirmed, null);
  assert.equal(v.sawBusy, true);
});

test('readiness: idle with a statusUpdatedAt after the compact send -> ready at once', async (t) => {
  enableClock(t);
  const s = fakeSession();
  s.desc.statusUpdatedAt = T0 + 1;
  const r = await settle(t, waitForCliIdleAfter('sid', s.ctx, T0, T0 + 60_000));
  assert.equal(r.ready, true);
  assert.equal(r.available, true);
});

test('readiness: idle older than the compact send, then a later idle -> waits for the later one', async (t) => {
  enableClock(t);
  const s = fakeSession();
  s.desc.statusUpdatedAt = T0 - 1;
  setTimeout(() => { s.desc.status = 'busy'; s.desc.statusUpdatedAt = Date.now(); }, 200);
  setTimeout(() => { s.desc.status = 'idle'; s.desc.statusUpdatedAt = Date.now(); }, 1000);
  const r = await settle(t, waitForCliIdleAfter('sid', s.ctx, T0, T0 + 60_000));
  assert.equal(r.ready, true);
  assert.ok(r.waited_ms >= 1000, `waited ${r.waited_ms} ms, expected to hold until the later idle`);
});

test('readiness: a dialog ("waiting") is not idle', async (t) => {
  enableClock(t);
  const s = fakeSession();
  s.desc.status = 'waiting';
  s.desc.statusUpdatedAt = T0 + 5;
  const r = await settle(t, waitForCliIdleAfter('sid', s.ctx, T0, T0 + 1000));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
});

test('readiness: never idle -> bounded, reports timedOut', async (t) => {
  enableClock(t);
  const s = fakeSession();
  s.desc.status = 'busy';
  const r = await settle(t, waitForCliIdleAfter('sid', s.ctx, T0, T0 + 2000));
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, true);
  assert.ok(r.waited_ms >= 2000);
});

test('readiness: no descriptor -> available:false so the caller keeps today\'s behaviour', async (t) => {
  enableClock(t);
  const s = fakeSession({ withDescriptor: false });
  const r = await settle(t, waitForCliIdleAfter('sid', s.ctx, T0, T0 + 60_000));
  assert.equal(r.available, false);
  assert.equal(r.ready, false);
  assert.equal(r.timedOut, false);
});

test('isCompactCommand: /compact with or without arguments, nothing else', () => {
  assert.equal(isCompactCommand('/compact'), true);
  assert.equal(isCompactCommand('  /compact keep the plan'), true);
  assert.equal(isCompactCommand('/compactify'), false);
  assert.equal(isCompactCommand('run /compact'), false);
});

// ── chain, through the real watcher ─────────────────────────────────────────

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-desc-')));
}

function recordingLog() {
  const lines = [];
  const mk = (level) => (...args) => { lines.push({ level, text: args.join(' ') }); };
  return { lines, info: mk('info'), warn: mk('warn'), error: mk('error'), debug: () => {} };
}

function chainSession(sessionId, { log, onEnter }) {
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
    getCliStatus: (id) => (id === sessionId ? { ...desc } : undefined),
  };
  return { ctx, written, desc, setBusy(v) { busy = v; } };
}

async function runChain(chain, session, uuid) {
  const tmp = mkTmp();
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';
  const watcher = start(session.ctx);
  try {
    fs.writeFileSync(path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: uuid, wait: 'idle', chain, timeout_ms: 20000 }), 'utf8');
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

test('chain: the step after /compact is held until the descriptor is idle after the compact, then confirmed by edge', async () => {
  const uuid = 'sess-desc-ready-' + Date.now();
  const log = recordingLog();
  let compactIdleAt = null;
  const session = chainSession(uuid, {
    log,
    onEnter(n, desc) {
      session.setBusy(true);
      if (n === 1) {
        desc.status = 'busy'; desc.statusUpdatedAt = Date.now();
        setTimeout(() => { session.setBusy(false); }, 80);
        setTimeout(() => {
          desc.status = 'idle'; desc.statusUpdatedAt = Date.now(); compactIdleAt = Date.now();
        }, 900);
      } else {
        desc.status = 'busy'; desc.statusUpdatedAt = Date.now();
        setTimeout(() => { session.setBusy(false); desc.status = 'idle'; desc.statusUpdatedAt = Date.now(); }, 100);
      }
    },
  });

  const result = await runChain([{ command: '/compact' }, { command: 'resume the work' }], session, uuid);

  const nextText = session.written.find((w) => w.data === 'resume the work');
  assert.ok(compactIdleAt, 'the compact never reached idle');
  assert.ok(nextText.at >= compactIdleAt, `step 1 written at +${nextText.at - compactIdleAt} ms relative to the compact idle`);
  assert.equal(result.ok, true);
  assert.equal(result.steps[1].submit_confirmed, true);
  assert.equal(result.steps[1].submitted, 'confirmed');
  assert.equal(result.unconfirmed_steps, undefined);
  assert.ok(log.lines.some((l) => l.level === 'info' && /Chain step 1 submitted to/.test(l.text)));
  assert.ok(!log.lines.some((l) => /Chain step 1 sent/.test(l.text)));
});

test('chain: a CLI that never goes idle after /compact -> bounded wait, warning, step still written', async () => {
  process.env.SWITCHBOARD_CLI_READY_WAIT_MS = '300';
  try {
    const uuid = 'sess-desc-timeout-' + Date.now();
    const log = recordingLog();
    const session = chainSession(uuid, {
      log,
      onEnter(n, desc) {
        if (n === 1) {
          desc.status = 'busy'; desc.statusUpdatedAt = Date.now();
          setTimeout(() => session.setBusy(false), 60);
        }
      },
    });
    session.setBusy(false);

    const started = Date.now();
    const result = await runChain([{ command: '/compact' }, { command: 'resume the work' }], session, uuid);

    const nextText = session.written.find((w) => w.data === 'resume the work');
    assert.ok(nextText, 'the step must still be written after the bounded wait');
    assert.ok(log.lines.some((l) => l.level === 'warn' && /CLI not idle after \/compact/.test(l.text)));
    assert.ok(nextText.at - started >= 300, 'the readiness wait must have been honoured up to its bound');
    assert.equal(result.ok, true);
  } finally {
    delete process.env.SWITCHBOARD_CLI_READY_WAIT_MS;
  }
});

test('chain: an Enter that never starts a turn is reported "not confirmed submitted", never "sent"', async () => {
  process.env.SWITCHBOARD_CLI_READY_WAIT_MS = '200';
  try {
    const uuid = 'sess-desc-unconfirmed-' + Date.now();
    const log = recordingLog();
    const session = chainSession(uuid, {
      log,
      onEnter(n, desc) {
        if (n === 1) {
          desc.status = 'busy'; desc.statusUpdatedAt = Date.now();
          setTimeout(() => { desc.status = 'idle'; desc.statusUpdatedAt = Date.now(); }, 100);
        }
      },
    });

    const result = await runChain([{ command: '/compact' }, { command: 'resume the work' }], session, uuid);

    assert.deepEqual(session.written.map((w) => w.data), ['/compact', '\r', 'resume the work', '\r', '\r']);
    assert.ok(log.lines.some((l) => l.level === 'warn' && /Chain step 1 not confirmed submitted/.test(l.text)));
    assert.ok(!log.lines.some((l) => /Chain step 1 (sent|submitted)/.test(l.text)));
    assert.equal(result.steps[1].submit_confirmed, false);
    assert.equal(result.steps[1].submitted, 'assumed');
    assert.deepEqual(result.unconfirmed_steps, [1]);
    assert.equal(result.submitted, 'assumed');
  } finally {
    delete process.env.SWITCHBOARD_CLI_READY_WAIT_MS;
  }
});
