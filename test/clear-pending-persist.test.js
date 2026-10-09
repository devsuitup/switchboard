'use strict';

// see docs/session-restore.md ("A session with no transcript yet")

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const PLAN_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'restore-plan.js'), 'utf8');
const PROJECT = { folder: '-srv-app', projectPath: '/srv/app', sessions: [] };

function setup() {
  const ctx = setupSidebarDom();
  const { window } = ctx;
  const settings = { global: { openWorkingSet: [] } };
  let persists = 0;
  let projects = [PROJECT];
  let archived = [];
  const launched = [];
  const shown = [];
  Object.assign(window, {
    loadingStatus: window.document.createElement('div'),
    terminalHeaderId: window.document.createElement('span'),
    terminalHeaderName: window.document.createElement('span'),
    reportActivityFocus: () => {},
    reportActivityTitles: () => {},
    pollActiveSessions: async () => {},
    refreshSidebar: () => {},
    renderDefaultStatus: () => {},
    rekeyActivityState: () => {},
    setActiveSession: (id) => { window.activeSessionId = id; },
    encodeProjectPath: (p) => p.replace(/\//g, '-'),
    schedulePersistWorkingSet: () => { persists += 1; },
    liveElsewhereMany: async () => ({}),
    showLiveElsewhereNotice: () => {},
    showSession: (id) => shown.push(id),
    openSession: async () => true,
    resolveDefaultSessionOptions: async () => ({ permissionMode: 'plan', worktree: true, worktreeName: 'w' }),
    launchNewSession: async (project, options) => {
      const id = `started-${launched.length + 1}`;
      launched.push({ projectPath: project.projectPath, options });
      window.openSessions.set(id, { session: { sessionId: id, projectPath: project.projectPath }, closed: false });
      return id;
    },
    RESTORE_STAGGER_MS: 0,
  });
  window.api = {
    getProjects: async (showArchived) => JSON.parse(JSON.stringify(showArchived ? [...projects, ...archived] : projects)),
    getActiveTerminals: async () => [],
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
  };
  window.cachedProjects = [];
  window.cachedAllProjects = [];
  vm.runInContext(PLAN_SRC, ctx.context);
  const fns = loadAppFunctions(ctx.context, {
    functions: ['dedup', 'loadProjects', 'persistWorkingSet', 'pendingRestoreEntries', 'runRestore', 'applySessionForked'],
    declarations: ['_persistChain', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restorePlanner'],
  });
  const open = (sessionId, { pending, remoteAlias } = {}) => {
    const session = { sessionId, projectPath: '/srv/app', summary: 'Earlier work', ...(remoteAlias ? { remoteAlias } : {}) };
    window.openSessions.set(sessionId, { session, closed: false });
    window.sessionMap.set(sessionId, session);
    if (pending) window.pendingSessions.set(sessionId, { session, projectPath: '/srv/app', folder: '-srv-app' });
  };
  return {
    ...fns, open, settings, window, launched, shown,
    run: (code) => vm.runInContext(code, ctx.context),
    persists: () => persists,
    setProjects: (list) => { projects = list; },
    setArchived: (list) => { archived = list; },
    saved: () => settings.global.openWorkingSet,
    destroy: () => ctx.destroy(),
  };
}

test('after /clear, the new id has no transcript yet: it is saved as a fresh session, not dropped', async () => {
  const h = setup();
  try {
    h.open('old-id');
    h.window.activeSessionId = 'old-id';
    h.applySessionForked('old-id', 'new-id');
    assert.ok(h.window.pendingSessions.has('new-id'), 'the cleared session is a pending row');
    await h.persistWorkingSet();
    assert.deepEqual(h.saved(), [{ sessionId: 'new-id', projectPath: '/srv/app', active: true, fresh: true }]);
  } finally { h.destroy(); }
});

test('a fresh entry is restored by starting a new session in its project, without the index', async () => {
  const h = setup();
  try {
    h.open('real');
    h.open('cleared', { pending: true });
    h.window.activeSessionId = 'cleared';
    await h.persistWorkingSet();
    const savedSet = h.saved();

    h.window.openSessions.clear();
    h.window.sessionMap.clear();
    h.window.sessionMap.set('real', { sessionId: 'real', projectPath: '/srv/app' });
    h.run(`restorePlanner = createRestorePlanner({ savedSet: ${JSON.stringify(savedSet)} });`);
    const plan = h.run('restorePlanner.tick({ sessionMap, openSessions, indexingDone: true })');
    assert.equal(plan.action, 'restore');
    assert.equal(plan.unavailable.length, 0, 'not reported as "not in the index"');
    assert.deepEqual([...plan.candidates].map(c => c.sessionId).sort(), ['cleared', 'real']);

    await h.runRestore(plan.candidates);
    assert.deepEqual(h.launched, [{ projectPath: '/srv/app', options: { permissionMode: 'plan' } }],
      'started with the project defaults, in the same folder: no new worktree');
    assert.equal(h.shown.at(-1), 'started-1', 'the restored session that was active is shown');
  } finally { h.destroy(); }
});

test('a fresh entry waiting in the restore survives a persist', async () => {
  const h = setup();
  try {
    const savedSet = [{ sessionId: 'cleared', projectPath: '/srv/app', active: false, fresh: true }];
    h.run(`restoreSavedIndex = new Map([['cleared', 0]]); restorePlanner = createRestorePlanner({ savedSet: ${JSON.stringify(savedSet)} });`);
    await h.persistWorkingSet();
    assert.deepEqual(h.saved(), savedSet);
  } finally { h.destroy(); }
});

test('a pending session on a remote host is still left out', async () => {
  const h = setup();
  try {
    h.open('remote-new', { pending: true, remoteAlias: 'box' });
    await h.persistWorkingSet();
    assert.deepEqual(h.saved(), []);
  } finally { h.destroy(); }
});

test('its first prompt makes it real, and the set is saved again without the fresh mark', async () => {
  const h = setup();
  try {
    h.open('cleared', { pending: true });
    await h.loadProjects();
    assert.equal(h.persists(), 0, 'still pending');
    h.setProjects([{ ...PROJECT, sessions: [{ sessionId: 'cleared', projectPath: '/srv/app' }] }]);
    await h.loadProjects();
    assert.equal(h.persists(), 1);
    await h.persistWorkingSet();
    assert.deepEqual(h.saved(), [{ sessionId: 'cleared', projectPath: '/srv/app', active: false }]);
  } finally { h.destroy(); }
});

test('the row added after /clear does not bring back an archived folder', async () => {
  const h = setup();
  try {
    h.setProjects([]);
    h.setArchived([{ ...PROJECT, sessions: [{ sessionId: 'old-id', projectPath: '/srv/app' }] }]);
    h.open('old-id');
    h.applySessionForked('old-id', 'new-id');
    await h.loadProjects();
    assert.ok(!h.window.cachedProjects.some(p => p.projectPath === '/srv/app'), 'hidden like the rest of the folder');
    assert.ok(h.window.cachedAllProjects.some(p => p.sessions.some(s => s.sessionId === 'new-id')), 'still listed with the archived folders');

    h.window.pendingSessions.set('plus', { session: { sessionId: 'plus', projectPath: '/srv/app' }, projectPath: '/srv/app', folder: '-srv-app' });
    await h.loadProjects();
    assert.ok(h.window.cachedProjects.some(p => p.sessions.some(s => s.sessionId === 'plus')), 'a session started with + still shows, as before');
  } finally { h.destroy(); }
});
