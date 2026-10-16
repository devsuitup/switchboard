'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, answerChoiceDialog } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const { deleteSessionRefusal } = require('../delete-session-guard');

function setup(t, extra = {}) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const session = { sessionId: 's1', name: 'Work', projectPath: '/project', modified: new Date().toISOString(), archived: 0, ...extra };
  const project = { projectPath: '/project', folder: '-project', sessions: [session] };
  h.window.cachedAllProjects = [project];
  h.window.gridViewActive = false;
  const render = () => {
    for (const s of project.sessions) h.window.sessionMap.set(s.sessionId, s);
    h.sidebar.renderProjects([project], true);
  };
  h.window.refreshSidebar = render;
  render();
  const focus = h.document.createElement('input');
  h.document.body.append(focus);
  focus.focus();
  const timers = [];
  h.window.setTimeout = (_fn, ms) => { timers.push(ms); return timers.length; };
  const click = selector => h.document.querySelector(selector).onclick(new h.window.MouseEvent('click'));
  const notice = (reason, operation, expectedFocus = focus) => {
    const el = [...h.document.querySelectorAll('#app-notices [role="alert"]')].find(n => n.textContent.includes(reason));
    assert.ok(el, `persistent ${operation} notice: ${reason}`);
    assert.match(el.textContent, new RegExp(operation, 'i'));
    assert.match(el.textContent, /Work|s1|\/project/);
    assert.match(el.textContent, /\/project/);
    assert.ok(el.querySelector('.app-notice-dismiss'));
    assert.match(el.textContent, /retry|try again|own terminal|Settings|sidebar/i);
    assert.equal(h.document.activeElement, expectedFocus);
    el.dispatchEvent(new h.window.MouseEvent('mouseleave'));
    render();
    assert.ok(el.isConnected, 'survives sidebar rebuild and pointer leave');
    assert.deepEqual(timers.filter(ms => ms > 0), [], 'failure schedules no expiry, including beyond 20 s (modal focus may schedule 0 ms)');
    return el;
  };
  return { ...h, session, project, render, click, notice, focus, timers };
}

for (const failure of ['rejected', 'refused', 'unavailable']) {
  test(`Stop ${failure} preserves terminal state and persistent recovery`, async t => {
    const h = setup(t, { remoteAlias: 'vps' });
    h.window.appConfirm = async () => true;
    h.window.activePtyIds.add('s1');
    h.window.activeSessionId = 's1';
    h.window.terminalHeader = h.document.createElement('div');
    h.window.api.remoteStopSession = failure === 'unavailable' ? undefined : async () => {
      if (failure === 'rejected') throw new Error('host unreachable');
      return { ok: false, error: 'host unreachable' };
    };
    const { confirmAndStopSession } = loadAppFunctions(h.context, { functions: ['confirmAndStopSession'], installSpies: false });
    await confirmAndStopSession('s1', h.document.querySelector('.session-stop-btn'), h.session);
    h.notice(failure === 'unavailable' ? 'unavailable' : 'host unreachable', 'Stop');
    assert.ok(h.window.activePtyIds.has('s1'));
    assert.equal(h.window.activeSessionId, 's1');
  });
}

for (const [reason, extra] of [['missing transcript', {}], ['REMOTE_READ_ONLY', { remoteAlias: 'vps' }], ['backend disconnected', {}]]) {
  test(`Delete ${reason} retains the row and explains recovery`, async t => {
    const h = setup(t, extra);
    h.window.showDeleteSessionDialog = async () => true;
    h.window.api.deleteSession = async () => {
      if (reason === 'backend disconnected') throw new Error(reason);
      return { ok: false, error: reason };
    };
    await h.click('.session-delete-btn');
    const notice = h.notice(reason, 'Delete');
    if (reason === 'REMOTE_READ_ONLY') {
      assert.match(notice.textContent, /Use Archive/);
      assert.doesNotMatch(notice.textContent, /retry Delete|end it there/i);
    }
    assert.ok(h.window.sessionMap.has('s1'));
    assert.equal(h.session.archived, 0);
    assert.ok(h.document.querySelector('[data-session-id="s1"]'));
  });
}

test('a live merged member refuses Delete without promising unsupported Stop or Close', async t => {
  const h = setup(t, { mergedMemberIds: ['external'] });
  h.window.activePtyIds.add('external');
  let deleted = false;
  h.window.api.deleteSession = async () => { deleted = true; };
  await h.click('.session-delete-btn');
  const el = h.notice('running', 'Delete');
  assert.match(el.textContent, /own terminal/);
  assert.doesNotMatch(el.textContent, /close it first|stop it first/i);
  assert.equal(deleted, false);
});

test('external-process backend refusal describes its own terminal and location', async t => {
  const reason = await deleteSessionRefusal('s1', {
    activeSessions: new Map(), liveJobCheck: () => ({ known: true }),
    liveElsewhereChecked: async () => ({ known: true, live: { pid: 4242 } }), describeLiveProcess: true,
  });
  assert.match(reason, /own terminal/);
  assert.doesNotMatch(reason, /stop it first|close it first/i);
  const h = setup(t);
  h.window.showDeleteSessionDialog = async () => true;
  h.window.api.deleteSession = async () => ({ ok: false, error: reason });
  await h.click('.session-delete-btn');
  h.notice('4242', 'Delete');
});

for (const failure of ['rejected', 'refused', 'unavailable']) {
  test(`Archive ${failure} does not mutate archive state`, async t => {
    const h = setup(t);
    h.window.api.archiveSession = failure === 'unavailable' ? undefined : async () => {
      if (failure === 'rejected') throw new Error('database locked');
      return { ok: false, error: 'database locked' };
    };
    await h.click('.session-archive-btn');
    h.notice(failure === 'unavailable' ? 'unavailable' : 'database locked', 'Archive');
    assert.equal(h.session.archived, 0);
  });
}

test('successful Archive retry clears only its own notice and Dismiss preserves focus', async t => {
  const h = setup(t);
  h.window.showDeleteSessionDialog = async () => true;
  h.window.api.deleteSession = async () => ({ ok: false, error: 'missing transcript' });
  h.window.api.archiveSession = async () => ({ ok: false, error: 'database locked' });
  await h.click('.session-delete-btn');
  await h.click('.session-archive-btn');
  const other = h.notice('missing transcript', 'Delete');
  const archive = h.notice('database locked', 'Archive');
  h.window.api.archiveSession = async () => ({ archived: 1 });
  await h.click('.session-archive-btn');
  assert.equal(archive.isConnected, false);
  assert.equal(other.isConnected, true);
  other.querySelector('.app-notice-dismiss').click();
  assert.equal(other.isConnected, false);
  assert.equal(h.document.activeElement, h.focus);
});

test('unreachable Archive names host and object while retaining its warning', async t => {
  const h = setup(t, { remoteAlias: 'vps', remoteDescriptorSeen: true });
  h.window.api.remoteStopSession = async () => ({ ok: false, hostUnreachable: true, error: 'host unreachable' });
  await h.click('.session-archive-btn');
  const el = h.notice('host unreachable', 'Archive');
  assert.match(el.textContent, /vps/);
  assert.match(el.textContent, /unarchive/i);
  assert.equal(h.session.archived, 1, 'established archive-on-unreachable policy');
});

test('folder partial failure remains a notice and a rejected planning IPC is caught', async t => {
  const h = setup(t);
  h.window.api.getProjectArchivePlan = async () => { throw new Error('backend disconnected'); };
  await h.click('.project-archive-btn');
  h.notice('backend disconnected', 'Archive');
  h.window.api.getProjectArchivePlan = async () => ({ schedules: [] });
  h.window.api.archiveProject = async () => ({ ok: true, failed: [{ name: 'nightly', error: 'EACCES' }] });
  const button = h.document.querySelector('.project-archive-btn');
  const pending = h.click('.project-archive-btn');
  await answerChoiceDialog(h, { confirm: true });
  await pending;
  h.notice('EACCES', 'Archive', button);
});

test('background handoff and attach errors persist independently and attach retry clears its own notice', async t => {
  const h = setup(t);
  const entry = { session: h.session, closed: false };
  h.window.openSessions.set('s1', entry);
  h.window.activePtyIds.add('s1');
  h.window.activeSubagentsByParent = new Map();
  h.window.updateTerminalHeader = () => {};
  h.window.skippedWorkingSetEntries = new Map();
  h.window.beginPtyOpen = () => {};
  h.window.settlePtyOpen = () => {};
  h.window.syncPtySizeAfterOpen = () => {};
  h.window.schedulePersistWorkingSet = () => {};
  h.window.LIVE_ELSEWHERE_NOTICE_MS = 20_000;
  h.window.api.sendSessionToBackground = async () => { throw new Error('handoff disconnected'); };
  const app = loadAppFunctions(h.context, { functions: ['sendSessionToBackground', 'attachBackgroundContinuation', 'showRestoreNotice'], installSpies: false });
  await app.sendSessionToBackground('s1');
  const handoff = h.notice('handoff disconnected', 'background');
  assert.equal(h.window.openSessions.get('s1'), entry);
  h.window.api.openTerminal = async () => ({ ok: false, error: 'attach disconnected' });
  await app.attachBackgroundContinuation(entry, { jobId: 'job' });
  const attach = h.notice('attach disconnected', 'attach');
  h.window.api.openTerminal = async () => ({ ok: true });
  await app.attachBackgroundContinuation(entry, { jobId: 'job' });
  assert.equal(attach.isConnected, false);
  assert.equal(handoff.isConnected, true);
});

test('slug bulk Archive keeps partial successes and reports each refused member', async t => {
  const h = setup(t, { slug: 'conversation' });
  const second = { ...h.session, sessionId: 's2', name: 'Second' };
  h.project.sessions.push(second);
  h.render();
  const calls = [];
  h.window.api.archiveSession = async id => { calls.push(id); return id === 's1' ? { ok: false, error: 'first locked' } : { archived: 1 }; };
  await h.click('.slug-group-archive-btn');
  h.notice('first locked', 'Archive');
  assert.deepEqual(calls, ['s1', 's2']);
  assert.equal(h.session.archived, 0);
  assert.equal(second.archived, 1);
});

test('missing restored transcript remains actionable after rebuild without an expiry', t => {
  const h = setup(t);
  h.window.LIVE_ELSEWHERE_NOTICE_MS = 20_000;
  const { showNotRestoredNotice, showRestoreNotice } = loadAppFunctions(h.context, { functions: ['showNotRestoredNotice', 'showRestoreNotice'] });
  h.window.showRestoreNotice = showRestoreNotice;
  showNotRestoredNotice([{ sessionId: 's1', projectPath: '/project' }]);
  h.notice('not in the index', 'restor');
});

test('an absent Stop acknowledgement blocks Archive and preserves PTY liveness', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('s1');
  h.window.api.stopSession = async () => undefined;
  let archived = false;
  h.window.api.archiveSession = async () => { archived = true; return { archived: 1 }; };
  await h.click('.session-archive-btn');
  h.notice('no result', 'Archive');
  assert.equal(archived, false);
  assert.ok(h.window.activePtyIds.has('s1'));
});

test('a Restore refusal for an external process stays visible with its terminal recovery', t => {
  const h = setup(t);
  h.window.LIVE_ELSEWHERE_NOTICE_MS = 20_000;
  const { showLiveElsewhereNotice } = loadAppFunctions(h.context, { functions: ['showLiveElsewhereNotice', 'showRestoreNotice'] });
  showLiveElsewhereNotice([{ session: h.session, live: { pid: 4242 } }]);
  const notice = h.notice('4242', 'restor');
  assert.match(notice.textContent, /own terminal/);
  assert.doesNotMatch(notice.textContent, /stop it first|close it first/);
});

test('Stop Retry retains its alert when confirmation is cancelled and clears only on success', async t => {
  const h = setup(t);
  h.window.appConfirm = async () => true;
  h.window.api.stopSession = async () => ({ ok: false, error: 'stop refused' });
  const { confirmAndStopSession } = loadAppFunctions(h.context, { functions: ['confirmAndStopSession'], installSpies: false });
  await confirmAndStopSession('s1', null, h.session);
  const notice = h.notice('stop refused', 'Stop');
  h.window.appConfirm = async () => false;
  notice.querySelector('.app-notice-action').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(notice.isConnected, 'cancelled Retry keeps the failure visible');
  h.window.showAppNotice({ id: 'unrelated', kind: 'error', message: 'Other operation failed' });
  h.window.appConfirm = async () => true;
  h.window.api.stopSession = async () => ({ ok: true });
  notice.querySelector('.app-notice-action').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notice.isConnected, false);
  assert.ok(h.document.querySelector('[data-notice-id="unrelated"]'));
});

test('background terminal confirmation is information while handoff is pending', t => {
  const h = setup(t);
  const button = h.document.createElement('button');
  button.id = 'terminal-bg-btn';
  h.document.body.append(button);
  let notify;
  h.window.api.onBgHandoffNotice = callback => { notify = callback; };
  const { initTerminalBackgroundControl } = loadAppFunctions(h.context, { functions: ['initTerminalBackgroundControl'] });
  initTerminalBackgroundControl();
  notify('s1', 'Claude asks you to confirm in the terminal (Background / Stay).');
  const notice = h.document.querySelector('#app-notices [role="status"]');
  assert.ok(notice, 'terminal question must not be labelled a failed handoff');
  assert.match(notice.textContent, /confirm in the terminal/);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});
test('a failed Unarchive names that action and preserves its archived state', async t => {
  const h = setup(t, { archived: 1 });
  h.window.api.archiveSession = async () => ({ ok: false, error: 'database locked' });
  await h.click('.session-archive-btn');
  h.notice('database locked', 'Unarchive');
  assert.equal(h.session.archived, 1);
});
