// Tests for the local-pty adapter in public/session-activity.js — see
// .ai/contexts/session-state.md ("The local-pty adapter"). Same eval-in-jsdom
// technique as test/remote-session-adapter.test.js and
// test/local-transcript-adapter.test.js: the real session-state.js /
// session-activity-dom.js / session-activity.js, loaded in index.html order.
//
// test/session-activity.test.js already pins the caller-facing contract
// (setActivity/clearUnread/rekeyActivityState/purgeActivityFor/reconcileBusyState
// signatures and the response-ready-holds-idle rule). This file pins the
// adapter's own persisted state: one createSessionState('local-pty') per
// session id, event sequence -> snapshot, and that busy/responseReady/
// attention exclusivity is now enforced by the domain, not reconstructable
// through the public API.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const STATE_SRC = path.join(__dirname, '..', 'public', 'session-state.js');
const DOM_SRC = path.join(__dirname, '..', 'public', 'session-activity-dom.js');
const SRC = path.join(__dirname, '..', 'public', 'session-activity.js');

function setup(sessionIds = ['s1']) {
  const items = sessionIds
    .map(id => `<div class="session-item" data-session-id="${id}"><span class="session-icon"></span></div>`)
    .join('');
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${items}</body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;

  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(STATE_SRC, 'utf8'), ctx, { filename: STATE_SRC });
  vm.runInContext(fs.readFileSync(DOM_SRC, 'utf8'), ctx, { filename: DOM_SRC });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });

  const read = (expr) => vm.runInContext(expr, ctx);
  return {
    window,
    document: window.document,
    item: (id) => window.document.querySelector(`.session-item[data-session-id="${id}"]`),
    icon: (id) => window.document.querySelector(`.session-item[data-session-id="${id}"] .session-icon`),
    setActivity: read('setActivity'),
    clearUnread: read('clearUnread'),
    setAttention: read('setAttention'),
    syncLocalPtyAgentsBusy: read('syncLocalPtyAgentsBusy'),
    purgeActivityFor: read('purgeActivityFor'),
    rekeyActivityState: read('rekeyActivityState'),
    snapshot: (id) => vm.runInContext(`localPtyState(${JSON.stringify(id)}).snapshot()`, ctx),
    hasState: (id) => vm.runInContext(`localPtyStates.has(${JSON.stringify(id)})`, ctx),
    destroy: () => window.close(),
  };
}

// ---------------------------------------------------------------------------
// Event sequence -> snapshot
// ---------------------------------------------------------------------------

test('a fresh session has no persisted state until first touched', () => {
  const t = setup();
  assert.equal(t.hasState('s1'), false);
  t.destroy();
});

test('setActivity(true) then setActivity(false) drives the persisted snapshot, not a throwaway one', () => {
  const t = setup();
  t.window.activeSessionId = 's2'; // s1 unfocused

  t.setActivity('s1', true, 'onCliBusyState');
  assert.equal(t.snapshot('s1').busy, true);
  assert.equal(t.snapshot('s1').kind, 'local-pty');

  t.setActivity('s1', false, 'onCliBusyState');
  const snap = t.snapshot('s1');
  assert.equal(snap.busy, false);
  assert.equal(snap.waitingForInput, true);
  assert.equal(snap.responseReady, true);

  t.destroy();
});

test('setAttention feeds the same persisted state (event sequence -> snapshot)', () => {
  const t = setup();
  t.setAttention('s1', true, 'onTerminalNotification');
  assert.equal(t.snapshot('s1').attention, true);
  assert.ok(t.item('s1').classList.contains('needs-attention'));

  t.setAttention('s1', false, 'clearNotifications');
  assert.equal(t.snapshot('s1').attention, false);
  assert.ok(!t.item('s1').classList.contains('needs-attention'));

  t.destroy();
});

test('syncLocalPtyAgentsBusy feeds agentsBusy into an existing persisted state', () => {
  const t = setup();
  t.setActivity('s1', true); // an entry must already exist — see the next test

  t.syncLocalPtyAgentsBusy('s1', true);
  assert.equal(t.snapshot('s1').agentsBusy, true);

  t.syncLocalPtyAgentsBusy('s1', false);
  assert.equal(t.snapshot('s1').agentsBusy, false);
  t.destroy();
});

// Adversarial review of PR #282 (item 4): syncLocalPtyAgentsBusy used to call
// the auto-vivifying localPtyState(), leaking a blank entry for every parent
// id reflectSubagentRunningState is ever called with — including a parent
// whose row is gone, filtered, or that will never be a local-pty row at all.
test('syncLocalPtyAgentsBusy never creates a state for a parent with no existing entry', () => {
  const t = setup();
  assert.equal(t.hasState('s1'), false, 'precondition: untouched');

  t.syncLocalPtyAgentsBusy('s1', true);

  assert.equal(t.hasState('s1'), false, 'must not auto-vivify — see .ai/contexts/session-state.md ("The local-pty adapter")');
  t.destroy();
});

test('snapshot() is complete for a local row: busy, attention and agentsBusy all present together', () => {
  const t = setup();
  t.setActivity('s1', true);
  t.syncLocalPtyAgentsBusy('s1', true);
  const snap = t.snapshot('s1');
  assert.equal(snap.busy, true);
  assert.equal(snap.agentsBusy, true, 'agentsBusy survives an unrelated busy transition');
  t.destroy();
});

// ---------------------------------------------------------------------------
// Exclusivity now enforced by the domain — impossible through the public API
// ---------------------------------------------------------------------------

test('busy and response-ready can never both be true through the public API', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  for (const active of [true, false, true, false, true]) {
    t.setActivity('s1', active);
    const snap = t.snapshot('s1');
    assert.ok(!(snap.busy && snap.responseReady), 'busy and responseReady must never coexist');
  }
  t.destroy();
});

test('attention fired while busy clears busy — an attention edge still wins', () => {
  const t = setup();
  t.setActivity('s1', true);
  assert.equal(t.snapshot('s1').busy, true);

  t.setAttention('s1', true, 'onTerminalNotification');
  const snap = t.snapshot('s1');
  assert.equal(snap.attention, true);
  assert.equal(snap.busy, false, 'an attention EVENT still clears busy — only a later busy edge must not clear attention back (see the next test)');
  t.destroy();
});

// Regression (adversarial review of PR #282): an OSC-0 busy title arriving
// while a permission prompt is open (two independent IPC streams) used to
// wipe needs-attention. Decided: attention is cleared only by an explicit
// attention:false (clearNotifications) — never by a busy edge. See
// .ai/contexts/session-state.md ("The local-pty adapter").
test('a busy edge after attention does NOT clear attention — attention is orthogonal to busy', () => {
  const t = setup();
  t.setAttention('s1', true, 'onTerminalNotification');
  assert.equal(t.snapshot('s1').attention, true);

  t.setActivity('s1', true, 'onCliBusyState'); // OSC 0 busy title fires independently
  const busySnap = t.snapshot('s1');
  assert.equal(busySnap.attention, true, 'a busy edge must never clear attention');
  assert.equal(busySnap.busy, true);
  assert.ok(t.item('s1').classList.contains('needs-attention'));
  assert.ok(t.item('s1').classList.contains('cli-busy'));

  t.setAttention('s1', false, 'clearNotifications'); // only an explicit clear removes it
  const clearedSnap = t.snapshot('s1');
  assert.equal(clearedSnap.attention, false);
  assert.equal(clearedSnap.busy, true, 'busy remains untouched by the attention clear');
  assert.ok(!t.item('s1').classList.contains('needs-attention'));
  assert.ok(t.item('s1').classList.contains('cli-busy'));
  t.destroy();
});

test('attention while response-ready clears response-ready — cannot force the combination', () => {
  const t = setup();
  t.window.activeSessionId = 's2';
  t.setActivity('s1', true);
  t.setActivity('s1', false); // response-ready armed
  assert.equal(t.snapshot('s1').responseReady, true);

  t.setAttention('s1', true, 'onTerminalNotification');
  const snap = t.snapshot('s1');
  assert.equal(snap.attention, true);
  assert.equal(snap.responseReady, false, 'the two are exclusive by construction, not by caller discipline');
  t.destroy();
});

test('decided (not a regression): attention after response-ready, then clearing attention does not restore response-ready', () => {
  // Behavior change from the pre-migration independent Sets, documented in
  // .ai/contexts/session-state.md ("Decided: attention supersedes and
  // consumes the unseen-response state"). Old behavior: responseReadySessions
  // and attentionSessions were independent, so clearing attention re-exposed
  // response-ready underneath it. New behavior: attention:true calls the
  // domain's clearExclusive(), erasing responseReady, not just outshining it
  // — clearing attention afterwards lands on plain idle, never back on
  // response-ready.
  const t = setup();
  t.window.activeSessionId = 's2'; // s1 unfocused, the case that arms response-ready

  t.setActivity('s1', true);
  t.setActivity('s1', false); // idle, unseen -> response-ready armed
  assert.equal(t.snapshot('s1').responseReady, true, 'precondition: response-ready armed');

  t.setAttention('s1', true, 'onTerminalNotification'); // OSC 9 interrupts it
  assert.equal(t.snapshot('s1').attention, true);
  assert.equal(t.snapshot('s1').responseReady, false, 'response-ready consumed, not merely outshone');

  t.setAttention('s1', false, 'clearNotifications'); // user handles it, attention clears
  const snap = t.snapshot('s1');
  assert.equal(snap.attention, false);
  assert.equal(snap.responseReady, false, 'must NOT fall back to response-ready — that fact is gone, not hidden');
  assert.ok(!t.item('s1').classList.contains('response-ready'));
  assert.ok(!t.item('s1').classList.contains('needs-attention'));
  t.destroy();
});

// ---------------------------------------------------------------------------
// Decided: a local row idling while active (or armReady:false) now shows
// "Waiting for input", not "Idle" — see .ai/contexts/session-state.md
// ("The local-pty adapter").
// ---------------------------------------------------------------------------

test('decided: a local row going idle while active shows "Waiting for input", not "Idle"', () => {
  const t = setup();
  t.window.activeSessionId = 's1'; // s1 IS the focused session

  t.setActivity('s1', true);
  t.setActivity('s1', false); // idle while active -> must not arm response-ready
  const snap = t.snapshot('s1');
  assert.equal(snap.busy, false);
  assert.equal(snap.waitingForInput, true);
  assert.equal(snap.responseReady, false);

  const icon = t.icon('s1');
  assert.ok(icon.classList.contains('session-icon--waiting'));
  assert.equal(icon.title, 'Waiting for input');
  t.destroy();
});

test('decided: a local row going idle NOT active still arms response-ready (unchanged)', () => {
  const t = setup();
  t.window.activeSessionId = 's2'; // s1 not focused

  t.setActivity('s1', true);
  t.setActivity('s1', false);
  const snap = t.snapshot('s1');
  assert.equal(snap.responseReady, true);

  const icon = t.icon('s1');
  assert.ok(icon.classList.contains('session-icon--response-ready'));
  assert.equal(icon.title, 'Response ready');
  t.destroy();
});

// ---------------------------------------------------------------------------
// rekey/purge move/drop the whole persisted state, not per-field collections
// ---------------------------------------------------------------------------

test('rekeyActivityState moves the whole persisted state object, not a copy', () => {
  const t = setup(['old', 'new']);
  t.setActivity('old', true);
  t.syncLocalPtyAgentsBusy('old', true);

  t.rekeyActivityState('old', 'new');

  assert.equal(t.hasState('old'), false, 'the old id carries no state after rekey');
  assert.equal(t.hasState('new'), true);
  const snap = t.snapshot('new');
  assert.equal(snap.busy, true);
  assert.equal(snap.agentsBusy, true, 'every facet of the state moves together, not just busy');
  t.destroy();
});

test('purgeActivityFor drops the whole persisted state object', () => {
  const t = setup();
  t.setActivity('s1', true);
  t.setAttention('s1', true, 'x');
  assert.equal(t.hasState('s1'), true);

  t.purgeActivityFor('s1', 'pty-gone');

  assert.equal(t.hasState('s1'), false, 'the entire state is dropped, not individually cleared fields');
  t.destroy();
});

// ---------------------------------------------------------------------------
// Mutation target: setActivity must go through state.apply(), not write the
// legacy view directly — bypassing the domain drops waitingForInput/
// responseReady, fields only apply() knows how to set.
// ---------------------------------------------------------------------------

test('mutation guard: setActivity must arm waitingForInput via apply(), not merely flip a busy boolean', () => {
  // If setActivity were rewritten to call sessionBusyState.set(id, active)
  // instead of localPtyState(id).apply({ type: 'busy', ... }), this goes red:
  // waitingForInput/responseReady only exist because apply() derives them,
  // a raw boolean flip on the legacy view cannot produce them.
  const t = setup();
  t.window.activeSessionId = 's2';
  t.setActivity('s1', true);
  t.setActivity('s1', false);
  const snap = t.snapshot('s1');
  assert.equal(snap.waitingForInput, true, 'waitingForInput must come from apply(), not a bypassed write');
  assert.equal(snap.responseReady, true);
  t.destroy();
});
