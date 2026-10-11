'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const PROJECT = '/project';
const LIVE = { pid: 4242, cwd: PROJECT, startedAt: 1 };

function setup(t, { id = 'B', mode = 'auto', live = false, fresh = false, indexed = true, remembered = false } = {}) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const saved = [{ sessionId: id, projectPath: PROJECT, active: true, ...(fresh ? { fresh: true } : {}) }];
  const settings = { global: { restoreOnStartup: mode, openWorkingSet: saved } };
  const spawned = [];
  const continuationQueries = [];
  const liveQueries = [];
  const row = {
    sessionId: 'A', mergedMemberIds: ['B'], projectPath: PROJECT,
    name: 'Web conversation', created: new Date().toISOString(), modified: new Date().toISOString(),
    messageCount: 1,
  };
  const projects = [{ folder: '-project', projectPath: PROJECT, sessions: [row] }];
  Object.assign(h.window.api, {
    getSetting: async key => structuredClone(settings[key] || null),
    setSetting: async (key, value) => { settings[key] = structuredClone(value); },
    getIndexingState: async () => ({ finished: indexed }),
    getSessionContinuations: async sessionId => {
      continuationQueries.push(sessionId);
      return { candidates: [], unresolved: false, continued: false };
    },
    getSessionsLiveElsewhere: async ids => {
      liveQueries.push([...ids]);
      return live ? { [id]: LIVE } : {};
    },
    getSessionLiveElsewhere: async () => live ? LIVE : null,
    openTerminal: async (sessionId, projectPath) => {
      spawned.push({ sessionId, projectPath });
      return { ok: true };
    },
  });
  h.window.confirm = () => { throw new Error('automatic restore must not prompt'); };
  h.evalPublic('restore-plan.js');
  h.evalPublic('resume-guard.js');
  const functions = loadAppFunctions(h.context, {
    declarations: [
      'restoringWorkingSet', 'restorePlanner', 'restoreMode', 'restoreIndexingDone',
      'sessionOpenedOutsideRestore', 'continuationRetryCancelled', 'skippedWorkingSetEntries',
      'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', '_persistChain',
      'exitingApp', 'savedWorkingSetRead', 'RESTORE_STAGGER_MS', 'LIVE_ELSEWHERE_NOTICE_MS', 'openingSessions',
    ],
    functions: [
      'dedup', 'restoreWorkingSet', 'tickRestorePlanner', 'markRestoreIndexingDone',
      'runRestore', 'openSession', 'openSessionNow', 'persistWorkingSet', 'pendingRestoreEntries',
      'showRestoreNotice', 'showNotRestoredNotice', 'showLiveElsewhereNotice', 'showColdCacheNotice',
      'restoreStartupSessions',
    ],
  });
  Object.assign(h.window, {
    SETTING_DEFAULTS: { restoreOnStartup: 'ask' },
    createTerminalEntry(session) {
      const entry = { session, closed: false, terminal: { write() {}, focus() {} }, initialSize: {} };
      h.window.openSessions.set(session.sessionId, entry);
      h.window.activePtyIds.add(session.sessionId);
      return entry;
    },
    showSession(sessionId) { h.window.activeSessionId = sessionId; },
    resolveDefaultSessionOptions: async () => ({}),
    syncPtySizeAfterOpen() {},
    setSessionMcpState() {},
    setSessionSandboxed() {},
    forgetSessionExit() {},
    beginPtyOpen() {},
    settlePtyOpen() {},
    schedulePersistWorkingSet() {},
    restoreAgentsViewAtStartup() {},
    launchNewSession() { throw new Error('an indexed merged member must resume, not start fresh'); },
    loadProjects: async () => functions.dedup(projects),
  });
  if (indexed) functions.dedup(projects);
  if (remembered) h.window.activeSessionId = id;

  const persist = async () => {
    await functions.persistWorkingSet();
    return settings.global.openWorkingSet;
  };
  const assertRunningRow = () => {
    h.sidebar.renderProjects(projects);
    const el = h.window.sessionItemEl(id);
    assert.equal(el?.dataset.sessionId, 'A', 'the member uses the primary sidebar row');
    assert.ok(el.classList.contains('has-running-pty'), 'the merged row has a running PTY');
    assert.ok(el.querySelector('.session-icon').classList.contains('running'), 'the merged row shows its running icon');
    assert.ok(el.classList.contains('active'), 'the merged row is active');
    assert.equal(h.window.rowOpenId(row), id, 'the row follows the restored member');
    assert.deepEqual([...h.window.sessionMap.keys()], ['A'], 'the sidebar map keeps row primaries only');
  };
  return { ...h, ...functions, saved, settings, spawned, continuationQueries, liveQueries, persist, assertRunningRow };
}

test('auto restore reopens saved merged member B and persists B on active row A', async t => {
  const h = setup(t);
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, [{ sessionId: 'B', projectPath: PROJECT }], 'restore must reopen member B, not primary A');
  assert.deepEqual(h.continuationQueries, ['B'], 'continuations are checked for the saved member');
  assert.deepEqual(await h.persist(), h.saved, 'the saved working set keeps member B and its active state');
  h.assertRunningRow();
});

test('auto restore of saved primary A is unchanged', async t => {
  const h = setup(t, { id: 'A' });
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, [{ sessionId: 'A', projectPath: PROJECT }]);
  assert.deepEqual(await h.persist(), h.saved);
  h.assertRunningRow();
});

test('saved merged member B live elsewhere is skipped, checked by B and kept', async t => {
  const h = setup(t, { live: true });
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.liveQueries, [['B']], 'liveness must be checked for member B');
  assert.deepEqual(await h.persist(), [{ ...h.saved[0], active: false }], 'the skipped member stays saved like any live-elsewhere session');
  assert.match(h.document.getElementById('restore-live-elsewhere-toast')?.textContent || '', /live in pid 4242/);
  assert.equal(h.document.getElementById('restore-unavailable-toast'), null);
});

test('ask mode offers saved merged member B, keeps it pending and restores B on consent', async t => {
  const h = setup(t, { mode: 'ask' });
  await h.restoreWorkingSet();
  const toast = h.document.getElementById('restore-toast');
  assert.ok(toast, 'ask mode must offer the indexed merged member');
  assert.match(toast.textContent, /Restore 1 session from last time/);
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(await h.persist(), h.saved, 'pending consent keeps member B saved');
  toast.querySelector('.restore-toast-restore').click();
  await t.waitFor(() => assert.equal(h.read('restoringWorkingSet'), false));
  assert.deepEqual(h.spawned, [{ sessionId: 'B', projectPath: PROJECT }]);
  assert.deepEqual(await h.persist(), h.saved);
  h.assertRunningRow();
});

test('a merged member arriving in the final index batch restores B', async t => {
  const h = setup(t, { indexed: false });
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(await h.persist(), h.saved, 'cold indexing keeps B pending');
  await h.markRestoreIndexingDone();
  assert.deepEqual(h.spawned, [{ sessionId: 'B', projectPath: PROJECT }], 'the last index batch must make B restorable');
  assert.deepEqual(await h.persist(), h.saved);
});

test('a saved fresh member B with an indexed transcript resumes B', async t => {
  const h = setup(t, { fresh: true });
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, [{ sessionId: 'B', projectPath: PROJECT }]);
  assert.deepEqual(await h.persist(), [{ sessionId: 'B', projectPath: PROJECT, active: true }]);
});

test('runRestore directly resolves member B without relying on the planner', async t => {
  const h = setup(t);
  await h.runRestore(h.saved);
  assert.deepEqual(h.spawned, [{ sessionId: 'B', projectPath: PROJECT }], 'the open path must resolve the member too');
  assert.deepEqual(await h.persist(), h.saved);
});

test('a remembered active merged member B is reopened before working-set restore', async t => {
  const h = setup(t, { remembered: true, mode: 'ask' });
  await h.restoreStartupSessions();
  assert.deepEqual(h.spawned, [{ sessionId: 'B', projectPath: PROJECT }], 'the remembered open must resolve member B');
  assert.equal(h.document.getElementById('restore-toast'), null, 'the remembered open retains renderer-reload cancellation');
  assert.deepEqual(await h.persist(), h.saved);
});
