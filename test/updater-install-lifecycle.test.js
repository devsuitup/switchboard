'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const espree = require('espree');
const { extractFunction } = require('./app-source');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');
const { createUnsavedGuard } = require('../src/main/app/unsaved-guard');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
const updaterIndex = ast.body.findIndex(node => node.type === 'VariableDeclaration' &&
  node.declarations.some(declaration => declaration.id.name === 'autoUpdater'));
const startup = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'startApplication');
const install = startup.body.body.find(node => node.expression?.callee?.object?.name === 'ipcMain' &&
  node.expression.arguments[0]?.value === 'updater-install');
const quit = startup.body.body.findLast(node => node.expression?.callee?.object?.name === 'app' &&
  node.expression.callee.property.name === 'on' && node.expression.arguments[0]?.value === 'before-quit');

function setup(behavior) {
  const updater = new EventEmitter();
  const nativeUpdater = new EventEmitter();
  const calls = [];
  const handlers = new Map();
  const context = vm.createContext({
    app: { isPackaged: true, on: (name, handler) => handlers.set(name, handler), exit: () => calls.push('exit') },
    process: { env: {} },
    SETTING_DEFAULTS,
    require: name => ({ autoUpdater: name === 'electron' ? nativeUpdater : updater }),
    log: { info() {}, error() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    mainWindow: null, quitAttemptToken: null, updateInstallPromise: null, updateWaitTimer: null,
    setTimeout, clearTimeout, activityFlushedForQuit: false, updateInstalling: false,
    shutdownComplete: false, nonDatabaseResourcesStopped: false,
    unsavedGuard: { invalidate() {}, beforeQuit: () => { calls.push('guard'); return false; } },
    drainForUpdate: async () => { calls.push('drain'); context.activityFlushedForQuit = true; },
    shutdownForExit: async () => {
      calls.push('shutdown');
      if (context.updateInstalling) context.stopNonDatabaseResources(true);
      context.shutdownComplete = true;
    },
    exitOnce: () => calls.push('exit'),
    stopScheduler: () => calls.push('scheduler'), mainLoopMonitor: { stop: () => calls.push('monitor') },
    shutdownAllMcp: () => calls.push('mcp'), localTranscriptTracker: { dispose() {} },
    unsubscribeTaskJobs() {}, taskRecords: { dispose() {} },
    projectsWatcher: { close: () => calls.push('watcher') }, cliSessionState: { stop() {} },
    bgAgents: { stop() {} }, remoteIndexer: { dispose: () => calls.push('indexer') },
    remoteWatcher: { stopAll() {} }, remoteActivityTracker: { dispose() {} },
    activityTrace: { close: () => calls.push('trace') },
  });
  updater.quitAndInstall = () => { calls.push('install'); return behavior(updater); };
  vm.runInContext(source.slice(ast.body[updaterIndex].range[0], ast.body[updaterIndex + 1].range[1]), context);
  vm.runInContext(extractFunction(source, 'stopNonDatabaseResources'), context);
  if (source.includes('function resetUpdateAttempt(')) vm.runInContext(extractFunction(source, 'resetUpdateAttempt'), context);
  vm.runInContext(source.slice(...install.range), context);
  vm.runInContext(source.slice(...quit.range), context);
  return { calls, context, nativeUpdater, updater, install: () => handlers.get('updater-install')(), quit: () => {
    handlers.get('before-quit')({ preventDefault: () => calls.push('prevent') });
  } };
}

test('a silent second install after an asynchronous failure keeps normal quit draining writes', async () => {
  let attempts = 0;
  const ctx = setup(updater => {
    if (++attempts === 1) setImmediate(() => updater.emit('error', new Error('installer spawn failed')));
  });
  await ctx.install();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.context.updateInstalling, false);
  await ctx.install();
  assert.deepEqual(ctx.calls, ['drain', 'install', 'drain', 'install']);
  assert.equal(ctx.context.updateInstalling, false);
  ctx.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ctx.calls, ['drain', 'install', 'drain', 'install', 'guard', 'prevent', 'shutdown', 'exit']);
});

for (const failure of ['error event', 'throw']) {
  test(`failed update (${failure}) keeps services running and a later quit uses normal shutdown`, async () => {
    const ctx = setup(updater => {
      if (failure === 'throw') throw new Error('installer failed');
      updater.emit('error', new Error('installer failed'));
      return undefined;
    });
    if (failure === 'throw') await assert.rejects(ctx.install(), /installer failed/);
    else await ctx.install();
    assert.deepEqual(ctx.calls, ['drain', 'install'], 'failed install must leave all services running');
    assert.equal(ctx.context.updateInstalling, false);
    assert.equal(ctx.context.activityFlushedForQuit, false);
    ctx.quit();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ctx.calls, ['drain', 'install', 'guard', 'prevent', 'shutdown', 'exit']);
  });
}

test('successful install stops services only on before-quit, once', async () => {
  const ctx = setup(() => undefined);
  await ctx.install();
  assert.deepEqual(ctx.calls, ['drain', 'install']);
  ctx.nativeUpdater.emit('before-quit-for-update');
  ctx.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ctx.calls, ['drain', 'install', 'prevent', 'shutdown', 'scheduler', 'monitor', 'mcp', 'watcher', 'indexer', 'trace', 'exit']);
  ctx.quit();
  assert.equal(ctx.calls.filter(call => call === 'mcp').length, 1);
  assert.equal(ctx.calls.filter(call => call === 'shutdown').length, 1);
});

test('A6 installer failures release consent and launches, native macOS close is approved, deferred install is bounded', async () => {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (const failure of ['silent false', 'linux false', 'throw', 'error event', 'mac deferred', 'mac error', 'mac success']) {
    const platform = failure.startsWith('mac') ? 'darwin' : failure === 'linux false' ? 'linux' : 'win32';
    const ctx = setup(updater => {
      updater.quitAndInstallCalled = failure !== 'silent false';
      if (failure === 'throw') throw new Error('failed');
      if (failure.includes('error')) updater.emit('error', new Error('failed'));
    });
    ctx.context.process.platform = platform;
    const timers = [];
    ctx.context.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; };
    ctx.context.clearTimeout = timer => { if (timer) timer.cleared = true; };
    const ipcMain = new EventEmitter();
    const sent = [];
    const wc = new EventEmitter();
    Object.assign(wc, { send: (channel, ...args) => sent.push({ channel, args }), isDestroyed: () => false, isCrashed: () => false });
    const win = new EventEmitter();
    Object.assign(win, { webContents: wc, isDestroyed: () => false, close() {}, destroy() {} });
    const guard = createUnsavedGuard({ ipcMain, quit() {}, inventory: () => ({ rows: [], counts: {}, remote: {} }) });
    guard.attach(win);
    ctx.context.unsavedGuard = guard;
    ctx.context.mainWindow = win;
    ctx.updater.install = () => false;
    if (platform === 'win32') ctx.updater.quitAndInstallCalled = true;
    const installing = ctx.install();
    const check = sent.find(m => m.channel === 'unsaved-check');
    assert.ok(check, 'Restart checks the editor before draining');
    assert.deepEqual(ctx.calls, []);
    ipcMain.emit('unsaved-check-result', { sender: wc }, check.args[0], true, check.args[2]);
    if (failure === 'throw') await assert.rejects(installing, /failed/);
    else await installing;
    if (failure === 'mac success') {
      const close = { prevented: false, preventDefault() { this.prevented = true; } };
      win.emit('close', close);
      assert.equal(close.prevented, false);
      ctx.nativeUpdater.emit('before-quit-for-update'); ctx.quit(); await tick();
      assert.equal(sent.filter(m => m.channel === 'unsaved-check').length, 1);
      assert.equal(ctx.calls.filter(c => c === 'shutdown').length, 1);
      continue;
    }
    if (failure === 'mac deferred') {
      assert.equal(guard.launchAllowed(), false, 'deferred native install holds the launch gate');
      assert.equal(timers.filter(t => t.ms === 30000).length, 1, 'native fetch has a release bound');
      timers.find(t => t.ms === 30000).fn();
    }
    assert.equal(guard.launchAllowed(), true, failure + ': failed install releases launches');
    assert.equal(guard.committedToken(win), null, 'no stale Stop consent');
    assert.ok(sent.some(m => m.channel === 'exit-attempt-invalidated'), 'renderer unload approval is revoked');
    if (failure.includes('error')) assert.equal(ctx.updater.quitAndInstallCalled, false);
    const again = guard.confirmQuit(win);
    const next = sent.filter(m => m.channel === 'unsaved-check').at(-1);
    assert.notEqual(next.args[0], check.args[0], 'next user exit asks again');
    ipcMain.emit('unsaved-check-result', { sender: wc }, next.args[0], false, next.args[2]);
    assert.equal(await again, false);
  }
});
