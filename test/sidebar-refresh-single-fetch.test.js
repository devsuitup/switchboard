// One projects fetch per sidebar refresh, and no sidebar rebuild when nothing
// it shows changed. See .ai/contexts/session-cache.md ("One build, two views",
// "Skipping an unchanged sidebar render").

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const sessionCache = require('../session-cache');
const { setupSidebarDom } = require('./dom-setup');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const body = src.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

// ---- loadProjects: one IPC ---------------------------------------------------

function runLoadProjects(payload, opts) {
  const calls = { getProjects: [], refreshSidebar: [] };
  const ctx = {
    window: {
      api: {
        getProjects: (...args) => { calls.getProjects.push(args); return Promise.resolve(payload); },
        getActiveTerminals: () => Promise.resolve([]),
      },
    },
    loadingStatus: { style: {}, className: '', textContent: '' },
    cachedProjects: [],
    cachedAllProjects: [],
    sessionMap: new Map(),
    pendingSessions: new Map(),
    reportActivityFocus: () => {},
    reportActivityTitles: () => {},
    encodeProjectPath: (p) => p.replace(/\//g, '-'),
    pollActiveSessions: () => Promise.resolve(),
    refreshSidebar: (o) => { calls.refreshSidebar.push(o); },
    renderDefaultStatus: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(functionSource(APP_SRC, 'dedup'), ctx);
  vm.runInContext('async ' + functionSource(APP_SRC, 'loadProjects'), ctx);
  ctx.__opts = opts;
  return vm.runInContext('loadProjects(__opts)', ctx).then(() => ({ ctx, calls }));
}

test('loadProjects asks main for the projects once and takes both views from that answer', async () => {
  const shared = { sessionId: 'a', projectPath: '/p', modified: '2026-10-01T10:00:00.000Z' };
  const archived = { sessionId: 'b', projectPath: '/p', modified: '2026-10-01T09:00:00.000Z', archived: 1 };
  const payload = {
    projects: [{ projectPath: '/p', folder: '-p', sessions: [shared] }],
    allProjects: [{ projectPath: '/p', folder: '-p', sessions: [shared, archived] }],
  };
  const { ctx, calls } = await runLoadProjects(payload);
  assert.equal(calls.getProjects.length, 1);
  assert.deepEqual(calls.getProjects[0], []);
  assert.deepEqual(ctx.cachedProjects[0].sessions.map(s => s.sessionId), ['a']);
  assert.deepEqual(ctx.cachedAllProjects[0].sessions.map(s => s.sessionId), ['a', 'b']);
  assert.equal(ctx.cachedProjects[0].sessions[0], ctx.cachedAllProjects[0].sessions[0]);
});

test('only the projects-changed reload may skip an unchanged render; a direct reload always renders', async () => {
  const payload = { projects: [], allProjects: [] };
  const direct = await runLoadProjects(payload);
  assert.equal(direct.calls.refreshSidebar[0].skipIfUnchanged, false);
  const live = await runLoadProjects(payload, { skipIfUnchanged: true });
  assert.equal(live.calls.refreshSidebar[0].skipIfUnchanged, true);
  assert.match(APP_SRC, /window\.api\.onProjectsChanged\([\s\S]*?loadProjects\(\{ skipIfUnchanged: true \}\)/);
});

// ---- main: one build, both views ----------------------------------------------

const PROJECT = '/home/dev/views-proj';
const FOLDER = '-home-dev-views-proj';
const ALL_ARCHIVED = '/home/dev/all-archived';
const ALL_ARCHIVED_FOLDER = '-home-dev-all-archived';

function row(sessionId, projectPath, folder, modified, extra = {}) {
  return {
    sessionId, folder, projectPath, summary: sessionId, firstPrompt: sessionId,
    modified, created: modified, messageCount: 1, parentSessionId: null, agentId: null,
    subagentType: null, description: null, slug: null, aiTitle: null, ...extra,
  };
}

function withCache(fn) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-views-'));
  fs.mkdirSync(path.join(projectsDir, ALL_ARCHIVED_FOLDER));
  fs.mkdirSync(path.join(projectsDir, '-home-dev-empty'));
  const rows = [
    row('live', PROJECT, FOLDER, '2026-10-01T10:00:00.000Z'),
    row('old-archived', PROJECT, FOLDER, '2026-10-01T09:00:00.000Z'),
    row('parent', PROJECT, FOLDER, '2026-10-01T08:00:00.000Z'),
    row('kid', PROJECT, FOLDER, '2026-10-01T08:30:00.000Z', { parentSessionId: 'parent', agentId: 'kid' }),
    row('gone', ALL_ARCHIVED, ALL_ARCHIVED_FOLDER, '2026-09-01T10:00:00.000Z'),
  ];
  const meta = new Map([
    ['old-archived', { archived: 1 }],
    ['parent', { archived: 1 }],
    ['gone', { archived: 1 }],
  ]);
  const folderMeta = new Map([
    [ALL_ARCHIVED_FOLDER, { projectPath: ALL_ARCHIVED }],
    ['-home-dev-empty', { projectPath: '/home/dev/empty' }],
  ]);
  let cachedReads = 0;
  try {
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      db: {
        getAllFolderMeta: () => folderMeta,
        getAllMeta: () => meta,
        getAllCached: () => { cachedReads++; return rows.map(r => ({ ...r })); },
        getSetting: () => ({}),
        setFolderMeta: () => {},
        isInitialScanComplete: () => true,
      },
    });
    return fn(() => cachedReads);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
}

test('the two views built together equal the two views built separately', () => {
  withCache(() => {
    const views = sessionCache.buildProjectViewsFromCache();
    assert.deepEqual(views.projects, sessionCache.buildProjectsFromCache(false));
    assert.deepEqual(views.allProjects, sessionCache.buildProjectsFromCache(true));

    const ids = (list, p) => list.find(x => x.projectPath === p).sessions.map(s => s.sessionId);
    assert.deepEqual(ids(views.projects, PROJECT), ['live']);
    assert.deepEqual(ids(views.allProjects, PROJECT), ['live', 'old-archived', 'kid', 'parent']);
    // a project whose every session is archived stays listed by its on-disk folder, empty
    assert.deepEqual(ids(views.projects, ALL_ARCHIVED), []);
    assert.deepEqual(ids(views.allProjects, ALL_ARCHIVED), ['gone']);
  });
});

test('both views come from one read of the cache and share their session objects', () => {
  withCache((cachedReads) => {
    const views = sessionCache.buildProjectViewsFromCache();
    assert.equal(cachedReads(), 1);
    const live = views.projects.find(p => p.projectPath === PROJECT).sessions[0];
    const liveAll = views.allProjects.find(p => p.projectPath === PROJECT).sessions.find(s => s.sessionId === 'live');
    assert.equal(live, liveAll);
  });
});

test('the get-projects handler answers both views from one build', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('get-projects'");
  const handler = src.slice(start, src.indexOf("ipcMain.handle('get-stats'", start));
  assert.equal((handler.match(/buildProjectViewsFromCache\(\)/g) || []).length, 1);
  assert.doesNotMatch(handler, /buildProjectsFromCache\(/);
});

// ---- renderer: skip an unchanged render -----------------------------------------

const T0 = Date.parse('2026-10-01T10:00:10.000Z');

function project(overrides = {}) {
  return {
    projectPath: '/home/dev/skip',
    folder: '-home-dev-skip',
    sessions: [
      { sessionId: 's1', summary: 'first', modified: new Date(T0).toISOString(), messageCount: 3, archived: 0, starred: 0 },
      { sessionId: 's2', summary: 'second', modified: new Date(T0 - 5000).toISOString(), messageCount: 1, archived: 0, starred: 0 },
      { sessionId: 'k1', parentSessionId: 's1', agentId: 'k1', subagentType: 'explore', description: 'k1', modified: new Date(T0 - 1000).toISOString(), messageCount: 1 },
      { sessionId: 'k2', parentSessionId: 's1', agentId: 'k2', subagentType: 'explore', description: 'k2', modified: new Date(T0 - 2000).toISOString(), messageCount: 1 },
    ],
    ...overrides,
  };
}

function clone(p) {
  return JSON.parse(JSON.stringify(p));
}

function withSidebar(fn) {
  const ctx = setupSidebarDom();
  ctx.window.Date.now = () => T0 + 20000;
  try {
    return fn(ctx);
  } finally {
    ctx.destroy();
  }
}

test('an unchanged reload does not rebuild the sidebar', () => {
  withSidebar((ctx) => {
    const { renderProjects } = ctx.sidebar;
    assert.equal(renderProjects([project()], false), true);
    const item = ctx.document.getElementById('si-s1');
    assert.ok(item);
    assert.equal(renderProjects([clone(project())], false, { skipIfUnchanged: true }), false);
    assert.equal(ctx.document.getElementById('si-s1'), item);
  });
});

test('a session bumped within the same minute, or reordered by it, does not rebuild', () => {
  withSidebar((ctx) => {
    const { renderProjects } = ctx.sidebar;
    renderProjects([project()], false);
    const bumped = project();
    bumped.sessions[1].modified = new Date(T0 + 1000).toISOString();
    bumped.sessions = [bumped.sessions[1], bumped.sessions[0], ...bumped.sessions.slice(2)];
    assert.equal(renderProjects([bumped], false, { skipIfUnchanged: true }), false);
  });
});

test('every displayed change rebuilds the sidebar', () => {
  const changes = {
    'a title': (p) => { p.sessions[0].summary = 'renamed'; },
    'a name': (p) => { p.sessions[0].name = 'named'; },
    'a message count': (p) => { p.sessions[0].messageCount = 4; },
    'a modified minute': (p) => { p.sessions[1].modified = new Date(T0 + 60000).toISOString(); },
    'a star': (p) => { p.sessions[1].starred = 1; },
    'an archive flag': (p) => { p.sessions[1].archived = 1; },
    'a status': (p) => { p.sessions[0].status = 'busy'; },
    'a new session': (p) => { p.sessions.push({ sessionId: 's3', summary: 'third', modified: new Date(T0).toISOString(), messageCount: 0 }); },
    'a removed session': (p) => { p.sessions.splice(1, 1); },
    'the subagent order': (p) => { p.sessions = [p.sessions[0], p.sessions[1], p.sessions[3], p.sessions[2]]; },
    'a missing flag': (p) => { p.missing = true; },
  };
  for (const [label, change] of Object.entries(changes)) {
    withSidebar((ctx) => {
      const { renderProjects } = ctx.sidebar;
      renderProjects([project()], false);
      const next = project();
      change(next);
      assert.equal(renderProjects([next], false, { skipIfUnchanged: true }), true, label);
    });
  }
});

test('renderer state the sidebar shows, a new minute, or a resort all rebuild', () => {
  withSidebar((ctx) => {
    const { renderProjects } = ctx.sidebar;
    renderProjects([project()], false);
    ctx.window.activePtyIds = new Set(['s2']);
    assert.equal(renderProjects([project()], false, { skipIfUnchanged: true }), true, 'running set');
    ctx.setActivity('s2', true);
    assert.equal(renderProjects([project()], false, { skipIfUnchanged: true }), true, 'busy state');
    assert.equal(renderProjects([project()], false, { skipIfUnchanged: true }), false, 'settled');
    ctx.window.showStarredOnly = true;
    assert.equal(renderProjects([project()], false, { skipIfUnchanged: true }), true, 'filter');
    assert.equal(renderProjects([project()], true, { skipIfUnchanged: true }), true, 'resort');
    ctx.window.Date.now = () => T0 + 120000;
    assert.equal(renderProjects([project()], false, { skipIfUnchanged: true }), true, 'next minute');
  });
});

test('without the skip option every call renders', () => {
  withSidebar((ctx) => {
    const { renderProjects } = ctx.sidebar;
    renderProjects([project()], false);
    assert.equal(renderProjects([project()], false), true);
  });
});
