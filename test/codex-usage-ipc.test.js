'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');

test('main IPC enforces opt-in from saved settings and invalidates a request on Save', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ipc-1139-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({ tokens: { access_token: 'FAKE-IPC-TOKEN' } }));
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('const codexUsage =');
  assert.ok(start >= 0, 'main registers the opt-in service');
  const registration = source.slice(start, source.indexOf("ipcMain.handle('get-usage'", start));
  const saveStart = source.indexOf("ipcMain.handle('set-setting'");
  const saveEnd = source.indexOf('\n});', saveStart) + 4;
  const handlers = new Map();
  let settings = {}, calls = 0, reads = 0, resolve, signal;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file) === auth) { reads++; assert.equal(settings.showCodexUsage, true, 'off may not read auth'); }
    return read(file, ...args);
  });
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    calls++;
    assert.equal(settings.showCodexUsage, true, 'off may not call endpoint');
    signal = options.signal;
    return new Promise(done => { resolve = done; });
  });
  const context = vm.createContext({
    require: createRequire(filename), SETTING_DEFAULTS,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    getSetting: () => settings,
    setSetting: async (_key, value) => { settings = value; },
    applyUpdateChannel() {}, restartHarnessWatchers() {}, notifyRendererProjectsChanged() {},
  });
  vm.runInContext(registration, context, { filename });
  t.after(() => vm.runInContext('codexUsage.settingsChanged()', context));
  vm.runInContext(source.slice(saveStart, saveEnd), context, { filename });
  const usage = handlers.get('get-codex-usage');
  const save = value => handlers.get('set-setting')(null, 'global', value);
  assert.deepEqual(await usage(), {});
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  await save({ showCodexUsage: 'true' });
  assert.deepEqual(await usage(), {});
  assert.equal(reads, 0);
  await save({ showCodexUsage: true });
  const pending = usage();
  assert.equal(calls, 1);
  await save({ showCodexUsage: false });
  assert.equal(signal.aborted, true);
  resolve({ ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 10 } } }) });
  assert.deepEqual(await pending, {});
  assert.deepEqual(await usage(), {});
  assert.equal(reads, 1);
  assert.equal(calls, 1);
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  assert.match(preload, /getCodexUsage:\s*\(\)\s*=>\s*ipcRenderer.invoke\('get-codex-usage'\)/);
});
