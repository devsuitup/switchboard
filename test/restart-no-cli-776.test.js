// The automatic restart of a restored session without a CLI (#776, PR #1319 review).
//
// The shipped restartSessionWithoutCli, armCliLiveness and applyProcessExit run
// in the sidebar jsdom window, next to the real session-state projection and
// the real public/cli-liveness.js. window.api and openSession, the reopen
// path, are the outside edges.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const LIVENESS = path.join(__dirname, '..', 'public', 'cli-liveness.js');
const { CLI_LIVENESS_NO_CLI_MS: NO_CLI, CLI_LIVENESS_RESTART_TIMEOUT_MS: RESTART } = require('../public/cli-liveness');

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function setup(t, { headTurn = 'closed', spent = false } = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const w = ctx.window;
  const calls = [];
  const control = { restartReply: { ok: true }, exitOnRestart: true, beforeExit: null, pendingRestart: null };
  vm.runInContext(fs.readFileSync(LIVENESS, 'utf8'), ctx.context, { filename: LIVENESS });
  const timers = [];
  let clock = 0;
  w.cliLiveness = vm.runInContext('createCliLiveness', ctx.context)({
    setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer; },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i !== -1) timers.splice(i, 1); },
    isOnline: () => true,
    restart: id => w.restartSessionWithoutCli(id),
  });
  w.api.stopSession = async id => { calls.push(['stopSession', id]); setTimeout(() => w.applyProcessExit(id, null, null, true), 0); return { ok: true }; };
  w.api.getSessionLiveElsewhere = async id => { calls.push(['live', id]); return null; };
  w.api.noCliRestartSpent = async id => { calls.push(['spent?', id]); return { ok: true, spent }; };
  w.api.restartNoCliSession = async id => {
    calls.push(['restartNoCli', id]);
    if (control.pendingRestart) await control.pendingRestart;
    const reply = control.restartReply;
    if (reply.ok && control.exitOnRestart) {
      setTimeout(() => { control.beforeExit?.(); w.applyProcessExit(control.exitId || id, null, null, true); }, 0);
    }
    return reply;
  };
  w.openSession = async (session, options, flags) => { calls.push(['openSession', JSON.parse(JSON.stringify(session)), options, { ...flags }]); };
  Object.assign(w, {
    gridViewActive: false, gridViewerCount: null, skippedWorkingSetEntries: new Map(), filePanelState: new Map(),
    updateRunningIndicators() {}, schedulePersistWorkingSet() {}, setSessionMcpState(id, state) { w.cliLiveness.mcpState(id, state); },
  });
  vm.runInContext(['CLI_RESTART_EXIT_WAIT_MS'].map(name => (APP_SRC.match(new RegExp(`^const ${name} = .*;$`, 'm')) || [''])[0])
    .join('\n').replace(/^const /gm, 'var '), ctx.context);
  loadAppFunctions(ctx.context, { functions: ['applyProcessExit', 'restartSessionWithoutCli',
    ...['armCliLiveness', 'noCliRestartIdentity'].filter(name => new RegExp(`^(async )?function ${name}\\(`, 'm').test(APP_SRC))] });
  const session = { sessionId: 'a', projectPath: '/pa', name: 'restored' };
  w.sessionMap.set('a', session);
  w.openSessions.set('a', { session: { ...session }, closed: false, terminal: { write() {} } });
  w.activePtyIds.add('a');
  if (headTurn) ctx.emitHeadTurn('a', headTurn);
  const arm = async () => {
    if (typeof w.armCliLiveness === 'function') await w.armCliLiveness('a');
    else w.cliLiveness.expect('a');
    w.cliLiveness.mcpState('a', 'listening');
  };
  const advance = async ms => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter(timer => timer.at <= until).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock = due.at;
      due.fn();
      await flush();
    }
    clock = until;
    await flush();
  };
  const kinds = kind => calls.filter(call => call[0] === kind);
  return { ctx, w, calls, control, arm, advance, kinds };
}

test('#1 GIVEN the head turn is open while the local-pty adapter says busy:false WHEN the restart is due THEN nothing is stopped', async t => {
  const h = setup(t, { headTurn: 'open' });
  assert.equal(h.ctx.read('localPtyStates.get("a")?.snapshot().busy'), false);
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  assert.deepEqual(h.kinds('stopSession'), []);
  assert.deepEqual(h.kinds('restartNoCli'), []);
});

test('#1 GIVEN the head turn is unknown WHEN the restart is due THEN nothing is stopped', async t => {
  const h = setup(t, { headTurn: 'unknown' });
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  assert.deepEqual(h.kinds('stopSession'), []);
  assert.deepEqual(h.kinds('restartNoCli'), []);
});

test('#2 GIVEN a quiet session WHEN the restart is due THEN the renderer never stops it itself: one main call checks and stops', async t => {
  const h = setup(t);
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  assert.deepEqual(h.kinds('stopSession'), []);
  assert.deepEqual(h.kinds('restartNoCli'), [['restartNoCli', 'a']]);
  assert.equal(h.kinds('openSession').length, 1);
});

test('#2 GIVEN the restart call is in flight WHEN the CLI connects THEN the restart is cancelled and the row clears', async t => {
  const h = setup(t);
  let release;
  h.control.pendingRestart = new Promise(resolve => { release = resolve; });
  h.control.restartReply = { ok: false, reason: 'connected' };
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  assert.equal(h.kinds('restartNoCli').length, 1);
  h.w.cliLiveness.mcpState('a', 'connected');
  assert.equal(h.w.cliLiveness.isNoCli('a'), false);
  release();
  await flush();
  assert.deepEqual(h.kinds('openSession'), []);
  assert.equal(h.w.cliLiveness.isNoCli('a'), false);
});

test('#3 GIVEN the session was stopped WHEN it is reopened THEN the reopen runs its own live-elsewhere guard', async t => {
  const h = setup(t);
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  const [, , , flags] = h.kinds('openSession')[0];
  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'live'), false);
  assert.equal(flags.automatic, true);
});

test('#4 GIVEN the entry is re-keyed while it shuts down WHEN its exit arrives THEN the old id is not reopened', async t => {
  const h = setup(t);
  h.control.beforeExit = () => {
    const entry = h.w.openSessions.get('a');
    h.w.openSessions.delete('a');
    entry.session = { ...entry.session, sessionId: 'b' };
    h.w.openSessions.set('b', entry);
    h.w.activePtyIds.delete('a');
  };
  h.control.exitId = 'b';
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  assert.deepEqual(h.kinds('openSession'), []);
});

test('#4 GIVEN the row gains a merged member while it shuts down WHEN its exit arrives THEN nothing is reopened', async t => {
  const h = setup(t);
  h.control.beforeExit = () => { h.w.openSessions.get('a').session.mergedMemberIds = ['c']; };
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  assert.deepEqual(h.kinds('openSession'), []);
});

test('#4 GIVEN an unchanged identity WHEN the session is reopened THEN continuation fields are left to openSession', async t => {
  const h = setup(t);
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  const [, session, , flags] = h.kinds('openSession')[0];
  assert.deepEqual(session, { sessionId: 'a', projectPath: '/pa', name: 'restored' });
  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'continuationResolved'), false);
});

test('#5 GIVEN main says this session already used its restart WHEN it is armed again THEN it never restarts and says to stop it', async t => {
  const h = setup(t, { spent: true });
  await h.arm();
  assert.deepEqual(h.kinds('spent?'), [['spent?', 'a']]);
  await h.advance(NO_CLI);
  assert.equal(h.w.cliLiveness.isNoCli('a'), true);
  assert.equal(h.w.cliLiveness.status('a').restartPending, false);
  await h.advance(RESTART * 2);
  assert.deepEqual(h.kinds('restartNoCli'), []);
});

test('#5 GIVEN main cannot say whether the restart was used WHEN it is armed THEN it is treated as used', async t => {
  const h = setup(t);
  h.w.api.noCliRestartSpent = async () => { throw new Error('ipc down'); };
  await h.arm();
  await h.advance(NO_CLI + RESTART);
  assert.deepEqual(h.kinds('restartNoCli'), []);
  assert.deepEqual(h.kinds('stopSession'), []);
});

test('GIVEN a healthy CLI slower than the delay WHEN it connects after the no-CLI mark THEN the mark clears and nothing restarts', async t => {
  const h = setup(t);
  await h.arm();
  await h.advance(NO_CLI + 15000);
  assert.equal(h.w.cliLiveness.isNoCli('a'), true);
  h.w.cliLiveness.mcpState('a', 'connected');
  assert.equal(h.w.cliLiveness.isNoCli('a'), false);
  await h.advance(RESTART * 2);
  assert.deepEqual(h.kinds('restartNoCli'), []);
  assert.deepEqual(h.kinds('stopSession'), []);
  assert.deepEqual(h.kinds('openSession'), []);
});
