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

function setup(t, { id = 'B', ids = [id], members = ['B'], headSessionId = members[0], mode = 'auto', live = false, liveId = id, liveDescriptor = LIVE, fresh = false, indexed = true, remembered = false } = {}) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const saved = ids.map(sessionId => ({ sessionId, projectPath: PROJECT, active: sessionId === ids.at(-1), ...(fresh ? { fresh: true } : {}) }));
  const settings = { global: { restoreOnStartup: mode, openWorkingSet: saved } };
  const spawned = [];
  const attached = [];
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
      return live && ids.includes(liveId) ? { [liveId]: liveDescriptor } : {};
    },
    getSessionLiveElsewhere: async sessionId => live && sessionId === liveId ? liveDescriptor : null,
    openTerminal: async (sessionId, projectPath, _sandboxed, options) => {
      if (options?.type === 'attach') attached.push({ sessionId, jobId: options.jobId });
      else spawned.push({ sessionId, projectPath });
      return { ok: true };
    },
  });
  h.window.appConfirm = async () => { throw new Error('automatic restore must not prompt'); };
  h.evalPublic('restore-plan.js');
  h.evalPublic('resume-guard.js');
  const functions = loadAppFunctions(h.context, {
    declarations: [
      'restoreRunDepth', 'restoringWorkingSet', 'restorePlanner', 'restoreMode', 'restoreIndexingDone',
      'sessionOpenedOutsideRestore', 'continuationRetryCancelled', 'skippedWorkingSetEntries',
      'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', '_persistChain',
      'exitingApp', 'savedWorkingSetRead', 'RESTORE_STAGGER_MS', 'LIVE_ELSEWHERE_NOTICE_MS', 'openingSessions', 'dormantWorkingSet',
    ],
    functions: [
      'dedup', 'restoreWorkingSet', 'tickRestorePlanner', 'markRestoreIndexingDone',
      'runRestore', 'openSession', 'openSessionNow', 'persistWorkingSet', 'pendingRestoreEntries',
      'showRestoreNotice', 'showNotRestoredNotice', 'showLiveElsewhereNotice', 'showColdCacheNotice',
      'restoreStartupSessions', 'reopenActiveSessionAfterReload', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow'
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
    const el = h.window.sessionItemEl(headSessionId);
    assert.equal(el?.dataset.sessionId, 'A', 'the member uses the primary sidebar row');
    assert.ok(el.classList.contains('has-running-pty'), 'the merged row has a running PTY');
    assert.ok(el.querySelector('.session-icon').classList.contains('running'), 'the merged row shows its running icon');
    assert.ok(el.classList.contains('active'), 'the merged row is active');
    assert.equal(h.window.rowOpenId(row), headSessionId, 'the row follows the restored head');
    assert.deepEqual([...h.window.sessionMap.keys()], ['A'], 'the sidebar map keeps row primaries only');
  };
  return { ...h, ...functions, saved, settings, spawned, attached, continuationQueries, liveQueries, persist, assertRunningRow };
}

test('auto restore reopens saved merged member B and persists B on active row A', async t => {
  const h = setup(t);
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, [{ sessionId: 'B', projectPath: PROJECT }], 'restore must reopen member B, not primary A');
  assert.deepEqual(h.continuationQueries, ['B'], 'continuations are checked for the saved member');
  assert.deepEqual(await h.persist(), h.saved, 'the saved working set keeps member B and its active state');
  h.assertRunningRow();
});

test('auto restore of saved primary A follows head B', async t => {
  const h = setup(t, { id: 'A' });
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, [{ sessionId: 'B', projectPath: PROJECT }]);
  assert.deepEqual(await h.persist(), [{ sessionId: 'B', projectPath: PROJECT, active: true }]);
  h.assertRunningRow();
});

for (const ids of [['B', 'A'], ['A', 'B'], ['B', 'C']]) {
  test(`auto restore reuses one head tab for saved row members [${ids.join(', ')}]`, async t => {
    const headSessionId = ids.includes('C') ? 'C' : 'B';
    const h = setup(t, { ids, members: headSessionId === 'C' ? ['C', 'B'] : ['B'] });
    await h.restoreWorkingSet();
    assert.deepEqual(h.spawned.map(s => s.sessionId), [headSessionId]);
    assert.equal(h.window.openSessions.size, 1);
    assert.deepEqual(await h.persist(), [{ sessionId: headSessionId, projectPath: PROJECT, active: true }]);
  });
}

test('auto restore persists one tab when B and primary A were saved', async t => {
  const h = setup(t, { ids: ['B', 'A'] });
  await h.restoreWorkingSet();
  assert.deepEqual(await h.persist(), [{ sessionId: 'B', projectPath: PROJECT, active: true }]);
});

test('saved merged member B live elsewhere is skipped, checked by B and kept', async t => {
  const h = setup(t, { live: true });
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.liveQueries, [['B'], ['B', 'A']], 'restore rechecks the head and every other row member');
  assert.deepEqual(await h.persist(), [{ ...h.saved[0], active: false }], 'the skipped member stays saved like any live-elsewhere session');
  assert.match(h.document.querySelector('#app-notices [role="alert"]')?.textContent || '', /live outside this window in pid 4242/);
  assert.equal(h.document.getElementById('restore-unavailable-toast'), null);
});

test('saved primary A with head B live elsewhere is skipped with a notice naming B and kept', async t => {
  const h = setup(t, { id: 'A', headSessionId: 'B', live: true, liveId: 'B' });
  await h.restoreWorkingSet();
  assert.deepEqual(h.spawned, [], 'restore must not resume a conversation whose head is live elsewhere');
  assert.match(h.document.querySelector('#app-notices [role="alert"]')?.textContent || '', /B.*live outside this window in pid 4242/);
  assert.deepEqual(await h.persist(), [{ sessionId: 'B', projectPath: PROJECT, active: false }], 'the held entry follows the head');
  assert.equal(h.document.getElementById('restore-unavailable-toast'), null);
});

test('saved root A is held without prompting when middle B has a live bg job', async t => {
  const h = setup(t, { id: 'A', members: ['C', 'B'], live: true, liveId: 'B', liveDescriptor: { ...LIVE, kind: 'bg', jobId: 'middle-job' } });
  await h.restoreWorkingSet();
  assert.deepEqual(h.attached, [], 'restore must not attach to the middle part job');
  assert.deepEqual(h.spawned, [], 'a live middle part must hold the conversation');
  assert.equal(h.window.openSessions.size, 0);
  assert.deepEqual(await h.persist(), [{ sessionId: 'C', projectPath: PROJECT, active: false }]);
  assert.match(h.document.querySelector('#app-notices [role="alert"]')?.textContent || '', /B.*live outside this window/);
});

test('saved root A still attaches when head C has a live bg job', async t => {
  const h = setup(t, { id: 'A', members: ['C', 'B'], live: true, liveId: 'C', liveDescriptor: { ...LIVE, kind: 'bg', jobId: 'head-job' } });
  await h.restoreWorkingSet();
  assert.deepEqual(h.attached, [{ sessionId: 'C', jobId: 'head-job' }]);
  assert.deepEqual(h.spawned, [], 'attaching must not spawn a resume');
  assert.equal(h.window.openSessions.size, 1);
  assert.deepEqual(await h.persist(), [{ sessionId: 'C', projectPath: PROJECT, active: true, bg: true, attachJobId: 'head-job' }]);
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

test('a remembered active id absent from all rows is not reported during indexing', async () => {
  const calls = [];
  const unavailableIds = [];
  const ctx = vm.createContext({
    window: { api: {
      getSetting: async () => ({ openWorkingSet: [{ sessionId: 'missing', projectPath: PROJECT }] }),
      getActiveSessions: async () => [],
      getIndexingState: async () => ({ finished: false }),
    } },
    localStorage: { getItem: () => null },
    activeSessionId: 'missing',
    openSessions: new Map(),
    sessionMap: new Map([['A', { sessionId: 'A', mergedMemberIds: ['B'] }]]),
    localMergedMemberRows: new Map(),
    openSession: async session => { calls.push(session.sessionId); },
    showNotRestoredNotice: entries => { unavailableIds.push(...entries.map(entry => entry.sessionId)); },
    restoreWorkingSet: async () => { calls.push('working set'); },
    restoreAgentsViewAtStartup() {},
  });
  const { restoreStartupSessions } = loadAppFunctions(ctx, { functions: ['restoreStartupSessions', 'reopenActiveSessionAfterReload', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow'] });
  await assert.doesNotReject(restoreStartupSessions);
  assert.deepEqual(calls, ['working set']);
  assert.deepEqual(unavailableIds, []);
  assert.equal(ctx.window._startupResumeResolutions, null);
});
