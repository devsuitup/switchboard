// The CI check that a PR changing the app carries a CHANGELOG.md entry — see docs/changelog.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const { isAppPath, checkChangelog, parseLabels } = require('../scripts/check-changelog');

test('app code is what electron-builder ships: root scripts, public/, workers/, the sandbox wrapper', () => {
  for (const file of ['main.js', 'preload.js', 'git-changes.js', 'public/app.js', 'public/style.css',
    'public/index.html', 'workers/search-worker.js', 'scripts/claude-sandbox.sh']) {
    assert.equal(isAppPath(file), true, file);
  }
});

test('tests, docs, CI, tooling and nested scripts are not app code', () => {
  for (const file of ['test/changelog.test.js', 'docs/releasing.md', 'README.md', '.github/workflows/test.yml',
    'eslint.config.js', 'scripts/run-tests.js', 'package-lock.json', '.ai/shared-guidelines.md',
    'test/fixtures/main.js', 'CHANGELOG.md']) {
    assert.equal(isAppPath(file), false, file);
  }
});

test('a PR changing app code without CHANGELOG.md fails, naming the files', () => {
  const result = checkChangelog({ files: ['main.js', 'test/x.test.js'], labels: [] });
  assert.equal(result.ok, false);
  assert.match(result.message, /main\.js/);
  assert.doesNotMatch(result.message, /x\.test\.js/);
  assert.match(result.message, /no-changelog/);
});

test('a PR changing app code and CHANGELOG.md passes', () => {
  assert.equal(checkChangelog({ files: ['main.js', 'CHANGELOG.md'], labels: [] }).ok, true);
});

test('a PR changing app code without CHANGELOG.md passes with the no-changelog label', () => {
  assert.equal(checkChangelog({ files: ['public/app.js'], labels: ['bug', 'no-changelog'] }).ok, true);
});

test('another label does not waive the entry', () => {
  assert.equal(checkChangelog({ files: ['public/app.js'], labels: ['changelog', 'no-changelog-please'] }).ok, false);
});

test('a PR that changes no app code passes without an entry', () => {
  assert.equal(checkChangelog({ files: ['docs/releasing.md', 'test/a.test.js'], labels: [] }).ok, true);
  assert.equal(checkChangelog({ files: [], labels: [] }).ok, true);
});

test('labels come from a JSON array of names, or from nothing', () => {
  assert.deepEqual(parseLabels('["no-changelog","bug"]'), ['no-changelog', 'bug']);
  assert.deepEqual(parseLabels(''), []);
  assert.deepEqual(parseLabels(undefined), []);
});

test('labels that are not a JSON array of names are an error, not an empty list', () => {
  assert.throws(() => parseLabels('no-changelog'), /PR_LABELS/);
  assert.throws(() => parseLabels('{"name":"no-changelog"}'), /PR_LABELS/);
  assert.throws(() => parseLabels('[1]'), /PR_LABELS/);
});

test('the test workflow only invokes the script, with the PR base and head SHAs and the PR to read labels from', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');
  const start = workflow.indexOf('\n  changelog:');
  assert.notEqual(start, -1, 'test.yml must carry a changelog job');
  const job = workflow.slice(start, workflow.indexOf('\n  test:', start));
  assert.match(job, /if: github\.event_name == 'pull_request'/);
  assert.match(job, /fetch-depth: 0/);
  assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  const run = job.match(/run: (.*)/)[1];
  assert.equal(run, 'node scripts/check-changelog.js'
    + ' --base "${{ github.event.pull_request.base.sha }}"'
    + ' --head "${{ github.event.pull_request.head.sha }}"'
    + ' --repo "${{ github.repository }}"'
    + ' --pr "${{ github.event.pull_request.number }}"');
});

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-changelog.js');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C',
};

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-changelog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('HUSKY')));
  const env = { ...inherited, ...GIT_ENV, HOME: dir };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) write(file, text);
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  const base = commit({ 'main.js': 'a\n', 'docs/a.md': 'a\n', 'CHANGELOG.md': '# Changelog\n' }, 'base');
  git('checkout', '-q', '-b', 'pr');
  return { dir, env, git, commit, base };
}

function check(repo, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo.dir, env: { ...repo.env, ...extraEnv }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('end to end: an app change without an entry fails and names the file', (t) => {
  const repo = makeRepo(t);
  const head = repo.commit({ 'main.js': 'b\n' }, 'app');
  const r = check(repo, ['--base', repo.base, '--head', head, '--labels', '[]']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /main\.js/);
});

test('end to end: an app change with an entry passes', (t) => {
  const repo = makeRepo(t);
  const head = repo.commit({ 'main.js': 'b\n', 'CHANGELOG.md': '# Changelog\n\n- x\n' }, 'app');
  assert.equal(check(repo, ['--base', repo.base, '--head', head, '--labels', '[]']).status, 0);
});

test('end to end: an app change with the no-changelog label passes', (t) => {
  const repo = makeRepo(t);
  const head = repo.commit({ 'main.js': 'b\n' }, 'app');
  assert.equal(check(repo, ['--base', repo.base, '--head', head, '--labels', '["no-changelog"]']).status, 0);
});

test('end to end: moving an app file out of the app is an app change, not a rename to hide', (t) => {
  const repo = makeRepo(t);
  repo.commit({ 'public/foo.js': 'const foo = 1;\n'.repeat(20) }, 'add foo');
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--ff-only', 'pr');
  const base = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '-q', 'pr');
  repo.git('mv', 'public/foo.js', 'docs/foo.js');
  repo.git('commit', '-qm', 'move');
  const head = repo.git('rev-parse', 'HEAD');
  const r = check(repo, ['--base', base, '--head', head, '--labels', '[]']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /public\/foo\.js/);
});

test('end to end: a docs-only change passes', (t) => {
  const repo = makeRepo(t);
  const head = repo.commit({ 'docs/a.md': 'b\n' }, 'docs');
  assert.equal(check(repo, ['--base', repo.base, '--head', head, '--labels', '[]']).status, 0);
});

test('end to end: a PR is judged on all its commits, not the last one', (t) => {
  const repo = makeRepo(t);
  repo.commit({ 'main.js': 'b\n' }, 'app');
  const head = repo.commit({ 'docs/a.md': 'b\n' }, 'docs');
  const r = check(repo, ['--base', repo.base, '--head', head, '--labels', '[]']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /main\.js/);
});

test('end to end: app changes merged in from main are not the PR\'s', (t) => {
  const repo = makeRepo(t);
  repo.commit({ 'docs/a.md': 'b\n' }, 'docs');
  repo.git('checkout', '-q', 'main');
  const mainTip = repo.commit({ 'main.js': 'from main\n' }, 'main moves on');
  repo.git('checkout', '-q', 'pr');
  repo.git('merge', '-q', '--no-edit', 'main');
  const head = repo.git('rev-parse', 'HEAD');
  const r = check(repo, ['--base', mainTip, '--head', head, '--labels', '[]']);
  assert.equal(r.status, 0, r.out);
});

test('end to end: app changes on main since the PR branched are not the PR\'s', (t) => {
  const repo = makeRepo(t);
  const head = repo.commit({ 'docs/a.md': 'b\n' }, 'docs');
  repo.git('checkout', '-q', 'main');
  const mainTip = repo.commit({ 'main.js': 'from main\n' }, 'main moves on');
  const r = check(repo, ['--base', mainTip, '--head', head, '--labels', '[]']);
  assert.equal(r.status, 0, r.out);
});

test('end to end: a base the repository does not have is an error, not a pass', (t) => {
  const repo = makeRepo(t);
  const head = repo.commit({ 'main.js': 'b\n' }, 'app');
  const r = check(repo, ['--base', '0'.repeat(40), '--head', head, '--labels', '[]']);
  assert.equal(r.status, 2, r.out);
});

test('end to end: missing arguments are an error, not a pass', (t) => {
  const repo = makeRepo(t);
  for (const args of [[], ['--base', repo.base, '--labels', '[]'], ['--base', repo.base, '--head', repo.base], ['--base']]) {
    const r = check(repo, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.out, /^usage: check-changelog\.js/m, 'refused before running git or gh');
  }
});

const POSIX = process.platform !== 'win32';

function fakeGh(t, repo, output) {
  const bin = path.join(repo.dir, '.bin');
  fs.mkdirSync(bin);
  const argsFile = path.join(repo.dir, '.gh-args');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
  return { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, args: () => fs.readFileSync(argsFile, 'utf8').trim().split('\n') };
}

test('end to end: without --labels the labels are read from the PR through gh, at run time', { skip: !POSIX && 'the fake gh is a POSIX shell script' }, (t) => {
  const repo = makeRepo(t);
  const head = repo.commit({ 'main.js': 'b\n' }, 'app');
  const gh = fakeGh(t, repo, '["bug","no-changelog"]');
  const r = check(repo, ['--base', repo.base, '--head', head, '--repo', 'o/r', '--pr', '7'], gh.env);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(gh.args(), ['api', 'repos/o/r/issues/7/labels', '--jq', '[.[].name]']);
});

test('end to end: labels read through gh without no-changelog do not waive the entry', { skip: !POSIX && 'the fake gh is a POSIX shell script' }, (t) => {
  const repo = makeRepo(t);
  const head = repo.commit({ 'main.js': 'b\n' }, 'app');
  const gh = fakeGh(t, repo, '["bug"]');
  assert.equal(check(repo, ['--base', repo.base, '--head', head, '--repo', 'o/r', '--pr', '7'], gh.env).status, 1);
});
