// Tests for app.js's confirmAndStopSession — a failed stop must not touch
// local state (activePtyIds, the open terminal view) and must surface the
// failure on the clicked button instead of alert(). See
// .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop").
//
// confirmAndStopSession is extracted from the real public/app.js
// (test/app-source.js) and runs in the jsdom window of dom-setup.js, next to
// the real resolveSessionStop of stop-session-ui.js. Only its outside edges
// (confirm, the IPC bridge, timers, the terminal view) are stubbed.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function withHarness(overrides, fn) {
  const ctx = setupSidebarDom();
  try {
    const { window, document } = ctx;
    const calls = { closed: [], active: [], refreshed: 0, logged: [], remoteStopped: [], flashed: [], ipc: [] };
    window.sessionMap = new Map([['s1', { sessionId: 's1', remoteAlias: 'vps' }]]);
    window.activePtyIds = new Set(['s1']);
    window.activeSessionId = 's1';
    window.gridViewActive = false;
    window.terminalHeader = document.createElement('div');
    window.placeholder = document.createElement('div');
    window.setActiveSession = (id) => { calls.active.push(id); window.activeSessionId = id; };
    window.refreshSidebar = () => { calls.refreshed++; };
    window.applyRemoteStopped = (id) => calls.remoteStopped.push(id);
    window.flashButtonText = (b, text, ms) => calls.flashed.push({ b, text, ms });
    window.confirm = () => true;
    window.setTimeout = (cb) => cb();
    window.console = { error: (...args) => calls.logged.push(args) };
    window.api = {
      stopSession: async (id) => { calls.ipc.push(['stop', id]); return { ok: true }; },
      remoteStopSession: async (alias, id) => { calls.ipc.push(['remote-stop', alias, id]); return { ok: true }; },
    };
    Object.assign(window, overrides(calls, window));
    const { confirmAndStopSession } = loadAppFunctions(ctx.context, { functions: ['confirmAndStopSession'] });
    return fn({ confirmAndStopSession, window, calls });
  } finally {
    ctx.destroy();
  }
}

const none = () => ({});

test('a successful remote stop deletes the pty id and closes the active view', async () => {
  await withHarness(none, async ({ confirmAndStopSession, window, calls }) => {
    await confirmAndStopSession('s1', null);

    assert.ok(!window.activePtyIds.has('s1'), 'activePtyIds must be cleared on success');
    assert.deepEqual(calls.active, [null], 'the active session must be released on success');
    assert.equal(window.terminalHeader.style.display, 'none', 'the terminal header must be hidden on success');
    assert.deepEqual(calls.remoteStopped, ['s1'], 'a remote stop must update the remote adapter state');
    assert.deepEqual(calls.ipc, [['remote-stop', 'vps', 's1']]);
  });
});

test('a failed remote stop must not delete the pty id (mutation target: unconditional delete)', async () => {
  const failing = () => ({
    api: {
      stopSession: async () => ({ ok: true }),
      remoteStopSession: async () => ({ ok: false, error: 'pid now belongs to a non-claude process' }),
    },
  });
  await withHarness(failing, async ({ confirmAndStopSession, window, calls }) => {
    await confirmAndStopSession('s1', null);

    assert.ok(window.activePtyIds.has('s1'), 'a failed stop must leave activePtyIds untouched');
    assert.deepEqual(calls.active, [], 'a failed stop must not release the active session');
    assert.equal(window.terminalHeader.style.display, '', 'a failed stop must not hide the terminal header');
    assert.equal(calls.refreshed, 0);
  });
});

test('a failed stop flashes the clicked button and sets its title to the error, restoring it after', async () => {
  const titles = [];
  const failing = () => ({
    api: { remoteStopSession: async () => ({ ok: false, error: 'ssh: connection refused' }) },
  });
  await withHarness(failing, async ({ confirmAndStopSession, window, calls }) => {
    const btn = { title: 'Stop session' };
    window.setTimeout = (cb) => { titles.push(btn.title); cb(); };

    await confirmAndStopSession('s1', btn);

    assert.equal(calls.flashed.length, 1, 'flashButtonText must be called on failure');
    assert.equal(calls.flashed[0].text, 'Failed');
    assert.deepEqual(titles, ['ssh: connection refused'], 'the error text is the button title until the timer fires');
    assert.equal(btn.title, 'Stop session', 'the original title is restored after the flash window');
  });
});

test('a failed stop with no button element does not throw (terminal header stop passes a real btn, but be defensive)', async () => {
  const failing = () => ({ api: { remoteStopSession: async () => ({ ok: false, error: 'boom' }) } });
  await withHarness(failing, async ({ confirmAndStopSession }) => {
    await assert.doesNotReject(confirmAndStopSession('s1', null));
  });
});

test('a local session is stopped through stopSession, not the remote channel', async () => {
  const local = () => ({ sessionMap: new Map([['s1', { sessionId: 's1' }]]) });
  await withHarness(local, async ({ confirmAndStopSession, calls }) => {
    await confirmAndStopSession('s1', null);

    assert.deepEqual(calls.ipc, [['stop', 's1']]);
    assert.deepEqual(calls.remoteStopped, []);
  });
});

test('declining the confirm() dialog calls neither IPC', async () => {
  const declining = () => ({ confirm: () => false });
  await withHarness(declining, async ({ confirmAndStopSession, window, calls }) => {
    await confirmAndStopSession('s1', null);

    assert.deepEqual(calls.ipc, []);
    assert.ok(window.activePtyIds.has('s1'));
  });
});
