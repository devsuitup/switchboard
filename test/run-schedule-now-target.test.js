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
// root, including the root itself. The guard asks it about the project root as
// well as the file, and a stub without the equality branch answers false for
// the root — which refuses on the project check and leaves the check on the
// file untested.
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

test('resolveRunNowTarget: accepts a schedule linked in from a versioned repo elsewhere under the allowed root, and roots the run at the listing project', (t) => {
  const r = rig();
  try {
    // The shape a versioned dotfiles setup produces: the schedule file lives in
    // a repo of its own, outside .claude/commands, and the project's
    // .claude/commands holds a symlink to it. The repo is under the allowed
    // root here — that is the boundary, and the two tests below pin both sides
    // of it.
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

test('resolveRunNowTarget: a project reached through a symlinked ancestor is rooted at its canonical path', (t) => {
  const r = rig();
  try {
    // The project root goes through disk resolution in its own right. Handing
    // back the spelling that was asked for would give the spawn a cwd the
    // allowlist never saw, and compare unequal against the known project list.
    const alias = path.join(r.root, 'alias');
    try { fs.symlinkSync(r.projectPath, alias, 'dir'); }
    catch { return t.skip('cannot create a symlink on this machine'); }

    const filePath = path.join(r.commandsDir, 'schedule-nightly.md');
    fs.writeFileSync(filePath, '---\nname: nightly\n---\ndo the thing');

    const viaAlias = path.join(alias, '.claude', 'commands', 'schedule-nightly.md');
    const out = resolveRunNowTarget(viaAlias, allowUnder(r.projectPath));
    assert.equal(out.ok, true, out.error);
    assert.equal(out.projectPath, fs.realpathSync(r.projectPath));
    assert.equal(out.realPath, fs.realpathSync(filePath));
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: a schedule linked between two known projects reads one and roots the run in the other', (t) => {
  const r = rig();
  try {
    // The file and the cwd are resolved and allowlisted independently, so when
    // both land in allowed roots they may legitimately be different roots: the
    // bytes come from projB, the run belongs to projA because projA's
    // .claude/commands is what lists it. Pinned so it is not "fixed" either way
    // by accident — see .ai/contexts/schedule-runner.md.
    const projB = path.join(r.root, 'project-b');
    const bCommands = path.join(projB, '.claude', 'commands');
    fs.mkdirSync(bCommands, { recursive: true });
    const realFile = path.join(bCommands, 'schedule-shared.md');
    fs.writeFileSync(realFile, '---\nname: shared\n---\nrun the shared task');

    const linkPath = path.join(r.commandsDir, 'schedule-shared.md');
    try { fs.symlinkSync(realFile, linkPath, 'file'); }
    catch { return t.skip('cannot create a symlink on this machine'); }

    const bothKnown = (p) => [r.projectPath, projB].some((root) => {
      const real = fs.realpathSync(root);
      return p === real || p.startsWith(real + path.sep);
    });

    const out = resolveRunNowTarget(linkPath, bothKnown);
    assert.equal(out.ok, true, out.error);
    assert.equal(out.realPath, fs.realpathSync(realFile), 'content comes from project B');
    assert.equal(out.projectPath, fs.realpathSync(r.projectPath), 'cwd is project A, which lists it');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: refuses a link whose target is not itself named schedule-*.md, however the link is named', (t) => {
  const r = rig();
  try {
    // The listing directory decides where a schedule may be *linked from*; it
    // does not decide what the link may point at. Without this, any file the
    // allowlist reaches — a project file, anything under ~/.claude — becomes
    // the prompt of a spawned `claude -p` by being linked under a
    // schedule-shaped name.
    const secret = path.join(r.projectPath, 'credentials.json');
    fs.writeFileSync(secret, '{"token":"sk-not-a-real-token"}');

    const linkPath = path.join(r.commandsDir, 'schedule-weekly.md');
    try { fs.symlinkSync(secret, linkPath, 'file'); }
    catch { return t.skip('cannot create a symlink on this machine'); }

    const out = resolveRunNowTarget(linkPath, allowUnder(r.projectPath));
    assert.equal(out.ok, false);
    assert.equal(out.error, 'not a schedule file');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: refuses a link to a sensitive location even under a schedule-shaped name at both ends', (t) => {
  const r = rig();
  try {
    // The denylist answers for the resolved target as well: a name that passes
    // both filename checks still must not open a credential store.
    const sshDir = path.join(r.projectPath, '.ssh');
    fs.mkdirSync(sshDir, { recursive: true });
    const target = path.join(sshDir, 'schedule-keys.md');
    fs.writeFileSync(target, 'id_rsa contents');

    const linkPath = path.join(r.commandsDir, 'schedule-keys.md');
    try { fs.symlinkSync(target, linkPath, 'file'); }
    catch { return t.skip('cannot create a symlink on this machine'); }

    const out = resolveRunNowTarget(linkPath, allowUnder(r.projectPath));
    assert.equal(out.ok, false);
    assert.equal(out.error, 'path not allowed');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: refuses a schedule linked in from a repo outside every allowed root', (t) => {
  const r = rig();
  try {
    // The counterpart of the accepting case above: a dotfiles repo the user has
    // never opened as a project is not a place this handler reads and spawns
    // from, however correctly the link is named and placed.
    const repoDir = path.join(r.outsideDir, 'dotfiles');
    fs.mkdirSync(repoDir, { recursive: true });
    const realFile = path.join(repoDir, 'schedule-audit.md');
    fs.writeFileSync(realFile, '---\nname: audit\ncron: 17 12 * * 1\n---\naudit');

    const linkPath = path.join(r.commandsDir, 'schedule-audit.md');
    try { fs.symlinkSync(realFile, linkPath, 'file'); }
    catch { return t.skip('cannot create a symlink on this machine'); }

    const out = resolveRunNowTarget(linkPath, allowUnder(r.projectPath));
    assert.equal(out.ok, false);
    assert.equal(out.error, 'path not allowed');
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

    // allowUnder allows the known project root and everything under it, so the
    // project check passes and the refusal can only come from the check on the
    // resolved file — the one this test is about.
    const out = resolveRunNowTarget(linkPath, allowUnder(r.projectPath));
    assert.equal(out.ok, false, 'the resolved real target lives outside the known project');
    assert.equal(out.error, 'path not allowed');
  } finally { r.cleanup(); }
});

test('resolveRunNowTarget: rejects non-string / empty input without touching the filesystem', () => {
  for (const bad of [null, undefined, 42, '', {}]) {
    const out = resolveRunNowTarget(bad, allowAll);
    assert.equal(out.ok, false);
    assert.equal(out.error, 'invalid path');
  }
});
