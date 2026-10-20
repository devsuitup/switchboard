'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const { window: w } = h;
  w.setTimeout = setTimeout;
  w.clearTimeout = clearTimeout;
  w.Date = Date;
  const session = { sessionId: 's1', projectPath: '/project', name: 'Background work' };
  const entry = { session, attach: true, attachJobId: '1234abcd', attachCwd: '/project/worktree', closed: false };
  w.openSessions.set('s1', entry);
  w.activePtyIds.add('s1');
  w.gridViewActive = true;
  w.refreshSidebar = () => {};
  const calls = { questions: [], stopped: [], opened: [] };
  w.appConfirm = async options => { calls.questions.push(options); return true; };
  w.api.stopSession = async id => { calls.stopped.push(id); return { ok: true, detached: true }; };
  w.openSession = async (...args) => { calls.opened.push(args); };
  const app = loadAppFunctions(h.context, { functions: ['confirmAndStopSession'] });
  const undo = () => [...h.document.querySelectorAll('#app-notices .app-notice-action')].find(button => button.textContent === 'Undo');
  return { ...h, app, session, entry, calls, undo };
}

test('P4 an attach tab detaches once without asking and offers Undo', async t => {
  const h = setup(t);
  await h.app.confirmAndStopSession('s1');
  assert.equal(h.calls.questions.length, 0, 'Detach does not ask');
  assert.deepEqual(h.calls.stopped, ['s1']);
  assert.equal(h.window.activePtyIds.has('s1'), false);
  assert.ok(h.undo(), 'Detach offers Undo');
  assert.match(h.undo().parentElement.textContent, /keeps running/);
});

test('Undo reattaches with the job id and cwd captured before detach even after the entry disappears', async t => {
  const h = setup(t);
  h.window.api.stopSession = async id => {
    h.calls.stopped.push(id);
    h.entry.closed = true;
    h.entry.attachJobId = 'changed';
    h.entry.attachCwd = '/changed';
    h.window.openSessions.delete(id);
    return { ok: true, detached: true };
  };
  await h.app.confirmAndStopSession('s1');
  assert.ok(h.undo(), 'Detach offers Undo');
  h.undo().click();
  await Promise.resolve();
  assert.equal(h.calls.opened.length, 1);
  assert.equal(h.calls.opened[0][0].sessionId, 's1');
  assert.deepEqual({ ...h.calls.opened[0][1] }, { type: 'attach', jobId: '1234abcd', cwd: '/project/worktree' });
  assert.equal(h.undo(), undefined);
});

test('the detach Undo notice expires at 10001 ms', async t => {
  const h = setup(t);
  await h.app.confirmAndStopSession('s1');
  assert.ok(h.undo(), 'Detach offers Undo');
  t.mock.timers.tick(9999);
  assert.ok(h.undo());
  t.mock.timers.tick(2);
  assert.equal(h.undo(), undefined);
  assert.deepEqual(h.calls.opened, []);
});

test('Undo clicked while the attach client is exiting waits for its process exit before reopening', async t => {
  const h = setup(t);
  Object.assign(h.window, {
    gridViewActive: false, activeSessionId: null,
    skippedWorkingSetEntries: new Map(),
    noteSessionExit() {}, lastSessionExit: () => ({}),
    updateRunningIndicators() {}, schedulePersistWorkingSet() {},
  });
  const { applyProcessExit } = loadAppFunctions(h.context, { functions: ['applyProcessExit'] });
  await h.app.confirmAndStopSession('s1');
  assert.ok(h.undo(), 'Detach offers Undo');
  h.undo().click();
  await Promise.resolve();
  assert.deepEqual(h.calls.opened, [], 'the exiting client must not be reopened');
  applyProcessExit('s1', 0, null, true);
  await Promise.resolve();
  assert.equal(h.calls.opened.length, 1);
  assert.equal(h.entry.closed, true);
});

test('a detach failure offers Retry without Undo, then a successful retry offers Undo without asking', async t => {
  const h = setup(t);
  h.window.api.stopSession = async () => ({ ok: false, error: 'client unavailable' });
  await h.app.confirmAndStopSession('s1');
  assert.equal(h.undo(), undefined);
  assert.ok(h.window.activePtyIds.has('s1'));
  const retry = h.document.querySelector('#app-notices [role="alert"] .app-notice-action');
  assert.equal(retry.textContent, 'Retry');
  h.window.api.stopSession = async () => ({ ok: true, detached: true });
  retry.click();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.ok(h.undo(), 'the successful retry offers Undo');
  assert.equal(h.calls.questions.length, 0);
  assert.equal(h.document.querySelector('#app-notices [role="alert"]'), null);
});
