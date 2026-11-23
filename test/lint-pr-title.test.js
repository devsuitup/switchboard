'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const yaml = require('js-yaml');
const { lintPrTitle, runPrTitleLint } = require('../scripts/lint-pr-title');

const validTitles = [
  ...['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert']
    .map(type => `${type}(viewer): update the view`),
  'chore(release): v0.1.0',
  'chore(release): v0.1.0-beta.1',
  'fix(ci)!: …',
  'feat(remote-hosts)!: change the connection format',
  'docs(ci/release): explain the workflow',
  'fix(viewer): afficher les résultats 日本語',
  'fix(ci): keep $(echo title) and `title` as text',
];

const invalidTitles = [
  '(area): subject', 'fix: subject', 'fix(): subject', 'fix( ): subject',
  'fix(two words): subject', 'fix((ci)): subject', 'Fix(ci): subject',
  'feature(ci): subject', 'style(ci): subject', 'fix(ci):', 'fix(ci): ',
  'fix(ci):   ', 'fix(ci):\t', 'fix(ci):subject', 'fix!(ci): subject',
  'fix(ci)!!: subject', 'prefix fix(ci): subject', ' fix(ci): subject',
  'fix(ci): subject\n', 'fix(ci): subject\r\n::error::injected',
  'fix(ci): first\nsecond', 'fix(ci): first\u2028second', 'fix(ci): first\u2029second',
  '', null, undefined, 42,
];

for (const title of validTitles) {
  test(`accepts ${JSON.stringify(title)}`, () => {
    assert.equal(lintPrTitle(title), null, 'valid title must have no diagnostic');
  });
}

for (const title of invalidTitles) {
  test(`rejects ${JSON.stringify(title)}`, () => {
    assert.equal(typeof lintPrTitle(title), 'string', 'invalid title must have a diagnostic');
    assert.match(lintPrTitle(title), /type\(area\): subject/);
  });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-title-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'summary.md');
}

for (const advisory of [true, false]) {
  test(`invalid title reports a warning and summary; advisory=${advisory}`, (t) => {
    const summaryPath = fixture(t);
    fs.writeFileSync(summaryPath, 'Earlier step\n');
    const output = [];
    const result = runPrTitleLint({
      title: '(ci): bad\n::error::INJECTED%0A<img src=x>',
      summaryPath, advisory, write: line => output.push(line),
    });
    assert.equal(result, advisory ? 0 : 1, 'advisory failures must not block the check');
    assert.equal(output.length, 1);
    assert.match(output[0], /^::warning::/);
    assert.match(output[0], /type\(area\): subject/);
    assert.doesNotMatch(output[0], /\n|INJECTED|<img/);
    const summary = fs.readFileSync(summaryPath, 'utf8');
    assert.match(summary, /^Earlier step\n/);
    assert.match(summary, /PR title/);
    assert.match(summary, /type\(area\): subject/);
    assert.doesNotMatch(summary, /INJECTED|<img/);
  });

  test(`valid title reports success; advisory=${advisory}`, (t) => {
    const summaryPath = fixture(t);
    const output = [];
    assert.equal(runPrTitleLint({
      title: 'chore(release): v0.1.0', summaryPath, advisory,
      write: line => output.push(line),
    }), 0);
    assert.deepEqual(output, ['PR title matches type(area): subject.']);
    assert.match(fs.readFileSync(summaryPath, 'utf8'), /PR title matches/);
  });
}

test('strict reusable runner works without a GitHub summary file', () => {
  assert.equal(runPrTitleLint({ title: '(ci): subject', write: () => {} }), 1);
});

function runEntry(env, args) {
  const filename = path.resolve(__dirname, '../scripts/lint-pr-title.js');
  const entryModule = { exports: {} };
  const entryRequire = createRequire(filename);
  entryRequire.main = entryModule;
  const output = [];
  const context = {
    require: entryRequire, module: entryModule, exports: entryModule.exports,
    process: { argv: ['node', filename, ...args], env, exitCode: undefined },
    console: { log: line => output.push(line) },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { exitCode: context.process.exitCode, output };
}

test('CLI reads PR_TITLE and GITHUB_STEP_SUMMARY and enables advisory mode', (t) => {
  const summaryPath = fixture(t);
  const result = runEntry({ PR_TITLE: '(ci): legacy', GITHUB_STEP_SUMMARY: summaryPath }, ['--advisory']);
  assert.equal(result.exitCode, 0);
  assert.match(result.output[0], /^::warning::/);
  assert.match(fs.readFileSync(summaryPath, 'utf8'), /type\(area\): subject/);
});

test('CLI fails strictly on missing title and accepts a valid environment title', () => {
  assert.equal(runEntry({}, []).exitCode, 1);
  assert.equal(runEntry({ PR_TITLE: 'fix(ci)!: …' }, []).exitCode, 0);
});

test('PR title workflow is isolated, advisory, and passes untrusted title via environment', () => {
  const filename = path.resolve(__dirname, '../.github/workflows/pr-title.yml');
  assert.ok(fs.existsSync(filename), 'PR title workflow must exist');
  const workflow = yaml.load(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(workflow.on, {
    pull_request: { branches: ['main'], types: ['opened', 'edited', 'synchronize', 'reopened'] },
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(Object.keys(workflow.jobs).length, 1);
  const job = workflow.jobs['pr-title'];
  assert.equal(job['continue-on-error'], true);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 10);
  assert.equal(job.steps[0].uses, 'actions/checkout@v4');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  assert.equal(job.steps[1].uses, 'actions/setup-node@v4');
  assert.equal(Number(job.steps[1].with['node-version']), 22);
  const steps = job.steps.filter(step => step.run);
  assert.equal(steps.length, 1, 'title check needs no dependency installation');
  assert.equal(steps[0].run, 'node scripts/lint-pr-title.js --advisory');
  assert.deepEqual(steps[0].env, { PR_TITLE: '${{ github.event.pull_request.title }}' });
});
