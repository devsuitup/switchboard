'use strict';

// see .ai/contexts/session-cache.md ("Projects query worker")
const { parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const cache = require('../session-cache');
const { applySessionName, establishTranscriptBaseline } = require('../session-name');
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');

const readSnapshot = db.transaction(() => ({
  rows: db.prepare('SELECT * FROM session_cache').all(),
  meta: db.prepare(`SELECT m.*, f.source AS nameSource, f.revision AS nameRevision, f.transcriptTitle AS nameTranscriptTitle FROM session_meta m
    LEFT JOIN session_meta_fields f ON f.sessionId = m.sessionId AND f.field = 'name'`).all(),
  folders: db.prepare('SELECT * FROM cache_meta').all(),
  settings: db.prepare('SELECT key, value FROM settings').all(),
}));

function build(message) {
  const data = readSnapshot();
  const rows = new Map(data.rows.map(row => [row.sessionId, row]));
  const meta = new Map(data.meta.map(row => [row.sessionId, row]));
  const folders = new Map(data.folders.map(row => [row.folder, row]));
  const settings = new Map(data.settings.map(row => {
    let value = row.value;
    try { value = JSON.parse(value); } catch {}
    return [row.key, value];
  }));
  const effects = [];
  const adapter = {
    getAllCached: () => [...rows.values()],
    getCachedByFolder: folder => [...rows.values()].filter(row => row.folder === folder),
    getAllMeta: () => meta,
    getMeta: id => meta.get(id),
    getAllFolderMeta: () => folders,
    getFolderMeta: folder => folders.get(folder),
    getSetting: key => settings.get(key) ?? null,
    isInitialScanComplete: () => settings.get('initial_scan_complete') === true,
  };
  const writers = {
    upsertCachedSessions: sessions => {
      for (const row of sessions) {
        const cachedEntry = rows.get(row.sessionId);
        const previous = meta.get(row.sessionId);
        const next = establishTranscriptBaseline(previous, row);
        rows.set(row.sessionId, { ...cachedEntry, ...row });
        if (next !== previous) meta.set(row.sessionId, next);
      }
    },
    deleteCachedSession: id => rows.delete(id),
    deleteCachedFolder: folder => { for (const row of rows.values()) if (row.folder === folder) rows.delete(row.sessionId); },
    touchCachedModified: (id, modified) => { const row = rows.get(id); if (row) Object.assign(row, { modified, fileMtime: modified }); },
    setFolderMeta: (folder, projectPath, indexMtimeMs) => folders.set(folder, { folder, projectPath, indexMtimeMs }),
    setName: (id, name, source = 'user') => {
      const previous = meta.get(id);
      meta.set(id, applySessionName(previous, id, name, source, rows.get(id)?.customTitle ?? null));
    },
    replaceSessionMetrics: () => {},
    deleteSearchFolder: () => {},
    deleteSearchSession: () => {},
    upsertSearchEntries: () => {},
  };
  for (const [name, write] of Object.entries(writers)) {
    adapter[name] = (...args) => {
      effects.push({ name, args: structuredClone(args) });
      return write(...args);
    };
  }
  cache.init({
    PROJECTS_DIR: workerData.projectsDir,
    activeSessions: new Map(message.activeSessions || []),
    getLocalDescriptors: () => message.localDescriptors || [],
    getLocalJobs: () => new Map(message.localJobs || []),
    getMainWindow: () => null,
    log: console,
    db: adapter,
  });
  cache.setRemoteRoots(new Map(message.remoteRoots || []));
  cache.resetProjectsWorkerRetainedRows();
  let publishedLiveRows = new Map();
  const reconciled = !!message.reconcile && adapter.isInitialScanComplete();
  if (reconciled) cache.reconcileCacheFromFilesystem({ throttle: false, onFolder: () => {
    const keptLiveRows = cache.getProjectsWorkerRetainedRows();
    const liveRowsChanged = keptLiveRows.length !== publishedLiveRows.size
      || keptLiveRows.some(([id, folder]) => publishedLiveRows.get(id) !== folder);
    if (!effects.length && !liveRowsChanged) return;
    parentPort.postMessage({ id: message.id, progress: { effects: effects.splice(0), keptLiveRows } });
    publishedLiveRows = new Map(keptLiveRows);
  } });
  const defaultProjects = cache.buildProjectsFromCache(false);
  const allProjects = cache.buildProjectsFromCache(true);
  const replyBytes = message.measureBytes ? {
    default: Buffer.byteLength(JSON.stringify(defaultProjects)),
    all: Buffer.byteLength(JSON.stringify(allProjects)),
    both: Buffer.byteLength(JSON.stringify({ defaultProjects, allProjects })),
  } : null;
  return { defaultProjects, allProjects, effects, keptLiveRows: cache.getProjectsWorkerRetainedRows(), rows: rows.size, reconciled, replyBytes };
}

parentPort.on('message', message => {
  try {
    parentPort.postMessage({ id: message.id, result: build(message) });
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: error.message });
  }
});
