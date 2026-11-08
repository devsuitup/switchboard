'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const selectorPath = path.join(root, 'scripts/platform-tests.js');

function selector() {
  assert.ok(fs.existsSync(selectorPath), 'platform test selector must exist');
  return require(selectorPath);
}

function fixture(t, sources) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-selection-'));
  t.after(() => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    assert.ok(fs.realpathSync(dir).startsWith(tempRoot + path.sep), 'fixture cleanup stays inside the temp directory');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, source] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), source);
  }
  return { root: dir, minimum: 0 };
}

test('October Windows regressions remain selected without executing their sources', () => {
  const files = ['worktree-delete-real-git', 'touched-editor-ipc', 'canary-cli-capabilities-fast']
    .map(name => `test/${name}.test.js`);
  assert.deepEqual(selector().selectPlatformTests(files, { minimum: 0 }), files);
});

for (const name of ['run-to-exit', 'trigger-continuation-delivery', 'task-transcript-reader',
  'task-review-regressions', 'transcript-cwd-trust', 'transcript-cwd-trust-cache', 'derive-project-path']) {
  test(`Windows bug regression ${name} remains selected`, () => {
    const file = `test/${name}.test.js`;
    assert.deepEqual(selector().selectPlatformTests([file], { minimum: 0 }), [file]);
  });
}

for (const name of ['continuation-choice-menu', 'continuation-memory', 'get-projects-cold-start-reconcile',
  'projection-envelope-742', 'refusals-before-dialogs', 'reload-notices', 'restore-in-flight-persist',
  'restore-pending-notice-666', 'send-to-background-renderer']) {
  test(`production platform dependency through a test helper selects ${name}`, () => {
    const file = `test/${name}.test.js`;
    assert.deepEqual(selector().selectPlatformTests([file], { minimum: 0 }), [file]);
  });
}

test('test helpers forward production dependencies without opting callers into helper-only platform code', t => {
  const options = fixture(t, {
    'test/through.js': "require('./bridge.cjs')",
    'test/bridge.cjs': "require('../src/platform')",
    'src/platform.js': 'process.platform',
    'test/only.js': "require('./only.cjs')",
    'test/only.cjs': 'process.platform',
  });
  assert.deepEqual(selector().selectPlatformTests(['test/through.js', 'test/only.js'], options), ['test/through.js']);
});

test('generic sources and physical CRLF line endings stay out', t => {
  const options = fixture(t, { 'test/plain.js': "'use strict';\nconst value = 1;\n",
    'test/crlf.js': "'use strict';\r\nconst value = 'https://example.com';\r\n" });
  assert.deepEqual(selector().selectPlatformTests(['test/plain.js', 'test/crlf.js'], options), []);
});

test('carriage returns are stripped before strong-marker matching', t => {
  const options = fixture(t, { 'test/normalized.js': 'process.\rplatform' });
  assert.deepEqual(selector().selectPlatformTests(['test/normalized.js'], options), ['test/normalized.js']);
});

test('each strong marker and the explicit comment opt-in select a file', t => {
  const samples = ["process.platform", "'win32'", 'path.win32', 'C:\\repo', 'C:/repo', 'RUNNER~1',
    'conpty', 'node-pty', 'cmd.exe', 'powershell', 'junction', 'symlink', 'EPERM', 'EBUSY',
    'EACCES', 'USERPROFILE', 'APPDATA', 'TEMP', String.raw`'\r\n'`, 'case-insensitive',
    '// platform: windows', 'spawn(', 'spawnSync(', 'execFile(', 'execFileSync(',
    'child.kill(', 'fs.rename(', 'fs.renameSync(', 'fs.promises.rename(',
    'fs.realpathSync(', 'stat.birthtime', '{ bigint: true }', 'os.tmpdir(); realpath()'];
  const sources = Object.fromEntries(samples.map((source, i) => [`test/marker-${i}.js`, source]));
  const options = fixture(t, sources);
  const files = Object.keys(sources);
  assert.deepEqual(selector().selectPlatformTests(files, options), files);
  assert.ok(Object.keys(selector().STRONG_MARKERS).length > 0);
});

test('production platform dependencies are followed transitively through cycles and index modules', t => {
  const options = fixture(t, {
    'test/direct.js': "require('../src/direct')",
    'test/indirect.js': "require('../src/indirect')",
    'test/helper.js': "require('./helper.cjs')",
    'test/helper.cjs': 'process.platform',
    'test/shell.js': "require('../src/shell')",
    'src/direct.js': 'process.platform',
    'src/indirect.js': "require('./direct')",
    'src/shell.js': "'powershell'",
    'test/cycle.js': "require('../src/cycle')",
    'src/cycle/index.js': "require('../cycle'); require('../indirect')",
  });
  assert.deepEqual(selector().selectPlatformTests([
    'test/direct.js', 'test/indirect.js', 'test/helper.js', 'test/shell.js', 'test/cycle.js',
  ], options), ['test/direct.js', 'test/indirect.js', 'test/cycle.js']);
});

test('missing listed files fail closed', t => {
  const options = fixture(t, { 'test/dep.js': "require('../src/missing')" });
  assert.throws(() => selector().selectPlatformTests(['test/missing.js'], options), /ENOENT/);
});

test('the selection floor rejects 149 files and accepts 150', t => {
  const sources = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`test/${i}.js`, 'process.platform']));
  const options = fixture(t, sources);
  delete options.minimum;
  assert.throws(() => selector().selectPlatformTests(Object.keys(sources).slice(1), options), /149.*150/);
  assert.equal(selector().selectPlatformTests(Object.keys(sources), options).length, 150);
});

function runRunner(platformOnly, inventory, selected, error) {
  const filename = path.join(root, 'scripts/run-tests.js');
  const realRequire = createRequire(filename);
  const calls = [], logs = [];
  let status;
  const entry = { exports: {} };
  const requireForRunner = name => {
    if (name === 'fs') return { readdirSync: () => inventory };
    if (name === 'child_process') return { spawnSync: (_exe, args) => { calls.push(args); return { status: 0 }; } };
    if (name === './platform-tests') return { selectPlatformTests: files => {
      if (error) throw new Error(error);
      return files.filter(file => selected.includes(path.basename(file)));
    } };
    return realRequire(name);
  };
  requireForRunner.main = entry;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: requireForRunner, module: entry, __dirname: path.dirname(filename),
    process: { execPath: process.execPath, argv: ['node', filename, ...(platformOnly ? ['--platform-only'] : [])],
      env: {}, exit: code => { status = code; } },
    console: { log: line => logs.push(line), error: line => logs.push(line) },
  }, { filename });
  return { calls, logs, status };
}

test('platform-only filters both stages and prints the inventory count', () => {
  const result = runRunner(true, ['plain.test.js', 'windows.test.js', 'trigger-watcher.test.js', 'trigger-delivery.test.js'],
    ['windows.test.js', 'trigger-delivery.test.js']);
  assert.deepEqual(result.calls.map(args => Array.from(args).filter(arg => arg.startsWith('test'))),
    [[path.join('test', 'windows.test.js')], [path.join('test', 'trigger-delivery.test.js')]]);
  assert.deepEqual(result.logs, ['platform-only: 2 of 4 test files']);
  assert.equal(result.status, 0);
});

test('empty selected stages never launch Node with implicit test discovery', () => {
  const result = runRunner(true, ['plain.test.js'], []);
  assert.deepEqual(result.calls, []);
});

test('selection read errors fail before any test process starts', () => {
  const result = runRunner(true, ['plain.test.js'], [], 'ENOENT: listed file');
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
  assert.match(result.logs.join('\n'), /ENOENT: listed file/);
});

test('ordinary runner retains both unfiltered stages', () => {
  const result = runRunner(false, ['plain.test.js', ...require('../scripts/run-tests').ISOLATED_FILES], []);
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls[0].includes(path.join('test', 'plain.test.js')));
  assert.ok(result.calls[1].includes(path.join('test', 'trigger-watcher.test.js')));
});

for (const missing of require('../scripts/run-tests').ISOLATED_FILES) {
  test(`ordinary runner fails closed when isolated file ${missing} is missing`, () => {
    const inventory = ['plain.test.js', ...require('../scripts/run-tests').ISOLATED_FILES.filter(file => file !== missing)];
    const result = runRunner(false, inventory, []);
    assert.equal(result.status, 1, 'missing isolated file must fail the run');
    assert.deepEqual(result.calls, [], 'missing inventory entry must fail before launching tests');
    assert.ok(result.logs.some(line => line.includes(missing)), 'failure must name the missing isolated file');
  });
}

test('the excluded canary source harness can still intercept the runner exit', () => {
  const consumer = fs.readFileSync(path.join(root, 'test/canary-cli-capabilities-fast.test.js'), 'utf8');
  const anchor = consumer.match(/\.replace\('(process\.exit\([^']+;)'/);
  assert.ok(anchor, 'the recorded canary consumer must expose its exit interception anchor');
  const runner = fs.readFileSync(path.join(root, 'scripts/run-tests.js'), 'utf8');
  assert.ok(runner.includes(anchor[1]), 'runner must preserve the canary exit interception anchor');
});
