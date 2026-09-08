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

const { LIST_COMMAND, SESSIONS_MARKER, splitListOutput, parseSessions } = require('../remote-transport');

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
    const result = spawnSync('sh', ['-c', LIST_COMMAND], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'a missing inventory root must fail the whole command');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('LIST_COMMAND: .claude/sessions missing but .claude/projects present (even empty) degrades cleanly', { skip: SH_SKIP }, () => {
  const dir = sandbox();
  try {
    fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
    const result = spawnSync('sh', ['-c', LIST_COMMAND], { cwd: dir, encoding: 'utf8' });
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
    fs.writeFileSync(path.join(sessionsDir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'abc' }));
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

    const result = spawnSync('sh', ['-c', LIST_COMMAND], { cwd: dir, encoding: 'utf8' });

    assert.equal(result.status, 0);
    assert.ok(!result.stdout.includes('top-secret-key-material-should-never-appear'),
      'the .key content must never reach stdout');
    if (symlinkCreated) {
      assert.ok(!result.stdout.includes('symlink-target-should-never-appear'),
        'a symlink named like a valid descriptor must never have its target content reach stdout');
    }
    const { sessionsBlock } = splitListOutput(result.stdout);
    const { sessions } = parseSessions(sessionsBlock);
    assert.equal(sessions.length, 1,
      'exactly one descriptor: the directory, the .key file and any symlink are all excluded');
    assert.equal(sessions[0].sessionId, 'abc');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
