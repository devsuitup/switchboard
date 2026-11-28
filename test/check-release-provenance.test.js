'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const provenance = require('../scripts/check-release-provenance');
const { checkTagProvenance, checkReleaseProvenance } = provenance;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-release-provenance.js');
const source = fs.readFileSync(SCRIPT, 'utf8');
const SHA = 'a'.repeat(40);
const ORIGIN = 'b'.repeat(40);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const mergeHelp = (() => {
  try { return execFileSync('git', ['merge-tree', '-h'], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (err) { return String(err.stdout || '') + String(err.stderr || ''); }
})();
const mergeOptions = { skip: !mergeHelp.includes('--write-tree') && 'Git >= 2.38 required: merge-tree --write-tree unsupported' };

function tagCheck(branches) {
  return checkTagProvenance({
    tag: 'v1.2.0-beta.1',
    resolveTag: () => SHA,
    containingBranches: () => branches,
  });
}

for (const branches of [[], ['refs/remotes/origin/main'], ['refs/heads/release/1.2'],
  ['refs/remotes/upstream/release/1.2'], ['refs/remotes/origin/release-other/1.2']]) {
  test('tag rejects branches outside origin/release/*: ' + JSON.stringify(branches), () => {
    const result = tagCheck(branches);
    assert.equal(result.ok, false, 'tag must be reachable from origin/release/*');
    assert.match(result.message, /release\/\*/);
    assert.match(result.message, /docs\/releasing\.md/);
    assert.match(result.message, new RegExp(SHA));
  });
}

test('tag accepts membership of any remote release branch', () => {
  const result = tagCheck(['refs/remotes/origin/main', 'refs/remotes/origin/release/1.2']);
  assert.equal(result.ok, true, result.message);
});

function prCheck(overrides = {}, onMain = [], readers = {}) {
  const commit = { sha: SHA, parents: [ORIGIN], files: ['src/fix.js'], message: 'fix: release only', ...overrides };
  return checkReleaseProvenance({
    base: 'release/1.2', head: SHA,
    listCommits: () => [SHA],
    readCommit: () => commit,
    isOnMain: sha => onMain.includes(sha),
    readFileAt: () => JSON.stringify({ version: '1.2.0' }),
    mergeTree: () => ({ tree: 'automatic-tree', conflicts: [] }),
    diffFiles: () => [],
    patchId: () => 'same-patch',
    ...readers,
  });
}

for (const [name, change] of [
  ['unported code', {}],
  ['bump mixed with code', { files: ['package.json', 'src/fix.js'] }],
  ['nested package file', { files: ['sub/package.json'] }],
  ['empty commit', { files: [] }],
  ['trailer without reachable source', { message: '(cherry picked from commit ' + ORIGIN + ')' }],
  ['malformed trailer', { message: '(cherry picked from commit origin/main)' }],
  ['inline trailer', { message: 'example: (cherry picked from commit ' + ORIGIN + ')' }],
]) {
  test('PR rejects ' + name, () => {
    const result = prCheck(change);
    assert.equal(result.ok, false, name);
    assert.match(result.message, new RegExp(SHA));
    assert.match(result.message, /main/);
    assert.match(result.message, /cherry-pick -x/);
  });
}

for (const [name, change, onMain] of [
  ['commit on main', {}, [SHA]],
  ['merge commit', { parents: [SHA, ORIGIN] }, []],
  ['bump', { files: ['CHANGELOG.md', 'package.json', 'package-lock.json'] }, []],
  ['changelog only', { files: ['CHANGELOG.md'] }, []],
  ['ported fix', { message: 'fix: backport\n\n(cherry picked from commit ' + ORIGIN + ')\n' }, [ORIGIN]],
  ['CRLF trailer', { message: 'fix\r\n\r\n(cherry picked from commit ' + ORIGIN + ')\r\n' }, [ORIGIN]],
]) {
  test('PR accepts ' + name, () => {
    const result = prCheck(change, onMain);
    assert.equal(result.ok, true, result.message);
  });
}

test('PR lists every offender and checks the entire base..head range', () => {
  const result = checkReleaseProvenance({
    base: 'release/1.2', head: 'head-sha',
    listCommits: (base, head) => {
      assert.equal(base, 'release/1.2');
      assert.equal(head, 'head-sha');
      return [SHA, ORIGIN];
    },
    isOnMain: () => false,
    readCommit: sha => ({ sha, parents: [SHA], files: ['fix.js'], message: 'offender ' + sha }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(SHA));
  assert.match(result.message, new RegExp(ORIGIN));
});

test('empty PR range passes', () => {
  assert.equal(checkReleaseProvenance({ base: 'release/1.2', head: SHA, listCommits: () => [] }).ok, true);
});

test('build job fetches release refs and checks provenance before publish', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '..', '.github/workflows/build.yml'), 'utf8'));
  const job = workflow.jobs['release-tag'];
  const fetch = job.steps.findIndex(s => s.run?.includes('+refs/heads/release/*:refs/remotes/origin/release/*'));
  assert.match(job.steps[fetch].run, /\+refs\/heads\/main:refs\/remotes\/origin\/main/);
  const extract = job.steps.findIndex(s => s.run === 'git show origin/main:scripts/check-release-provenance.js > "$RUNNER_TEMP/check-release-provenance.js"');
  assert.ok(extract > fetch, 'checker must be extracted from fetched main');
  const check = job.steps.findIndex(s => s.run === 'node "$RUNNER_TEMP/check-release-provenance.js" tag "$GITHUB_REF_NAME"');
  assert.ok(check > extract, 'tag must execute the trusted checker');
  assert.ok(fetch >= 0, 'release refs must be fetched explicitly');
  assert.ok(check > fetch, 'tag provenance must run after fetch');
  assert.ok(workflow.jobs.publish.needs.includes('release-tag'));
});

test('PR workflow checks the actual head against the fetched release base and main', () => {
  const file = path.join(__dirname, '..', '.github/workflows/release-provenance.yml');
  assert.ok(fs.existsSync(file), 'release-provenance workflow must exist');
  const workflow = yaml.load(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(workflow.on, { pull_request: { branches: ['release/*'] } });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const job = workflow.jobs['release-provenance'];
  assert.ok(job);
  assert.equal(job['timeout-minutes'], 10);
  const checkout = job.steps.find(s => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  const fetch = job.steps.findIndex(s => s.run?.includes('+refs/heads/main:refs/remotes/origin/main'));
  assert.ok(fetch >= 0);
  assert.match(job.steps[fetch].run, /\+refs\/heads\/release\/\*:refs\/remotes\/origin\/release\/\*/);
  const extract = job.steps.findIndex(s => s.run === 'git show origin/main:scripts/check-release-provenance.js > "$RUNNER_TEMP/check-release-provenance.js"');
  assert.ok(extract > fetch, 'checker must be extracted from fetched main');
  const check = job.steps.findIndex(s => s.run === 'node "$RUNNER_TEMP/check-release-provenance.js" pr "$BASE_BRANCH" "$HEAD_SHA"');
  assert.ok(check > extract, 'PR must execute the trusted checker');
  assert.ok(check > fetch);
  assert.equal(job.steps[check].env.BASE_BRANCH, '$' + '{{ github.base_ref }}');
  assert.equal(job.steps[check].env.HEAD_SHA, '$' + '{{ github.event.pull_request.head.sha }}');
  assert.equal(job['continue-on-error'], undefined);
  for (const step of job.steps) assert.equal(step['continue-on-error'], undefined);
});

function repoFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-provenance-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|HUSKY)/i.test(k)));
  const env = { ...inherited, HOME: dir, USERPROFILE: dir, SWITCHBOARD_DATA_DIR: path.join(dir, 'data'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'no-git-config'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (file, text, message) => {
    fs.writeFileSync(path.join(dir, file), text);
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.0', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.2.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.2.0' }, 'node_modules/example': { version: '1.0.0' } } }));
  const base = commit('base.txt', 'base', 'base');
  git('update-ref', 'refs/remotes/origin/release/1.2', base);
  git('update-ref', 'refs/remotes/origin/main', base);
  assert.equal(typeof provenance.createGitReaders, 'function', 'real Git readers must be exported');
  const readers = provenance.createGitReaders({ cwd: dir, env });
  return { dir, env, git, commit, base, readers };
}

test('real Git: annotated ancestor tag accepted; off-release tag rejected', t => {
  const repo = repoFixture(t);
  repo.git('tag', '-a', 'v1.2.0-beta.1', '-m', 'beta');
  const tip = repo.commit('bump.txt', 'next', 'next');
  repo.git('update-ref', 'refs/remotes/origin/release/1.2', tip);
  assert.equal(checkTagProvenance({ tag: 'v1.2.0-beta.1', ...repo.readers }).ok, true);
  repo.git('checkout', '-qb', 'unreleased', repo.base);
  repo.commit('unreleased.txt', 'code', 'unreleased');
  repo.git('tag', 'v1.3.0');
  const result = checkTagProvenance({ tag: 'v1.3.0', ...repo.readers });
  assert.equal(result.ok, false, result.message);
});

test('real Git: -x backport passes; unported commits hidden by a merge are listed', mergeOptions, t => {
  const repo = repoFixture(t);
  const original = repo.commit('fix.txt', 'fixed', 'fix on main');
  repo.git('update-ref', 'refs/remotes/origin/main', original);
  repo.git('checkout', '-qb', 'backport', repo.base);
  repo.commit('CHANGELOG.md', 'bump', 'bump');
  repo.git('cherry-pick', '-x', original);
  const check = () => checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(check().ok, true, check().message);
  repo.git('checkout', '-qb', 'side');
  const bad = repo.commit('bad.txt', 'release only', 'unported side commit');
  repo.git('checkout', 'backport');
  repo.commit('CHANGELOG.md', 'next bump', 'bump');
  repo.git('merge', '--no-ff', 'side', '-m', 'merge side');
  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(bad));
  assert.doesNotMatch(result.message, /  [a-f0-9]+ merge side/);
});

test('real Git: renaming code into an allowed bump file is rejected', t => {
  const repo = repoFixture(t);
  repo.git('mv', 'base.txt', 'CHANGELOG.md');
  repo.git('commit', '-qm', 'disguise deletion as bump');
  const result = checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(result.ok, false);
});

test('real Git: unknown cherry-pick source is rejected and missing main fails closed', t => {
  const repo = repoFixture(t);
  repo.commit('fix.txt', 'fix', '(cherry picked from commit ' + SHA + ')');
  const check = () => checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(check().ok, false);
  repo.git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.throws(check);
});


function bumpPackage(repo, file, change) {
  const value = JSON.parse(fs.readFileSync(path.join(repo.dir, file), 'utf8'));
  change(value);
  return repo.commit(file, JSON.stringify(value), 'chore(release): bump');
}

for (const [name, file, change] of [
  ['package script', 'package.json', value => { value.scripts.postinstall = 'node unreviewed.js'; }],
  ['package dependency', 'package.json', value => { value.dependencies = { example: '2.0.0' }; }],
  ['lock dependency', 'package-lock.json', value => { value.packages['node_modules/example'].version = '2.0.0'; }],
  ['lock root dependency', 'package-lock.json', value => { value.packages[''].dependencies = { example: '2.0.0' }; }],
]) {
  test('real Git: bump changing ' + name + ' is rejected', t => {
    const repo = repoFixture(t);
    const bad = bumpPackage(repo, file, value => { value.version = '1.2.1'; change(value); });
    const result = checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
    assert.equal(result.ok, false, name + ' must not qualify as a version-only bump');
    assert.match(result.message, new RegExp(bad));
  });
}

function mergedReleaseFixture(t, withCode) {
  const repo = repoFixture(t);
  repo.git('checkout', '-qb', 'release/1.2');
  repo.git('checkout', '-qb', 'previous-bump');
  bumpPackage(repo, 'package.json', value => { value.version = '1.2.1'; });
  repo.git('checkout', 'release/1.2');
  repo.git('merge', '--no-ff', 'previous-bump', '-m', 'Merge previous release bump');
  const releaseTip = repo.git('rev-parse', 'HEAD');
  repo.git('update-ref', 'refs/remotes/origin/release/1.2', releaseTip);
  repo.git('checkout', '-qb', 'bump/next', repo.base);
  repo.commit('CHANGELOG.md', 'next release notes', 'prepare changelog');
  repo.git('merge', '--no-ff', 'release/1.2', '-m', 'Merge release/1.2 into bump/next');
  let bad;
  if (withCode) {
    repo.git('checkout', '-qb', 'unported-side');
    bad = repo.commit('fix.js', 'unported code', 'release-only code');
    repo.git('checkout', 'bump/next');
    repo.git('merge', '--no-ff', 'unported-side', '-m', 'Merge unported side');
  }
  bumpPackage(repo, 'package.json', value => { value.version = '1.2.2'; });
  bumpPackage(repo, 'package-lock.json', value => {
    value.version = '1.2.2';
    value.packages[''].version = '1.2.2';
  });
  return { ...repo, bad };
}

test('real Git: #1312 release-only bump and merge base merged into a bump head passes', mergeOptions, t => {
  const repo = mergedReleaseFixture(t, false);
  const result = checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(result.ok, true, result.message);
});

test('real Git: #1312 topology rejects non-bump code brought by a head merge', mergeOptions, t => {
  const repo = mergedReleaseFixture(t, true);
  const result = checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(result.ok, false, 'merged non-bump code must still be checked');
  assert.match(result.message, new RegExp(repo.bad));
});

function cli(args, git) {
  const mod = { exports: {} };
  const output = [];
  const req = name => name === 'node:child_process' ? { execFileSync: git } : require(name);
  req.main = mod;
  const proc = { argv: ['node', SCRIPT, ...args], exitCode: undefined };
  vm.runInNewContext(source, { require: req, module: mod, process: proc,
    console: { log: s => output.push(s), error: s => output.push(s) } }, { filename: SCRIPT });
  return { code: proc.exitCode, out: output.join('\n') };
}

test('CLI rejects invalid usage without running Git', () => {
  for (const args of [[], ['tag'], ['pr', 'release/1.2'], ['unknown'], ['pr', 'main', SHA]]) {
    const result = cli(args, () => assert.fail('unexpected Git'));
    assert.equal(result.code, 2);
    assert.match(result.out, /usage/);
  }
});

test('CLI reports tag failure, success and Git errors with distinct exit codes', () => {
  const git = (branches) => (_exe, args) => args[0] === 'rev-parse' ? SHA + '\n' : branches;
  const fail = cli(['tag', 'v1.2.0'], git(''));
  assert.equal(fail.code, 1);
  assert.match(fail.out, /::error::.*release\/\*/);
  assert.equal(cli(['tag', 'v1.2.0'], git('refs/remotes/origin/release/1.2\n')).code, 0);
  const error = cli(['tag', 'missing'], () => { throw new Error('Git unavailable'); });
  assert.equal(error.code, 2);
  assert.match(error.out, /Git unavailable/);
});

test('real Git: a file larger than one MiB is read whole', t => {
  const repo = repoFixture(t);
  const sha = repo.commit('big.txt', 'x'.repeat(2 * 1024 * 1024), 'big file');
  let content;
  assert.doesNotThrow(() => { content = repo.readers.readFileAt(sha, 'big.txt'); }, 'git output above the 1 MiB default buffer is read');
  assert.equal(content.length, 2 * 1024 * 1024);
});

function mergeCheck({ conflicts = [], files = [], parents = [ORIGIN, 'c'.repeat(40)], readFileAt } = {}) {
  return prCheck({ parents, message: 'Merge release/1.2 into bump/next' }, [], {
    mergeTree: (first, second) => {
      assert.deepEqual([first, second], parents);
      return { tree: 'automatic-tree', conflicts };
    },
    diffFiles: (before, after) => {
      assert.equal(before, 'automatic-tree');
      assert.equal(after, SHA);
      return files;
    },
    ...(readFileAt ? { readFileAt } : {}),
  });
}

test('PR rejects non-bump paths hand-resolved during a merge', () => {
  const result = mergeCheck({ conflicts: ['src/conflict.js'], files: ['src/conflict.js'] });
  assert.equal(result.ok, false, 'hand-resolved code must fail provenance');
  assert.match(result.message, /hand-resolved.*src\/conflict\.js/);
});

test('PR rejects code added to an otherwise automatic merge', () => {
  const result = mergeCheck({ files: ['src/sneaked.js'] });
  assert.equal(result.ok, false, 'merge-only code must fail provenance');
  assert.match(result.message, /src\/sneaked\.js/);
});

test('PR rejects octopus merges explicitly', () => {
  const result = mergeCheck({ parents: [ORIGIN, SHA, 'c'.repeat(40)] });
  assert.equal(result.ok, false, 'octopus must fail closed');
  assert.match(result.message, /octopus.*3 parents/i);
});

test('PR accepts #1312 merge resolved only in bump files and version fields', () => {
  const files = ['CHANGELOG.md', 'package.json', 'package-lock.json'];
  const result = mergeCheck({ conflicts: files, files, readFileAt: (ref, file) => {
    assert.notEqual(ref, 'automatic-tree', 'conflicted JSON contains markers, not valid JSON');
    return JSON.stringify({ name: 'app', version: ref, ...(file === 'package-lock.json' ? { packages: { '': { version: ref }, dep: { version: '1' } } } : {}) });
  } });
  assert.equal(result.ok, true, result.message);
});

test('PR accepts an automatic merge and a clean version-only merge edit', () => {
  assert.equal(mergeCheck().ok, true);
  assert.equal(mergeCheck({ files: ['package.json'], readFileAt: ref => JSON.stringify({ name: 'app', version: ref }) }).ok, true);
});

for (const conflicted of [false, true]) {
  for (const file of ['package.json', 'package-lock.json']) {
    test('PR rejects non-version merge edits in ' + file + ' (conflict=' + conflicted + ')', () => {
      const result = mergeCheck({ files: [file], conflicts: conflicted ? [file] : [], readFileAt: ref =>
        JSON.stringify({ version: ref, dependencies: { dep: ref === SHA ? '2' : '1' } }) });
      assert.equal(result.ok, false, 'package changes beyond version fields must fail');
      assert.ok(result.message.includes(file));
    });
  }
}

test('PR rejects a conflicted package resolution that drops a parent dependency', () => {
  const result = mergeCheck({ files: ['package.json'], conflicts: ['package.json'], readFileAt: ref =>
    JSON.stringify({ version: ref, dependencies: { dep: ref === ORIGIN ? '2' : '1' } }) });
  assert.equal(result.ok, false, 'both parents must agree outside version fields');
});

function cherryCheck(files, sourceFiles) {
  return prCheck({}, [ORIGIN], {
    readCommit: sha => ({ parents: [ORIGIN], files: sha === SHA ? files : sourceFiles,
      message: 'fix: backport\n\n(cherry picked from commit ' + ORIGIN + ')' }),
    patchId: sha => sha,
  });
}

test('PR rejects a mismatched -x trailer that introduces a file absent from its source', () => {
  const result = cherryCheck(['src/new.js'], ['src/original.js']);
  assert.equal(result.ok, false, 'unrelated trailer must fail provenance');
  assert.match(result.message, /trailer does not match its source/);
});

test('PR accepts an exact -x cherry-pick by stable patch ID', () => {
  const patches = [];
  const result = prCheck({ message: '(cherry picked from commit ' + ORIGIN + ')' }, [ORIGIN], {
    readCommit: sha => {
      assert.equal(sha, SHA, 'equal patch IDs do not need the source file set');
      return { parents: [ORIGIN], files: ['src/fix.js'], message: '(cherry picked from commit ' + ORIGIN + ')' };
    },
    patchId: sha => { patches.push(sha); return 'same-patch'; },
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(patches, [SHA, ORIGIN]);
});

test('PR accepts a conflict-resolved -x cherry-pick touching a subset of source files', () => {
  assert.equal(cherryCheck(['src/fix.js'], ['src/fix.js', 'CHANGELOG.md']).ok, true);
});

test('PR does not equate absent patch IDs', () => {
  const result = prCheck({}, [ORIGIN], {
    readCommit: sha => ({ parents: [ORIGIN], files: [sha + '.js'], message: '(cherry picked from commit ' + ORIGIN + ')' }),
    patchId: () => null,
  });
  assert.equal(result.ok, false, 'missing patch IDs must use the file-set fallback');
});

function fakeReaders(git) {
  const mod = { exports: {} };
  const req = name => name === 'node:child_process' ? { execFileSync: git } : require(name);
  vm.runInNewContext(source, { require: req, module: mod }, { filename: SCRIPT });
  return mod.exports.createGitReaders();
}

for (const conflicted of [false, true]) {
  test('Git reader parses NUL-delimited merge-tree output (conflict=' + conflicted + ')', () => {
    const readers = fakeReaders((_exe, args, options) => {
      assert.equal(options.maxBuffer, GIT_MAX_BUFFER);
      assert.deepEqual(Array.from(args), ['merge-tree', '--write-tree', '--name-only', '-z', SHA, ORIGIN]);
      const stdout = SHA + '\0' + (conflicted ? 'odd\nname.js\0package.json\0\0messages\0' : '');
      if (conflicted) throw Object.assign(new Error('conflict'), { status: 1, stdout });
      return stdout;
    });
    assert.equal(typeof readers.mergeTree, 'function', 'mergeTree reader must be exported');
    const result = readers.mergeTree(SHA, ORIGIN);
    assert.equal(result.tree, SHA);
    assert.deepEqual(Array.from(result.conflicts), conflicted ? ['odd\nname.js', 'package.json'] : []);
  });
}

test('Git merge reader propagates unsupported Git and rejects malformed output', () => {
  for (const action of [() => { throw Object.assign(new Error('unsupported'), { status: 129 }); }, () => 'invalid\0']) {
    const readers = fakeReaders(action);
    assert.equal(typeof readers.mergeTree, 'function', 'mergeTree reader must be exported');
    assert.throws(() => readers.mergeTree(SHA, ORIGIN));
  }
});

test('Git readers compare tree files without renames and pipe patches with the large buffer', () => {
  const calls = [];
  const readers = fakeReaders((_exe, args, options) => {
    assert.equal(options.maxBuffer, GIT_MAX_BUFFER);
    calls.push(Array.from(args));
    if (args[0] === 'diff-tree') {
      assert.ok(args.includes('--no-renames'));
      assert.ok(args.includes('-z'));
      return 'old.js\0new.js\0';
    }
    if (args[0] === 'show') {
      assert.ok(args.includes('--binary'));
      assert.ok(args.includes('--no-renames'));
      return 'patch bytes';
    }
    assert.deepEqual(Array.from(args), ['patch-id', '--stable']);
    assert.equal(options.input, 'patch bytes');
    return ORIGIN + ' ' + SHA + '\n';
  });
  assert.equal(typeof readers.diffFiles, 'function', 'diffFiles reader must be exported');
  assert.equal(typeof readers.patchId, 'function', 'patchId reader must be exported');
  assert.deepEqual(Array.from(readers.diffFiles(SHA, ORIGIN)), ['old.js', 'new.js']);
  assert.equal(readers.patchId(SHA), ORIGIN);
  assert.equal(calls.length, 3);
});

function conflictFixture(t, files) {
  const repo = repoFixture(t);
  for (const file of files) {
    if (file === 'CHANGELOG.md' || file === 'code.js') repo.commit(file, 'base\n', 'base content');
  }
  const base = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '-qb', 'release-side');
  for (const file of files) {
    if (file.endsWith('.json')) bumpPackage(repo, file, value => { value.version = '1.2.1'; if (value.packages) value.packages[''].version = '1.2.1'; });
    else repo.commit(file, 'release side\n', 'release side');
  }
  const release = repo.git('rev-parse', 'HEAD');
  repo.git('update-ref', 'refs/remotes/origin/release/1.2', release);
  repo.git('checkout', '-qb', 'bump-side', base);
  for (const file of files) {
    if (file.endsWith('.json')) bumpPackage(repo, file, value => { value.version = '1.2.2'; if (value.packages) value.packages[''].version = '1.2.2'; });
    else repo.commit(file, 'bump side\n', 'main content');
  }
  const main = repo.git('rev-parse', 'HEAD');
  repo.git('update-ref', 'refs/remotes/origin/main', main);
  assert.throws(() => repo.git('merge', '--no-ff', 'release-side', '-m', 'Merge release into bump'));
  for (const file of files) repo.git('checkout', '--ours', '--', file);
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'Merge release into bump');
  return { ...repo, main, release };
}

test('real Git: merge resolution in code fails and identifies the path', mergeOptions, t => {
  const repo = conflictFixture(t, ['code.js']);
  const automatic = repo.readers.mergeTree(repo.main, repo.release);
  assert.deepEqual(automatic.conflicts, ['code.js']);
  const result = checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(result.ok, false, 'hand-resolved code must fail provenance');
  assert.match(result.message, /hand-resolved.*code\.js/);
});

test('real Git: #1312 conflicts resolved in all three bump files pass', mergeOptions, t => {
  const repo = conflictFixture(t, ['CHANGELOG.md', 'package.json', 'package-lock.json']);
  const result = checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(result.ok, true, result.message);
});

test('real Git: exact -x patch, resolved subset and unrelated file are distinguished', mergeOptions, t => {
  const repo = repoFixture(t);
  fs.writeFileSync(path.join(repo.dir, 'second.txt'), 'original\n');
  const original = repo.commit('fix.txt', 'original\n', 'fix on main');
  repo.git('update-ref', 'refs/remotes/origin/main', original);
  repo.git('checkout', '-qb', 'backport', repo.base);
  repo.commit('CHANGELOG.md', 'bump\n', 'bump');
  repo.git('cherry-pick', '-x', original);
  const exact = repo.git('rev-parse', 'HEAD');
  assert.equal(repo.readers.patchId(exact), repo.readers.patchId(original));
  const check = () => checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(check().ok, true);
  repo.git('checkout', '-qb', 'resolved', repo.base);
  const resolved = repo.commit('fix.txt', 'adapted to release\n', '(cherry picked from commit ' + original + ')');
  assert.notEqual(repo.readers.patchId(resolved), repo.readers.patchId(original));
  assert.equal(check().ok, true, 'source file subset is allowed');
  repo.commit('unrelated.txt', 'invented\n', '(cherry picked from commit ' + original + ')');
  const result = check();
  assert.equal(result.ok, false, 'unrelated trailer must fail provenance');
  assert.match(result.message, /trailer does not match its source/);
});
