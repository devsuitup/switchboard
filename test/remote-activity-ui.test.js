// Tests for public/remote-activity-ui.js — the sidebar's remote
// transcript-write signal. Since #243 it goes through the same central
// dispatcher local PTY output uses: session-activity.js's
// setActivity(sessionId, active, via), which owns sessionBusyState,
// activitySeq, the response-ready transition and the trace — never a direct
// write. See .ai/contexts/session-cache.md ("Remote hosts — busy spinner
// (issue #242)"). Evaluated standalone in jsdom together with the real
// session-activity.js, same technique as test/session-activity.test.js:
// split out precisely so it can be exercised without the rest of app.js
// (which builds ViewerPanel/xterm at module scope and cannot be eval'd in
// isolation).
//
// setTimeout/clearTimeout are stubbed on the jsdom window so the 20s decay
// is driven by hand instead of a real wall-clock wait.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

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
  vm.runInContext(fs.readFileSync(ACTIVITY_SRC, 'utf8'), ctx, { filename: ACTIVITY_SRC });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });

  const read = (expr) => vm.runInContext(expr, ctx);

  return {
    window,
    document: window.document,
    item: (id) => window.document.querySelector(`.session-item[data-session-id="${id}"]`),
    emit: (payload) => onRemoteActivityCb(payload),
    scheduled,
    pending: () => scheduled.filter(h => !h.cleared),
    pruneRemoteActivityTimers: read('pruneRemoteActivityTimers'),
    remoteActivityDecayTimers: read('remoteActivityDecayTimers'),
    sessionBusyState: read('sessionBusyState'),
    responseReadySessions: read('responseReadySessions'),
    destroy: () => window.close(),
  };
}

test('a remote-activity event marks the matching row busy through setActivity', () => {
  const t = setup(['s1']);
  assert.ok(!t.item('s1').classList.contains('cli-busy'), 'precondition: row starts idle');

  t.emit({ alias: 'vps', sessionId: 's1', at: Date.now() });

  assert.equal(t.sessionBusyState.get('s1'), true, 'sessionBusyState is set through the central dispatcher');
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'the row must go busy, same as a local session');
  t.destroy();
});

test('a payload with no sessionId is ignored', () => {
  const t = setup(['s1']);
  t.emit({ alias: 'vps' });
  t.emit(null);
  t.emit(undefined);

  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  assert.equal(t.scheduled.length, 0, 'a malformed payload must not schedule a decay timer either');
  t.destroy();
});

test('.cli-busy clears once the decay timer fires, and not before', () => {
  const t = setup(['s1']);
  t.emit({ sessionId: 's1' });
  assert.ok(t.item('s1').classList.contains('cli-busy'));

  const timer = t.pending()[0];
  assert.ok(timer, 'a decay timer must be scheduled');
  assert.equal(timer.ms, 20000, 'the decay window is 20s');

  // Before the timer fires, the row stays busy.
  assert.ok(t.item('s1').classList.contains('cli-busy'));

  timer.fn(); // simulate the 20s elapsing
  assert.ok(!t.item('s1').classList.contains('cli-busy'), 'the row must go idle once the decay window elapses');
  t.destroy();
});

test('decay routes through setActivity with armReady:false: a non-selected remote session clears busy WITHOUT landing in responseReadySessions', () => {
  // F3: 20s of transcript silence means "stopped writing", not "the response
  // is ready" — a remote adapter has no PTY to confirm a turn actually ended
  // (a long tool call, or a parent delegating to subagents whose own
  // transcript stays silent). Decay must not claim the turn is done.
  const t = setup(['s1']);
  t.window.activeSessionId = 's2'; // s1 is not the focused session
  t.emit({ sessionId: 's1' });
  assert.ok(!t.responseReadySessions.has('s1'), 'precondition: not response-ready while busy');

  t.pending()[0].fn(); // decay fires

  assert.equal(t.sessionBusyState.get('s1'), false, 'busy is cleared');
  assert.ok(!t.responseReadySessions.has('s1'), 'decay must NOT arm the unread/response-ready marker');
  assert.ok(!t.item('s1').classList.contains('cli-busy'), 'the spinner is off');
  assert.ok(!t.item('s1').classList.contains('response-ready'), 'the row must not claim a finished response it never measured');
  t.destroy();
});

test('a second event before decay resets the timer instead of stacking one', () => {
  const t = setup(['s1']);
  t.emit({ sessionId: 's1' });
  const first = t.pending()[0];

  t.emit({ sessionId: 's1' });

  assert.equal(first.cleared, true, 'the earlier timer must be cancelled, not left to also fire');
  assert.equal(t.pending().length, 1, 'exactly one live decay timer per session');

  // Firing the (now-cancelled) first timer's callback would be a stale fire
  // in the real world — clearTimeout prevents that from ever happening — but
  // confirm the surviving timer is the one that actually clears the row.
  const second = t.pending()[0];
  second.fn();
  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  t.destroy();
});

test('pruneRemoteActivityTimers cancels a timer whose row no longer exists', () => {
  const t = setup(['s1', 's2']);
  t.emit({ sessionId: 's1' });
  t.emit({ sessionId: 's2' });
  assert.equal(t.pending().length, 2);

  t.item('s2').remove(); // e.g. the session was archived out of the sidebar
  t.pruneRemoteActivityTimers();

  assert.equal(t.remoteActivityDecayTimers.has('s2'), false, 'the orphaned timer entry must be dropped');
  assert.equal(t.remoteActivityDecayTimers.has('s1'), true, 'a timer for a row that still exists must survive the sweep');
  t.destroy();
});
