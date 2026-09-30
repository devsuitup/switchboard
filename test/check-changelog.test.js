// The CI check that a PR changing the app carries a CHANGELOG.md entry — see docs/changelog.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('the test workflow runs the check on pull requests, with the PR labels read at run time', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  changelog:'));
  assert.notEqual(workflow.indexOf('\n  changelog:'), -1, 'test.yml must carry a changelog job');
  assert.match(job, /if: github\.event_name == 'pull_request'/);
  assert.match(job, /gh api "repos\/\$\{\{ github\.repository \}\}\/issues\/\$\{\{ github\.event\.pull_request\.number \}\}\/labels"/);
  assert.match(job, /node scripts\/check-changelog\.js/);
});
