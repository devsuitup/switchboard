'use strict';

// see docs/session-restore.md ("A session with no transcript yet")

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions, readAppSource } = require('./app-source');

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
    resolveResumeSession: async (s) => s,
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
    functions: ['dedup', 'loadProjects', 'persistWorkingSet', 'pendingRestoreEntries', 'runRestore'],
    declarations: ['_persistChain', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restorePlanner', 'restoreIndexingDone', 'continuationRetryCancelled'],
  });
  const open = (sessionId, { pending, remoteAlias } = {}) => {
    const session = { sessionId, projectPath: '/srv/app', summary: 'Earlier work', ...(remoteAlias ? { remoteAlias } : {}) };
    window.openSessions.set(sessionId, { session, closed: false });
    window.sessionMap.set(sessionId, session);
    if (pending) window.pendingSessions.set(sessionId, { session, projectPath: '/srv/app', folder: '-srv-app' });
  };
  let forkedListener = null;
  const sessionForked = (...args) => {
    if (!forkedListener) {
      window.api.onSessionForked = (cb) => { forkedListener = cb; };
      const src = readAppSource();
      const start = src.indexOf('window.api.onSessionForked(');
      vm.runInContext(src.slice(start, src.indexOf('\n});', start) + 4), ctx.context);
    }
    forkedListener(...args);
  };
  return {
    ...fns, open, settings, window, launched, shown, sessionForked,
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
    h.sessionForked('old-id', 'new-id', 'clear');
    assert.ok(h.window.pendingSessions.has('new-id'), 'the cleared session is a pending row');
    await h.persistWorkingSet();
    assert.deepEqual(h.saved(), [{ sessionId: 'new-id', projectPath: '/srv/app', active: true, fresh: true }]);
  } finally { h.destroy(); }
});

test('the row after /clear is a new session, not a copy of the cleared conversation', async () => {
  const h = setup();
  try {
    h.open('old-id');
    Object.assign(h.window.sessionMap.get('old-id'), {
      name: 'Payments', aiTitle: 'Refactor the payment flow', starred: 1, bridgeSessionId: 'bridge-1',
      messageCount: 42, created: '2026-01-01T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z',
    });
    h.sessionForked('old-id', 'new-id', 'clear');
    assert.ok(h.window.pendingSessions.has('new-id'), 'the cleared session is a pending row');
    const rows = [h.window.pendingSessions.get('new-id')?.session, h.window.sessionMap.get('new-id'), h.window.openSessions.get('new-id')?.session];
    for (const row of rows) {
      assert.equal(row.name || row.aiTitle || row.summary, 'New session');
      assert.equal(row.starred, 0);
      assert.equal(row.bridgeSessionId, undefined);
      assert.equal(row.messageCount, 0);
      assert.equal(row.projectPath, '/srv/app');
      assert.notEqual(row.created, '2026-01-01T00:00:00.000Z');
    }
    assert.equal(h.window.sessionMap.get('old-id'), undefined);
    await new Promise((r) => setTimeout(r, 0));
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
    h.sessionForked('old-id', 'new-id', 'clear');
    await h.loadProjects();
    assert.ok(!h.window.cachedProjects.some(p => p.projectPath === '/srv/app'), 'hidden like the rest of the folder');
    assert.ok(h.window.cachedAllProjects.some(p => p.sessions.some(s => s.sessionId === 'new-id')), 'still listed with the archived folders');

    h.window.pendingSessions.set('plus', { session: { sessionId: 'plus', projectPath: '/srv/app' }, projectPath: '/srv/app', folder: '-srv-app' });
    await h.loadProjects();
    assert.ok(h.window.cachedProjects.some(p => p.sessions.some(s => s.sessionId === 'plus')), 'a session started with + still shows, as before');
  } finally { h.destroy(); }
});

test('a fork re-key adds no pending row and is never saved as fresh', async () => {
  const h = setup();
  try {
    h.open('source');
    h.window.activeSessionId = 'source';
    h.sessionForked('source', 'forked', 'fork');
    assert.ok(!h.window.pendingSessions.has('forked'));
    await h.persistWorkingSet();
    assert.deepEqual(h.saved(), [{ sessionId: 'forked', projectPath: '/srv/app', active: true }]);
  } finally { h.destroy(); }
});

test('a fresh entry is not given up on, nor started empty, before indexing is done', () => {
  const h = setup();
  try {
    const savedSet = [{ sessionId: 'cleared', projectPath: '/srv/app', active: false, fresh: true }];
    h.run(`restorePlanner = createRestorePlanner({ savedSet: ${JSON.stringify(savedSet)} });`);
    const early = h.run('restorePlanner.tick({ sessionMap, openSessions, indexingDone: false })');
    assert.equal(early.action, 'wait', 'its transcript may still be indexed');
    const done = h.run('restorePlanner.tick({ sessionMap, openSessions, indexingDone: true })');
    assert.deepEqual(Array.from(done.candidates, c => c.sessionId), ['cleared']);
    assert.equal(done.unavailable.length, 0);
  } finally { h.destroy(); }
});

test('a fresh entry whose transcript is indexed by the restart is resumed, not started empty', async () => {
  const h = setup();
  try {
    const opened = [];
    h.window.openSession = async (s) => { opened.push(s.sessionId); return true; };
    h.window.sessionMap.set('cleared', { sessionId: 'cleared', projectPath: '/srv/app' });
    const savedSet = [{ sessionId: 'cleared', projectPath: '/srv/app', active: true, fresh: true }];
    h.run(`restorePlanner = createRestorePlanner({ savedSet: ${JSON.stringify(savedSet)} });`);
    const plan = h.run('restorePlanner.tick({ sessionMap, openSessions, indexingDone: false })');
    assert.deepEqual(Array.from(plan.candidates, c => c.sessionId), ['cleared']);
    await h.runRestore(plan.candidates);
    assert.deepEqual(opened, ['cleared']);
    assert.deepEqual(h.launched, []);
  } finally { h.destroy(); }
});

test('a session started as a fork or in a new worktree is not saved as fresh', async () => {
  for (const options of [{ forkFrom: 'source' }, { worktree: true }, {}]) {
    const ctx = setupSidebarDom();
    const { window } = ctx;
    try {
      const settings = { global: { openWorkingSet: [] } };
      Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'started' }, configurable: true });
      Object.assign(window, {
        refreshSidebar: () => {},
        createTerminalEntry: (session) => {
          const entry = { session, closed: false, terminal: { write() {} }, initialSize: {} };
          window.openSessions.set(session.sessionId, entry);
          return entry;
        },
        syncPtySizeAfterOpen: () => {},
        setSessionMcpState: () => {},
        setSessionSandboxed: () => {},
        showSession: () => {},
        schedulePersistWorkingSet: () => {},
        pollActiveSessions: () => {},
      });
      window.api = {
        openTerminal: async () => ({ ok: true }),
        getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
        setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
      };
      window.cachedProjects = [];
      window.cachedAllProjects = [];
      vm.runInContext(PLAN_SRC, ctx.context);
      const fns = loadAppFunctions(ctx.context, {
        functions: ['launchNewSession', 'persistWorkingSet', 'pendingRestoreEntries'],
        declarations: ['_persistChain', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restorePlanner'],
      });
      await fns.launchNewSession({ projectPath: '/srv/app' }, options);
      await fns.persistWorkingSet();
      const expected = Object.keys(options).length ? [] : ['started'];
      assert.deepEqual(settings.global.openWorkingSet.map(i => i.sessionId), expected, JSON.stringify(options));
    } finally { ctx.destroy(); }
  }
});
