// Tests for cli-session-state.js's findLiveProcess / liveElsewhere — the
// main-side answer to "is this session running in another process?" that
// gates an automatic resume. See .ai/contexts/cli-session-state.md
// ("Live elsewhere").
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const cliSessionState = require('../cli-session-state');

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-live-elsewhere-')));
}

function writeState(dir, pid, fields = {}) {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: 'sess-1',
    cwd: '/work/proj',
    startedAt: 1790685077444,
    procStart: '9373049',
    version: '2.1.284',
    kind: 'interactive',
    status: 'idle',
    ...fields,
  }), 'utf8');
}

function boot(dir, opts = {}) {
  cliSessionState.init({
    dir,
    activeSessions: new Map(),
    log: silentLog,
    onIdle: () => {},
    isProcessAlive: opts.isProcessAlive || (() => true),
    readProcStart: opts.readProcStart || (() => '9373049'),
    readParentPid: opts.readParentPid || (() => null),
    ownPid: opts.ownPid,
  });
}

function withDir(fn) {
  const dir = mkTmp();
  try {
    return fn(dir);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const noPty = () => false;

test('a session whose id is in a state file under a live pid is live elsewhere', () => withDir((dir) => {
  writeState(dir, 4242);
  boot(dir);
  assert.deepEqual(cliSessionState.liveElsewhere('sess-1', noPty),
    { pid: 4242, cwd: '/work/proj', startedAt: 1790685077444 });
}));

test('a session this instance holds a PTY for is not live elsewhere, even with a live state file', () => withDir((dir) => {
  // A renderer reload keeps main's PTY: the resume is a re-attach, not a second CLI.
  writeState(dir, 4242);
  boot(dir);
  const hasPty = (id) => id === 'sess-1';
  assert.equal(cliSessionState.liveElsewhere('sess-1', hasPty), null);
}));

test('a state file left by a dead pid is not live', () => withDir((dir) => {
  writeState(dir, 4242);
  boot(dir, { isProcessAlive: () => false });
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty), null);
}));

test('a reused pid (procStart differs from the recorded one) is not live', () => withDir((dir) => {
  writeState(dir, 4242, { procStart: '111' });
  boot(dir, { readProcStart: () => '222' });
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty), null);
}));

test('when the process start cannot be read, liveness alone decides', () => withDir((dir) => {
  writeState(dir, 4242, { procStart: '111' });
  boot(dir, { readProcStart: () => null });
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty).pid, 4242);
}));

test('another session\'s state file does not make this one live', () => withDir((dir) => {
  writeState(dir, 4242, { sessionId: 'other' });
  boot(dir);
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty), null);
}));

test('the answer does not depend on the status field or on the watcher being attached', () => withDir((dir) => {
  // An unknown status is rejected by parseState for the idle trigger, but a
  // live process holding the session is still a live process.
  writeState(dir, 4242, { status: 'something-new' });
  boot(dir);
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty).pid, 4242);
}));

test('a missing directory, a corrupt file and a non-state file are silence, not a throw', () => {
  boot(path.join(os.tmpdir(), 'sw-live-elsewhere-does-not-exist'));
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty), null);
  cliSessionState.stop();

  withDir((dir) => {
    fs.writeFileSync(path.join(dir, '4242.json'), '{"pid":42', 'utf8');
    fs.writeFileSync(path.join(dir, '4243.key'), JSON.stringify({ pid: 4243, sessionId: 'sess-1' }), 'utf8');
    boot(dir);
    assert.equal(cliSessionState.liveElsewhere('sess-1', noPty), null);
  });
});

test('a non-string session id is refused without touching the directory', () => withDir((dir) => {
  writeState(dir, 4242);
  boot(dir);
  assert.equal(cliSessionState.liveElsewhere(undefined, noPty), null);
  assert.equal(cliSessionState.liveElsewhere({ sessionId: 'sess-1' }, noPty), null);
}));

test('on Linux, the default probes read the real start time of a real process', { skip: process.platform !== 'linux' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];

    withDir((dir) => {
      // ownPid off this tree: the child stands for another instance's CLI
      cliSessionState.init({ dir, activeSessions: new Map(), log: silentLog, onIdle: () => {}, ownPid: -1 });

      writeState(dir, child.pid, { procStart });
      assert.equal(cliSessionState.liveElsewhere('sess-1', noPty).pid, child.pid,
        'the recorded procStart matches /proc: the process is the one that wrote the file');

      writeState(dir, child.pid, { procStart: String(Number(procStart) + 1) });
      assert.equal(cliSessionState.liveElsewhere('sess-1', noPty), null,
        'a different procStart means the pid was reused by another process');
    });
  } finally {
    child.kill('SIGKILL');
  }
});

// A session this instance spawned can still be keyed by its pending id when a
// reload asks, so hasPty misses it; its CLI is still this instance's own.
test('a CLI this instance spawned is never live elsewhere, even before its PTY is keyed by the real id', () => withDir((dir) => {
  writeState(dir, 5001);
  const parents = { 5001: 5000, 5000: 900 };   // claude -> shell -> this main process
  boot(dir, { ownPid: 900, readParentPid: (pid) => parents[pid] || null });
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty), null);
}));

test('a CLI that is the PTY process itself is this instance\'s own', () => withDir((dir) => {
  writeState(dir, 5001);
  boot(dir);
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]), null);
}));

test('a CLI under another process tree is still live elsewhere', () => withDir((dir) => {
  writeState(dir, 5001);
  const parents = { 5001: 7000, 7000: 1 };
  boot(dir, { ownPid: 900, readParentPid: (pid) => parents[pid] || null });
  assert.equal(cliSessionState.liveElsewhere('sess-1', noPty, () => [6000]).pid, 5001);
}));

test('on Linux, a real child of this process is recognised as its own through /proc', { skip: process.platform !== 'linux' }, async () => {
  const dir = mkTmp();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => child.once('spawn', r));
    writeState(dir, child.pid, { procStart: null });
    cliSessionState.init({ dir, activeSessions: new Map(), log: silentLog, onIdle: () => {} });
    assert.equal(cliSessionState.liveElsewhere('sess-1', noPty), null);
  } finally {
    child.kill();
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
