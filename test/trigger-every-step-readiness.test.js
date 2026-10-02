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

const { start, waitForBusyFall } = require('../trigger-watcher');

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
  process.env.SWITCHBOARD_CLI_READY_WAIT_MS = '5000';
  try {
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
  } finally {
    delete process.env.SWITCHBOARD_CLI_READY_WAIT_MS;
  }
});

test('a dialog open ("waiting"): never written into, the step fails at the bound with the dialog reason', async () => {
  process.env.SWITCHBOARD_CLI_READY_WAIT_MS = '400';
  try {
    const uuid = 'sess-every-waiting-' + Date.now();
    const session = chainSession(uuid, { log: recordingLog(), onEnter: () => {} });
    session.desc.status = 'waiting';
    session.desc.statusUpdatedAt = Date.now();

    const result = await runChain([{ command: 'first step' }, { command: 'second step' }], session, uuid);

    assert.deepEqual(session.written, []);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not sent');
    assert.match(result.reason, /dialog/);
    assert.equal(result.steps_completed, 0);
    assert.equal(result.steps[0].submitted, 'no');
  } finally {
    delete process.env.SWITCHBOARD_CLI_READY_WAIT_MS;
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
