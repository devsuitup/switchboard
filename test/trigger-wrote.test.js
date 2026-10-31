'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '50';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '5';
process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: realSetTimeout } = require('node:timers');
const { start } = require('../src/main/triggers/trigger-watcher');

const log = { info() {}, warn() {}, error() {}, debug() {} };
const id = 'wrote-session';

function makeCtx(options = {}) {
  const written = [];
  const composer = { pending: 0, lastInputAt: 0 };
  let busy = false;
  const ptyProcess = { pid: process.pid, write(data) {
    if (options.ptyThrows) throw new Error('PTY closed');
    written.push(data);
    if (data === '\r') {
      busy = true;
      realSetTimeout(() => { busy = false; if (options.pendingAfterFirstEnter) composer.pending = 1; }, 20);
    }
  } };
  const ctx = {
    log,
    getPtyForSession: sid => (!options.missing && sid === id ? { ptyProcess } : null),
    isSessionBusy: () => options.alwaysBusy || busy,
    isPtyAlive: () => { if (options.aliveThrows) throw new Error('liveness probe exploded'); return true; },
    getComposerState: () => ({ pending: composer.pending, lastInputAt: composer.lastInputAt }),
    ...(options.bgDescriptor ? { getLiveDescriptor: async () => ({ kind: 'bg', jobId: 'job-1' }) } : {}),
  };
  return { ctx, written };
}

async function run(payload, options = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wrote-')));
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = dir;
  const { ctx, written } = makeCtx(options);
  const watcher = start(ctx);
  try {
    fs.writeFileSync(path.join(dir, 'w.json'), typeof payload === 'string' ? payload : JSON.stringify({ sessionId: id, ...payload }));
    const resultPath = path.join(dir, 'processed', 'w.result.json');
    const deadline = performance.now() + 8000;
    while (!fs.existsSync(resultPath)) {
      assert.ok(performance.now() < deadline, 'result file must be produced');
      await new Promise(resolve => realSetTimeout(resolve, 10));
    }
    return { result: JSON.parse(fs.readFileSync(resultPath, 'utf8')), written };
  } finally {
    watcher.close();
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, payload, options] of [
  ['invalid JSON', '{not json', {}],
  ['validation refusal', { command: 'a\nb' }, {}],
  ['session not found', { command: 'hello' }, { missing: true }],
  ['background session, not attached here', { command: 'hello' }, { missing: true, bgDescriptor: true }],
  ['idle wait expiry', { command: 'hello', wait: 'idle', timeout_ms: 300 }, { alwaysBusy: true }],
  ['chain refused before step 0', { chain: [{ command: 'a' }, { command: 'b' }], wait: 'idle', timeout_ms: 300 }, { alwaysBusy: true }],
  ['internal error before any write', { command: 'hello' }, { aliveThrows: true }],
]) {
  test(`wrote: ${name} reports wrote false`, async () => {
    const { result, written } = await run(payload, options);
    assert.deepEqual(written, []);
    assert.equal(result.ok, false);
    if (options.aliveThrows) assert.equal(result.internal, true);
    if (options.alwaysBusy) assert.equal(result.error, 'not sent');
    assert.equal(result.wrote, false, JSON.stringify(result));
  });
}

test('wrote: a delivered single command reports wrote true', async () => {
  const { result, written } = await run({ command: 'hello' });
  assert.deepEqual(written.slice(0, 2), ['hello', '\r']);
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true);
});

test('wrote: a PTY write that throws is a possible write', async () => {
  const { result } = await run({ command: 'hello' }, { ptyThrows: true });
  assert.match(result.error, /^pty write failed/);
  assert.equal(result.submitted, 'no');
  assert.equal(result.wrote, true, JSON.stringify(result));
});

test('wrote: a chain that wrote step 0 then stopped reports wrote true', async () => {
  const { result, written } = await run({ chain: [{ command: 'first' }, { command: 'second' }], timeout_ms: 1500 }, { pendingAfterFirstEnter: true });
  assert.deepEqual(written.slice(0, 2), ['first', '\r']);
  assert.ok(!written.includes('second'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chain timeout');
  assert.equal(result.submitted, 'no');
  assert.equal(result.partial, true, JSON.stringify(result));
  assert.equal(result.wrote, true, JSON.stringify(result));
});
