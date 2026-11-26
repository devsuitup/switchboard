// test/trigger-own-turn-proof-1284.test.js
//
// A turn the CLI starts on its own (a queued task notification, a peer
// message) must neither confirm a prompt that stayed in the input box nor be
// written into. See .ai/contexts/trigger-watcher.md, "A turn the CLI starts on
// its own (issue #1284)".
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '300';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '20';
process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '1';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const watcher = require('./fixtures/trigger-watcher.cjs');
const { classifyTranscriptTail } = require('../transcript-turn');

const hold = setInterval(() => {}, 1000);
test.after(() => clearInterval(hold));

const T0 = 1_000_000;
const NOTIFICATION = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';

function transcript() {
  const lines = [];
  let mtimeMs = 0;
  const add = (entry) => {
    lines.push(JSON.stringify({ timestamp: new Date(Date.now()).toISOString(), ...entry }));
    mtimeMs = Date.now();
  };
  return {
    add,
    closedTurn(text = 'earlier') {
      add({ type: 'user', message: { role: 'user', content: text } });
      add({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
      add({ type: 'system', subtype: 'turn_duration' });
    },
    enqueue(content) { add({ type: 'queue-operation', operation: 'enqueue', content }); },
    dequeue() { add({ type: 'queue-operation', operation: 'dequeue' }); },
    user(content) { add({ type: 'user', message: { role: 'user', content } }); },
    reply() {
      add({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } });
      add({ type: 'system', subtype: 'turn_duration' });
    },
    turn: () => ({ ...classifyTranscriptTail(lines.join('\n') + '\n'), mtimeMs }),
  };
}

function fixture({ onEnter } = {}) {
  const desc = { status: 'idle', statusUpdatedAt: T0 - 10_000 };
  const tr = transcript();
  const writes = [];
  let enters = 0;
  let firstWriteAt = null;
  const handle = {
    isAlive: () => true,
    write(data) {
      if (firstWriteAt === null) firstWriteAt = Date.now();
      writes.push(data);
      if (data === '\r') { enters += 1; if (onEnter) onEnter(enters, desc, tr); }
    },
  };
  const entry = { ptyProcess: { pid: process.pid }, handle };
  const ctx = {
    getPtyForSession: () => entry, isSessionBusy: () => false,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
    getCliStatus: () => ({ ...desc }),
    getTranscriptTurn: () => tr.turn(),
    log: { info() {}, warn() {}, error() {} },
  };
  return { desc, tr, writes, handle, entry, ctx, firstWriteAt: () => firstWriteAt };
}

function set(desc, status) { desc.status = status; desc.statusUpdatedAt = Date.now(); }

async function drive(t, promise, ms) {
  let done = false;
  let value;
  promise.then((v) => { done = true; value = v; });
  await new Promise((r) => setImmediate(r));
  for (let elapsed = 0; elapsed < ms && !done; elapsed += 5) {
    t.mock.timers.tick(5);
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(done, `still pending after ${ms} mocked ms`);
  return value;
}

function single(f, extra = {}) {
  return watcher.deliverSingle({ ...f, sessionId: 'sid', command: 'hello', wait: 'idle', v1: true,
    deliveryDeadline: Date.now() + 8000, ...extra });
}

for (const status of ['busy', 'waiting']) {
  test(`proof: a ${status} descriptor after the Enter with only a foreign <task-notification> entry is not a submission`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
    const f = fixture({ onEnter: (n, desc, tr) => {
      if (n === 1) setTimeout(() => { tr.dequeue(); tr.user(NOTIFICATION); set(desc, status); }, 20);
    } });
    f.tr.closedTurn();
    const r = await drive(t, single(f), 6000);
    assert.equal(r.submit_confirmed, false, JSON.stringify(r));
    assert.equal(r.turn_observed, false);
    assert.deepEqual(f.writes, ['hello', '\r'], 'no recovery Enter while the descriptor reads busy or waiting');
  });
}

test('proof: a busy descriptor after the Enter followed by the prompt\'s own user entry confirms', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const f = fixture({ onEnter: (n, desc, tr) => {
    if (n === 1) setTimeout(() => set(desc, 'busy'), 20);
    if (n === 1) setTimeout(() => { tr.enqueue('hello'); tr.dequeue(); tr.user('hello'); }, 60);
  } });
  f.tr.closedTurn();
  const r = await drive(t, single(f), 6000);
  assert.equal(r.submit_confirmed, true, JSON.stringify(r));
  assert.equal(r.turn_observed, true);
  assert.deepEqual(f.writes, ['hello', '\r']);
});

test('proof: a prompt queued while the CLI is busy confirms through its own enqueue when its turn starts', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const f = fixture({ onEnter: (n, desc, tr) => {
    if (n !== 1) return;
    tr.enqueue('hello');
    setTimeout(() => { tr.reply(); tr.dequeue(); set(desc, 'busy'); }, 50);
  } });
  f.tr.user('long running');
  set(f.desc, 'busy');
  const v = await drive(t, watcher.submitWithVerify(f.handle, 'sid', 'hello', f.ctx), 4000);
  assert.equal(v.confirmed, true, JSON.stringify(v));
  assert.equal(v.confirmSource, 'descriptor');
});

test('proof: a foreign busy, then the prompt\'s own entry within the window, confirms', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const f = fixture({ onEnter: (n, desc, tr) => {
    if (n !== 1) return;
    setTimeout(() => { tr.dequeue(); tr.user(NOTIFICATION); set(desc, 'busy'); }, 20);
    setTimeout(() => { tr.enqueue('hello'); }, 150);
  } });
  f.tr.closedTurn();
  const v = await drive(t, watcher.submitWithVerify(f.handle, 'sid', 'hello', f.ctx), 4000);
  assert.equal(v.confirmed, true, JSON.stringify(v));
  assert.ok(v.waited_ms >= 150, `confirmed after ${v.waited_ms} ms, before the own entry`);
});

test('proof: a slash command needs its own structured entry with its arguments when the descriptor goes busy', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  for (const [args, confirmed] of [['other', false], ['intended', true]]) {
    const f = fixture({ onEnter: (n, desc, tr) => {
      if (n === 1) setTimeout(() => {
        tr.user(`<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>${args}</command-args>`);
        set(desc, 'busy');
      }, 20);
    } });
    f.tr.closedTurn();
    const v = await drive(t, watcher.submitWithVerify(f.handle, 'sid', '/rename intended', f.ctx), 4000);
    assert.equal(v.confirmed, confirmed, `${args}: ${JSON.stringify(v)}`);
  }
});

test('readiness: a foreign enqueue pending at readiness holds the write until the turn it starts ends, then the prompt confirms by its own entry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  let foreignEndAt = null;
  const f = fixture({ onEnter: (n, desc, tr) => {
    if (n !== 1) return;
    setTimeout(() => { tr.enqueue('hello'); tr.dequeue(); tr.user('hello'); set(desc, 'busy'); }, 20);
  } });
  f.tr.closedTurn();
  f.tr.enqueue(NOTIFICATION);
  setTimeout(() => { f.tr.dequeue(); }, 300);
  setTimeout(() => { f.tr.user(NOTIFICATION); set(f.desc, 'busy'); }, 700);
  setTimeout(() => { f.tr.reply(); set(f.desc, 'idle'); foreignEndAt = Date.now(); }, 1500);
  const r = await drive(t, single(f), 6000);
  assert.ok(foreignEndAt !== null, 'the foreign turn ended');
  assert.ok(f.firstWriteAt() >= foreignEndAt, `written at +${f.firstWriteAt() - T0} ms, the foreign turn ended at +${foreignEndAt - T0} ms`);
  assert.equal(r.submit_confirmed, true, JSON.stringify(r));
  assert.deepEqual(f.writes, ['hello', '\r']);
});

test('readiness (open): a notification the resumed CLI queues after its input attaches holds the prompt until that turn ends', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  let foreignEndAt = null;
  const f = fixture({ onEnter: (n, desc, tr) => {
    if (n === 1) setTimeout(() => { tr.enqueue('hello'); tr.dequeue(); tr.user('hello'); set(desc, 'busy'); }, 20);
  } });
  f.tr.closedTurn();
  f.desc.statusUpdatedAt = T0;
  f.ctx.getInputAttachedAt = () => T0;
  f.tr.enqueue(NOTIFICATION);
  setTimeout(() => { f.tr.dequeue(); f.tr.user(NOTIFICATION); set(f.desc, 'busy'); }, 400);
  setTimeout(() => { f.tr.reply(); set(f.desc, 'idle'); foreignEndAt = Date.now(); }, 1200);
  const r = await drive(t, single(f, { startup: true, launchStartedAt: T0 }), 6000);
  assert.ok(foreignEndAt !== null, 'the foreign turn ended before the prompt was written');
  assert.ok(f.firstWriteAt() >= foreignEndAt, `written at +${f.firstWriteAt() - T0} ms, the foreign turn ended at +${foreignEndAt - T0} ms`);
  assert.equal(r.submit_confirmed, true, JSON.stringify(r));
});

test('readiness: a pending enqueue in a transcript nobody writes any more (a dead process) holds only for the transcript quiet window', async (t) => {
  const previous = process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS;
  process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS = '800';
  t.after(() => { if (previous === undefined) delete process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS; else process.env.SWITCHBOARD_TRANSCRIPT_QUIET_MS = previous; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const f = fixture();
  f.tr.closedTurn();
  f.tr.enqueue('a message the previous process never took');
  await drive(t, single(f), 6000);
  assert.ok(f.firstWriteAt() >= T0 + 800, `written at +${f.firstWriteAt() - T0} ms`);
  assert.ok(f.firstWriteAt() < T0 + 1500, `written at +${f.firstWriteAt() - T0} ms`);
});

test('readiness: still held by the CLI\'s own turn at the deadline -> nothing written, the result names it', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const f = fixture();
  f.tr.closedTurn();
  f.tr.enqueue(NOTIFICATION);
  const keepWriting = () => { f.tr.add({ type: 'progress' }); setTimeout(keepWriting, 200); };
  keepWriting();
  const r = await drive(t, single(f, { deliveryDeadline: T0 + 1000 }), 3000);
  assert.deepEqual(f.writes, []);
  assert.equal(r.submitted, 'no');
  assert.equal(r.reason, 'the transcript showed a queued item or a turn the CLI started on its own still running at the deadline; nothing was written');
});

test('classifier: an enqueue written during the previous turn stays pending after that turn closes', () => {
  const at = (s) => new Date(T0 + s).toISOString();
  const lines = (...entries) => entries.map((e, i) => JSON.stringify({ timestamp: at(i), ...e })).join('\n') + '\n';
  const turn = classifyTranscriptTail(lines(
    { type: 'user', message: { content: 'previous task' } },
    { type: 'queue-operation', operation: 'enqueue', content: NOTIFICATION },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'turn_duration' },
  ));
  assert.equal(turn.queueActivity, true);
});

test('classifier: a dequeue whose enqueue lies before the tail does not hide a later pending enqueue, nor invent one', () => {
  const at = (s) => new Date(T0 + s).toISOString();
  const lines = (...entries) => entries.map((e, i) => JSON.stringify({ timestamp: at(i), ...e })).join('\n') + '\n';
  const done = [
    { type: 'user', message: { content: 'x' } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'y' }] } },
  ];
  const deq = { type: 'queue-operation', operation: 'dequeue' };
  const enq = { type: 'queue-operation', operation: 'enqueue', content: NOTIFICATION };
  assert.equal(classifyTranscriptTail(lines(deq, ...done)).queueActivity, false);
  assert.equal(classifyTranscriptTail(lines(deq, ...done, enq)).queueActivity, true);
});

test('readiness: an enqueue queued while the previous turn ran, not yet dequeued at its close, holds the prompt until its own turn ends', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  let foreignEndAt = null;
  const f = fixture({ onEnter: (n, desc, tr) => {
    if (n === 1) setTimeout(() => { tr.enqueue('hello'); tr.dequeue(); tr.user('hello'); set(desc, 'busy'); }, 20);
  } });
  f.tr.user('previous task');
  f.tr.enqueue(NOTIFICATION);
  f.tr.reply();
  set(f.desc, 'idle');
  setTimeout(() => { f.tr.dequeue(); f.tr.user(NOTIFICATION); set(f.desc, 'busy'); }, 600);
  setTimeout(() => { f.tr.reply(); set(f.desc, 'idle'); foreignEndAt = Date.now(); }, 2000);
  const r = await drive(t, single(f), 7000);
  assert.ok(foreignEndAt !== null, 'the foreign turn ended before the prompt was written');
  assert.ok(f.firstWriteAt() >= foreignEndAt, `written at +${f.firstWriteAt() - T0} ms, the foreign turn ended at +${foreignEndAt - T0} ms`);
  assert.equal(r.submit_confirmed, true, JSON.stringify(r));
});

test('classifier: queue activity is pending enqueues, or a dequeue whose turn has not closed', () => {
  const at = (s) => new Date(T0 + s).toISOString();
  const lines = (...entries) => entries.map((e, i) => JSON.stringify({ timestamp: at(i), ...e })).join('\n') + '\n';
  const closed = [
    { type: 'user', message: { content: 'x' } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'y' }] } },
    { type: 'system', subtype: 'turn_duration' },
  ];
  const enq = { type: 'queue-operation', operation: 'enqueue', content: NOTIFICATION };
  const deq = { type: 'queue-operation', operation: 'dequeue' };
  assert.equal(classifyTranscriptTail(lines(...closed)).queueActivity, false);
  assert.equal(classifyTranscriptTail(lines(...closed, enq)).queueActivity, true);
  assert.equal(classifyTranscriptTail(lines(...closed, enq, deq)).queueActivity, true);
  assert.equal(classifyTranscriptTail(lines(...closed, enq, deq, { type: 'user', message: { content: NOTIFICATION } })).queueActivity, true);
  assert.equal(classifyTranscriptTail(lines(...closed, enq, deq, { type: 'user', message: { content: NOTIFICATION } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'z' }] } })).queueActivity, false);
  assert.equal(classifyTranscriptTail(lines(...closed, enq, { type: 'queue-operation', operation: 'remove' })).queueActivity, false);
  assert.equal(classifyTranscriptTail(lines(...closed, enq, { type: 'queue-operation', operation: 'popAll', content: NOTIFICATION })).queueActivity, false);
  const notif = classifyTranscriptTail(lines(...closed, enq, deq, { type: 'user', message: { content: NOTIFICATION } }));
  assert.ok(notif.prompts.some((p) => p.text === NOTIFICATION), 'a queued notification is listed as a prompt, so only matching proves');
});

// ── chain, through the real watcher ─────────────────────────────────────────

test('chain: a step whose Enter meets a turn the CLI starts on its own is not confirmed', async () => {
  const { setTimeout: realSetTimeout } = require('node:timers');
  const uuid = 'sess-own-turn-chain-' + Date.now();
  const tr = transcript();
  tr.closedTurn();
  const desc = { status: 'idle', statusUpdatedAt: Date.now() - 10_000 };
  const written = [];
  const ptyProcess = {
    pid: process.pid,
    write(data) {
      written.push(data);
      if (data !== '\r') return;
      const enters = written.filter((w) => w === '\r').length;
      if (enters === 1) {
        tr.enqueue('first step'); tr.dequeue(); tr.user('first step'); set(desc, 'busy');
        realSetTimeout(() => { tr.reply(); set(desc, 'idle'); }, 80);
      } else if (enters === 2) {
        realSetTimeout(() => { tr.dequeue(); tr.user(NOTIFICATION); set(desc, 'busy'); }, 20);
      }
    },
  };
  const ctx = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    getPtyForSession: (id) => (id === uuid ? { ptyProcess } : null),
    isSessionBusy: () => false, isPtyAlive: () => true,
    getComposerState: () => ({ pending: 0, lastInputAt: 0 }),
    getCliStatus: (id) => (id === uuid ? { ...desc } : undefined),
    getTranscriptTurn: () => tr.turn(),
  };
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-own-turn-')));
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;
  const w = watcher.start(ctx);
  try {
    fs.writeFileSync(path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: uuid, wait: 'idle', chain: [{ command: 'first step' }, { command: 'second step' }], timeout_ms: 4000 }), 'utf8');
    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    const limit = Date.now() + 15000;
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > limit) throw new Error('no result file');
      await new Promise((r) => realSetTimeout(r, 20));
    }
    await new Promise((r) => realSetTimeout(r, 20));
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.steps[0].submit_confirmed, true, JSON.stringify(result));
    assert.equal(result.steps[1].submit_confirmed, false, JSON.stringify(result));
    assert.equal(result.steps[1].turn_observed, false);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'step not confirmed');
    assert.equal(written.filter((x) => x === '\r').length, 2, 'no recovery Enter into the busy CLI');
  } finally {
    w.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
