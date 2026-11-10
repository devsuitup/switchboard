'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExitAttempts } = require('../src/main/app/session-exit');
test('close commitment immediately notifies the trigger permit owner', async () => {
  const notifications = []; const win = {};
  const attempts = createExitAttempts({ snapshot: () => ({ rows: [] }), check: async () => ({ proceed: true }),
    cancelCheck() {}, invalidateRenderer() {}, onCommitted: window => notifications.push(window) });
  await attempts.request(win, 'close');
  assert.deepEqual(notifications, [win]); assert.equal(attempts.launchAllowed(), false);
});

const { EventEmitter } = require('node:events');
const realNow = Date.now.bind(Date);
const { createTriggerRendererBridge } = require('../src/main/triggers/trigger-renderer-bridge');
const { createTriggerActions } = require('../src/main/triggers/trigger-actions');
const { fixture: stopFixture, ID: STOP_ID } = require('./fixtures/trigger-stop.cjs');
const NEW = '11234567-89ab-cdef-0123-456789abcdef';
const STEM = '21234567-89ab-cdef-0123-456789abcdef';
const ENTRY = 'abcdef01-2345-6789-abcd-0123456789ab';
const project = process.cwd();

function stack(t, { handshake = true } = {}) {
  const ipcMain = new EventEmitter(); const handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn); ipcMain.removeHandler = name => handlers.delete(name);
  const wc = new EventEmitter(); wc.mainFrame = {}; wc.isDestroyed = () => false;
  const win = new EventEmitter(); win.webContents = wc; win.isDestroyed = () => false;
  const event = () => ({ sender: wc, senderFrame: wc.mainFrame });
  const sessions = new Map();
  const sent = [];
  let bridge;
  const attempts = createExitAttempts({ snapshot: () => ({ rows: [] }), check: async () => ({ proceed: true }),
    cancelCheck() {}, invalidateRenderer() {},
    onCommitted: window => bridge.suspend(window), onRolledBack: window => bridge.restore(window) });
  bridge = createTriggerRendererBridge({ ipcMain, getWindow: () => win, getSession: id => sessions.get(id),
    launchAllowed: attempts.launchAllowed });
  wc.send = (channel, payload) => { sent.push([channel, payload]); stack.onSend?.(payload); };
  t.after(() => bridge.dispose());
  bridge.attach(win);
  const shake = () => handlers.get('trigger-actions-ready')(event());
  if (handshake) shake();
  const ack = (payload, extra = {}) => ipcMain.emit('trigger-session-action-result', event(),
    { requestId: payload.requestId, documentEpoch: payload.documentEpoch, mode: payload.mode,
      requestedSessionId: payload.requestedSessionId, tabKey: payload.tabKey, ok: true, generation: 7, ...extra });
  const rollback = async () => { await attempts.request(win, 'update'); return () => attempts.invalidate('update'); };
  return { ipcMain, handlers, wc, win, event, sessions, sent, bridge, attempts, shake, ack, rollback };
}
const soon = () => new Promise(resolve => setImmediate(resolve));
const reattach = (s, session, tabKey = ENTRY) => ({ mode: 'reattach', requestedSessionId: tabKey, tabKey, entry: session, generation: 7,
  project, deadline: Date.now() + 5000 });

test('after a canceled committed update, the surviving document serves a fresh request and fresh stop readiness', async t => {
  const s = stack(t);
  assert.equal((await s.bridge.waitForReady(Date.now() + 100)).ok, true);
  const undo = await s.rollback();
  assert.equal(s.attempts.launchAllowed(), false);
  assert.equal((await s.bridge.waitForReady(Date.now() + 5)).ok, false, 'no readiness while the update is committed');
  undo();
  assert.equal(s.attempts.launchAllowed(), true);
  const session = { pty: { pid: 1 }, generation: 7 }; s.sessions.set(ENTRY, session);
  const pending = s.bridge.request(reattach(s, session), async () => {});
  await soon();
  const [channel, payload] = s.sent.at(-1);
  assert.equal(channel, 'trigger-session-action');
  s.ack(payload);
  const result = await pending;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await s.bridge.waitForReady(Date.now() + 100)).ok, true);
});
test('a request and consumed permit held across a committed update stay unusable after rollback', async t => {
  const s = stack(t);
  const session = { pty: { pid: 1 }, generation: 7 }; s.sessions.set(ENTRY, session);
  const old = s.bridge.request(reattach(s, session), async () => {});
  await soon();
  const [, payload] = s.sent.at(-1);
  const permit = s.bridge.consumePermit(payload.requestId, s.event(), { sessionId: ENTRY, projectPath: project, isNew: false, sessionOptions: { reattachOnly: true } });
  assert.ok(permit);
  const undo = await s.rollback();
  undo();
  const settled = await old;
  assert.equal(settled.ok, false); assert.equal(settled.reason, 'Switchboard is closing.');
  assert.equal(s.bridge.checkPermit(payload.requestId), null);
  s.ack(payload);
  await soon();
  assert.equal(s.bridge.checkPermit(payload.requestId), null);
  assert.equal(s.sent.length, 1, 'no replay of the cancelled request');
});
test('a readiness object obtained before the commit stays invalid after a fresh readiness recovers', async t => {
  const s = stack(t);
  const old = await s.bridge.waitForReady(Date.now() + 100);
  assert.equal(old.validate().ok, true);
  const undo = await s.rollback();
  undo();
  const fresh = await s.bridge.waitForReady(Date.now() + 100);
  assert.equal(fresh.ok, true); assert.equal(fresh.validate().ok, true);
  assert.equal(old.validate().ok, false);
});
for (const [kind, disturb] of [
  ['never-ready document', () => {}],
  ['navigated main frame', s => s.wc.emit('did-start-navigation', {}, 'file:///x', false, true)],
  ['replaced main frame', s => { s.wc.mainFrame = {}; }],
  ['renderer death', s => s.wc.emit('render-process-gone')],
  ['destroyed web contents', s => { s.wc.isDestroyed = () => true; }],
]) {
  test(`${kind} does not regain readiness through rollback alone`, async t => {
    const s = stack(t, { handshake: kind !== 'never-ready document' });
    disturb(s);
    const undo = await s.rollback();
    undo();
    assert.equal((await s.bridge.waitForReady(Date.now() + 5)).ok, false);
  });
}

function openingStack(t, { prompt = 'hello' } = {}) {
  const s = stack(t);
  const events = [];
  const session = { pty: { pid: 1 }, generation: 7, cwd: project, projectPath: project };
  let releaseName; const nameStarted = new Promise(resolve => { s.signalName = resolve; });
  stack.onSend = payload => queueMicrotask(() => {
    const permit = s.bridge.consumePermit(payload.requestId, s.event(), { sessionId: payload.tabKey, projectPath: payload.project, isNew: payload.mode === 'new', sessionOptions: {} });
    if (!permit) return;
    s.sessions.set(payload.tabKey, session);
    s.bridge.markOpened(payload.requestId, session);
    s.ack(payload);
  });
  t.after(() => { stack.onSend = null; });
  const lifecycle = {
    activeSessions: s.sessions, broker: s.bridge, launchAllowed: s.attempts.launchAllowed, captureAuthority: s.attempts.capture,
    getProjectSnapshot: async () => ({ allProjects: [{ projectPath: project }], hiddenProjects: [], hiddenProjectKinds: {} }),
    liveElsewhere: async () => ({ known: true, live: null }), remoteTarget: async () => false,
    randomUUID: () => NEW,
    saveName: () => { s.signalName(); return new Promise(resolve => { releaseName = () => resolve({ name: 'Task' }); }); },
  };
  const ctx = { getPtyForSession: () => s.sessions.has(NEW) ? { session, ptyProcess: session.pty, cwd: project } : null,
    pinDelivery: (_id, entry) => ({ binding: { tab: entry.session, deadline: Infinity, admit: async () => {}, readId: () => NEW }, ctx: {}, handle: {} }),
    lifecycle };
  const execution = { ctx, deadline: Date.now() + 5000,
    acquireSessionLock: async () => () => events.push(['release-fifo']), acquireTabLock: async () => () => events.push(['release-mutex']),
    saveMarker: marker => events.push(['marker', marker.phase]), publish: result => events.push(['result', result]),
    deliver: async ({ pinned }) => { events.push(['deliver']); return { ok: true, submitted: 'assumed', wrote: true, text_written: true, enter_written: true }; } };
  const run = () => createTriggerActions().execute({ version: 1, action: 'open', new: { project, name: 'Task' }, ...(prompt ? { prompt } : {}) }, STEM, execution);
  return { ...s, nameStarted, events, session, execution, run, releaseName: () => releaseName() };
}
test('an action past its successful ACK is cancelled by a committed update and never revived by rollback', async t => {
  const f = openingStack(t);
  const running = f.run();
  await f.nameStarted;
  const undo = await f.rollback();
  undo();
  f.releaseName();
  const result = await running;
  assert.equal(result.ok, false); assert.equal(result.outcome, 'refused'); assert.equal(result.reason, 'Switchboard is closing.');
  assert.equal(result.created, true); assert.equal(result.sessionId, NEW);
  assert.equal(result.submitted, 'no'); assert.equal(result.wrote, false);
  assert.equal(f.events.some(e => e[0] === 'deliver'), false);
  assert.equal(f.events.filter(e => e[0] === 'result').length, 1);
  assert.deepEqual(f.events.map(e => e[0]).filter(name => name.startsWith('release-')).sort(), ['release-fifo', 'release-mutex']);
  await soon(); await soon();
  assert.equal(f.events.filter(e => e[0] === 'result').length, 1, 'no late publication');
  assert.equal(f.events.some(e => e[0] === 'deliver'), false);
});
test('cancellation during delivery stops later bytes and publishes the closing refusal once', async t => {
  const f = openingStack(t);
  const bytes = []; let pause; const paused = new Promise(resolve => { pause = resolve; }); let proceed; const resumed = new Promise(resolve => { proceed = resolve; });
  f.execution.deliver = async ({ pinned }) => {
    pinned.binding.validateAction(); bytes.push('text');
    pause(); await resumed;
    try { pinned.binding.validateAction(); bytes.push('enter'); }
    catch (error) { return { ok: false, reason: error.message, wrote: true, text_written: true, enter_written: false, submitted: 'no' }; }
    return { ok: true };
  };
  const running = f.run();
  const nameRelease = f.nameStarted.then(() => f.releaseName());
  await nameRelease; await paused;
  const undo = await f.rollback();
  undo();
  proceed();
  const result = await running;
  assert.deepEqual(bytes, ['text']);
  assert.equal(result.reason, 'Switchboard is closing.'); assert.equal(result.outcome, 'refused');
  assert.equal(result.wrote, true); assert.equal(result.text_written, true); assert.equal(result.created, true);
  assert.equal(f.events.filter(e => e[0] === 'result').length, 1);
});
test('a stop holding readiness from before the commit never reaches the backend after rollback', async t => {
  const s = stack(t);
  const f = stopFixture(t);
  let proceed; const resumed = new Promise(resolve => { proceed = resolve; });
  let obtained; const gotReady = new Promise(resolve => { obtained = resolve; });
  f.lifecycle.broker.waitForReady = async deadline => { const ready = await s.bridge.waitForReady(realNow() + 1000); obtained(); await resumed; return ready; };
  f.lifecycle.launchAllowed = s.attempts.launchAllowed; f.lifecycle.captureAuthority = s.attempts.capture;
  const running = f.start();
  await gotReady;
  const undo = await s.rollback();
  undo();
  proceed();
  const result = await f.finish();
  assert.equal(f.kills(), 0);
  assert.equal(result.ok, false);
  await running;
});

for (const [name, settle] of [
  ['rejected', reject => reject(new Error('disk'))],
  ['mismatched', (_reject, resolve) => resolve({ name: 'Other' })],
]) {
  test(`a ${name} name save cannot override the cancellation of its action`, async t => {
    const f = openingStack(t);
    let finish;
    f.execution.ctx.lifecycle.saveName = () => { f.signalName(); return new Promise((resolve, reject) => { finish = () => settle(reject, resolve); }); };
    const running = f.run();
    await f.nameStarted;
    const undo = await f.rollback();
    undo();
    finish();
    const result = await running;
    assert.equal(result.ok, false); assert.equal(result.outcome, 'refused'); assert.equal(result.reason, 'Switchboard is closing.');
    assert.equal(result.created, true); assert.equal(result.sessionId, NEW);
    assert.equal(f.events.some(e => e[0] === 'deliver'), false);
    assert.equal(f.events.filter(e => e[0] === 'result').length, 1);
  });
}

function cancellableStop(t, options) {
  const s = stack(t);
  const f = stopFixture(t, options);
  f.lifecycle.launchAllowed = s.attempts.launchAllowed; f.lifecycle.captureAuthority = s.attempts.capture;
  const backend = [];
  const stopCall = f.lifecycle.stop;
  f.lifecycle.stop = (...args) => { backend.push(args); return stopCall(...args); };
  return { s, f, backend };
}
for (const [name, behave, reason] of [
  ['rejected liveness', () => Promise.reject(new Error('probe failed')), 'session liveness unavailable'],
  ['unknown liveness', () => ({ known: false }), 'session liveness unavailable'],
  ['a live elsewhere writer', () => ({ known: true, live: { kind: 'interactive' } }), 'session live elsewhere'],
  ['a missing session', () => ({ known: true, live: null }), 'session not found'],
]) {
  test(`stop keeps its cancellation over ${name} that settles after commit and rollback`, async t => {
    const c = cancellableStop(t);
    c.f.map.clear();
    let release; const gate = new Promise(resolve => { release = resolve; });
    let reached; const started = new Promise(resolve => { reached = resolve; });
    c.f.lifecycle.liveElsewhere = async () => { reached(); await gate; return behave(); };
    c.f.start();
    await started;
    const undo = await c.s.rollback();
    undo();
    release();
    const result = await c.f.finish();
    assert.equal(result.ok, false); assert.equal(result.reason, 'Switchboard is closing.');
    assert.equal(c.backend.length, 0);
    assert.notEqual(result.reason, reason);
  });
}
test('stop keeps its cancellation over an early lookup refusal', async t => {
  const c = cancellableStop(t);
  c.f.map.clear();
  let release; const gate = new Promise(resolve => { release = resolve; });
  let reached; const started = new Promise(resolve => { reached = resolve; });
  c.f.lifecycle.remoteTarget = async () => { reached(); await gate; return true; };
  c.f.start();
  await started;
  const undo = await c.s.rollback();
  undo();
  release();
  const result = await c.f.finish();
  assert.equal(result.reason, 'Switchboard is closing.');
  assert.equal(c.backend.length, 0);
});
test('a stop queued behind another request is cancelled by a commit that is rolled back before it starts', async t => {
  const c = cancellableStop(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let reached; const queued = new Promise(resolve => { reached = resolve; });
  c.f.execution.acquireSessionLock = async () => { reached(); await gate; return () => c.f.events.push(['release-fifo']); };
  c.f.start();
  await queued;
  const undo = await c.s.rollback();
  undo();
  release();
  const result = await c.f.finish();
  assert.equal(result.ok, false); assert.equal(result.reason, 'Switchboard is closing.');
  assert.equal(c.backend.length, 0);
  assert.equal(c.f.events.some(e => e[0] === 'release-fifo'), true, 'the session lock is released');
});

for (const commit of [false, true]) {
  test(`a successful stop ${commit ? 'is normalized to the closing refusal when a close commits before publication' : 'publishes closed without a commit'}`, async t => {
    const f = stopFixture(t);
    let authorityValid = true; let killed = false;
    f.lifecycle.captureAuthority = () => ({ valid: () => authorityValid });
    Object.defineProperty(f.session, 'exited', { configurable: true, get() {
      if (killed && commit) authorityValid = false;
      return killed;
    }, set(value) { killed = value; } });
    const stopCall = f.lifecycle.stop;
    f.lifecycle.stop = (...args) => { const out = stopCall(...args); killed = true; return out; };
    f.start();
    const result = await f.finish();
    assert.equal(f.kills(), 1);
    assert.equal(result.stop_requested, true);
    if (commit) {
      assert.equal(result.ok, false); assert.equal(result.outcome, 'refused'); assert.equal(result.reason, 'Switchboard is closing.');
    } else {
      assert.equal(result.ok, true); assert.equal(result.outcome, 'closed');
    }
    assert.equal(f.events.filter(e => e[0] === 'result').length, 1);
  });
}

const os = require('node:os');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { createJournal } = require('./fixtures/session-request-journal.cjs');
const { createSessionRequestNamespace } = require('../src/main/triggers/session-request-namespace');
const { createSessionRequestPublication } = require('../src/main/triggers/session-request-publication');

async function journalledPublication(t, f, duringHold = async () => { const undo = await f.rollback(); undo(); },
  trigger = { version: 1, action: 'open', new: { project, name: 'Task' }, prompt: 'hello' }) {
  const root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'sb-closing-journal-')));
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  const processed = nodePath.join(root, 'processed');
  nodeFs.mkdirSync(processed);
  const input = nodePath.join(root, STEM + '.json');
  nodeFs.writeFileSync(input, JSON.stringify(trigger));
  const base = createJournal();
  let hold = Promise.resolve();
  const journal = Object.fromEntries(Object.entries(base).map(([name, fn]) => [name, async (...args) => { await hold; return fn(...args); }]));
  const publisher = createSessionRequestPublication({ fs: nodeFs, renameWithRetry: nodeFs.renameSync });
  const namespace = createSessionRequestNamespace({ fs: nodeFs, journal, publisher, actions: createTriggerActions(), processedDir: processed });
  const guarded = await namespace.begin(STEM, input);
  const actions = createTriggerActions();
  f.execution.publish = async (result, finalize) => {
    let release; hold = new Promise(resolve => { release = resolve; });
    const publishing = actions.publish({ result, namespace: guarded, finalize });
    await duringHold();
    release();
    assert.equal(await publishing, true);
  };
  return { resultPath: nodePath.join(processed, STEM + '.result.json') };
}
test('a cancellation that lands while the journal commit is pending stores the closing refusal', async t => {
  const f = openingStack(t);
  const journalled = await journalledPublication(t, f);
  f.nameStarted.then(() => f.releaseName());
  const result = await f.run();
  const stored = JSON.parse(nodeFs.readFileSync(journalled.resultPath, 'utf8'));
  assert.equal(stored.ok, false); assert.equal(stored.outcome, 'refused'); assert.equal(stored.reason, 'Switchboard is closing.');
  assert.equal(stored.created, true);
  assert.equal(result.reason, 'Switchboard is closing.');
});

const heldTargetChanges = {
  'PTY replaced': [f => { f.session.pty = { pid: 2 }; }, 'session target changed'],
  'map binding removed': [f => { f.sessions.delete(NEW); }, 'session target changed'],
  'map binding replaced': [f => { f.sessions.set(NEW, { ...f.session }); }, 'session target changed'],
  'conflicting binding with a surviving alias': [f => { f.sessions.set('alias', f.session); f.sessions.set(NEW, { ...f.session }); }, 'session target changed'],
  'session exited': [f => { f.session.exited = true; }, 'session target changed'],
  'became remote': [f => { f.session.host = 'server'; }, 'remote sessions are not supported'],
  'became a plain terminal': [f => { f.session.isPlainTerminal = true; }, 'plain terminal sessions are not supported'],
  'became background': [f => { f.session.backgrounded = true; }, 'background session is not supported'],
};
for (const [name, [apply, reason]] of Object.entries(heldTargetChanges)) {
  test(`an open whose target ${name} while the journal query is pending stores the refusal and keeps its evidence`, async t => {
    const f = openingStack(t);
    const generation = f.session.generation;
    const journalled = await journalledPublication(t, f, async () => { apply(f); });
    f.nameStarted.then(() => f.releaseName());
    const result = await f.run();
    assert.equal(f.session.generation, generation, 'the generation is constant');
    const stored = JSON.parse(nodeFs.readFileSync(journalled.resultPath, 'utf8'));
    assert.equal(stored.ok, false); assert.equal(stored.outcome, 'refused'); assert.equal(stored.reason, reason);
    assert.equal(stored.created, true); assert.equal(stored.sessionId, NEW);
    assert.equal(result.reason, reason); assert.equal(result.created, true);
    assert.equal(f.events.filter(e => e[0] === 'deliver').length, 1);
  });
}
for (const [name, apply] of [['unchanged', () => {}], ['re-keyed to the same object', f => { f.sessions.delete(NEW); f.sessions.set('re-keyed', f.session); }]]) {
  test(`an open whose target is ${name} during the held journal query publishes opened`, async t => {
    const f = openingStack(t);
    const journalled = await journalledPublication(t, f, async () => { apply(f); });
    f.nameStarted.then(() => f.releaseName());
    await f.run();
    const stored = JSON.parse(nodeFs.readFileSync(journalled.resultPath, 'utf8'));
    assert.equal(stored.ok, true); assert.equal(stored.outcome, 'opened');
  });
}

for (const cancel of [false, true]) {
  test(`a successful stop ${cancel ? 'cancelled while the journal query is pending stores the closing refusal' : 'with no cancellation stores closed'}`, async t => {
    const c = cancellableStop(t, { onKill: session => { session.exited = true; } });
    const journalled = await journalledPublication(t, c.f, async () => { if (cancel) { const undo = await c.s.rollback(); undo(); } },
      { version: 1, action: 'stop', sessionId: STOP_ID });
    c.f.start();
    const result = await c.f.finish();
    const stored = JSON.parse(nodeFs.readFileSync(journalled.resultPath, 'utf8'));
    assert.equal(c.backend.length, 1);
    assert.equal(stored.stop_requested, true);
    if (cancel) {
      assert.equal(stored.ok, false); assert.equal(stored.outcome, 'refused'); assert.equal(stored.reason, 'Switchboard is closing.');
      assert.equal(result.reason, 'Switchboard is closing.');
    } else {
      assert.equal(stored.ok, true); assert.equal(stored.outcome, 'closed');
    }
    assert.equal(c.f.events.filter(e => e[0] === 'release-mutex').length, 1);
    assert.equal(c.f.events.filter(e => e[0] === 'release-fifo').length, 1);
  });
}
