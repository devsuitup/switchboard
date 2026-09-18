// buildProjectsFromCache injects live plain-terminal PTYs as sidebar rows so
// they participate in sorting. A panel shell is a plain terminal, so without an
// explicit exclusion it is injected too and reaches the sidebar as a session of
// its own — see .ai/contexts/panel-terminal.md ("A panel shell is not a
// session").
//
// The jsdom renderer harnesses cannot catch this: they never run
// buildProjectsFromCache, and the row the sidebar draws comes from this
// payload, not from the renderer's own session object.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

function initCache(projectsDir, activeSessions) {
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions,
    getMainWindow: () => null,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    db: {
      isInitialScanComplete: () => true,
      setInitialScanComplete: () => {},
      deleteCachedFolder: () => {}, getCachedByFolder: () => [],
      upsertCachedSessions: () => {}, touchCachedModified: () => {},
      deleteCachedSession: () => {}, replaceSessionMetrics: () => {},
      deleteSearchFolder: () => {}, deleteSearchSession: () => {},
      upsertSearchEntries: () => {},
      setFolderMeta: () => {}, getFolderMeta: () => null,
      getAllFolderMeta: () => new Map(),
      getAllMeta: () => new Map(),
      getAllCached: () => [],
      getSetting: () => ({}),
      getMeta: () => null,
      setName: () => {},
    },
  });
}

const OWNER_ID = 'a31c9ebc-916c-4da5-abcc-42bc60d4dafd';
const PANEL_ID = 'panel:' + OWNER_ID;
const PROJECT = '/tmp/switchboard-bpps/tools/switchboard';

function terminalSession(extra = {}) {
  return {
    exited: false,
    isPlainTerminal: true,
    projectPath: PROJECT,
    _openedAt: Date.now(),
    ...extra,
  };
}

function allSessions(projects) {
  return projects.flatMap((p) => p.sessions);
}

function withCache(activeSessions, fn) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bpps-'));
  try {
    initCache(projectsDir, activeSessions);
    return fn();
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
}

test('a panel shell is not injected as a session row (mutation target: dropping the isPanelShellSession filter)', () => {
  const active = new Map([
    [OWNER_ID, terminalSession()],
    [PANEL_ID, terminalSession({ panelFor: OWNER_ID })],
  ]);

  const rows = withCache(active, () => allSessions(sessionCache.buildProjectsFromCache(false)));

  assert.deepEqual(rows.map((s) => s.sessionId), [OWNER_ID],
    'the shell the panel owns has no sidebar row of its own');
  assert.equal(rows.length, 1,
    'a second row here also inflates the status bar’s session count, which reads this payload');
});

test('an ordinary terminal is still injected — the filter must not swallow the row it exists to add', () => {
  const active = new Map([[OWNER_ID, terminalSession()]]);

  const rows = withCache(active, () => allSessions(sessionCache.buildProjectsFromCache(false)));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, OWNER_ID);
  assert.equal(rows[0].type, 'terminal');
  assert.equal(rows[0].projectPath, PROJECT);
});

test('a panel shell alone leaves the project it runs in out of the sidebar entirely', () => {
  const active = new Map([[PANEL_ID, terminalSession({ panelFor: OWNER_ID })]]);

  const projects = withCache(active, () => sessionCache.buildProjectsFromCache(false));

  assert.deepEqual(allSessions(projects).map((s) => s.sessionId), []);
  assert.equal(projects.some((p) => p.projectPath === PROJECT), false,
    'a shell must not conjure a project group either — the injection creates one when missing');
});

test('an exited panel shell is excluded by the exited check, whichever runs first', () => {
  const active = new Map([[PANEL_ID, terminalSession({ panelFor: OWNER_ID, exited: true })]]);

  const rows = withCache(active, () => allSessions(sessionCache.buildProjectsFromCache(false)));
  assert.deepEqual(rows, []);
});

// The predicate is shared with get-active-terminals rather than re-tested as a
// string prefix: keying on the id spelling here would pass while the real
// session object carries panelFor, and diverge the moment the id shape changes.
test('the exclusion keys on the session object, not on the "panel:" id spelling', () => {
  const oddId = 'shell-for-' + OWNER_ID;
  const active = new Map([[oddId, terminalSession({ panelFor: OWNER_ID })]]);

  const rows = withCache(active, () => allSessions(sessionCache.buildProjectsFromCache(false)));
  assert.deepEqual(rows, [],
    'panelFor is what makes a PTY a panel shell — see panel-terminal-target.js');
});

// --- The status bar reads this same payload ---------------------------------
// "N running" and "N sessions" come from two different sources, and only one of
// them was wrong. Pinning both here keeps the pair from drifting apart again.

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function renderDefaultStatusBody() {
  const start = APP_SRC.indexOf('function renderDefaultStatus()');
  assert.notEqual(start, -1);
  return APP_SRC.slice(start, APP_SRC.indexOf('\n}', start));
}

test('public/app.js: the session total counts the get-projects payload, which is what the injected row inflates', () => {
  assert.match(renderDefaultStatusBody(), /cachedAllProjects\.reduce\(/,
    'totalSessions is summed over the cached projects, so a phantom row there is a phantom session in the status bar');
});

test('public/app.js: "N running" goes through runningSessionCount, not activePtyIds.size (mutation target: counting the raw set)', () => {
  const body = renderDefaultStatusBody();
  assert.match(body, /const running = runningSessionCount\(\);/,
    'a panel shell is in activePtyIds by design — the LRU needs it there — so the count must filter');
  assert.doesNotMatch(body, /activePtyIds\.size/);

  const start = APP_SRC.indexOf('function runningSessionCount()');
  assert.notEqual(start, -1);
  assert.match(APP_SRC.slice(start, APP_SRC.indexOf('\n}', start)), /countSessionsWithoutPanelShells\(activePtyIds\)/);
});
