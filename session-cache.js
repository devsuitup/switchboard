const path = require('path');
const fs = require('fs');
const { Worker: NativeWorker } = require('worker_threads');
const scanWorkers = new Set();
const subsetScans = new Set();
let stopping = false;
class Worker extends NativeWorker {
  constructor(...args) {
    super(...args);
    scanWorkers.add(this);
    this.once('exit', () => scanWorkers.delete(this));
  }
}
async function shutdownProducers() {
  stopping = true;
  await Promise.all([...scanWorkers].map(worker => worker.terminate()));
  await Promise.allSettled([...subsetScans, populatePromise, entrypointBackfill, customTitleBackfill, repairPromise].filter(Boolean));
}

const { getFolderIndexMtimeMs } = require('./folder-index-state');
const { setRemappedProjectReader } = require('./encode-project-path');
const { deriveProjectPath, storedProjectPathMatchesFolder } = require('./derive-project-path');
const { readSessionFile, readSessionDisplayHeader, readSessionEntrypoint, isSdkEntrypoint, enumerateSessionFiles, resolveJsonlPath, mergeBridgeGroups } = require('./read-session-file');
const { encodeProjectPath, decodeProjectFolderBestEffort } = require('./encode-project-path');
const { parseFolderKey, joinFolderKey } = require('./remote-hosts');
const { isPanelShellSession } = require('./panel-terminal-target');
const { SETTING_DEFAULTS } = require('./public/setting-defaults');
const { scanContinuationIndex, resolveContinuations, validId, continuationStamp, matchesContinuationStamp } = require('./session-continuations');
const { mergeLocalBackgroundSessions } = require('./sidebar-bg-sessions');

/**
 * Session cache module.
 * Call init(ctx) once with the shared context object.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log, writer;
let deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession, touchCachedModified, replaceSessionMetrics;
let deleteSearchFolder, deleteSearchSession, upsertSearchEntries;
let setFolderMeta, getFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, setSetting, getMeta, setName;
let isInitialScanComplete, setInitialScanComplete;
let getCachedMissingEntrypoint, setCachedEntrypoints, getCachedSession, setCachedContinuationIndex;
let entrypointBackfill = null;
let getLocalDescriptors = () => [];
let getLocalJobs = () => new Map();
let setCachedCustomTitles, getCachedMissingCustomTitle;
let customTitleBackfill = null;
const continuationFiles = new Map();

function sameContinuationFile(a, b) {
  return a?.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

function sameContinuationStamp(a, b) {
  return sameContinuationFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function continuationHead(file, size, maxBytes = 64) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(Math.min(64, Number(size), maxBytes));
  try { return buffer.toString('hex', 0, fs.readSync(fd, buffer, 0, buffer.length, 0)); }
  finally { fs.closeSync(fd); }
}

function rememberContinuation(file, stat, head, serialized) {
  continuationFiles.delete(file);
  continuationFiles.set(file, { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs,
    size: stat.size, mtimeNs: stat.mtimeNs, head, serialized });
  while (continuationFiles.size > 128) continuationFiles.delete(continuationFiles.keys().next().value);
}

// see .ai/contexts/session-cache.md ("Continuation index")
function scanCachedContinuation(file, id, previous, maxBytes, stat = fs.statSync(file, { bigint: true })) {
  const cached = continuationFiles.get(file);
  const head = continuationHead(file, stat.size, Math.max(0, maxBytes - 1));
  const reuse = cached?.serialized === previous && sameContinuationFile(cached, stat)
    && (sameContinuationStamp(cached, stat) || (stat.size > cached.size && head.startsWith(cached.head)));
  let serialized = scanContinuationIndex(file, id, reuse ? previous : undefined, maxBytes - head.length / 2);
  const after = fs.statSync(file, { bigint: true });
  if (!sameContinuationStamp(stat, after)) { continuationFiles.delete(file); return null; }
  serialized = JSON.stringify({ ...JSON.parse(serialized), stamp: continuationStamp(stat) });
  rememberContinuation(file, stat, head, serialized);
  return serialized;
}

function init(ctx) {
  continuationFiles.clear();
  stopping = false;
  populateRetry = null;
  populateNow = ctx.now || Date.now;
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getLocalDescriptors = ctx.getLocalDescriptors || (() => []);
  getLocalJobs = ctx.getLocalJobs || (() => new Map());
  setCachedCustomTitles = ctx.db.setCachedCustomTitles;
  getCachedMissingCustomTitle = ctx.db.getCachedMissingCustomTitle;
  customTitleBackfill = null;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  // DB functions
  deleteCachedFolder = ctx.db.deleteCachedFolder;
  getCachedByFolder = ctx.db.getCachedByFolder;
  upsertCachedSessions = ctx.db.upsertCachedSessions;
  touchCachedModified = ctx.db.touchCachedModified;
  deleteCachedSession = ctx.db.deleteCachedSession;
  replaceSessionMetrics = ctx.db.replaceSessionMetrics;
  deleteSearchFolder = ctx.db.deleteSearchFolder;
  deleteSearchSession = ctx.db.deleteSearchSession;
  upsertSearchEntries = ctx.db.upsertSearchEntries;
  setFolderMeta = ctx.db.setFolderMeta;
  getFolderMeta = ctx.db.getFolderMeta;
  getAllFolderMeta = ctx.db.getAllFolderMeta;
  getAllMeta = ctx.db.getAllMeta;
  getAllCached = ctx.db.getAllCached;
  getSetting = ctx.db.getSetting;
  setSetting = ctx.db.setSetting;
  setRemappedProjectReader((folder) => remappedProjectsSetting()[folder]);
  getMeta = ctx.db.getMeta;
  setName = ctx.db.setName;
  isInitialScanComplete = ctx.db.isInitialScanComplete;
  setInitialScanComplete = ctx.db.setInitialScanComplete;
  getCachedMissingEntrypoint = ctx.db.getCachedMissingEntrypoint;
  getCachedSession = ctx.db.getCachedSession;
  setCachedContinuationIndex = ctx.db.setCachedContinuationIndex;
  setCachedEntrypoints = ctx.db.setCachedEntrypoints;
  entrypointBackfill = null;
  lastReconcileAt = 0;
  writer = ctx.writer || {
    writeScannedFolder, writeScannedFolderPartial,
    setCachedEntrypoints, setCachedCustomTitles, setCachedContinuationIndex,
    setInitialScanComplete, setSetting,
  };
  reindexRepairedFolders();
}

function setTranscriptName(id, name) {
  const collision = getLocalDescriptors().some(d => d.sessionId?.toLowerCase() === id.toLowerCase() && d.nameSource === 'collision')
    || [...getLocalJobs().values()].some(job => job.sessionId?.toLowerCase() === id.toLowerCase() && job.nameSource === 'collision');
  if (!collision) setName(id, name, 'transcript');
}

// alias -> that host's mirrored projects root; empty unless one is declared.
let remoteRoots = new Map();
function setRemoteRoots(roots) {
  remoteRoots = roots instanceof Map ? new Map(roots) : new Map();
}
function getRemoteRoots() {
  return new Map(remoteRoots);
}

/** Absolute directory for a folder key, local or `<alias>::<folder>`.
 *  Returns null when the key names a host that is not declared. */
function resolveFolderDir(folderKey) {
  const { alias, folder } = parseFolderKey(folderKey);
  if (alias === null) return path.join(PROJECTS_DIR, folder);
  const root = remoteRoots.get(alias);
  return root ? path.join(root, folder) : null;
}

// readSessionFile is imported from read-session-file.js (shared with worker)

const warnedRejectedFolders = new Set();

function warnRejectedCwd(folder, cwd) {
  if (warnedRejectedFolders.has(folder)) return;
  warnedRejectedFolders.add(folder);
  if (log && log.warn) log.warn(`[session-cache] no transcript of folder ${folder} has a cwd that encodes to it; first rejected cwd: ${JSON.stringify(cwd)}`);
}

// see .ai/contexts/session-cache.md ("A running session keeps its row")
const keptLiveRows = new Map();

function resetProjectsWorkerRetainedRows() { keptLiveRows.clear(); }
function getProjectsWorkerRetainedRows() { return [...keptLiveRows]; }

// see .ai/contexts/session-cache.md ("Projects query worker")
function applyProjectsWorkerEffects(result) {
  const writers = { upsertCachedSessions, deleteCachedSession, deleteCachedFolder,
    touchCachedModified, setFolderMeta, setName, replaceSessionMetrics,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries };
  for (const { name, args } of result.effects) writers[name](...args);
  for (const [id, folder] of result.keptLiveRows) keptLiveRows.set(id, folder);
}

function isRunningSession(sessionId) {
  const s = activeSessions && activeSessions.get(sessionId);
  return !!s && !s.exited && !s.isPlainTerminal;
}

function keepIfRunning(sessionId, folder) {
  if (!isRunningSession(sessionId)) return false;
  keptLiveRows.set(sessionId, folder);
  return true;
}

function dropFolderRows(folder, { search = false } = {}) {
  const rows = getCachedByFolder(folder);
  const dropped = rows.filter(r => !keepIfRunning(r.sessionId, folder));
  if (dropped.length === rows.length) {
    deleteCachedFolder(folder);
    if (search) deleteSearchFolder(folder);
    return;
  }
  for (const { sessionId } of dropped) {
    deleteCachedSession(sessionId);
    if (search) deleteSearchSession(sessionId);
  }
}

function releaseLiveSession(sessionId) {
  const folder = keptLiveRows.get(sessionId);
  if (folder === undefined || isRunningSession(sessionId)) return false;
  keptLiveRows.delete(sessionId);
  refreshFolder(folder);
  return true;
}

function deriveFolderProjectPath(folderPath, folderKey, onIncomplete) {
  const { alias, folder } = parseFolderKey(folderKey);
  return deriveProjectPath(folderPath, folder, {
    remote: alias !== null,
    onRejected: (cwd) => warnRejectedCwd(folder, cwd),
    onIncomplete,
  });
}

function remappedProjectsSetting() {
  const stored = getSetting ? getSetting('projectRemaps') : null;
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** Read one folder from filesystem by scanning .jsonl files directly */
function readFolderFromFilesystem(folder) {
  const folderPath = resolveFolderDir(folder);
  if (!folderPath) return { projectPath: null, sessions: [] };
  const projectPath = deriveFolderProjectPath(folderPath, folder);
  if (!projectPath) return { projectPath: null, sessions: [] };
  const sessions = [];

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) sessions.push(s);
  }

  // Merge compaction mirrors sharing a bridgeSessionId -- see mergeBridgeGroups.
  // existingRows=[] (fresh scan): every group member is re-derived from scratch.
  const reread = (sessionId, cutoff, excludedMessageUuids, excludedMessageSignatures) => readSessionFile(
    path.join(folderPath, sessionId + '.jsonl'), folder, projectPath, { dedupeSinceTimestamp: cutoff, excludedMessageUuids, excludedMessageSignatures }
  );
  const { toUpsert } = mergeBridgeGroups([], sessions, reread);
  return { projectPath, sessions: toUpsert };
}

/** Refresh a single folder incrementally: only re-read changed/new .jsonl files.
 *
 * @param {string} folder    folder name relative to PROJECTS_DIR
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.files]  if provided, ONLY scan these on-disk
 *   relative paths within the folder instead of walking everything. Used by the
 *   fs.watch flush to avoid statSync'ing thousands of files when only a handful
 *   of subagent transcripts were appended. When null/undefined, walk the whole
 *   folder (used for bootstrap and folder-level events).
 */
function refreshFolder(folder, opts = {}) {
  if (pendingRepairFolders().includes(folder)) return;
  // null when the key names a host no longer declared — treated as vanished.
  const folderPath = resolveFolderDir(folder);
  if (!folderPath || !fs.existsSync(folderPath)) {
    dropFolderRows(folder);
    return;
  }

  // Reuse the previously-derived projectPath when its directory still exists.
  // deriveProjectPath reads session JSONL heads, and refreshFolder runs on
  // every watcher flush -- deriving each time is wasted I/O on hot folders.
  // A vanished directory falls through to a fresh derive so the missing-
  // project remap detection keeps working.
  const knownMeta = getFolderMeta ? getFolderMeta(folder) : null;
  let projectPath = knownMeta && knownMeta.projectPath && fs.existsSync(knownMeta.projectPath)
    && (parseFolderKey(folder).alias !== null || storedProjectPathMatchesFolder(knownMeta.projectPath, folder))
    ? knownMeta.projectPath
    : null;
  let incomplete = false;
  if (!projectPath) projectPath = deriveFolderProjectPath(folderPath, folder, () => { incomplete = true; });
  if (!projectPath) {
    if (parseFolderKey(folder).alias === null) dropFolderRows(folder, { search: true });
    setFolderMeta(folder, null, incomplete ? 0 : getFolderIndexMtimeMs(folderPath));
    return;
  }

  // Get what's currently cached for this folder.
  // cachedMap: DB sessionId -> { modified, filePath } so we can do mtime comparison
  // even for subagents whose DB sessionId differs from the on-disk filename.
  // filePathToDbId: inverted index so the per-file lookup is O(1) -- without it,
  // refreshing a folder with N cached sessions costs O(N^2) per flush (the watcher
  // fires frequently while live Claude sessions append JSONL, freezing the main
  // process for folders with thousands of subagents).
  const cachedSessions = getCachedByFolder(folder);
  // `folder` may carry an `<alias>::` prefix, which is not a path component.
  const jsonlPathFor = (row) => resolveJsonlPath(folderPath, { ...row, folder: '.' });
  const cachedMap = new Map();
  const filePathToDbId = new Map();
  for (const row of cachedSessions) {
    const filePath = jsonlPathFor(row);
    // Keep the full row so refresh can merge display-only header updates with
    // unchanged fields (created, messageCount, textContent) without re-reading
    // the file body.
    cachedMap.set(row.sessionId, { ...row, filePath });
    filePathToDbId.set(filePath, row.sessionId);
  }

  // Targeted refresh: walk only the files the watcher said changed, not the
  // entire folder. Skips enumerateSessionFiles (which does many readdirSyncs on
  // every subagent subdir) and only stats the dirty files. Falls back to full
  // walk when opts.files is omitted (bootstrap / folder-level events / cold
  // delete-detection).
  const targeted = opts.files instanceof Set && opts.files.size > 0;
  let filesToScan;
  if (targeted) {
    filesToScan = [];
    for (const rel of opts.files) {
      const filePath = path.join(folderPath, rel);
      // Derive parentSessionId for subagent paths: <folder>/<parent>/subagents/agent-X.jsonl
      const parts = rel.split(path.sep);
      let parentSessionId = null;
      if (parts.length === 3 && parts[1] === 'subagents') {
        parentSessionId = parts[0];
      } else if (parts.length === 2) {
        // legacy <folder>/<parent>/agent-X.jsonl layout (no subagents/ subdir)
        parentSessionId = parts[0];
      }
      filesToScan.push({ filePath, parentSessionId });
    }
  } else {
    filesToScan = enumerateSessionFiles(folderPath);
  }

  let continuationBytesLeft = 1024 * 1024;
  const currentIds = new Set();
  let changed = false;

  // Collect all changes first, then batch DB writes to minimize lock duration
  const sessionsToUpsert = [];
  const searchEntriesToUpsert = [];
  const namesToSet = [];
  const sessionsToDelete = [];
  const metricsToReplace = [];
  // Full reads only (the "NEW file" branch below) -- kept separate from
  // sessionsToUpsert so mergeBridgeGroups never sees a header-only-refreshed
  // row and mistakes it for a safe-to-reread fresh read (it isn't: the whole
  // point of header-only refresh is to avoid a full re-read of a live file).
  const newFileReads = [];

  // Refresh strategy:
  //   - NEW file (no cache row): full readSessionFile -- small at first turn,
  //     seeds session_cache + FTS body in one shot.
  //   - EXISTING file (already cached): header-only read (~256 KB / 500 lines).
  //     Updates display fields (summary, slug, titles, mtime) without reading
  //     the full body. Avoids re-reading 200+ MB live host-session JSONLs on
  //     every watcher flush. Side-effect: FTS body for live sessions goes
  //     stale until the next cold-start (acceptable trade-off).
  //   - Header read failing (truncated chunk, partial JSON): fall back to a
  //     mtime-only DB touch so the sidebar still reflects activity.

  for (const { filePath, parentSessionId } of filesToScan) {
    let stat, fileMtime;
    try {
      stat = fs.statSync(filePath, { bigint: true });
      fileMtime = new Date(Number((stat.mtimeNs + 500000n) / 1000000n)).toISOString();
    } catch { continue; }

    const cachedDbId = filePathToDbId.get(filePath) || null;
    const cachedEntry = cachedDbId ? cachedMap.get(cachedDbId) : null;

    if (cachedDbId !== null) currentIds.add(cachedDbId);

    // Invalidation compares against the dedicated fileMtime column, not
    // `modified`. Upstream split the two (v7 migration): `modified` now holds
    // the last *message* timestamp for display, so it no longer tracks the
    // file's mtime and can't serve as the change-detection key. Comparing
    // `modified` here would miss on nearly every row and re-read every dirty
    // file on every watcher flush.
    const snapshot = continuationFiles.get(filePath);
    let persistedStamp;
    if (!snapshot) {
      try { persistedStamp = JSON.parse(cachedEntry?.continuationIndex)?.stamp; } catch {}
    }
    const changedIndex = snapshot ? !sameContinuationStamp(snapshot, stat)
      : persistedStamp && !matchesContinuationStamp(persistedStamp, stat);
    if (cachedEntry && cachedEntry.fileMtime === fileMtime && cachedEntry.projectPath === projectPath
      && (!cachedEntry.continuationIndex || !changedIndex || parentSessionId || cachedEntry.parentSessionId)) {
      continue; // unchanged, skip
    }

    if (cachedEntry) {
      let continuationIndex = cachedEntry.continuationIndex;
      if (parentSessionId || cachedEntry.parentSessionId) continuationIndex = null;
      else if (continuationBytesLeft) {
        continuationIndex = scanCachedContinuation(filePath, cachedEntry.sessionId, continuationIndex, continuationBytesLeft, stat);
        continuationBytesLeft = 0;
      } else if (changedIndex) continuationIndex = null;
      if (cachedEntry.fileMtime === fileMtime && cachedEntry.projectPath === projectPath
        && continuationIndex === cachedEntry.continuationIndex) continue;
      // EXISTING -- header-only refresh.
      const h = readSessionDisplayHeader(filePath, { parentSessionId });
      if (h) {
        // Merge: keep cached body/messageCount/created, overlay fresh display fields.
        const merged = {
          ...cachedEntry,
          continuationIndex,
          folder, projectPath,
          summary: h.summary || cachedEntry.summary,
          firstPrompt: h.firstPrompt || cachedEntry.firstPrompt,
          // The header read only sees the first 256 KB of the transcript, so it
          // cannot know the last message timestamp that upstream's `modified`
          // now means. Keep bumping `modified` to the file mtime here so live
          // sessions still sort to the top of the sidebar; the cold-start full
          // read (readSessionFile) corrects it to the real last-message time.
          // Same class of trade-off as the stale-FTS-body note above.
          modified: fileMtime,
          fileMtime,
          slug: h.slug || cachedEntry.slug,
          scheduleSlug: h.scheduleSlugComplete ? h.scheduleSlug : h.scheduleSlug || cachedEntry.scheduleSlug,
          aiTitle: h.aiTitle || cachedEntry.aiTitle,
          parentSessionId: h.parentSessionId || cachedEntry.parentSessionId,
          agentId: h.agentId || cachedEntry.agentId,
          subagentType: h.subagentType || cachedEntry.subagentType,
          description: h.description || cachedEntry.description,
        };
        // see .ai/contexts/session-cache.md ("SDK-launched sessions")
        if (isSdkEntrypoint(cachedEntry.entrypoint)) {
          merged.entrypoint = readSessionEntrypoint(filePath) ?? cachedEntry.entrypoint;
        }
        sessionsToUpsert.push(merged);
        if (h.customTitle && h.customTitle !== cachedEntry.customTitle) {
          namesToSet.push({ id: merged.sessionId, name: h.customTitle });
        }
      } else {
        // Header read couldn't extract signal -- just bump mtime so sort order
        // stays current. fileMtime has to move too, otherwise this file stays
        // permanently "dirty" and gets re-read on every watcher flush.
        if (continuationIndex !== cachedEntry.continuationIndex) {
          sessionsToUpsert.push({ ...cachedEntry, continuationIndex, modified: fileMtime, fileMtime });
        } else touchCachedModified(cachedDbId, fileMtime);
        cachedEntry.modified = fileMtime;
        cachedEntry.fileMtime = fileMtime;
      }
      changed = true;
      continue;
    }

    // NEW file -- full readSessionFile so the FTS index gets seeded. Search
    // entry / metrics / name are built AFTER merge resolution below, from
    // whatever object actually survives (a compaction mirror's raw read here
    // may still be replaced by a cutoff-filtered re-derivation, or dropped).
    const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) {
      if (!parentSessionId && s.continuationIndex) {
        const head = continuationHead(filePath, stat.size);
        const after = fs.statSync(filePath, { bigint: true });
        if (sameContinuationStamp(stat, after)) rememberContinuation(filePath, stat, head, s.continuationIndex);
        else s.continuationIndex = null;
      }
      currentIds.add(s.sessionId);
      newFileReads.push(s);
    }
    changed = true;
  }

  // Remove sessions whose .jsonl files were deleted. Skip in targeted mode --
  // we only stat'd the dirty files, so cachedMap entries not in currentIds
  // weren't checked and may still exist on disk. Targeted-mode deletions are
  // handled by the watcher path-stat: missing files surface via statSync's
  // ENOENT in the loop above and produce no upsert. A full walk picks up any
  // drift on the next folder-level event.
  if (!targeted) {
    for (const sessionId of cachedMap.keys()) {
      if (!currentIds.has(sessionId) && !keepIfRunning(sessionId, folder)) {
        sessionsToDelete.push(sessionId);
        changed = true;
      }
    }
  } else {
    // Targeted mode still needs to delete entries for files explicitly deleted
    // in this flush -- detected by statSync failing on a path we tried to scan.
    for (const { filePath } of filesToScan) {
      const dbId = filePathToDbId.get(filePath);
      if (!dbId) continue;
      try { fs.statSync(filePath); } catch {
        if (keepIfRunning(dbId, folder)) continue;
        sessionsToDelete.push(dbId);
        changed = true;
      }
    }
  }

  // Merge compaction mirrors sharing a bridgeSessionId -- see mergeBridgeGroups.
  // Only newFileReads (this pass's full reads) are eligible for re-derivation;
  // cachedSessions is the folder's full pre-refresh state, independent of
  // `targeted`, so an already-cached parent is recognised without re-reading it.
  const reread = (sessionId, cutoff, excludedMessageUuids, excludedMessageSignatures) => readSessionFile(
    jsonlPathFor({ folder, sessionId }), folder, projectPath, { dedupeSinceTimestamp: cutoff, excludedMessageUuids, excludedMessageSignatures }
  );
  const deletedBridges = new Set(cachedSessions.filter(row => sessionsToDelete.includes(row.sessionId)).map(row => row.bridgeSessionId).filter(Boolean));
  for (const row of cachedSessions) {
    if (row.parentSessionId || !deletedBridges.has(row.bridgeSessionId) || sessionsToDelete.includes(row.sessionId)) continue;
    if (newFileReads.some(fresh => fresh.sessionId === row.sessionId)) continue;
    const full = reread(row.sessionId, null);
    if (full) newFileReads.push(full);
  }
  const { toUpsert: mergedRows, toDelete: mergeDeletes } = newFileReads.length
    ? mergeBridgeGroups(cachedSessions.filter(row => !sessionsToDelete.includes(row.sessionId)), newFileReads, reread)
    : { toUpsert: [], toDelete: [] };

  // Now that merge resolution is final, build the search entry / metrics /
  // name-set for each surviving row -- a plain fresh read, OR an
  // already-cached member re-derived because its recorded mergedIntoSessionId
  // disagreed with the winner just computed (see mergeBridgeGroups).
  for (const s of mergedRows) {
    sessionsToUpsert.push(s);
    metricsToReplace.push({ sessionId: s.sessionId, dailyMetrics: s.dailyMetrics });
    const name = getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
    searchEntriesToUpsert.push({
      id: s.sessionId, type: 'session', folder: s.folder,
      title: (name ? name + ' ' : '') + s.summary, body: s.textContent,
    });
    if (s.customTitle) namesToSet.push({ id: s.sessionId, name: s.customTitle });
  }
  // An already-cached member whose re-derivation found nothing surviving the
  // newly-applicable cutoff must be removed outright -- leaving its old,
  // pre-cutoff row in place would keep the exact double-count this fix exists
  // to close.
  sessionsToDelete.push(...mergeDeletes);

  // Batch all DB writes to reduce lock contention
  if (sessionsToUpsert.length > 0) {
    stripBridgeEvidence(sessionsToUpsert);
    upsertCachedSessions(sessionsToUpsert);
  }
  for (const { sessionId, dailyMetrics } of metricsToReplace) {
    replaceSessionMetrics(sessionId, dailyMetrics);
  }
  for (const entry of searchEntriesToUpsert) {
    deleteSearchSession(entry.id);
  }
  if (searchEntriesToUpsert.length > 0) {
    upsertSearchEntries(searchEntriesToUpsert);
  }
  for (const { id, name } of namesToSet) {
    setTranscriptName(id, name);
  }
  for (const sessionId of sessionsToDelete) {
    if (keepIfRunning(sessionId, folder)) continue;
    deleteCachedSession(sessionId);
    deleteSearchSession(sessionId);
  }

  // Update folder mtime
  setFolderMeta(folder, projectPath, getFolderIndexMtimeMs(folderPath));
}

// see .ai/contexts/session-cache.md ("Projects query worker")
const RECONCILE_THROTTLE_MS = 5000;
let lastReconcileAt = 0;
function reconcileCacheFromFilesystem({ onFolder, throttle = true } = {}) {
  const now = Date.now();
  if (throttle && now - lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  lastReconcileAt = now;
  try {
    const metaMap = getAllFolderMeta();
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);

    for (const folder of folders) {
      const meta = metaMap.get(folder);
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (!meta || getFolderIndexMtimeMs(folderPath) > (meta.indexMtimeMs || 0)
        || (meta.projectPath && !storedProjectPathMatchesFolder(meta.projectPath, folder))) {
        if (!pendingRepairFolders().includes(folder)) refreshFolder(folder);
      }
      if (onFolder) onFolder(folder);
    }
  } catch (err) {
    console.error('Error reconciling cache:', err);
  }
}

// A hidden entry is a bare projectPath (legacy, hides on every host) or
// alias+'::'+projectPath (hides only on that host). See remove-project in main.js.
function isProjectHidden(hiddenProjects, alias, projectPath) {
  if (hiddenProjects.has(projectPath)) return true;
  return alias !== null && hiddenProjects.has(joinFolderKey(alias, projectPath));
}

const ENTRYPOINT_BACKFILL_BATCH = 200;

// see .ai/contexts/session-cache.md ("SDK-launched sessions")
function backfillEntrypoints() {
  if (stopping) return Promise.resolve();
  if (entrypointBackfill) return entrypointBackfill;
  entrypointBackfill = new Promise((resolve, reject) => {
    const rows = getCachedMissingEntrypoint ? getCachedMissingEntrypoint() : [];
    let next = 0;
    let sdkFound = false;
    const step = async () => {
      const pairs = [];
      const end = Math.min(next + ENTRYPOINT_BACKFILL_BATCH, rows.length);
      for (; next < end; next++) {
        const row = rows[next];
        const dir = resolveFolderDir(row.folder);
        if (!dir) continue;
        const entrypoint = readSessionEntrypoint(resolveJsonlPath(dir, { ...row, folder: '.' }), { full: true });
        if (entrypoint === null) continue;
        if (isSdkEntrypoint(entrypoint)) sdkFound = true;
        pairs.push({ sessionId: row.sessionId, entrypoint });
      }
      if (pairs.length) await writer.setCachedEntrypoints(pairs);
      if (next < rows.length) {
        setImmediate(() => step().catch(reject));
        return;
      }
      if (sdkFound) notifyRendererProjectsChanged();
      resolve();
    };
    step().catch(reject);
  });
  return entrypointBackfill;
}

// see .ai/contexts/session-cache.md ("Local background sidebar rows")
function backfillCustomTitles() {
  if (stopping) return Promise.resolve();
  if (customTitleBackfill) return customTitleBackfill;
  if (!setCachedCustomTitles || !getCachedMissingCustomTitle) return (customTitleBackfill = Promise.resolve());
  const rows = getCachedMissingCustomTitle().filter(row => validId(row.sessionId) && parseFolderKey(row.folder).alias === null);
  if (!rows.length) return (customTitleBackfill = Promise.resolve());
  const files = rows.map(row => ({ sessionId: row.sessionId, fileMtime: row.fileMtime,
    file: resolveJsonlPath(resolveFolderDir(row.folder), { ...row, folder: '.' }) }));
  customTitleBackfill = new Promise(resolve => {
    let worker, settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => { worker?.terminate(); finish(false); }, SUBSET_SCAN_TIMEOUT_MS);
    try {
      worker = new Worker(path.join(__dirname, 'workers', 'scan-session-titles.js'), { workerData: { files } });
    } catch (err) {
      log.warn(`Title backfill failed: ${err.message}`);
      finish(false);
      return;
    }
    let writes = Promise.resolve();
    worker.on('message', pairs => {
      writes = writes.then(async () => {
        if (settled) return;
        try {
          await writer.setCachedCustomTitles(pairs);
          if (pairs.length) notifyRendererProjectsChanged();
        } catch (err) {
          log.warn(`Title backfill failed: ${err.message}`);
          worker.terminate();
          finish(false);
        }
      });
    });
    worker.on('error', err => { log.warn(`Title backfill failed: ${err.message}`); finish(false); });
    worker.on('exit', code => { writes.then(() => finish(code === 0)); });
  }).then(ok => { if (!ok) customTitleBackfill = null; });
  return customTitleBackfill;
}

// see .ai/contexts/session-cache.md ("SDK-launched sessions")
function revealIfSdkSession(sessionId) {
  const row = getCachedSession ? getCachedSession(sessionId) : null;
  if (row && isSdkEntrypoint(row.entrypoint)) notifyRendererProjectsChanged();
}

// see .ai/contexts/session-cache.md ("SDK-launched sessions")
function hiddenSdkSessionIds(cachedRows, global, mergedChildrenByParent) {
  if (!(global.hideSdkSessions ?? SETTING_DEFAULTS.hideSdkSessions)) return new Set();
  const kept = new Set((global.openWorkingSet || []).map(item => item && item.sessionId));
  for (const [sessionId, session] of activeSessions || []) {
    if (!session.exited) kept.add(sessionId);
  }
  const hidden = new Set();
  for (const row of cachedRows) {
    if (!isSdkEntrypoint(row.entrypoint) || kept.has(row.sessionId)) continue;
    const children = mergedChildrenByParent.get(row.sessionId) || [];
    if (children.some(child => !isSdkEntrypoint(child.entrypoint))) continue;
    hidden.add(row.sessionId);
  }
  return hidden;
}

/** Build projects response from cached data */
function buildProjectsFromCache(showArchived) {
  const metaMap = getAllMeta(true);
  const cachedRows = getAllCached();
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // Group by projectPath, not on-disk folder name. Multiple ~/.claude/projects/<folder>/
  // directories can resolve to the same projectPath (Claude Code's folder-name encoding
  // scheme has changed over time, leaving legacy stragglers around), so we merge them into
  // a single sidebar group to avoid duplicate-id collisions in the morphdom render.
  // Only insert a project entry once we have a session that survives the archive filter --
  // otherwise folders whose sessions are all archived would appear in the sidebar as
  // undismissable phantom entries.
  // A compaction mirror keeps its own session_cache row (own fileMtime, own
  // incremental refresh) but must never appear as a second sidebar entry --
  // see mergeBridgeGroups in read-session-file.js. Roll its messageCount and
  // modified up onto the row it merged into before building sidebar entries.
  const mergedChildrenByParent = new Map();
  for (const row of cachedRows) {
    if (!row.mergedIntoSessionId) continue;
    if (!mergedChildrenByParent.has(row.mergedIntoSessionId)) {
      mergedChildrenByParent.set(row.mergedIntoSessionId, []);
    }
    mergedChildrenByParent.get(row.mergedIntoSessionId).push(row);
  }

  const hiddenSdkIds = hiddenSdkSessionIds(cachedRows, global, mergedChildrenByParent);
  const sdkOnlyProjectKeys = new Set();

  const cachedIds = new Set(cachedRows.map(r => r.sessionId));
  const isArchivedParent = (id) => cachedIds.has(id) && !!metaMap.get(id)?.archived;

  // Keyed on alias + projectPath: two hosts can hold the same absolute path.
  const projectMap = new Map();
  // '|' cannot occur in an alias (remote-hosts.js ALIAS_RE): the key is injective.
  const groupKey = (alias, projectPath) => (alias === null ? '' : alias) + '|' + projectPath;
  for (const row of cachedRows) {
    if (row.mergedIntoSessionId) continue; // rolled up into its parent below, not its own entry
    if (!row.projectPath) continue;
    const { alias } = parseFolderKey(row.folder);
    if (hiddenSdkIds.has(row.sessionId) || hiddenSdkIds.has(row.parentSessionId)) {
      sdkOnlyProjectKeys.add(groupKey(alias, row.projectPath));
      continue;
    }
    if (isProjectHidden(hiddenProjects, alias, row.projectPath)) continue;
    const meta = metaMap.get(row.sessionId);
    const children = mergedChildrenByParent.get(row.sessionId) || [];
    const orderedChildren = [...children].sort((a, b) =>
      (b.modified || '').localeCompare(a.modified || '') || a.sessionId.localeCompare(b.sessionId)
    );
    const head = orderedChildren[0];
    const headSessionId = head && (head.modified || '') >= (row.modified || '') ? head.sessionId : row.sessionId;
    let messageCount = row.messageCount;
    let modified = row.modified;
    for (const child of children) {
      messageCount += child.messageCount || 0;
      if (child.modified && (!modified || child.modified > modified)) modified = child.modified;
    }
    const s = {
      sessionId: row.sessionId,
      summary: row.summary,
      firstPrompt: row.firstPrompt,
      created: row.created,
      modified,
      messageCount,
      projectPath: row.projectPath,
      slug: row.slug || null,
      scheduleSlug: row.scheduleSlug || null,
      aiTitle: row.aiTitle || null,
      parentSessionId: row.parentSessionId || null,
      agentId: row.agentId || null,
      subagentType: row.subagentType || null,
      description: row.description || null,
      name: meta?.name || null,
      starred: meta?.starred || 0,
      archived: meta?.archived || 0,
      remoteAlias: alias,
      bridgeSessionId: row.bridgeSessionId || null,
      headSessionId,
      mergedMemberIds: orderedChildren.map(child => child.sessionId),
    };
    if (!showArchived && s.archived) continue;
    // see .ai/contexts/subagent-observability.md ("A subagent follows its archived parent")
    if (!showArchived && s.parentSessionId && isArchivedParent(s.parentSessionId)) continue;
    const key = groupKey(alias, row.projectPath);
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        folder: alias === null
          ? encodeProjectPath(row.projectPath)
          : joinFolderKey(alias, encodeProjectPath(row.projectPath)),
        projectPath: row.projectPath,
        remoteAlias: alias,
        sessions: [],
        // A remote root is never on this filesystem. see .ai/contexts/session-cache.md ("Remote SSH hosts")
        missing: alias === null ? !fs.existsSync(row.projectPath) : false,
      });
    }
    projectMap.get(key).sessions.push(s);
  }

  // Include empty project directories (no sessions yet). Resolve folder->projectPath
  // through cache_meta (populated by the indexer) instead of re-reading a JSONL off
  // disk for every directory on every render. Fall back to deriveProjectPath only
  // for folders the indexer hasn't seen yet, and backfill cache_meta so subsequent
  // renders are pure DB reads.
  //
  // While the INITIAL scan is still incomplete (completeness marker absent),
  // that fallback is forbidden: cache_meta is mostly/entirely empty, so
  // deriveProjectPath (readdir + up to 256 KB JSONL read) would run for every
  // folder under PROJECTS_DIR — twice per sidebar paint (the renderer's
  // showArchived false/true Promise.all) — synchronously on the main process,
  // undermining the "return whatever's cached, zero per-folder I/O" contract
  // of the non-blocking first launch. Use a best-effort decode of the folder
  // name instead (display-only, corrected per folder as the scan worker fills
  // cache_meta and fires projects-changed) and skip the fs.existsSync missing
  // probe for the same zero-I/O reason. Nothing is written to cache_meta on
  // this path — a lossy guess must never shadow the real derived path.
  try {
    const scanComplete = isInitialScanComplete ? isInitialScanComplete() : true;
    const folderMeta = getAllFolderMeta();
    const roots = [{ alias: null, dir: PROJECTS_DIR }];
    for (const [alias, dir] of remoteRoots) roots.push({ alias, dir });
    for (const { alias, dir } of roots) {
      let dirs;
      try {
        dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== '.git');
      } catch { continue; }
      for (const d of dirs) {
        const folderKey = alias === null ? d.name : joinFolderKey(alias, d.name);
        let projectPath = folderMeta.get(folderKey)?.projectPath;
        if (projectPath && alias === null && !storedProjectPathMatchesFolder(projectPath, d.name)) projectPath = null;
        let placeholder = false;
        if (!projectPath) {
          if (scanComplete) {
            projectPath = deriveFolderProjectPath(path.join(dir, d.name), folderKey);
            if (projectPath && alias === null) setFolderMeta(folderKey, projectPath, 0);
          } else {
            projectPath = decodeProjectFolderBestEffort(d.name);
            placeholder = true;
          }
        }
        if (!projectPath) continue;
        if (isProjectHidden(hiddenProjects, alias, projectPath)) continue;
        const key = groupKey(alias, projectPath);
        if (projectMap.has(key) || sdkOnlyProjectKeys.has(key)) continue;
        // For a placeholder the on-disk name IS the ground truth — re-encoding
        // the lossy decode could diverge from it (>200-char hashed names).
        const bare = placeholder ? d.name : encodeProjectPath(projectPath);
        projectMap.set(key, {
          folder: alias === null ? bare : joinFolderKey(alias, bare),
          projectPath,
          remoteAlias: alias,
          sessions: [],
          // A remote root is never on this filesystem — see above.
          missing: (placeholder || alias !== null) ? false : !fs.existsSync(projectPath),
        });
      }
    }
  } catch {}

  // Inject active plain terminal sessions so they participate in sorting
  for (const [sessionId, session] of activeSessions) {
    if (session.exited || !session.isPlainTerminal) continue;
    // see .ai/contexts/panel-terminal.md ("A panel shell is not a session")
    if (isPanelShellSession(session)) continue;
    if (!session.projectPath) continue;
    if (isProjectHidden(hiddenProjects, null, session.projectPath)) continue;
    const localKey = groupKey(null, session.projectPath);
    if (!projectMap.has(localKey)) {
      projectMap.set(localKey, {
        folder: encodeProjectPath(session.projectPath),
        projectPath: session.projectPath,
        remoteAlias: null,
        sessions: [],
      });
    }
    const proj = projectMap.get(localKey);
    if (!proj.sessions.some(s => s.sessionId === sessionId)) {
      proj.sessions.push({
        sessionId, summary: 'Terminal', firstPrompt: '', projectPath: session.projectPath,
        name: null, starred: 0, archived: 0, messageCount: 0,
        modified: new Date(session._openedAt).toISOString(),
        created: new Date(session._openedAt).toISOString(),
        type: 'terminal',
      });
    }
  }

  const localDescriptors = [...getLocalDescriptors()];
  const descriptorIds = new Set(localDescriptors.map(descriptor => descriptor.sessionId.toLowerCase()));
  for (const [id, session] of activeSessions) {
    if (session.exited || !session.isAttach || session.host || !session.attachJobId) continue;
    const sessionId = session.realSessionId || id;
    if (descriptorIds.has(sessionId.toLowerCase())) continue;
    localDescriptors.push({ sessionId, kind: 'bg', jobId: session.attachJobId,
      cwd: session.cwd || session.projectPath, startedAt: session._openedAt });
    descriptorIds.add(sessionId.toLowerCase());
  }
  const projects = mergeLocalBackgroundSessions([...projectMap.values()], cachedRows, localDescriptors, {
    hiddenProjects, metaMap, showArchived, jobs: getLocalJobs(),
  });
  for (const proj of projects) {
    proj.sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  }

  projects.sort((a, b) => {
    // Missing projects go to the bottom
    if (a.missing && !b.missing) return 1;
    if (!a.missing && b.missing) return -1;
    // Empty projects go to the bottom
    if (a.sessions.length === 0 && b.sessions.length > 0) return 1;
    if (b.sessions.length === 0 && a.sessions.length > 0) return -1;
    const aDate = a.sessions[0]?.modified || '';
    const bDate = b.sessions[0]?.modified || '';
    return new Date(bDate) - new Date(aDate);
  });

  return projects;
}


// Throttle projects-changed IPC: live sessions appending JSONL trigger a flush
// every ~500ms; without throttling the renderer re-runs getProjects + morphdom
// over 100+ items at that cadence, producing visible flicker. Leading-edge fire
// + trailing flush so the first change is instant but subsequent bursts coalesce.
const NOTIFY_THROTTLE_MS = 1500;
let _notifyCooldown = false;
let _notifyPending = false;
function notifyRendererProjectsChanged() {
  if (_notifyCooldown) { _notifyPending = true; return; }
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projects-changed');
  }
  _notifyCooldown = true;
  setTimeout(() => {
    _notifyCooldown = false;
    if (_notifyPending) {
      _notifyPending = false;
      notifyRendererProjectsChanged();
    }
  }, NOTIFY_THROTTLE_MS);
}

function sendStatus(text, type) {
  if (text) log.info(`[status] (${type || 'info'}) ${text}`);
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('status-update', text, type || 'info');
  }
}

// First-run cold-start progress, consumed by the renderer's dismissible
// indexing banner (see public/app.js). Deliberately separate from sendStatus:
// status-update already fires unconditionally on every populateCacheViaWorker
// run (cold start AND warm-start rebuilds AND manual rebuild-cache clicks) to
// feed the small, always-on statusBarActivity text -- overloading that stream
// to also drive a prominent banner would require the renderer to distinguish
// "genuine first run" from "routine background rebuild" by string-matching a
// human-readable message, which breaks the moment the wording changes.
// sendIndexingProgress instead only ever fires when populateCacheViaWorker
// captured coldStart=true at call time, so the banner's visibility is a pure
// function of "did I receive one of these events" -- never a warm-start flash.
function sendIndexingProgress(payload) {
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('indexing-progress', payload);
  }
}

let indexingFinished = false;
function isIndexingFinished() { return indexingFinished; }

function sendIndexingFinished() {
  indexingFinished = true;
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('indexing-finished');
  }
}

/** Persist one `{type:'folder'}` result from workers/scan-projects.js.
 *  Delete-then-insert, so re-scanning an already-written folder never
 *  duplicates rows. `folder` already carries the `<alias>::` prefix when the
 *  worker was pointed at a remote mirror. Returns the session count written. */
function writeScannedFolder(r, unverifiedLocalFolder = null) {
  if (!r) {
    if (unverifiedLocalFolder) dropFolderRows(unverifiedLocalFolder, { search: true });
    return 0;
  }
  const { folder, projectPath, sessions, indexMtimeMs } = r;
  stripBridgeEvidence(sessions);
  dropFolderRows(folder, { search: true });
  if (sessions.length > 0) {
    upsertCachedSessions(sessions);
    for (const s of sessions) {
      // Only JSONL custom-title (genuine user title) promotes to the DB name column.
      // AI titles must not -- see refreshFolder for the rationale.
      if (s.customTitle) setTranscriptName(s.sessionId, s.customTitle);
      // Worker called readSessionFile, so dailyMetrics is present.
      replaceSessionMetrics(s.sessionId, s.dailyMetrics);
    }
    upsertSearchEntries(sessions.map(s => {
      // Search title precedence matches the sidebar: user rename > custom-title > ai-title.
      const name = getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
      return {
        id: s.sessionId, type: 'session', folder: s.folder,
        title: (name ? name + ' ' : '') + s.summary,
        body: s.textContent,
      };
    }));
  }
  setFolderMeta(folder, projectPath, indexMtimeMs);
  if (setSetting && pendingRepairFolders().includes(folder)) {
    setSetting('bridge_uuid_reindex_folders', pendingRepairFolders().filter(key => key !== folder));
  }
  return sessions.length;
}

/** Persist one `{type:'folder', result:{partial:true}}` file-subset scan
 *  result. Upserts/deletes only the named rows, never the whole folder --
 *  see .ai/contexts/session-cache.md ("Remote hosts file-level rescan"). */
function writeScannedFolderPartial(r) {
  if (!r) return 0;
  const { folder, projectPath, sessions, toDelete, indexMtimeMs } = r;
  stripBridgeEvidence(sessions);
  if (sessions.length > 0) {
    upsertCachedSessions(sessions);
    for (const s of sessions) {
      if (s.customTitle) setTranscriptName(s.sessionId, s.customTitle);
      replaceSessionMetrics(s.sessionId, s.dailyMetrics);
    }
    for (const s of sessions) deleteSearchSession(s.sessionId);
    upsertSearchEntries(sessions.map(s => {
      const name = getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
      return {
        id: s.sessionId, type: 'session', folder: s.folder,
        title: (name ? name + ' ' : '') + s.summary,
        body: s.textContent,
      };
    }));
  }
  for (const sessionId of (toDelete || [])) {
    if (keepIfRunning(sessionId, folder)) continue;
    deleteCachedSession(sessionId);
    deleteSearchSession(sessionId);
  }
  setFolderMeta(folder, projectPath, indexMtimeMs);
  return sessions.length;
}

// Hard ceiling on one subset scan; a worker that never reports is terminated.
const SUBSET_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

function stripBridgeEvidence(rows) {
  for (const row of rows) {
    delete row.messageUuids;
    delete row.messageUuidsComplete;
    delete row.messageSignatures;
  }
}

// see .ai/contexts/session-cache.md ("Bridge history divergence")
let repairPromise = null;
function pendingRepairFolders() {
  const folders = getSetting?.('bridge_uuid_reindex_folders');
  return Array.isArray(folders) ? folders : [];
}

function reindexRepairedFolders() {
  if (repairPromise) return repairPromise;
  const folders = pendingRepairFolders().filter(key => parseFolderKey(key).alias === null);
  if (!folders.length || !setSetting) return Promise.resolve({ ok: true, folders: 0 });
  repairPromise = (async () => {
    const result = await scanFoldersViaWorker({ projectsDir: PROJECTS_DIR, folders });
    if (!result.ok) {
      log?.warn(`Bridge repair re-index failed: ${result.error}`);
    }
    if (getMainWindow()) notifyRendererProjectsChanged();
    return result;
  })().catch(err => {
    log?.warn(`Bridge repair re-index failed: ${err.message}`);
    return { ok: false, error: err.message };
  }).finally(async () => {
    if (writer.completeRepairFolders) await writer.completeRepairFolders(folders);
    else await writer.setSetting('bridge_uuid_reindex_folders', pendingRepairFolders().filter(key => !folders.includes(key)));
    repairPromise = null;
  });
  return repairPromise;
}

/** Index a caller-chosen subset of folders under an arbitrary projects root.
 *  Rows are keyed `<folderPrefix>::<folder>`. see .ai/contexts/session-cache.md ("Remote SSH hosts")
 *
 *  `fileSubsets` (optional Map<folder, Set<relPathWithinFolder>>) additively
 *  restricts named folders to just those files -- see
 *  .ai/contexts/session-cache.md ("Remote hosts file-level rescan"). */
function scanFoldersViaWorker(options) {
  if (stopping) return Promise.resolve({ ok: false, error: 'indexer shutting down' });
  const promise = scanFoldersViaWorkerInternal(options);
  subsetScans.add(promise);
  promise.finally(() => subsetScans.delete(promise)).catch(() => {});
  return promise;
}
function scanFoldersViaWorkerInternal({ projectsDir, folderPrefix, folders, fileSubsets }) {
  return new Promise((resolve) => {
    const hasFolders = Array.isArray(folders) && folders.length > 0;
    const subsets = fileSubsets instanceof Map ? fileSubsets : null;
    if (!hasFolders && !subsets) {
      resolve({ ok: true, folders: 0, sessions: 0 });
      return;
    }
    const fullFolders = hasFolders ? folders.filter(f => !subsets || !subsets.has(f)) : [];
    const targets = [];
    if (subsets) {
      for (const [folder, files] of subsets) {
        if (hasFolders && !folders.includes(folder)) continue;
        const folderKey = folderPrefix ? joinFolderKey(folderPrefix, folder) : folder;
        targets.push({ folder, files: [...files], existingRows: getCachedByFolder(folderKey) });
      }
    }
    if (fullFolders.length === 0 && targets.length === 0) {
      resolve({ ok: true, folders: 0, sessions: 0 });
      return;
    }

    let settled = false;
    let sessions = 0;
    let scanned = 0;
    let writeError;
    let worker;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker && worker.terminate(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => {
      settle({ ok: false, error: 'folder scan timed out', folders: scanned, sessions });
    }, SUBSET_SCAN_TIMEOUT_MS);

    try {
      worker = new Worker(path.join(__dirname, 'workers', 'scan-projects.js'), {
        workerData: { projectsDir, folderPrefix, folders: fullFolders, targets, remaps: remappedProjectsSetting() },
      });
    } catch (err) {
      settle({ ok: false, error: err.message, folders: 0, sessions: 0 });
      return;
    }

    let writes = Promise.resolve();
    worker.on('message', (msg) => {
      writes = writes.then(async () => {
        if (settled) return;
        if (msg.type === 'folder') {
          scanned++;
          try {
            sessions += msg.result && msg.result.partial
              ? await writer.writeScannedFolderPartial(msg.result)
              : await writer.writeScannedFolder(msg.result, msg.unverifiedLocalFolder);
          } catch (err) {
            writeError = err.message;
            log && log.warn(`[remote] folder write failed: ${err.message}`);
          }
          return;
        }
        settle({ ok: !!msg.ok && !writeError, error: writeError || msg.error, folders: scanned, sessions });
      }).catch(err => { writeError = err.message; settle({ ok: false, error: writeError, folders: scanned, sessions }); });
    });
    worker.on('error', err => { writes.then(() => settle({ ok: false, error: err.message, folders: scanned, sessions })); });
    worker.on('exit', code => { writes.then(() => settle({ ok: code === 0 && !writeError, error: writeError || (code === 0 ? undefined : `worker exited ${code}`), folders: scanned, sessions })); });
  });
}

// --- Worker-based cache population ---
// Returns a Promise that resolves when the in-flight scan finishes. Concurrent
// callers share the same Promise so the first get-projects after a migration
// can await it instead of seeing an empty list.
let populatePromise = null;
let populateRetry = null;
let populateNow = Date.now;

function populateCacheViaWorker() {
  if (stopping) return Promise.resolve();
  if (populatePromise) return populatePromise;
  if (populateRetry && populateNow() < populateRetry.at) return Promise.resolve();
  const retryFolders = populateRetry?.folders;
  const retryAttempt = populateRetry?.attempt || 0;

  // Captured once, up front. Keyed on the persistent completeness marker, not
  // on isCachePopulated(): the worker streams per-folder writes, so a scan
  // interrupted mid-run leaves session_cache non-empty — a row-count check
  // would classify the resumed scan as warm and silently drop its banner.
  // Marker absent covers both a genuine first launch AND the resume after an
  // interruption; it flips true only via setInitialScanComplete() on the
  // worker's final successful done message below.
  const coldStart = !isInitialScanComplete();
  indexingFinished = false;
  sendStatus('Scanning projects…', 'active');

  let scannedFolders = 0;
  let totalFolders = 0;
  let sessionCount = 0;
  let indexedProjects = 0;
  let writeError = null;
  const failedFolders = new Set();
  let scanSucceeded = false;
  let unknownFailure = false;

  // ~4 events/s: one IPC message per folder is wasteful on a large tree (the
  // comparable notifyRendererProjectsChanged is throttled too). The FIRST
  // event (lastProgressAt still 0) and every done event always pass, so the
  // banner appears immediately and never misses the terminal state.
  const PROGRESS_THROTTLE_MS = 250;
  let lastProgressAt = 0;

  const reportProgress = (done, error) => {
    if (!coldStart) {
      if (done) sendIndexingFinished();
      return;
    }
    const now = Date.now();
    if (!done && lastProgressAt !== 0 && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    sendIndexingProgress({
      coldStart: true,
      current: scannedFolders,
      total: totalFolders,
      sessionsSoFar: sessionCount,
      done,
      ...(error ? { error } : {}),
    });
    if (done) sendIndexingFinished();
  };

  populatePromise = new Promise((resolve) => {
    let settled = false;
    let workerExited = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (scanSucceeded) populateRetry = null;
      else {
        const backoff = [30000, 120000, 600000][retryAttempt];
        populateRetry = {
          folders: !unknownFailure && failedFolders.size ? [...failedFolders] : retryFolders || null,
          attempt: retryAttempt + 1,
          at: backoff === undefined ? Infinity : populateNow() + backoff,
        };
      }
      Promise.resolve(workerExited ? undefined : worker.terminate()).catch(() => {}).finally(() => {
        populatePromise = null;
        resolve();
      });
    };

    const worker = new Worker(path.join(__dirname, 'workers', 'scan-projects.js'), {
      workerData: { projectsDir: PROJECTS_DIR, remaps: remappedProjectsSetting(), ...(retryFolders ? { folders: retryFolders } : {}) },
    });

    let writes = Promise.resolve();
    worker.on('message', (msg) => {
      writes = writes.then(async () => {
        if (settled) return;
        // One folder finished scanning. Write it to the DB immediately instead
        // of waiting for the rest of the tree, and push a sidebar update
        // (notifyRendererProjectsChanged is already throttled ~1.5s) so a large
        // history fills in progressively rather than sitting empty for minutes.
        if (msg.type === 'folder') {
          if (msg.rejected) warnRejectedCwd(msg.rejected.folder, msg.rejected.cwd);
          scannedFolders = msg.current;
          totalFolders = msg.total;
          let written = 0;
          try {
            if (msg.error) throw new Error(msg.error);
            written = await writer.writeScannedFolder(msg.result, msg.unverifiedLocalFolder);
          } catch (err) {
            writeError = err.message;
            const folder = msg.folder || msg.result?.folder || msg.unverifiedLocalFolder;
            if (folder) failedFolders.add(folder);
            else unknownFailure = true;
            log && log.error('[session-cache] folder write failed:', err.message);
          }
          if (written > 0) {
            sessionCount += written;
            indexedProjects++;
          }

          sendStatus(`Scanning projects (${scannedFolders}/${totalFolders})…`, 'active');
          reportProgress(false);
          notifyRendererProjectsChanged();
          return;
        }

        // msg.type === 'done'
        if (!msg.ok || writeError) {
          for (const folder of msg.failedFolders || []) failedFolders.add(folder);
          if (!msg.ok && !msg.failedFolders?.length) unknownFailure = true;
          const error = writeError || msg.error;
          console.error('Worker scan error:', error);
          sendStatus('Scan failed: ' + error, 'error');
          reportProgress(true, error);
          settle();
          return;
        }

        if (setInitialScanComplete) await writer.setInitialScanComplete();
        scanSucceeded = true;
        sendStatus(`Indexed ${sessionCount} sessions across ${indexedProjects} projects`, 'done');
        // Clear status after a few seconds
        setTimeout(() => sendStatus(''), 5000);
        reportProgress(true);
        notifyRendererProjectsChanged();
        settle();
      }).catch(err => {
        unknownFailure = true;
        sendStatus('Scan failed: ' + err.message, 'error');
        reportProgress(true, err.message);
        settle();
      });
    });

    worker.on('error', (err) => {
      writes = writes.then(() => {
        if (settled) return;
        unknownFailure = true;
        console.error('Worker error:', err);
        sendStatus('Worker error: ' + err.message, 'error');
        reportProgress(true, err.message);
        settle();
      });
    });

    // If the worker exits abnormally (SIGSEGV, OOM, uncaught exception) without
    // sending a message, neither the 'message' nor 'error' handler will fire.
    // Resolve here so awaiters aren't stuck forever and the next call can retry.
    worker.on('exit', (code) => {
      workerExited = true;
      writes = writes.then(() => {
        if (!settled && code !== 0) {
          unknownFailure = true;
          sendStatus('Scan worker exited unexpectedly', 'error');
          reportProgress(true, 'worker exited unexpectedly');
        }
        settle();
      });
    });
  });

  return populatePromise;
}

async function resolveSessionContinuations(sessionId, { chunkBytes = 1024 * 1024, getSessionLiveElsewhere } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new RangeError('chunkBytes must be a positive integer');
  let diskEntries;
  return resolveContinuations(sessionId, async id => {
    if (!validId(id)) return null;
    const row = getCachedSession?.(id);
    if (!row) {
      const { alias } = parseFolderKey(getCachedSession?.(sessionId)?.folder || '');
      if (alias === null && getSessionLiveElsewhere) {
        const checked = await getSessionLiveElsewhere(id);
        if (!checked?.known) return null;
        if (checked.live) return { index: { ids: [] } };
      }
      const root = alias === null ? PROJECTS_DIR : remoteRoots.get(alias);
      diskEntries ||= fs.promises.readdir(root, { recursive: true, withFileTypes: true });
      const entries = await diskEntries;
      if (entries.some(entry => entry.isFile() && entry.name === id + '.jsonl')) return { waitingForIndex: true };
      return entries.some(entry => entry.isSymbolicLink()) ? null : { missing: true };
    }
    if (row.parentSessionId) return null;
    const file = resolveJsonlPath(resolveFolderDir(row.folder), { ...row, folder: '.' });
    const stat = fs.statSync(file, { bigint: true });
    let serialized = row.continuationIndex, index;
    try { index = JSON.parse(serialized); } catch {}
    const cached = continuationFiles.get(file);
    if (index?.format !== 3 || !index.complete || index.bytes !== Number(stat.size)
      || !(matchesContinuationStamp(index.stamp, stat)
        || (cached?.serialized === serialized && sameContinuationStamp(cached, stat)))) {
      let grew;
      do {
        serialized = scanCachedContinuation(file, id, serialized, chunkBytes);
        if (serialized === null) return null;
        index = JSON.parse(serialized);
        const scanned = continuationFiles.get(file);
        await new Promise(resolve => setImmediate(resolve));
        const after = fs.statSync(file, { bigint: true });
        grew = sameContinuationFile(scanned, after) && after.size > scanned.size;
        if (!sameContinuationStamp(scanned, after) && !grew) {
          continuationFiles.delete(file);
          return null;
        }
      } while (grew || (!index.complete && index.bytes < index.size));
      await writer.setCachedContinuationIndex(id, serialized);
    }
    return { index, modified: getCachedSession(id)?.modified || row.modified };
  });
}

module.exports = { shutdownProducers,
  writeScannedFolder, writeScannedFolderPartial,
  resolveSessionContinuations,
  applyProjectsWorkerEffects,
  resetProjectsWorkerRetainedRows,
  getProjectsWorkerRetainedRows,
  init,
  readSessionFile,
  readFolderFromFilesystem,
  refreshFolder,
  dropFolderRows,
  releaseLiveSession,
  reconcileCacheFromFilesystem,
  buildProjectsFromCache,
  backfillEntrypoints,
  backfillCustomTitles,
  revealIfSdkSession,
  notifyRendererProjectsChanged,
  sendStatus,
  populateCacheViaWorker,
  isIndexingFinished,
  scanFoldersViaWorker,
  reindexRepairedFolders,
  setRemoteRoots,
  getRemoteRoots,
  resolveFolderDir,
};
