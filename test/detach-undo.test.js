'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

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
  const calls = { questions: [], stopped: [], opened: [], liveChecks: [] };
  w.appConfirm = async options => { calls.questions.push(options); return true; };
  w.api.stopSession = async id => { calls.stopped.push(id); return { ok: true, detached: true }; };
  w.api.bgAgentLiveJob = async id => { calls.liveChecks.push(id); return { known: true, job: { id: '1234abcd' } }; };
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
  await settle();
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
  await settle();
  assert.deepEqual(h.calls.opened, [], 'the exiting client must not be reopened');
  applyProcessExit('s1', 0, null, true);
  await settle();
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

test('Undo refuses a background job that ended while the attach client was exiting', async t => {
  const h = setup(t);
  await h.app.confirmAndStopSession('s1');
  h.undo().click();
  await settle();
  assert.deepEqual(h.calls.liveChecks, [], 'check liveness after the detach grace');
  h.window.api.bgAgentLiveJob = async id => {
    h.calls.liveChecks.push(id);
    return { known: true, job: null };
  };
  h.entry.closed = true;
  h.entry.completeDetach();
  await settle();
  assert.deepEqual(h.calls.opened, [], 'an ended job must not open a tab');
  assert.deepEqual(h.calls.liveChecks, ['s1']);
  assert.match(h.document.querySelector('#app-notices [role="alert"]').textContent, /background job has ended.*nothing to reattach/i);
  assert.equal(h.undo(), undefined);
});

for (const [label, check] of [
  ['live', { known: true, job: { id: '1234abcd' } }],
  ['unknown', { known: false, reason: 'unreadable job state' }],
  ['unavailable', undefined],
]) {
  test(`Undo checks a ${label} job and reopens with the captured attach options`, async t => {
    const h = setup(t);
    h.window.api.bgAgentLiveJob = async id => { h.calls.liveChecks.push(id); return check; };
    await h.app.confirmAndStopSession('s1');
    h.entry.closed = true;
    h.undo().click();
    await settle();
    assert.deepEqual(h.calls.liveChecks, ['s1']);
    assert.equal(h.calls.opened.length, 1);
    assert.deepEqual({ ...h.calls.opened[0][1] }, { type: 'attach', jobId: '1234abcd', cwd: '/project/worktree' });
  });
}

test('Undo reopens when the liveness IPC rejects', async t => {
  const h = setup(t);
  h.window.api.bgAgentLiveJob = async id => { h.calls.liveChecks.push(id); throw new Error('IPC unavailable'); };
  await h.app.confirmAndStopSession('s1');
  h.entry.closed = true;
  h.undo().click();
  await settle();
  assert.deepEqual(h.calls.liveChecks, ['s1']);
  assert.equal(h.calls.opened.length, 1);
});

test('Undo with not running reopens immediately while the entry is still open', async t => {
  const h = setup(t);
  h.window.api.stopSession = async () => ({ ok: false, error: 'not running' });
  await h.app.confirmAndStopSession('s1');
  assert.equal(h.entry.closed, false);
  h.undo().click();
  await settle();
  assert.equal(h.calls.opened.length, 1, 'not running must bypass the unresolved detachComplete');
  assert.deepEqual({ ...h.calls.opened[0][1] }, { type: 'attach', jobId: '1234abcd', cwd: '/project/worktree' });
});

for (const jobId of [null, undefined, '', 'invalid', 1234]) {
  test(`a detached tab with job id ${String(jobId)} shows a plain notice without Undo`, async t => {
    const h = setup(t);
    h.entry.attachJobId = jobId;
    await h.app.confirmAndStopSession('s1');
    assert.deepEqual(h.calls.stopped, ['s1']);
    assert.equal(h.undo(), undefined);
    const notices = h.document.querySelectorAll('#app-notices .app-notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].getAttribute('role'), 'status');
    assert.match(notices[0].textContent, /Detached from/);
    assert.deepEqual(h.calls.opened, []);
  });
}

test('Undo shows Reattaching while waiting and replaces it with the successful result', async t => {
  const h = setup(t);
  await h.app.confirmAndStopSession('s1');
  h.undo().click();
  await settle();
  assert.equal(h.undo(), undefined);
  assert.equal(h.document.querySelectorAll('#app-notices .app-notice').length, 1);
  assert.match(h.document.querySelector('#app-notices [role="status"]').textContent, /Reattaching/);
  assert.deepEqual(h.calls.opened, []);
  h.entry.closed = true;
  h.entry.completeDetach();
  await settle();
  assert.equal(h.calls.opened.length, 1);
  assert.equal(h.document.querySelectorAll('#app-notices .app-notice').length, 1);
  const notice = h.document.querySelector('#app-notices [role="status"]');
  assert.match(notice.textContent, /Reattached to/);
  assert.doesNotMatch(notice.textContent, /Reattaching/);
});

test('Undo clears progress and keeps only the Attach background failure when reopening returns false', async t => {
  const h = setup(t);
  h.window.openSession = async () => {
    h.window.showSessionActionFailure('Attach background', h.session, 'The attach backend is unavailable', 'Retry from the Agents view.');
    return false;
  };
  await h.app.confirmAndStopSession('s1');
  h.entry.closed = true;
  h.undo().click();
  await settle();
  const notices = h.document.querySelectorAll('#app-notices .app-notice');
  assert.equal(notices.length, 1, 'only the failure already reported by openSession should remain');
  assert.equal(notices[0].getAttribute('role'), 'alert');
  assert.match(notices[0].textContent, /Attach background/);
  assert.match(notices[0].textContent, /The attach backend is unavailable/);
  assert.doesNotMatch(notices[0].textContent, /Reattaching|The attach tab did not open/);
});

test('Undo bounds an unresolved detach wait and replaces progress after reopening', async t => {
  const h = setup(t);
  await h.app.confirmAndStopSession('s1');
  h.undo().click();
  await settle();
  assert.match(h.document.querySelector('#app-notices [role="status"]').textContent, /Reattaching/);
  t.mock.timers.tick(2999);
  await settle();
  assert.deepEqual(h.calls.opened, [], 'allow the two-second detach grace plus a margin');
  assert.deepEqual(h.calls.liveChecks, []);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(h.entry.closed, false, 'the exit event never arrived');
  assert.deepEqual(h.calls.liveChecks, ['s1']);
  assert.equal(h.calls.opened.length, 1, 'reopen after the bounded wait even without an exit event');
  assert.deepEqual({ ...h.calls.opened[0][1] }, { type: 'attach', jobId: '1234abcd', cwd: '/project/worktree' });
  const notices = h.document.querySelectorAll('#app-notices .app-notice');
  assert.equal(notices.length, 1);
  assert.match(notices[0].textContent, /Reattached to/);
  assert.doesNotMatch(notices[0].textContent, /Reattaching/);
});

test('Undo replaces progress with its own error when reopening throws', async t => {
  const h = setup(t);
  h.window.openSession = async () => {
    throw new Error('attach unavailable');
  };
  await h.app.confirmAndStopSession('s1');
  h.entry.closed = true;
  h.undo().click();
  await settle();
  assert.equal(h.document.querySelectorAll('#app-notices .app-notice').length, 1);
  assert.match(h.document.querySelector('#app-notices [role="alert"]').textContent, /reattach/i);
  assert.match(h.document.querySelector('#app-notices [role="alert"]').textContent, /attach unavailable/);
  assert.doesNotMatch(h.document.querySelector('#app-notices').textContent, /Reattaching/);
});
