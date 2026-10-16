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
    assert.match(el.textContent, /retry (?:Stop|Detach|Delete|Unarchive|Archive(?: folder)?)|try again (?:once|when)|own terminal|open (?:it|the (?:session|conversation)) from the sidebar|Agent Files|Reindex all sessions/i);
    assert.doesNotMatch(el.textContent, /schedules in Settings|reload the sidebar|eligible/i);
    assert.equal(h.document.activeElement, expectedFocus);
    el.dispatchEvent(new h.window.MouseEvent('mouseleave'));
    render();
    assert.ok(el.isConnected, 'survives sidebar rebuild and pointer leave');
    assert.deepEqual(timers.filter(ms => ms > 0), [], 'failure schedules no expiry, including beyond 20 s (modal focus may schedule 0 ms)');
    return el;
  };
  return { ...h, session, project, render, click, notice, focus, timers };
}

test('successive not-stopped batches merge by host and refresh a repeated member reason', t => {
  const h = setup(t, { remoteAlias: 'vps' });
  const second = { ...h.session, sessionId: 's2', name: 'Second' };
  h.window.announceNotStopped([{ alias: 'vps', error: 'first timeout', session: h.session }]);
  h.window.announceNotStopped([{ alias: 'vps', error: 'second timeout', session: second }]);
  let el = h.document.querySelector('[data-notice-id="Archive:vps:not-stopped"]');
  assert.match(el.textContent, /s1.*s2/);
  assert.match(el.textContent, /first timeout/);
  assert.match(el.textContent, /second timeout/);
  h.window.announceNotStopped([{ alias: 'vps', error: 'new refusal', session: { ...h.session, name: 'Updated' } }]);
  el = h.document.querySelector('[data-notice-id="Archive:vps:not-stopped"]');
  assert.match(el.textContent, /Updated.*s1.*s2/);
  assert.match(el.textContent, /new refusal/);
  assert.doesNotMatch(el.textContent, /first timeout/);
  assert.equal((el.textContent.match(/s1/g) || []).length, 1);
  h.window.clearAppNotice(h.window.sessionActionNoticeId('Archive', h.session));
  el = h.document.querySelector('[data-notice-id="Archive:vps:not-stopped"]');
  assert.doesNotMatch(el.textContent, /s1/);
  assert.match(el.textContent, /s2/);
  h.window.clearAppNotice(h.window.sessionActionNoticeId('Archive', second));
  assert.equal(h.document.querySelector('[data-notice-id="Archive:vps:not-stopped"]'), null);
});

for (const group of ['live', 'unavailable', 'pending']) {
  test(`successive ${group} restore batches keep both members and update repeated text`, t => {
    const h = setup(t);
    const app = loadAppFunctions(h.context, { functions: ['showLiveElsewhereNotice', 'showNotRestoredNotice', 'showRestoreNotice'] });
    const second = { sessionId: 's2', name: 'Second', projectPath: '/second' };
    const announce = session => group === 'unavailable' ? app.showNotRestoredNotice([session])
      : app.showLiveElsewhereNotice([{ session, live: { pid: session.sessionId === 's1' ? 42 : 43 }, ...(group === 'pending' ? { waitingForIndex: true, retryAfterIndexing: true } : {}) }]);
    announce(h.session);
    announce(second);
    const id = group === 'unavailable' ? 'Restore:unavailable' : group === 'pending' ? 'Restore:pending' : 'Restore:batch';
    let el = h.document.querySelector(`[data-notice-id="${id}"]`);
    assert.match(el.textContent, /s1.*s2/);
    h.session.name = 'Updated';
    announce(h.session);
    el = h.document.querySelector(`[data-notice-id="${id}"]`);
    assert.match(el.textContent, /Updated.*s1.*s2/);
    assert.equal((el.textContent.match(/s1/g) || []).length, 1);
    h.window.clearAppNotice(h.window.sessionActionNoticeId('Restore', h.session));
    el = h.document.querySelector(`[data-notice-id="${id}"]`);
    assert.doesNotMatch(el.textContent, /s1/);
    assert.match(el.textContent, /s2/);
    h.window.clearAppNotice(h.window.sessionActionNoticeId('Restore', second));
    assert.equal(h.document.querySelector(`[data-notice-id="${id}"]`), null);
  });
}

test('an indexing hold needing user action is persistent while automatic retries alone are pending', async t => {
  const h = setup(t);
  h.window.restorePlanner = null;
  h.window.skippedWorkingSetEntries = new Map();
  const app = loadAppFunctions(h.context, { functions: ['showLiveElsewhereNotice', 'showRestoreNotice', 'markRestoreIndexingDone'] });
  app.showLiveElsewhereNotice([
    { session: h.session, waitingForIndex: true, retryAfterIndexing: false },
    { session: { sessionId: 'auto', projectPath: '/auto' }, waitingForIndex: true, retryAfterIndexing: true },
  ]);
  const manual = h.document.querySelector('[data-notice-id="Restore:batch"]');
  const pending = h.document.querySelector('[data-notice-id="Restore:pending"]');
  assert.ok(manual);
  assert.equal(manual.getAttribute('role'), 'alert');
  assert.match(manual.textContent, /s1.*Open it from the sidebar to choose and retry restoring/);
  assert.doesNotMatch(manual.textContent, /auto/);
  assert.equal(pending.getAttribute('role'), 'status');
  assert.match(pending.textContent, /auto.*will retry/);
  assert.doesNotMatch(pending.textContent, /s1/);
  await app.markRestoreIndexingDone();
  assert.ok(manual.isConnected);
  assert.equal(pending.isConnected, false);
});

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
  const { initTerminalBackgroundControl } = loadAppFunctions(h.context, { functions: ['initTerminalBackgroundControl', 'showRestoreNotice'] });
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

test('folder partial success names Agent Files and uses a partial headline with one path', async t => {
  const h = setup(t);
  h.window.api.getProjectArchivePlan = async () => ({ schedules: [] });
  h.window.api.archiveProject = async () => ({ ok: true, failed: [{ name: 'nightly', error: 'EACCES' }] });
  const pending = h.click('.project-archive-btn');
  await answerChoiceDialog(h, { confirm: true });
  await pending;
  const el = h.document.querySelector('[role="alert"]');
  assert.match(el.textContent, /^Archive folder partly done/);
  assert.match(el.textContent, /schedule-.*\.md.*Agent Files/);
  assert.doesNotMatch(el.textContent, /schedules in Settings|Archive folder failed/);
  assert.equal(el.textContent.split('/project').length - 1, 1);
});

test('an Archive database failure after Stop says the process stopped and the row is not archived', async t => {
  const h = setup(t);
  h.window.activePtyIds.add('s1');
  h.window.api.stopSession = async () => ({ ok: true });
  h.window.api.archiveSession = async () => ({ ok: false, error: 'database locked' });
  await h.click('.session-archive-btn');
  const el = h.notice('database locked', 'Archive');
  assert.match(el.textContent, /process was stopped.*(?:row|session) is not archived/);
  assert.equal(h.session.archived, 0);
});

test('Unarchive clears its host partial Archive notice and preserves another operation', async t => {
  const h = setup(t, { remoteAlias: 'vps', remoteDescriptorSeen: true });
  h.window.api.remoteStopSession = async () => ({ ok: false, hostUnreachable: true, error: 'offline' });
  await h.click('.session-archive-btn');
  const el = h.notice('offline', 'Archive');
  assert.match(el.textContent, /^Archived, but not stopped/);
  assert.doesNotMatch(el.textContent, /Archive failed/);
  h.window.showAppNotice({ id: 'other', kind: 'error', message: 'Other operation failed' });
  h.render();
  h.window.api.archiveSession = async () => ({ ok: true });
  await h.click('.session-archive-btn');
  assert.equal(el.isConnected, false);
  assert.ok(h.document.querySelector('[data-notice-id="other"]'));
});

test('waiting for indexing is pending status and disappears when indexing finishes', async t => {
  const h = setup(t);
  h.window.restorePlanner = null;
  h.window.skippedWorkingSetEntries = new Map();
  const app = loadAppFunctions(h.context, { functions: ['showLiveElsewhereNotice', 'showRestoreNotice', 'markRestoreIndexingDone'] });
  app.showLiveElsewhereNotice([{ session: h.session, waitingForIndex: true, retryAfterIndexing: true }]);
  const el = h.document.querySelector('#app-notices [role="status"]');
  assert.ok(el, 'indexing progress is informational');
  assert.match(el.textContent, /Waiting for indexing/);
  assert.doesNotMatch(el.textContent, /failed/i);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  await app.markRestoreIndexingDone();
  assert.equal(el.isConnected, false);
});

test('Restore batch lists cleaned names and actual live locations in one notice', t => {
  const h = setup(t);
  const app = loadAppFunctions(h.context, { functions: ['showLiveElsewhereNotice', 'showRestoreNotice'] });
  app.showLiveElsewhereNotice([
    { session: { sessionId: 'member', name: '<command>Member</command>' }, live: { pid: 42, cwd: '/real/member' } },
    { session: { sessionId: 'second', name: 'Second', projectPath: '/second' }, live: { pid: 43, cwd: '/real/second' } },
  ]);
  const els = h.document.querySelectorAll('#app-notices [role="alert"]');
  assert.equal(els.length, 1);
  assert.match(els[0].textContent, /Member.*member.*\/real\/member.*42.*Second.*\/real\/second.*43/);
  assert.doesNotMatch(els[0].textContent, /<command>|at this window/);
});

for (const type of ['remote', 'sandboxed', 'terminal', 'pending']) {
  test(`background ${type} refusal has accurate eligibility or progress copy`, async t => {
    const h = setup(t, type === 'remote' ? { remoteAlias: 'vps' } : type === 'terminal' ? { type: 'terminal' } : {});
    h.window.openSessions.set('s1', { session: h.session, closed: false, backgrounding: type === 'pending' });
    h.window.activePtyIds.add('s1');
    h.window.sandboxedSessions = new Map(type === 'sandboxed' ? [['s1', true]] : []);
    const { sendSessionToBackground, backgroundActionReason } = loadAppFunctions(h.context, { functions: ['sendSessionToBackground', 'backgroundActionReason'] });
    h.window.backgroundActionReason = backgroundActionReason;
    await sendSessionToBackground('s1');
    const el = h.document.querySelector('#app-notices .app-notice');
    assert.ok(el);
    assert.doesNotMatch(el.textContent, /eligible/);
    if (type === 'pending') {
      assert.equal(el.getAttribute('role'), 'status');
      assert.match(el.textContent, /Moving to the background/);
      assert.doesNotMatch(el.textContent, /failed/i);
    } else {
      assert.equal(el.getAttribute('role'), 'alert');
      assert.match(el.textContent, /cannot be sent to the background/i);
      assert.match(el.textContent, type === 'remote' ? /remote/i : type === 'sandboxed' ? /sandbox/i : /plain terminal/i);
    }
  });
}

test('Delete guard recovery is used once without an extra terminal instruction', async t => {
  const h = setup(t);
  h.window.showDeleteSessionDialog = async () => true;
  h.window.api.deleteSession = async () => ({ ok: false, error: 'session is still running in this window — use Stop on its row in the sidebar, then retry Delete' });
  await h.click('.session-delete-btn');
  const el = h.notice('running in this window', 'Delete');
  assert.match(el.textContent, /use Stop on its row/);
  assert.equal((el.textContent.match(/retry Delete/g) || []).length, 1);
  assert.doesNotMatch(el.textContent, /own terminal/);
});

test('missing transcripts share one Restore batch notice and a successful member keeps the others visible', t => {
  const h = setup(t);
  const { showNotRestoredNotice } = loadAppFunctions(h.context, { functions: ['showNotRestoredNotice', 'showRestoreNotice'] });
  showNotRestoredNotice([{ sessionId: 's1', projectPath: '/project' }, { sessionId: 's2', projectPath: '/other' }]);
  assert.equal(h.document.querySelectorAll('#app-notices [role="alert"]').length, 1);
  h.window.clearAppNotice(h.window.sessionActionNoticeId('Restore', h.session));
  const el = h.document.querySelector('#app-notices [role="alert"]');
  assert.ok(el);
  assert.doesNotMatch(el.textContent, /s1/);
  assert.match(el.textContent, /s2.*Reindex all sessions/);
});

test('Unarchive removes only its member from the host notice', async t => {
  const h = setup(t, { archived: 1, remoteAlias: 'vps' });
  const second = { ...h.session, sessionId: 's2', name: 'Second' };
  h.window.announceNotStopped([{ alias: 'vps', error: 'offline', session: h.session }, { alias: 'vps', error: 'offline', session: second }]);
  h.window.api.archiveSession = async () => ({ ok: true });
  await h.click('.session-archive-btn');
  const el = h.document.querySelector('#app-notices [role="alert"]');
  assert.ok(el);
  assert.doesNotMatch(el.textContent, /s1/);
  assert.match(el.textContent, /s2/);
});
