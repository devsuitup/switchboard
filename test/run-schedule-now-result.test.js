'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { extractFunction } = require('./app-source');

function setup(t, { sandbox = false, platform = 'linux', refused = [], spawnError, syncError, archived = false, noReply = false, deferSpawn = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-run-result-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.claude', 'commands', 'schedule-test.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: test\n---\nDo the task');
  const handlers = new Map(), children = [], events = [];
  const log = { info() {}, warn() {}, error() {} };
  const ctx = vm.createContext({
    getSetting: () => ({}), isProjectSettingsArchived: () => archived,
    SETTING_DEFAULTS: { shellProfile: 'test', sandbox: false },
    resolveShell: () => ({ path: 'test-shell' }),
    quoteArgvForShell: (_shell, args) => args.join(' '), shellArgs: (_shell, cmd) => [cmd],
    cleanPtyEnv: {}, resolveScheduleSandbox: () => sandbox, process: { platform },
    sandboxScriptPath: () => '/sandbox.sh', scheduleProjects: () => ({ list: async () => [root] }),
    scheduleBindRefusals: () => refused, os, sandboxBindEnv: () => '', encodeProjectPath: () => 'project',
    cpSpawn: () => {
      if (syncError) throw new Error(syncError);
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push(child);
      if (!deferSpawn) queueMicrotask(() => {
        events.push(spawnError ? 'error' : 'spawn');
        child.emit(spawnError ? 'error' : 'spawn', ...(spawnError ? [new Error(spawnError)] : []));
      });
      return child;
    },
    cliSessionState: { trackScheduleRun() {} }, activityReporter: { sessionStarted() {}, sessionEnded() {} }, log,
  });
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  vm.runInContext(extractFunction(main.replace(/^    (async )?function runScheduleCommand/m, '$1function runScheduleCommand'), 'runScheduleCommand'), ctx);
  const localRequire = createRequire(path.join(__dirname, '../schedule-ipc.js'));
  const ipc = vm.createContext({
    require: name => name === 'electron' ? { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
      : name === './schedule-runner' ? {
        parseFrontmatter: localRequire(name).parseFrontmatter,
        createScheduleSession: () => ({ sessionId: 'manual-session' }),
        buildScheduleCommand: () => ({ claudeArgs: ['--resume', 'manual-session', '--add-dir', '/refused'] }),
      } : localRequire(name),
    module: { exports: {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../schedule-ipc.js'), 'utf8'), ipc);
  ipc.module.exports.init(log, noReply ? async () => undefined : ctx.runScheduleCommand, () => true, () => false);
  return { run: () => handlers.get('run-schedule-now')(null, file), children, events };
}

test('Run now returns a Linux sandbox refusal with recovery and never spawns', async t => {
  const h = setup(t, { sandbox: true, platform: 'win32' });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /sandbox.*Linux/i);
  assert.match(result.error, /disable.*sandbox|turn.*sandbox.*off/i);
  assert.equal(h.children.length, 0);
});

test('Run now returns refused add-dirs with the offending path and recovery', async t => {
  const h = setup(t, { sandbox: true, refused: [{ dir: '/refused', reason: 'protected path' }] });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /add-dirs.*\/refused.*protected path/i);
  assert.match(result.error, /remove|change/i);
  assert.equal(h.children.length, 0);
});

test('Run now returns a late archive refusal from the launcher', async t => {
  const h = setup(t, { archived: true });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /archived.*unarchive/i);
  assert.equal(h.children.length, 0);
});

test('Run now returns a synchronous spawn failure with recovery', async t => {
  const h = setup(t, { syncError: 'spawn EACCES' });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /spawn EACCES/);
  assert.match(result.error, /shell.*project.*Run now/i);
});

test('Run now returns an asynchronous spawn error before answering IPC', async t => {
  const h = setup(t, { spawnError: 'spawn ENOENT' });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /spawn ENOENT/);
  assert.match(result.error, /shell.*project.*Run now/i);
  assert.deepEqual(h.events, ['error']);
});

test('Run now acknowledges success only after the child spawn event', async t => {
  const h = setup(t, { deferSpawn: true });
  let answered = false;
  const pending = h.run().then(result => { answered = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(answered, false, 'IPC must wait for the spawn acknowledgement');
  h.children[0].emit('spawn');
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'manual-session');
  h.children[0].emit('exit', 1);
  assert.equal(result.ok, true);
});

test('Run now refuses a missing launcher acknowledgement', async t => {
  const h = setup(t, { noReply: true });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.match(result.error, /no.*result|no.*reply|acknowledg/i);
});
