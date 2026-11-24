// The tag check of the build workflow: tag format, package version, and a final rebuilt from its last beta — see docs/releasing.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const { parseTag, lastBetaTag, checkReleaseTag, ALLOWED_FINAL_FILES } = require('../scripts/check-release-tag');

const changelog = (...headings) => ['# Changelog', '', '## Unreleased', '',
  ...headings.flatMap((h) => [h, '', '### Fixed', '- Something. (#1)', '']), '---', ''].join('\n');
const pkg = (version, extra = {}) => JSON.stringify({ name: 'switchboard', version, ...extra }, null, 2) + '\n';
const lock = (version, extra = {}) => JSON.stringify({
  name: 'switchboard', version, lockfileVersion: 3,
  packages: { '': { name: 'switchboard', version, ...extra } },
}, null, 2) + '\n';

function fakeRepo(files, diffs = {}) {
  return {
    tags: Object.keys(files),
    readFile: (ref, file) => (files[ref] && files[ref][file] !== undefined ? files[ref][file] : null),
    changedFiles: (from, to) => diffs[`${from}..${to}`] || [],
  };
}

const BETA2_FILES = {
  'package.json': pkg('0.1.0-beta.2'), 'package-lock.json': lock('0.1.0-beta.2'),
  'CHANGELOG.md': changelog('## v0.1.0-beta.2 — 2026-11-25', '## v0.1.0-beta.1 — 2026-11-24'),
};
const FINAL_FILES = {
  'package.json': pkg('0.1.0'), 'package-lock.json': lock('0.1.0'),
  'CHANGELOG.md': changelog('## v0.1.0 — 2026-11-26'),
};

test('release tags are vX.Y.Z or vX.Y.Z-beta.N, nothing else', () => {
  assert.deepEqual(parseTag('v0.1.0'), { version: '0.1.0', base: '0.1.0', beta: null });
  assert.deepEqual(parseTag('v0.1.0-beta.12'), { version: '0.1.0-beta.12', base: '0.1.0', beta: 12 });
  for (const bad of ['0.1.0', 'v0.1', 'v0.1.0-rc.1', 'v0.1.0-beta', 'v0.1.0-beta.0', 'v0.1.0-beta.1.2',
    'v01.1.0', 'v0.1.0-Beta.1', 'v0.1.0+build', 'v0.1.0-beta.01', '', null]) {
    assert.equal(parseTag(bad), null, `accepted ${String(bad)}`);
  }
});

test('the last beta of a version is the highest N, compared as a number', () => {
  const tags = ['v0.1.0-beta.2', 'v0.1.0-beta.10', 'v0.1.0-beta.9', 'v0.1.1-beta.30', 'v0.0.109', 'v0.1.0-rc.99'];
  assert.equal(lastBetaTag(tags, '0.1.0'), 'v0.1.0-beta.10');
  assert.equal(lastBetaTag(tags, '0.2.0'), null);
});

test('a beta tag passes when package.json carries its version', () => {
  const repo = fakeRepo({ 'v0.1.0-beta.2': BETA2_FILES });
  const result = checkReleaseTag({ tag: 'v0.1.0-beta.2', ...repo });
  assert.equal(result.ok, true, result.message);
});

test('a tag whose package.json carries another version fails, naming both', () => {
  const repo = fakeRepo({ 'v0.1.0-beta.3': BETA2_FILES });
  const result = checkReleaseTag({ tag: 'v0.1.0-beta.3', ...repo });
  assert.equal(result.ok, false);
  assert.match(result.message, /0\.1\.0-beta\.2/);
  assert.match(result.message, /v0\.1\.0-beta\.3/);
});

test('a tag of another shape fails before anything is read', () => {
  const result = checkReleaseTag({ tag: 'v0.1.0-rc.1', tags: [], readFile: () => assert.fail('read'), changedFiles: () => assert.fail('diff') });
  assert.equal(result.ok, false);
  assert.match(result.message, /vX\.Y\.Z-beta\.N/);
});

test('a final that differs from its last beta only by the version bump and the changelog passes', () => {
  const repo = fakeRepo({ 'v0.1.0-beta.1': BETA2_FILES, 'v0.1.0-beta.2': BETA2_FILES, 'v0.1.0': FINAL_FILES },
    { 'v0.1.0-beta.2..v0.1.0': [...ALLOWED_FINAL_FILES] });
  const result = checkReleaseTag({ tag: 'v0.1.0', ...repo });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /v0\.1\.0-beta\.2/);
});

test('a final that changes any other file than the three allowed fails, naming the files and the beta', () => {
  const repo = fakeRepo({ 'v0.1.0-beta.2': BETA2_FILES, 'v0.1.0': FINAL_FILES },
    { 'v0.1.0-beta.2..v0.1.0': ['CHANGELOG.md', 'main.js', 'package.json', 'src/main/app/changelog.js'] });
  const result = checkReleaseTag({ tag: 'v0.1.0', ...repo });
  assert.equal(result.ok, false);
  assert.match(result.message, /main\.js/);
  assert.match(result.message, /src\/main\/app\/changelog\.js/);
  assert.match(result.message, /v0\.1\.0-beta\.2/);
  assert.doesNotMatch(result.message, /^ {2}CHANGELOG\.md$/m);
});

test('a final with no beta tag of its version passes without a beta comparison, and says so', () => {
  const unfolded = { ...FINAL_FILES, 'CHANGELOG.md': changelog('## v0.1.0 — 2026-11-26', '## v0.1.0-beta.2 — 2026-11-25') };
  for (const files of [FINAL_FILES, unfolded]) {
    const result = checkReleaseTag({
      tag: 'v0.1.0',
      tags: ['v0.0.109', 'v0.1.1-beta.1', 'v0.1.0-rc.1', 'v0.1.0'],
      readFile: (ref, file) => (ref === 'v0.1.0' ? files[file] ?? null : assert.fail(`read ${ref}:${file}`)),
      changedFiles: () => assert.fail('no beta tree to compare'),
    });
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /no v0\.1\.0-beta\.N tag/);
  }
});

test('a final with no beta tag of its version still fails on its package.json version', () => {
  const repo = fakeRepo({ 'v0.0.110': FINAL_FILES });
  const result = checkReleaseTag({ tag: 'v0.0.110', ...repo });
  assert.equal(result.ok, false);
  assert.match(result.message, /carries version 0\.1\.0, not 0\.0\.110/);
});

test('a final whose package.json or lock changes more than the version fails', () => {
  for (const [file, changed] of [
    ['package.json', pkg('0.1.0', { dependencies: { 'electron-updater': '6.9.0' } })],
    ['package-lock.json', lock('0.1.0', { dependencies: { 'electron-updater': '6.9.0' } })],
  ]) {
    const repo = fakeRepo({ 'v0.1.0-beta.2': BETA2_FILES, 'v0.1.0': { ...FINAL_FILES, [file]: changed } },
      { 'v0.1.0-beta.2..v0.1.0': [...ALLOWED_FINAL_FILES] });
    const result = checkReleaseTag({ tag: 'v0.1.0', ...repo });
    assert.equal(result.ok, false, file);
    assert.match(result.message, new RegExp(`${file.replace('.', '\\.')} .*more than its version`), file);
  }
});

test('a final whose changelog still carries its beta sections, or lacks its own, fails', () => {
  for (const [text, pattern] of [
    [changelog('## v0.1.0 — 2026-11-26', '## v0.1.0-beta.2 — 2026-11-25'), /v0\.1\.0-beta\.2.*fold/],
    [changelog('## v0.1.0-beta.2 — 2026-11-25'), /no section for v0\.1\.0/],
  ]) {
    const repo = fakeRepo({ 'v0.1.0-beta.2': BETA2_FILES, 'v0.1.0': { ...FINAL_FILES, 'CHANGELOG.md': text } },
      { 'v0.1.0-beta.2..v0.1.0': ['CHANGELOG.md', 'package.json', 'package-lock.json'] });
    const result = checkReleaseTag({ tag: 'v0.1.0', ...repo });
    assert.equal(result.ok, false);
    assert.match(result.message, pattern);
  }
});

test('the build workflow runs the check on every tag push, and publish waits for it', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'build.yml'), 'utf8'));
  const job = workflow.jobs['release-tag'];
  assert.ok(job, 'build.yml must carry a release-tag job');
  assert.equal(job.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0, 'the check reads every tag');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(job.steps.some((s) => s.run === 'node scripts/check-release-tag.js "$GITHUB_REF_NAME"'));
  assert.ok(workflow.jobs.publish.needs.includes('release-tag'));
});

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-release-tag.js');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C',
};

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-release-tag-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('HUSKY')));
  const env = { ...inherited, ...GIT_ENV, HOME: dir };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, encoding: 'utf8' }).trim();
  const commit = (files, message) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git('add', '-A');
    git('commit', '-qm', message);
  };
  git('init', '-q');
  commit({ 'main.js': 'a\n', ...BETA2_FILES }, 'beta 2');
  git('tag', '-a', '-m', 'beta 2', 'v0.1.0-beta.2');
  return { dir, env, git, commit };
}

function run(repo, tag) {
  const r = spawnSync(process.execPath, [SCRIPT, tag], { cwd: repo.dir, env: repo.env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('end to end: a final tag on a bump-only commit passes, and one on a code change fails', (t) => {
  const repo = makeRepo(t);
  assert.equal(run(repo, 'v0.1.0-beta.2').status, 0);
  repo.commit(FINAL_FILES, 'chore(release): v0.1.0');
  repo.git('tag', 'v0.1.0');
  const pass = run(repo, 'v0.1.0');
  assert.equal(pass.status, 0, pass.out);
  repo.commit({ 'main.js': 'b\n' }, 'fix(x): late');
  repo.git('tag', '-f', 'v0.1.0');
  const fail = run(repo, 'v0.1.0');
  assert.equal(fail.status, 1, fail.out);
  assert.match(fail.out, /::error::/);
  assert.match(fail.out, /main\.js/);
});

test('end to end: a plain final with no beta of its version passes and logs that no beta was compared', (t) => {
  const repo = makeRepo(t);
  repo.commit({ 'main.js': 'c\n', 'package.json': pkg('0.0.110'), 'package-lock.json': lock('0.0.110'),
    'CHANGELOG.md': changelog('## v0.0.110 — 2026-11-26') }, 'chore(release): v0.0.110');
  repo.git('tag', 'v0.0.110');
  const result = run(repo, 'v0.0.110');
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /no v0\.0\.110-beta\.N tag/);
});

test('end to end: a tag that names no commit is a git failure, not a contract failure', (t) => {
  const repo = makeRepo(t);
  const result = run(repo, 'v9.9.9');
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /::error::.*v9\.9\.9/);
});

test('end to end: a missing tag argument is a usage error', (t) => {
  const repo = makeRepo(t);
  assert.equal(run(repo, '').status, 2);
});
