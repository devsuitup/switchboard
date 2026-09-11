// Tests for app.js's confirmAndStopSession — a failed stop must not touch
// local state (activePtyIds, the open terminal view) and must surface the
// failure on the clicked button instead of alert(). See
// .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop").
//
// app.js cannot be eval-ed in jsdom (module-scope `new ViewerPanel(...)` etc.
// — see test/running-indicators.test.js's file header for the full reason).
// `makeConfirmAndStopSession` below is therefore a HAND-MAINTAINED MIRROR of
// the real function, not the shipped code — it pins the *decision* logic in
// isolation. The source-level pin test at the bottom catches the one
// regression that matters most (the guard silently dropped from the shipped
// file) without needing a full eval — same two-layer technique already used
// in test/running-indicators.test.js.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Mirrors public/app.js's confirmAndStopSession(sessionId, btn), with every
// external dependency injected instead of read off globals.
function makeConfirmAndStopSession(deps) {
  return async function confirmAndStopSession(sessionId, btn) {
    const plan = deps.resolveSessionStop(deps.sessionMap.get(sessionId));
    if (!deps.confirm(plan.confirmText)) return;
    const result = plan.remote
      ? await deps.api.remoteStopSession(plan.alias, sessionId)
      : await deps.api.stopSession(sessionId);
    if (result && result.ok === false) {
      const message = result.error || 'unknown error';
      deps.logError('[stop-session]', message);
      if (btn) {
        if (typeof deps.flashButtonText === 'function') deps.flashButtonText(btn, 'Failed', 1500);
        const originalTitle = btn.title;
        btn.title = message;
        deps.setTimeout(() => { btn.title = originalTitle; }, 3000);
      }
      return;
    }
    if (plan.remote && typeof deps.applyRemoteStopped === 'function') {
      deps.applyRemoteStopped(sessionId);
    }
    deps.activePtyIds.delete(sessionId);
    if (!deps.gridViewActive && deps.activeSessionId === sessionId) {
      deps.setActiveSession(null);
      deps.closeTerminalView();
    }
  };
}

function makeDeps(overrides = {}) {
  const activePtyIds = new Set(['s1']);
  return {
    resolveSessionStop: (session) => (session && session.remoteAlias
      ? { remote: true, alias: session.remoteAlias, confirmText: `Stop this session on ${session.remoteAlias}?` }
      : { remote: false, alias: null, confirmText: 'Stop this session?' }),
    sessionMap: new Map([['s1', { sessionId: 's1', remoteAlias: 'vps' }]]),
    confirm: () => true,
    api: { stopSession: async () => ({ ok: true }), remoteStopSession: async () => ({ ok: true }) },
    logError: () => {},
    flashButtonText: () => {},
    applyRemoteStopped: () => {},
    activePtyIds,
    gridViewActive: false,
    activeSessionId: 's1',
    setActiveSession: () => {},
    closeTerminalView: () => {},
    setTimeout: (fn) => fn(), // fire immediately — tests don't care about the 3s delay itself
    ...overrides,
  };
}

test('a successful remote stop deletes the pty id and closes the active view', async () => {
  const closed = [];
  const deps = makeDeps({
    closeTerminalView: () => closed.push('closed'),
  });
  const confirmAndStopSession = makeConfirmAndStopSession(deps);

  await confirmAndStopSession('s1', null);

  assert.ok(!deps.activePtyIds.has('s1'), 'activePtyIds must be cleared on success');
  assert.equal(closed.length, 1, 'the active terminal view must be closed on success');
});

test('a failed remote stop must not delete the pty id (mutation target: unconditional delete)', async () => {
  const closed = [];
  const deps = makeDeps({
    api: { stopSession: async () => ({ ok: true }), remoteStopSession: async () => ({ ok: false, error: 'pid now belongs to a non-claude process' }) },
    closeTerminalView: () => closed.push('closed'),
  });
  const confirmAndStopSession = makeConfirmAndStopSession(deps);

  await confirmAndStopSession('s1', null);

  assert.ok(deps.activePtyIds.has('s1'), 'a failed stop must leave activePtyIds untouched');
  assert.equal(closed.length, 0, 'a failed stop must not close the terminal view');
});

test('a failed stop flashes the clicked button and sets its title to the error, restoring it after', async () => {
  const flashCalls = [];
  let restoredTitle = null;
  const btn = { title: 'Stop session' };
  const deps = makeDeps({
    api: { remoteStopSession: async () => ({ ok: false, error: 'ssh: connection refused' }) },
    flashButtonText: (b, text, ms) => flashCalls.push({ b, text, ms }),
    setTimeout: (fn) => { fn(); restoredTitle = btn.title; }, // simulate the restore firing later, capture it before we assert
  });
  const confirmAndStopSession = makeConfirmAndStopSession(deps);

  await confirmAndStopSession('s1', btn);

  assert.equal(flashCalls.length, 1, 'flashButtonText must be called on failure');
  assert.equal(flashCalls[0].text, 'Failed');
  // btn.title was set to the error message synchronously before the restore timer fires.
  assert.equal(restoredTitle, 'Stop session', 'the original title is restored after the flash window');
});

test('a failed stop with no button element does not throw (terminal header stop passes a real btn, but be defensive)', async () => {
  const deps = makeDeps({ api: { remoteStopSession: async () => ({ ok: false, error: 'boom' }) } });
  const confirmAndStopSession = makeConfirmAndStopSession(deps);
  await assert.doesNotReject(confirmAndStopSession('s1', null));
});

test('declining the confirm() dialog calls neither IPC', async () => {
  const calls = [];
  const deps = makeDeps({
    confirm: () => false,
    api: {
      stopSession: async () => { calls.push('stop'); return { ok: true }; },
      remoteStopSession: async () => { calls.push('remote-stop'); return { ok: true }; },
    },
  });
  const confirmAndStopSession = makeConfirmAndStopSession(deps);
  await confirmAndStopSession('s1', null);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Source-level pin for the REAL public/app.js.
// ---------------------------------------------------------------------------

test('public/app.js: confirmAndStopSession still exists with the (sessionId, btn) signature', () => {
  assert.match(APP_SRC, /async function confirmAndStopSession\(sessionId,\s*btn\)/,
    'confirmAndStopSession must accept the clicked button as its second argument');
});

test('public/app.js: a failed stop returns before touching activePtyIds or closing the view (mutation target: unconditional delete)', () => {
  const start = APP_SRC.indexOf('async function confirmAndStopSession(sessionId, btn)');
  assert.notEqual(start, -1);
  const body = APP_SRC.slice(start, start + 1200);

  const failIdx = body.indexOf("result.ok === false");
  assert.notEqual(failIdx, -1, 'the ok === false branch must still exist');
  const returnIdx = body.indexOf('return;', failIdx);
  const deleteIdx = body.indexOf('activePtyIds.delete(sessionId)');
  assert.notEqual(returnIdx, -1, 'the failure branch must return before falling through to the success path');
  assert.ok(returnIdx < deleteIdx,
    'the failure branch\'s return must precede activePtyIds.delete — a failed stop must not clear it');
});

test('public/app.js: a failed stop flashes the button and sets its title to the error text', () => {
  const start = APP_SRC.indexOf('async function confirmAndStopSession(sessionId, btn)');
  const body = APP_SRC.slice(start, start + 1200);
  assert.match(body, /window\.flashButtonText\(btn,\s*'Failed',\s*1500\)/,
    'a failed stop must flash the button, same pattern as session-delete-btn');
  assert.match(body, /btn\.title\s*=\s*message/, 'the error text must be surfaced via the button title');
  assert.doesNotMatch(body, /\balert\(/, 'no alert() for a failed stop');
});
