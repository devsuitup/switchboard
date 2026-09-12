'use strict';

// Parser for `git status --porcelain=v2 --branch` + `git diff --numstat`,
// plus the merge into the Changes panel's model. See issue #251 and
// .ai/contexts/ipc-bridge.md ("Changes panel").
//
// Each test below is written so that the specific distinction it names is
// load-bearing: collapsing staged/unstaged into one boolean, or treating a
// rename as a plain add+delete pair, turns the corresponding assertion red.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStatusPorcelainV2, parseNumstat, mergeChanges } = require('../git-changes');

// --- parseStatusPorcelainV2 --------------------------------------------

test('branch header: head, upstream, ahead/behind', () => {
  const text = [
    '# branch.oid abc123',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
  ].join('\n');
  const { branch } = parseStatusPorcelainV2(text);
  assert.deepEqual(branch, { head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
});

test('branch header: detached HEAD reports head:null, no upstream defaults to null/0', () => {
  const text = '# branch.head (detached)';
  const { branch } = parseStatusPorcelainV2(text);
  assert.deepEqual(branch, { head: null, upstream: null, ahead: 0, behind: 0 });
});

test('ordinary entry: staged and unstaged are independent booleans (mutation target: collapsing XY to one flag)', () => {
  const { files } = parseStatusPorcelainV2([
    '1 M. N... 100644 100644 100644 abc123 def456 staged-only.js',
    '1 .M N... 100644 100644 100644 abc123 def456 unstaged-only.js',
    '1 MM N... 100644 100644 100644 abc123 def456 both.js',
  ].join('\n'));

  const byPath = Object.fromEntries(files.map(f => [f.path, f]));
  assert.deepEqual(
    { staged: byPath['staged-only.js'].staged, unstaged: byPath['staged-only.js'].unstaged },
    { staged: true, unstaged: false },
  );
  assert.deepEqual(
    { staged: byPath['unstaged-only.js'].staged, unstaged: byPath['unstaged-only.js'].unstaged },
    { staged: false, unstaged: true },
  );
  assert.deepEqual(
    { staged: byPath['both.js'].staged, unstaged: byPath['both.js'].unstaged },
    { staged: true, unstaged: true },
    'a file modified in both the index and the worktree must report both flags true, not collapse to one',
  );
});

test('ordinary entry: state reflects the staged code when present, else the unstaged code', () => {
  const { files } = parseStatusPorcelainV2([
    '1 A. N... 000000 100644 100644 0000000 abc1234 added.js',
    '1 .D N... 100644 100644 000000 abc1234 0000000 deleted.js',
  ].join('\n'));
  const byPath = Object.fromEntries(files.map(f => [f.path, f]));
  assert.equal(byPath['added.js'].state, 'A');
  assert.equal(byPath['deleted.js'].state, 'D');
});

test('untracked entry: marked untracked, not staged/unstaged, state "?" (mutation target: dropping the untracked flag)', () => {
  const { files } = parseStatusPorcelainV2('? new-file.js');
  assert.equal(files.length, 1);
  assert.deepEqual(files[0], {
    path: 'new-file.js', origPath: null, staged: false, unstaged: false, untracked: true, renamed: false, state: '?',
  });
});

test('ignored entries are dropped, not surfaced as files', () => {
  const { files } = parseStatusPorcelainV2('! ignored/build-output.js');
  assert.deepEqual(files, []);
});

test('rename entry: renamed:true and origPath carried through (mutation target: dropping rename handling)', () => {
  const { files } = parseStatusPorcelainV2(
    '2 R. N... 100644 100644 100644 abc1234 def5678 R100 new/path.js\told/path.js'
  );
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.renamed, true);
  assert.equal(f.path, 'new/path.js');
  assert.equal(f.origPath, 'old/path.js');
  assert.equal(f.state, 'R');
});

test('rename entry without renamed handling would collapse to a bare path with no origPath — pinned distinctly from an ordinary entry', () => {
  const renamed = parseStatusPorcelainV2(
    '2 R. N... 100644 100644 100644 abc1234 def5678 R100 b.js\ta.js'
  ).files[0];
  const ordinary = parseStatusPorcelainV2(
    '1 M. N... 100644 100644 100644 abc1234 def5678 b.js'
  ).files[0];
  assert.notEqual(renamed.renamed, ordinary.renamed, 'a rename record must be distinguishable from an ordinary modify');
  assert.ok(renamed.origPath && !ordinary.origPath);
});

test('copy entry (score C): renamed:true, state "C"', () => {
  const f = parseStatusPorcelainV2(
    '2 C. N... 100644 100644 100644 abc1234 def5678 C90 copy.js\tsource.js'
  ).files[0];
  assert.equal(f.renamed, true);
  assert.equal(f.state, 'C');
  assert.equal(f.origPath, 'source.js');
});

test('unmerged entry: staged and unstaged both true, state carries a letter', () => {
  const f = parseStatusPorcelainV2(
    'u UU N... 100644 100644 100644 100644 abc1 def2 ghi3 conflict.js'
  ).files[0];
  assert.equal(f.staged, true);
  assert.equal(f.unstaged, true);
  assert.equal(f.state, 'U');
});

test('unknown/future record types are skipped without throwing', () => {
  assert.doesNotThrow(() => {
    const { files } = parseStatusPorcelainV2('x SOMETHING new-record-type\n? real.js');
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'real.js');
  });
});

test('empty input produces an empty, well-formed result', () => {
  assert.deepEqual(parseStatusPorcelainV2(''), {
    branch: { head: null, upstream: null, ahead: 0, behind: 0 }, files: [],
  });
  assert.deepEqual(parseStatusPorcelainV2(null), {
    branch: { head: null, upstream: null, ahead: 0, behind: 0 }, files: [],
  });
});

// --- parseNumstat --------------------------------------------------------

test('numstat: plain added/deleted counts keyed by path', () => {
  const result = parseNumstat('3\t1\tfoo.js\n0\t5\tbar.js\n');
  assert.deepEqual(result, { 'foo.js': { added: 3, deleted: 1 }, 'bar.js': { added: 0, deleted: 5 } });
});

test('numstat: binary file reports null, not 0 (mutation target: treating "-" as zero)', () => {
  const result = parseNumstat('-\t-\timage.png\n');
  assert.deepEqual(result, { 'image.png': { added: null, deleted: null } });
});

test('numstat: a full rename ("old => new") is keyed on the new path', () => {
  const result = parseNumstat('2\t1\told/name.js => new/name.js\n');
  assert.deepEqual(result, { 'new/name.js': { added: 2, deleted: 1 } });
});

test('numstat: a partial common-directory rename ("prefix/{old => new}/suffix") resolves to the new path', () => {
  const result = parseNumstat('4\t0\tsrc/{old => new}/file.js\n');
  assert.deepEqual(result, { 'src/new/file.js': { added: 4, deleted: 0 } });
});

test('numstat: blank lines and malformed lines are ignored, not throwing', () => {
  assert.doesNotThrow(() => {
    const result = parseNumstat('\n\nnot a numstat line\n2\t1\tok.js\n');
    assert.deepEqual(result, { 'ok.js': { added: 2, deleted: 1 } });
  });
});

// --- mergeChanges ---------------------------------------------------------

test('mergeChanges: a staged-only file gets its counts from the staged numstat map', () => {
  const status = { branch: { head: 'main', upstream: null, ahead: 0, behind: 0 }, files: [
    { path: 'a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M' },
  ] };
  const merged = mergeChanges(status, { 'a.js': { added: 5, deleted: 2 } }, {});
  assert.deepEqual(merged.files[0], { path: 'a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M', added: 5, deleted: 2 });
  assert.deepEqual(merged.totals, { files: 1, added: 5, deleted: 2 });
});

test('mergeChanges: a file modified in both index and worktree sums both numstat entries (mutation target: only reading one map)', () => {
  const status = { branch: { head: 'main', upstream: null, ahead: 0, behind: 0 }, files: [
    { path: 'both.js', origPath: null, staged: true, unstaged: true, untracked: false, renamed: false, state: 'M' },
  ] };
  const merged = mergeChanges(status, { 'both.js': { added: 3, deleted: 1 } }, { 'both.js': { added: 2, deleted: 4 } });
  assert.equal(merged.files[0].added, 5, 'staged (3) + unstaged (2) added lines');
  assert.equal(merged.files[0].deleted, 5, 'staged (1) + unstaged (4) deleted lines');
});

test('mergeChanges: an untracked file carries null counts, not zero — git diff never reports it', () => {
  const status = { branch: { head: 'main', upstream: null, ahead: 0, behind: 0 }, files: [
    { path: 'new.js', origPath: null, staged: false, unstaged: false, untracked: true, renamed: false, state: '?' },
  ] };
  const merged = mergeChanges(status, {}, {});
  assert.equal(merged.files[0].added, null);
  assert.equal(merged.files[0].deleted, null);
  assert.deepEqual(merged.totals, { files: 1, added: 0, deleted: 0 }, 'totals only sum known counts');
});

test('mergeChanges: a binary file (null in both maps) stays null after combining, not coerced to 0', () => {
  const status = { branch: { head: 'main', upstream: null, ahead: 0, behind: 0 }, files: [
    { path: 'img.png', origPath: null, staged: false, unstaged: true, untracked: false, renamed: false, state: 'M' },
  ] };
  const merged = mergeChanges(status, {}, { 'img.png': { added: null, deleted: null } });
  assert.equal(merged.files[0].added, null);
  assert.equal(merged.files[0].deleted, null);
});

test('mergeChanges: totals sum added/deleted across all files and count files', () => {
  const status = { branch: { head: 'main', upstream: null, ahead: 0, behind: 0 }, files: [
    { path: 'a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M' },
    { path: 'b.js', origPath: null, staged: false, unstaged: true, untracked: false, renamed: false, state: 'M' },
  ] };
  const merged = mergeChanges(status, { 'a.js': { added: 1, deleted: 1 } }, { 'b.js': { added: 4, deleted: 0 } });
  assert.deepEqual(merged.totals, { files: 2, added: 5, deleted: 1 });
});

test('mergeChanges: branch pass-through defaults when status is missing', () => {
  const merged = mergeChanges(null, {}, {});
  assert.deepEqual(merged.branch, { head: null, upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(merged.files, []);
  assert.deepEqual(merged.totals, { files: 0, added: 0, deleted: 0 });
});
