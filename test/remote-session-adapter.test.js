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

test('setRemoteAttached(true) toggles the attached flag without affecting busy/liveness; setRemoteAttached(false) hands ownership back — see test/remote-row-ownership.test.js (#273) for the full handoff', () => {
  const t = setup(['s1']);
  t.setRemoteAttached('s1', true);
  assert.equal(t.snapshot('s1').attached, true);
  assert.equal(t.snapshot('s1').busy, false, 'attaching must not touch busy');

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

// Subagent attribution (issue #247) — a remote agent-<id>.jsonl write,
// previously dropped by sessionIdFromRel, is now attributed to its parent
// and lights that parent's has-busy-agents. See
// .ai/contexts/subagent-observability.md ("Attribution across sources").

test('a subagent activity event marks the parent agentsBusy, projects has-busy-agents + the agents-busy icon slot, then decay clears both', () => {
  const t = setup(['s1']);
  let snap = t.snapshot('s1');
  assert.equal(snap.agentsBusy, false, 'precondition: no subagents');

  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
  snap = t.snapshot('s1');
  assert.equal(snap.agentsBusy, true, 'the subagent write marks the parent agentsBusy');
  const item = t.item('s1');
  assert.ok(item.classList.contains('has-busy-agents'), 'projected onto the parent row');

  const timer = t.pending()[0];
  assert.ok(timer, 'a decay timer must be scheduled');
  timer.fn(); // simulate the 20s elapsing

  snap = t.snapshot('s1');
  assert.equal(snap.agentsBusy, false, 'decay clears agentsBusy');
  assert.ok(!t.item('s1').classList.contains('has-busy-agents'));
  t.destroy();
});

test('within the coalescing window, the parent shows the agents-busy icon rung when nothing higher is active', () => {
  const t = setup(['s1']);
  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

  const { renderSessionIcon } = require('../public/session-state.js');
  const icon = renderSessionIcon(t.snapshot('s1'));
  assert.ok(icon.slotClasses.includes('session-icon--agents-busy'),
    'agentsBusy is the winning rung when busy/attention/responseReady are all inactive');
  t.destroy();
});

test('a mutant subagent decay that leaves agentsBusy stillActive would be caught here', () => {
  // Mutation proof: flip stillActive to true on decay and this test goes red.
  const t = setup(['s1']);
  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
  t.pending()[0].fn();
  assert.equal(t.snapshot('s1').agentsBusy, false);
  t.destroy();
});

// Issue #284 — a Task-tool invocation touches the parent's own transcript as
// well as the subagent leg. Two designs were tried and rejected before this
// one (see .ai/contexts/session-state.md for why): the current fix shortens
// the parent's busy DECAY to SUBAGENT_PARENT_DECAY_MS (3s) while agentsBusy is
// true, instead of a coincidence window keyed off the spawn edge — no edge,
// so a second/third spawned agent is covered exactly like the first, and
// `busy` is never cleared synchronously, only its pending decay rescheduled.
//
// These tests need a clock genuinely independent of wall time: `advance(ms)`
// below moves a virtual clock, backs both `Date.now()` and `setTimeout`'s
// scheduled fire time, and fires any timer whose deadline has been crossed —
// the same shape as dom-sidebar-remote-activity-pip.test.js's
// installFakeTimers, plus the Date.now stub these assertions also need.

function setupWithClock(sessionIds = ['s1']) {
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

  let clock = 0;
  window.Date.now = () => clock;

  const timers = [];
  let nextId = 1;
  Object.defineProperty(window, 'setTimeout', {
    value: (fn, ms) => {
      const t = { id: nextId++, at: clock + ms, fn, cleared: false, fired: false };
      timers.push(t);
      return t.id;
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'clearTimeout', {
    value: (id) => {
      const t = timers.find(t => t.id === id);
      if (t) t.cleared = true;
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
    now: () => clock,
    emit: (payload) => onRemoteActivityCb(payload),
    snapshot: (id) => vm.runInContext(`remoteState(${JSON.stringify(id)}).snapshot()`, ctx),
    seedRemoteActivity: (session) => call('seedRemoteActivity', session),
    advance(ms) {
      clock += ms;
      for (const t of timers) {
        if (!t.cleared && !t.fired && t.at <= clock) { t.fired = true; t.fn(); }
      }
    },
    destroy: () => window.close(),
  };
}

test('(1) a genuinely busy parent (touch every ~1s) with a running subagent never lets busy lapse', () => {
  const t = setupWithClock(['s1']);
  t.emit({ sessionId: 's1', at: t.now() }); // touch @0

  t.advance(1000); // -> 1000
  t.emit({ sessionId: 's1', at: t.now() }); // touch @1000
  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-1', at: t.now(), kind: 'subagent' }); // spawn @1000

  t.advance(200); // -> 1200
  assert.equal(t.snapshot('s1').busy, true, 'busy at t=1200');

  t.advance(800); // -> 2000
  t.emit({ sessionId: 's1', at: t.now() }); // touch @2000
  t.advance(500); // -> 2500
  assert.equal(t.snapshot('s1').busy, true, 'busy at t=2500');

  t.advance(500); // -> 3000
  t.emit({ sessionId: 's1', at: t.now() }); // touch @3000
  t.advance(1000); // -> 4000
  t.emit({ sessionId: 's1', at: t.now() }); // touch @4000
  assert.equal(t.snapshot('s1').busy, true, 'busy at t=4000');
  t.destroy();
});

test('(2) a touch coincident with a fresh spawn still shows busy briefly, then decays to agentsBusy alone', () => {
  const t = setupWithClock(['s1']);
  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-1', at: t.now(), kind: 'subagent' }); // spawn @0

  t.advance(100); // -> 100
  t.emit({ sessionId: 's1', at: t.now() }); // touch @100

  t.advance(900); // -> 1000
  let snap = t.snapshot('s1');
  assert.equal(snap.busy, true, 'busy at t=1000');
  assert.equal(snap.agentsBusy, true);

  t.advance(2200); // -> 3200, the 3s decay armed at t=100 (fires at 3100) has elapsed
  snap = t.snapshot('s1');
  assert.equal(snap.busy, false, 'busy false at t=3200');
  assert.equal(snap.agentsBusy, true, 'agentsBusy stays true — only busy decayed');
  t.destroy();
});

test('(3) a second subagent spawned while the first still runs still shortens a coincident touch\'s decay — no edge needed', () => {
  const t = setupWithClock(['s1']);
  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-1', at: t.now(), kind: 'subagent' }); // 1st spawn @0

  t.advance(10000); // -> 10000, well before the 1st spawn's own 20s agentsBusy decay
  assert.equal(t.snapshot('s1').agentsBusy, true, 'precondition: agentsBusy already true, no edge available');

  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-2', at: t.now(), kind: 'subagent' }); // 2nd spawn @10000

  t.advance(100); // -> 10100
  t.emit({ sessionId: 's1', at: t.now() }); // touch @10100

  t.advance(3100); // -> 13200, past the 3s decay armed at t=10100 (fires at 13100)
  assert.equal(t.snapshot('s1').busy, false, 'busy false at t=13200 — the touch got the short decay despite no edge');
  t.destroy();
});

test('(4) a parent with no subagent keeps the full 20s decay', () => {
  const t = setupWithClock(['s1']);
  t.emit({ sessionId: 's1', at: t.now() }); // touch @0

  t.advance(15000); // -> 15000
  assert.equal(t.snapshot('s1').busy, true, 'busy still true at t=15000, well inside 20s');

  t.advance(5001); // -> 20001, past the 20s decay
  assert.equal(t.snapshot('s1').busy, false, 'busy false once the 20s decay elapses');
  t.destroy();
});

// seedRemoteActivity's own arm used to stay PIP_DECAY_MS-based regardless of
// agentsBusy — renderProjects calls it on every full rebuild, and rebuilds
// are themselves triggered by the subagent's own writes, so a waiting parent
// whose short decay had already fired got re-armed onto the animated busy
// rung for up to 20s at the very next rebuild. See .ai/contexts/session-state.md.

test('(5) a rebuild after the short decay already fired must not re-arm busy for 20s', () => {
  const t = setupWithClock(['s1']);
  t.emit({ sessionId: 's1', at: t.now() }); // touch @0
  t.advance(1000); // -> 1000
  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-1', at: t.now(), kind: 'subagent' }); // spawn @1000, reschedules the decay to fire @4000

  t.advance(3000); // -> 4000, the short decay fires
  let snap = t.snapshot('s1');
  assert.equal(snap.busy, false, 'precondition: the short decay already cleared busy at t=4000');

  t.advance(1000); // -> 5000, renderProjects rebuilds (often provoked by the subagent's own write)
  t.seedRemoteActivity({ sessionId: 's1', remoteAlias: 'vps', remoteActiveAt: 1000, remoteDescriptorSeen: true });

  snap = t.snapshot('s1');
  assert.equal(snap.busy, false, 'a rebuild at t=5000 must not re-arm busy for another 20s');
  assert.equal(snap.agentsBusy, true, 'agentsBusy is untouched by the seed path');
  t.destroy();
});

test('(6) a rebuild inside the short window re-arms only for what is left of it, not the full 20s', () => {
  const t = setupWithClock(['s1']);
  t.emit({ alias: 'vps', parentSessionId: 's1', agentId: 'agent-1', at: t.now(), kind: 'subagent' }); // spawn @0, no busy touch emitted live

  t.advance(2000); // -> 2000, a rebuild seeds from the descriptor's last-seen activity at t=0
  t.seedRemoteActivity({ sessionId: 's1', remoteAlias: 'vps', remoteActiveAt: 0, remoteDescriptorSeen: true });
  assert.equal(t.snapshot('s1').busy, true, 'seed arms busy from the short window (0 + 3000 - 2000 = 1000ms left)');

  t.advance(999); // -> 2999, just before the window (0 + 3000) closes
  assert.equal(t.snapshot('s1').busy, true, 'busy still held just before t=3000');

  t.advance(2); // -> 3001, past t=3000
  assert.equal(t.snapshot('s1').busy, false, 'busy decays at t=3000 — the short window, not the full 20s');
  t.destroy();
});
