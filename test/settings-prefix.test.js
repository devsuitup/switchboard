'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('prefix IPC returns only matching settings through the shipped preload bridge', async () => {
  const settings = new Map([['global', { openWorkingSet: ['a'] }], ['continuationChoice:a', { chosen: 'b', candidates: ['b'] }], ['continuationChoice:b', { chosen: null, candidates: ['c'] }]]);
  const handlers = new Map();
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('get-settings-by-prefix'");
  assert.ok(start >= 0, 'main must register get-settings-by-prefix');
  const end = source.indexOf('\n});', start) + 4;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
    listSettingKeys: prefix => [...settings.keys()].filter(key => key.startsWith(prefix)),
    getSetting: key => settings.get(key),
  }, { filename: 'main.js' });
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), {
    process: { argv: [] },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_, value) => { api = value; } },
        ipcRenderer: { on() {}, invoke: (channel, ...args) => { calls.push([channel, ...args]); return handlers.get(channel)(null, ...args); } } };
    },
  }, { filename: 'preload.js' });
  assert.equal(typeof api.getSettingsByPrefix, 'function');
  const result = await api.getSettingsByPrefix('continuationChoice:');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), Object.fromEntries([...settings].filter(([key]) => key.startsWith('continuationChoice:'))));
  assert.deepEqual(calls, [['get-settings-by-prefix', 'continuationChoice:']]);
});
