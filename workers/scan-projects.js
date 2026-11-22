const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexMtimeMs } = require('../folder-index-state');
const { deriveProjectPath, resolveWorktreePath } = require('../derive-project-path');
const { setRemappedProjectReader } = require('../encode-project-path');
const { readSessionFile, enumerateSessionFiles, mergeBridgeGroups, subagentSessionId, isCanonicalWorkflowPath } = require('../read-session-file');
const { classifyTranscriptPath } = require('../subagent-attribution');
const { prefixedHarnesses, readHarnessFolder, harnessFolderIndexMtimeMs } = require('../harnesses');
const { enumerateReads, measureFolder } = require('../src/main/session-index/read-counters');
const { fullIndexConfig, SESSION_CONTENT_INDEX_VERSION, observation, fullReadStamp, matchesFullRead, sourceRelativePath, safeRelativePath, deferStartupSources, readFailures, failureStamp } = require('../src/main/session-index/full-read-state');

const PROJECTS_DIR = workerData.projectsDir;
const REMAPS = workerData.remaps && typeof workerData.remaps === 'object' ? workerData.remaps : {};
setRemappedProjectReader((folder) => REMAPS[folder]);
let lastRejected = null;
// Non-empty only for a remote mirror root; `folder` is then <alias>::<folder>.
const FOLDER_PREFIX = workerData.folderPrefix ? workerData.folderPrefix + '::' : '';
let startupRead = null;

function readForScan(file, key, projectPath, opts = {}) {
  if (!startupRead) return readSessionFile(file, key, projectPath, opts);
  const relativePath = path.relative(path.join(PROJECTS_DIR, key), file).split(path.sep).join('/');
  const previousFailure = startupRead.failures.get(relativePath);
  if (previousFailure && matchesFullRead(file, previousFailure.stamp, 'claude', relativePath)) {
    startupRead.checks.set(relativePath, previousFailure.stamp);
    startupRead.failedSources.add(relativePath);
    return null;
  }
  startupRead.failures.delete(relativePath);
  startupRead.failedSources.delete(relativePath);
  const before = observation(file);
  const dependencies = opts.parentSessionId ? { meta: observation(file.replace(/\.jsonl$/, '.meta.json')) } : {};
  const readObservation = {};
  const row = readSessionFile(file, key, projectPath, { ...opts, readObservation });
  if (readObservation.error) {
    const failedStamp = failureStamp(file, 'claude', relativePath, before, dependencies);
    if (failedStamp) {
      startupRead.failures.set(relativePath, { stamp: failedStamp, error: readObservation.error });
      startupRead.checks.set(relativePath, failedStamp);
      startupRead.failedSources.add(relativePath);
    } else startupRead.failed.add(relativePath);
    return null;
  }
  const stamp = row?.fullReadStamp || (readObservation.before && fullReadStamp(file, 'claude', relativePath,
    readObservation.before, readObservation.bytes,
    opts.parentSessionId ? { meta: observation(file.replace(/\.jsonl$/, '.meta.json')) } : {}, readObservation.dependencies));
  if (!stamp || (row && !row.fullReadStamp)) { startupRead.failed.add(relativePath); return row; }
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
      if (startupRead && !s && !startupRead.failed.has(rel) && !startupRead.failedSources.has(rel) && startupRead.byPath.has(rel)) goneIds.push(startupRead.byPath.get(rel).sessionId);
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
  const failures = readFailures(entry.meta);
  const selected = new Set(entry.deferred || []);
  for (const file of files) {
    const relativePath = path.relative(folderPath, file.filePath).split(path.sep).join('/');
    if (matchesFullRead(file.filePath, failures.get(relativePath)?.stamp, 'claude', relativePath)) selected.delete(relativePath);
    else if (!matchesFullRead(file.filePath, byPath.get(relativePath)?.fullReadStamp, 'claude', relativePath)) selected.add(relativePath);
  }
  const existingPaths = new Set(files.map(file => path.relative(folderPath, file.filePath).split(path.sep).join('/')));
  for (const relativePath of byPath.keys()) if (!existingPaths.has(relativePath)) {
    const stat = observation(path.join(folderPath, relativePath));
    if (stat === undefined) throw new Error('Cannot verify absent transcript');
    if (stat === null) selected.add(relativePath);
    else reason ||= 'changed-layout';
  }
  for (const relativePath of failures.keys()) if (!existingPaths.has(relativePath)) failures.delete(relativePath);
  startupRead = { byPath, checks: new Map(), failed: new Set(), failures, failedSources: new Set(failures.keys()) };
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
    Object.assign(result, { startup: true, reason: reason || (selected.size ? 'changed' : 'unchanged'),
      checks: [...startupRead.checks], deferred, goneFolder, inventory: entry, metadataIds: rows.map(row => row.sessionId) });
    deferStartupSources(result, [...deferred, ...startupRead.failedSources]);
    result.deferred = result.deferred?.filter(relativePath => !startupRead.failedSources.has(relativePath)) || [];
    result.readFailures = [...failures].filter(([relativePath, failure]) => matchesFullRead(path.join(folderPath, relativePath), failure.stamp, 'claude', relativePath));
    result.checks.push(...result.readFailures.map(([relativePath, failure]) => [relativePath, failure.stamp]));
    return result;
  } finally { startupRead = null; }
}

function readStartupCodexFolder(harness, folder, state) {
  const dir = harness.folderPath(folder);
  if (!dir || !folder.startsWith(harness.folderPrefix)) throw new Error('Invalid Codex startup folder');
  const entry = workerData.startup.inventory.find(item => item.folder === folder) || { folder, rows: [], meta: null };
  const titleSnapshot = state.titleSnapshot;
  if (!titleSnapshot) throw new Error('Unknown Codex title snapshot');
  const files = state.files.get(folder);
  if (!Array.isArray(files)) throw files;
  enumerateReads(files);
  const folderObservation = observation(dir);
  if (folderObservation === undefined) throw new Error('Cannot inspect Codex day');
  const { rows, meta } = entry;
  let reason = workerData.startup.force ? 'forced' : !meta ? 'missing-baseline' : meta.fullIndexPending ? 'pending'
    : meta.fullIndexVersion !== SESSION_CONTENT_INDEX_VERSION ? 'version' : meta.fullIndexConfig !== scanConfig() ? 'configuration'
      : workerData.startup.repairs?.includes(folder) ? 'repair' : null;
  if (state.ambiguous.has(folder)) reason = 'ambiguous-source';
  const byPath = new Map(), byId = new Map();
  for (const file of files) {
    const id = harness.sessionIdFromPath(file);
    if (byId.has(id)) reason ||= 'ambiguous-source';
    byId.set(id, file);
  }
  for (const row of rows) {
    const stamped = sourceRelativePath(row);
    const fallback = row.sessionFile && path.basename(row.sessionFile);
    const relativePath = stamped || (fallback && safeRelativePath(fallback) && harness.sessionIdFromPath(fallback) === row.sessionId ? fallback : null);
    if (!relativePath || byPath.has(relativePath)) { reason ||= 'ambiguous-source'; continue; }
    byPath.set(relativePath, row);
  }
  const failures = readFailures(entry.meta), failedSources = new Set();
  const selected = new Set(entry.deferred || []), checks = new Map();
  const present = new Set(files.map(file => path.basename(file)));
  for (const file of files) {
    const relativePath = path.basename(file), row = byPath.get(relativePath);
    if (matchesFullRead(file, failures.get(relativePath)?.stamp, 'codex', relativePath, titleSnapshot)) {
      selected.delete(relativePath);
      failedSources.add(relativePath);
      checks.set(relativePath, failures.get(relativePath).stamp);
      continue;
    }
    failures.delete(relativePath);
    if (!row?.fileMtime || sourceRelativePath(row) !== relativePath
      || !matchesFullRead(file, row.fullReadStamp, 'codex', relativePath, titleSnapshot)) selected.add(relativePath);
    else checks.set(relativePath, row.fullReadStamp);
  }
  for (const relativePath of byPath.keys()) if (!present.has(relativePath)) {
    const current = observation(path.join(dir, relativePath));
    if (current === undefined) throw new Error('Cannot verify absent Codex rollout');
    if (current !== null) reason ||= 'changed-layout';
    else selected.add(relativePath);
  }
  for (const relativePath of failures.keys()) if (!present.has(relativePath)) failures.delete(relativePath);
  const sessions = [], toDelete = [], deferred = [];
  const paths = reason ? new Set([...present, ...byPath.keys()]) : selected;
  for (const relativePath of paths) {
    if (!safeRelativePath(relativePath) || relativePath.includes('/') || !harness.sessionIdFromPath(relativePath)) throw new Error('Invalid Codex startup source');
    const file = path.join(dir, relativePath);
    const before = observation(file);
    if (before === undefined) throw new Error('Cannot inspect Codex rollout');
    if (before === null) {
      if (byPath.has(relativePath)) toDelete.push(byPath.get(relativePath).sessionId);
      checks.set(relativePath, null);
      continue;
    }
    if (failedSources.has(relativePath)) continue;
    const outcome = {};
    const row = harness.readSessionFile(file, folder, { startup: true, outcome, titleSnapshot, allowSubagentEarlyStop: !byPath.has(relativePath) });
    if (outcome.status === 'excluded-early') continue;
    if (outcome.status === 'failed') {
      const stamp = failureStamp(file, 'codex', relativePath, before, { title: titleSnapshot.titles.get(harness.sessionIdFromPath(file)) || null });
      if (stamp) {
        failures.set(relativePath, { stamp, error: outcome.error });
        failedSources.add(relativePath);
        checks.set(relativePath, stamp);
      } else deferred.push(relativePath);
      continue;
    }
    if (outcome.status === 'absent' || outcome.status === 'deferred' || !outcome.stamp) deferred.push(relativePath);
    else {
      checks.set(relativePath, outcome.stamp);
      if (!row && byPath.has(relativePath)) toDelete.push(byPath.get(relativePath).sessionId);
    }
    if (row) sessions.push(row);
  }
  for (const [relativePath, stamp] of checks) {
    const file = path.join(dir, relativePath);
    if (stamp === null ? observation(file) !== null : !matchesFullRead(file, stamp, 'codex', relativePath, titleSnapshot)) deferred.push(relativePath);
  }
  if (!harness.matchesTitleSnapshot(titleSnapshot)) throw Object.assign(new Error('Codex title snapshot changed during scan'), { code: 'WRITER_STALE' });
  const result = { folder, projectPath: null, sessions, toDelete: [...new Set(toDelete)],
    indexMtimeMs: harnessFolderIndexMtimeMs(harness, dir, files), partial: !reason,
    startup: true, runtime: 'codex', reason: reason || (selected.size ? 'changed' : 'unchanged'),
    checks: [...checks], deferred, goneFolder: folderObservation === null, inventory: entry,
    metadataIds: rows.map(row => row.sessionId), titleSnapshot };
  deferStartupSources(result, [...deferred, ...failedSources]);
  result.deferred = result.deferred?.filter(relativePath => !failedSources.has(relativePath)) || [];
  result.readFailures = [...failures].filter(([relativePath, failure]) => matchesFullRead(path.join(dir, relativePath), failure.stamp, 'codex', relativePath, titleSnapshot));
  result.checks.push(...result.readFailures.map(([relativePath, failure]) => [relativePath, failure.stamp]));
  return result;
}

function startupHarnessState(harness, folders) {
  const state = { titleSnapshot: harness.readTitleSnapshot(), files: new Map(), ambiguous: new Set() };
  const byId = new Map();
  for (const folder of folders) {
    try {
      const files = harness.listTranscripts(harness.folderPath(folder), { strict: true });
      state.files.set(folder, files);
      for (const file of files) {
        const id = harness.sessionIdFromPath(file);
        if (byId.has(id)) { state.ambiguous.add(byId.get(id)); state.ambiguous.add(folder); }
        byId.set(id, folder);
      }
    } catch (error) { state.files.set(folder, error); }
  }
  return state;
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
    ? [...new Set([...listProjectFolders(), ...workerData.startup.inventory.filter(entry => !prefixedHarnesses().some(harness => entry.folder.startsWith(harness.folderPrefix))).map(entry => entry.folder)])]
      .filter(folder => !workerData.startup.scope || workerData.startup.scope.includes(folder))
    : Array.isArray(workerData.folders)
    ? workerData.folders.filter(f => typeof f === 'string' && f && f !== '.git' && f !== '.' && f !== '..' && !/[\\/]/.test(f))
    : listProjectFolders();

  // see .ai/contexts/session-cache.md ("Remote hosts file-level rescan")
  const targets = workerData.disabledHarnesses?.includes('claude') ? [] : Array.isArray(workerData.targets) ? workerData.targets : [];
  // see .ai/contexts/session-cache.md ("Harness folders")
  const enumerationFailures = [], harnessScopes = new Map(), harnessStates = new Map();
  const inScope = (folder, harness) => !workerData.startup?.scope || workerData.startup.scope.includes(folder) || workerData.startup.scope.includes(harness.folderPrefix);
  const harnessFolders = (Array.isArray(workerData.folders) && !workerData.startup) || FOLDER_PREFIX !== '' ? []
    : prefixedHarnesses(workerData.disabledHarnesses).flatMap(harness => {
      if (workerData.startup?.scope && !workerData.startup.scope.some(folder => folder.startsWith(harness.folderPrefix))) return [];
      const cached = (workerData.startup?.inventory || []).filter(entry => entry.folder.startsWith(harness.folderPrefix)).map(entry => entry.folder);
      try {
        const scope = [...new Set([...harness.listFolders({ strict: !!workerData.startup }), ...cached])];
        harnessScopes.set(harness, scope);
        return scope.filter(folder => inScope(folder, harness)).map(folder => ({ harness, folder }));
      } catch (error) {
        const scope = workerData.startup?.scope
          ? workerData.startup.scope.filter(folder => folder.startsWith(harness.folderPrefix))
          : [harness.folderPrefix, ...cached];
        enumerationFailures.push(...(scope.length ? scope : [harness.folderPrefix]).map(folder => ({ folder, error: error.message })));
        return [];
      }
    });
  const total = folders.length + harnessFolders.length + targets.length;
  let current = 0;
  const failedFolders = [], replanFolders = new Set();

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
  for (const failure of enumerationFailures) {
    failedFolders.push(failure.folder);
    parentPort.postMessage({ type: 'folder', ...failure, current, total });
  }
  for (const { harness, folder } of harnessFolders) {
    current++;
    try {
      const { result, counters } = measureFolder(() => {
        if (!workerData.startup || harness.id !== 'codex') return readHarnessFolder(harness, folder);
        if (!harnessStates.has(harness)) harnessStates.set(harness, startupHarnessState(harness, harnessScopes.get(harness)));
        return readStartupCodexFolder(harness, folder, harnessStates.get(harness));
      });
      if (result?.deferred?.length) counters.filesFailed = Math.max(counters.filesFailed, result.deferred.length);
      if (result) Object.assign(result, { counters, fullIndexConfig: scanConfig() });
      parentPort.postMessage({ type: 'folder', result, counters, folder, current, total });
    } catch (error) {
      if (error.code === 'WRITER_STALE') {
        replanFolders.add(folder);
        parentPort.postMessage({ type: 'folder', folder, replan: true, current, total });
        continue;
      }
      failedFolders.push(folder);
      parentPort.postMessage({ type: 'folder', folder, error: error.message, counters: error.counters, current, total });
    }
  }
  for (const [harness, state] of harnessStates) {
    if (state.titleSnapshot && !harness.matchesTitleSnapshot(state.titleSnapshot)) {
      for (const { folder, harness: owner } of harnessFolders) if (owner === harness && !failedFolders.includes(folder)) replanFolders.add(folder);
    }
  }
  for (const t of targets) {
    const { result, counters } = measureFolder(() => readFolderFileSubsetFromFilesystem(t && t.folder, t && t.files, t && t.existingRows));
    if (result) Object.assign(result, { counters, fullIndexConfig: scanConfig() });
    current++;
    stripBridgeEvidence(result);
    parentPort.postMessage({ type: 'folder', result, counters, folder: FOLDER_PREFIX + (t && t.folder), current, total });
  }
  parentPort.postMessage({ type: 'done', ok: failedFolders.length === 0, failedFolders, replanFolders: [...replanFolders], total,
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
