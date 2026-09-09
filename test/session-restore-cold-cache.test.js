// Tests for the cold-cache restore retry (issue #205).
//
// planWorkingSetRestore (public/restore-plan.js) is the actual decision this
// bug lives in: telling "not indexed yet" apart from "genuinely deleted" when
// a saved working-set item is missing from sessionMap. It is require()'d
// directly below — never re-implemented — so reverting the fix in
// public/restore-plan.js (or the app.js call site) turns these tests red.
// See .work-files/switchboard/restore-cold-cache-report.md.
//
// The DOM/IO orchestration around it (app.js's restoreWorkingSet() /
// maybeRetryRestoreWorkingSet() — toasts, retry-once bookkeeping) still can't
// be loaded via vm.runInContext without prohibitive DOM scaffolding (see
// test/session-restore.test.js, same codebase precedent). The wiring harness
// in the second half of this file reproduces only that bookkeeping and always
// delegates the actual candidate-selection decision to the real, required
// planWorkingSetRestore — nothing about *what gets restored* is duplicated.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planWorkingSetRestore } = require('../public/restore-plan');

// ---------------------------------------------------------------------------
// planWorkingSetRestore — direct coverage of the real, shipped decision.
// ---------------------------------------------------------------------------

// Acceptance test 1 (issue #205): working set non-empty, sessionMap empty at
// decision time, then populated — the sessions must come back.

test('planWorkingSetRestore: sessionMap empty at decision time → defer, not drop', () => {
  const savedSet = [
    { sessionId: 'sa', projectPath: '/a', active: false },
    { sessionId: 'sb', projectPath: '/b', active: true },
  ];
  const plan = planWorkingSetRestore({
    savedSet,
    sessionMap: new Map(), // cold cache: initial scan hasn't written anything yet
    openSessions: new Map(),
    retryDone: false,
    sessionOpenedOutsideRestore: false,
  });

  assert.equal(plan.action, 'defer', 'must not silently drop the working set while the cache is cold');
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.notYetIndexedCount, 2);
});

test('planWorkingSetRestore: same saved set, sessionMap now populated → restore both', () => {
  const savedSet = [
    { sessionId: 'sa', projectPath: '/a', active: false },
    { sessionId: 'sb', projectPath: '/b', active: true },
  ];
  const plan = planWorkingSetRestore({
    savedSet,
    sessionMap: new Map([
      ['sa', { sessionId: 'sa' }],
      ['sb', { sessionId: 'sb' }],
    ]),
    openSessions: new Map(),
    retryDone: true, // the one retry firing, per app.js's guard
    sessionOpenedOutsideRestore: false,
  });

  assert.equal(plan.action, 'restore');
  assert.deepEqual(plan.candidates.map(i => i.sessionId).sort(), ['sa', 'sb'], 'both saved sessions come back once indexed');
});

// Acceptance test 2: a saved session genuinely absent from the finished
// index is dropped, the others still restore.

test('planWorkingSetRestore: a session absent from the finished index is dropped, others restored', () => {
  const savedSet = [
    { sessionId: 'sa', projectPath: '/a', active: false },
    { sessionId: 'gone', projectPath: '/x', active: true },
  ];
  const plan = planWorkingSetRestore({
    savedSet,
    sessionMap: new Map([['sa', { sessionId: 'sa' }]]), // 'gone' never shows up — finished index
    openSessions: new Map(),
    retryDone: true,
    sessionOpenedOutsideRestore: false,
  });

  assert.equal(plan.action, 'restore');
  assert.equal(plan.candidates.length, 1, 'the missing session is dropped');
  assert.equal(plan.candidates[0].sessionId, 'sa', 'the surviving session is restored');
});

// Guard branches

test('planWorkingSetRestore: empty saved set → nothing, never defer', () => {
  const plan = planWorkingSetRestore({
    savedSet: [], sessionMap: new Map(), openSessions: new Map(),
    retryDone: false, sessionOpenedOutsideRestore: false,
  });
  assert.equal(plan.action, 'nothing');
  assert.equal(plan.notYetIndexedCount, 0);
});

test('planWorkingSetRestore: everything already open → nothing (not the cold-cache case)', () => {
  const savedSet = [{ sessionId: 'sa', projectPath: '/a', active: true }];
  const plan = planWorkingSetRestore({
    savedSet,
    sessionMap: new Map([['sa', { sessionId: 'sa' }]]),
    openSessions: new Map([['sa', { closed: false }]]), // already open
    retryDone: false,
    sessionOpenedOutsideRestore: false,
  });

  assert.equal(plan.action, 'nothing', 'nothing missing from the index -- no retry warranted');
});

test('planWorkingSetRestore: retryDone → never defers again, even if still not indexed', () => {
  const savedSet = [{ sessionId: 'sa', projectPath: '/a', active: true }];
  const plan = planWorkingSetRestore({
    savedSet, sessionMap: new Map(), openSessions: new Map(),
    retryDone: true, sessionOpenedOutsideRestore: false,
  });

  assert.equal(plan.action, 'nothing', 'the one retry was already spent -- must not defer forever');
});

test('planWorkingSetRestore: sessionOpenedOutsideRestore → never defers, even if still not indexed', () => {
  const savedSet = [{ sessionId: 'sa', projectPath: '/a', active: true }];
  const plan = planWorkingSetRestore({
    savedSet, sessionMap: new Map(), openSessions: new Map(),
    retryDone: false, sessionOpenedOutsideRestore: true,
  });

  assert.equal(plan.action, 'nothing', 'the user acted themselves -- no automatic restore behind them');
});

test('planWorkingSetRestore: candidates already available take priority over deferring', () => {
  const savedSet = [
    { sessionId: 'sa', projectPath: '/a', active: false },
    { sessionId: 'sc', projectPath: '/c', active: true },
  ];
  const plan = planWorkingSetRestore({
    savedSet,
    sessionMap: new Map([['sa', { sessionId: 'sa' }]]), // 'sc' not indexed yet
    openSessions: new Map(),
    retryDone: false,
    sessionOpenedOutsideRestore: false,
  });

  assert.equal(plan.action, 'restore', 'restore what is ready now rather than waiting');
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].sessionId, 'sa');
});

// ---------------------------------------------------------------------------
// Wiring — mirrors app.js's restoreWorkingSet()/maybeRetryRestoreWorkingSet()
// orchestration (toast display, retry-once bookkeeping). The candidate
// decision itself is always delegated to the real planWorkingSetRestore
// required above.
// ---------------------------------------------------------------------------

function makeWiringHarness({ mode = 'ask', savedSet = [] } = {}) {
  const settingsStore = { global: { restoreOnStartup: mode, openWorkingSet: savedSet } };
  const openSessions = new Map();
  const sessionMap = new Map();

  const runRestoreLog = [];
  const toastCalls = [];
  const coldToastCalls = [];
  const removedToastIds = [];

  let restorePendingRetry = false;
  let restoreRetryDone = false;
  let sessionOpenedOutsideRestore = false;

  function removeToast(id) { removedToastIds.push(id); }

  async function runRestore(list) {
    runRestoreLog.push(list.slice());
    for (const item of list) openSessions.set(item.sessionId, { closed: false });
  }

  function showColdCacheNotice(count) {
    removeToast('restore-cold-toast');
    coldToastCalls.push({ count });
  }

  async function restoreWorkingSet() {
    const g = settingsStore.global;
    const modeVal = (g && g.restoreOnStartup) || 'ask';
    const savedSetVal = (g && g.openWorkingSet) || [];

    removeToast('restore-cold-toast');
    if (modeVal === 'off') return;

    const plan = planWorkingSetRestore({
      savedSet: savedSetVal,
      sessionMap,
      openSessions,
      retryDone: restoreRetryDone,
      sessionOpenedOutsideRestore,
    });

    if (plan.action === 'nothing') return;

    if (plan.action === 'defer') {
      restorePendingRetry = true;
      if (modeVal === 'ask') showColdCacheNotice(savedSetVal.length);
      return;
    }

    restorePendingRetry = false;

    if (modeVal === 'auto') {
      await runRestore(plan.candidates);
      return;
    }

    toastCalls.push({ candidates: plan.candidates });
  }

  async function maybeRetryRestoreWorkingSet() {
    if (!restorePendingRetry || restoreRetryDone) return;
    if (sessionMap.size === 0) return;
    restoreRetryDone = true;
    restorePendingRetry = false;
    if (sessionOpenedOutsideRestore) {
      removeToast('restore-cold-toast');
      return;
    }
    await restoreWorkingSet();
  }

  return {
    sessionMap,
    openSessions,
    runRestoreLog,
    toastCalls,
    coldToastCalls,
    removedToastIds,
    restoreWorkingSet,
    maybeRetryRestoreWorkingSet,
    isRetryDone: () => restoreRetryDone,
    isRetryPending: () => restorePendingRetry,
    markUserOpenedSession() { sessionOpenedOutsideRestore = true; },
  };
}

test('wiring: cold cache defers, then the retry restores once sessionMap is populated', async () => {
  const h = makeWiringHarness({
    mode: 'auto',
    savedSet: [
      { sessionId: 'sa', projectPath: '/a', active: false },
      { sessionId: 'sb', projectPath: '/b', active: true },
    ],
  });

  await h.restoreWorkingSet();
  assert.equal(h.runRestoreLog.length, 0);
  assert.equal(h.isRetryPending(), true);

  h.sessionMap.set('sa', { sessionId: 'sa' });
  h.sessionMap.set('sb', { sessionId: 'sb' });
  await h.maybeRetryRestoreWorkingSet();

  assert.equal(h.runRestoreLog.length, 1);
  assert.deepEqual(h.runRestoreLog[0].map(i => i.sessionId).sort(), ['sa', 'sb']);
});

test('wiring: ask mode shows a distinct notice for a cold cache, not silence', async () => {
  const h = makeWiringHarness({ mode: 'ask', savedSet: [{ sessionId: 'sa', projectPath: '/a', active: true }] });

  await h.restoreWorkingSet();

  assert.equal(h.toastCalls.length, 0);
  assert.equal(h.coldToastCalls.length, 1, 'a distinct cold-cache notice, not the normal toast, and not nothing');
});

test('wiring: ask mode with a genuinely empty saved set shows nothing (contrast with the cold-cache case)', async () => {
  const h = makeWiringHarness({ mode: 'ask', savedSet: [] });

  await h.restoreWorkingSet();

  assert.equal(h.toastCalls.length, 0);
  assert.equal(h.coldToastCalls.length, 0);
});

test('wiring: the retry never consumes itself on a no-op tick (sessionMap still empty)', async () => {
  const h = makeWiringHarness({ mode: 'auto', savedSet: [{ sessionId: 'sa', projectPath: '/a', active: true }] });

  await h.restoreWorkingSet();
  await h.maybeRetryRestoreWorkingSet(); // sessionMap still empty
  assert.equal(h.isRetryDone(), false, 'a no-op tick must not burn the one retry attempt');

  h.sessionMap.set('sa', { sessionId: 'sa' });
  await h.maybeRetryRestoreWorkingSet();
  assert.equal(h.runRestoreLog.length, 1, 'the retry still succeeds once real data arrives');
});

test('wiring: the retry fires at most once', async () => {
  const h = makeWiringHarness({ mode: 'auto', savedSet: [{ sessionId: 'sa', projectPath: '/a', active: true }] });

  await h.restoreWorkingSet();
  h.sessionMap.set('sa', { sessionId: 'sa' });
  await h.maybeRetryRestoreWorkingSet();
  assert.equal(h.runRestoreLog.length, 1);

  h.openSessions.delete('sa'); // pretend it closed again
  await h.maybeRetryRestoreWorkingSet();
  assert.equal(h.runRestoreLog.length, 1, 'the retry never fires a second time');
});

test('wiring: a session opened outside the restore flow cancels the pending retry', async () => {
  const h = makeWiringHarness({ mode: 'auto', savedSet: [{ sessionId: 'sa', projectPath: '/a', active: true }] });

  await h.restoreWorkingSet();
  assert.equal(h.isRetryPending(), true);

  h.markUserOpenedSession();
  h.sessionMap.set('sa', { sessionId: 'sa' });
  await h.maybeRetryRestoreWorkingSet();

  assert.equal(h.runRestoreLog.length, 0, 'no automatic restore behind the user once they have acted');
  assert.equal(h.isRetryDone(), true, 'consumed but skipped -- never fires again');
});
