// test/bg-agents-ipc.test.js — the four handlers and the push. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { init } = require('../bg-agents-ipc');

function fakeIpc() {
  const handlers = new Map();
  return { handlers, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
}

function fakeBgAgents() {
  const calls = [];
  let listener = null;
  return {
    calls,
    start: () => { calls.push('start'); return true; },
    reconcile: async () => { calls.push('reconcile'); return { roster: [], daemonReachable: true }; },
    runVerb: async (verb, id) => { calls.push(['verb', verb, id]); return { ok: true }; },
    dispatch: async (fields) => { calls.push(['dispatch', fields]); return { ok: true, id: 'aaaaaaaa' }; },
    liveJobCheck: (sessionId) => { calls.push(['liveJobCheck', sessionId]); return { known: true, job: null }; },
    onChange: (l) => { listener = l; return () => { listener = null; }; },
    fire: (snap) => listener && listener(snap),
  };
}

test('get-bg-agents arms the watchers then reconciles; the verbs pass straight through', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} } });
  assert.deepEqual(await handlers.get('get-bg-agents')({}), { roster: [], daemonReachable: true });
  assert.deepEqual(bg.calls, ['start', 'reconcile']);
  assert.deepEqual(await handlers.get('bg-agent-verb')({}, 'stop', 'aaaaaaaa'), { ok: true });
  assert.deepEqual(await handlers.get('dispatch-bg-agent')({}, { prompt: 'p', cwd: '/x' }), { ok: true, id: 'aaaaaaaa' });
  assert.deepEqual(bg.calls.slice(2), [['verb', 'stop', 'aaaaaaaa'], ['dispatch', { prompt: 'p', cwd: '/x' }]]);
});

test('a roster change is pushed to the window on bg-agents-changed, and skipped when the window is gone', () => {
  const { ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  const sent = [];
  let window = { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push([ch, payload]) } };
  init({ ipcMain, bgAgents: bg, getMainWindow: () => window, log: { warn() {} } });
  bg.fire({ roster: [{ id: 'aaaaaaaa' }], daemonReachable: true });
  assert.deepEqual(sent, [['bg-agents-changed', { roster: [{ id: 'aaaaaaaa' }], daemonReachable: true }]]);
  window = null;
  bg.fire({ roster: [], daemonReachable: false });
  assert.equal(sent.length, 1);
});

test('get-bg-agents restores the push after stop() cleared it, without ever doubling it', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const listeners = new Set();
  const bg = {
    start: () => true,
    reconcile: async () => ({ roster: [], daemonReachable: true }),
    onChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
    stop: () => listeners.clear(),
  };
  const sent = [];
  const window = { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push([ch, payload]) } };
  init({ ipcMain, bgAgents: bg, getMainWindow: () => window, log: { warn() {} } });
  await handlers.get('get-bg-agents')({});
  bg.stop();
  await handlers.get('get-bg-agents')({});
  for (const l of listeners) l({ roster: [], daemonReachable: true });
  assert.deepEqual(sent, [['bg-agents-changed', { roster: [], daemonReachable: true }]]);
});

test('bg-agent-live-job answers liveJobCheck for the id, coerced to a string', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} } });
  assert.deepEqual(await handlers.get('bg-agent-live-job')({}, 'S-1'), { known: true, job: null });
  await handlers.get('bg-agent-live-job')({}, undefined);
  await handlers.get('bg-agent-live-job')({}, { toString: () => 'x' });
  assert.deepEqual(bg.calls, [['liveJobCheck', 'S-1'], ['liveJobCheck', ''], ['liveJobCheck', 'x']]);
});
