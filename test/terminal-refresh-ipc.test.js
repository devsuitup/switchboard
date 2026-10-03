'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalResizeHandler } = require('../terminal-resize');
const { extractFunction } = require('./app-source');

test('remote open, reattach and launch preserve the adapter sizing capability in IPC results', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  for (const remoteResizeAllowed of [false, true]) {
    const activeSessions = new Map();
    const handlers = new Map();
    const descriptor = { sessionId: 'fixture', cwd: '/fixture' };
    const attachResult = { ok: true, ptyProcess: {}, remoteResizeAllowed };
    const context = vm.createContext({
      activeSessions,
      mainWindow: { webContents: { send() {} } },
      ipcMain: { handle: (name, cb) => handlers.set(name, cb) },
      getCachedFolder: () => 'remote-folder',
      isRemoteFolder: () => true,
      parseFolderKey: () => ({ alias: 'fixture' }),
      remoteIndexer: { getRemoteSessions: () => ({ sessions: [descriptor] }), refreshHostNow: async () => {} },
      normalizePtySize: require('../pty-size').normalizePtySize,
      remoteAttachAdapter: { attach: async () => attachResult },
      remoteLaunchAdapter: {},
      handleLaunchRequest: async () => ({ ok: true, descriptor, attachResult }),
      wireSessionPty() {},
      getMcpState: () => null,
    });
    vm.runInContext(extractFunction(main, 'registerRemoteAttachSession'), context);
    for (const channel of ['open-terminal', 'remote-launch-session']) {
      const start = main.indexOf(`ipcMain.handle('${channel}'`);
      const end = main.indexOf('\n});', start) + 4;
      assert.ok(start >= 0 && end > start);
      vm.runInContext(main.slice(start, end), context);
    }
    const open = handlers.get('open-terminal');
    const result = await open(null, 'fixture', '/fixture', false, {}, { cols: 120, rows: 40 });
    assert.equal(result.remoteResizeAllowed, remoteResizeAllowed, 'new attach');
    assert.equal((await open(null, 'fixture', '/fixture', false)).remoteResizeAllowed, remoteResizeAllowed, 'renderer reattach');
    activeSessions.clear();
    const launched = await handlers.get('remote-launch-session')(null, { alias: 'fixture', sessionId: 'fixture' });
    assert.equal(launched.remoteResizeAllowed, remoteResizeAllowed, 'launch attach');
  }
});

test('the shipped preload and main resize registration forward one refresh and restore its size', () => {
  const calls = [];
  const pending = [];
  const session = { pty: { resize(cols, rows) { calls.push({ cols, rows }); } } };
  const activeSessions = new Map([['fixture', session]]);
  let registered;
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('const handleTerminalResize =');
  const end = main.indexOf('// --- IPC: close-terminal ---', start);
  assert.ok(start !== -1 && end > start);
  vm.runInNewContext(main.slice(start, end), {
    activeSessions,
    createTerminalResizeHandler: (sessions) => createTerminalResizeHandler(sessions, {
      setTimeout(cb) { pending.push(cb); return pending.length; }, clearTimeout() {},
    }),
    ipcMain: { on(channel, cb) { assert.equal(channel, 'terminal-resize'); registered = cb; } },
    setTimeout(cb) { pending.push(cb); },
  });
  let api;
  let sends = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    process: { platform: 'fixture', argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { send(channel, ...args) { sends++; assert.equal(channel, 'terminal-resize'); registered(null, ...args); } },
      webUtils: {},
    }),
  });
  api.resizeTerminal('fixture', 120, 40, { refresh: true });
  assert.equal(sends, 1);
  assert.deepEqual(calls, [{ cols: 120, rows: 40 }, { cols: 119, rows: 40 }]);
  pending.shift()();
  assert.deepEqual(calls.at(-1), { cols: 120, rows: 40 });
  calls.length = 0;
  api.resizeTerminal('fixture', 130, 40);
  assert.deepEqual(calls, [{ cols: 130, rows: 40 }]);
});
