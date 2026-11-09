'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { extractFunction } = require('./app-source');
const { scheduleStateKey } = require('../src/main/schedules/schedule-runner');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-792d-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runsDir = path.join(root, 'schedule-runs');
  const filePath = path.join(root, '.claude', 'commands', 'schedule-nightly.md');
  const input = { sessionId: crypto.randomUUID(), filePath, slug: 'nightly', name: 'Nightly',
    manual: false, dueMs: null, startedAtMs: 100000, endedAtMs: 101000, outcome: 'exited', code: 2, signal: null, stderr: '', sandbox: false };
  const messages = [], warnings = [];
  const log = { info() {}, error() {}, warn: (...args) => warnings.push(args) };
  return { root, runsDir, filePath, input, log, warnings, messages,
    records: () => fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(f => f.endsWith('.json')) : [],
    read: () => fs.readdirSync(runsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'))) };
}

function api() {
  const filename = path.join(__dirname, '../src/main/schedules/schedule-run-results.js');
  assert.ok(fs.existsSync(filename), 'run-result persistence module exists');
  return require(filename);
}

function launcher(t, options = {}) {
  const f = fixture(t);
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8').replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand');
  const children = [];
  const ipcFile = path.join(__dirname, '../src/main/schedules/schedule-ipc.js');
  const ipcModule = { exports: {} };
  const handlers = new Map();
  vm.runInNewContext(fs.readFileSync(ipcFile, 'utf8'), { module: ipcModule, exports: ipcModule.exports,
    require: name => name === 'electron' ? { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } } : createRequire(ipcFile)(name),
  }, { filename: ipcFile });
  const ctx = vm.createContext({ require: createRequire(filename), fs, path, os, process: { platform: options.platform || 'linux' },
    DB_PATH: path.join(f.root, 'db'), getSetting: () => ({}), isProjectSettingsArchived: () => !!options.archived,
    SETTING_DEFAULTS: {}, resolveShell: () => ({ path: 'fake-shell' }), quoteArgvForShell: (_shell, argv) => argv.join(' '),
    shellArgs: (_shell, cmd) => [cmd], cleanPtyEnv: {}, resolveScheduleSandbox: () => !!options.sandbox,
    scheduleLaunchRefusal: require('../src/main/schedules/schedule-runner').scheduleLaunchRefusal,
    scheduleProjects: () => ({ list: async () => [] }), sandboxScriptPath: () => 'sandbox', sandboxBindEnv: () => '',
    encodeProjectPath: () => 'project', scheduleIpc: ipcModule.exports,
    mainWindow: options.noWindow ? null : { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => f.messages.push(args) } },
    log: f.log, cliSessionState: { trackScheduleRun() {} }, activityReporter: { sessionStarted() {}, sessionEnded() {} },
    cpSpawn: () => {
      if (options.syncError) throw new Error('sync spawn failure');
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  vm.runInContext(extractFunction(source, 'runScheduleCommand'), ctx, { filename });
  let done = 0;
  return { ...f, children, handlers, ipc: ipcModule.exports, get done() { return done; },
    run: () => ctx.runScheduleCommand(['--resume', f.input.sessionId, ...(options.addDir ? ['--add-dir', path.join(f.root, '.claude')] : [])], f.root, 'Nightly', () => { done++; },
      { filePath: f.filePath, slug: 'nightly', manual: true, dueMs: 60000 }) };
}

test('child exit persists a complete record, independently of a window', async t => {
  const h = launcher(t, { noWindow: true });
  assert.equal((await h.run()).ok, true);
  h.children[0].emit('exit', 2, null);
  assert.equal(h.records().length, 1, 'one exit must produce one result record');
  const r = h.read()[0];
  assert.equal(r.v, 1);
  assert.equal(r.sessionId, h.input.sessionId);
  assert.equal(r.file, h.filePath);
  assert.equal(r.name, 'Nightly');
  assert.equal(r.slug, 'nightly');
  assert.equal(r.manual, true);
  assert.equal(r.dueMs, 60000);
  assert.equal(r.outcome, 'exited');
  assert.equal(r.exitCode, 2);
  assert.equal(r.failure, 'exit');
  assert.equal(r.signal, null);
  assert.equal(r.error, null);
  assert.ok(Number.isFinite(Date.parse(r.startedAt)));
  assert.ok(Date.parse(r.endedAt) >= Date.parse(r.startedAt));
});

for (const options of [{ archived: true }, { sandbox: true, platform: 'win32' }, { sandbox: true, platform: 'linux', addDir: true }, { syncError: true }]) {
  test(`launcher refusal or synchronous failure keeps the returned error: ${JSON.stringify(options)}`, async t => {
    const h = launcher(t, options);
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(h.records().length, 1, 'refused or failed spawn must produce a result');
    assert.equal(h.read()[0].outcome, options.syncError ? 'spawn-error' : 'refused');
    assert.equal(h.read()[0].error, result.error);
    assert.equal(h.read()[0].exitCode, null);
  });
}

test('error then exit at different end times keeps the first result and filename', async t => {
  const h = launcher(t);
  await h.run();
  h.children[0].emit('error', new Error('async spawn failure'));
  assert.equal(h.records().length, 1, 'spawn error must be recorded');
  const filename = h.records()[0];
  const bytes = fs.readFileSync(path.join(h.runsDir, filename));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5000 });
  h.children[0].emit('exit', 2);
  assert.deepEqual(h.records(), [filename], 'one run has one started-at filename');
  assert.deepEqual(fs.readFileSync(path.join(h.runsDir, filename)), bytes, 'the first result wins');
  assert.equal(h.read()[0].outcome, 'spawn-error');
});

test('signal and successful exits keep their actual outcome', async t => {
  for (const [code, signal, outcome] of [[0, null, 'exited'], [null, 'SIGTERM', 'signal']]) {
    const h = launcher(t);
    await h.run();
    h.children[0].emit('exit', code, signal);
    assert.equal(h.records().length, 1, 'successes and signals are recorded');
    assert.equal(h.read()[0].outcome, outcome);
    assert.equal(h.read()[0].exitCode, code);
    assert.equal(h.read()[0].signal, signal);
    if (code === 0) assert.equal(h.read()[0].failure, null);
  }
});

test('notice and record use identical stderr classification without persisting stderr', async t => {
  for (const [stderr, sandbox, code, expected] of [
    ['claude: command not found', false, 127, 'claude-path'],
    ['bwrap: creating namespace failed', true, 1, 'sandbox'],
    ['API Error', false, 2, 'exit'],
  ]) {
    const h = launcher(t, { sandbox });
    await h.run();
    h.children[0].stderr.emit('data', Buffer.from(stderr));
    h.children[0].emit('exit', code);
    assert.equal(h.records().length, 1, 'exit classification is persisted');
    assert.equal(h.read()[0].failure, expected);
    assert.equal(h.read()[0].failure, h.messages[0][1].failure);
    assert.equal(Object.hasOwn(h.read()[0], 'stderr'), false);
  }
});

test('pruning keeps the 20 newest starts of only the written key', t => {
  const f = fixture(t), a = api();
  a.writeScheduleRunResult(f.runsDir, { ...f.input, filePath: f.filePath + '.other' }, f.log);
  for (let n = 24; n >= 0; n--) a.writeScheduleRunResult(f.runsDir, { ...f.input, sessionId: crypto.randomUUID(), startedAtMs: 100000 + n }, f.log);
  const own = f.records().filter(name => name.startsWith(scheduleStateKey({ filePath: f.filePath }) + '-'));
  assert.equal(own.length, 20);
  assert.equal(f.records().length, 21, 'another schedule is untouched');
  assert.deepEqual(own.map(name => Number(name.split('-')[1])).sort((x, y) => x - y), Array.from({ length: 20 }, (_, n) => 100005 + n));
});

test('reader creates nothing, parses only requested ids, and marks broken records unreadable', t => {
  const f = fixture(t), a = api();
  assert.equal(a.readScheduleRunResults(f.runsDir, [f.input.sessionId]).size, 0);
  assert.equal(fs.existsSync(f.runsDir), false, 'a read must not mkdir');
  a.writeScheduleRunResult(f.runsDir, f.input, f.log);
  const name = f.records()[0];
  assert.equal(a.readScheduleRunResults(f.runsDir, []).size, 0);
  for (const content of ['{"v":', '{}', 'null']) {
    fs.writeFileSync(path.join(f.runsDir, name), content);
    assert.deepEqual(a.readScheduleRunResults(f.runsDir, [f.input.sessionId]).get(f.input.sessionId), { unreadable: true });
  }
});

test('atomic replacement publishes complete JSON, keeps the first write, and removes temporary files on error', t => {
  const f = fixture(t), a = api();
  let renamed = false;
  const rename = (from, to) => {
    assert.equal(path.dirname(from), f.runsDir);
    assert.equal(fs.existsSync(to), false, 'no partial destination is visible');
    assert.equal(JSON.parse(fs.readFileSync(from, 'utf8')).exitCode, 2);
    fs.renameSync(from, to);
    renamed = true;
  };
  a.writeScheduleRunResult(f.runsDir, f.input, f.log, { rename });
  assert.equal(renamed, true);
  a.writeScheduleRunResult(f.runsDir, { ...f.input, code: 99, endedAtMs: 200000 }, f.log);
  assert.equal(f.read()[0].exitCode, 2, 'duplicate completion keeps the first record');
  a.writeScheduleRunResult(f.runsDir, { ...f.input, sessionId: crypto.randomUUID() }, f.log, { rename: () => { throw new Error('rename failed'); } });
  assert.equal(f.records().length, 1);
  assert.equal(fs.readdirSync(f.runsDir).length, 1, 'no temporary or lock files survive failure');
  assert.ok(f.warnings.length, 'write failure is logged');
});

test('write failure never changes launcher acknowledgement or exit notice', async t => {
  const h = launcher(t);
  fs.writeFileSync(h.runsDir, 'not a directory');
  assert.equal((await h.run()).ok, true);
  assert.doesNotThrow(() => h.children[0].emit('exit', 2));
  assert.equal(h.messages[0][1].code, 2);
  assert.equal(h.done, 1);
  assert.ok(h.warnings.length, 'failed persistence warns');
});
