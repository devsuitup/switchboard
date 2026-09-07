'use strict';

// Issue #201 acceptance: a declared host, mirrored by a fake transport, must
// produce rows keyed `<alias>::<folder>` that reach the sidebar, the search
// index and the heatmap — and a machine with no host declared must behave
// exactly as before.
//
// better-sqlite3 is compiled against Electron's ABI and cannot be required
// under plain node:test (see test/db-daily-activity.test.js), so the DB layer
// is the usual capture fake. The heatmap is asserted at that boundary: its
// queries (db.js getDailyActivity / getDailyMetrics) read session_cache and
// session_metrics with no folder predicate, so a row written there is counted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { syncMirror } = require('../remote-mirror');
const { encodeProjectPath } = require('../encode-project-path');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-' + name + '-'));
}

function transcript(cwd, sessionId, text, extra = {}) {
  const ts = '2026-09-06T10:00:00.000Z';
  return [
    JSON.stringify({ type: 'user', cwd, sessionId, timestamp: ts, ...extra, message: { role: 'user', content: text } }),
    JSON.stringify({
      type: 'assistant', cwd, sessionId, timestamp: ts, ...extra,
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ack ' + text }], usage: { input_tokens: 5, output_tokens: 7 } },
    }),
  ].join('\n') + '\n';
}

function captureDb() {
  const captured = {
    upserts: [], searchEntries: [], metrics: [], folderMeta: new Map(),
    deletedFolders: [], names: [],
  };
  return {
    captured,
    db: {
      deleteCachedFolder: (f) => captured.deletedFolders.push(f),
      getCachedByFolder: () => [],
      upsertCachedSessions: (rows) => captured.upserts.push(...rows),
      touchCachedModified: () => {},
      deleteCachedSession: () => {},
      replaceSessionMetrics: (sessionId, dailyMetrics) => captured.metrics.push({ sessionId, dailyMetrics }),
      deleteSearchFolder: () => {},
      deleteSearchSession: () => {},
      upsertSearchEntries: (entries) => captured.searchEntries.push(...entries),
      setFolderMeta: (folder, projectPath, indexMtimeMs) => captured.folderMeta.set(folder, { projectPath, indexMtimeMs }),
      getFolderMeta: (f) => captured.folderMeta.get(f) || null,
      getAllFolderMeta: () => captured.folderMeta,
      getAllMeta: () => new Map(),
      getAllCached: () => captured.upserts,
      getSetting: () => ({}),
      getMeta: () => null,
      setName: (id, name) => captured.names.push({ id, name }),
      isInitialScanComplete: () => true,
      setInitialScanComplete: () => {},
    },
  };
}

/** Fake host holding two projects, one of them with a subagent transcript. */
function fakeHost() {
  const files = {
    '-srv-supervision/11111111-1111-4111-8111-111111111111.jsonl': {
      content: transcript('/srv/supervision', '11111111-1111-4111-8111-111111111111', 'ripcord protocol'),
      mtimeMs: 1000,
    },
    '-srv-supervision/11111111-1111-4111-8111-111111111111/subagents/agent-7.jsonl': {
      // isSidechain is what read-session-file.js requires to accept a file under
      // subagents/ as a real subagent transcript.
      content: transcript('/srv/supervision', '11111111-1111-4111-8111-111111111111', 'subagent leg', { isSidechain: true }),
      mtimeMs: 1100,
    },
    '-srv-orchestration/22222222-2222-4222-8222-222222222222.jsonl': {
      content: transcript('/srv/orchestration', '22222222-2222-4222-8222-222222222222', 'board sweep'),
      mtimeMs: 2000,
    },
  };
  return {
    files,
    async listFiles() {
      return Object.entries(files).map(([rel, f]) => ({ rel, size: f.content.length, mtimeMs: f.mtimeMs }));
    },
    async fetchFiles(alias, rels, destRoot) {
      for (const rel of rels) {
        const dest = path.join(destRoot, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, files[rel].content, 'utf8');
      }
      return { fetched: [...rels], failed: [] };
    },
  };
}

test('a mirrored host lands in the sidebar, the search index and the heatmap under its alias', async () => {
  const dataDir = tmp('e2e');
  const localProjects = tmp('e2e-local');
  try {
    const { captured, db } = captureDb();
    sessionCache.init({
      PROJECTS_DIR: localProjects,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info() {}, warn() {}, error() {} },
      db,
    });

    const projectsDir = path.join(dataDir, 'remote', 'planificator', 'projects');
    const manifestPath = path.join(dataDir, 'remote', 'planificator', 'inventory.json');
    fs.mkdirSync(projectsDir, { recursive: true });

    const host = fakeHost();
    const sync = await syncMirror({ alias: 'planificator', transport: host, projectsDir, manifestPath });
    assert.equal(sync.fetched, 3);
    assert.deepEqual([...sync.changedFolders].sort(), ['-srv-orchestration', '-srv-supervision']);

    sessionCache.setRemoteRoots(new Map([['planificator', projectsDir]]));
    const scan = await sessionCache.scanFoldersViaWorker({
      projectsDir, folderPrefix: 'planificator', folders: [...sync.changedFolders],
    });
    assert.equal(scan.ok, true, scan.error);

    // --- rows: every folder key carries the alias -----------------------------
    assert.ok(captured.upserts.length >= 3, 'parent + subagent + second project');
    for (const row of captured.upserts) {
      assert.match(row.folder, /^planificator::-srv-/, `row folder must be prefixed, got ${row.folder}`);
    }
    const parent = captured.upserts.find(r => r.sessionId === '11111111-1111-4111-8111-111111111111');
    assert.equal(parent.folder, 'planificator::-srv-supervision');
    assert.equal(parent.projectPath, '/srv/supervision');
    assert.ok(captured.upserts.some(r => r.parentSessionId === '11111111-1111-4111-8111-111111111111'),
      'the subagent transcript is indexed too');

    // --- search ---------------------------------------------------------------
    const hit = captured.searchEntries.find(e => (e.body || '').includes('ripcord protocol'));
    assert.ok(hit, 'the remote transcript body is offered to the FTS index');
    assert.equal(hit.folder, 'planificator::-srv-supervision');

    // --- heatmap --------------------------------------------------------------
    const metric = captured.metrics.find(m => m.sessionId === '11111111-1111-4111-8111-111111111111');
    assert.ok(metric && metric.dailyMetrics.length > 0, 'per-day metrics are written for the remote session');
    assert.equal(metric.dailyMetrics[0].date, '2026-09-06');

    // --- sidebar --------------------------------------------------------------
    const projects = sessionCache.buildProjectsFromCache(false);
    const remote = projects.find(p => p.projectPath === '/srv/supervision');
    assert.ok(remote, 'the remote project appears in the sidebar');
    assert.equal(remote.folder, 'planificator::' + encodeProjectPath('/srv/supervision'));
    assert.equal(remote.remoteAlias, 'planificator');
    assert.equal(remote.missing, false, 'a remote root must never be flagged missing');
    assert.ok(remote.sessions.every(s => s.remoteAlias === 'planificator'));
  } finally {
    sessionCache.setRemoteRoots(new Map());
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(localProjects, { recursive: true, force: true });
  }
});

test('two hosts sharing one absolute project path stay two sidebar groups', () => {
  const localProjects = tmp('e2e-collide');
  try {
    const { captured, db } = captureDb();
    captured.upserts.push(
      { sessionId: 'a', folder: 'alpha::-srv-app', projectPath: '/srv/app', modified: '2026-09-06T10:00:00.000Z', messageCount: 1 },
      { sessionId: 'b', folder: 'beta::-srv-app', projectPath: '/srv/app', modified: '2026-09-06T11:00:00.000Z', messageCount: 1 },
      { sessionId: 'c', folder: encodeProjectPath('/srv/app'), projectPath: '/srv/app', modified: '2026-09-06T12:00:00.000Z', messageCount: 1 },
    );
    sessionCache.init({
      PROJECTS_DIR: localProjects, activeSessions: new Map(), getMainWindow: () => null,
      log: { info() {}, warn() {}, error() {} }, db,
    });
    sessionCache.setRemoteRoots(new Map());

    const groups = sessionCache.buildProjectsFromCache(false).filter(p => p.projectPath === '/srv/app');

    assert.equal(groups.length, 3, 'alpha, beta and the local one are distinct groups');
    assert.deepEqual(groups.map(g => String(g.remoteAlias)).sort(), ['alpha', 'beta', 'null']);
  } finally {
    sessionCache.setRemoteRoots(new Map());
    fs.rmSync(localProjects, { recursive: true, force: true });
  }
});

test('with no remote root the scan and the sidebar are byte-identical to before', async () => {
  const localProjects = tmp('e2e-local-only');
  try {
    const { captured, db } = captureDb();
    sessionCache.init({
      PROJECTS_DIR: localProjects, activeSessions: new Map(), getMainWindow: () => null,
      log: { info() {}, warn() {}, error() {} }, db,
    });
    sessionCache.setRemoteRoots(new Map());

    const folder = encodeProjectPath(localProjects);
    fs.mkdirSync(path.join(localProjects, folder), { recursive: true });
    fs.writeFileSync(
      path.join(localProjects, folder, '33333333-3333-4333-8333-333333333333.jsonl'),
      transcript(localProjects, '33333333-3333-4333-8333-333333333333', 'local work'), 'utf8'
    );

    const scan = await sessionCache.scanFoldersViaWorker({ projectsDir: localProjects, folders: [folder] });
    assert.equal(scan.ok, true, scan.error);

    for (const row of captured.upserts) {
      assert.ok(!row.folder.includes('::'), `a local row must stay unprefixed, got ${row.folder}`);
    }
    const projects = sessionCache.buildProjectsFromCache(false);
    const local = projects.find(p => p.projectPath === localProjects);
    assert.ok(local);
    assert.equal(local.folder, folder);
    assert.equal(local.remoteAlias, null);
    assert.equal(local.missing, false);
  } finally {
    fs.rmSync(localProjects, { recursive: true, force: true });
  }
});
