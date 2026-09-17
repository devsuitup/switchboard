// test/run-schedule-now-target.test.js — unit tests for the run-schedule-now
// path guard.
//
// Before this file, `run-schedule-now` (schedule-ipc.js) had no guard at
// all: it took a renderer-supplied string, read it with fs.readFileSync, and
// spawned a `claude` process rooted at a directory derived from it — no
// denylist, no allowlist, no disk resolution. This is the one guard that
// stands between that channel and an arbitrary read + spawn.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { resolveRunNowTarget } = require('../run-schedule-now-target');

function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-run-now-')));
  const projectPath = path.join(root, 'known-project');
  const commandsDir = path.join(projectPath, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  return {
    root, projectPath, commandsDir, outsideDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const allowAll = () => true;

// The predicate stands in for isAllowedMemoryPath: containment in an allowed
// root, not an exact match on one file. The guard asks it about the project
// root as well as the file, since the two are no longer the same branch of
// the filesystem once a schedule is symlinked in.
const allowUnder = (root) => (p) => {
  const real = fs.realpathSync(root);
  return p === real || p.startsWith(real + path.sep);
};

test('resolveRunNowTarget: accepts a schedule-*.md file inside a project .claude/commands dir that is allowed', () => {
  const r = rig();
  try {
    const filePath = path.join(r.commandsDir, 'schedule-nightly.md');
    fs.writeFileSync(filePath, '---\nname: nightly\n---\ndo the thing');
    const out = resolveRunNowTarget(filePath, allowUnder(r.projectPath));
    assert.equal(out.ok, true);
    assert.equal(out.realPath, fs.realpathSync(filePath));
    assert.equal(out.projectPath, fs.realpathSync(r.projectPath));
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: accepts a schedule linked in from outside the project, and roots the run at the listing project', (t) => {
  const r = rig();
  try {
    // The shape a versioned dotfiles setup produces: the schedule file lives
    // in a repo somewhere else on disk, and the project's .claude/commands
    // holds a symlink to it. Both the link's target and the project root are
    // inside the allowed root here (a repo checked out under the workspace),
    // which is what makes it different from the escaping case below.
    const repoDir = path.join(r.projectPath, 'dotfiles', 'switchboard');
    fs.mkdirSync(repoDir, { recursive: true });
    const realFile = path.join(repoDir, 'schedule-audit.md');
    fs.writeFileSync(realFile, '---\nname: audit\ncron: 17 12 * * 1\n---\naudit the memory');

    const linkPath = path.join(r.commandsDir, 'schedule-audit.md');
    try { fs.symlinkSync(realFile, linkPath, 'file'); }
    catch { return t.skip('cannot create a symlink on this machine'); }

    const out = resolveRunNowTarget(linkPath, allowUnder(r.projectPath));
    assert.equal(out.ok, true, out.error);
    assert.equal(out.realPath, fs.realpathSync(realFile), 'the file read is the link target');
    assert.equal(out.projectPath, fs.realpathSync(r.projectPath),
      'the run is rooted at the project whose .claude/commands lists it, not at the repo the file happens to live in');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: refuses a schedule whose project root is not allowed, even when the file itself is', () => {
  const r = rig();
  try {
    const filePath = path.join(r.commandsDir, 'schedule-nightly.md');
    fs.writeFileSync(filePath, '---\nname: nightly\n---\ndo the thing');
    // The file passes, the project the run would be spawned in does not: the
    // cwd of the spawn is its own thing to allowlist, not something to infer
    // from the file once the two can live apart.
    const isPathAllowed = (p) => p === fs.realpathSync(filePath);
    const out = resolveRunNowTarget(filePath, isPathAllowed);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'path not allowed');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: refuses a path outside every known project — before any read or spawn', () => {
  const r = rig();
  try {
    const filePath = path.join(r.outsideDir, '.claude', 'commands', 'schedule-evil.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '---\nname: evil\n---\nrm -rf /');
    let read = false;
    const isPathAllowed = () => { read = true; return false; };
    const out = resolveRunNowTarget(filePath, isPathAllowed);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'path not allowed');
    assert.ok(read, 'the allowlist predicate is expected to run (and refuse)');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: refuses a nonexistent path before calling isPathAllowed at all', () => {
  const r = rig();
  try {
    let called = false;
    const out = resolveRunNowTarget(path.join(r.commandsDir, 'schedule-ghost.md'), () => { called = true; return true; });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'file not found');
    assert.equal(called, false, 'must be refused before the allowlist (and before any read) runs');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: refuses a file that is not named schedule-*.md', () => {
  const r = rig();
  try {
    const filePath = path.join(r.commandsDir, 'not-a-schedule.md');
    fs.writeFileSync(filePath, 'x');
    const out = resolveRunNowTarget(filePath, allowAll);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'not a schedule file');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: refuses a schedule-*.md file that is not inside .claude/commands', () => {
  const r = rig();
  try {
    const filePath = path.join(r.projectPath, 'schedule-nightly.md');
    fs.writeFileSync(filePath, 'x');
    const out = resolveRunNowTarget(filePath, allowAll);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'not inside a project .claude/commands directory');
  } finally { r.cleanup(); }
});

// The two checks above (parent dir named "commands", grandparent named
// ".claude") are joined with ||, not &&: either name being wrong is enough
// to refuse. The two existing tests above don't distinguish || from && —
// in both, either both names are already right (accepted either way) or
// both are already wrong (refused either way). This test puts exactly one
// name right and the other wrong, which || refuses and && would wrongly
// accept (a De Morgan mutation that left every prior test green).
test('resolveRunNowTarget: refuses a directory literally named "commands" when it is not the direct child of .claude (exactly one of the two name checks fails)', () => {
  const r = rig();
  try {
    // <project>/foo/commands/schedule-x.md: basename(commandsDir) === 'commands'
    // (that check passes) but basename(dirname(commandsDir)) === 'foo', not
    // '.claude' (that check fails) — exactly one true, one false.
    const foreignCommandsDir = path.join(r.projectPath, 'foo', 'commands');
    fs.mkdirSync(foreignCommandsDir, { recursive: true });
    const filePath = path.join(foreignCommandsDir, 'schedule-x.md');
    fs.writeFileSync(filePath, 'x');
    const out = resolveRunNowTarget(filePath, allowAll);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'not inside a project .claude/commands directory');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: a symlinked commands directory escaping the project is caught by disk resolution', (t) => {
  const r = rig();
  try {
    const evilCommandsDir = path.join(r.outsideDir, '.claude', 'commands');
    fs.mkdirSync(evilCommandsDir, { recursive: true });
    const realFile = path.join(evilCommandsDir, 'schedule-evil.md');
    fs.writeFileSync(realFile, '---\nname: evil\n---\nrm -rf /');

    // Symlink projectPath/.claude/commands/schedule-evil.md -> the file above,
    // so the string handed to the guard *looks* like it lives inside the
    // known project's commands dir.
    const linkPath = path.join(r.commandsDir, 'schedule-evil.md');
    let linked;
    try { fs.symlinkSync(realFile, linkPath, 'file'); linked = true; }
    catch { linked = false; }
    if (!linked) return t.skip('cannot create a symlink on this machine');

    // isPathAllowed only allows the known project root, not the outside one.
    const isPathAllowed = (p) => p.startsWith(fs.realpathSync(r.projectPath) + path.sep);
    const out = resolveRunNowTarget(linkPath, isPathAllowed);
    assert.equal(out.ok, false, 'the resolved real target lives outside the known project');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: rejects non-string / empty input without touching the filesystem', () => {
  for (const bad of [null, undefined, 42, '', {}]) {
    const out = resolveRunNowTarget(bad, allowAll);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'invalid path');
  }
});
