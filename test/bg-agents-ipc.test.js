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

function restoreFixture(t, { saved = [{ sessionId: 's1', bg: true, attachJobId: 'aaaaaaaa' }], state = 'working', liveness = 'dead', descriptors = [], verbResult = { ok: true } } = {}) {
  const { handlers, ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  const listeners = new Set();
  const seen = [];
  bg.findRestoreJob = (sid, jobId) => { seen.push(['lookup', sid, jobId]); return { known: true, job: { id: 'aaaaaaaa', sessionId: sid, state } }; };
  bg.conversationCheck = (_id, options) => { seen.push(['check', options]); return { known: true, state, workerLiveness: liveness, hosted: liveness === 'live', sessionIds: ['s1'] }; };
  bg.runVerb = async (...args) => { seen.push(args); return verbResult; };
  const live = { value: descriptors };
  const unsubscribe = init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} }, getSetting: () => ({ openWorkingSet: saved }),
    activeSessions: new Map(), sessionHasPty: () => false, ptyPids: () => [],
    cliSessionState: { readAllDescriptors: () => live.value,
      onDescriptorsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      liveElsewhereChecked: async () => ({ known: true, live: null }),
    },
  });
  t.after(() => assert.equal(listeners.size, 0, 'descriptor listener released'));
  const restore = handlers.get('restore-background-job');
  assert.equal(typeof restore, 'function', 'B-T7 restore IPC registered');
  return { handoff: job => unsubscribe.respawnForHandoff(job), restore: (id = 's1', options) => restore({}, id, options), bg, seen, live, listeners,
    publish: value => { live.value = value; for (const fn of listeners) fn(); } };
}

for (const saved of [[], [{ sessionId: 's1' }]]) {
  test(`B-T7 refuses ${saved.length ? 'non-bg' : 'absent'} saved entry before reading jobs`, async t => {
    const h = restoreFixture(t, { saved });
    const result = await h.restore();
    assert.equal(result.action, 'refuse');
    assert.match(result.reason, /saved.*background|background.*working set/i);
    assert.deepEqual(h.seen, []);
  });
}

test('B-T7 ambiguous legacy lookup names both matching job ids without invoking a verb', async t => {
  const h = restoreFixture(t, { saved: [{ sessionId: 's1', bg: true }] });
  h.bg.findRestoreJob = () => ({ known: false, reason: 'multiple records: aaaaaaaa, bbbbbbbb' });
  const result = await h.restore();
  assert.equal(result.action, 'refuse');
  assert.match(result.reason, /aaaaaaaa.*bbbbbbbb/);
  assert.deepEqual(h.seen, []);
});

for (const state of ['working', 'blocked', 'running', 'done', 'failed', 'stopped']) {
  for (const liveness of ['live', 'dead', 'unknown']) {
    test(`B main restore ${state}/${liveness} follows the classifier and checked verb`, async t => {
      const h = restoreFixture(t, { state, liveness, descriptors: [{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: 's1' }] });
      const result = await h.restore();
      const shouldRespawn = liveness === 'dead' && state !== 'stopped';
      const shouldAttach = liveness === 'live' || shouldRespawn;
      assert.equal(result.action, shouldAttach ? 'attach' : 'refuse');
      assert.deepEqual(h.seen.filter(call => call[0] === 'respawn'), shouldRespawn ? [['respawn', 'aaaaaaaa']] : []);
      assert.ok(h.seen.some(call => call[0] === 'check' && call[1]?.workerLiveness === 'all'), 'S1a classifies every restore state');
      if (state === 'stopped' && liveness === 'dead') assert.equal(result.recovery, 'respawn');
      if (!shouldAttach) assert.match(result.reason, new RegExp(`aaaaaaaa.*${state}`));
    });
  }
}

test('B dead worker respawn repeats the existing conversation guard', async t => {
  const h = restoreFixture(t);
  let checks = 0;
  h.bg.conversationCheck = () => (++checks === 1
    ? { known: true, state: 'working', workerLiveness: 'dead', hosted: false, sessionIds: ['s1'] }
    : { known: false, reason: 'interactive process now owns conversation' });
  const result = await h.restore();
  assert.equal(result.action, 'refuse');
  assert.match(result.reason, /aaaaaaaa.*working.*interactive process/);
  assert.deepEqual(h.seen.filter(call => call[0] === 'respawn'), []);
});

test('B respawn waits for its own bg descriptor then releases its listener', async t => {
  const h = restoreFixture(t);
  let started;
  const invoked = new Promise(resolve => { started = resolve; });
  h.bg.runVerb = async () => { started(); return { ok: true }; };
  const result = h.restore();
  await invoked;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.listeners.size, 1);
  h.publish([{ kind: 'interactive', sessionId: 's1' }, { kind: 'bg', jobId: 'bbbbbbbb', sessionId: 's1' }]);
  assert.equal(h.listeners.size, 1, 'neither interactive nor another job is attachment proof');
  h.publish([{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: 's1' }]);
  assert.deepEqual(await result, { action: 'attach', sessionId: 's1', jobId: 'aaaaaaaa' });
});

test('B missing descriptor after 15 seconds reports respawned-not-attached', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = restoreFixture(t);
  const result = h.restore();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(14999);
  assert.equal(h.listeners.size, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await result, { action: 'respawned-not-attached', jobId: 'aaaaaaaa' });
});

test('B CLI refusal is visible and never waits for attachment', async t => {
  const h = restoreFixture(t, { verbResult: { ok: false, error: 'cannot open: running in another terminal' } });
  const result = await h.restore();
  assert.equal(result.action, 'refuse');
  assert.match(result.reason, /aaaaaaaa.*working.*running in another terminal/);
});

test('B GUARD overlapping restore requests share one respawn', async t => {
  const h = restoreFixture(t, { descriptors: [{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: 's1' }] });
  const results = await Promise.all([h.restore(), h.restore()]);
  assert.equal(results[0].action, 'attach');
  assert.equal(results[1].action, 'attach');
  assert.deepEqual(h.seen.filter(call => call[0] === 'respawn'), [['respawn', 'aaaaaaaa']]);
});

test('B GUARD attach-only retry cannot respawn a dead worker', async t => {
  const h = restoreFixture(t);
  assert.equal((await h.restore('s1', { attachOnly: true })).action, 'refuse');
  assert.deepEqual(h.seen.filter(call => call[0] === 'respawn'), []);
});

for (const verb of ['respawn', 'rm', 'stop']) {
  test(`A-T8 ${verb === 'respawn' ? 'RED' : 'GUARD'} open-window refusal uses ${verb}'s wording`, async () => {
    const { handlers, ipcMain } = fakeIpc();
    const bg = fakeBgAgents();
    bg.conversationCheck = () => ({ known: true, hosted: false, state: 'running', sessionIds: ['s1'] });
    init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} }, activeSessions: new Map([['s1', {}]]) });
    for (const channel of ['check-bg-agent-verb', 'bg-agent-verb']) {
      const result = await handlers.get(channel)({}, verb, 'abcdef12');
      assert.equal(result.ok, false);
      assert.match(result.error, verb === 'stop' ? /not stopped$/ : verb === 'rm' ? /then retry Delete$/ : /then retry Respawn$/);
      if (verb !== 'rm') assert.doesNotMatch(result.error, /retry Delete/);
    }
    assert.deepEqual(bg.calls.filter(call => Array.isArray(call) && call[0] === 'verb'), []);
  });
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

test('Stop refusal retains em dashes within the backend reason', async () => {
  const { handlers, ipcMain } = fakeIpc();
  const bg = fakeBgAgents();
  bg.conversationCheck = () => ({ known: true, hosted: false, state: 'done', sessionIds: ['s1'] });
  bg.liveJobCheck = () => ({ known: false, reason: 'daemon unavailable — state read failed — retry later' });
  init({ ipcMain, bgAgents: bg, getMainWindow: () => null, log: { warn() {} } });
  const expected = { ok: false, error: 'cannot tell whether a background job is still running this session (daemon unavailable — state read failed — retry later) — not stopped' };
  assert.deepEqual(await handlers.get('check-bg-agent-verb')({}, 'stop', 'abcdef12'), expected);
  assert.deepEqual(await handlers.get('bg-agent-verb')({}, 'stop', 'abcdef12'), expected);
  assert.deepEqual(bg.calls.filter(call => Array.isArray(call) && call[0] === 'verb'), []);
});

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
  assert.equal(typeof api.restoreBackgroundJob, 'function');
  await api.restoreBackgroundJob('s1', { attachOnly: true });
  assert.deepEqual(calls[1], ['restore-background-job', 's1', { attachOnly: true }]);
});


test('S2 shared checked respawn matches a descriptor without jobId using full job identity', async t => {
  const h = restoreFixture(t, { state: 'stopped', descriptors: [{ kind: 'bg', sessionId: 's1' }] });
  assert.deepEqual(await h.handoff({ id: 'aaaaaaaa', sessionId: 's1' }), { ok: true, attached: true });
  assert.deepEqual(h.seen.filter(call => call[0] === 'respawn'), [['respawn', 'aaaaaaaa']]);
});

for (const failure of ['refuse', 'fail', 'throw']) {
  test('S2 shared checked respawn preserves failure kind: ' + failure, async t => {
    const h = restoreFixture(t, { state: 'stopped', verbResult: { ok: false, error: 'verb failed' } });
    if (failure === 'refuse') h.bg.conversationCheck = () => ({ known: false, reason: 'unknown owner' });
    if (failure === 'throw') h.bg.runVerb = async () => { throw new Error('verb threw'); };
    const result = await h.handoff({ id: 'aaaaaaaa', sessionId: 's1' });
    assert.equal(result.ok, false);
    assert.equal(result.refused === true, failure === 'refuse');
    assert.match(result.error, failure === 'refuse' ? /unknown owner/ : failure === 'fail' ? /verb failed/ : /verb threw/);
    if (failure === 'refuse') assert.deepEqual(h.seen.filter(call => call[0] === 'respawn'), []);
  });
}
