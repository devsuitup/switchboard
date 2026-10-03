'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalResizeHandler } = require('../terminal-resize');

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
