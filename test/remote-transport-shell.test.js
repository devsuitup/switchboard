'use strict';

// Real shell execution of LIST_COMMAND, not a fake stdout fixture. Every other
// test in remote-transport.test.js hand-builds stdout or does string equality
// on LIST_COMMAND — none of them run the command through a shell, which is how
// the exit-status-swallowing bug (issue #211 follow-up) shipped past three
// rounds of review. See .ai/contexts/session-cache.md ("Remote SSH hosts (issue #211)").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnSyncRetryingCrash } = require('./spawn-retry');

const { LIST_COMMAND, ALIVE_MARKER_PREFIX, SESSIONS_MARKER, splitListOutput, parseSessions } = require('../remote-transport');

function shAvailable() {
  const r = spawnSync('sh', ['-c', 'exit 0']);
  return !r.error;
}

const SH_SKIP = shAvailable() ? false : 'sh is not available on this machine';

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-shell-'));
}

test('LIST_COMMAND: .claude/projects missing yields a non-zero exit status', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    const result = spawnSyncRetryingCrash('sh', ['-c', LIST_COMMAND], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'a missing inventory root must fail the whole command');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LIST_COMMAND: .claude/sessions missing but .claude/projects present (even empty) degrades cleanly', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
    const result = spawnSyncRetryingCrash('sh', ['-c', LIST_COMMAND], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes(SESSIONS_MARKER), 'the marker must still be emitted');
    const { inventoryBlock, sessionsBlock } = splitListOutput(result.stdout);
    assert.equal(inventoryBlock, '', 'a refused split would leave the marker inside inventoryBlock instead of sessionsBlock');
    assert.equal(sessionsBlock, '',
      'an empty projects dir puts the marker at byte offset 0 with no preceding newline — must still split cleanly');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LIST_COMMAND: only a digit-named .json FILE is read — never a .key file, a directory, or a symlink', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    const sessionsDir = path.join(dir, '.claude', 'sessions');
    fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, '1.abc.key'), 'top-secret-key-material-should-never-appear');
    fs.mkdirSync(path.join(sessionsDir, '2.json'), { recursive: true });

    const symlinkTarget = path.join(dir, 'outside-target.txt');
    fs.writeFileSync(symlinkTarget, 'symlink-target-should-never-appear');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(symlinkTarget, path.join(sessionsDir, '3.json'), 'file');
      symlinkCreated = true;
    } catch {
      // Symlink creation needs an elevated privilege on Windows by default;
      // skip only this one assertion below, not the rest of the test.
    }

    fs.writeFileSync(path.join(sessionsDir, '4242.json'), '{"pid":4242,"sessionId":"abc"}');
    const result = spawnSyncRetryingCrash('sh', ['-c', LIST_COMMAND], { cwd: dir, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('top-secret-key-material-should-never-appear'),
      'the .key content must never reach stdout');
    if (symlinkCreated) {
      assert.ok(!result.stdout.includes('symlink-target-should-never-appear'),
        'a symlink named like a valid descriptor must never have its target content reach stdout');
    }
    const { sessionsBlock } = splitListOutput(result.stdout);
    const markers = sessionsBlock.split('\n').filter((line) => line.startsWith(ALIVE_MARKER_PREFIX));
    assert.equal(markers.length, 1,
      `exactly one descriptor read: the directory, the .key file and any symlink are all excluded; stderr: ${result.stderr}`);
    assert.ok(sessionsBlock.startsWith('{"pid":4242,"sessionId":"abc"}\n'), 'the one descriptor read is the valid one');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function sessionsSandbox(descriptors) {
  const dir = sandbox();
  const sessionsDir = path.join(dir, '.claude', 'sessions');
  fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (const [pid, sessionId] of descriptors) {
    fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, sessionId }));
  }
  return dir;
}

function listSessions(dir, command) {
  const result = spawnSyncRetryingCrash('sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { sessionsBlock } = splitListOutput(result.stdout);
  const markers = sessionsBlock.split('\n').filter((line) => line.startsWith(ALIVE_MARKER_PREFIX));
  return { markers, ...parseSessions(sessionsBlock) };
}

// see .ai/contexts/session-cache.md ("Remote SSH hosts (issue #211)", liveness marker)
test('LIST_COMMAND: the ALIVE marker follows the pid directory under /proc, and parseSessions drops only the dead one', { skip: SH_SKIP }, () => {
  const procCheck = '"/proc/$pid"';
  assert.equal(LIST_COMMAND.split(procCheck).length, 2, 'liveness is read from exactly one /proc/$pid check');
  const dir = sessionsSandbox([[4242, 'live'], [4343, 'dead']]);
  try {
    fs.mkdirSync(path.join(dir, 'proc', '4242'), { recursive: true });
    const { markers, sessions, dropped } = listSessions(dir, LIST_COMMAND.replace(procCheck, '"proc/$pid"'));
    assert.deepEqual(markers, [`${ALIVE_MARKER_PREFIX}1`, `${ALIVE_MARKER_PREFIX}0`]);
    assert.deepEqual(sessions.map((s) => s.sessionId), ['live']);
    assert.equal(dropped, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LIST_COMMAND: on Linux the ALIVE marker reads the real /proc', {
  skip: SH_SKIP || (process.platform !== 'linux' && 'only Linux guarantees /proc/<pid> for a running process'),
}, () => {
  const dir = sessionsSandbox([[process.pid, 'live'], [999999999, 'dead']]);
  try {
    const { sessions, dropped } = listSessions(dir, LIST_COMMAND);
    assert.deepEqual(sessions.map((s) => s.sessionId), ['live']);
    assert.equal(dropped, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

