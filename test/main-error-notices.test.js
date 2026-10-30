'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { setupSidebarDom } = require('./dom-setup');
const { installMainErrorHandlers } = require('../src/main/app/main-error-handlers');
const createClock = require('./fixtures/main-error-clock.cjs');

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
  const clock = createClock();
  const logs = [];
  const handlers = installMainErrorHandlers({ target, ...clock, log: { error: (...args) => logs.push(args) }, notify: notice => ipc.emit('main-process-error', { sender: 'main' }, notice) });
  t.after(() => handlers.dispose());
  target.emit('uncaughtException', new Error('<img src=x onerror=alert(1)>'));
  target.emit('unhandledRejection', new Error('rejected operation'), Promise.resolve());
  target.emit('unhandledRejection', new Error('rejected operation'), Promise.resolve());
  clock.advance(1000);
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

function setupMain(t) {
  const sourcePath = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const target = new EventEmitter();
  const webContents = new EventEmitter();
  const sent = [];
  webContents.isDestroyed = () => false;
  webContents.getURL = () => 'file:///app/index.html';
  webContents.send = (...args) => sent.push(args);
  const window = { webContents, isDestroyed: () => false };
  const ipcMain = new EventEmitter();
  const clock = createClock();
  const context = vm.createContext({ log: { error() {} }, ipcMain, shell: { openExternal: async () => {} }, require: () => ({ installMainErrorHandlers: options => installMainErrorHandlers({ ...options, target, ...clock }) }) });
  const start = source.indexOf('let mainWindow = null;');
  const end = source.indexOf('let activityFlushedForQuit', start);
  assert.ok(start >= 0 && end > start && end < source.indexOf('app.whenReady()'));
  vm.runInContext(source.slice(start, end), context, { filename: sourcePath });
  t.after(() => vm.runInContext('mainErrorHandlers.dispose()', context, { filename: sourcePath }));
  context.testWindow = window;
  vm.runInContext('mainWindow = testWindow', context, { filename: sourcePath });
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/mainWindow\.webContents\.on\('(will-navigate|did-start-navigation|did-navigate|render-process-gone)'/.test(lines[i])) continue;
    let registration = lines[i];
    if (!registration.trimEnd().endsWith('});')) {
      do { registration += '\n' + lines[++i]; } while (!/^  \}\);/.test(lines[i]));
    }
    vm.runInContext(registration, context, { filename: sourcePath });
  }
  const ready = source.match(/^ipcMain\.on\('main-error-notices-ready',[\s\S]*?^\}\);/m);
  if (ready) vm.runInContext(ready[0], context, { filename: sourcePath });
  const signalReady = (sender = webContents) => ipcMain.emit('main-error-notices-ready', { sender, senderFrame: sender.mainFrame });
  return { target, webContents, sent, context, signalReady, clock };
}

test('ready handshake flushes early errors only from the active renderer', t => {
  const { target, sent, signalReady, webContents } = setupMain(t);
  target.emit('uncaughtException', new Error('early'));
  assert.equal(sent.length, 0);
  signalReady({});
  assert.equal(sent.length, 0, 'foreign renderer cannot arm delivery');
  signalReady();
  assert.equal(sent.length, 1, 'ready handshake must flush the pending error');
  assert.equal(sent[0][0], 'main-process-error');
  webContents.isDestroyed = () => true;
  target.emit('uncaughtException', new Error('destroyed'));
  assert.equal(sent.length, 1);
});

test('cancelled navigation leaves errors deliverable using Electron details events', t => {
  const { target, webContents, sent, context } = setupMain(t);
  vm.runInContext('mainErrorWindowReady = true', context, { filename: 'main.js' });
  webContents.emit('did-start-navigation', { url: 'file:///dropped', isSameDocument: false, isMainFrame: true }, 'file:///dropped', false, true);
  let cancelled = false;
  webContents.emit('will-navigate', { url: 'file:///dropped', isMainFrame: true, preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  target.emit('uncaughtException', new Error('after cancellation'));
  assert.equal(sent.length, 1, 'cancelled navigation must not disable notices');
});

test('committed main document and renderer death require a new ready handshake', t => {
  const { target, webContents, sent, signalReady, context } = setupMain(t);
  vm.runInContext('mainErrorWindowReady = true', context, { filename: 'main.js' });
  webContents.emit('did-frame-navigate', {}, 'file:///subframe', -1, '', false);
  webContents.emit('did-navigate-in-page', { isMainFrame: true, isSameDocument: true });
  target.emit('uncaughtException', new Error('still ready'));
  assert.equal(sent.length, 1);
  webContents.emit('did-navigate', {}, 'file:///app/index.html', -1, '');
  target.emit('uncaughtException', new Error('new document'));
  assert.equal(sent.length, 1, 'committed navigation must disarm delivery');
  signalReady();
  assert.equal(sent.length, 3, 'ready replays the delivered notice before the queued new document error');
  webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  target.emit('uncaughtException', new Error('dead renderer'));
  assert.equal(sent.length, 3);
  signalReady();
  assert.equal(sent.length, 6, 'reload handshake replays both delivered ids and flushes the new error');
});

test('reload and renderer death replay the five latest delivered ids exactly once per ready transition', t => {
  const { target, webContents, sent, signalReady, clock } = setupMain(t);
  signalReady();
  for (let i = 0; i < 6; i++) target.emit('uncaughtException', new Error(`replay-${i}`));
  target.emit('uncaughtException', new Error('replay-1'));
  clock.advance(1000);
  const expected = [sent[2][1], sent[3][1], sent[4][1], sent[5][1], sent[6][1]];
  webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  target.emit('uncaughtException', new Error('outgoing document'));
  const latest = [...expected.slice(1), sent.at(-1)[1]];
  const before = sent.length;
  webContents.emit('did-navigate', {}, 'file:///app/index.html');
  assert.equal(sent.length, before, 'commit waits for subscription');
  signalReady({});
  assert.equal(sent.length, before, 'foreign readiness cannot replay');
  signalReady();
  assert.deepEqual(sent.slice(before).map(([, notice]) => notice), latest, 'reload must recover the latest five ids including the outgoing-page error');
  assert.equal(latest[3].count, 2, 'replay preserves the last delivered count');
  signalReady();
  assert.equal(sent.length, before + 5, 'duplicate ready must not replay again');
  webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  signalReady();
  assert.deepEqual(sent.slice(before + 5).map(([, notice]) => notice), latest, 'renderer death must replay the same bounded group');
});

test('repeat counts leave announced text unchanged and new ids update the live region', t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  const emit = (id, count) => dom.window.api._mainProcessErrorCb({ id, count, message: `problem-${id}.` });
  emit('first', 1);
  const alert = dom.document.querySelector('[role="alert"]');
  const announced = () => {
    const copy = alert.cloneNode(true);
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return copy.textContent;
  };
  const original = announced();
  emit('first', 7);
  assert.equal(announced(), original, 'count updates must not change announced text');
  assert.equal(alert.querySelector('.app-notice-message').textContent, 'problem-first (7 occurrences). Open log; the log may hold details.');
  emit('second', 1);
  assert.notEqual(announced(), original, 'a new id must change announced text');
  assert.match(announced(), /problem-second/);
  const afterNew = announced();
  emit('first', 8);
  assert.equal(announced(), afterNew, 'recency changes must not re-announce the group');
});

test('a visible member keeps its count after main count-cache eviction and resets after renderer eviction', t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  const target = new EventEmitter();
  const clock = createClock();
  let ready = true;
  const handlers = installMainErrorHandlers({ target, ...clock, log: { error() {} }, notify: notice => {
    if (!ready) return false;
    dom.window.api._mainProcessErrorCb(notice);
  } });
  t.after(() => handlers.dispose());
  target.emit('uncaughtException', new Error('retained'));
  for (let i = 0; i < 8; i++) target.emit('uncaughtException', new Error('retained'));
  clock.advance(1000);
  ready = false;
  for (let i = 0; i < 101; i++) target.emit('uncaughtException', new Error(`unavailable-${i}`));
  ready = true;
  target.emit('uncaughtException', new Error('retained'));
  const text = () => dom.document.querySelector('.app-notice-message').textContent;
  assert.match(text(), /retained \(9 occurrences\)/, 'main cache eviction cannot decrease a visible count');
  for (let i = 0; i < 5; i++) target.emit('uncaughtException', new Error(`visible-${i}`));
  assert.doesNotMatch(text(), /retained/);
  clock.advance(1000);
  target.emit('uncaughtException', new Error('retained'));
  assert.match(text(), /retained \(2 occurrences\)/, 'an evicted renderer member starts from the incoming count');
});

test('renderer subscribes before sending ready through the real preload', t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  const ipc = new EventEmitter();
  let ready = 0;
  ipc.send = channel => {
    assert.equal(channel, 'main-error-notices-ready');
    assert.equal(ipc.listenerCount('main-process-error'), 1, 'listener must precede readiness');
    ready++;
    ipc.emit('main-process-error', {}, { id: 'early', count: 1, message: 'early error' });
  };
  const preloadPath = path.join(__dirname, '..', 'preload.js');
  vm.runInNewContext(fs.readFileSync(preloadPath, 'utf8'), {
    process: { platform: process.platform, argv: [] },
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, api) => { dom.window.api = api; } } }),
  }, { filename: preloadPath });
  const noticesPath = path.join(__dirname, '..', 'public', 'app-notices.js');
  const noticesSource = fs.readFileSync(noticesPath, 'utf8');
  const subscription = noticesSource.slice(noticesSource.indexOf('window.api?'), noticesSource.indexOf('async function openMainErrorLog'));
  vm.runInContext(subscription, dom.context, { filename: noticesPath });
  assert.equal(ready, 1, 'installed renderer listener must send readiness');
  assert.match(dom.document.querySelector('[role="alert"]').textContent, /early error/);
});

test('repeated errors keep buttons and focus, refresh member recency and use cautious log wording', t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  const emit = (id, count = 1) => dom.window.api._mainProcessErrorCb({ id, count, message: `problem-${id}.` });
  for (let i = 0; i < 5; i++) emit(String(i));
  const alert = dom.document.querySelector('[role="alert"]');
  const action = alert.querySelector('.app-notice-action');
  const dismiss = alert.querySelector('.app-notice-dismiss');
  action.focus();
  emit('0', 2);
  assert.equal(dom.document.querySelector('.app-notice-action'), action, 'repeat must keep the same action element');
  assert.equal(dom.document.querySelector('.app-notice-dismiss'), dismiss);
  assert.equal(dom.document.activeElement, action);
  assert.equal(dom.document.querySelector('[role="alert"]'), alert);
  emit('5');
  assert.match(alert.textContent, /problem-0/);
  assert.doesNotMatch(alert.textContent, /problem-1/);
  assert.doesNotMatch(alert.textContent, /\.\./);
  assert.match(alert.textContent, /the log may hold details/);
  dismiss.click();
  assert.equal(dom.document.querySelector('[role="alert"]'), null);
});

test('most recently repeated member survives renderer eviction', t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  const emit = id => dom.window.api._mainProcessErrorCb({ id, count: 1, message: `member-${id}` });
  for (let i = 0; i < 5; i++) emit(String(i));
  emit('0');
  emit('5');
  const text = dom.document.querySelector('[role="alert"]').textContent;
  assert.match(text, /member-0/, 'fresh repeat must survive the five-member limit');
  assert.doesNotMatch(text, /member-1/);
});

test('notice punctuation and log wording allow missing rotated details', t => {
  const dom = setupSidebarDom();
  t.after(() => dom.destroy());
  dom.window.api._mainProcessErrorCb({ id: 'period', count: 1, message: 'foo.' });
  const text = dom.document.querySelector('[role="alert"]').textContent;
  assert.doesNotMatch(text, /foo\.\./, 'do not append a second period');
  assert.match(text, /the log may hold details/);
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
  assert.match(alert.textContent, /the log may hold details/);
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
