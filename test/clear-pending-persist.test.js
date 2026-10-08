'use strict';

// see docs/session-restore.md ("A session with no transcript yet")

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const PROJECT = { folder: '-srv-app', projectPath: '/srv/app', sessions: [] };

function setup() {
  const ctx = setupSidebarDom();
  const { window } = ctx;
  const settings = { global: { openWorkingSet: [] } };
  let persists = 0;
  let projects = [PROJECT];
  Object.assign(window, {
    loadingStatus: window.document.createElement('div'),
    reportActivityFocus: () => {},
    reportActivityTitles: () => {},
    pollActiveSessions: async () => {},
    refreshSidebar: () => {},
    renderDefaultStatus: () => {},
    encodeProjectPath: (p) => p.replace(/\//g, '-'),
    schedulePersistWorkingSet: () => { persists += 1; },
    pendingRestoreEntries: () => [],
  });
  window.api = {
    getProjects: async () => JSON.parse(JSON.stringify(projects)),
    getActiveTerminals: async () => [],
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
  };
  window.cachedProjects = [];
  window.cachedAllProjects = [];
  const fns = loadAppFunctions(ctx.context, {
    functions: ['dedup', 'loadProjects', 'persistWorkingSet'],
    declarations: ['_persistChain', 'skippedWorkingSetEntries'],
  });
  const open = (sessionId, { pending }) => {
    const session = { sessionId, projectPath: '/srv/app', summary: 'New session' };
    window.openSessions.set(sessionId, { session, closed: false });
    if (pending) window.pendingSessions.set(sessionId, { session, projectPath: '/srv/app', folder: '-srv-app' });
  };
  return {
    ...fns, open, settings,
    persists: () => persists,
    setProjects: (list) => { projects = list; },
    saved: () => settings.global.openWorkingSet.map((e) => e.sessionId),
    destroy: () => ctx.destroy(),
  };
}

test('a session with no transcript yet, after /clear or from +, is not saved: there is nothing to resume', async () => {
  const h = setup();
  try {
    h.open('real', { pending: false });
    h.open('cleared', { pending: true });
    await h.persistWorkingSet();
    assert.deepEqual(h.saved(), ['real']);
  } finally { h.destroy(); }
});

test('its first prompt makes it real, and the set is saved again with it', async () => {
  const h = setup();
  try {
    h.open('cleared', { pending: true });
    await h.loadProjects();
    assert.equal(h.persists(), 0, 'still pending');
    h.setProjects([{ ...PROJECT, sessions: [{ sessionId: 'cleared', projectPath: '/srv/app' }] }]);
    await h.loadProjects();
    assert.equal(h.persists(), 1);
    await h.persistWorkingSet();
    assert.deepEqual(h.saved(), ['cleared']);
  } finally { h.destroy(); }
});
