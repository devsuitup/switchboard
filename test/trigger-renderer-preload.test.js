'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

function loadPreloadBody() {
  const filename = path.join(__dirname, '../preload.js');
  const source = fs.readFileSync(filename, 'utf8');
  const body = source.slice(source.indexOf('\n') + 1);
  const ipcRenderer = new EventEmitter();
  const invoked = [];
  const sent = [];
  ipcRenderer.invoke = (...args) => { invoked.push(args); return Promise.resolve({ documentEpoch: 'epoch' }); };
  ipcRenderer.send = (...args) => sent.push(args);
  let api;
  vm.runInNewContext(body, {
    ipcRenderer, process: { platform: process.platform, argv: [] }, webUtils: {},
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
  }, { filename });
  return { api, invoked, sent, ipcRenderer };
}

test('readiness invokes its named channel and action replies send only the supplied acknowledgement', async () => {
  const r = loadPreloadBody();
  assert.equal(typeof r.api.triggerActionsReady, 'function');
  assert.equal(typeof r.api.triggerSessionActionResult, 'function');
  assert.equal((await r.api.triggerActionsReady()).documentEpoch, 'epoch');
  assert.deepEqual(r.invoked, [['trigger-actions-ready']]);
  const ack = { requestId: 'request', ok: false };
  r.api.triggerSessionActionResult(ack);
  assert.deepEqual(r.sent, [['trigger-session-action-result', ack]]);
});

test('the action subscription strips the IPC event and its cleanup preserves other subscriptions', () => {
  const r = loadPreloadBody();
  assert.equal(typeof r.api.onTriggerSessionAction, 'function');
  const first = [];
  const second = [];
  const removeFirst = r.api.onTriggerSessionAction((...args) => first.push(args));
  const removeSecond = r.api.onTriggerSessionAction((...args) => second.push(args));
  assert.equal(typeof removeFirst, 'function');
  const payload = { requestId: 'request' };
  r.ipcRenderer.emit('trigger-session-action', { sender: 'private' }, payload);
  assert.deepEqual(first, [[payload]]);
  assert.deepEqual(second, [[payload]]);
  removeFirst();
  removeFirst();
  r.ipcRenderer.emit('trigger-session-action', {}, payload);
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);
  removeSecond();
  assert.equal(r.ipcRenderer.listenerCount('trigger-session-action'), 0);
});
