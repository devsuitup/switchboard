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
const { joinFolderKey } = require('../src/main/remote/remote-hosts');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-hidden-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeFakeDb({ cachedRows = [], folderMeta = new Map(), hiddenProjects = [], hiddenProjectScopes = {} } = {}) {
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
    getSetting: (key) => (key === 'global' ? { hiddenProjects, hiddenProjectScopes } : {}),
    getMeta: () => null,
    setName: () => {},
  };
}

function initCache(projectsDir, db, extra = {}) {
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    db,
    ...extra,
  });
  sessionCache.setRemoteRoots(new Map());
}

test('a project pass builds one hidden matcher across rows, placeholders, terminals and background descriptors', t => {
  const projectsDir = mkTmp();
  t.after(() => cleanup(projectsDir));
  const projectPath = '/srv/visible';
  const folder = encodeProjectPath(projectPath);
  fs.mkdirSync(path.join(projectsDir, folder));
  const hiddenPath = '/srv/hidden';
  let reads = 0;
  const hiddenProjectScopes = { get [hiddenPath]() { reads++; return { alias: null }; } };
  const descriptors = [1, 2].map(i => ({ kind: 'bg', jobId: '0000000' + i,
    sessionId: `00000000-0000-4000-8000-00000000000${i}`, cwd: '/srv/background-' + i }));
  const db = makeFakeDb({ hiddenProjects: [hiddenPath], hiddenProjectScopes,
    cachedRows: Array.from({ length: 10 }, (_, i) => row('visible-' + i, folder, projectPath)),
    folderMeta: new Map([[folder, { projectPath }], [joinFolderKey('box', folder), { projectPath: '/srv/empty' }]]) });
  initCache(projectsDir, db, { getLocalDescriptors: () => descriptors,
    activeSessions: new Map([['terminal', { isPlainTerminal: true, projectPath: '/srv/terminal', _openedAt: 0 }]]) });
  sessionCache.setRemoteRoots(new Map([['box', projectsDir]]));
  for (let pass = 0; pass < 2; pass++) {
    reads = 0;
    const projects = sessionCache.buildProjectsFromCache(true);
    assert.equal(projects.find(p => p.projectPath === projectPath).sessions.length, 10);
    for (const expected of ['/srv/empty', '/srv/terminal', ...descriptors.map(d => d.cwd)]) {
      assert.ok(projects.some(p => p.projectPath === expected), 'pass must exercise ' + expected);
    }
    assert.equal(reads, 1, 'one project pass must read each hidden scope once, including the background merge');
  }
});

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

test('scoped local delete keeps same-path remote cache rows and empty groups', () => {
  const projectsDir = mkTmp();
  try {
    const projectPath = '/srv/scoped';
    const folder = encodeProjectPath(projectPath);
    fs.mkdirSync(path.join(projectsDir, folder));
    const db = makeFakeDb({ hiddenProjects: [projectPath], hiddenProjectScopes: { [projectPath]: { alias: null } },
      cachedRows: [row('local', folder, projectPath), row('remote', joinFolderKey('box', folder), projectPath)],
      folderMeta: new Map([[joinFolderKey('empty', folder), { projectPath }]]) });
    initCache(projectsDir, db);
    sessionCache.setRemoteRoots(new Map([['empty', projectsDir]]));
    assert.deepEqual(sessionCache.buildProjectsFromCache(true).filter(p => p.projectPath === projectPath).map(p => p.remoteAlias).sort(),
      ['box', 'empty'], 'local scope must preserve remote rows and empty folder metadata');
  } finally { cleanup(projectsDir); }
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
