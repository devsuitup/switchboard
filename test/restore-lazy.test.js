// see .ai/contexts/session-cache.md ("Restore on click")

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions, extractFunction } = require('./app-source');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PROJECT = '/home/dev/proj';
const OLD = '2020-01-01T00:00:00Z';
const SAVED = [
  { sessionId: 'a', projectPath: PROJECT, active: false },
  { sessionId: 'x', projectPath: PROJECT, active: true },
  { sessionId: 'b', projectPath: PROJECT, active: false },
];

function setup({ savedSet = SAVED, liveElsewhere = {}, confirmAnswer = false, openResult = { ok: true }, mode = 'lazy', livePtys = [], recent = true } = {}) {
  const ctx = setupSidebarDom();
  const { window, context } = ctx;
  const run = (code) => vm.runInContext(code, context);
  for (const f of ['resume-guard.js', 'restore-plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), context, { filename: f });
  }

  const settings = { global: { restoreOnStartup: mode, openWorkingSet: savedSet } };
  const openTerminalCalls = [];
  const openTerminalOptions = [];
  const live = { ptys: livePtys };
  const confirms = [];
  const gridFocused = [];
  Object.assign(window.api, {
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
    getSessionLiveElsewhere: async (id) => liveElsewhere[id] || null,
    getSessionsLiveElsewhere: async () => ({}),
    getActiveSessions: async () => live.ptys.map(sessionId => ({ sessionId, busy: false })),
    deleteSession: async () => ({ ok: true }),
    openTerminal: async (sessionId, _projectPath, _isNew, options) => {
      openTerminalCalls.push(sessionId);
      openTerminalOptions.push(options);
      return typeof openResult === 'function' ? openResult(sessionId, options) : openResult;
    },
  });
  window.confirm = (msg) => { confirms.push(msg); return confirmAnswer; };

  const project = {
    projectPath: PROJECT,
    sessions: [
      ...(recent ? ['n1', 'n2', 'n3'] : []).map((id, i) => ({ sessionId: id, name: id, modified: new Date(Date.now() - i * 1000).toISOString(), messageCount: 1 })),
      ...savedSet.map(({ sessionId }) => ({ sessionId, name: sessionId, modified: OLD, messageCount: 1 })),
    ],
  };
  window.cachedProjects = [project];
  window.cachedAllProjects = [project];
  window.visibleSessionCount = 2;
  window.sessionMaxAgeDays = 30;
  let sidebarRefreshes = 0;
  Object.assign(window, {
    refreshSidebar: () => { sidebarRefreshes++; window.renderProjects(window.cachedProjects, true); },
    createTerminalEntry: (session) => {
      const entry = { session, closed: false, terminal: { write() {}, focus() {} }, initialSize: {} };
      window.openSessions.set(session.sessionId, entry);
      return entry;
    },
    showSession: (id) => { run(`activeSessionId = ${JSON.stringify(id)}`); },
    destroySession: (id) => { window.openSessions.delete(id); },
    resolveDefaultSessionOptions: async () => ({}),
    resolveResumeSession: async (session) => session,
    syncPtySizeAfterOpen: () => {},
    setSessionMcpState: () => {},
    setSessionSandboxed: () => {},
    forgetSessionExit: () => {},
    beginPtyOpen: () => {},
    settlePtyOpen: () => {},
    schedulePersistWorkingSet: () => {},
    pollActiveSessions: () => {},
    showColdCacheNotice: () => {},
    showNotRestoredNotice: () => {},
    runRestore: async () => { throw new Error('lazy restore must not resume anything'); },
    showDeleteSessionDialog: async () => true,
    stopBeforeArchive: async () => ({ ok: true }),
    loadProjects: () => {},
    focusGridCard: (id) => { gridFocused.push(id); },
    SETTING_DEFAULTS,
  });

  const fns = loadAppFunctions(context, {
    declarations: ['restoringWorkingSet', 'restorePlanner', 'restoreMode', 'restoreIndexingDone',
      'sessionOpenedOutsideRestore', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight',
      'dormantWorkingSet', '_persistChain', 'openingSessions', 'continuationRetryCancelled', 'exitingApp', 'persistSkippedWhileExiting'],
    functions: ['dismissDormantSession', 'persistWorkingSet', 'pendingRestoreEntries', 'tickRestorePlanner', 'openSession', 'openSessionNow',
      'reopenActiveSessionAfterReload'],
  });
  const gridSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'grid-view.js'), 'utf8');
  vm.runInContext(['var gridViewActive = false;', 'var gridFocusedSessionId = null;',
    'var isMac = false;', 'var appShortcuts = {};', 'function matchShortcut(name, e) { return e.shortcut === name; }',
    extractFunction(gridSrc, 'getOrderedOpenSessionIds'), extractFunction(gridSrc, 'navigateSession'),
    extractFunction(gridSrc, 'handleSessionNavKey')].join('\n'), context);
  context.savedSet = savedSet;
  run(`
    restoreMode = 'lazy';
    restoreSavedIndex = new Map(savedSet.map((item, index) => [item.sessionId, index]));
    restorePlanner = createRestorePlanner({ savedSet });
  `);

  return {
    window, settings, openTerminalCalls, openTerminalOptions, confirms, gridFocused, fns, run,
    index: (ids) => {
      for (const id of ids) {
        const item = savedSet.find((i) => i.sessionId === id);
        window.sessionMap.set(id, { sessionId: id, projectPath: item.projectPath });
      }
    },
    sidebarRefreshes: () => sidebarRefreshes,
    setLivePtys: (ids) => { live.ptys = ids; },
    open: (id) => fns.openSession(window.sessionMap.get(id)),
    dormantIds: () => [...run('[...dormantWorkingSet.keys()]')].sort(),
    savedIds: () => settings.global.openWorkingSet.map((i) => i.sessionId),
    row: (id) => window.document.getElementById('si-' + id),
    destroy: () => ctx.destroy(),
  };
}

test('lazy: the saved sessions are marked dormant and none is resumed', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.openTerminalCalls, []);
    assert.deepEqual(h.dormantIds(), ['a', 'b', 'x']);
    assert.equal(h.sidebarRefreshes(), 1);
  } finally { h.destroy(); }
});

test('lazy: dormant sessions stay in the persisted working set at their saved place', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
    assert.ok(h.settings.global.openWorkingSet.every((i) => i.active === false));
  } finally { h.destroy(); }
});

test('lazy: opening a dormant session resumes only that one and keeps the others', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    await h.open('x');
    assert.deepEqual(h.openTerminalCalls, ['x']);
    assert.deepEqual(h.dormantIds(), ['a', 'b']);
    assert.equal(h.row('x').classList.contains('dormant'), false, 'the row loses its mark without waiting for a render');
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
    assert.equal(h.settings.global.openWorkingSet.find((i) => i.sessionId === 'x').active, true);
  } finally { h.destroy(); }
});

test('lazy: a dormant session live elsewhere stays dormant and saved when the user refuses to resume it', async () => {
  const h = setup({ liveElsewhere: { x: { pid: 4242 } }, confirmAnswer: false });
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    await h.open('x');
    assert.equal(h.confirms.length, 1, 'the user is asked before resuming a session live elsewhere');
    assert.deepEqual(h.openTerminalCalls, []);
    assert.deepEqual(h.dormantIds(), ['a', 'b', 'x']);
    assert.ok(h.row('x').classList.contains('dormant'));
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
  } finally { h.destroy(); }
});

test('lazy: a dormant session whose terminal fails to open stays dormant and saved', async () => {
  const h = setup({ openResult: { ok: false, error: 'spawn failed' } });
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    await h.open('x');
    assert.deepEqual(h.openTerminalCalls, ['x']);
    assert.deepEqual(h.dormantIds(), ['a', 'b', 'x']);
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
  } finally { h.destroy(); }
});

test('lazy: a session opened during a cold index does not stop the rest from being marked', async () => {
  const h = setup();
  try {
    h.index(['a']);
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.dormantIds(), ['a']);
    await h.open('a');
    h.index(['x', 'b']);
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.dormantIds(), ['b', 'x']);
    assert.deepEqual(h.openTerminalCalls, ['a']);
  } finally { h.destroy(); }
});

test('lazy sidebar: dormant rows are marked and stay visible past the visible count and the age limit', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    for (const id of ['a', 'x', 'b']) {
      const row = h.row(id);
      assert.ok(row, `${id} is rendered`);
      assert.ok(row.classList.contains('dormant'), `${id} is marked dormant`);
      assert.equal(row.closest('.sessions-older'), null, `${id} is not folded under "older"`);
    }
    assert.ok(h.row('n3').closest('.sessions-older'), 'a non-dormant row past the visible count is folded');
  } finally { h.destroy(); }
});

test('lazy sidebar: "Don\'t restore" drops a dormant session from the working set without starting it', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    const { document } = h.window;
    h.window.sessionMap.set('n1', { sessionId: 'n1', projectPath: PROJECT });
    h.window.refreshSidebar();
    h.row('n1').dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    assert.ok(document.querySelector('.session-context-menu'), 'the menu of a row that is not dormant opens');
    assert.equal(document.querySelector('.session-dismiss-dormant-btn'), null, 'and has no "Don\'t restore" item');
    h.window.closeSessionContextMenu();

    h.row('x').dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    const dismiss = document.querySelector('.session-dismiss-dormant-btn');
    assert.ok(dismiss, 'the menu of a dormant row offers "Don\'t restore"');
    dismiss.click();
    await h.window.eval('_persistChain');
    assert.deepEqual(h.openTerminalCalls, []);
    assert.deepEqual(h.dormantIds(), ['a', 'b']);
    assert.deepEqual(h.savedIds(), ['a', 'b']);
    assert.equal(h.row('x').classList.contains('dormant'), false);
  } finally { h.destroy(); }
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('lazy: saved sessions not indexed yet stay in the saved set when it is persisted during the cold index', async () => {
  const h = setup();
  try {
    h.index(['a']);
    await h.fns.tickRestorePlanner();
    h.window.sessionMap.set('n1', { sessionId: 'n1', projectPath: PROJECT });
    await h.open('n1');
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b', 'n1'], 'x and b, still unindexed, are kept');

    h.index(['x', 'b']);
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.dormantIds(), ['a', 'b', 'x']);
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b', 'n1']);
  } finally { h.destroy(); }
});

test('lazy: a renderer reload reattaches the remembered session only while its PTY still runs', async () => {
  for (const { mode, livePtys, expected } of [
    { mode: 'lazy', livePtys: [], expected: [] },
    { mode: 'lazy', livePtys: ['x'], expected: ['x'] },
    { mode: 'auto', livePtys: [], expected: ['x'] },
  ]) {
    const h = setup({ mode, livePtys });
    try {
      h.index(['a', 'x', 'b']);
      h.run('activeSessionId = "x"');
      await h.fns.reopenActiveSessionAfterReload();
      assert.deepEqual(h.openTerminalCalls, expected, `${mode}, live PTYs ${JSON.stringify(livePtys)}`);
    } finally { h.destroy(); }
  }
});

test('lazy sidebar: a project collapsed for its age opens to show its dormant rows', async () => {
  const h = setup({ recent: false });
  try {
    h.index(['a', 'x', 'b']);
    h.window.renderProjects(h.window.cachedProjects, true);
    const header = () => h.row('x').closest('.project-sessions').previousElementSibling;
    assert.ok(header().classList.contains('collapsed'), 'collapsed for its age before the restore');
    await h.fns.tickRestorePlanner();
    assert.equal(header().classList.contains('collapsed'), false);
    h.window.refreshSidebar();
    assert.equal(header().classList.contains('collapsed'), false, 'and stays open on the next render');
  } finally { h.destroy(); }
});

test('lazy sidebar: deleting a dormant session drops it from the saved set', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    h.row('x').querySelector('.session-delete-btn').click();
    await settle();
    await h.window.eval('_persistChain');
    assert.deepEqual(h.dormantIds(), ['a', 'b']);
    assert.deepEqual(h.savedIds(), ['a', 'b']);
    assert.deepEqual(h.openTerminalCalls, []);
  } finally { h.destroy(); }
});

test('lazy: keyboard navigation reaches dormant rows and opens them, except in the grid', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    await h.open('x');
    for (let i = 0; i < 2; i++) {
      h.run('navigateSession(1)');
      for (let j = 0; j < 5; j++) await settle();
    }
    assert.deepEqual([...h.openTerminalCalls].sort(), ['a', 'b', 'x']);
    assert.deepEqual(h.dormantIds(), []);

    const g = setup();
    try {
      g.index(['a', 'x', 'b']);
      await g.fns.tickRestorePlanner();
      await g.open('x');
      g.run('gridViewActive = true; gridFocusedSessionId = "x"');
      g.run('navigateSession(1)');
      await settle();
      assert.deepEqual(g.openTerminalCalls, ['x']);
      assert.deepEqual(g.gridFocused, ['x'], 'the grid has no card for a dormant session');
    } finally { g.destroy(); }
  } finally { h.destroy(); }
});

test('lazy: a reload whose PTY exits before the reattach asks main for a reattach only, and leaves the session dormant', async () => {
  const h = setup({ livePtys: ['x'], openResult: { ok: false, notLive: true } });
  try {
    h.index(['a', 'x', 'b']);
    h.run('activeSessionId = "x"');
    await h.fns.reopenActiveSessionAfterReload();
    assert.deepEqual(h.openTerminalCalls, ['x']);
    assert.equal(h.openTerminalOptions[0].reattachOnly, true, 'main is told not to spawn');
    assert.equal(h.window.openSessions.has('x'), false, 'no terminal is left behind');
    h.setLivePtys([]);
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.dormantIds(), ['a', 'b', 'x']);
  } finally { h.destroy(); }
});

test('main refuses to spawn for a reattach-only open when no PTY is live', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = MAIN.indexOf("ipcMain.handle('open-terminal'");
  const reattach = MAIN.indexOf('ok: true, reattached: true', start);
  const refuse = MAIN.indexOf('if (sessionOptions?.reattachOnly) return { ok: false, notLive: true };', start);
  const spawn = MAIN.indexOf('// Spawn new PTY', start);
  assert.ok(start > 0 && reattach > start && refuse > reattach && spawn > refuse,
    'the refusal sits after the reattach of a live PTY and before anything is started');
  const remote = MAIN.indexOf('remoteAttachAdapter.attach(', start);
  assert.ok(remote > refuse, 'and before a remote attach');
});

test('lazy: a session whose PTY still runs after a reload is reattached, not marked dormant', async () => {
  const h = setup({ livePtys: ['a'] });
  try {
    h.index(['a', 'x', 'b']);
    h.run('activeSessionId = "x"');
    h.window.createTerminalEntry({ sessionId: 'x', projectPath: PROJECT });
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.openTerminalCalls, ['a']);
    assert.equal(h.openTerminalOptions[0].reattachOnly, true);
    assert.deepEqual(h.dormantIds(), ['b']);
    assert.equal(h.run('activeSessionId'), 'x', 'the selected session stays selected');
  } finally { h.destroy(); }
});

test('lazy: a running session whose PTY exits before the reattach is marked dormant', async () => {
  const h = setup({ livePtys: ['a'], openResult: { ok: false, notLive: true } });
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.openTerminalCalls, ['a']);
    assert.deepEqual(h.dormantIds(), ['a', 'b', 'x']);
    assert.equal(h.window.openSessions.has('a'), false);
  } finally { h.destroy(); }
});

test('lazy: a held or repeated next-session key opens a dormant session once', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    await h.open('x');
    h.run('navigateSession(1); navigateSession(1);');
    for (let j = 0; j < 5; j++) await settle();
    assert.equal(h.openTerminalCalls.length, 2, JSON.stringify(h.openTerminalCalls));
    assert.equal(new Set(h.openTerminalCalls).size, 2);
  } finally { h.destroy(); }
});

const WORKTREE = PROJECT + '/.claude/worktrees/wt1';

function setupGroups({ recent = true } = {}) {
  const savedSet = [...SAVED, { sessionId: 'w', projectPath: WORKTREE, active: false }];
  const h = setup({ savedSet, recent });
  const project = h.window.cachedProjects[0];
  project.sessions = project.sessions.filter((s) => s.sessionId !== 'w');
  for (const s of project.sessions) if (s.sessionId === 'x') s.slug = 'sl';
  project.sessions.push({ sessionId: 'x2', name: 'x2', slug: 'sl', modified: OLD, messageCount: 1 });
  const worktree = { projectPath: WORKTREE, sessions: [{ sessionId: 'w', name: 'w', modified: OLD, messageCount: 1 }] };
  h.window.cachedProjects = [project, worktree];
  h.window.cachedAllProjects = [project, worktree];
  h.window.renderProjects(h.window.cachedProjects, true);
  return h;
}

test('lazy sidebar: a dormant session in a slug group or a worktree is shown, past the visible count and the age limit', async () => {
  const h = setupGroups();
  try {
    const slugGroup = () => h.row('x').closest('.slug-group');
    const wtHeader = () => h.row('w').closest('.worktree-sessions').previousElementSibling;
    assert.ok(slugGroup().classList.contains('collapsed'), 'the slug group starts folded');
    assert.ok(wtHeader().classList.contains('collapsed'), 'the worktree is collapsed for its age');
    h.index(['a', 'x', 'b', 'w']);
    await h.fns.tickRestorePlanner();
    assert.equal(slugGroup().classList.contains('collapsed'), false);
    assert.equal(slugGroup().closest('.sessions-older'), null, 'the slug group is not folded under "older"');
    assert.equal(wtHeader().classList.contains('collapsed'), false);
  } finally { h.destroy(); }
});

test('lazy sidebar: a group built again after the marking shows its dormant rows', async () => {
  const h = setupGroups({ recent: false });
  try {
    h.index(['a', 'x', 'b', 'w']);
    await h.fns.tickRestorePlanner();
    const projects = h.window.cachedProjects;
    h.window.renderProjects([], true);
    assert.equal(h.row('x'), null);
    h.window.renderProjects(projects, true);
    const header = h.row('a').closest('.project-sessions').previousElementSibling;
    assert.equal(header.classList.contains('collapsed'), false, 'project');
    assert.equal(h.row('x').closest('.slug-group').classList.contains('collapsed'), false, 'slug group');
    assert.equal(h.row('w').closest('.worktree-sessions').previousElementSibling.classList.contains('collapsed'), false, 'worktree');
  } finally { h.destroy(); }
});

test('lazy: a key held down cycles the open sessions and resumes no dormant one', async () => {
  const h = setup({ savedSet: [...SAVED, { sessionId: 'c', projectPath: PROJECT, active: false }] });
  try {
    h.index(['a', 'x', 'b', 'c']);
    await h.fns.tickRestorePlanner();
    await h.open('x');
    await h.open('c');
    h.run('navigateSession(1, { repeat: true }); navigateSession(1, { repeat: true });');
    for (let j = 0; j < 5; j++) await settle();
    assert.deepEqual(h.openTerminalCalls, ['x', 'c'], 'no dormant row is resumed by an auto-repeat');
    assert.deepEqual(h.dormantIds(), ['a', 'b']);
    assert.equal(h.run('activeSessionId'), 'c', 'two repeats from c go to x and back');
  } finally { h.destroy(); }
});

test('lazy: a persist while a running session is being reattached keeps the candidates not handled yet', async () => {
  let release;
  const h = setup({ livePtys: ['a'], openResult: () => new Promise((resolve) => { release = () => resolve({ ok: true, reattached: true }); }) });
  try {
    h.index(['a', 'x', 'b']);
    const ticking = h.fns.tickRestorePlanner();
    for (let j = 0; j < 5; j++) await settle();
    assert.ok(release, 'the reattach of a is in flight');
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
    release();
    await ticking;
    assert.deepEqual(h.dormantIds(), ['b', 'x']);
    assert.equal(h.run('restoreInFlight.size'), 0);
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
  } finally { h.destroy(); }
});

test('lazy: a dormant session that fails to open from the keyboard is logged, not an unhandled rejection', async () => {
  const h = setup({ openResult: (id) => (id === 'b' ? Promise.reject(new Error('pty spawn failed')) : { ok: true }) });
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  const logged = [];
  h.window.console.error = (...args) => logged.push(args.join(' '));
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    await h.open('x');
    h.run('navigateSession(1)');
    for (let j = 0; j < 10; j++) await settle();
    assert.deepEqual(unhandled, []);
    assert.ok(logged.some((line) => line.includes('pty spawn failed')), JSON.stringify(logged));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    h.destroy();
  }
});

test('lazy: a dormant session whose conversation continues under another id is opened there, and the old id is neither dormant nor saved', async () => {
  const h = setup();
  try {
    h.index(['a', 'x', 'b']);
    await h.fns.tickRestorePlanner();
    h.window.resolveResumeSession = async (session) => (session.sessionId === 'a' ? { ...session, sessionId: 'a2' } : session);
    await h.open('a');
    assert.deepEqual(h.openTerminalCalls, ['a2']);
    assert.deepEqual(h.dormantIds(), ['b', 'x']);
    assert.equal(h.row('a').classList.contains('dormant'), false);
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a2', 'x', 'b']);
  } finally { h.destroy(); }

  const failed = setup({ openResult: { ok: false, error: 'spawn failed' } });
  try {
    failed.index(['a', 'x', 'b']);
    await failed.fns.tickRestorePlanner();
    failed.window.resolveResumeSession = async (session) => (session.sessionId === 'a' ? { ...session, sessionId: 'a2' } : session);
    await failed.open('a');
    assert.deepEqual(failed.dormantIds(), ['a2', 'b', 'x'], 'a continuation that fails to open stays marked under its new id');
    await failed.fns.persistWorkingSet();
    assert.deepEqual(failed.savedIds(), ['a2', 'x', 'b']);
  } finally { failed.destroy(); }
});

test('lazy: a session the user opens while the marking awaits a reattach is not marked dormant', async () => {
  for (const stage of ['opened', 'opening', 'checking']) {
    const releases = {};
    const h = setup({ livePtys: ['a'], openResult: (id) => new Promise((resolve) => { releases[id] = () => resolve({ ok: true, reattached: id === 'a' }); }) });
    try {
      h.index(['a', 'x', 'b']);
      let check;
      if (stage === 'checking') h.window.api.getSessionLiveElsewhere = (id) => (id === 'b' ? new Promise((resolve) => { check = () => resolve(null); }) : Promise.resolve(null));
      const ticking = h.fns.tickRestorePlanner();
      for (let j = 0; j < 5; j++) await settle();
      const opening = h.open('b');
      for (let j = 0; j < 5; j++) await settle();
      if (stage === 'opened') { releases.b(); await opening; }
      releases.a();
      for (let j = 0; j < 5; j++) await settle();
      if (stage === 'checking') { check(); for (let j = 0; j < 5; j++) await settle(); }
      if (stage !== 'opened') { releases.b(); await opening; }
      await ticking;
      assert.deepEqual(h.dormantIds(), ['x'], stage);
      assert.equal(h.row('b').classList.contains('dormant'), false, stage);
    } finally { h.destroy(); }
  }
});

test('lazy: a click during the reattach-only open of the same session opens it when no PTY is left', async () => {
  let release;
  const h = setup({
    livePtys: ['a'],
    openResult: (_id, options) => (options.reattachOnly ? new Promise((resolve) => { release = () => resolve({ ok: false, notLive: true }); }) : { ok: true }),
  });
  try {
    h.index(['a', 'x', 'b']);
    const ticking = h.fns.tickRestorePlanner();
    for (let j = 0; j < 5; j++) await settle();
    const click = h.open('a');
    release();
    await ticking;
    await click;
    assert.deepEqual(h.openTerminalCalls, ['a', 'a']);
    assert.equal(h.openTerminalOptions[1].reattachOnly, undefined, 'the click resumes it');
    assert.equal(h.window.openSessions.has('a'), true);
    assert.deepEqual(h.dormantIds(), ['b', 'x']);
  } finally { h.destroy(); }
});

test('lazy: the session keys pass an auto-repeat on, so a held key resumes no dormant one', async () => {
  for (const key of [{ shortcut: 'sessionNavBrackets', code: 'BracketRight' }, { shortcut: 'sessionNavArrows', key: 'ArrowRight' }]) {
    const h = setup({ savedSet: [...SAVED, { sessionId: 'c', projectPath: PROJECT, active: false }] });
    try {
      h.index(['a', 'x', 'b', 'c']);
      await h.fns.tickRestorePlanner();
      await h.open('x');
      await h.open('c');
      const e = { ...key, type: 'keydown', repeat: true, preventDefault() {} };
      h.window.handleSessionNavKey(e);
      h.window.handleSessionNavKey(e);
      for (let j = 0; j < 5; j++) await settle();
      assert.deepEqual(h.openTerminalCalls, ['x', 'c'], key.shortcut);
    } finally { h.destroy(); }
  }
});

test('lazy: a running session is reattached under its own id, not a continuation\'s', async () => {
  const h = setup({ livePtys: ['a', 'x'], openResult: { ok: true, reattached: true } });
  try {
    h.index(['a', 'x', 'b']);
    h.window.resolveResumeSession = async (session) => ({ ...session, sessionId: session.sessionId + '2' });
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.openTerminalCalls, ['a', 'x']);
    h.window.openSessions.clear();
    h.run('activeSessionId = "x"');
    await h.fns.reopenActiveSessionAfterReload();
    assert.deepEqual(h.openTerminalCalls, ['a', 'x', 'x'], 'and so after a reload');
  } finally { h.destroy(); }
});

test('lazy: a saved session with no transcript yet is neither started nor kept dormant', async () => {
  const savedSet = [...SAVED, { sessionId: 'f', projectPath: PROJECT, active: false, fresh: true }];
  const h = setup({ savedSet });
  try {
    h.index(['a', 'x', 'b']);
    h.window.sessionMap.delete('f');
    h.run('restoreIndexingDone = true');
    await h.fns.tickRestorePlanner();
    assert.deepEqual(h.openTerminalCalls, []);
    assert.deepEqual(h.dormantIds(), ['a', 'b', 'x']);
    await h.fns.persistWorkingSet();
    assert.deepEqual(h.savedIds(), ['a', 'x', 'b']);
  } finally { h.destroy(); }
});
