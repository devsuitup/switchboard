// test/trigger-single-readiness.test.js
//
// A single trigger is held by the CLI descriptor like a chain step: not written
// while it reads busy or waiting (a dialog). See
// .ai/contexts/trigger-watcher.md, "Readiness before a single trigger".
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

const { start } = require('../trigger-watcher');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function session(sessionId, { withDescriptor = true } = {}) {
  const written = [];
  const desc = { status: 'idle', statusUpdatedAt: Date.now() - 10_000 };
  const ptyProcess = {
    pid: process.pid,
    write(data) { written.push({ data, at: Date.now() }); },
  };
  const ctx = {
    log: silent,
    getPtyForSession: (id) => (id === sessionId ? { ptyProcess } : null),
    isSessionBusy: () => false,
    isPtyAlive: () => true,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
  };
  if (withDescriptor) ctx.getCliStatus = (id) => (id === sessionId ? { ...desc } : undefined);
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

test('a dialog open, no wait: nothing is written and the result says a dialog is open', async () => {
  const id = 'sess-single-ready-dialog-' + Date.now();
  const s = session(id);
  set(s.desc, 'waiting');
  const r = await run(trig(id), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not sent');
  assert.equal(r.submitted, 'no');
  assert.match(r.reason, /dialog open \(waiting\); nothing was written into it/);
});

test('a dialog open while the session reads not busy, wait idle: nothing is written, dialog reason', async () => {
  const id = 'sess-single-ready-dialog-idle-' + Date.now();
  const s = session(id);
  set(s.desc, 'waiting');
  const r = await run(trig(id, { wait: 'idle' }), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'not sent');
  assert.match(r.reason, /dialog open \(waiting\); nothing was written into it/);
});

test('a dialog that closes before the deadline: the trigger is written once the descriptor reads idle', async () => {
  const id = 'sess-single-ready-closes-' + Date.now();
  const s = session(id);
  set(s.desc, 'waiting');
  let idleAt = null;
  setTimeout(() => { set(s.desc, 'idle'); idleAt = Date.now(); }, 300);
  const r = await run(trig(id, { timeout_ms: 3000 }), s);
  assert.ok(idleAt, 'the descriptor never went idle');
  assert.equal(s.written[0].data, 'hello');
  assert.ok(s.written[0].at >= idleAt, `written ${idleAt - s.written[0].at} ms before the descriptor read idle`);
  assert.equal(r.ok, true);
});

test('descriptor busy until the deadline: nothing is written, the busy reason', async () => {
  const id = 'sess-single-ready-busy-' + Date.now();
  const s = session(id);
  set(s.desc, 'busy');
  const r = await run(trig(id), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'not sent');
  assert.match(r.reason, /still reported a turn running \(busy\)/);
});

test('descriptor idle: written at once', async () => {
  const id = 'sess-single-ready-idle-' + Date.now();
  const s = session(id);
  const started = Date.now();
  const r = await run(trig(id), s);
  assert.equal(s.written[0].data, 'hello');
  assert.ok(s.written[0].at - started < 700);
  assert.equal(r.ok, true);
});

test('no descriptor: written as before, nothing waits', async () => {
  const id = 'sess-single-ready-none-' + Date.now();
  const s = session(id, { withDescriptor: false });
  const started = Date.now();
  const r = await run(trig(id), s);
  assert.equal(s.written[0].data, 'hello');
  assert.ok(s.written[0].at - started < 700);
  assert.equal(r.ok, true);
});
