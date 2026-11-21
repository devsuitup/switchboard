'use strict';

const test = require('node:test');
require('./fixtures/isolated-codex-home.cjs')(test);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');

const ID = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';

test('settings know the disabled CLI list and the Codex launch options', () => {
  assert.deepEqual(SETTING_DEFAULTS.disabledHarnesses, []);
  for (const key of ['codexSandbox', 'codexApproval', 'codexModel', 'codexEffort']) assert.equal(SETTING_DEFAULTS[key], '', key);
});

test('the writer refuses a global patch that switches every CLI off', () => {
  const { assertHarnessSettings, enabledHarnesses, allHarnesses } = require('../harnesses');
  const ids = allHarnesses().map(h => h.id);
  assert.ok(ids.includes('claude') && ids.includes('codex'));
  assert.throws(() => assertHarnessSettings({ disabledHarnesses: ids }), /at least one CLI/i);
  assert.deepEqual(assertHarnessSettings({ disabledHarnesses: ['codex', 'unknown'] }).disabledHarnesses, ['codex', 'unknown']);
  assert.deepEqual(assertHarnessSettings({}), {});
  assert.throws(() => assertHarnessSettings({ disabledHarnesses: 'codex' }), /disabledHarnesses/);
  assert.deepEqual(enabledHarnesses(['codex']).map(h => h.id), ['claude']);
  assert.deepEqual(enabledHarnesses(undefined).map(h => h.id), ids);
  const { createWriterCommands } = require('../session-index-commands');
  const store = new Map([['global', { disabledHarnesses: [] }]]);
  const db = { getSetting: key => store.get(key) ?? null, setSetting: (key, value) => store.set(key, value) };
  const commands = createWriterCommands(db);
  assert.throws(() => commands.patchGlobal({ disabledHarnesses: ids }), err => err.code === 'HARNESS_GUARD');
  commands.patchGlobal({ disabledHarnesses: ['codex'] });
  assert.deepEqual(store.get('global').disabledHarnesses, ['codex']);
  const worker = fs.readFileSync(path.join(__dirname, '../workers/session-index-writer.js'), 'utf8');
  assert.match(worker, /assertHarnessSettings\(args\[1\]\)/, 'a raw global setSetting goes through the same guard');
});

test('a switched-off CLI is neither listed nor shown, its rows are kept', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-toggle-'));
  const { home: codexHome } = require('./fixtures/isolated-codex-home.cjs')(t);
  const day = path.join(codexHome, 'sessions', '2026', '08', '26');
  fs.mkdirSync(day, { recursive: true });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(day, `rollout-2026-08-26T11-55-02-${ID}.jsonl`), [
    { timestamp: '2026-08-26T10:00:00.000Z', type: 'session_meta', payload: { id: 'root', cwd: root } },
    { timestamp: '2026-08-26T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n');
  const cache = require('../session-cache');
  const rows = new Map(), meta = new Map(), settings = new Map([['global', { disabledHarnesses: ['codex'] }]]);
  const db = {
    getCachedByFolder: key => [...rows.values()].filter(r => r.folder === key), getAllCached: () => [...rows.values()],
    getAllMeta: () => new Map(), getAllFolderMeta: () => meta, getFolderMeta: key => meta.get(key),
    getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => settings.set(key, value), getMeta: () => null, setName() {},
    isInitialScanComplete: () => true, setFolderMeta: (key, projectPath, indexMtimeMs) => meta.set(key, { folder: key, projectPath, indexMtimeMs }),
    upsertCachedSessions: fresh => fresh.forEach(r => rows.set(r.sessionId, { ...rows.get(r.sessionId), ...r })),
    deleteCachedSession: id => rows.delete(id), deleteCachedFolder() {}, deleteSearchFolder() {}, deleteSearchSession() {},
    upsertSearchEntries() {}, replaceSessionMetrics() {}, touchCachedModified() {}, setCachedFileSize() {},
  };
  cache.init({ PROJECTS_DIR: path.join(root, 'projects'), activeSessions: new Map(), getMainWindow: () => null, log: { info() {}, warn() {}, error() {} }, db });
  cache.setRemoteRoots(new Map());
  const seen = [];
  cache.reconcileCacheFromFilesystem({ onFolder: folder => seen.push(folder), throttle: false });
  assert.deepEqual(seen, [], 'a disabled CLI is not scanned');
  settings.set('global', { disabledHarnesses: [] });
  cache.reconcileCacheFromFilesystem({ throttle: false });
  assert.equal(rows.get(ID)?.runtime, 'codex');
  assert.equal(cache.buildProjectsFromCache(false).some(p => p.sessions.some(s => s.sessionId === ID)), true);
  settings.set('global', { disabledHarnesses: ['codex'] });
  assert.equal(cache.buildProjectsFromCache(false).some(p => p.sessions.some(s => s.sessionId === ID)), false, 'rows of a disabled CLI are hidden');
  assert.equal(rows.has(ID), true, 'and kept for when it is switched back on');
});

test('the "+" menu offers every enabled CLI after Claude, and launches it with its runtime', async t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const launched = [];
  h.window.launchNewSession = (project, options) => launched.push(options);
  h.window.api.getEffectiveSettings = async () => ({ permissionMode: 'auto', codexSandbox: 'workspace-write', codexApproval: '', codexEffort: 'high', codexModel: '' });
  h.window.api.getHarnesses = async () => [
    { id: 'claude', label: 'Claude', available: true, enabled: true, isDefault: true },
    { id: 'codex', label: 'Codex', available: true, enabled: true },
    { id: 'other', label: 'Other', available: true, enabled: false },
  ];
  h.evalPublic('setting-defaults.js');
  h.evalPublic('dialogs.js');
  const anchor = h.document.createElement('button');
  h.document.body.appendChild(anchor);
  h.window.showNewSessionPopover(makeSampleProject({ projectPath: '/repo' }), anchor);
  const popover = h.document.querySelector('.new-session-popover');
  assert.ok(popover);
  assert.equal(popover.querySelectorAll('.popover-option').length, 3, 'Claude entries render at once');
  await new Promise(resolve => setTimeout(resolve, 20));
  const codexBtn = popover.querySelector('.popover-option[data-runtime="codex"]');
  assert.ok(codexBtn, 'the enabled Codex CLI is offered');
  assert.equal(popover.querySelector('.popover-option[data-runtime="other"]'), null, 'a disabled CLI is not');
  assert.equal(codexBtn.nextElementSibling?.classList.contains('popover-option-terminal'), true, 'CLIs come before Terminal');
  assert.equal(codexBtn.getAttribute('role'), 'menuitem');
  codexBtn.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(launched.length, 1);
  assert.equal(launched[0].runtime, 'codex');
  assert.equal(launched[0].runtimeLabel, 'Codex');
  assert.equal(launched[0].codexSandbox, 'workspace-write');
  assert.equal(launched[0].codexEffort, 'high');
  assert.equal(launched[0].codexApproval, undefined, 'empty Codex options are not sent');
});

test('main exposes the CLI list and model catalog over IPC and restarts the harness watchers on a toggle', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('get-harnesses'/);
  assert.match(main, /ipcMain\.handle\('get-harness-models'/);
  assert.match(main, /restartHarnessWatchers\(\)/);
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  assert.match(preload, /getHarnesses: \(\) => ipcRenderer\.invoke\('get-harnesses'\)/);
  assert.match(preload, /getHarnessModels: \(runtime\) => ipcRenderer\.invoke\('get-harness-models', runtime\)/);
  const codex = require('../harnesses/codex');
  assert.equal(typeof codex.readModelCatalog, 'function');
});

test('a switched-off Claude leaves the "+" menu with the other CLIs and Terminal only, keyboard order included', async t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  h.window.api.getHarnesses = async () => [
    { id: 'claude', label: 'Claude', available: true, enabled: false, isDefault: true },
    { id: 'codex', label: 'Codex', available: true, enabled: true, isDefault: false },
  ];
  h.evalPublic('setting-defaults.js');
  h.evalPublic('dialogs.js');
  const anchor = h.document.createElement('button');
  h.document.body.appendChild(anchor);
  h.window.showNewSessionPopover(makeSampleProject({ projectPath: '/repo' }), anchor);
  await new Promise(resolve => setTimeout(resolve, 20));
  const popover = h.document.querySelector('.new-session-popover');
  assert.ok(popover && popover.isConnected, 'the menu stays open');
  assert.deepEqual([...popover.querySelectorAll('.popover-option')].map(e => e.textContent.trim()), ['Codex', 'Terminal'],
    'neither Claude entry is offered');
  const codexBtn = popover.querySelector('.popover-option[data-runtime="codex"]');
  assert.equal(h.document.activeElement, codexBtn, 'focus lands on the first remaining entry');
  codexBtn.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(h.document.activeElement.classList.contains('popover-option-terminal'), true);
  h.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(h.document.activeElement, codexBtn, 'the arrow keys cycle over the remaining entries only');
});
