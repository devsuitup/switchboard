// Executing tests for the guards on session deletion.
//
// The previous suite regex-matched main.js, which the review showed was no
// guarantee at all: neutering the containment check while leaving the matched
// substring in place kept every test green. These call the real functions
// against real directories, real files and real symlinks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isValidSessionId, isInsideDir, resolveDeletionTargets, resolveRowDeletionTargets } = require('../delete-session-target');

const ID = '57cf3347-04e1-485f-8063-4d8700785fba';

function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-del-')));
  const projects = path.join(root, 'projects');
  const folder = path.join(projects, '-home-u-proj');
  fs.mkdirSync(folder, { recursive: true });
  return { root, projects, folder, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// --- isValidSessionId ---

test('isValidSessionId accepts a real session id and rejects anything path-like', () => {
  assert.equal(isValidSessionId(ID), true);
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '.', '..', '', 'a b', 'a;rm -rf /', null, undefined, 42]) {
    assert.equal(isValidSessionId(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
});

// --- isInsideDir ---

test('isInsideDir accepts the directory itself and its descendants', () => {
  assert.equal(isInsideDir('/a/b', '/a/b'), true);
  assert.equal(isInsideDir('/a/b/c/d.jsonl', '/a/b'), true);
});

test('isInsideDir rejects a sibling that merely shares the prefix', () => {
  // The bug this pins: a plain startsWith would accept /a/projects-evil
  // as being inside /a/projects.
  assert.equal(isInsideDir('/a/projects-evil/x', '/a/projects'), false);
  assert.equal(isInsideDir('/a', '/a/b'), false);
  assert.equal(isInsideDir('', '/a'), false);
  assert.equal(isInsideDir('/a', ''), false);
});

// --- resolveDeletionTargets ---

test('resolves the transcript and the sibling subagent directory together', () => {
  const r = rig();
  try {
    const jsonl = path.join(r.folder, ID + '.jsonl');
    const subdir = path.join(r.folder, ID, 'subagents');
    fs.writeFileSync(jsonl, '{}\n');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'agent-x.jsonl'), '{}\n');

    const out = resolveDeletionTargets(r.projects, ID);
    assert.equal(out.ok, true);
    assert.deepEqual(out.targets.sort(), [jsonl, path.join(r.folder, ID)].sort(),
      'both the transcript and its subagent directory belong to the same conversation');
    assert.deepEqual(out.refused, []);
  } finally { r.cleanup(); }
});

test('refuses a target whose symlink escapes the projects directory', () => {
  const r = rig();
  try {
    const outside = path.join(r.root, 'secret.jsonl');
    fs.writeFileSync(outside, 'do not delete me\n');
    fs.symlinkSync(outside, path.join(r.folder, ID + '.jsonl'));

    const out = resolveDeletionTargets(r.projects, ID);
    assert.equal(out.ok, true);
    assert.deepEqual(out.targets, [], 'nothing inside the projects dir, so nothing to delete');
    assert.equal(out.refused.length, 1, 'the escaping link must be reported, not silently skipped');
    assert.equal(out.refused[0].real, outside);
    assert.ok(fs.existsSync(outside), 'and the target outside must still be there');
  } finally { r.cleanup(); }
});

test('refuses a symlinked DIRECTORY that escapes, not just a file', () => {
  const r = rig();
  try {
    const outside = path.join(r.root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(r.folder, ID));

    const out = resolveDeletionTargets(r.projects, ID);
    assert.deepEqual(out.targets, []);
    assert.equal(out.refused.length, 1);
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  } finally { r.cleanup(); }
});

test('a symlink that stays inside the projects directory is allowed', () => {
  const r = rig();
  try {
    const real = path.join(r.folder, 'real.jsonl');
    fs.writeFileSync(real, '{}\n');
    fs.symlinkSync(real, path.join(r.folder, ID + '.jsonl'));

    const out = resolveDeletionTargets(r.projects, ID);
    assert.deepEqual(out.targets, [real], 'containment is the rule, not "no symlinks"');
    assert.deepEqual(out.refused, []);
  } finally { r.cleanup(); }
});

test('an invalid id resolves nothing at all', () => {
  const r = rig();
  try {
    for (const bad of ['../../etc/passwd', 'a/b', '..']) {
      const out = resolveDeletionTargets(r.projects, bad);
      assert.equal(out.ok, false, `${bad} must be refused outright`);
      assert.deepEqual(out.targets, []);
    }
  } finally { r.cleanup(); }
});

test('a placeholder session with nothing on disk resolves to no targets, not an error', () => {
  const r = rig();
  try {
    const out = resolveDeletionTargets(r.projects, ID);
    assert.equal(out.ok, true, 'a card with no transcript must still be dismissable');
    assert.deepEqual(out.targets, []);
  } finally { r.cleanup(); }
});

test('preferredFolder short-circuits the scan but still finds the targets', () => {
  const r = rig();
  try {
    const jsonl = path.join(r.folder, ID + '.jsonl');
    fs.writeFileSync(jsonl, '{}\n');
    // A second folder that must not be visited when the cached folder is known.
    const other = path.join(r.projects, '-home-u-other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, ID + '.jsonl'), '{}\n');

    const scoped = resolveDeletionTargets(r.projects, ID, '-home-u-proj');
    assert.deepEqual(scoped.targets, [jsonl], 'only the cached folder is consulted');

    const scanned = resolveDeletionTargets(r.projects, ID);
    assert.equal(scanned.targets.length, 2, 'without a hint every folder is scanned');
  } finally { r.cleanup(); }
});

test('an unreadable projects directory is an error, not a throw', () => {
  const out = resolveDeletionTargets('/nonexistent-projects-dir', ID);
  assert.equal(out.ok, false);
  assert.match(out.error, /cannot read projects directory/);
});

test('row deletion resolves every part and its subagent directory across folders once', () => {
  const r = rig();
  try {
    const expected = [];
    const folders = new Map();
    for (const id of ['a', 'b', 'c']) {
      const folder = id === 'c' ? '-other-project' : path.basename(r.folder);
      folders.set(id, folder);
      const base = path.join(r.projects, folder);
      fs.mkdirSync(path.join(base, id, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(base, id + '.jsonl'), '{}\n');
      fs.writeFileSync(path.join(base, id, 'subagents', 'agent-x.jsonl'), '{}\n');
      expected.push(path.join(base, id + '.jsonl'), path.join(base, id));
    }
    const out = resolveRowDeletionTargets(r.projects, 'a', ['b', 'c', 'b', 'a'], id => folders.get(id));
    assert.equal(out.ok, true);
    assert.equal(out.parts, 3);
    assert.deepEqual(out.targets.sort(), expected.sort());
  } finally { r.cleanup(); }
});

test('an unresolved row member refuses all targets and preserves the resolvable transcript', () => {
  const r = rig();
  try {
    const file = path.join(r.folder, 'a.jsonl');
    fs.writeFileSync(file, '{}\n');
    for (const members of [['b'], ['../invalid']]) {
      const out = resolveRowDeletionTargets(r.projects, 'a', members, () => path.basename(r.folder));
      assert.equal(out.ok, false);
      assert.match(out.error, /part/);
      assert.deepEqual(out.targets, []);
      assert.equal(fs.existsSync(file), true);
    }
  } finally { r.cleanup(); }
});

test('row deletion refuses a folder lookup error and keeps a single placeholder dismissable', () => {
  const r = rig();
  try {
    const refused = resolveRowDeletionTargets(r.projects, 'a', ['b'], () => { throw new Error('cache unavailable'); });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /cache unavailable/);
    assert.deepEqual(refused.targets, []);
    const placeholder = resolveRowDeletionTargets(r.projects, 'a', [], () => null);
    assert.equal(placeholder.ok, true);
    assert.equal(placeholder.parts, 1);
    assert.deepEqual(placeholder.targets, []);
  } finally { r.cleanup(); }
});

test('one escaping member or subagent directory refuses the entire row', () => {
  for (const suffix of ['b.jsonl', 'b']) {
    const r = rig();
    try {
      const a = path.join(r.folder, 'a.jsonl');
      fs.writeFileSync(a, '{}\n');
      fs.writeFileSync(path.join(r.folder, 'b.jsonl'), '{}\n');
      const outside = path.join(r.root, 'outside');
      fs.mkdirSync(outside);
      const link = path.join(r.folder, suffix);
      if (suffix === 'b.jsonl') fs.unlinkSync(link);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      const out = resolveRowDeletionTargets(r.projects, 'a', ['b'], () => path.basename(r.folder));
      assert.equal(out.ok, false);
      assert.deepEqual(out.targets, []);
      assert.equal(out.refused.length, 1);
      assert.equal(fs.existsSync(a), true);
      assert.equal(fs.existsSync(outside), true);
    } finally { r.cleanup(); }
  }
});

test('row fallback scan ignores ordinary files beside project folders and permits a placeholder', () => {
  const r = rig();
  const lstat = fs.lstatSync;
  try {
    const ordinary = path.join(r.projects, 'not-a-project');
    fs.writeFileSync(ordinary, 'unrelated');
    fs.lstatSync = (file, ...args) => {
      if (file.startsWith(ordinary + path.sep)) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return lstat(file, ...args);
    };
    const out = resolveRowDeletionTargets(r.projects, 'placeholder', [], () => null);
    assert.equal(out.ok, true);
    assert.deepEqual(out.targets, []);
  } finally { fs.lstatSync = lstat; r.cleanup(); }
});
