'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { selectTests, runFast } = require('../scripts/check-fast');

const inventory = [
  'pty-ops.test.js', 'pty-ops-input.test.js', 'other.test.js',
  'foo.test.js', 'foo-extra.test.js', 'dom-foo.test.js', 'dom-foo-extra.test.js',
  'foo.js', 'foo.test.json', 'foobar.test.js', 'trigger-watcher.test.js',
];

test('source basename selects all matching test siblings, sorted and deduplicated', () => {
  assert.deepEqual(selectTests(['src/main/terminals/pty-ops.js', 'src/main/pty-ops.js'], inventory), [
    'test/pty-ops-input.test.js', 'test/pty-ops.test.js',
  ]);
});

test('public source selects renderer and ordinary prefix tests with either separator', () => {
  const expected = ['test/dom-foo-extra.test.js', 'test/dom-foo.test.js', 'test/foo-extra.test.js', 'test/foo.test.js'];
  assert.deepEqual(selectTests(['public/foo.js'], inventory), expected);
  assert.deepEqual(selectTests(['public\\foo.js', 'src\\main\\foo.js'], inventory), expected);
});

test('staged test selects itself without selecting similarly named siblings', () => {
  assert.deepEqual(selectTests(['test\\foo.test.js', 'test/foo.test.js'], inventory), ['test/foo.test.js']);
  assert.deepEqual(selectTests(['test/canary/cli.test.js'], inventory), []);
});

test('non-JS files, empty selection and unmatched sources select nothing', () => {
  assert.deepEqual(selectTests(['README.md', 'public/foo.css', 'missing.js'], inventory), []);
  assert.deepEqual(selectTests([], inventory), []);
});

test('basenames are literal prefixes, not regular expressions', () => {
  assert.deepEqual(selectTests(['foo[1].js'], ['foo[1].test.js', 'foo1.test.js']), ['test/foo[1].test.js']);
});

test('a source basename matches only up to a separator', () => {
  assert.deepEqual(selectTests(['foo.js'], inventory), ['test/foo-extra.test.js', 'test/foo.test.js']);
});

test('lint takes staged .cjs and .mjs files; serial trigger tests run without a per-file test timeout', (t) => {
  const options = rig(t, { files: ['scripts/x.cjs', 'src/main/triggers/trigger-watcher.js'] });
  assert.equal(runFast(options), 0);
  const [lint, ...tests] = options.calls;
  assert.deepEqual(lint.args.slice(-2), ['scripts/x.cjs', 'src/main/triggers/trigger-watcher.js']);
  assert.deepEqual(tests.map(call => call.args), [['--test', '--test-concurrency=1', 'test/trigger-watcher.test.js']]);
  assert.equal(tests[0].options.timeout, 600000);
});

function rig(t, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'check-fast-901-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'test'));
  for (const name of inventory) fs.writeFileSync(path.join(cwd, 'test', name), '');
  fs.mkdirSync(path.join(cwd, 'test', 'foo-directory.test.js'));
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return overrides.respond?.(command, args) ?? {
      status: 0, stdout: command === 'git' ? 'pty-ops.js\0test/pty-ops.test.js\0' : '',
    };
  };
  return { cwd, spawn, env: {}, ...overrides, calls };
}

test('staged ACMR NUL list ignores deletions and preserves spaces', (t) => {
  const options = rig(t, { respond: (command, args) => command === 'git'
    ? { status: 0, stdout: args.includes('--diff-filter=ACMR') ? 'file with space.js\0' : 'deleted.js\0' }
    : { status: 0 } });
  assert.equal(runFast(options), 0);
  assert.deepEqual(options.calls[0].args, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  assert.deepEqual(options.calls[1].args.slice(-2), ['--', 'file with space.js']);
  assert.equal(options.calls.length, 2);
});

test('runs staged JS lint then each actual matching test once, using current Node', (t) => {
  const options = rig(t, { files: ['public\\foo.js', 'test/foo.test.js', 'README.md'] });
  assert.equal(runFast(options), 0);
  const [lint, ...tests] = options.calls;
  assert.ok(lint, 'lint must run');
  assert.equal(lint.command, process.execPath);
  assert.match(lint.args[0], /eslint[\\/]bin[\\/]eslint\.js$/);
  assert.deepEqual(lint.args.slice(1), ['--no-error-on-unmatched-pattern', '--', 'public/foo.js', 'test/foo.test.js']);
  assert.deepEqual(tests.map(call => call.args.at(-1)), selectTests(options.files, inventory));
  assert.equal(tests.length, 4);
  for (const call of tests) {
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args.slice(0, -1), ['--test', '--test-concurrency=1', '--test-timeout=120000']);
  }
  for (const call of options.calls) {
    assert.equal(call.options.cwd, options.cwd);
    assert.equal(call.options.timeout, 120000);
    assert.notEqual(call.options.shell, true);
  }
});

test('SKIP_TESTS keeps lint and skips tests with task or direct invocation', (t) => {
  const options = rig(t, { files: ['src/main/terminals/pty-ops.js'], env: { SKIP_TESTS: '1' } });
  assert.equal(runFast(options), 0);
  assert.equal(options.calls.length, 1);
  assert.ok(options.calls[0].args[0].includes('eslint'));
});

test('docs-only selection spawns neither lint nor tests', (t) => {
  const options = rig(t, { files: ['docs/development.md'] });
  assert.equal(runFast(options), 0);
  assert.deepEqual(options.calls, []);
});

test('lint failure blocks tests and returns its exit status', (t) => {
  const options = rig(t, { files: ['src/main/terminals/pty-ops.js'], respond: () => ({ status: 2 }) });
  assert.equal(runFast(options), 2);
  assert.equal(options.calls.length, 1);
});

test('test failure blocks later tests and returns its exit status', (t) => {
  const options = rig(t, { files: ['src/main/terminals/pty-ops.js'], respond: (command, args) => ({ status: args[0] === '--test' ? 3 : 0 }) });
  assert.equal(runFast(options), 3);
  assert.equal(options.calls.length, 2);
});

test('git failure is reported instead of silently accepting an empty selection', (t) => {
  const options = rig(t, { respond: () => ({ status: 128, stderr: 'git failed' }) });
  assert.throws(() => runFast(options), /git failed/);
  assert.equal(options.calls.length, 1);
});

test('spawn error and signal termination cannot pass the check', (t) => {
  const options = rig(t, { files: ['src/main/terminals/pty-ops.js'], respond: () => ({ error: new Error('spawn failed'), status: null }) });
  assert.throws(() => runFast(options), /spawn failed/);
  const terminated = rig(t, { files: ['src/main/terminals/pty-ops.js'], respond: () => ({ status: null, signal: 'SIGTERM' }) });
  assert.equal(runFast(terminated), 1);
});

test('hook routes both branches through the fast task or script; full gate stays full', () => {
  const root = path.join(__dirname, '..');
  const hook = fs.readFileSync(path.join(root, '.husky/pre-commit'), 'utf8');
  const tasks = fs.readFileSync(path.join(root, 'Taskfile.yaml'), 'utf8');
  assert.match(hook, /task check:fast/);
  assert.match(hook, /else\s+node scripts\/check-fast\.js/);
  assert.doesNotMatch(hook, /npm test|npm run lint/);
  assert.match(tasks, /"check:fast":[\s\S]*?node scripts\/check-fast\.js/);
  assert.match(tasks, /\n  check:\r?\n[^\n]*\n    deps: \[test, lint\]/);
});

test('CLI accepts explicit files without Git and rejects malformed arguments', () => {
  const script = path.join(__dirname, '../scripts/check-fast.js');
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120000 });
  const docs = run(['--files', 'README.md']);
  assert.equal(docs.status, 0, docs.stderr);
  for (const args of [['--unknown'], ['--files']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});
