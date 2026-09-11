// Tests for public/session-activity.js — the busy / response-ready state
// machine behind the sidebar's braille spinner.
//
// Unlike test/running-indicators.test.js, these exercise the SHIPPED file:
// session-activity.js was split out of app.js precisely so it can be evaluated
// in jsdom (app.js builds ViewerPanel/xterm objects at module scope and cannot).
//
// Its top-level `const`/`let` bindings land in the context's global lexical
// scope, which is not reachable as a property of `window` — a second
// runInContext expression in the same context is how we read them back.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

// session-activity.js was split (see .ai/contexts/session-state.md): the pure
// domain module (session-state.js) and the DOM projection
// (session-activity-dom.js) load alongside it, same order as index.html.
const STATE_SRC = path.join(__dirname, '..', 'public', 'session-state.js');
const DOM_SRC = path.join(__dirname, '..', 'public', 'session-activity-dom.js');
const SRC = path.join(__dirname, '..', 'public', 'session-activity.js');

function setup(sessionIds = ['s1', 's2']) {
  const items = sessionIds
    .map(id => `<div class="session-item" data-session-id="${id}"><div class="session-status-dot"></div></div>`)
    .join('');
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="sidebar-content">${items}</div></body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;

  // app.js declares activeSessionId; session-activity.js only reads it.
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
    setActivity: read('setActivity'),
    clearUnread: read('clearUnread'),
    rekeyActivityState: read('rekeyActivityState'),
    reconcileBusyState: read('reconcileBusyState'),
    currentActivitySeq: read('currentActivitySeq'),
    forgetActivitySeq: read('forgetActivitySeq'),
    purgeActivityFor: read('purgeActivityFor'),
    responseReadySessions: read('responseReadySessions'),
    sessionBusyState: read('sessionBusyState'),
    attentionSessions: read('attentionSessions'),
    activitySeqBySession: read('activitySeqBySession'),
    destroy: () => window.close(),
  };
}

// ---------------------------------------------------------------------------
// The bug: the response-ready lock swallowed whole turns
// ---------------------------------------------------------------------------

test('busy=true on a response-ready session updates the map, sets .cli-busy and drops the unread marker', () => {
  const t = setup();
  t.window.activeSessionId = 's2'; // s1 is NOT the focused session

  // s1 finishes a turn while the user is looking elsewhere → response-ready.
  t.setActivity('s1', true);
  t.setActivity('s1', false);
  assert.ok(t.responseReadySessions.has('s1'), 'precondition: s1 is response-ready');

  // s1 starts generating again with no click in between (cron, trigger, resume).
  t.setActivity('s1', true);

  assert.equal(t.sessionBusyState.get('s1'), true, 'sessionBusyState updated despite the response-ready lock');
  assert.ok(!t.responseReadySessions.has('s1'), 's1 removed from responseReadySessions — the unread marker is stale');
  assert.ok(t.item('s1').classList.contains('cli-busy'), '.cli-busy set');
  assert.ok(!t.item('s1').classList.contains('response-ready'), '.response-ready removed');

  t.destroy();
});

test('busy → idle (unfocused) → busy: the spinner is back on the second busy', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'spinner on first busy');

  t.setActivity('s1', false);
  assert.ok(!t.item('s1').classList.contains('cli-busy'), 'spinner off when the turn ends');
  assert.ok(t.item('s1').classList.contains('response-ready'), 'response-ready while unread');

  t.setActivity('s1', true);
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'spinner back on the second busy — this is the reported bug');

  // And a third cycle still behaves.
  t.setActivity('s1', false);
  t.setActivity('s1', true);
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'spinner back on the third busy');

  t.destroy();
});

test('busy=false on a response-ready session does NOT overwrite the unread marker', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  t.setActivity('s1', false);
  const seqAfterMarker = t.currentActivitySeq();
  assert.ok(t.responseReadySessions.has('s1'));

  // A late "waiting for your input" notification, or a duplicate OSC 0 idle.
  t.setActivity('s1', false);

  assert.ok(t.responseReadySessions.has('s1'), 'response-ready preserved');
  assert.ok(t.item('s1').classList.contains('response-ready'), '.response-ready still on the item');
  assert.equal(t.currentActivitySeq(), seqAfterMarker, 'the ignored idle signal is not counted as a transition');

  t.destroy();
});

test('a focused session going idle is not marked response-ready', () => {
  const t = setup();
  t.window.activeSessionId = 's1';

  t.setActivity('s1', true);
  t.setActivity('s1', false);

  assert.ok(!t.responseReadySessions.has('s1'), 'the user is looking at it — nothing unread');
  assert.ok(!t.item('s1').classList.contains('response-ready'));
  assert.ok(!t.item('s1').classList.contains('cli-busy'));

  t.destroy();
});

test('clearUnread re-exposes the spinner when the session is still generating', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  t.setActivity('s1', false);
  t.setActivity('s1', true); // busy again, marker already dropped
  t.responseReadySessions.add('s1'); // force the stale combination
  t.item('s1').classList.add('response-ready');

  t.clearUnread('s1');

  assert.ok(t.item('s1').classList.contains('cli-busy'), 'cli-busy restored from sessionBusyState');
  assert.ok(!t.item('s1').classList.contains('response-ready'));

  t.destroy();
});

// ---------------------------------------------------------------------------
// F3: opts.armReady — a source that can only infer silence, not completion
// ---------------------------------------------------------------------------

test('setActivity(id, false, via, { armReady: false }) clears busy without arming response-ready', () => {
  const t = setup();
  t.window.activeSessionId = 's2'; // s1 not focused — the case that normally arms response-ready

  t.setActivity('s1', true, 'remote-watch');
  t.setActivity('s1', false, 'remote-decay', { armReady: false });

  assert.equal(t.sessionBusyState.get('s1'), false, 'busy still clears');
  assert.ok(!t.responseReadySessions.has('s1'), 'armReady:false must suppress the response-ready transition');
  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  assert.ok(!t.item('s1').classList.contains('response-ready'));
  t.destroy();
});

test('a local PTY source (no opts) going idle while unfocused still arms response-ready', () => {
  // The default must stay armed — only an explicit opt-out (F3) changes it.
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true, 'onCliBusyState');
  t.setActivity('s1', false, 'onCliBusyState');

  assert.ok(t.responseReadySessions.has('s1'), 'local PTY idle must still claim an unread response');
  assert.ok(t.item('s1').classList.contains('response-ready'));
  t.destroy();
});

test('armReady:false does not block the response-ready CLEAR when the session goes busy again', () => {
  // Symmetry check: armReady only gates the idle→response-ready transition;
  // it must not interfere with the existing "busy always clears the stale
  // marker" behavior.
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  t.setActivity('s1', false); // response-ready armed via the normal path
  assert.ok(t.responseReadySessions.has('s1'));

  t.setActivity('s1', true, 'remote-watch', { armReady: false });
  assert.ok(!t.responseReadySessions.has('s1'), 'going busy always clears the stale unread marker regardless of armReady');
  t.destroy();
});

// ---------------------------------------------------------------------------
// F7: purgeActivityFor — the single writer for the PTY-gone purge
// ---------------------------------------------------------------------------

test('purgeActivityFor drops busy/unread/attention state and their classes', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  t.setActivity('s1', false); // response-ready armed
  t.attentionSessions.add('s1');
  t.item('s1').classList.add('needs-attention');
  assert.ok(t.responseReadySessions.has('s1') && t.attentionSessions.has('s1'), 'preconditions');

  t.purgeActivityFor('s1', 'pty-gone');

  assert.ok(!t.attentionSessions.has('s1'), 'attentionSessions cleared');
  assert.ok(!t.responseReadySessions.has('s1'), 'responseReadySessions cleared');
  assert.ok(!t.sessionBusyState.has('s1'), 'sessionBusyState cleared');
  assert.ok(!t.item('s1').classList.contains('needs-attention'));
  assert.ok(!t.item('s1').classList.contains('response-ready'));
  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  t.destroy();
});

test('purgeActivityFor on a busy session removes .cli-busy too', () => {
  const t = setup();
  t.setActivity('s1', true);
  assert.ok(t.item('s1').classList.contains('cli-busy'));

  t.purgeActivityFor('s1', 'pty-gone');

  assert.ok(!t.sessionBusyState.has('s1'));
  assert.ok(!t.item('s1').classList.contains('cli-busy'));
  t.destroy();
});

// ---------------------------------------------------------------------------
// Fork / session-detected re-keying
// ---------------------------------------------------------------------------

test('rekeyActivityState carries busy state and DOM class from oldId to newId', () => {
  const t = setup(['old', 'new']);
  t.window.activeSessionId = 'other';

  t.setActivity('old', true);
  assert.ok(t.item('old').classList.contains('cli-busy'), 'precondition: old is busy');

  t.rekeyActivityState('old', 'new');

  assert.equal(t.sessionBusyState.get('new'), true, 'busy state moved to newId');
  assert.ok(!t.sessionBusyState.has('old'), 'old key dropped');
  assert.ok(t.item('new').classList.contains('cli-busy'), '.cli-busy follows to the new item');
  assert.ok(!t.item('old').classList.contains('cli-busy'), '.cli-busy removed from the stale item');

  t.destroy();
});

test('rekeyActivityState carries response-ready and needs-attention too', () => {
  const t = setup(['old', 'new']);
  t.window.activeSessionId = 'other';

  t.setActivity('old', true);
  t.setActivity('old', false);
  t.attentionSessions.add('old');
  t.item('old').classList.add('needs-attention');
  assert.ok(t.responseReadySessions.has('old'));

  t.rekeyActivityState('old', 'new');

  assert.ok(t.responseReadySessions.has('new') && !t.responseReadySessions.has('old'));
  assert.ok(t.attentionSessions.has('new') && !t.attentionSessions.has('old'));
  assert.ok(t.item('new').classList.contains('response-ready'));
  assert.ok(t.item('new').classList.contains('needs-attention'));
  assert.ok(!t.item('old').classList.contains('response-ready'));
  assert.ok(!t.item('old').classList.contains('needs-attention'));

  t.destroy();
});

// ---------------------------------------------------------------------------
// Resynchronisation against the backend snapshot
// ---------------------------------------------------------------------------

test('reconcileBusyState marks a session busy with no transition event ever emitted', () => {
  const t = setup();
  assert.equal(t.sessionBusyState.size, 0, 'renderer starts blind (fresh reload)');

  t.reconcileBusyState([{ sessionId: 's1', busy: true }, { sessionId: 's2', busy: false }], t.currentActivitySeq());

  assert.equal(t.sessionBusyState.get('s1'), true, 's1 realigned from the poll snapshot');
  assert.ok(t.item('s1').classList.contains('cli-busy'), '.cli-busy set without any cli-busy-state front');
  assert.ok(!t.item('s2').classList.contains('cli-busy'), 's2 left alone');

  t.destroy();
});

test('reconcileBusyState is not swallowed by the response-ready lock', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  t.setActivity('s1', false);
  assert.ok(t.responseReadySessions.has('s1'));

  // The backend says s1 is generating again; the busy front went missing.
  t.reconcileBusyState([{ sessionId: 's1', busy: true }], t.currentActivitySeq());

  assert.equal(t.sessionBusyState.get('s1'), true);
  assert.ok(!t.responseReadySessions.has('s1'));
  assert.ok(t.item('s1').classList.contains('cli-busy'));

  t.destroy();
});

test('reconcileBusyState turns a stuck spinner off when the backend says idle', () => {
  const t = setup();
  t.window.activeSessionId = 's1'; // focused, so no response-ready marker

  t.setActivity('s1', true);
  t.reconcileBusyState([{ sessionId: 's1', busy: false }], t.currentActivitySeq());

  assert.equal(t.sessionBusyState.get('s1'), false);
  assert.ok(!t.item('s1').classList.contains('cli-busy'));

  t.destroy();
});

test('reconcileBusyState does not overwrite an event that landed while the poll was in flight', () => {
  const t = setup();
  t.window.activeSessionId = 's1';

  const seq = t.currentActivitySeq(); // snapshot taken before the IPC call
  t.setActivity('s1', true);          // fresh event arrives during the round-trip

  // Stale reply computed before the event.
  t.reconcileBusyState([{ sessionId: 's1', busy: false }], seq);

  assert.equal(t.sessionBusyState.get('s1'), true, 'the fresher live event wins');
  assert.ok(t.item('s1').classList.contains('cli-busy'));

  t.destroy();
});

test('forgetActivitySeq drops the per-session counter so a dead session leaks nothing', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  assert.ok(t.activitySeqBySession.has('s1'), 'precondition: the transition was recorded');

  t.forgetActivitySeq('s1');

  assert.ok(!t.activitySeqBySession.has('s1'), 'counter entry removed with the session');
  assert.equal(t.activitySeqBySession.size, 0, 'nothing left behind');

  t.destroy();
});

test('reconcileBusyState ignores malformed payloads', () => {
  const t = setup();
  t.reconcileBusyState(undefined);
  t.reconcileBusyState(null);
  t.reconcileBusyState([null, {}, { sessionId: 42 }, 'nope']);
  assert.equal(t.sessionBusyState.size, 0);
  t.destroy();
});

// ---------------------------------------------------------------------------
// Visual arbitration between busy and response-ready
// ---------------------------------------------------------------------------

test('busy wins over response-ready: the two classes are mutually exclusive by construction', () => {
  // Decision: a session that resumed generating is busy, not "answer waiting".
  // applyActivityClasses is the only writer of both classes and never sets
  // them together, so the CSS cascade is never asked to arbitrate.
  const t = setup();
  t.window.activeSessionId = 's2';

  for (const step of [true, false, true, false, true]) {
    t.setActivity('s1', step);
    const cls = t.item('s1').classList;
    assert.ok(!(cls.contains('cli-busy') && cls.contains('response-ready')),
      'cli-busy and response-ready are never both set');
  }

  t.destroy();
});

test('style.css: the busy icon-slot rung always wins over .session-icon.running', () => {
  // Issue #246 step 3b (coordinator follow-up, 2026-09-11): renderSessionIcon()
  // now resolves rung exclusivity in JS (the mutual exclusion tested above),
  // so the slot's CSS no longer arbitrates between row classes — it keys on
  // session-icon--busy alone. jsdom does not resolve ::before content, so
  // this pins the cascade at the source level: background is !important
  // because a busy row is very often also .session-icon.running (green).
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const busyRule = css.match(/\.session-icon--busy \{[\s\S]*?\}/);
  assert.ok(busyRule, 'the cli-busy icon-slot rule must still exist');
  assert.match(busyRule[0], /background:\s*transparent\s*!important/,
    'the cli-busy slot must clear its background with !important so .session-icon.running cannot repaint over the spinner');
  assert.match(css, /\.session-icon--busy::before/,
    'the braille spinner ::before must still be keyed on the busy rung');
});

// ---------------------------------------------------------------------------
// Source-level pins for the wiring that lives outside session-activity.js
// ---------------------------------------------------------------------------

test('main.js: get-active-sessions reports the busy flag alongside the session id', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('get-active-sessions'");
  assert.notEqual(start, -1, 'the get-active-sessions handler must still exist');
  const body = src.slice(start, start + 400);
  assert.match(body, /\{\s*sessionId,\s*busy:\s*!!session\._cliBusy\s*\}/,
    'the handler must carry _cliBusy so the renderer can realign without a transition event');
});

test('public/app.js: the poll reconciles busy state and re-keys it on fork/detect', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const poll = src.slice(src.indexOf('async function pollActiveSessions'), src.indexOf('async function pollActiveSessions') + 500);
  assert.match(poll, /currentActivitySeq\(\)/, 'the poll must snapshot the activity sequence before the IPC call');
  assert.match(poll, /reconcileBusyState\(entries,\s*seq\)/, 'the poll must reconcile the busy state');
  assert.match(poll, /entries\.map\(e => e\.sessionId\)/, 'activePtyIds must be rebuilt from the new payload shape');

  const forked = src.slice(src.indexOf('window.api.onSessionForked'), src.indexOf('window.api.onProcessExited'));
  assert.match(forked, /rekeyActivityState\(oldId, newId\)/, 'a fork must carry the activity state to the new id');

  const detected = src.slice(src.indexOf('window.api.onSessionDetected'), src.indexOf('window.api.onSessionForked'));
  assert.match(detected, /rekeyActivityState\(tempId, realId\)/, 'session detection must carry the activity state to the real id');
});

test('public/app.js: the pty-stop cleanup routes through purgeActivityFor and skips remote rows (F7)', () => {
  // purgeActivityFor (session-activity.js) is the single writer for
  // sessionBusyState/responseReadySessions/attentionSessions/activitySeqBySession
  // outside setActivity/rekeyActivityState — app.js must not touch those maps
  // directly, and must not purge a row whose busy state is owned by the
  // remote watch channel instead of local PTY presence.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const scanStart = src.indexOf("document.querySelectorAll('.session-item').forEach(item => {");
  assert.notEqual(scanStart, -1, 'the .session-item pty-set scan must still exist');
  const body = src.slice(scanStart, scanStart + 1200);

  assert.match(body, /if\s*\(!running\s*&&\s*!item\.dataset\.remoteAlias\)\s*\{/,
    'the purge branch must skip rows carrying dataset.remoteAlias');
  assert.match(body, /purgeActivityFor\(id,\s*'pty-gone'\)/,
    'the purge must go through the shared dispatcher');
  assert.ok(!/sessionBusyState\.delete\(id\)/.test(body),
    'app.js must not delete from sessionBusyState directly anymore');
  assert.ok(!/responseReadySessions\.delete\(id\)/.test(body),
    'app.js must not delete from responseReadySessions directly anymore');
  assert.ok(!/attentionSessions\.delete\(id\)/.test(body),
    'app.js must not delete from attentionSessions directly anymore');
});
