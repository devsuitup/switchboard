'use strict';

// loadProjects re-injects a session that has no transcript yet. A launched
// remote session must go back under its own host's project, never under a
// local project that happens to have the same path.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const ID = '3f2a9c10-7b1d-4e55-9a60-0123456789ab';

function run(projects, pendingSession, pendingFolder) {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    window.loadingStatus = window.document.createElement('div');
    window.reportActivityFocus = () => {};
    window.reportActivityTitles = () => {};
    window.pollActiveSessions = async () => {};
    window.refreshSidebar = () => {};
    window.renderDefaultStatus = () => {};
    window.encodeProjectPath = (p) => p.replace(/\//g, '-');
    window.api = {
      getProjects: async () => JSON.parse(JSON.stringify(projects)),
      getActiveTerminals: async () => [],
    };
    window.cachedProjects = [];
    window.cachedAllProjects = [];
    window.pendingSessions.set(ID, { session: pendingSession, projectPath: pendingSession.projectPath, folder: pendingFolder });
    const fns = loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects'] });
    return fns.loadProjects().then(() => JSON.parse(JSON.stringify({
      cached: window.cachedProjects,
      all: window.cachedAllProjects,
    })));
  } finally {
    ctx.destroy();
  }
}

const LOCAL = { folder: '-srv-app', projectPath: '/srv/app', sessions: [] };
const REMOTE = { folder: 'box::-srv-app', projectPath: '/srv/app', remoteAlias: 'box', sessions: [] };
const remoteSession = { sessionId: ID, projectPath: '/srv/app', remoteAlias: 'box', summary: 'New session' };

test('a pending remote session is re-injected under the remote project, not the local one with the same path', async () => {
  const { cached, all } = await run([LOCAL, REMOTE], remoteSession, 'box::-srv-app');
  for (const list of [cached, all]) {
    assert.deepEqual(list.find(p => !p.remoteAlias).sessions, []);
    assert.deepEqual(list.find(p => p.remoteAlias === 'box').sessions.map(s => s.sessionId), [ID]);
  }
});

test('with only a local project at that path, the pending remote session gets its own remote entry', async () => {
  const { cached } = await run([LOCAL], remoteSession, 'box::-srv-app');
  assert.deepEqual(cached.find(p => !p.remoteAlias).sessions, []);
  const created = cached.find(p => p.remoteAlias === 'box');
  assert.equal(created.folder, 'box::-srv-app');
  assert.deepEqual(created.sessions.map(s => s.sessionId), [ID]);
});

test('a pending local session still lands under the local project', async () => {
  const local = { sessionId: ID, projectPath: '/srv/app', summary: 'New session' };
  const { cached } = await run([LOCAL, REMOTE], local, '-srv-app');
  assert.deepEqual(cached.find(p => !p.remoteAlias).sessions.map(s => s.sessionId), [ID]);
  assert.deepEqual(cached.find(p => p.remoteAlias === 'box').sessions, []);
});
