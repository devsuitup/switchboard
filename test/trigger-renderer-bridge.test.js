'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTriggerRendererBridge, createPendingOpens } = require('../src/main/triggers/trigger-renderer-bridge');

const A = '01234567-89ab-cdef-0123-456789abcdef';
const B = 'fedcba98-7654-3210-fedc-ba9876543210';

function rig() {
  const state = { hasWindow: true, destroyed: false, closing: false };
  const sessions = new Map();
  const sent = [];
  const frame = { name: 'main' };
  const webContents = Object.assign(new EventEmitter(), { mainFrame: frame, send: (channel, payload) => sent.push([channel, payload]), isDestroyed: () => state.destroyed });
  const win = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => state.destroyed });
  const handlers = {};
  const listeners = {};
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn; }, on: (channel, fn) => { listeners[channel] = fn; } };
  const bridge = createTriggerRendererBridge({ ipcMain, getWindow: () => (state.hasWindow ? win : null), getSession: key => sessions.get(key), isClosing: () => state.closing });
  bridge.register();
  const trusted = { sender: webContents, senderFrame: frame };
  const r = {
    state, sessions, sent, bridge, webContents, win, frame, trusted,
    ready: (event = trusted) => handlers['trigger-actions-ready'](event),
    reply: (message, event = trusted) => listeners['trigger-session-action-result'](event, message),
    deadline: (ms = 400) => Date.now() + ms,
    payload: () => sent.at(-1)[1],
  };
  return r;
}

const settled = promise => { const box = { done: false }; promise.then(value => { box.done = true; box.value = value; }); return box; };
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

test('no window refuses without creating one or sending', async () => {
  const r = rig();
  r.state.hasWindow = false;
  const outcome = await r.bridge.ensureOpen({ mode: 'new', tabKey: A, deadline: r.deadline() });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'window not available');
  assert.equal(outcome.preSpawn, true);
  assert.deepEqual(r.sent, []);
});

test('nothing is sent before the ready handshake; the request goes out once it arrives', async () => {
  const r = rig();
  const pending = settled(r.bridge.ensureOpen({ mode: 'new', tabKey: A, project: '/p', name: 'n', deadline: r.deadline(2000) }));
  await tick();
  assert.deepEqual(r.sent, []);
  const handshake = await r.ready();
  assert.equal(handshake.ok, true);
  await tick();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0][0], 'trigger-session-action');
  assert.equal(r.payload().documentEpoch, handshake.documentEpoch);
  assert.equal(r.payload().tabKey, A);
  assert.equal(pending.done, false);
});

test('a renderer that never becomes ready refuses at the deadline as not ready', async () => {
  const r = rig();
  const outcome = await r.bridge.ensureOpen({ mode: 'new', tabKey: A, deadline: r.deadline(60) });
  assert.equal(outcome.reason, 'renderer not ready');
  assert.deepEqual(r.sent, []);
});

test('a ready handshake from another frame or sender is not trusted', async () => {
  const r = rig();
  assert.equal((await r.ready({ sender: r.webContents, senderFrame: { name: 'child' } })).ok, false);
  assert.equal((await r.ready({ sender: {}, senderFrame: r.frame })).ok, false);
  assert.equal(r.bridge.isReady(), false);
});

async function openNew(r, extra = {}) {
  await r.ready();
  const pending = r.bridge.ensureOpen({ mode: 'new', tabKey: A, requestedSessionId: null, project: '/p', name: 'n', deadline: r.deadline(extra.ms ?? 600), ...extra });
  await tick();
  return { pending, payload: r.payload() };
}

function spawnedSession(r, key = A) {
  const session = { generation: 7, exited: false, pty: {} };
  r.sessions.set(key, session);
  return session;
}

test('a correlated acknowledgement from a spawned entry completes the request once', async () => {
  const r = rig();
  const { pending, payload } = await openNew(r);
  const consumed = r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} });
  assert.equal(consumed.ok, true);
  const gate = r.bridge.guardedSpawn(payload.requestId, () => spawnedSession(r));
  assert.equal(gate.ok, true);
  const message = { requestId: payload.requestId, documentEpoch: payload.documentEpoch, mode: 'new', ok: true, requestedSessionId: null, tabKey: A, generation: 7 };
  r.reply(message);
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.spawned, true);
  assert.equal(outcome.generation, 7);
  assert.equal(outcome.launchStartedAt, gate.launchStartedAt);
  r.reply({ ...message, generation: 8 });
});

test('replies from a wrong sender, frame, epoch, request, mode or key are ignored', async () => {
  const r = rig();
  const { pending, payload } = await openNew(r);
  r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} });
  r.bridge.guardedSpawn(payload.requestId, () => spawnedSession(r));
  const good = { requestId: payload.requestId, documentEpoch: payload.documentEpoch, mode: 'new', ok: true, requestedSessionId: null, tabKey: A, generation: 7 };
  const box = settled(pending);
  r.reply(good, { sender: {}, senderFrame: r.frame });
  r.reply(good, { sender: r.webContents, senderFrame: { name: 'child' } });
  r.reply({ ...good, documentEpoch: payload.documentEpoch + 1 });
  r.reply({ ...good, requestId: 'other' });
  r.reply({ ...good, mode: 'resume' });
  r.reply({ ...good, tabKey: B });
  r.reply({ ...good, requestedSessionId: A });
  await tick();
  assert.equal(box.done, false);
  r.reply(good);
  assert.equal((await pending).ok, true);
});

test('a wrong generation or a replaced entry cannot complete the request: target changed', async () => {
  for (const arrange of [
    (r, session) => { session.generation = 9; },
    (r) => { r.sessions.delete(A); },
    (r) => { r.sessions.get(A).exited = true; },
  ]) {
    const r = rig();
    const { pending, payload } = await openNew(r);
    r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} });
    const session = r.bridge.guardedSpawn(payload.requestId, () => spawnedSession(r)).value;
    arrange(r, session);
    r.reply({ requestId: payload.requestId, documentEpoch: payload.documentEpoch, mode: 'new', ok: true, requestedSessionId: null, tabKey: A, generation: 7 });
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'session target changed');
  }
});

test('an acknowledgement of success without a spawn recorded by main is refused', async () => {
  const r = rig();
  const { pending, payload } = await openNew(r);
  spawnedSession(r);
  r.reply({ requestId: payload.requestId, documentEpoch: payload.documentEpoch, mode: 'new', ok: true, requestedSessionId: null, tabKey: A, generation: 7 });
  assert.equal((await pending).reason, 'session target changed');
});

test('a reattach acknowledgement must carry the pinned generation of the same entry', async () => {
  const r = rig();
  const session = spawnedSession(r, B);
  await r.ready();
  const run = (ackGeneration, mutate) => {
    const promise = r.bridge.ensureOpen({ mode: 'reattach', requestedSessionId: A, tabKey: B, generation: 7, session, deadline: r.deadline(600) });
    return tick().then(() => {
      const { requestId, documentEpoch } = r.payload();
      assert.equal(r.payload().requestedSessionId, A);
      assert.equal(r.payload().tabKey, B);
      mutate?.();
      r.reply({ requestId, documentEpoch, mode: 'reattach', ok: true, requestedSessionId: A, tabKey: B, generation: ackGeneration });
      return promise;
    });
  };
  assert.equal((await run(7)).ok, true);
  assert.equal((await run(8)).reason, 'session target changed');
  assert.equal((await run(7, () => { r.sessions.set(B, { generation: 7, exited: false, pty: {} }); })).reason, 'session target changed');
});

test('an acknowledgement that names an A key for a B tab never completes the reattach', async () => {
  const r = rig();
  const session = spawnedSession(r, B);
  await r.ready();
  const pending = r.bridge.ensureOpen({ mode: 'reattach', requestedSessionId: A, tabKey: B, generation: 7, session, deadline: r.deadline(150) });
  await tick();
  const { requestId, documentEpoch } = r.payload();
  r.reply({ requestId, documentEpoch, mode: 'reattach', ok: true, requestedSessionId: A, tabKey: A, generation: 7 });
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'renderer action timed out');
});

test('a renderer that never acknowledges is refused at the deadline and its permit is revoked', async () => {
  const r = rig();
  const { pending, payload } = await openNew(r, { ms: 120 });
  const outcome = await pending;
  assert.equal(outcome.reason, 'renderer action timed out');
  assert.equal(r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} }).ok, false);
  r.reply({ requestId: payload.requestId, documentEpoch: payload.documentEpoch, mode: 'new', ok: true, requestedSessionId: null, tabKey: A, generation: 7 });
});

test('navigation, renderer death and window destruction revoke readiness and pending permits', async () => {
  for (const trigger of [
    r => r.webContents.emit('did-start-navigation', {}, 'file:///x', false, true),
    r => r.webContents.emit('render-process-gone', {}, { reason: 'crashed' }),
    r => r.win.emit('closed'),
  ]) {
    const r = rig();
    const { pending, payload } = await openNew(r);
    trigger(r);
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'renderer unavailable');
    assert.equal(r.bridge.isReady(), false);
    assert.equal(r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} }).ok, false);
    const next = await r.bridge.ensureOpen({ mode: 'new', tabKey: B, deadline: r.deadline(60) });
    assert.equal(next.reason, 'renderer not ready');
  }
});

test('an in-place navigation or a subframe navigation keeps the renderer ready', async () => {
  const r = rig();
  await r.ready();
  r.webContents.emit('did-start-navigation', {}, 'file:///x#a', true, true);
  r.webContents.emit('did-start-navigation', {}, 'file:///x', false, false);
  assert.equal(r.bridge.isReady(), true);
});

test('closing revokes pending work, refuses new work and cancels the final spawn check', async () => {
  const r = rig();
  const { pending, payload } = await openNew(r);
  r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} });
  r.state.closing = true;
  r.bridge.revokeAll('Switchboard is closing.');
  assert.equal((await pending).reason, 'Switchboard is closing.');
  let spawns = 0;
  const gate = r.bridge.guardedSpawn(payload.requestId, () => { spawns += 1; });
  assert.equal(gate.ok, false);
  assert.equal(spawns, 0);
  assert.equal((await r.bridge.ensureOpen({ mode: 'new', tabKey: B, deadline: r.deadline(60) })).reason, 'Switchboard is closing.');
});

test('a permit is single use and bound to its tab key and mode', async () => {
  const r = rig();
  const { payload } = await openNew(r);
  assert.equal(r.bridge.consumePermit(payload.requestId, { sessionId: B, isNew: true, sessionOptions: {} }).ok, false);
  assert.equal(r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: false, sessionOptions: {} }).ok, false);
  assert.equal(r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: { forkFrom: B } }).ok, false);
  assert.equal(r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: { type: 'terminal' } }).ok, false);
  assert.equal(r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} }).ok, true);
  assert.equal(r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} }).ok, false);
  assert.equal(r.bridge.consumePermit('nope', { sessionId: A, isNew: true }).ok, false);
});

test('resume and reattach permits refuse forks, attaches and a missing reattachOnly', async () => {
  const r = rig();
  await r.ready();
  const resume = r.bridge.ensureOpen({ mode: 'resume', requestedSessionId: A, tabKey: A, deadline: r.deadline(600) });
  await tick();
  const id = r.payload().requestId;
  assert.equal(r.bridge.consumePermit(id, { sessionId: A, isNew: false, sessionOptions: { forkFrom: B } }).ok, false);
  assert.equal(r.bridge.consumePermit(id, { sessionId: A, isNew: false, sessionOptions: { type: 'attach' } }).ok, false);
  assert.equal(r.bridge.consumePermit(id, { sessionId: A, isNew: true, sessionOptions: {} }).ok, false);
  assert.equal(r.bridge.consumePermit(id, { sessionId: A, isNew: false, sessionOptions: {} }).ok, true);
  r.bridge.revokeAll();
  await resume;
  const session = spawnedSession(r, B);
  await r.ready();
  const reattach = r.bridge.ensureOpen({ mode: 'reattach', requestedSessionId: A, tabKey: B, generation: 7, session, deadline: r.deadline(600) });
  await tick();
  const rid = r.payload().requestId;
  assert.equal(r.bridge.consumePermit(rid, { sessionId: B, isNew: false, sessionOptions: {} }).ok, false);
  assert.equal(r.bridge.consumePermit(rid, { sessionId: B, isNew: false, sessionOptions: { reattachOnly: true } }).ok, true);
  r.bridge.revokeAll();
  await reattach;
});

test('the final pre-spawn check refuses an expired permit after deferred setup, with zero spawns', async () => {
  const r = rig();
  const { pending, payload } = await openNew(r, { ms: 80 });
  r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} });
  await new Promise(resolve => setTimeout(resolve, 150));
  let spawns = 0;
  const gate = r.bridge.guardedSpawn(payload.requestId, () => { spawns += 1; });
  assert.equal(gate.ok, false);
  assert.equal(spawns, 0);
  assert.equal((await pending).reason, 'renderer action timed out');
});

test('launchStartedAt is recorded at the guard, not at dispatch', async () => {
  const r = rig();
  const { payload } = await openNew(r, { ms: 2000 });
  r.bridge.consumePermit(payload.requestId, { sessionId: A, isNew: true, sessionOptions: {} });
  await new Promise(resolve => setTimeout(resolve, 60));
  const before = Date.now();
  const gate = r.bridge.guardedSpawn(payload.requestId, () => spawnedSession(r));
  assert.ok(gate.launchStartedAt >= before);
});

test('a concurrent ordinary open and a trigger open of one id run one after the other', async () => {
  const serialized = createPendingOpens();
  const log = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = serialized(A, async () => { log.push('click start'); await gate; log.push('click end'); return 'click'; });
  const second = serialized(A, async () => { log.push('trigger start'); return 'trigger'; });
  const other = await serialized(B, async () => 'other');
  assert.equal(other, 'other');
  await tick();
  assert.deepEqual(log, ['click start']);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['click', 'trigger']);
  assert.deepEqual(log, ['click start', 'click end', 'trigger start']);
});

test('a failing open does not block the next open of the same id', async () => {
  const serialized = createPendingOpens();
  await assert.rejects(serialized(A, async () => { throw new Error('boom'); }));
  assert.equal(await serialized(A, async () => 'ok'), 'ok');
});
