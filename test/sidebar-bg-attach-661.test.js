// A background session's sidebar row names its job and attaches on a click
// without the saved-entry restore detour. See .ai/contexts/bg-agents.md
// ("The sidebar").

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeLocalBackgroundSessions } = require('../sidebar-bg-sessions');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const HEAD = '33333333-3333-4333-8333-333333333333';
const PROJECT = '/home/dev/proj';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a background row carries its job name next to the job id', (t) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-661-'));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  const projects = mergeLocalBackgroundSessions([], [], [{ kind: 'bg', jobId: '33333333', sessionId: HEAD, cwd: projectPath,
    name: 'switchboard-dev (3)', nameSource: 'collision', startedAt: Date.parse('2026-11-19T18:15:29.000Z') }], {
    hiddenProjects: new Set(), metaMap: new Map(), showArchived: false, jobs: new Map([['33333333', { state: 'working', sessionId: HEAD }]]),
  });
  const row = projects.flatMap((project) => project.sessions).find((session) => session.sessionId === HEAD);
  assert.equal(row.bgJobId, '33333333');
  assert.equal(row.bgJobName, 'switchboard-dev (3)');
});

test('the bg badge shows the job name when the row is titled after its original conversation', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const project = { projectPath: PROJECT, sessions: [
    { sessionId: HEAD, name: 'Refactor the sidebar', modified: new Date().toISOString(), messageCount: 3,
      bgJobId: '33333333', bgSessionId: HEAD, bgJobName: 'switchboard-dev (3)' },
  ] };
  ctx.sidebar.renderProjects([project], false);
  const badge = ctx.document.querySelector(`[data-session-id="${HEAD}"] .bg-badge`);
  assert.ok(badge, 'the badge is there');
  assert.equal(badge.textContent, 'bg · switchboard-dev (3)');
  assert.match(badge.title, /switchboard-dev \(3\)/);
  assert.match(badge.title, /33333333/);
});

test('a collision suffix alone does not repeat the launch name in the badge', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const project = { projectPath: PROJECT, sessions: [
    { sessionId: HEAD, name: 'switchboard-dev', modified: new Date().toISOString(), messageCount: 3,
      bgJobId: '33333333', bgSessionId: HEAD, bgJobName: 'switchboard-dev (3)' },
  ] };
  ctx.sidebar.renderProjects([project], false);
  assert.equal(ctx.document.querySelector(`[data-session-id="${HEAD}"] .bg-badge`).textContent, 'bg');
});

test('a name that ends in a d is not mistaken for a collision suffix', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const project = { projectPath: PROJECT, sessions: [
    { sessionId: HEAD, name: 'board', modified: new Date().toISOString(), messageCount: 3,
      bgJobId: '33333333', bgSessionId: HEAD, bgJobName: 'board d' },
  ] };
  ctx.sidebar.renderProjects([project], false);
  assert.equal(ctx.document.querySelector(`[data-session-id="${HEAD}"] .bg-badge`).textContent, 'bg · board d');
});

test('the bg badge stays short when the row already reads the job name', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const project = { projectPath: PROJECT, sessions: [
    { sessionId: HEAD, name: 'switchboard-dev', modified: new Date().toISOString(), messageCount: 3,
      bgJobId: '33333333', bgSessionId: HEAD, bgJobName: 'switchboard-dev' },
  ] };
  ctx.sidebar.renderProjects([project], false);
  assert.equal(ctx.document.querySelector(`[data-session-id="${HEAD}"] .bg-badge`).textContent, 'bg');
});

function setupOpen() {
  const ctx = setupSidebarDom();
  const { window } = ctx;
  const calls = [];
  Object.assign(window, {
    restoringWorkingSet: false,
    sessionOpenedOutsideRestore: false,
    skippedWorkingSetEntries: new Map(),
    restoreSavedIndex: new Map(),
    restoreInFlight: new Map(),
    refreshSidebar: () => {},
    createTerminalEntry: (session) => {
      const entry = { session, closed: false, terminal: { write() {}, focus() {} }, initialSize: {} };
      window.openSessions.set(session.sessionId, entry);
      return entry;
    },
    showSession: () => {},
    destroySession: (id) => { window.openSessions.delete(id); },
    guardResume: async () => { calls.push(['guard']); return true; },
    resolveResumeSession: async (session) => { calls.push(['continuations']); return session; },
    resolveDefaultSessionOptions: async () => ({}),
    syncPtySizeAfterOpen: () => {},
    setSessionMcpState: () => {},
    setSessionSandboxed: () => {},
    forgetSessionExit: () => {},
    beginPtyOpen: () => {},
    settlePtyOpen: () => {},
    schedulePersistWorkingSet: () => {},
    pollActiveSessions: () => {},
    showAppNotice: (notice) => { calls.push(['notice', notice.message]); },
    clearAppNotice: () => {},
    sessionActionNoticeId: (action, session) => `${action}:${session.sessionId}`,
    sessionActionDescription: (session) => session.sessionId,
    showSessionActionFailure: (action, _session, reason) => { calls.push(['failure', action, String(reason)]); },
  });
  Object.assign(window.api, {
    openTerminal: async (sessionId, _cwd, _fresh, options) => { calls.push(['open', sessionId, options]); return { ok: true }; },
    restoreBackgroundJob: async (id) => { calls.push(['restore', id]); return { action: 'refuse', reason: 'worker liveness unknown', jobId: '1234abcd' }; },
    getSessionLiveElsewhere: async () => ({ kind: 'bg', jobId: '1234abcd', cwd: PROJECT }),
  });
  const row = { sessionId: HEAD, projectPath: PROJECT, name: 'switchboard-dev', modified: new Date().toISOString(), messageCount: 3,
    bgJobId: '1234abcd', bgSessionId: HEAD, bgJobName: 'switchboard-dev' };
  window.cachedProjects = [{ projectPath: PROJECT, sessions: [row] }];
  window.cachedAllProjects = window.cachedProjects;
  window.sessionMap.set(HEAD, row);
  loadAppFunctions(ctx.context, {
    declarations: ['restoreRunDepth', 'restoreMode', 'continuationRetryCancelled', 'openingSessions', 'dormantWorkingSet'],
    functions: ['openSession', 'openSessionNow', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow', 'prepareBackgroundRestore'],
  });
  return { window, row, calls, destroy: () => ctx.destroy() };
}

test('clicking a live background row attaches it directly, even while a saved restore entry holds it', async (t) => {
  const h = setupOpen();
  t.after(() => h.destroy());
  h.window.skippedWorkingSetEntries.set(HEAD, { item: { sessionId: HEAD, projectPath: PROJECT, bg: true, attachJobId: '1234abcd' }, index: 0 });
  await h.window.openSession(h.row);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['open', HEAD, { type: 'attach', jobId: '1234abcd', cwd: PROJECT }]],
    'one attach, no restore IPC, no continuation lookup, no failure notice');
  assert.equal(h.window.openSessions.get(HEAD)?.attach, true);
  assert.equal(h.window.openSessions.get(HEAD)?.attachJobId, '1234abcd');
});

test('clicking a live background row without a saved entry attaches without the continuation lookup', async (t) => {
  const h = setupOpen();
  t.after(() => h.destroy());
  await h.window.openSession(h.row);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['open', HEAD, { type: 'attach', jobId: '1234abcd', cwd: PROJECT }]]);
});

test('the direct attach follows the descriptor the main process reads now, not the cached row', async (t) => {
  const h = setupOpen();
  t.after(() => h.destroy());
  h.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '1234ABCD', cwd: '/current/worktree' });
  await h.window.openSession(h.row);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [['open', HEAD, { type: 'attach', jobId: '1234ABCD', cwd: '/current/worktree' }]]);
});

test('a stale row does not dispatch an attach after its conversation moved to another job', async (t) => {
  const h = setupOpen();
  t.after(() => h.destroy());
  h.window.api.getSessionLiveElsewhere = async () => ({ kind: 'bg', jobId: '8765abcd', cwd: PROJECT });
  await h.window.openSession(h.row);
  await settle();
  const staleAttaches = h.calls.filter(c => c[0] === 'open' && c[2]?.jobId === '1234abcd');
  assert.equal(staleAttaches.length, 0, 'cached job 1234abcd is no longer the job for this conversation');
  assert.deepEqual(h.calls.map(c => c[0]), ['continuations', 'guard', 'open'], 'the click re-resolves through the ordinary guarded path');
});

test('a row whose conversation no longer runs in the background resumes through the guarded path', async (t) => {
  const h = setupOpen();
  t.after(() => h.destroy());
  h.window.api.getSessionLiveElsewhere = async () => null;
  await h.window.openSession(h.row);
  await settle();
  assert.deepEqual(h.calls.map(c => c[0]), ['continuations', 'guard', 'open']);
  assert.equal(h.calls[2][2]?.type, undefined, 'no attach options for a conversation without a live job');
});

test('an automatic open of a background row keeps the guarded restore path', async (t) => {
  const h = setupOpen();
  t.after(() => h.destroy());
  h.window.skippedWorkingSetEntries.set(HEAD, { item: { sessionId: HEAD, projectPath: PROJECT, bg: true, attachJobId: '1234abcd' }, index: 0 });
  const opened = await h.window.openSession(h.row, undefined, { automatic: true });
  await settle();
  assert.equal(opened, false);
  assert.deepEqual(h.calls[0], ['restore', HEAD]);
});
