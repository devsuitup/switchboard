// Regression coverage for PR #137 review Finding 1 — grid-view.js and
// sidebar.js are both loaded as classic (non-module) <script> tags sharing
// one global scope (index.html:129 grid-view.js, :133 sidebar.js — sidebar
// loads AFTER grid-view). Before the fix, both files declared a top-level
// `function pruneStaleSubagents()`. In non-module script scope, the later
// declaration wins on the shared global object, so the name that
// grid-view.js's wrapInGridCard() actually calls resolved to sidebar.js's
// implementation (operating on sidebar's own activeSubagentsByParent map) —
// silently disabling the TTL prune of grid-view's own `activeSubagents` map.
// Consequence: a subagent pill on a grid card would stay "running" forever
// if the parent PTY died before the matching subagent-completed event.
//
// This suite evaluates grid-view.js then sidebar.js in that exact real
// load order (mirroring the reviewer's jsdom+vm repro) and drives the real
// wrapInGridCard() call site end to end, so it exercises whichever function
// is actually bound to the shared global name — not a direct reference to
// grid-view's own function.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

// Loads grid-view.js then sidebar.js in the same jsdom+vm context, in the
// real index.html script order, with the union of stubs both files need.
function setupCombinedDom() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="sidebar-content"></div><div id="stats-content"></div>' +
    '<div id="memory-content"></div><div id="placeholder"></div><div id="terminals"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;

  // window.api.onSubagentSpawned/Completed is called once per file (grid-view.js
  // AND sidebar.js each register their own listener) — real ipcRenderer.on()
  // supports multiple independent listeners per event, so capture an array
  // and fire every registered callback on emit, not just the last one.
  const spawnedCbs = [];
  const completedCbs = [];
  const apiTarget = {
    onSubagentSpawned: (cb) => { spawnedCbs.push(cb); },
    onSubagentCompleted: (cb) => { completedCbs.push(cb); },
  };
  window.api = new Proxy(apiTarget, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => Promise.resolve({ ok: true });
    },
  });

  const stubGlobals = {
    // Shared by grid-view.js and sidebar.js
    openSessions: new Map(),
    activeSessionId: null,
    sessionMap: new Map(),
    activePtyIds: new Set(),
    sortedOrder: [],
    cachedProjects: [],
    confirmAndStopSession: () => {},
    showSession: () => {},

    // grid-view.js only
    sidebarContent: window.document.getElementById('sidebar-content'),
    terminalsEl: window.document.getElementById('terminals'),
    gridViewActive: false,
    isMac: false,
    replayHiddenBuffer: () => {},
    updateRunningIndicators: () => {},
    fitAndScroll: () => {},

    // sidebar.js only
    statsContent: window.document.getElementById('stats-content'),
    memoryContent: window.document.getElementById('memory-content'),
    pendingSessions: new Map(),
    lastActivityTime: new Map(),
    searchMatchIds: null,
    searchMatchProjectPaths: null,
    showStarredOnly: false,
    showRunningOnly: false,
    showTodayOnly: false,
    visibleSessionCount: 10,
    sessionMaxAgeDays: 3650,
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    cachedAllProjects: [],
    pollActiveSessions: () => {},
    showNewSessionPopover: () => {},
    openSettingsViewer: () => {},
    showResumeSessionDialog: () => {},
    showJsonlViewer: () => {},
    forkSession: () => {},
    openSession: () => {},
    loadProjects: () => {},
    launchScheduleCreator: () => {},
    getExpandedSlugs: () => new Set(),
    saveExpandedSlugs: () => {},
  };

  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const MORPHDOM_PATH = path.join(__dirname, '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.js');
  const morphdomSrc = fs.readFileSync(MORPHDOM_PATH, 'utf8');
  vm.runInContext(morphdomSrc, dom.getInternalVMContext(), { filename: 'morphdom-umd.js' });

  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'icons.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'shortcuts.js'));
  // Real index.html order: grid-view.js (index.html:129) before sidebar.js (:133).
  evalInWindow(dom, path.join(PUBLIC_DIR, 'grid-view.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'sidebar.js'));

  return {
    window,
    document: window.document,
    emitSubagentSpawned(payload) { for (const cb of spawnedCbs) cb(payload); },
    emitSubagentCompleted(payload) { for (const cb of completedCbs) cb(payload); },
    destroy() { window.close(); },
  };
}

function openSession(ctx, sessionId) {
  const element = ctx.document.createElement('div');
  ctx.window.openSessions.set(sessionId, { closed: false, element, terminal: { focus: () => {} } });
  ctx.window.sessionMap.set(sessionId, {
    sessionId,
    name: 'parent session',
    projectPath: '/home/dev/proj',
    modified: '2026-05-22T10:00:00.000Z',
  });
}

test('grid-view + sidebar loaded together (real index.html order): a stale grid subagent is still pruned by TTL, not shadowed by sidebar\'s same-purpose function', () => {
  const ctx = setupCombinedDom();
  try {
    openSession(ctx, 'parent-1');
    ctx.window.wrapInGridCard('parent-1');
    ctx.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore' });

    const cardsBefore = ctx.document.querySelectorAll('.grid-card[data-session-id="parent-1"]');
    assert.equal(cardsBefore[cardsBefore.length - 1].querySelectorAll('.grid-subagent-pill').length, 1,
      'pill renders right after spawn');

    // 61s later, no subagent-completed ever arrived (parent PTY died mid-run).
    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 61000;

    // The real production call site: wrapInGridCard() calls
    // pruneStaleGridSubagents() then updateGridSubagentPills() on re-wrap
    // (e.g. re-entering grid view). This is the exact path the shadowed
    // name broke — it must purge grid-view's OWN activeSubagents map, not
    // sidebar's activeSubagentsByParent map.
    ctx.window.wrapInGridCard('parent-1');

    const cardsAfter = ctx.document.querySelectorAll('.grid-card[data-session-id="parent-1"]');
    const latestCard = cardsAfter[cardsAfter.length - 1];
    assert.equal(latestCard.querySelectorAll('.grid-subagent-pill').length, 0,
      'stale subagent must be pruned from the grid\'s own map — a same-named prune in sidebar.js must not shadow it');
  } finally {
    ctx.destroy();
  }
});
