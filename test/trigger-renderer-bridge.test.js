'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const modulePath = path.join(__dirname, '../src/main/triggers/trigger-renderer-bridge.js');

test('the renderer broker is an Electron-free production module', () => {
  assert.ok(fs.existsSync(modulePath), 'the renderer request owner must exist');
  assert.equal(typeof require(modulePath).createTriggerRendererBridge, 'function');
});

test('stop obtains renderer readiness without an action command and loses it on reload', async () => {
  const r = rig();
  assert.equal(typeof r.bridge.waitForReady, 'function', 'stop needs a readiness-only broker operation');
  let settled = false;
  const pending = r.bridge.waitForReady(200).then(value => { settled = true; return value; });
  await r.flush(); assert.equal(settled, false); assert.equal(r.sent.length, 0);
  r.ready(); const ready = await pending;
  assert.equal(ready.ok, true); assert.equal(ready.validate().ok, true); assert.equal(r.sent.length, 0);
  r.wc.emit('did-start-navigation', {}, 'reload', false, true);
  assert.equal(ready.validate().reason, 'renderer unavailable');
  r.bridge.dispose();
});

test('stop readiness expires or closes without a late command', async () => {
  const r = rig();
  assert.equal(typeof r.bridge.waitForReady, 'function', 'stop needs bounded readiness');
  const pending = r.bridge.waitForReady(200); await r.tick(200);
  assert.equal((await pending).reason, 'renderer not ready'); r.ready(); assert.equal(r.sent.length, 0);
  r.closing(); assert.equal((await r.bridge.waitForReady(300)).reason, 'Switchboard is closing.');
  r.bridge.dispose(); assert.equal(r.timers.size, 0);
});

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const project = path.resolve('broker-project');

function rig() {
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  ipcMain.removeHandler = name => handlers.delete(name);
  const sent = [];
  const wc = new EventEmitter();
  wc.mainFrame = {};
  wc.isDestroyed = () => false;
  wc.send = (channel, payload) => sent.push({ channel, payload });
  const win = new EventEmitter();
  win.webContents = wc;
  win.isDestroyed = () => false;
  let currentWindow = win;
  let allowed = true;
  let at = 100;
  let nextTimer = 0;
  const timers = new Map();
  const sessions = new Map();
  const entry = { pty: {}, generation: 7 };
  sessions.set(B, entry);
  const { createTriggerRendererBridge } = require(modulePath);
  const bridge = createTriggerRendererBridge({
    ipcMain, getWindow: () => currentWindow, getSession: id => sessions.get(id),
    launchAllowed: () => allowed, now: () => at,
    setTimeoutFn: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: at + delay }); return id; },
    clearTimeoutFn: id => timers.delete(id),
  });
  bridge.attach(win);
  const event = () => ({ sender: wc, senderFrame: wc.mainFrame });
  const ready = (from = event()) => handlers.get('trigger-actions-ready')(from);
  const reply = (payload, from = event()) => ipcMain.emit('trigger-session-action-result', from, payload);
  const request = (fields = {}, beforeDispatch) => bridge.request({
    mode: 'reattach', requestedSessionId: A, tabKey: B, generation: 7, entry,
    project, deadline: 200, ...fields,
  }, beforeDispatch);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const tick = async time => {
    at = time;
    for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.fn(); }
    await flush();
  };
  const payload = () => sent.at(-1)?.payload;
  const ack = (changes = {}) => ({ ...payload(), ok: true, generation: 7, ...changes });
  return { bridge, handlers, ipcMain, wc, win, sent, sessions, entry, event, ready, reply, request, flush, tick, payload, ack, timers,
    advance: time => { at = time; },
    noWindow: () => { currentWindow = null; }, closing: () => { allowed = false; } };
}

test('a document waits for the explicit main-frame handshake and keeps historical and tab IDs separate', async () => {
  const r = rig();
  let settled = false;
  const result = r.request().then(value => { settled = true; return value; });
  await r.flush();
  assert.equal(settled, false, 'the ready wait must remain pending');
  assert.equal(r.sent.length, 0);
  assert.equal(r.ready({ sender: r.wc, senderFrame: {} }), null);
  assert.equal(r.ready({ sender: {}, senderFrame: r.wc.mainFrame }), null);
  const ready = r.ready();
  assert.equal(typeof ready?.documentEpoch, 'string');
  await r.flush();
  assert.equal(r.sent.length, 1);
  const payload = r.payload();
  assert.equal(payload.requestedSessionId, A);
  assert.equal(payload.tabKey, B);
  assert.equal(payload.generation, 7);
  assert.equal(payload.documentEpoch, ready.documentEpoch);
  assert.notEqual(payload.requestId, A);
  assert.equal('entry' in payload, false);
  assert.equal('pty' in payload, false);
  r.reply(r.ack());
  assert.equal((await result).ok, true);
  assert.equal(r.timers.size, 0);
  r.bridge.dispose();
});

test('ready timeout, action timeout and missing window have distinct refusals and no late dispatch', async () => {
  const r = rig();
  const waiting = r.request();
  await r.tick(200);
  assert.equal((await waiting).reason, 'renderer not ready');
  r.ready();
  await r.flush();
  assert.equal(r.sent.length, 0);
  const dispatched = r.request({ deadline: 300 });
  await r.flush();
  assert.equal(r.sent.length, 1);
  await r.tick(300);
  assert.equal((await dispatched).reason, 'renderer action timed out');
  assert.equal(r.bridge.consumePermit(r.payload().requestId, r.event(), { sessionId: B, projectPath: project, isNew: false, sessionOptions: { reattachOnly: true } }), null);
  r.noWindow();
  assert.equal((await r.request({ deadline: 400 })).reason, 'window not available');
  r.bridge.dispose();
});

test('only the exact sender, document, mode, requested ID, tab key and pinned generation can ACK', async () => {
  const r = rig();
  r.ready();
  let settled = false;
  const result = r.request().then(value => { settled = true; return value; });
  await r.flush();
  assert.equal(r.sent.length, 1);
  for (const changes of [
    { requestId: 'wrong' }, { documentEpoch: 'old' }, { mode: 'resume' },
    { requestedSessionId: B }, { tabKey: A }, { generation: 8 }, { ok: 1 },
  ]) r.reply(r.ack(changes));
  r.reply(r.ack(), { sender: {}, senderFrame: r.wc.mainFrame });
  r.reply(r.ack(), { sender: r.wc, senderFrame: {} });
  r.reply(null);
  await r.flush();
  assert.equal(settled, false);
  r.reply(r.ack());
  assert.equal((await result).ok, true);
  r.reply(r.ack());
  assert.equal(r.timers.size, 0);
  r.bridge.dispose();
});

for (const change of ['remove', 'object', 'pty', 'generation', 'exit']) {
  test(`reattach refuses when its pinned ${change} changes before acknowledgement`, async () => {
    const r = rig();
    r.ready();
    const result = r.request();
    await r.flush();
    assert.equal(r.sent.length, 1);
    if (change === 'remove') r.sessions.delete(B);
    if (change === 'object') r.sessions.set(B, { ...r.entry });
    if (change === 'pty') r.entry.pty = {};
    if (change === 'generation') r.entry.generation++;
    if (change === 'exit') r.entry.exited = true;
    r.reply(r.ack());
    assert.equal((await result).reason, 'session target changed');
    r.bridge.dispose();
  });
}

for (const event of ['navigation', 'render-process-gone', 'destroyed', 'closed', 'revoke']) {
  test(`${event} revokes the document and pending permits without redispatch`, async () => {
    const r = rig();
    r.ready();
    const result = r.request();
    await r.flush();
    assert.equal(r.sent.length, 1);
    const old = r.ack();
    if (event === 'navigation') r.wc.emit('did-start-navigation', {}, 'about:blank', false, true);
    else if (event === 'closed') r.win.emit('closed');
    else if (event === 'revoke') r.bridge.revoke(r.win, 'Switchboard is closing.');
    else r.wc.emit(event);
    assert.equal((await result).reason, event === 'revoke' ? 'Switchboard is closing.' : 'renderer unavailable');
    r.reply(old);
    assert.equal(r.timers.size, 0);
    assert.equal(r.bridge.checkPermit(old.requestId), null);
    r.bridge.dispose();
    assert.equal(r.wc.listenerCount('did-start-navigation'), 0);
    assert.equal(r.wc.listenerCount('render-process-gone'), 0);
    assert.equal(r.wc.listenerCount('destroyed'), 0);
    assert.equal(r.win.listenerCount('closed'), 0);
  });
}

test('subframe and same-document navigation do not revoke readiness; attach is idempotent', async () => {
  const r = rig();
  r.bridge.attach(r.win);
  const first = r.ready();
  assert.equal(typeof first?.documentEpoch, 'string');
  assert.equal(r.wc.listenerCount('did-start-navigation'), 1);
  r.wc.emit('did-start-navigation', {}, 'about:blank', false, false);
  r.wc.emit('did-start-navigation', {}, '#anchor', true, true);
  assert.equal(r.ready().documentEpoch, first.documentEpoch);
  r.wc.emit('did-start-navigation', {}, 'about:blank', false, true);
  assert.notEqual(r.ready().documentEpoch, first.documentEpoch);
  r.bridge.dispose();
  assert.equal(r.ipcMain.listenerCount('trigger-session-action-result'), 0);
  assert.equal(r.handlers.size, 0);
});

for (const mode of ['resume', 'new']) {
  test(`${mode} requires a single-use main-issued permit and a main-recorded spawned entry`, async () => {
    const r = rig();
    r.sessions.delete(B);
    r.ready();
    let settled = false;
    const result = r.request({ mode, requestedSessionId: mode === 'new' ? null : B, generation: null, entry: undefined, name: 'Name' })
      .then(value => { settled = true; return value; });
    await r.flush();
    assert.equal(r.sent.length, 1);
    const id = r.payload().requestId;
    const args = { sessionId: B, projectPath: project, isNew: mode === 'new', sessionOptions: {} };
    r.reply(r.ack());
    await r.flush();
    assert.equal(settled, false, 'an ACK alone cannot establish spawn evidence');
    assert.equal(r.bridge.consumePermit(id, { sender: r.wc, senderFrame: {} }, args), null);
    for (const bad of [{ sessionId: A }, { projectPath: project + '-other' }, { isNew: mode !== 'new' },
      { sessionOptions: { type: 'attach' } }, { sessionOptions: { type: 'terminal' } }, { sessionOptions: { forkFrom: A } }]) {
      assert.equal(r.bridge.consumePermit(id, r.event(), { ...args, ...bad }), null);
    }
    const permit = r.bridge.consumePermit(id, r.event(), args);
    assert.equal(permit?.mode, mode);
    assert.equal(permit?.tabKey, B);
    assert.equal(permit?.signal.aborted, false);
    assert.equal(r.bridge.consumePermit(id, r.event(), args), null);
    assert.equal(r.bridge.checkPermit(id)?.requestId, id);
    r.sessions.set(B, r.entry);
    assert.equal(r.bridge.markOpened(id, r.entry), true);
    r.reply(r.ack());
    const done = await result;
    assert.equal(done.ok, true);
    assert.equal(done[mode === 'new' ? 'created' : 'resumed'], true);
    assert.equal(r.bridge.checkPermit(id), null);
    assert.equal(permit.signal.aborted, true);
    r.bridge.dispose();
  });
}

test('deadline and close revoke an opening permit and preserve only main-observed lifecycle evidence', async () => {
  const r = rig();
  r.sessions.clear();
  r.ready();
  const result = r.request({ mode: 'new', requestedSessionId: null, generation: null, entry: undefined });
  await r.flush();
  assert.equal(r.sent.length, 1);
  const id = r.payload().requestId;
  const permit = r.bridge.consumePermit(id, r.event(), { sessionId: B, projectPath: project, isNew: true });
  assert.equal(permit?.signal.aborted, false);
  r.sessions.set(B, r.entry);
  assert.equal(r.bridge.markOpened(id, r.entry), true);
  await r.tick(200);
  const done = await result;
  assert.equal(done.reason, 'renderer action timed out');
  assert.equal(done.created, true);
  assert.equal(done.uncertain, true);
  assert.equal(permit.signal.aborted, true);
  assert.equal(r.bridge.markOpened(id, r.entry), false);
  assert.equal(r.bridge.checkPermit(id), null);
  r.closing();
  assert.equal((await r.request({ deadline: 300 })).reason, 'Switchboard is closing.');
  r.bridge.dispose();
});

test('the marker must complete before dispatch, and deadline cancels a pending marker continuation', async () => {
  const r = rig();
  r.ready();
  let release;
  const marker = new Promise(resolve => { release = resolve; });
  const result = r.request({}, () => marker);
  await r.flush();
  assert.equal(r.sent.length, 0);
  await r.tick(200);
  assert.equal((await result).reason, 'session action timed out');
  release();
  await r.flush();
  assert.equal(r.sent.length, 0);
  r.bridge.dispose();
});

test('failed marker publication prevents dispatch and has no launch uncertainty', async () => {
  const r = rig();
  r.ready();
  const result = await r.request({}, () => { throw new Error('disk full'); });
  assert.equal(result.reason, 'action state could not be saved');
  assert.equal(result.error, 'disk full');
  assert.equal(result.uncertain, undefined);
  assert.equal(r.sent.length, 0);
  r.bridge.dispose();
});

for (const spawned of [false, true]) {
  test(`an explicit backend failure has known effects rather than interruption uncertainty (spawned=${spawned})`, async () => {
    const r = rig();
    r.sessions.clear();
    r.ready();
    const result = r.request({ mode: 'new', requestedSessionId: null, generation: null, entry: undefined });
    await r.flush();
    assert.equal(r.sent.length, 1);
    const id = r.payload().requestId;
    assert.ok(r.bridge.consumePermit(id, r.event(), { sessionId: B, projectPath: project, isNew: true }));
    if (spawned) {
      r.sessions.set(B, r.entry);
      assert.equal(r.bridge.markOpened(id, r.entry), true);
    }
    r.reply(r.ack({ ok: false, generation: spawned ? 7 : null, error: 'backend refused' }));
    const done = await result;
    assert.equal(done.reason, 'session open failed');
    assert.equal(done.error, 'backend refused');
    assert.equal(done.created, spawned ? true : undefined);
    assert.equal(done.uncertain, undefined, 'an acknowledged failure has a known outcome');
    r.bridge.dispose();
  });
}

test('before-dispatch admission refusal sends no renderer request', async () => {
  const r = rig(); r.ready();
  const result = r.request({}, () => ({ ok: false, reason: 'session live elsewhere' }));
  await r.flush();
  assert.equal(r.sent.length, 0, 'rechecking admission must precede renderer dispatch');
  assert.equal((await result).reason, 'session live elsewhere');
  r.bridge.dispose();
});

test('main spawn evidence updates the durable marker before any renderer ACK', async () => {
  const r = rig(); r.sessions.clear(); r.ready();
  let marked = false;
  const result = r.request({ mode: 'new', requestedSessionId: null, generation: null, entry: undefined, onOpened: () => { marked = true; } });
  await r.flush(); const id = r.payload().requestId;
  r.bridge.consumePermit(id, r.event(), { sessionId: B, projectPath: project, isNew: true });
  r.sessions.set(B, r.entry); r.bridge.markOpened(id, r.entry);
  assert.equal(marked, true);
  r.reply(r.ack()); assert.equal((await result).created, true); r.bridge.dispose();
});

test('synchronous spawn confirmation retains true effects when the deadline elapsed before timer dispatch', async () => {
  const r = rig(); r.sessions.clear(); r.ready();
  const result = r.request({ mode: 'resume', generation: null, entry: undefined });
  await r.flush(); const id = r.payload().requestId;
  r.bridge.consumePermit(id, r.event(), { sessionId: B, projectPath: project, isNew: false });
  r.sessions.set(B, r.entry); r.advance(201); r.bridge.markOpened(id, r.entry);
  const done = await result; assert.equal(done.resumed, true); assert.equal(done.uncertain, true); r.bridge.dispose();
});

test('a joined ordinary exact resume can ACK only after main validates that existing generation', async () => {
  const r = rig(); r.sessions.clear(); r.ready(); let checked = 0;
  const result = r.request({ mode: 'resume', generation: null, entry: undefined, verifyJoined: async entry => {
    assert.equal(entry, r.entry); checked++; return { ok: true };
  } });
  await r.flush(); r.sessions.set(B, r.entry); r.reply(r.ack()); await r.flush();
  assert.equal(checked, 1, 'the broker must verify a joined ordinary open, rather than ignore its ACK');
  const done = await result; assert.equal(done.ok, true); assert.equal(done.resumed, false); r.bridge.dispose();
});
