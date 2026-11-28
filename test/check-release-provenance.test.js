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

function prCheck(overrides = {}, onMain = []) {
  const commit = { sha: SHA, parents: [ORIGIN], files: ['src/fix.js'], message: 'fix: release only', ...overrides };
  return checkReleaseProvenance({
    base: 'release/1.2', head: SHA,
    listCommits: () => [SHA],
    readCommit: () => commit,
    isOnMain: sha => onMain.includes(sha),
    readFileAt: () => JSON.stringify({ version: '1.2.0' }),
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
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

test('real Git: -x backport passes; unported commits hidden by a merge are listed', t => {
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

test('real Git: #1312 release-only bump and merge base merged into a bump head passes', t => {
  const repo = mergedReleaseFixture(t, false);
  const result = checkReleaseProvenance({ base: 'release/1.2', head: 'HEAD', ...repo.readers });
  assert.equal(result.ok, true, result.message);
});

test('real Git: #1312 topology rejects non-bump code brought by a head merge', t => {
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
  assert.equal(repo.readers.readFileAt(sha, 'big.txt').length, 2 * 1024 * 1024);
});
