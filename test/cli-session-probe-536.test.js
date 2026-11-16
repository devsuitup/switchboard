'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const state = require('../cli-session-state');
const { mergeRoster } = require('../src/main/bg-agents/bg-agents-roster');

const OUTPUT = '900 1 134360000000000000\n5001 900 134360000000010000\n5004 5001 134360000000020000\n7004 1 134360000000030000\n';
const descriptors = [5004, 7004].map(pid => state.parseDescriptor(JSON.stringify({
  pid, sessionId: `session-${pid}`, kind: 'interactive', status: 'busy', startedAt: pid,
  procStart: pid === 5004 ? '134360000000020000' : '134360000000030000', pidDomain: 'win32:anchor',
})));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-probe-536-'));
  const f = { time: 100000, outcome: 'ok', duration: 10, logs: [], timers: new Set(), reads: 0 };
  const schedule = (fn, ms) => {
    const timer = { at: f.time + ms, fn, unref() {} };
    f.timers.add(timer);
    return timer;
  };
  f.advance = ms => {
    f.time += ms;
    for (const timer of [...f.timers]) {
      if (timer.at <= f.time) { f.timers.delete(timer); timer.fn(); }
    }
  };
  state.init({ dir, activeSessions: new Map(), platform: 'win32', ownPid: 900,
    now: () => f.time, schedule, cancel: timer => f.timers.delete(timer),
    log: { info: line => f.logs.push(line), debug() {}, warn() {} },
    readProcessTable: (timeout, options) => state.probeProcessTable('win32', timeout, (_exe, _args, _opts, done) => {
      f.reads++;
      f.time += f.duration;
      f.onRead?.(_opts);
      if (f.outcome === 'timeout') done(Object.assign(new Error('injected timeout'), { killed: true, signal: 'SIGTERM' }), '');
      else if (f.outcome === 'error') done(Object.assign(new Error('injected spawn failure'), { code: 'ENOENT' }), '');
      else done(null, f.outcome === 'empty' ? '' : OUTPUT);
    }, options?.signal),
  });
  f.roster = (items = descriptors, jobs = new Map()) => mergeRoster({
    cli: null, jobs, descriptors: items, isOwnPid: state.ownProcessFilter(() => [5001]),
  });
  f.probe = () => state.refreshProcessTable({ force: true });
  t.after(() => { state.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return f;
}

for (const outcome of ['timeout', 'error', 'empty']) {
  test(`536 cold ${outcome}: unavailable ownership never creates External; recovery classifies normally`, async t => {
    const f = fixture(t);
    f.outcome = outcome;
    await f.probe();
    assert.deepEqual(f.roster(), [], 'an unreadable table cannot label a Switchboard CLI External on cold start');
    assert.equal(state.ownProcessFilter(() => [5001])(5004, descriptors[0]), null, 'ownership is unknown');
    f.advance(3000);
    f.outcome = 'ok';
    f.roster();
    await state.refreshProcessTable();
    assert.deepEqual(f.roster().map(row => row.pid), [7004], 'successful recovery retains the real external CLI');
  });

  test(`536 steady ${outcome}: retain each session classification through stale and failed reads`, async t => {
    const f = fixture(t);
    await f.probe();
    assert.deepEqual(f.roster().map(row => row.pid), [7004]);
    f.outcome = outcome;
    f.advance(3000);
    assert.deepEqual(f.roster().map(row => row.pid), [7004], 'stale table preserves the last classification');
    await state.refreshProcessTable();
    assert.deepEqual(f.roster().map(row => row.pid), [7004], 'failed refresh must not turn the own session External');
    assert.equal(state.readWorkerProcessEvidence().processTableFresh, false, 'display fallback is not fresh action evidence');
    const replacement = { ...descriptors[1], sessionId: 'replacement', procStart: '134360000000040000' };
    assert.deepEqual(f.roster([replacement]), [], 'a reused PID cannot inherit another session External classification');
    f.advance(3000);
    f.outcome = 'ok';
    await f.probe();
    assert.deepEqual(f.roster().map(row => row.pid), [7004]);
  });
}

test('536 unknown ownership cannot convert a finished job into External', async t => {
  const f = fixture(t);
  f.outcome = 'timeout';
  await f.probe();
  const rows = f.roster([descriptors[0]], new Map([['abcdef12', { sessionId: descriptors[0].sessionId, state: 'done' }]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'background', 'a failed table cannot reclassify the finished job as External');
  assert.equal(rows[0].conversationOwn, null);
});

test('536 counts completed ok, timeout and error probes once per 60s window with max and p95', async t => {
  const f = fixture(t);
  f.duration = 100;
  await f.probe();
  await state.readProcessTableSnapshot(f.time + 20000);
  assert.equal(f.reads, 1, 'cache hits are not probes');
  f.outcome = 'timeout'; f.duration = 5000;
  await f.probe();
  f.outcome = 'error'; f.duration = 200;
  await state.readProcessTableSnapshot(f.time + 20000, { fresh: true });
  f.outcome = 'ok'; f.duration = 10;
  for (let i = 0; i < 18; i++) await f.probe();
  assert.equal(f.logs.length, 0, 'the window is reported only when complete');
  f.advance(60000 - (f.time - 100100) - 1);
  assert.equal(f.logs.length, 0);
  f.advance(1);
  assert.equal(f.logs.length, 1, 'one info summary must include failures even without another probe');
  assert.match(f.logs[0], /ok=19 timeout=1 error=1/);
  assert.match(f.logs[0], /maxMs=5000 p95Ms=200/);
  f.advance(60000);
  assert.equal(f.logs.length, 1, 'no duplicate summary');
  f.outcome = 'timeout';
  await f.probe();
  f.advance(60000);
  assert.equal(f.logs.length, 2, 'a later failed window gets its own summary');
  assert.match(f.logs[1], /ok=0 timeout=1 error=0/);
});

test('536 successful windows stay silent, invalid tables count as errors, stop cancels summary', async t => {
  const f = fixture(t);
  await f.probe();
  f.advance(60000);
  assert.deepEqual(f.logs, []);
  f.outcome = 'empty';
  await f.probe();
  f.advance(60000);
  assert.equal(f.logs.length, 1, 'an unusable table is an error outcome');
  assert.match(f.logs[0], /ok=0 timeout=0 error=1/);
  f.outcome = 'timeout';
  await f.probe();
  state.stop();
  assert.equal(f.timers.size, 0, 'stop cancels outstanding summary timers');
  f.advance(60000);
  assert.equal(f.logs.length, 1);
});

test('536 an unconsumed successful refresh does not erase the last displayed classifications', async t => {
  const f = fixture(t);
  await f.probe();
  assert.deepEqual(f.roster().map(row => row.pid), [7004]);
  f.advance(3000);
  await f.probe();
  f.advance(3000);
  f.outcome = 'timeout';
  await f.probe();
  assert.deepEqual(f.roster().map(row => row.pid), [7004], 'keep the last displayed external session when a subsequent table fails');
});

test('536 stop during a pending probe does not rearm the summary timer', async t => {
  const f = fixture(t);
  const pending = f.probe();
  state.stop();
  await pending;
  assert.equal(f.timers.size, 0, 'a stopped reader cannot rearm metrics when an old probe completes');
});

test('536b short-budget timeouts stay apart from full-budget counts and durations', async t => {
  const f = fixture(t);
  f.duration = 10;
  await f.probe();
  f.outcome = 'timeout'; f.duration = 1000;
  await state.readProcessTableSnapshot(f.time + 1000, { fresh: true });
  f.advance(60000);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /ok=1 timeout=0 error=0/, 'short-budget timeout must not increment the full-budget timeout count');
  assert.match(f.logs[0], /timeoutBudgetMs=15000/);
  assert.match(f.logs[0], /maxMs=10 p95Ms=10/, 'short-budget duration must not enter full-budget statistics');
  assert.match(f.logs[0], /callerOk=0 callerTimeout=1 callerError=0 aborted=0/);
});

for (const budget of [1000, 20000]) {
  test(`536b an aborted caller read with ${budget}ms available cannot count as a timeout`, async t => {
    const f = fixture(t);
    await f.probe();
    const controller = new AbortController();
    f.onRead = opts => { assert.equal(opts.signal, controller.signal); controller.abort(); };
    f.outcome = 'timeout'; f.duration = 500;
    await state.readProcessTableSnapshot(f.time + budget, { fresh: true, signal: controller.signal });
    f.advance(60000);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /ok=1 timeout=0 error=0/, 'an abort must not increment timeout or error');
    assert.match(f.logs[0], /maxMs=10 p95Ms=10/);
    assert.match(f.logs[0], /callerOk=0 callerTimeout=0 callerError=0 aborted=1/);
  });
}

test('536b a window containing only caller-budget reads has no full-budget duration', async t => {
  const f = fixture(t);
  await state.readProcessTableSnapshot(f.time + 1000, { fresh: true });
  f.outcome = 'error';
  await state.readProcessTableSnapshot(f.time + 1000, { fresh: true });
  f.outcome = 'timeout';
  await state.refreshProcessTable({ force: true, deadline: f.time + 1000 });
  f.advance(60000);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /ok=0 timeout=0 error=0/);
  assert.match(f.logs[0], /maxMs=n\/a p95Ms=n\/a/);
  assert.match(f.logs[0], /callerOk=1 callerTimeout=1 callerError=1 aborted=0/);
});
