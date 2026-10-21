'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');
const { extractFunction } = require('./app-source');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
const updaterIndex = ast.body.findIndex(node => node.type === 'VariableDeclaration' &&
  node.declarations.some(declaration => declaration.id.name === 'autoUpdater'));
assert.ok(updaterIndex >= 0);
const updaterInit = source.slice(ast.body[updaterIndex].range[0], ast.body[updaterIndex + 1].range[1]);
const startup = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'startApplication');
const settingsHandler = startup.body.body.find(node => node.type === 'ExpressionStatement' &&
  node.expression.callee?.object?.name === 'ipcMain' && node.expression.arguments[0]?.value === 'set-setting');
assert.ok(settingsHandler);

function findStartupBlock(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'IfStatement' && node.test.type === 'Identifier' && node.test.name === 'autoUpdater' &&
      node.range[0] > source.indexOf('// Check for updates after launch')) return node;
  for (const value of Object.values(node)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      const found = findStartupBlock(child);
      if (found) return found;
    }
  }
  return null;
}

const startupBlock = findStartupBlock(ast);
assert.ok(startupBlock);

function setup(stored, { packaged = true, defaults = SETTING_DEFAULTS } = {}) {
  const handlers = new Map();
  const events = new Map();
  const logs = [];
  const checks = [];
  const timers = [];
  let settings = stored;
  const updater = {
    allowPrerelease: true,
    allowDowngrade: false,
    on: (event, callback) => events.set(event, callback),
    checkForUpdates: async () => { checks.push(updater.allowPrerelease); },
  };
  const context = vm.createContext({
    app: { isPackaged: packaged },
    process: { env: {} },
    require: name => {
      if (name === 'electron') return { autoUpdater: { on() {} } };
      assert.equal(name, 'electron-updater');
      return { autoUpdater: updater };
    },
    SETTING_DEFAULTS: { ...defaults },
    getSetting: key => { assert.equal(key, 'global'); return settings; },
    setSetting: (key, value) => { if (key === 'global') settings = value; },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    log: { info: message => logs.push(message), error: () => {} },
    mainWindow: null, quitAttemptToken: null, updateInstallPromise: null, updateWaitTimer: null,
    updateInstalling: false, activityFlushedForQuit: false, unsavedGuard: { invalidate() {} }, clearTimeout,
    setTimeout: callback => timers.push(callback),
    setInterval: callback => timers.push(callback),
  });
  vm.runInContext(updaterInit, context, { filename: 'main.js' });
  vm.runInContext(extractFunction(source, 'resetUpdateAttempt'), context);
  vm.runInContext(extractFunction(source, 'applyUpdateChannel'), context, { filename: 'main.js' });
  vm.runInContext(source.slice(...settingsHandler.range), context, { filename: 'main.js' });
  vm.runInContext(source.slice(...startupBlock.range), context, { filename: 'main.js' });
  return { updater, logs, checks, timers, save: (key, value) => handlers.get('set-setting')(null, key, value) };
}

for (const receiveBetaVersions of [undefined, false, true]) {
  test(`startup applies beta setting ${receiveBetaVersions} before scheduled checks and logs the channel`, async () => {
    const ctx = setup(receiveBetaVersions === undefined ? null : { receiveBetaVersions });
    const expected = receiveBetaVersions ?? SETTING_DEFAULTS.receiveBetaVersions;
    assert.equal(ctx.updater.allowPrerelease, expected);
    assert.ok(ctx.logs.includes(`[updater] channel: ${expected ? 'beta' : 'stable'}`));
    assert.equal(ctx.timers.length, 2);
    for (const timer of ctx.timers) await timer();
    assert.deepEqual(ctx.checks, [expected, expected]);
    assert.equal(ctx.updater.allowDowngrade, false);
  });
}

test('startup resolves a missing channel from SETTING_DEFAULTS', () => {
  const ctx = setup({}, { defaults: { ...SETTING_DEFAULTS, receiveBetaVersions: true } });
  assert.equal(ctx.updater.allowPrerelease, true);
});

test('saving global settings switches both ways and missing values restore the default', async () => {
  const ctx = setup({ receiveBetaVersions: false });
  (await ctx.save('global', { receiveBetaVersions: true }));
  assert.equal(ctx.updater.allowPrerelease, true);
  (await ctx.save('project:/example', { receiveBetaVersions: false }));
  assert.equal(ctx.updater.allowPrerelease, true);
  (await ctx.save('global', { receiveBetaVersions: false }));
  assert.equal(ctx.updater.allowPrerelease, false);
  (await ctx.save('global', { receiveBetaVersions: true }));
  (await ctx.save('global', {}));
  assert.equal(ctx.updater.allowPrerelease, SETTING_DEFAULTS.receiveBetaVersions);
  assert.equal(ctx.updater.allowDowngrade, false);
});

test('beta applies even when automatic checks are disabled', async () => {
  const ctx = setup({ receiveBetaVersions: true, autoUpdate: false });
  assert.equal(ctx.updater.allowPrerelease, true);
  assert.equal(ctx.updater.autoDownload, false);
  assert.equal(ctx.updater.autoInstallOnAppQuit, false);
  assert.equal(ctx.timers.length, 0);
  (await ctx.save('global', { receiveBetaVersions: false, autoUpdate: false }));
  assert.equal(ctx.updater.allowPrerelease, false);
});

test('saving the channel without a packaged updater remains available', async () => {
  const ctx = setup({}, { packaged: false });
  assert.equal((await ctx.save('global', { receiveBetaVersions: true })).ok, true);
  assert.deepEqual(ctx.logs, []);
  assert.equal(ctx.timers.length, 0);
});
