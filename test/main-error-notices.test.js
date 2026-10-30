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
  assert.equal(alerts.length, 2);
  assert.match(alerts[0].textContent, /Uncaught exception.*<img/);
  assert.equal(alerts[0].querySelector('img'), null);
  assert.match(alerts[1].textContent, /Unhandled rejection.*Settings → Diagnostics/);
  assert.equal(dom.read('[...appNoticeEntries.values()].every(entry => entry.timer === null)'), true);
  alerts[0].querySelector('.app-notice-dismiss').click();
  assert.equal(dom.document.querySelectorAll('#app-notices [role="alert"]').length, 1);
});

test('main registers before readiness and flushes only after renderer loading', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const registration = source.indexOf("require('./src/main/app/main-error-handlers').installMainErrorHandlers(");
  assert.ok(registration >= 0);
  assert.ok(registration < source.indexOf('app.whenReady()'));
  assert.match(source, /if \(!mainErrorWindowReady \|\| !mainWindow \|\| mainWindow\.isDestroyed\(\) \|\| mainWindow\.webContents\.isDestroyed\(\)\) return false;/);
  assert.match(source, /mainWindow\.webContents\.send\('main-process-error', notice\)/);
  assert.match(source, /'did-start-loading', \(\) => \{ mainErrorWindowReady = false; \}/);
  assert.match(source, /'closed', \(\) => \{\s*mainErrorWindowReady = false;/);
  assert.match(source, /'did-finish-load', \(\) => \{\s*mainErrorWindowReady = true;\s*mainErrorHandlers\.flushNotices\(\);/);
});
