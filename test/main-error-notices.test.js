'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { setupSidebarDom } = require('./dom-setup');
const { installMainErrorHandlers } = require('../src/main/app/main-error-handlers');

test('process errors cross the real preload bridge into persistent dismissible B8 alerts', t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  let api;
  const ipc = new EventEmitter();
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
    ipcRenderer: ipc,
  };
  const preloadPath = path.join(__dirname, '..', 'preload.js');
  vm.runInNewContext(fs.readFileSync(preloadPath, 'utf8'), { process: { platform: process.platform, argv: [] }, require: name => {
    assert.equal(name, 'electron');
    return electron;
  } }, { filename: preloadPath });
  assert.equal(typeof dom.window.api._mainProcessErrorCb, 'function', 'B8 must subscribe to main process errors');
  assert.equal(api.onMainProcessError(dom.window.api._mainProcessErrorCb), undefined, 'subscription must not return the private IPC emitter');
  const target = new EventEmitter();
  const logs = [];
  const handlers = installMainErrorHandlers({ target, log: { error: (...args) => logs.push(args) }, notify: notice => ipc.emit('main-process-error', { sender: 'main' }, notice) });
  t.after(() => handlers.dispose());
  target.emit('uncaughtException', new Error('<img src=x onerror=alert(1)>'));
  target.emit('unhandledRejection', new Error('rejected operation'), Promise.resolve());
  target.emit('unhandledRejection', new Error('rejected operation'), Promise.resolve());
  assert.equal(logs.length, 3);
  const alerts = dom.document.querySelectorAll('#app-notices [role="alert"]');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].textContent, /Uncaught exception.*<img/);
  assert.equal(alerts[0].querySelector('img'), null);
  assert.match(alerts[0].textContent, /Unhandled rejection.*rejected operation/);
  assert.match(alerts[0].textContent, /2 occurrences/);
  assert.equal(alerts[0].querySelector('.app-notice-action').textContent, 'Open log');
  assert.equal(dom.read('[...appNoticeEntries.values()].every(entry => entry.timer === null)'), true);
  alerts[0].querySelector('.app-notice-dismiss').click();
  assert.equal(dom.document.querySelectorAll('#app-notices [role="alert"]').length, 0);
});

test('main registers before readiness and flushes only after renderer loading', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const registration = source.indexOf("require('./src/main/app/main-error-handlers').installMainErrorHandlers(");
  assert.ok(registration >= 0);
  assert.ok(registration < source.indexOf('app.whenReady()'));
  assert.match(source, /if \(!mainErrorWindowReady \|\| !mainWindow \|\| mainWindow\.isDestroyed\(\) \|\| mainWindow\.webContents\.isDestroyed\(\)\) return false;/);
  assert.match(source, /mainWindow\.webContents\.send\('main-process-error', notice\)/);
  assert.match(source, /'did-start-navigation', \(_event, _url, isSameDocument, isMainFrame\) => \{\s*if \(isMainFrame && !isSameDocument\) mainErrorWindowReady = false;/);
  assert.doesNotMatch(source, /'did-start-loading', \(\) => \{ mainErrorWindowReady = false; \}/);
  assert.match(source, /'closed', \(\) => \{\s*mainErrorWindowReady = false;/);
  assert.match(source, /'did-finish-load', \(\) => \{\s*mainErrorWindowReady = true;\s*mainErrorHandlers\.flushNotices\(\);/);
});

test('renderer death stops sending until the renderer finishes loading again', () => {
  const sourcePath = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const registration = source.match(/mainWindow\.webContents\.on\('render-process-gone',[\s\S]*?\}\);/);
  assert.ok(registration, 'renderer death must reset notice readiness');
  const webContents = new EventEmitter();
  const context = vm.createContext({ mainWindow: { webContents }, mainErrorWindowReady: true });
  vm.runInContext(registration[0], context, { filename: sourcePath });
  webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(context.mainErrorWindowReady, false);
});

test('only a new main-frame document resets notice readiness', () => {
  const sourcePath = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const registration = source.match(/mainWindow\.webContents\.on\('did-start-navigation',[\s\S]*?\}\);/);
  assert.ok(registration, 'main-frame navigation must own notice readiness');
  const webContents = new EventEmitter();
  const context = vm.createContext({ mainWindow: { webContents }, mainErrorWindowReady: true });
  vm.runInContext(registration[0], context, { filename: sourcePath });
  webContents.emit('did-start-navigation', {}, 'mermaid', false, false);
  assert.equal(context.mainErrorWindowReady, true);
  webContents.emit('did-start-navigation', {}, '#anchor', true, true);
  assert.equal(context.mainErrorWindowReady, true);
  webContents.emit('did-start-navigation', {}, 'index.html', false, true);
  assert.equal(context.mainErrorWindowReady, false);
});

test('queued errors flush into one bounded group with five recent distinct messages', t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  let ready = false;
  const target = new EventEmitter();
  const handlers = installMainErrorHandlers({ target, log: { error() {} }, notify: notice => {
    if (!ready) return false;
    dom.window.api._mainProcessErrorCb(notice);
  } });
  t.after(() => handlers.dispose());
  for (let i = 0; i < 110; i++) target.emit('uncaughtException', new Error(`error-${i}`));
  ready = true;
  handlers.flushNotices();
  assert.equal(dom.document.querySelectorAll('#app-notices [role="alert"]').length, 1);
  assert.equal(dom.read("appNoticeEntries.get('main-process-errors').options.members.length"), 5);
  const alert = dom.document.querySelector('[role="alert"]');
  assert.doesNotMatch(alert.textContent, /error-104\b/);
  assert.match(alert.textContent, /error-105\b/);
  assert.match(alert.textContent, /error-109\b/);
  assert.match(alert.textContent, /earlier errors/);
});

test('Open log traverses the renderer, preload and fixed-path main handler with path validation', async t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  const sourcePath = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const registration = source.match(/^ipcMain\.handle\('open-main-log',[\s\S]*?^\}\);/m);
  assert.ok(registration, 'Open log needs a dedicated main IPC handler');
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'main-log-896b-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let logPath = path.join(temp, 'main.log');
  fs.writeFileSync(logPath, 'test log');
  const opened = [];
  let handler;
  let openError = '';
  const context = {
    ipcMain: { handle: (channel, cb) => { assert.equal(channel, 'open-main-log'); handler = cb; } },
    log: { transports: { file: { getFile: () => ({ path: logPath }) } } },
    path, isSensitivePath: require('../ipc-path-validator').isSensitivePath,
    shell: { openPath: async value => { opened.push(value); return openError; } },
  };
  vm.runInNewContext(registration[0], context, { filename: sourcePath });
  const ipc = new EventEmitter();
  ipc.invoke = (channel, ...args) => {
    assert.equal(channel, 'open-main-log');
    assert.deepEqual(args, [], 'renderer must not choose a file path');
    return handler({});
  };
  const preloadPath = path.join(__dirname, '..', 'preload.js');
  vm.runInNewContext(fs.readFileSync(preloadPath, 'utf8'), {
    process: { platform: process.platform, argv: [] },
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, api) => { dom.window.api.openMainLog = api.openMainLog; } } }),
  }, { filename: preloadPath });
  dom.window.api._mainProcessErrorCb({ id: 'main-error:test', kind: 'error', count: 1, message: 'Uncaught exception: failed' });
  const action = dom.document.querySelector('.app-notice-action');
  assert.ok(action, 'error notice must offer Open log');
  assert.equal(action.textContent, 'Open log');
  action.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [logPath]);
  assert.ok(dom.document.querySelector('[role="alert"]'), 'opening the log keeps the error visible');
  openError = 'No application associated';
  action.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(dom.document.getElementById('app-notices').textContent, /No application associated/);
  for (const invalid of [null, '', 'relative.log', path.join(temp, '.ssh', 'key')]) {
    logPath = invalid;
    assert.equal((await handler({}, path.join(temp, 'injected.log'))).ok, false);
  }
  assert.equal(opened.length, 2, 'invalid log paths must never reach shell.openPath');
  logPath = path.join(temp, 'main.log');
  context.shell.openPath = async () => { throw new Error('opener unavailable'); };
  assert.match((await handler({})).error, /opener unavailable/);
});
