'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { checkDocs } = require('../scripts/check-docs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-docs.js');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');

test('each runtime path requires documentation, including non-JS renderer files', () => {
  for (const file of ['main.js', 'preload.js', 'session-cache.js', 'src/main/service.js',
    'public/app.js', 'public/index.html', 'public/style.css', 'workers/search.js',
    'harnesses/codex.js', 'scripts/claude-sandbox.sh']) {
    const result = checkDocs({ files: [file, 'test/fixture.js'], labels: [] });
    assert.equal(result.ok, false, file);
    assert.ok(result.message.includes(file));
    assert.ok(!result.message.includes('test/fixture.js'));
    assert.match(result.message, /no-docs/);
  }
});

test('test-only, CI-only, tooling-only and docs-only PRs pass', () => {
  for (const files of [[], ['test/main.test.js'], ['.github/workflows/test.yml'],
    ['scripts/check-docs.js', 'eslint.config.js', 'package-lock.json'],
    ['docs/guide.md'], ['.ai/contexts/build-release.md'], ['README.md']]) {
    assert.equal(checkDocs({ files, labels: [] }).ok, true, files.join(', '));
  }
});

test('any accepted documentation path satisfies the mechanical gate', () => {
  for (const file of ['docs/guide.md', 'docs/nested/guide.md', '.ai/contexts/cli.md', 'README.md']) {
    assert.equal(checkDocs({ files: ['main.js', file], labels: [] }).ok, true, file);
  }
});

test('changelog, guidelines and similarly named paths do not substitute for documentation', () => {
  for (const file of ['CHANGELOG.md', '.ai/shared-guidelines.md', 'docs-old/guide.md',
    '.ai/contexts-old/cli.md', 'test/README.md', 'README.md.bak']) {
    assert.equal(checkDocs({ files: ['main.js', file], labels: [] }).ok, false, file);
  }
});

test('only the exact no-docs label waives runtime documentation', () => {
  assert.equal(checkDocs({ files: ['main.js'], labels: ['bug', 'no-docs'] }).ok, true);
  for (const label of ['no-changelog', 'no-docs-please', 'No-Docs']) {
    assert.equal(checkDocs({ files: ['main.js'], labels: [label] }).ok, false, label);
  }
});

function runCli(args, { files = ['main.js'], labels = '[]', failCommand } = {}) {
  const calls = [];
  const output = [];
  const module = { exports: {} };
  const localRequire = createRequire(SCRIPT);
  const require = (name) => name === 'node:child_process' ? {
    execFileSync(command, argv, options) {
      calls.push({ command, argv: Array.from(argv), options: { ...options } });
      if (command === failCommand) throw new Error(`${command} unavailable`);
      assert.ok(['git', 'gh'].includes(command), command);
      return command === 'git' ? files.join('\0') + '\0' : labels;
    },
  } : localRequire(name);
  require.main = module;
  const process = { argv: ['node', SCRIPT, ...args] };
  vm.runInNewContext(SOURCE, {
    require, module, process,
    console: { log: (s) => output.push(s), error: (s) => output.push(s) },
  }, { filename: SCRIPT });
  return { code: process.exitCode, calls, output: output.join('\n') };
}

const REFS = ['--base', 'base-sha', '--head', 'head-sha'];

test('CLI reads the whole PR diff with renames exposed and uses exit codes 0 and 1', () => {
  const result = runCli([...REFS, '--labels', '[]']);
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(result.calls, [{ command: 'git',
    argv: ['diff', '--name-only', '--no-renames', '-z', 'base-sha...head-sha'],
    options: { encoding: 'utf8' } }]);
  assert.equal(runCli([...REFS, '--labels', '[]'], { files: ['main.js', 'docs/guide.md'] }).code, 0);
  assert.equal(runCli([...REFS, '--labels', '["no-docs"]']).code, 0);
});

test('CLI reads current labels from the PR at run time', () => {
  const result = runCli([...REFS, '--repo', 'owner/repo', '--pr', '7'], { labels: '["no-docs"]' });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls[0], { command: 'gh',
    argv: ['api', 'repos/owner/repo/issues/7/labels', '--jq', '[.[].name]'],
    options: { encoding: 'utf8' } });
  assert.equal(runCli([...REFS, '--repo', 'owner/repo', '--pr', '7']).code, 1);
});

test('CLI preserves quoted, Unicode and whitespace-containing git paths', () => {
  const result = runCli([...REFS, '--labels', '[]'], { files: ['public/é "a"\n b.js'] });
  assert.equal(result.code, 1);
  assert.ok(result.output.includes('public/é "a"\n b.js'));
});

test('CLI fails closed with exit 2 on invalid arguments, labels or command failures', () => {
  for (const args of [[], ['--base'], REFS, [...REFS, '--unknown', 'x']]) {
    const result = runCli(args);
    assert.equal(result.code, 2);
    assert.match(result.output, /usage: check-docs.js/);
    assert.equal(result.calls.length, 0);
  }
  for (const labels of ['invalid', '{}', '[1]']) {
    assert.equal(runCli([...REFS, '--labels', labels]).code, 2);
    assert.equal(runCli([...REFS, '--repo', 'o/r', '--pr', '7'], { labels }).code, 2);
  }
  assert.equal(runCli([...REFS, '--labels', '[]'], { failCommand: 'git' }).code, 2);
  assert.equal(runCli([...REFS, '--repo', 'o/r', '--pr', '7'], { failCommand: 'gh' }).code, 2);
});

test('workflow runs the docs gate on PRs with full history, live labels and PR SHAs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/test.yml'), 'utf8');
  const job = workflow.match(/\n  docs:\r?\n([\s\S]*?)(?=\n  \w+:|$)/);
  assert.ok(job, 'test.yml must carry a docs job');
  assert.match(job[1], /if: github\.event_name == 'pull_request'/);
  assert.match(job[1], /fetch-depth: 0/);
  assert.match(job[1], /persist-credentials: false/);
  assert.match(job[1], /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.equal(job[1].match(/run: (.*)/)[1], 'node scripts/check-docs.js'
    + ' --base "${{ github.event.pull_request.base.sha }}"'
    + ' --head "${{ github.event.pull_request.head.sha }}"'
    + ' --repo "${{ github.repository }}"'
    + ' --pr "${{ github.event.pull_request.number }}"');
});
