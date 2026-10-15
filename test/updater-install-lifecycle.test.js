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
  const calls = [];
  const handlers = new Map();
  const context = vm.createContext({
    app: { isPackaged: true, on: (name, handler) => handlers.set(name, handler), exit: () => calls.push('exit') },
    process: { env: {} },
    SETTING_DEFAULTS,
    require: () => ({ autoUpdater: updater }),
    log: { info() {}, error() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    mainWindow: null, activityFlushedForQuit: false, updateInstalling: false,
    shutdownComplete: false, nonDatabaseResourcesStopped: false,
    unsavedGuard: { beforeQuit: () => { calls.push('guard'); return false; } },
    drainForUpdate: async () => { calls.push('drain'); context.activityFlushedForQuit = true; },
    shutdownForExit: async () => { calls.push('shutdown'); },
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
  vm.runInContext(source.slice(...install.range), context);
  vm.runInContext(source.slice(...quit.range), context);
  return { calls, context, install: () => handlers.get('updater-install')(), quit: () => {
    handlers.get('before-quit')({ preventDefault: () => calls.push('prevent') });
  } };
}

for (const failure of ['error event', 'false return', 'throw']) {
  test(`failed update (${failure}) keeps services running and a later quit uses normal shutdown`, async () => {
    const ctx = setup(updater => {
      if (failure === 'throw') throw new Error('installer failed');
      if (failure === 'false return') return false;
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
  ctx.quit();
  assert.deepEqual(ctx.calls, ['drain', 'install', 'scheduler', 'monitor', 'mcp', 'watcher', 'indexer', 'trace']);
  ctx.quit();
  assert.equal(ctx.calls.filter(call => call === 'mcp').length, 1);
  assert.ok(!ctx.calls.includes('shutdown'));
});
