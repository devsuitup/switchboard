// Tests for the local-transcript adapter in public/local-transcript-adapter.js
// — see .ai/contexts/session-state.md (migration step 4). Same eval-in-jsdom
// technique as test/remote-session-adapter.test.js: the real session-state.js
// / session-activity-dom.js / session-activity.js / local-transcript-adapter.js,
// loaded in index.html order, with setTimeout/clearTimeout stubbed so the 20s
// decay is driven by hand.

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
const SRC = path.join(__dirname, '..', 'public', 'local-transcript-adapter.js');

function setup(sessionIds = ['s1']) {
  const items = sessionIds
    .map(id => `<div class="session-item" data-session-id="${id}"><span class="session-icon"></span></div>`)
    .join('');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${items}</body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;

  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });
  Object.defineProperty(window, 'activePtyIds', { value: new Set(), writable: true, configurable: true });
  Object.defineProperty(window, 'sessionMap', { value: new Map(), writable: true, configurable: true });

  let onActivityCb = null;
  Object.defineProperty(window, 'api', {
    value: { onSessionTranscriptActivity: (cb) => { onActivityCb = cb; } },
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
    emit: (payload) => onActivityCb(payload),
    snapshot: (id) => vm.runInContext(`localTranscriptState(${JSON.stringify(id)}).snapshot()`, ctx),
    hasState: (id) => vm.runInContext(`localTranscriptStates.has(${JSON.stringify(id)})`, ctx),
    setSessionStatus: (id, status, at) => { window.sessionMap.set(id, { status, statusUpdatedAt: at }); },
    setPty: (id, has) => { if (has) window.activePtyIds.add(id); else window.activePtyIds.delete(id); },
    ptyTakeover: (id) => call('localTranscriptPtyTakeover', id),
    scheduled,
    pending: () => scheduled.filter(h => !h.cleared),
    destroy: () => window.close(),
  };
}

test('a session-transcript-activity event drives the adapter busy, then decay clears busy without arming waitingForInput/attention/response-ready as ready', () => {
  const t = setup(['s1']);
  let snap = t.snapshot('s1');
  assert.equal(snap.busy, false, 'precondition: idle');

  t.emit({ sessionId: 's1', at: Date.now() });
  snap = t.snapshot('s1');
  assert.equal(snap.busy, true, 'the transcript-activity event marks the adapter busy');
  assert.equal(snap.attention, false, 'no PTY exists to ever justify attention');
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'projected onto the row');

  const timer = t.pending()[0];
  assert.ok(timer, 'a decay timer must be scheduled');
  timer.fn(); // simulate the 20s elapsing

  snap = t.snapshot('s1');
  assert.equal(snap.busy, false, 'decay clears busy');
  assert.equal(snap.waitingForInput, true);
  assert.equal(snap.responseReady, false, 'decay must never arm response-ready — no PTY to confirm a turn ended');
  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  assert.ok(!t.item('s1').classList.contains('response-ready'));
  t.destroy();
});

test('an event with no sessionMap entry leaves liveness unknown (no live-CLI signal to borrow)', () => {
  const t = setup(['s1']);
  t.emit({ sessionId: 's1', at: Date.now() });
  assert.equal(t.snapshot('s1').liveness, 'unknown');
  t.destroy();
});

test('an event seeds liveness/descriptorStatus from the session object when session.status is present', () => {
  const t = setup(['s1']);
  t.setSessionStatus('s1', 'idle', 12345);
  t.emit({ sessionId: 's1' });

  const snap = t.snapshot('s1');
  assert.equal(snap.liveness, 'alive');
  assert.equal(snap.lastActivitySource, 'descriptor');
  t.destroy();
});

test('an event is ignored outright for a session that already has a PTY in this app', () => {
  const t = setup(['s1']);
  t.setPty('s1', true);
  t.emit({ sessionId: 's1', at: Date.now() });
  assert.equal(t.hasState('s1'), false, 'the OSC path owns this row; the adapter must not even allocate state for it');
  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  t.destroy();
});

test('PTY takeover clears the pending decay timer and drops the adapter state, so a later event (once a PTY exists) is a no-op', () => {
  const t = setup(['s1']);
  t.emit({ sessionId: 's1', at: Date.now() });
  assert.equal(t.hasState('s1'), true);
  assert.equal(t.pending().length, 1);

  t.ptyTakeover('s1');
  assert.equal(t.hasState('s1'), false, 'the local-pty path now owns this row');
  assert.equal(t.pending().length, 0, 'the decay timer must not fire after takeover and repaint a stale snapshot');

  t.setPty('s1', true);
  t.emit({ sessionId: 's1', at: Date.now() });
  assert.equal(t.hasState('s1'), false, 'once the row has a PTY, the adapter must stay silent for it');
  t.destroy();
});

test('a mutant decay that arms response-ready would be caught here', () => {
  // Mutation proof for the brief's required check: flip armReady to true on
  // decay and this test goes red — see HANDOFF for the executed proof.
  const t = setup(['s1']);
  t.emit({ sessionId: 's1', at: Date.now() });
  const timer = t.pending()[0];
  timer.fn();
  assert.equal(t.snapshot('s1').responseReady, false);
  t.destroy();
});

// Subagent attribution (issue #247) — a subagent write whose parent has no
// PTY in this app is attributed to the parent's own local-transcript state.
// See .ai/contexts/subagent-observability.md ("Attribution across sources").

test('a subagent activity event marks the parent agentsBusy, then decay clears it (parent has no PTY)', () => {
  const t = setup(['p1']);
  let snap = t.snapshot('p1');
  assert.equal(snap.agentsBusy, false, 'precondition: no subagents');

  t.emit({ parentSessionId: 'p1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
  snap = t.snapshot('p1');
  assert.equal(snap.agentsBusy, true, 'the subagent write marks the parent agentsBusy');
  assert.ok(t.item('p1').classList.contains('has-busy-agents'), 'projected onto the parent row');

  const timer = t.pending()[0];
  assert.ok(timer, 'a decay timer must be scheduled');
  timer.fn(); // simulate the 20s elapsing

  snap = t.snapshot('p1');
  assert.equal(snap.agentsBusy, false, 'decay clears agentsBusy');
  assert.ok(!t.item('p1').classList.contains('has-busy-agents'));
  t.destroy();
});

test('a subagent activity event is dropped outright when the parent already has a PTY in this app', () => {
  const t = setup(['p1']);
  t.setPty('p1', true);
  t.emit({ parentSessionId: 'p1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
  assert.equal(t.hasState('p1'), false, 'the IPC path (detectSubagentTransitions) already owns this parent');
  assert.ok(!t.item('p1').classList.contains('has-busy-agents'));
  t.destroy();
});

test('the subagent decay timer is independent of the parent\'s own busy decay timer', () => {
  const t = setup(['p1']);
  t.emit({ sessionId: 'p1', at: Date.now() }); // parent's own transcript activity
  const busyTimer = t.pending()[0];
  t.emit({ parentSessionId: 'p1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
  assert.equal(t.pending().length, 2, 'busy decay and agentsBusy decay are two separate timers');
  const agentsTimer = t.pending()[1];

  const before = t.snapshot('p1');
  assert.equal(before.busy, true);
  assert.equal(before.agentsBusy, true);

  agentsTimer.fn(); // resolve the subagent decay only
  const afterAgents = t.snapshot('p1');
  assert.equal(afterAgents.busy, true, 'the parent\'s own busy signal must be unaffected');
  assert.equal(afterAgents.agentsBusy, false, 'the subagent decay cleared agentsBusy alone');

  busyTimer.fn(); // resolve the parent's own busy decay
  const afterBoth = t.snapshot('p1');
  assert.equal(afterBoth.busy, false);
  assert.equal(afterBoth.agentsBusy, false);
  t.destroy();
});

test('PTY takeover also clears a pending subagent decay timer', () => {
  const t = setup(['p1']);
  t.emit({ parentSessionId: 'p1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
  assert.equal(t.pending().length, 1);

  t.ptyTakeover('p1');
  assert.equal(t.hasState('p1'), false);
  assert.equal(t.pending().length, 0, 'the subagent decay timer must not fire after takeover');
  t.destroy();
});

test('a mutant subagent decay that leaves agentsBusy stillActive would be caught here', () => {
  // Mutation proof: flip stillActive to true on decay and this test goes red.
  const t = setup(['p1']);
  t.emit({ parentSessionId: 'p1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
  t.pending()[0].fn();
  assert.equal(t.snapshot('p1').agentsBusy, false);
  t.destroy();
});
