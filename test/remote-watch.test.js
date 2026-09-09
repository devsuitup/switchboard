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
  child.kill = () => { child.killed++; child.emit('close', null); };
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
  assert.ok(args.includes('BatchMode=yes'));
  assert.equal(args[args.length - 2], 'planificator', 'alias is its own argv element, never concatenated');
  const command = args[args.length - 1];
  assert.match(command, /inotifywait/);
  assert.ok(command.includes(REMOTE_PROJECTS_REL));
  assert.ok(command.includes(REMOTE_SESSIONS_REL));
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
