'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const settings = new Map([['global', { openWorkingSet: ['a'] }], ['continuationChoice:a', { chosen: 'b', candidates: ['b'] }], ['continuationChoice:b', { chosen: null, candidates: ['c'] }]]);
  const handlers = new Map();
  const reads = [];
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('get-settings-by-prefix'");
  assert.ok(start >= 0, 'main must register get-settings-by-prefix');
  const end = source.indexOf('\n});', start) + 4;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
    listSettingKeys: prefix => { reads.push(prefix); return [...settings.keys()].filter(key => key.startsWith(prefix)); },
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
  return { api, calls, settings, reads };
}

test('prefix IPC returns only matching settings through the shipped preload bridge', async () => {
  const { api, calls, settings } = setup();
  assert.equal(typeof api.getSettingsByPrefix, 'function');
  const result = await api.getSettingsByPrefix('continuationChoice:');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), Object.fromEntries([...settings].filter(([key]) => key.startsWith('continuationChoice:'))));
  assert.deepEqual(calls, [['get-settings-by-prefix', 'continuationChoice:']]);
});

for (const prefix of [undefined, null, '', 0, {}, [], 'global', 'continuationChoice', 'continuationChoice:a', '%', '_']) {
  test('prefix IPC rejects an invalid or unapproved prefix: ' + JSON.stringify(prefix), async () => {
    const { api, reads } = setup();
    await assert.rejects(async () => api.getSettingsByPrefix(prefix), /Invalid settings prefix/);
    assert.deepEqual(reads, [], 'invalid prefixes must be rejected before accessing settings');
  });
}
