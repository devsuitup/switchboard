const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexMtimeMs } = require('../folder-index-state');
const { deriveProjectPath, resolveWorktreePath } = require('../derive-project-path');
const { setRemappedProjectReader } = require('../encode-project-path');
const { readSessionFile, enumerateSessionFiles, mergeBridgeGroups, subagentSessionId, isCanonicalWorkflowPath } = require('../read-session-file');
const { classifyTranscriptPath } = require('../subagent-attribution');
const { prefixedHarnesses, readHarnessFolder } = require('../harnesses');
const { enumerateReads, measureFolder } = require('../src/main/session-index/read-counters');
const { fullIndexConfig, SESSION_CONTENT_INDEX_VERSION, observation, fullReadStamp, matchesFullRead, sourceRelativePath, safeRelativePath } = require('../src/main/session-index/full-read-state');

const PROJECTS_DIR = workerData.projectsDir;
const REMAPS = workerData.remaps && typeof workerData.remaps === 'object' ? workerData.remaps : {};
setRemappedProjectReader((folder) => REMAPS[folder]);
let lastRejected = null;
// Non-empty only for a remote mirror root; `folder` is then <alias>::<folder>.
const FOLDER_PREFIX = workerData.folderPrefix ? workerData.folderPrefix + '::' : '';
let startupRead = null;

function readForScan(file, key, projectPath, opts = {}) {
  if (!startupRead) return readSessionFile(file, key, projectPath, opts);
  const readObservation = {};
  const row = readSessionFile(file, key, projectPath, { ...opts, readObservation });
  const relativePath = path.relative(path.join(PROJECTS_DIR, key), file).split(path.sep).join('/');
  const stamp = row?.fullReadStamp || (readObservation.before && fullReadStamp(file, 'claude', relativePath,
    readObservation.before, readObservation.bytes,
    opts.parentSessionId ? { meta: observation(file.replace(/\.jsonl$/, '.meta.json')) } : {}, readObservation.dependencies));
  if (!stamp || (row && !row.fullReadStamp)) { startupRead.failed.add(relativePath); return null; }
  startupRead.checks.set(relativePath, stamp);
  return row;
}

function readFolderFromFilesystem(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  lastRejected = null;
  const projectPath = deriveProjectPath(folderPath, folder, {
    remote: FOLDER_PREFIX !== '',
    onRejected: (cwd) => { lastRejected = { folder, cwd }; },
  });
  if (!projectPath) return null;
  const key = FOLDER_PREFIX + folder;
  const sessions = [];
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  const files = enumerateSessionFiles(folderPath, { strict: !!startupRead });
  enumerateReads(files.map(entry => entry.filePath));
  for (const { filePath, parentSessionId, workflowRunId } of files) {
    try {
      const s = readForScan(filePath, key, projectPath, { parentSessionId, workflowRunId });
      if (s) sessions.push(s);
    } catch (error) { if (startupRead) throw error; }
  }

  // Merge compaction mirrors sharing a bridgeSessionId -- see mergeBridgeGroups.
  // existingRows=[] (fresh scan): every group member is re-derived from scratch.
  const reread = (sessionId, cutoff, excludedMessageUuids, excludedMessageSignatures) => {
    try {
      return readForScan(path.join(folderPath, sessionId + '.jsonl'), key, projectPath, { dedupeSinceTimestamp: cutoff, excludedMessageUuids, excludedMessageSignatures });
    } catch (error) { if (startupRead) throw error; return null; }
  };
  const { toUpsert } = mergeBridgeGroups([], sessions, reread);
  return { folder: key, projectPath, sessions: toUpsert, indexMtimeMs };
}

// rel is POSIX-separated (remote inventory, not the local fs) -- see
// .ai/contexts/session-cache.md ("Remote hosts file-level rescan").
function sessionIdFromRel(rel, classified) {
  if (!classified.parentSessionId) return path.basename(rel, '.jsonl');
  return classified.agentId ? subagentSessionId(classified.parentSessionId, classified.agentId) : null;
}

// File-subset scan for the remote path -- see .ai/contexts/session-cache.md
// ("Remote hosts file-level rescan").
function readFolderFileSubsetFromFilesystem(folder, files, existingRows, derivedPath) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = startupRead ? derivedPath : deriveProjectPath(folderPath, folder, { remote: FOLDER_PREFIX !== '' });
  if (!projectPath && !startupRead) return null;
  const key = FOLDER_PREFIX + folder;
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  const freshRows = [];
  const goneIds = [];
  const scanFiles = new Set(files || []);
  enumerateReads([...scanFiles].map(file => path.join(folderPath, file)));
  for (const rel of scanFiles) {
    if (startupRead && !safeRelativePath(rel)) throw new Error('Invalid startup transcript path');
    const classified = classifyTranscriptPath(rel);
    if (!classified) continue;
    if (classified.workflowRunId) {
      const rootId = 'agent-' + classified.agentId;
      if ((existingRows || []).some(row => row.sessionId === rootId && !row.parentSessionId)
        && !fs.existsSync(path.join(folderPath, rootId + '.jsonl')) && !goneIds.includes(rootId)) goneIds.push(rootId);
    }
    const parts = rel.split(/[\\/]/);
    const filePath = path.join(folderPath, ...parts);

    try {
      fs.statSync(filePath);
    } catch (error) {
      if (startupRead && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const sessionId = startupRead?.byPath.get(rel)?.sessionId || sessionIdFromRel(rel, classified);
      if (sessionId) goneIds.push(sessionId);
      startupRead?.checks.set(rel, null);
      continue;
    }
    if (!isCanonicalWorkflowPath(folderPath, classified)) continue;
    try {
      const s = readForScan(filePath, key, projectPath, classified);
      if (s) freshRows.push(s);
      if (startupRead && s && startupRead.byPath.has(rel) && startupRead.byPath.get(rel).sessionId !== s.sessionId) goneIds.push(startupRead.byPath.get(rel).sessionId);
      if (startupRead && !s && !startupRead.failed.has(rel) && startupRead.byPath.has(rel)) goneIds.push(startupRead.byPath.get(rel).sessionId);
    } catch (error) { if (startupRead) throw error; }
  }

  const reread = (sessionId, cutoff, excludedMessageUuids, excludedMessageSignatures) => {
    try {
      return readForScan(path.join(folderPath, sessionId + '.jsonl'), key, projectPath, { dedupeSinceTimestamp: cutoff, excludedMessageUuids, excludedMessageSignatures });
    } catch (error) { if (startupRead) throw error; return null; }
  };
  const deletedBridges = new Set((existingRows || []).filter(row => goneIds.includes(row.sessionId)
    || (startupRead && freshRows.some(fresh => fresh.sessionId === row.sessionId && fresh.bridgeSessionId !== row.bridgeSessionId)))
    .map(row => row.bridgeSessionId).filter(Boolean));
  for (const row of existingRows || []) {
    if (row.parentSessionId || !deletedBridges.has(row.bridgeSessionId) || goneIds.includes(row.sessionId)) continue;
    if (freshRows.some(fresh => fresh.sessionId === row.sessionId)) continue;
    const full = reread(row.sessionId, null);
    if (full) freshRows.push(full);
  }
  const { toUpsert, toDelete } = startupRead && !freshRows.length && !goneIds.length ? { toUpsert: [], toDelete: [] }
    : mergeBridgeGroups((existingRows || []).filter(row => !goneIds.includes(row.sessionId)), freshRows, reread);
  return { folder: key, projectPath, sessions: toUpsert,
    toDelete: [...new Set([...goneIds, ...toDelete])].filter(id => !startupRead || !toUpsert.some(row => row.sessionId === id)), indexMtimeMs, partial: true };
}

function readStartupFolder(folder) {
  if (typeof folder !== 'string' || !folder || folder === '.' || folder === '..' || /[\\/:]/.test(folder)) throw new Error('Invalid startup folder');
  const entry = workerData.startup.inventory.find(item => item.folder === folder) || { folder, rows: [], meta: null };
  const folderPath = path.join(PROJECTS_DIR, folder);
  let goneFolder = false;
  try { fs.readdirSync(folderPath); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; goneFolder = true; }
  const files = enumerateSessionFiles(folderPath, { strict: true });
  enumerateReads(files.map(file => file.filePath));
  lastRejected = null;
  const projectPath = deriveProjectPath(folderPath, folder, { onRejected: cwd => { lastRejected = { folder, cwd }; } });
  const { meta, rows } = entry;
  let reason = workerData.startup.force ? 'forced' : !meta ? 'missing-baseline' : meta.fullIndexPending ? 'pending'
    : meta.fullIndexVersion !== SESSION_CONTENT_INDEX_VERSION ? 'version' : meta.fullIndexConfig !== scanConfig() ? 'configuration'
      : workerData.startup.repairs?.includes(folder) ? 'repair'
        : meta.projectPath !== projectPath || resolveWorktreePath(meta.projectPath) !== meta.projectPath ? 'project-path' : null;
  const byPath = new Map();
  for (const row of rows) {
    const relativePath = sourceRelativePath(row) || (!row.parentSessionId && safeRelativePath(row.sessionId + '.jsonl') ? row.sessionId + '.jsonl' : null);
    if (!relativePath || byPath.has(relativePath)) { reason ||= 'ambiguous-source'; continue; }
    byPath.set(relativePath, row);
  }
  const selected = new Set(entry.deferred || []);
  for (const file of files) {
    const relativePath = path.relative(folderPath, file.filePath).split(path.sep).join('/');
    if (!matchesFullRead(file.filePath, byPath.get(relativePath)?.fullReadStamp, 'claude', relativePath)) selected.add(relativePath);
  }
  const existingPaths = new Set(files.map(file => path.relative(folderPath, file.filePath).split(path.sep).join('/')));
  for (const relativePath of byPath.keys()) if (!existingPaths.has(relativePath)) {
    const stat = observation(path.join(folderPath, relativePath));
    if (stat === undefined) throw new Error('Cannot verify absent transcript');
    if (stat === null) selected.add(relativePath);
    else reason ||= 'changed-layout';
  }
  startupRead = { byPath, checks: new Map(), failed: new Set() };
  try {
    const result = !projectPath ? { folder, projectPath, sessions: [], toDelete: rows.map(row => row.sessionId), unverified: true }
      : reason && files.length ? readFolderFromFilesystem(folder)
      : readFolderFileSubsetFromFilesystem(folder, selected, rows, projectPath);
    if (reason && !files.length) result.partial = false;
    const deferred = [...startupRead.failed];
    for (const [relativePath, stamp] of startupRead.checks) {
      const file = path.join(folderPath, relativePath);
      if (stamp === null ? observation(file) !== null : !matchesFullRead(file, stamp, 'claude', relativePath)) {
        deferred.push(relativePath);
      }
    }
    if (deferred.length) {
      const rejected = new Set(deferred.map(relativePath => byPath.get(relativePath)?.sessionId
        || sessionIdFromRel(relativePath, classifyTranscriptPath(relativePath))));
      const groups = new Set([...rows, ...result.sessions].filter(row => rejected.has(row.sessionId)).map(row => row.bridgeSessionId).filter(Boolean));
      for (const row of [...rows, ...result.sessions]) if (groups.has(row.bridgeSessionId)) rejected.add(row.sessionId);
      for (const [relativePath, row] of byPath) if (rejected.has(row.sessionId) && !deferred.includes(relativePath)) deferred.push(relativePath);
      result.sessions = result.sessions.filter(row => !rejected.has(row.sessionId));
      result.toDelete = (result.toDelete || []).filter(id => !rejected.has(id));
      result.partial = true;
      result.indexMtimeMs = 0;
      for (const relativePath of deferred) startupRead.checks.delete(relativePath);
    }
    Object.assign(result, { startup: true, reason: reason || (selected.size ? 'changed' : 'unchanged'),
      checks: [...startupRead.checks], deferred, goneFolder, inventory: entry, metadataIds: rows.map(row => row.sessionId) });
    return result;
  } finally { startupRead = null; }
}

// Scan all folders, streaming one message per folder as soon as it's read
// instead of buffering every folder into one `results` array and posting a
// single message at the very end. A large ~/.claude/projects/ (1GB+,
// witnessed live) took many minutes to fully scan, during which the caller
// (session-cache.js) had nothing to write to the DB or push to the renderer
// \u2014 the sidebar showed a bare "Loading\u2026" the whole time. Streaming lets the
// caller write + notify after every folder instead.
try {
  // workerData.folders restricts the sweep to a subset; absent, walk the root.
  const listProjectFolders = () => {
    try {
      return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== '.git').map(d => d.name);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const folders = workerData.disabledHarnesses?.includes('claude') ? [] : workerData.startup
    ? [...new Set([...listProjectFolders(), ...workerData.startup.inventory.map(entry => entry.folder)])]
      .filter(folder => !workerData.startup.scope || workerData.startup.scope.includes(folder))
    : Array.isArray(workerData.folders)
    ? workerData.folders.filter(f => typeof f === 'string' && f && f !== '.git' && f !== '.' && f !== '..' && !/[\\/]/.test(f))
    : listProjectFolders();

  // see .ai/contexts/session-cache.md ("Remote hosts file-level rescan")
  const targets = workerData.disabledHarnesses?.includes('claude') ? [] : Array.isArray(workerData.targets) ? workerData.targets : [];
  // see .ai/contexts/session-cache.md ("Harness folders")
  const harnessFolders = (Array.isArray(workerData.folders) && !workerData.startup) || FOLDER_PREFIX !== '' ? []
    : prefixedHarnesses(workerData.disabledHarnesses).flatMap(harness => harness.listFolders().map(folder => ({ harness, folder })))
      .filter(entry => !workerData.startup?.scope || workerData.startup.scope.includes(entry.folder));
  const total = folders.length + harnessFolders.length + targets.length;
  let current = 0;
  const failedFolders = [];

  for (let i = 0; i < folders.length; i++) {
    current++;
    try {
      const { result, counters } = measureFolder(() => workerData.startup ? readStartupFolder(folders[i]) : readFolderFromFilesystem(folders[i]));
      if (result?.deferred?.length) counters.filesFailed = Math.max(counters.filesFailed, result.deferred.length);
      if (result) Object.assign(result, { counters, fullIndexConfig: scanConfig() });
      stripBridgeEvidence(result);
      parentPort.postMessage({ type: 'folder', result, counters, folder: FOLDER_PREFIX + folders[i], current, total, rejected: !result || result.unverified ? lastRejected : null,
        unverifiedLocalFolder: (!result || result.unverified) && FOLDER_PREFIX === '' ? folders[i] : null });
    } catch (error) {
      failedFolders.push(folders[i]);
      parentPort.postMessage({ type: 'folder', folder: folders[i], error: error.message, counters: error.counters, current, total });
    }
  }
  for (const { harness, folder } of harnessFolders) {
    current++;
    try {
      const { result, counters } = measureFolder(() => readHarnessFolder(harness, folder));
      if (result) Object.assign(result, { counters, fullIndexConfig: scanConfig() });
      parentPort.postMessage({ type: 'folder', result, counters, folder, current, total });
    } catch (error) {
      failedFolders.push(folder);
      parentPort.postMessage({ type: 'folder', folder, error: error.message, counters: error.counters, current, total });
    }
  }
  for (const t of targets) {
    const { result, counters } = measureFolder(() => readFolderFileSubsetFromFilesystem(t && t.folder, t && t.files, t && t.existingRows));
    if (result) Object.assign(result, { counters, fullIndexConfig: scanConfig() });
    current++;
    stripBridgeEvidence(result);
    parentPort.postMessage({ type: 'folder', result, counters, folder: FOLDER_PREFIX + (t && t.folder), current, total });
  }
  parentPort.postMessage({ type: 'done', ok: failedFolders.length === 0, failedFolders, total,
    ...(failedFolders.length ? { error: 'folder scan failed' } : {}) });
} catch (err) {
  parentPort.postMessage({ type: 'done', ok: false, error: err.message });
}

function stripBridgeEvidence(result) {
  for (const row of result?.sessions || []) {
    delete row.messageUuids;
    delete row.messageUuidsComplete;
    delete row.messageSignatures;
  }
}

function scanConfig() {
  return fullIndexConfig({ remappedProjects: REMAPS, disabledHarnesses: workerData.disabledHarnesses }, PROJECTS_DIR);
}
