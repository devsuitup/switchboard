'use strict';

// see .ai/contexts/session-cache.md (Startup indexing worker)
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const cache = require('../session-cache');
const { getFolderIndexMtimeMs } = require('../folder-index-state');
const { parseFolderKey, joinFolderKey } = require('../remote-hosts');
const { readSessionDisplayHeader, readSessionEntrypoint, resolveJsonlPath } = require('../read-session-file');
const { validId } = require('../session-continuations');
const { readFolderFileSubsetFromFilesystem } = require('./scan-projects');
const { boundedEffects } = require('../index-effect-batches');
const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const readMeta = db.prepare('SELECT * FROM session_meta WHERE sessionId = ?');
let sequence = 0;
const replies = new Map();

function ask(id, message) {
  return new Promise(resolve => {
    const serial = ++sequence;
    replies.set(serial, resolve);
    parentPort.postMessage({ id, sequence: serial, ...message });
  });
}

function prepare(folder, state, projectsDir, folderPrefix, recovery) {
  const data = db.transaction(() => ({
    rows: db.prepare('SELECT * FROM session_cache WHERE folder = ?').all(folder),
    meta: db.prepare('SELECT * FROM session_meta WHERE sessionId IN (SELECT sessionId FROM session_cache WHERE folder = ?)').all(folder),
    folder: db.prepare('SELECT * FROM cache_meta WHERE folder = ?').get(folder),
    settings: db.prepare('SELECT key, value FROM settings').all(),
    search: db.prepare('SELECT id, type FROM search_map WHERE folder = ?').all(folder),
  }))();
  const rows = new Map(data.rows.map(row => [row.sessionId, row]));
  if (!recovery.base) recovery.base = structuredClone(rows);
  for (const [id, written] of recovery.written) {
    const current = rows.get(id);
    if (!current || !Object.entries(written).every(([key, value]) => !(key in current)
      || current[key] === value || (current[key] === null && (value == null || value === '')))) continue;
    if (recovery.base.has(id)) rows.set(id, structuredClone(recovery.base.get(id)));
    else rows.delete(id);
  }
  for (const id of recovery.deleted) if (!rows.has(id) && recovery.base.has(id)) rows.set(id, structuredClone(recovery.base.get(id)));
  const meta = new Map(data.meta.map(row => [row.sessionId, row]));
  const settings = new Map(data.settings.map(row => {
    let value = row.value;
    try { value = JSON.parse(value); } catch {}
    return [row.key, value];
  }));
  let folderMeta = data.folder;
  const effects = [];
  const emit = (name, args) => effects.push({ name, args: structuredClone(args) });
  const adapter = {
    getCachedByFolder: () => [...rows.values()],
    getCachedSession: id => rows.get(id) || null,
    getFolderMeta: () => folderMeta,
    getSetting: key => settings.get(key) ?? null,
    setSetting: (key, value) => { settings.set(key, value); emit('setSetting', [key, value]); },
    getMeta: id => {
      if (!meta.has(id)) meta.set(id, readMeta.get(id) || null);
      return meta.get(id);
    },
    setName: (id, name) => { meta.set(id, { sessionId: id, name }); emit('setName', [id, name]); },
    setFolderMeta: (...args) => { folderMeta = { folder: args[0], projectPath: args[1], indexMtimeMs: args[2] }; emit('setFolderMeta', args); },
    upsertCachedSessions: sessions => {
      for (const session of sessions) {
        rows.set(session.sessionId, { ...rows.get(session.sessionId), ...session });
        const stored = { ...session };
        delete stored.dailyMetrics;
        delete stored.textContent;
        emit('upsertCachedSessions', [[stored]]);
      }
    },
    deleteCachedSession: id => { rows.delete(id); emit('deleteCachedSession', [id]); },
    deleteCachedFolder: key => {
      for (const id of rows.keys()) emit('deleteCachedSession', [id]);
      rows.clear();
      emit('deleteFolderMeta', [key]);
    },
    deleteSearchFolder: () => { for (const entry of data.search) emit('deleteSearchEntry', [entry.type, entry.id]); },
    deleteSearchSession: id => emit('deleteSearchSession', [id]),
    touchCachedModified: (...args) => emit('touchCachedModified', args),
    replaceSessionMetrics: (id, metrics) => {
      emit('replaceSessionMetrics', [id, []]);
      for (const metric of metrics || []) emit('appendSessionMetrics', [id, [metric]]);
    },
    upsertSearchEntries: entries => { for (const entry of entries) emit('upsertSearchEntries', [[entry]]); },
  };
  cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(state.activeSessions), getMainWindow: () => null,
    log: console, db: adapter, skipRepair: true });
  const roots = new Map(state.remoteRoots);
  if (folderPrefix) roots.set(folderPrefix, projectsDir);
  cache.setRemoteRoots(roots);
  cache.resetProjectsWorkerRetainedRows();
  return { effects, rows, adapter, incomplete: settings.get('indexing_incomplete_folders') || [] };
}


async function publish(id, effects, retained, version, accepted = () => {}) {
  effects = boundedEffects(effects);
  let offset = 0;
  do {
    const batch = [];
    let bytes = 0;
    while (offset < effects.length && batch.length < 50) {
      const effect = effects[offset];
      const size = Buffer.byteLength(JSON.stringify(effect));
      if (size > 128 * 1024) throw new Error(`indexing effect exceeds 128 KiB: ${effect.name}`);
      if (bytes + size > 128 * 1024) break;
      bytes += size;
      batch.push(effect);
      offset++;
    }
    const reply = await ask(id, { type: 'batch', effects: batch, keptLiveRows: retained, version, bytes });
    if (!reply.accepted) return false;
    for (const effect of batch) accepted(effect);
    version = reply.version;
  } while (offset < effects.length);
  return true;
}

async function folderJob(message, folder, files) {
  const recovery = { base: null, written: new Map(), deleted: new Set() };
  let fullRepair = false;
  const accepted = effect => {
    if (effect.name === 'upsertCachedSessions') {
      for (const row of effect.args[0]) {
        recovery.written.set(row.sessionId, row);
        recovery.deleted.delete(row.sessionId);
      }
    } else if (effect.name === 'touchCachedModified') {
      const [id, modified, fileMtime = modified] = effect.args;
      recovery.written.set(id, { ...recovery.written.get(id), modified, fileMtime });
    } else if (effect.name === 'appendCachedField') {
      const [id, field, chunk] = effect.args;
      const written = recovery.written.get(id);
      if (written) written[field] = (written[field] || '') + chunk;
    } else if (effect.name === 'deleteCachedSession') {
      recovery.deleted.add(effect.args[0]);
      recovery.written.delete(effect.args[0]);
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state } = await ask(message.id, { type: 'state' });
    const { effects, rows, adapter, incomplete } = prepare(folder, state, message.projectsDir || workerData.projectsDir, message.folderPrefix, recovery);
    if (attempt === 0 && incomplete.includes(folder)) fullRepair = true;
    effects.push({ name: 'setSetting', args: ['indexing_incomplete_folders', [...new Set([...incomplete, folder])]] });
    let count = 0;
    if (message.kind === 'drop') {
      adapter.deleteCachedFolder(folder);
      adapter.deleteSearchFolder(folder);
      const pending = adapter.getSetting('bridge_uuid_reindex_folders');
      if (Array.isArray(pending) && pending.includes(folder)) adapter.setSetting('bridge_uuid_reindex_folders', pending.filter(key => key !== folder));
    } else if (message.kind === 'subset' && !fullRepair) {
      const result = readFolderFileSubsetFromFilesystem(parseFolderKey(folder).folder, files, [...rows.values()], {
        projectsDir: message.projectsDir || workerData.projectsDir,
        folderPrefix: message.folderPrefix ? message.folderPrefix + '::' : '',
      });
      count = cache.writeScannedFolderPartial(result);
    } else if (message.kind === 'refresh' && !fullRepair) cache.refreshFolder(folder, files ? { files: new Set(files) } : {});
    else {
      const result = cache.readFolderFromFilesystem(folder);
      count = cache.writeScannedFolder(result.projectPath ? { ...result, folder,
        indexMtimeMs: getFolderIndexMtimeMs(cache.resolveFolderDir(folder)) } : null,
      !result.projectPath && parseFolderKey(folder).alias === null ? folder : null);
    }
    effects.push({ name: 'setSetting', args: ['indexing_incomplete_folders', incomplete.filter(key => key !== folder)] });
    if (await publish(message.id, effects, cache.getProjectsWorkerRetainedRows(), state.version, accepted)) return count;
  }
  throw new Error('indexing snapshot changed three times');
}

async function backfill(message) {
  const column = message.kind === 'entrypoints' ? 'entrypoint' : 'customTitle';
  let cursor = '';
  let count = 0;
  for (;;) {
    const rows = db.prepare(`SELECT sessionId, folder, fileMtime FROM session_cache WHERE ${column} IS NULL
      AND parentSessionId IS NULL AND sessionId > ? ORDER BY sessionId LIMIT 50`).all(cursor);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].sessionId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { state } = await ask(message.id, { type: 'state' });
      const effects = [];
      for (const row of rows) {
        const { alias, folder } = parseFolderKey(row.folder);
        const root = alias === null ? workerData.projectsDir : new Map(state.remoteRoots).get(alias);
        if (!root || (column === 'customTitle' && (alias !== null || !validId(row.sessionId)))) continue;
        const file = resolveJsonlPath(path.join(root, folder), { ...row, folder: '.' });
        if (column === 'entrypoint') {
          const entrypoint = readSessionEntrypoint(file, { full: true });
          if (entrypoint !== null) effects.push({ name: 'setCachedEntrypoints', args: [[{ sessionId: row.sessionId, entrypoint }]] });
        } else {
          const header = readSessionDisplayHeader(file);
          if (header && (!row.fileMtime || row.fileMtime === header.modified)) effects.push({ name: 'setCachedCustomTitles',
            args: [[{ sessionId: row.sessionId, fileMtime: row.fileMtime, customTitle: header.customTitle || '' }]] });
        }
      }
      if (await publish(message.id, effects, [], state.version)) { count += effects.length; break; }
      if (attempt === 2) throw new Error('backfill snapshot changed three times');
    }
  }
  return { sessions: count, folders: 0 };
}

async function run(message) {
  if (message.kind === 'parent-files') {
    try { return fs.readdirSync(message.projectsDir).filter(file => file.endsWith('.jsonl')); }
    catch { return []; }
  }
  if (message.kind === 'stats') return db.transaction(readStats)();
  if (message.kind === 'folder-keys') return db.prepare('SELECT folder FROM cache_meta').all().map(row => row.folder);
  if (message.kind === 'mirror-folders') {
    try { return fs.readdirSync(message.projectsDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== '.git').map(entry => entry.name); }
    catch { return []; }
  }
  if (message.kind === 'repair') return repair(message);
  if (message.kind === 'entrypoints' || message.kind === 'titles') return backfill(message);
  const root = message.projectsDir || workerData.projectsDir;
  const folders = message.folders || fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== '.git').map(entry => entry.name);
  let sessions = 0;
  for (let i = 0; i < folders.length; i++) {
    const folder = message.folderPrefix ? joinFolderKey(message.folderPrefix, folders[i]) : folders[i];
    const files = message.fileSubsets?.find(([key]) => key === folders[i])?.[1];
    sessions += await folderJob({ ...message, kind: files && message.kind === 'scan' ? 'subset' : message.kind }, folder, files);
    parentPort.postMessage({ id: message.id, type: 'progress', current: i + 1, total: folders.length, sessions });
  }
  return { sessions, folders: folders.length };
}

function readStats() {
  const dailyActivity = db.prepare(`SELECT date, SUM(messageCount) AS messageCount, SUM(toolCallCount) AS toolCallCount,
    SUM(inputTokens + outputTokens) AS tokens, COUNT(DISTINCT sessionId) AS sessionCount
    FROM session_metrics GROUP BY date ORDER BY date ASC`).all();
  const byDate = new Map();
  for (const row of db.prepare(`SELECT date, model, SUM(inputTokens + outputTokens) AS tokens FROM session_metrics
    WHERE model != '' GROUP BY date, model`).all()) {
    if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date, tokensByModel: {} });
    byDate.get(row.date).tokensByModel[row.model] = row.tokens;
  }
  const modelUsage = {};
  for (const row of db.prepare(`SELECT model, SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens
    FROM session_metrics WHERE model != '' GROUP BY model`).all()) modelUsage[row.model] = { inputTokens: row.inputTokens, outputTokens: row.outputTokens };
  const totals = db.prepare(`SELECT SUM(messageCount) AS totalMessages, SUM(toolCallCount) AS totalToolCalls,
    SUM(inputTokens + outputTokens) AS totalTokens FROM session_metrics`).get();
  const sessions = db.prepare('SELECT COUNT(*) AS cnt FROM session_cache WHERE parentSessionId IS NULL AND mergedIntoSessionId IS NULL').get();
  const date = new Date().toISOString().slice(0, 10);
  return { dailyActivity, dailyModelTokens: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), modelUsage,
    totalMessages: totals.totalMessages || 0, totalSessions: sessions.cnt || 0, totalToolCalls: totals.totalToolCalls || 0,
    totalTokens: totals.totalTokens || 0, firstSessionDate: dailyActivity[0]?.date || date, lastComputedDate: date };
}

async function repair(message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state } = await ask(message.id, { type: 'state' });
    const setting = key => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      try { return row ? JSON.parse(row.value) : null; } catch { return null; }
    };
    const effects = [];
    const emit = (name, args) => effects.push({ name, args });
    if (setting('bridge_uuid_index_version') !== 1) {
      const rows = db.prepare("SELECT sessionId, folder FROM session_cache WHERE parentSessionId IS NULL AND bridgeSessionId IS NOT NULL AND bridgeSessionId != ''").all();
      const folders = [...new Set([...(setting('bridge_uuid_reindex_folders') || []), ...rows.map(row => row.folder)])];
      emit('setSetting', ['bridge_uuid_reindex_folders', folders]);
      for (const row of rows) {
        emit('deleteSearchSession', [row.sessionId]);
        emit('deleteCachedSession', [row.sessionId]);
        emit('deleteFolderMeta', [row.folder]);
      }
      emit('setSetting', ['bridge_uuid_index_version', 1]);
    }
    if (setting('bookkeeping_repair_pending') === true) {
      const rows = db.prepare(`SELECT sessionId, folder FROM session_cache WHERE summary LIKE '<command-name>%'
        OR summary LIKE '<command-message>%' OR summary LIKE '<local-command-stdout>%'`).all();
      for (const row of rows) {
        emit('deleteSearchSession', [row.sessionId]);
        emit('deleteCachedSession', [row.sessionId]);
        if (row.folder) emit('deleteFolderMeta', [row.folder]);
      }
      emit('setSetting', ['bookkeeping_repair_pending', false]);
    }
    if (await publish(message.id, effects, [], state.version)) return { sessions: 0, folders: 0 };
  }
  throw new Error('repair snapshot changed three times');
}

parentPort.on('message', message => {
  if (message.reply) {
    const resolve = replies.get(message.reply);
    replies.delete(message.reply);
    resolve?.(message);
    return;
  }
  run(message).then(result => parentPort.postMessage({ id: message.id, type: 'done', result }),
    error => parentPort.postMessage({ id: message.id, type: 'done', error: error.message }));
});
