'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const PROJECT = '/project';
const LIVE = { pid: 4242, cwd: PROJECT, startedAt: 1 };

async function waitUntil(check, { tries = 500, intervalMs = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return check();
}

function setup(t, { id = 'B', ids = [id], members = ['B'], headSessionId, mode = 'auto', live = false, liveId = id, fresh = false, indexed = true, remembered = false } = {}) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const saved = ids.map(sessionId => ({ sessionId, projectPath: PROJECT, active: sessionId === ids.at(-1), ...(fresh ? { fresh: true } : {}) }));
  const settings = { global: { restoreOnStartup: mode, openWorkingSet: saved } };
  const spawned = [];
  const continuationQueries = [];
  const liveQueries = [];
  const row = {
    sessionId: 'A', headSessionId, mergedMemberIds: members, projectPath: PROJECT,
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
      return live && ids.includes(liveId) ? { [liveId]: LIVE } : {};
    },
    getSessionLiveElsewhere: async sessionId => live && sessionId === liveId ? LIVE : null,
    openTerminal: async (sessionId, projectPath) => {
      spawned.push({ sessionId, projectPath });
      return { ok: true };
    },
  });
  h.window.appConfirm = async () => { throw new Error('automatic restore must not prompt'); };
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

for (const ids of [['B', 'A'], ['A', 'B'], ['B', 'C']]) {
  test(`auto restore spawns every saved id in order [${ids.join(', ')}]`, async t => {
    const h = setup(t, { ids, members: ['C', 'B'] });
    await h.restoreWorkingSet();
    assert.deepEqual(h.spawned.map(s => s.sessionId), ids, 'restore must spawn every saved id in saved order');
    assert.deepEqual(await h.persist(), h.saved, 'every restored id keeps its saved order and active state');
  });
}

test('auto restore persists both B and primary A when B was saved first', async t => {
  const h = setup(t, { ids: ['B', 'A'] });
  await h.restoreWorkingSet();
  assert.deepEqual(await h.persist(), h.saved, 'the saved primary A must not disappear after member B opens');
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

test('saved primary A with head B live elsewhere is skipped with a notice naming B and kept', async t => {
  const h = setup(t, { id: 'A', headSessionId: 'B', live: true, liveId: 'B' });
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, [], 'restore must not resume a conversation whose head is live elsewhere');
  assert.match(h.document.getElementById('restore-live-elsewhere-toast')?.textContent || '', /Not reopened: B is live in pid 4242/);
  assert.deepEqual(await h.persist(), [{ ...h.saved[0], active: false }], 'the skipped primary stays saved');
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
  assert.equal(await waitUntil(() => h.read('restoringWorkingSet') === false), true);
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

test('a remembered active id absent from all rows only restores the working set', async () => {
  const calls = [];
  const ctx = vm.createContext({
    window: {},
    localStorage: { getItem: () => null },
    activeSessionId: 'missing',
    openSessions: new Map(),
    sessionMap: new Map([['A', { sessionId: 'A', mergedMemberIds: ['B'] }]]),
    openSession: async session => { calls.push(session.sessionId); },
    restoreWorkingSet: async () => { calls.push('working set'); },
    restoreAgentsViewAtStartup() {},
  });
  const { restoreStartupSessions } = loadAppFunctions(ctx, { functions: ['restoreStartupSessions'] });
  await assert.doesNotReject(restoreStartupSessions);
  assert.deepEqual(calls, ['working set']);
  assert.equal(ctx.window._startupResumeResolutions, null);
});
