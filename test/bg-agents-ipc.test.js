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
    conversationCheck: () => ({ known: true, state: 'working', hosted: true, sessionIds: ['s-1'] }),
    dispatch: async (fields) => { calls.push(['dispatch', fields]); return { ok: true, id: 'aaaaaaaa' }; },
    liveJobCheck: (sessionId) => { calls.push(['liveJobCheck', sessionId]); return { known: true, job: null }; },
    onChange: (l) => { listener = l; return () => { listener = null; }; },
    fire: (snap) => listener && listener(snap),
  };
}

for (const verb of ['stop', 'rm', 'respawn']) {
  for (const attachJobId of ['abcdef12', 'ABCDEF12', '00000000']) {
    test(`A11 ${verb} exempts only its own attach client (${attachJobId})`, async () => {
      const { handlers, ipcMain } = fakeIpc();
      const bg = fakeBgAgents();
      bg.conversationCheck = () => ({ known: true, hosted: false, state: 'done', sessionIds: ['s1'] });
      init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} },
        activeSessions: new Map([['s1', { isAttach: true, attachJobId }]]),
        cliSessionState: { liveElsewhereChecked: async () => ({ known: true, live: null }) },
        sessionHasPty: () => false, ptyPids: () => [],
      });
      const allowed = verb === 'stop' && attachJobId.toLowerCase() === 'abcdef12';
      const preview = await handlers.get('check-bg-agent-verb')({}, verb, 'abcdef12');
      assert.equal(preview.ok, allowed, 'only Stop ignores its own attach tab');
      if (verb === 'stop' && !allowed) {
        assert.match(preview.error, /not stopped/);
        assert.doesNotMatch(preview.error, /Delete/);
      }
      assert.deepEqual(await handlers.get('bg-agent-verb')({}, verb, 'abcdef12'), preview);
      assert.deepEqual(bg.calls.filter(call => Array.isArray(call) && call[0] === 'verb'),
        allowed ? [['verb', 'stop', 'abcdef12']] : []);
    });
  }
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

test('a roster change is pushed only after an Agents request, and skipped when the window is gone', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  const sent = [];
  let window = { isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push([ch, payload]) } };
  init({ ipcMain, bgAgents: bg, getMainWindow: () => window, log: { warn() {} } });
  bg.fire({ roster: [], daemonReachable: false });
  assert.deepEqual(sent, [], 'initialization must not subscribe to the roster');
  await handlers.get('get-bg-agents')({});
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

test('window close releases the roster subscription and a reopened window can subscribe once', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const listeners = new Set();
  const bg = {
    start: () => true,
    reconcile: async () => ({ roster: [], daemonReachable: true }),
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const sent = [];
  let window = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const close = init({ ipcMain, bgAgents: bg, getMainWindow: () => window, log: { warn() {} } });
  assert.equal(listeners.size, 0);
  await handlers.get('get-bg-agents')({});
  assert.equal(listeners.size, 1);
  close();
  close();
  window = null;
  assert.equal(listeners.size, 0);
  window = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  await handlers.get('get-bg-agents')({});
  await handlers.get('get-bg-agents')({});
  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener({ roster: [], daemonReachable: true });
  assert.equal(sent.length, 1);
  close();
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

for (const verb of ['rm', 'respawn', 'stop']) {
  for (const scenario of ['unknown', 'hosted', 'own', 'external', 'unreadable', 'throwing', 'allowed']) {
    test(`PR6 check-only and execution agree for ${verb}: ${scenario}`, async () => {
      const { handlers, ipcMain } = fakeIpc();
      const bg = fakeBgAgents();
      bg.liveJobCheck = () => ({ known: true, job: null });
      bg.conversationCheck = () => {
        if (scenario === 'throwing') throw new Error('job read failed');
        return scenario === 'unknown' ? { known: false, reason: 'unreadable state' }
          : { known: true, hosted: scenario === 'hosted', state: 'working', sessionIds: ['s-1'] };
      };
      init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} },
        activeSessions: new Map(scenario === 'own' ? [['s-1', {}]] : []),
        cliSessionState: { liveElsewhereChecked: async () => scenario === 'unreadable'
          ? { known: false, reason: 'descriptor read failed' }
          : { known: true, live: scenario === 'external' ? { pid: 42 } : null } },
        sessionHasPty: () => false, ptyPids: () => [],
      });
      const checkOnly = handlers.get('check-bg-agent-verb');
      assert.equal(typeof checkOnly, 'function', 'check-only IPC must be registered');
      const preview = await checkOnly({}, verb, 'aaaaaaaa');
      assert.deepEqual(bg.calls, [], 'check-only must never invoke a verb or reconcile');
      const execution = await handlers.get('bg-agent-verb')({}, verb, 'aaaaaaaa');
      assert.deepEqual(preview, execution);
      const allowed = scenario === 'allowed' || (verb === 'stop' && ['unknown', 'hosted', 'throwing'].includes(scenario));
      assert.equal(preview.ok, allowed);
      assert.deepEqual(bg.calls, allowed ? [['verb', verb, 'aaaaaaaa']] : []);
    });
  }
}

test('PR6 execution rechecks a job that becomes hosted after an allowed preview', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  let hosted = false;
  bg.conversationCheck = () => ({ known: true, hosted, state: 'working', sessionIds: [] });
  init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} } });
  assert.equal(typeof handlers.get('check-bg-agent-verb'), 'function');
  assert.deepEqual(await handlers.get('check-bg-agent-verb')({}, 'rm', 'aaaaaaaa'), { ok: true });
  hosted = true;
  assert.deepEqual(await handlers.get('bg-agent-verb')({}, 'rm', 'aaaaaaaa'),
    { ok: false, error: 'cannot delete a working session; stop it first' });
  assert.deepEqual(bg.calls, []);
});

test('PR6 check-only rejects unsupported verbs and malformed ids without reading jobs', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  bg.conversationCheck = () => { throw new Error('must not read an invalid request'); };
  init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} } });
  const check = handlers.get('check-bg-agent-verb');
  assert.equal(typeof check, 'function');
  for (const verb of ['attach', 'transcript', 'bogus', null]) {
    assert.deepEqual(await check({}, verb, 'aaaaaaaa'), { ok: false, error: `unknown verb: ${String(verb)}` });
  }
  for (const id of ['../jobs', 'AAAAAAAA', '', null, {}]) {
    assert.deepEqual(await check({}, 'stop', id), { ok: false, error: 'invalid background session id' });
  }
  assert.deepEqual(bg.calls, []);
});

test('PR6 preload forwards the check-only verb and id without invoking execution', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const calls = [];
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; } } }),
    process: { platform: 'win32', argv: [] },
  }, { filename: path.join(__dirname, '..', 'preload.js') });
  assert.equal(typeof api.checkBgAgentVerb, 'function');
  assert.deepEqual(await api.checkBgAgentVerb('rm', 'aaaaaaaa'), { ok: true });
  assert.deepEqual(calls, [['check-bg-agent-verb', 'rm', 'aaaaaaaa']]);
});
