'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

function row(sessionId, bridgeSessionId) {
  return {
    sessionId, folder: '-tmp-proj', projectPath: '/tmp/proj', summary: sessionId, firstPrompt: '',
    created: '2026-09-01T10:00:00.000Z', modified: '2026-09-01T10:00:00.000Z', messageCount: 1,
    slug: null, aiTitle: null, parentSessionId: null, bridgeSessionId, mergedIntoSessionId: null,
  };
}

test('a cached session reaches the renderer payload with its bridgeSessionId, or null without one', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-id-'));
  try {
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      db: {
        isInitialScanComplete: () => true,
        getAllFolderMeta: () => new Map(),
        getAllMeta: () => new Map(),
        getAllCached: () => [row('with', 'cse_0189wicjnQ3j6mppaWVWuntM'), row('without', null)],
        getSetting: () => ({}),
        getMeta: () => null,
        getFolderMeta: () => null,
        setFolderMeta: () => {},
      },
    });
    const [project] = sessionCache.buildProjectsFromCache(false);
    const byId = Object.fromEntries(project.sessions.map((s) => [s.sessionId, s]));
    assert.equal(byId.with.bridgeSessionId, 'cse_0189wicjnQ3j6mppaWVWuntM');
    assert.equal(byId.without.bridgeSessionId, null);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
