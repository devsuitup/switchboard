// test/trigger-single-readiness.test.js
//
// A single trigger and the CLI descriptor: `wait: "idle"` holds it until the
// descriptor reads idle, `wait: "none"` (write now) holds it only while a
// dialog is open. See .ai/contexts/trigger-watcher.md, "Readiness before a
// single trigger".
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '300';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '50';
process.env.SWITCHBOARD_BUSY_RISE_WAIT_MS = '100';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { start, waitForCliIdleAfter } = require('../trigger-watcher');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function session(sessionId, { withDescriptor = true, getCliStatus = null, onComposerRead = null } = {}) {
  const written = [];
  const exited = { v: false };
  const desc = { status: 'idle', statusUpdatedAt: Date.now() - 10_000 };
  const ptyProcess = {
    pid: process.pid,
    write(data) { written.push({ data, at: Date.now() }); },
  };
  const ctx = {
    log: silent,
    getPtyForSession: (id) => (id === sessionId && !exited.v ? { ptyProcess } : null),
    isSessionBusy: () => false,
    isPtyAlive: () => true,
    getComposerState: () => {
      if (onComposerRead) onComposerRead(exited);
      return { pending: 0, lastInputAt: 0 };
    },
  };
  if (getCliStatus) ctx.getCliStatus = (id) => (id === sessionId ? getCliStatus() : undefined);
  else if (withDescriptor) ctx.getCliStatus = (id) => (id === sessionId ? { ...desc } : undefined);
  return { ctx, written, desc };
}

function set(desc, status) {
  desc.status = status;
  desc.statusUpdatedAt = Date.now();
}

async function run(payload, s) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-single-ready-')));
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const watcher = start(s.ctx);
  try {
    fs.writeFileSync(path.join(tmp, payload.sessionId + '.json'), JSON.stringify(payload), 'utf8');
    const resultPath = path.join(tmp, 'processed', payload.sessionId + '.result.json');
    const limit = Date.now() + 15000;
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > limit) throw new Error('no result file');
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } finally {
    watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const trig = (id, extra = {}) => ({ sessionId: id, command: 'hello', timeout_ms: 800, ...extra });
async function holdingLoop(fn) {
  const hold = setInterval(() => {}, 50);
  try { return await fn(); } finally { clearInterval(hold); }
}

const STALE = Date.now() - 5000;
const DIALOG = /dialog open \(waiting\); nothing was written into it/;

async function withSettle(ms, fn) {
  const before = process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS;
  process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = String(ms);
  try { return await fn(); } finally { process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = before; }
}

test('none, a dialog open: nothing is written and the result says a dialog is open', async () => {
  const id = 'sess-single-ready-dialog-' + Date.now();
  const s = session(id);
  set(s.desc, 'waiting');
  const r = await run(trig(id), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not sent');
  assert.equal(r.submitted, 'no');
  assert.match(r.reason, DIALOG);
});

test('none, a dialog that closes: written as soon as the descriptor stops reading waiting, without a settle', async () => {
  await withSettle(2000, async () => {
    const id = 'sess-single-ready-none-closes-' + Date.now();
    const s = session(id);
    set(s.desc, 'waiting');
    let closedAt = null;
    setTimeout(() => { set(s.desc, 'busy'); closedAt = Date.now(); }, 300);
    const r = await run(trig(id, { timeout_ms: 5000 }), s);
    assert.ok(closedAt, 'the dialog never closed');
    assert.equal(s.written[0].data, 'hello');
    assert.ok(s.written[0].at >= closedAt);
    assert.ok(s.written[0].at - closedAt < 1000, 'the write waited for a settle');
    assert.equal(r.ok, true);
  });
});

test('none, descriptor busy: written at once, the CLI queues it', async () => {
  const id = 'sess-single-ready-none-busy-' + Date.now();
  const s = session(id);
  set(s.desc, 'busy');
  const started = Date.now();
  const r = await run(trig(id), s);
  assert.equal(s.written[0].data, 'hello');
  assert.ok(s.written[0].at - started < 500);
  assert.equal(r.ok, true);
});

test('none, descriptor idle: written with no settle delay', async () => {
  await withSettle(2000, async () => {
    const id = 'sess-single-ready-none-idle-' + Date.now();
    const s = session(id);
    set(s.desc, 'idle');
    const started = Date.now();
    const r = await run(trig(id, { timeout_ms: 5000 }), s);
    assert.ok(s.written[0].at - started < 1000);
    assert.equal(r.ok, true);
  });
});

test('none, no descriptor: written as before', async () => {
  const id = 'sess-single-ready-none-nodesc-' + Date.now();
  const s = session(id, { withDescriptor: false });
  const r = await run(trig(id), s);
  assert.equal(s.written[0].data, 'hello');
  assert.equal(r.ok, true);
});

test('none, a dialog read once then the descriptor lost: still held, dialog reason at the deadline', async () => {
  const id = 'sess-single-ready-none-lost-' + Date.now();
  let reads = 0;
  const s = session(id, { getCliStatus: () => (reads++ === 0 ? { status: 'waiting', statusUpdatedAt: Date.now() } : undefined) });
  const r = await run(trig(id, { timeout_ms: 500 }), s);
  assert.deepEqual(s.written, []);
  assert.match(r.reason, DIALOG);
});

test('none, the session exits while a dialog holds the trigger: nothing written, session exited', async () => {
  const id = 'sess-single-ready-none-exit-' + Date.now();
  const s = session(id, { onComposerRead: (e) => { e.v = true; } });
  set(s.desc, 'waiting');
  const r = await run(trig(id), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'session exited during wait');
});

test('idle, a dialog open while the session reads not busy: nothing is written, dialog reason', async () => {
  const id = 'sess-single-ready-dialog-idle-' + Date.now();
  const s = session(id);
  set(s.desc, 'waiting');
  const r = await run(trig(id, { wait: 'idle' }), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'not sent');
  assert.match(r.reason, DIALOG);
});

test('idle, a dialog that closes before the deadline: written once the descriptor reads idle', async () => {
  const id = 'sess-single-ready-closes-' + Date.now();
  const s = session(id);
  set(s.desc, 'waiting');
  let idleAt = null;
  setTimeout(() => { set(s.desc, 'idle'); idleAt = Date.now(); }, 300);
  const r = await run(trig(id, { wait: 'idle', timeout_ms: 3000 }), s);
  assert.ok(idleAt, 'the descriptor never went idle');
  assert.equal(s.written[0].data, 'hello');
  assert.ok(s.written[0].at >= idleAt, `written ${idleAt - s.written[0].at} ms before the descriptor read idle`);
  assert.equal(r.ok, true);
});

test('idle, descriptor busy until the deadline: nothing is written, the busy reason', async () => {
  const id = 'sess-single-ready-busy-' + Date.now();
  const s = session(id);
  set(s.desc, 'busy');
  const r = await run(trig(id, { wait: 'idle' }), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'not sent');
  assert.match(r.reason, /still reported a turn running \(busy\)/);
});

test('idle, a status read once then lost: not idle until the deadline, nothing written', async () => {
  const id = 'sess-single-ready-idle-lost-' + Date.now();
  let reads = 0;
  const s = session(id, { getCliStatus: () => (reads++ === 0 ? { status: 'busy', statusUpdatedAt: Date.now() } : undefined) });
  const r = await run(trig(id, { wait: 'idle', timeout_ms: 500 }), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'not sent');
  assert.match(r.reason, /still reported a turn running \(busy\)/);
});

test('idle, the session exits during the readiness wait: nothing written, session exited', async () => {
  const id = 'sess-single-ready-idle-exit-' + Date.now();
  const s = session(id, { onComposerRead: (e) => { e.v = true; } });
  const r = await run(trig(id, { wait: 'idle' }), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'session exited during wait');
});

test('idle, an idle descriptor read long ago is ready at once, whatever the settle', async () => {
  await withSettle(2000, async () => {
    const id = 'sess-single-ready-idle-old-' + Date.now();
    const s = session(id);
    const started = Date.now();
    const r = await run(trig(id, { wait: 'idle', timeout_ms: 5000 }), s);
    assert.ok(s.written[0].at - started < 1000, 'the write waited for a settle');
    assert.equal(r.ok, true);
  });
});

test('idle, timeout_ms below the settle on an idle session: written, never "never reported idle"', async () => {
  await withSettle(300, async () => {
    const id = 'sess-single-ready-short-' + Date.now();
    const s = session(id);
    const r = await run(trig(id, { wait: 'idle', timeout_ms: 250 }), s);
    assert.equal(s.written[0] && s.written[0].data, 'hello', JSON.stringify(r));
    assert.equal(r.ok, true);
  });
});

test('idle, an idle too recent for the settle: the settle is capped at the deadline, so it is written', async () => {
  await withSettle(2000, async () => {
    const id = 'sess-single-ready-cap-' + Date.now();
    const s = session(id);
    s.desc.statusUpdatedAt = Date.now() - 150;
    const r = await run(trig(id, { wait: 'idle', timeout_ms: 400 }), s);
    assert.equal(s.written[0] && s.written[0].data, 'hello', JSON.stringify(r));
    assert.equal(r.ok, true);
  });
});

test('idle, an idle that keeps restarting never settles: the unsettled reason, nothing written', async () => {
  const id = 'sess-single-ready-unsettled-' + Date.now();
  const s = session(id, { getCliStatus: () => ({ status: 'idle', statusUpdatedAt: Date.now() }) });
  const r = await run(trig(id, { wait: 'idle', timeout_ms: 500 }), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'not sent');
  assert.match(r.reason, /idle only briefly before the deadline; it never held long enough to settle/);
});

test('the deadline passed before the write: nothing is written, with or without a descriptor', async () => {
  for (const withDescriptor of [true, false]) {
    const id = 'sess-single-ready-deadline-' + withDescriptor + Date.now();
    const spin = () => { const end = Date.now() + 15; while (Date.now() < end); };
    const s = session(id, { withDescriptor, onComposerRead: spin });
    const r = await run(trig(id, { timeout_ms: 1 }), s);
    assert.deepEqual(s.written, []);
    assert.equal(r.error, 'not sent');
    assert.match(r.reason, /deadline passed before it could be written/);
  }
});

test('waitForCliIdleAfter: an idle stamped before the settle window is ready on the first read', async () => {
  const ctx = {
    getPtyForSession: () => ({}),
    getCliStatus: () => ({ status: 'idle', statusUpdatedAt: STALE }),
  };
  const r = await holdingLoop(() => waitForCliIdleAfter('x', ctx, -Infinity, Date.now() + 5000, 2000, true));
  assert.equal(r.ready, true);
  assert.ok(r.waited_ms < 500);
});

test('waitForCliIdleAfter: without trustIdleStamp (chains) an old idle still pays the settle', async () => {
  const ctx = {
    getPtyForSession: () => ({}),
    getCliStatus: () => ({ status: 'idle', statusUpdatedAt: STALE }),
  };
  const r = await holdingLoop(() => waitForCliIdleAfter('x', ctx, -Infinity, Date.now() + 5000, 400));
  assert.equal(r.ready, true);
  assert.ok(r.waited_ms >= 380, 'ready after ' + r.waited_ms + ' ms, before the settle');
});
