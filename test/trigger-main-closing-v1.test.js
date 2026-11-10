'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const espree = require('espree');

const filename = path.resolve(__dirname, '../main.js');
const source = fs.readFileSync(filename, 'utf8');
const nativeRequire = createRequire(filename);

function shippedWiring(t) {
  const ast = espree.parse(source, { ecmaVersion: 2024, sourceType: 'commonjs', range: true });
  const startup = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'startApplication').body.body;
  const declares = (node, name) => (node.type === 'VariableDeclaration' && node.declarations.some(d => d.id.name === name))
    || (node.type === 'FunctionDeclaration' && node.id.name === name);
  const find = name => ast.body.find(node => declares(node, name)) || startup.find(node => declares(node, name));
  const assignment = name => ast.body.concat(startup).find(node => node.type === 'ExpressionStatement' && node.expression.left?.name === name);

  const ipcMain = new EventEmitter(); const handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn); ipcMain.removeHandler = name => handlers.delete(name);
  const wc = new EventEmitter(); wc.mainFrame = {}; wc.isDestroyed = () => false; wc.isCrashed = () => false; wc.send = () => {};
  const win = new EventEmitter(); win.webContents = wc; win.isDestroyed = () => false;
  const unsavedGuardModule = nativeRequire('./src/main/app/unsaved-guard');
  const context = vm.createContext({
    ipcMain, mainWindow: win, autoUpdater: null, clearTimeout, setTimeout,
    createUnsavedGuard: options => unsavedGuardModule.createUnsavedGuard({ ...options, timeoutMs: 20 }),
    require: request => request === './src/main/app/unsaved-guard' ? unsavedGuardModule : nativeRequire(request),
    getTriggerProjectSnapshot() {}, getCachedSession() {}, getCachedFolder() {}, PROJECTS_DIR: '', writer: {}, cliSessionState: {},
    remoteIndexer: {}, killPty() {}, isRemoteFolder() {}, app: { quit() {} },
  });
  const nodes = ['activeSessions', 'suspendTriggerActions', 'restoreTriggerActions', 'updateInstalling', 'activityFlushedForQuit', 'quitAttemptToken',
    'updateInstallPromise', 'updateWaitTimer', 'unsavedGuard', 'triggerRendererBridge', 'triggerLifecycleDeps', 'resetUpdateAttempt']
    .map(find);
  nodes.splice(nodes.indexOf(find('triggerRendererBridge')) + 1, 0, assignment('suspendTriggerActions'), assignment('restoreTriggerActions'));
  for (const node of nodes) {
    assert.ok(node, 'the shipped bootstrap declares every wiring edge');
    vm.runInContext(source.slice(...node.range), context, { filename });
  }
  const run = expression => vm.runInContext(expression, context);
  const bridge = run('triggerRendererBridge'); const guard = run('unsavedGuard');
  t.after(() => bridge.dispose());
  bridge.attach(win);
  guard.attach(win);
  handlers.get('trigger-actions-ready')({ sender: wc, senderFrame: wc.mainFrame });
  return { run, bridge, guard, win, deps: () => run('triggerLifecycleDeps()') };
}

test('the shipped guard, broker and update reset cancel old actions and restore availability on rollback', async t => {
  const w = shippedWiring(t);
  const deps = w.deps();
  assert.equal(typeof deps.captureAuthority, 'function', 'main supplies the action capture');
  const authority = deps.captureAuthority();
  const oldReady = await deps.broker.waitForReady(Date.now() + 100);
  assert.equal(oldReady.ok, true);
  assert.equal(authority.valid(), true);

  await w.guard.approveQuit(w.win);
  assert.equal(deps.launchAllowed(), false);
  assert.equal(authority.valid(), false);
  assert.equal((await deps.broker.waitForReady(Date.now() + 5)).ok, false);

  w.run('resetUpdateAttempt()');
  assert.equal(deps.launchAllowed(), true);
  assert.equal(authority.valid(), false, 'the cancelled action stays cancelled after the rollback');
  assert.equal(deps.captureAuthority().valid(), true, 'a new action starts valid');
  const fresh = await deps.broker.waitForReady(Date.now() + 100);
  assert.equal(fresh.ok, true, 'the surviving document serves triggers again');
  assert.equal(fresh.validate().ok, true);
  assert.equal(oldReady.validate().ok, false, 'readiness obtained before the commitment stays invalid');
});
