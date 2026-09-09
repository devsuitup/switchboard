// Hiding a remote project group must not hide a different group (local, or a
// different host) that happens to share the same projectPath. See
// isProjectHidden in session-cache.js and the alias-qualified hidden entry
// written by remove-project in main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { joinFolderKey } = require('../remote-hosts');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-hidden-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeFakeDb({ cachedRows = [], folderMeta = new Map(), hiddenProjects = [] } = {}) {
  return {
    deleteCachedFolder: () => {},
    getCachedByFolder: () => [],
    upsertCachedSessions: () => {},
    touchCachedModified: () => {},
    deleteCachedSession: () => {},
    replaceSessionMetrics: () => {},
    deleteSearchFolder: () => {},
    deleteSearchSession: () => {},
    upsertSearchEntries: () => {},
    setFolderMeta: () => {},
    getAllFolderMeta: () => folderMeta,
    getAllMeta: () => new Map(),
    getAllCached: () => cachedRows,
    getSetting: (key) => (key === 'global' ? { hiddenProjects } : {}),
    getMeta: () => null,
    setName: () => {},
  };
}

function initCache(projectsDir, db) {
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    db,
  });
  sessionCache.setRemoteRoots(new Map());
}

function row(sessionId, folder, projectPath) {
  return {
    sessionId, folder, projectPath, summary: sessionId, firstPrompt: sessionId,
    modified: '2024-03-15T10:00:00.000Z', created: '2024-03-15T10:00:00.000Z',
    messageCount: 1, parentSessionId: null, agentId: null, subagentType: null,
    description: null, slug: null, aiTitle: null,
  };
}

test('hiding <alias>::<path> hides only that host group, not local or a different alias sharing the path', () => {
  const projectsDir = mkTmp();
  try {
    const projectPath = '/srv/x';
    const bareFolder = encodeProjectPath(projectPath);
    fs.mkdirSync(path.join(projectsDir, bareFolder));

    const cachedRows = [
      row('local-s', bareFolder, projectPath),
      row('planificator-s', joinFolderKey('planificator', bareFolder), projectPath),
      row('otherhost-s', joinFolderKey('otherhost', bareFolder), projectPath),
    ];

    const db = makeFakeDb({ cachedRows, hiddenProjects: ['planificator::' + projectPath] });
    initCache(projectsDir, db);

    const projects = sessionCache.buildProjectsFromCache(true);
    const relevant = projects.filter(p => p.projectPath === projectPath);
    const aliases = relevant.map(p => p.remoteAlias).sort();

    assert.deepEqual(aliases, [null, 'otherhost'],
      `only the planificator group should be hidden; got groups for: ${aliases.join(', ')}`);
  } finally {
    cleanup(projectsDir);
  }
});

test('hiding a bare path (legacy entry) still hides it on every host', () => {
  const projectsDir = mkTmp();
  try {
    const projectPath = '/srv/y';
    const bareFolder = encodeProjectPath(projectPath);
    fs.mkdirSync(path.join(projectsDir, bareFolder));

    const cachedRows = [
      row('local-s', bareFolder, projectPath),
      row('remote-s', joinFolderKey('planificator', bareFolder), projectPath),
    ];

    const db = makeFakeDb({ cachedRows, hiddenProjects: [projectPath] });
    initCache(projectsDir, db);

    const projects = sessionCache.buildProjectsFromCache(true);
    const relevant = projects.filter(p => p.projectPath === projectPath);

    assert.equal(relevant.length, 0,
      'a bare legacy hidden entry must still hide the project on every host');
  } finally {
    cleanup(projectsDir);
  }
});

test('an empty remote project directory (no sessions yet) is hidden only for the alias named in the hidden entry', () => {
  const projectsDir = mkTmp();
  const remoteDir = mkTmp();
  try {
    const projectPath = '/srv/z';
    const bareFolder = encodeProjectPath(projectPath);
    fs.mkdirSync(path.join(remoteDir, bareFolder));

    const folderMeta = new Map([
      [joinFolderKey('planificator', bareFolder), { projectPath }],
      [joinFolderKey('otherhost', bareFolder), { projectPath }],
    ]);

    const db = makeFakeDb({ cachedRows: [], folderMeta, hiddenProjects: ['planificator::' + projectPath] });
    initCache(projectsDir, db);
    sessionCache.setRemoteRoots(new Map([
      ['planificator', remoteDir],
      ['otherhost', remoteDir],
    ]));

    const projects = sessionCache.buildProjectsFromCache(true);
    const relevant = projects.filter(p => p.projectPath === projectPath);
    const aliases = relevant.map(p => p.remoteAlias).sort();

    assert.deepEqual(aliases, ['otherhost'],
      `only the planificator group should be hidden; got groups for: ${aliases.join(', ')}`);
  } finally {
    cleanup(projectsDir);
    cleanup(remoteDir);
  }
});
