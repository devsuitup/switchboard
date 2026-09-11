// Tests for the remote-ssh adapter in public/remote-activity-ui.js — see
// .ai/contexts/session-state.md (migration step 3). Unlike
// test/remote-activity-ui.test.js (the pre-existing sessionBusyState/
// responseReadySessions-facing tests, kept as-is), these assert against the
// adapter's own persistent createSessionState('remote-ssh') snapshot: one
// instance per remote session id, fed by the watch-channel event, the decay
// timer, the descriptor (status/liveness) and the attach/detach signal.
//
// Same eval-in-jsdom technique as test/remote-activity-ui.test.js: the real
// session-state.js / session-activity-dom.js / session-activity.js /
// remote-activity-ui.js, loaded in index.html order, with setTimeout/
// clearTimeout stubbed so the 20s decay is driven by hand.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const STATE_SRC = path.join(__dirname, '..', 'public', 'session-state.js');
const DOM_SRC = path.join(__dirname, '..', 'public', 'session-activity-dom.js');
const ACTIVITY_SRC = path.join(__dirname, '..', 'public', 'session-activity.js');
const SRC = path.join(__dirname, '..', 'public', 'remote-activity-ui.js');

function setup(sessionIds = ['s1']) {
  const items = sessionIds
    .map(id => `<div class="session-item" data-session-id="${id}"><span class="session-status-dot"></span></div>`)
    .join('');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${items}</body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;

  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  let onRemoteActivityCb = null;
  Object.defineProperty(window, 'api', {
    value: { onRemoteActivity: (cb) => { onRemoteActivityCb = cb; } },
    writable: true, configurable: true,
  });

  const scheduled = [];
  let nextId = 1;
  Object.defineProperty(window, 'setTimeout', {
    value: (fn, ms) => {
      const handle = { id: nextId++, fn, ms, cleared: false };
      scheduled.push(handle);
      return handle.id;
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'clearTimeout', {
    value: (id) => {
      const h = scheduled.find(s => s.id === id);
      if (h) h.cleared = true;
    },
    writable: true, configurable: true,
  });

  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(STATE_SRC, 'utf8'), ctx, { filename: STATE_SRC });
  vm.runInContext(fs.readFileSync(DOM_SRC, 'utf8'), ctx, { filename: DOM_SRC });
  vm.runInContext(fs.readFileSync(ACTIVITY_SRC, 'utf8'), ctx, { filename: ACTIVITY_SRC });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });

  const call = (fnName, ...args) => vm.runInContext(
    `${fnName}(${args.map((a) => JSON.stringify(a)).join(',')})`, ctx
  );

  return {
    window,
    document: window.document,
    item: (id) => window.document.querySelector(`.session-item[data-session-id="${id}"]`),
    emit: (payload) => onRemoteActivityCb(payload),
    snapshot: (id) => vm.runInContext(`remoteState(${JSON.stringify(id)}).snapshot()`, ctx),
    applyRemoteDescriptor: (session) => call('applyRemoteDescriptor', session),
    setRemoteAttached: (id, attached) => call('setRemoteAttached', id, attached),
    seedRemoteActivity: (session) => call('seedRemoteActivity', session),
    scheduled,
    pending: () => scheduled.filter(h => !h.cleared),
    destroy: () => window.close(),
  };
}

test('a remote-activity event drives the adapter snapshot busy, then decay clears busy without arming response-ready', () => {
  const t = setup(['s1']);
  let snap = t.snapshot('s1');
  assert.equal(snap.busy, false, 'precondition: idle');

  t.emit({ sessionId: 's1', at: Date.now() });
  snap = t.snapshot('s1');
  assert.equal(snap.busy, true, 'the watch-channel event marks the adapter busy');
  assert.equal(snap.lastActivitySource, 'remote-watch');
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'projected onto the row');

  const timer = t.pending()[0];
  assert.ok(timer, 'a decay timer must be scheduled');
  timer.fn(); // simulate the 20s elapsing

  snap = t.snapshot('s1');
  assert.equal(snap.busy, false, 'decay clears busy');
  assert.equal(snap.waitingForInput, true);
  assert.equal(snap.responseReady, false, 'decay must never arm response-ready — remote has no PTY to confirm a turn ended');
  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  assert.ok(!t.item('s1').classList.contains('response-ready'));
  t.destroy();
});

test('applyRemoteDescriptor sets liveness alive and descriptorStatus from a matched descriptor', () => {
  const t = setup(['s1']);
  t.applyRemoteDescriptor({
    sessionId: 's1', remoteAlias: 'planificator',
    remoteDescriptorSeen: true, status: 'idle', statusUpdatedAt: 12345,
  });

  const snap = t.snapshot('s1');
  assert.equal(snap.liveness, 'alive');
  assert.equal(snap.lastActivitySource, 'descriptor');
  t.destroy();
});

test('applyRemoteDescriptor leaves liveness unknown when the descriptor was not seen (no false "dead")', () => {
  const t = setup(['s1']);
  t.applyRemoteDescriptor({
    sessionId: 's1', remoteAlias: 'planificator',
    remoteDescriptorSeen: false, status: null, statusUpdatedAt: null,
  });

  assert.equal(t.snapshot('s1').liveness, 'unknown');
  t.destroy();
});

test('applyRemoteDescriptor is a no-op for a session with no remoteAlias', () => {
  const t = setup(['s1']);
  t.applyRemoteDescriptor({ sessionId: 's1', remoteDescriptorSeen: true, status: 'idle' });
  assert.equal(t.snapshot('s1').liveness, 'unknown', 'a local session must never be routed through the remote-ssh adapter');
  t.destroy();
});

test('setRemoteAttached toggles the attached flag without affecting busy/liveness', () => {
  const t = setup(['s1']);
  t.setRemoteAttached('s1', true);
  assert.equal(t.snapshot('s1').attached, true);

  t.setRemoteAttached('s1', false);
  assert.equal(t.snapshot('s1').attached, false);
  t.destroy();
});

test('seeding a session inside the decay window marks it busy and arms exactly one decay timer', () => {
  const t = setup(['s1']);
  t.seedRemoteActivity({
    sessionId: 's1', remoteAlias: 'planificator', remoteActiveAt: Date.now() - 5000,
    remoteDescriptorSeen: true, status: 'busy', statusUpdatedAt: 999,
  });

  const snap = t.snapshot('s1');
  assert.equal(snap.busy, true);
  assert.equal(snap.liveness, 'alive');
  assert.equal(t.pending().length, 1);
  t.destroy();
});
