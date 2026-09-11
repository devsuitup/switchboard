'use strict';

// The remote watch channel, fully injected: no real ssh, no real timers.
// Properties proven here (issue #240, see .ai/contexts/session-cache.md,
// "Remote hosts — watch channel"):
//   1. -tt is passed — without it, a killed local ssh leaves the remote
//      inotifywait running (measured: one orphan per restart).
//   2. A missing inotifywait marks the host unwatchable and never retries.
//   3. A burst of events collapses to a coalesced signal, not one per line.
//   4. A line that does not parse to a safe path is dropped, not forwarded.
//   5. A child that exits restarts on the same backoff shape as remote-index.
//   6. A child's handlers are bound to that child, not to the alias state:
//      a superseded child's late close/data must never touch the state a
//      newer child owns (audit finding F1). The fake child below does NOT
//      emit 'close' on kill() — a real ssh process reports its exit on its
//      own asynchronous schedule — so a test drives that arrival explicitly
//      with child.emitClose(), on whatever tick reproduces the race.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const {
  createRemoteWatcher, parseWatchLine, buildSshArgs, NO_INOTIFYWAIT_MARKER,
} = require('../remote-watch');
const { backoffDelayMs } = require('../remote-index');
const { REMOTE_PROJECTS_REL, REMOTE_SESSIONS_REL } = require('../remote-transport');

const silentLog = { info() {}, warn() {}, error() {} };

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = 0;
  // Deliberately does NOT emit 'close' here: a real ssh process's exit is
  // reported asynchronously, independent of when kill() was called (F1).
  child.kill = () => { child.killed++; };
  child.emitClose = (code = null) => child.emit('close', code);
  return child;
}

/** spawn stub: records every call and hands the child back to drive by hand. */
function spawnRecorder() {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = fakeChild();
    calls.push({ cmd, args, child });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** setTimeout/clearTimeout double: nothing fires until the test says so. */
function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; scheduled.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
  };
}

test('buildSshArgs passes -tt, BatchMode, and keeps alias/command as separate argv elements', () => {
  const args = buildSshArgs('planificator');
  assert.ok(args.includes('-tt'), '-tt is mandatory: without it a killed ssh leaves the remote inotifywait running');
  assert.equal(args[0], '-tt', '-tt must come first');
  assert.ok(args.includes('BatchMode=yes'));
  assert.equal(args[args.length - 2], 'planificator', 'alias is its own argv element, never concatenated');
  const command = args[args.length - 1];
  assert.match(command, /inotifywait/);
  assert.ok(command.includes(REMOTE_PROJECTS_REL));
  assert.ok(command.includes(REMOTE_SESSIONS_REL));
});

test('buildSshArgs adds a connect timeout and keepalive so a half-open ssh does not hang silently forever (F4)', () => {
  const args = buildSshArgs('planificator');
  const aliasIdx = args.indexOf('planificator');
  assert.ok(aliasIdx > 0, 'alias must still be present as its own argv element');
  for (const opt of ['ConnectTimeout=10', 'ServerAliveInterval=30', 'ServerAliveCountMax=3']) {
    const idx = args.indexOf(opt);
    assert.ok(idx !== -1, `${opt} must be present`);
    assert.ok(idx < aliasIdx, `${opt} must come before the alias`);
    assert.equal(args[idx - 1], '-o', `${opt} must be introduced by its own -o flag`);
  }
});

test('parseWatchLine recovers kind and rel path for a well-formed line', () => {
  assert.deepEqual(
    parseWatchLine(`P|${REMOTE_PROJECTS_REL}/-srv-a/session.jsonl`),
    { kind: 'project', rel: '-srv-a/session.jsonl' },
  );
  assert.deepEqual(
    parseWatchLine(`S|${REMOTE_SESSIONS_REL}/1234.json`),
    { kind: 'session', rel: '1234.json' },
  );
});

test('parseWatchLine drops a line that does not parse, instead of guessing', () => {
  assert.equal(parseWatchLine(''), null);
  assert.equal(parseWatchLine('garbage'), null);
  assert.equal(parseWatchLine(`X|${REMOTE_PROJECTS_REL}/a.jsonl`), null, 'unknown kind prefix');
  assert.equal(parseWatchLine(`P|.claude/other/a.jsonl`), null, 'wrong root entirely');
  assert.equal(
    parseWatchLine(`P|${REMOTE_PROJECTS_REL}/../../etc/passwd`), null,
    'traversal beyond the declared root must never be forwarded',
  );
  assert.equal(parseWatchLine(`S|${REMOTE_SESSIONS_REL}/not-a-descriptor.txt`), null, 'wrong descriptor filename shape');
  assert.equal(parseWatchLine(`S|${REMOTE_SESSIONS_REL}/sub/1234.json`), null, 'sessions dir is not recursive');
});

test('a missing inotifywait marks the host unwatchable and never schedules a retry', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });
  const events = [];

  watcher.start('vps', (alias, kind) => events.push({ alias, kind }));
  assert.equal(spawn.calls.length, 1);

  const { child } = spawn.calls[0];
  child.stdout.push(NO_INOTIFYWAIT_MARKER + '\n');
  child.stdout.push(null);
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 44);

  assert.equal(watcher.isRunning('vps'), false, 'a missing binary must never look like a healthy watcher');
  assert.equal(events.length, 0);
  assert.ok(timers.scheduled.every(h => h.cleared), 'no restart may be scheduled once marked unwatchable');
  assert.equal(spawn.calls.length, 1, 'exactly one attempt — the periodic cycle already covers this host');
});

test('a burst of same-kind events collapses to far fewer callbacks than events', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });
  const events = [];

  watcher.start('vps', (alias, kind) => events.push({ alias, kind }));
  const { child } = spawn.calls[0];
  const rel = `${REMOTE_PROJECTS_REL}/-srv-a/session.jsonl`;
  for (let i = 0; i < 100; i++) child.stdout.push(`P|${rel}\n`);
  child.stdout.push(null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(events.length >= 1, 'at least the leading edge must fire');
  assert.ok(events.length <= 2, `100 rapid events must coalesce to a leading + at most one trailing flush, got ${events.length}`);
  assert.ok(events.every(e => e.kind === 'project'));
});

test('onActivity fires once per project event, uncoalesced — not collapsed like onEvent', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });
  const events = [];
  const activity = [];

  watcher.start('vps', (alias, kind) => events.push({ alias, kind }), (alias, rel) => activity.push({ alias, rel }));
  const { child } = spawn.calls[0];
  const rel = `${REMOTE_PROJECTS_REL}/-srv-a/session.jsonl`;
  for (let i = 0; i < 19; i++) child.stdout.push(`P|${rel}\n`);
  child.stdout.push(null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(activity.length, 19, 'onActivity must fire once per raw line, unlike the coalesced onEvent');
  assert.ok(events.length <= 2, 'onEvent must still coalesce the same burst');
  assert.ok(activity.every(a => a.alias === 'vps' && a.rel === '-srv-a/session.jsonl'));
});

test('a session-kind event never reaches onActivity', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });
  const activity = [];

  watcher.start('vps', () => {}, (alias, rel) => activity.push({ alias, rel }));
  const { child } = spawn.calls[0];
  child.stdout.push(`S|${REMOTE_SESSIONS_REL}/1234.json\n`);
  child.stdout.push(null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(activity, [], 'a session descriptor event must not be mistaken for transcript activity');
});

test('start() works with no onActivity supplied — the callback is optional', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });

  watcher.start('vps', () => {});
  const { child } = spawn.calls[0];
  child.stdout.push(`P|${REMOTE_PROJECTS_REL}/-srv-a/session.jsonl\n`);
  child.stdout.push(null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(watcher.isRunning('vps'), true, 'a project event with no onActivity wired must not throw');
});

test('project and session events are distinguishable in the callback', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });
  const events = [];

  watcher.start('vps', (alias, kind) => events.push({ alias, kind }));
  const { child } = spawn.calls[0];
  child.stdout.push(`P|${REMOTE_PROJECTS_REL}/-srv-a/session.jsonl\n`);
  child.stdout.push(`S|${REMOTE_SESSIONS_REL}/1234.json\n`);
  child.stdout.push(null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.sort((a, b) => a.kind.localeCompare(b.kind)), [
    { alias: 'vps', kind: 'project' },
    { alias: 'vps', kind: 'session' },
  ]);
});

test('a live watcher restarts on exit using the same backoff shape as remote-index', () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });

  watcher.start('vps', () => {});
  assert.equal(spawn.calls.length, 1);

  // Three consecutive rapid deaths: the per-attempt delay must follow
  // remote-index's own doubling-with-cap formula, not a locally invented one
  // (a linear or constant reimplementation matches at the 1st failure but
  // diverges by the 3rd).
  for (let failures = 1; failures <= 3; failures++) {
    const last = spawn.calls[spawn.calls.length - 1];
    last.child.emit('close', 1); // dies almost immediately -> counts as a failure

    const pending = timers.scheduled.filter(h => !h.cleared).pop();
    assert.ok(pending, `a restart must be scheduled after failure ${failures}`);
    assert.equal(pending.ms, backoffDelayMs(failures, 5000),
      'the delay must come from remote-index\'s own backoff formula, not a reimplementation');

    pending.fn();
  }
  assert.equal(spawn.calls.length, 4, 'each scheduled restart actually respawns the watcher');
});

test('a quick failing exit logs once with the stderr tail; a duplicate close on the same child never re-logs (F4)', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const warnings = [];
  const log = { info() {}, warn: (msg) => warnings.push(msg), error() {} };
  const watcher = createRemoteWatcher({ spawn, log, timers });

  watcher.start('vps', () => {});
  const a = spawn.calls[0].child;
  a.stderr.push('Host key verification failed.\n');
  await new Promise((resolve) => setImmediate(resolve));
  a.emit('close', 255); // dies almost immediately -> counts as a failure, tier 1

  assert.equal(warnings.length, 1, 'the first quick failure at a new backoff tier must log once');
  assert.match(warnings[0], /Host key verification failed\./, 'the captured stderr tail must appear in the warning');
  assert.match(warnings[0], /255/, 'the exit code must appear in the warning');

  // A duplicate 'close' on the very same, already-handled child (the kind of
  // glitch a real child_process can produce) must be a no-op: the F1
  // identity guard already nulled s.child, so this can never log again.
  a.emit('close', 255);
  assert.equal(warnings.length, 1, 'a duplicate close on the same already-handled child must not log again');
});

test('a stop() immediately followed by start() does not let A\'s late async close orphan B (F1)', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });
  const events = [];
  const onEvent = (alias, kind) => events.push({ alias, kind });

  watcher.start('vps', onEvent);
  const a = spawn.calls[0].child;

  watcher.stop('vps');
  assert.equal(a.killed, 1, 'A must be killed by stop()');

  watcher.start('vps', onEvent);
  assert.equal(spawn.calls.length, 2, 'start() spawns B right away, without waiting for A to actually close');
  const b = spawn.calls[1].child;

  // A's real ssh process reports its exit on its own schedule, independent
  // of when kill() was called — arriving here, after B already owns
  // s.child, is exactly the race.
  a.emitClose(0);
  for (const h of timers.scheduled) if (!h.cleared) h.fn();
  assert.equal(spawn.calls.length, 2, "A's late close must never spawn a third child (C) behind B's back");
  assert.equal(watcher.isRunning('vps'), true, 'B must remain the tracked, live watcher');

  // A data chunk delivered after supersession must never reach onEvent.
  a.stdout.push(`P|${REMOTE_PROJECTS_REL}/-srv-a/session.jsonl\n`);
  a.stdout.push(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 0, 'a chunk from the superseded child A must never reach onEvent');

  watcher.stopAll();
  assert.equal(b.killed, 1, 'stopAll() must still be able to kill B — it must never be orphaned');
});

test('stop() clears a pending coalesce cooldown so it cannot fire onEvent after stop (F11)', async () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });
  const events = [];

  watcher.start('vps', (alias, kind) => events.push({ alias, kind }));
  const { child } = spawn.calls[0];
  const rel = `${REMOTE_PROJECTS_REL}/-srv-a/session.jsonl`;

  child.stdout.push(`P|${rel}\n`);
  child.stdout.push(`P|${rel}\n`); // second event while still in cooldown -> queued as pending
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1, 'the leading edge fires once; the second event is only pending');

  const cooldown = timers.scheduled.filter(h => !h.cleared).pop();
  assert.ok(cooldown, 'a cooldown timer must be pending with a queued trailing event');

  watcher.stop('vps');
  assert.ok(cooldown.cleared, 'stop() must clear the pending coalesce cooldown, not just the restart timer');

  cooldown.fn(); // simulate the timer firing anyway, in case the clear alone were reverted
  assert.equal(events.length, 1, 'a cooldown that outlives stop() must never re-fire onEvent');
});

test('stop() kills the live child and cancels any pending restart', () => {
  const spawn = spawnRecorder();
  const timers = fakeTimers();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers });

  watcher.start('vps', () => {});
  const { child } = spawn.calls[0];
  watcher.stop('vps');

  assert.equal(child.killed, 1);
  assert.equal(watcher.isRunning('vps'), false);
  assert.ok(timers.scheduled.every(h => h.cleared), 'stop() must not leave a restart pending');
});

test('stopAll() tears down every tracked alias', () => {
  const spawn = spawnRecorder();
  const watcher = createRemoteWatcher({ spawn, log: silentLog, timers: fakeTimers() });

  watcher.start('vps', () => {});
  watcher.start('other', () => {});
  watcher.stopAll();

  assert.equal(watcher.isRunning('vps'), false);
  assert.equal(watcher.isRunning('other'), false);
  assert.equal(spawn.calls.filter(c => c.child.killed).length, 2);
});
