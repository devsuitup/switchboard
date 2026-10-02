// test/trigger-blocked-session.test.js
//
// A trigger result that ends because the session waited says so when the CLI
// descriptor read `waiting` (a dialog) during the end of that wait. See
// .ai/contexts/trigger-watcher.md, "A blocked session tells its driver".
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

function session(sessionId, { withDescriptor = true, onEnter = () => {} } = {}) {
  const written = [];
  const desc = { status: 'idle', statusUpdatedAt: Date.now() - 10_000 };
  const state = { busy: false };
  const ptyProcess = {
    pid: process.pid,
    write(data) {
      written.push(data);
      if (data === '\r') onEnter(desc, state);
    },
  };
  const ctx = {
    log: silent,
    getPtyForSession: (id) => (id === sessionId ? { ptyProcess } : null),
    isSessionBusy: () => state.busy,
    isPtyAlive: () => true,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
  };
  if (withDescriptor) ctx.getCliStatus = (id) => (id === sessionId ? { ...desc } : undefined);
  return { ctx, written, desc, state };
}

function set(desc, status) {
  desc.status = status;
  desc.statusUpdatedAt = Date.now();
}

async function run(payload, s) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-blocked-')));
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

const single = (id) => ({ sessionId: id, command: 'hello', wait: 'idle', timeout_ms: 600 });
const chain  = (id) => ({ sessionId: id, wait: 'idle', chain: [{ command: 'one' }, { command: 'two' }], timeout_ms: 1500 });

test('single trigger: still busy at the deadline with a dialog open -> the dialog reason', async () => {
  const id = 'sess-blocked-single-' + Date.now();
  const s = session(id);
  s.state.busy = true;
  set(s.desc, 'waiting');
  const r = await run(single(id), s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'not sent');
  assert.equal(r.submitted, 'no');
  assert.match(r.reason, /dialog open \(waiting\); nothing was written into it/);
});

test('single trigger: still busy at the deadline, descriptor busy -> the plain timeout reason', async () => {
  const id = 'sess-blocked-single-busy-' + Date.now();
  const s = session(id);
  s.state.busy = true;
  set(s.desc, 'busy');
  const r = await run(single(id), s);
  assert.equal(r.reason, 'timeout waiting for idle; nothing was written');
});

test('single trigger: no descriptor -> the plain timeout reason', async () => {
  const id = 'sess-blocked-single-none-' + Date.now();
  const s = session(id, { withDescriptor: false });
  s.state.busy = true;
  const r = await run(single(id), s);
  assert.equal(r.reason, 'timeout waiting for idle; nothing was written');
});

test('single trigger: a dialog that closed long before the deadline is not reported', async () => {
  const id = 'sess-blocked-single-old-' + Date.now();
  const s = session(id);
  s.state.busy = true;
  set(s.desc, 'waiting');
  setTimeout(() => set(s.desc, 'busy'), 100);
  const r = await run(single(id), s);
  assert.equal(r.reason, 'timeout waiting for idle; nothing was written');
});

test('chain initial wait: still busy at the deadline with a dialog open -> the dialog reason', async () => {
  const id = 'sess-blocked-chain0-' + Date.now();
  const s = session(id);
  s.state.busy = true;
  set(s.desc, 'waiting');
  const r = await run({ ...chain(id), timeout_ms: 600 }, s);
  assert.deepEqual(s.written, []);
  assert.equal(r.error, 'not sent');
  assert.equal(r.partial, false);
  assert.match(r.reason, /dialog open \(waiting\); nothing was written into it/);
});

test('chain initial wait: descriptor busy -> the plain timeout reason', async () => {
  const id = 'sess-blocked-chain0-busy-' + Date.now();
  const s = session(id);
  s.state.busy = true;
  set(s.desc, 'busy');
  const r = await run({ ...chain(id), timeout_ms: 600 }, s);
  assert.equal(r.reason, 'timed out waiting for the session to go idle; nothing was written');
});

test('chain busy-fall: a dialog opens while the turn is awaited -> chain timeout with the dialog reason', async () => {
  const id = 'sess-blocked-fall-' + Date.now();
  const s = session(id, { onEnter: (desc, state) => { state.busy = true; set(desc, 'waiting'); } });
  const r = await run(chain(id), s);
  assert.deepEqual(s.written.filter((w) => w === 'two'), []);
  assert.equal(r.error, 'chain timeout');
  assert.equal(r.partial, true);
  assert.equal(r.steps_completed, 0);
  assert.match(r.reason, /dialog open \(waiting\) while the turn was awaited; the step had been written/);
});

test('chain busy-fall: the turn runs past the deadline, descriptor busy -> chain timeout without a reason', async () => {
  const id = 'sess-blocked-fall-busy-' + Date.now();
  const s = session(id, { onEnter: (desc, state) => { state.busy = true; set(desc, 'busy'); } });
  const r = await run(chain(id), s);
  assert.equal(r.error, 'chain timeout');
  assert.equal('reason' in r, false);
});

test('chain busy-fall: no descriptor -> chain timeout without a reason', async () => {
  const id = 'sess-blocked-fall-none-' + Date.now();
  const s = session(id, { withDescriptor: false, onEnter: (desc, state) => { state.busy = true; } });
  const r = await run(chain(id), s);
  assert.equal(r.error, 'chain timeout');
  assert.equal('reason' in r, false);
});
