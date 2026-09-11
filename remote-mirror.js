// see .ai/contexts/session-cache.md ("Remote hosts")
'use strict';

const fs = require('fs');
const path = require('path');
const { isSafeMirrorRelPath, topFolderOf } = require('./remote-hosts');

const MAX_INVENTORY_ENTRIES = 20_000;
// Per-file ceiling: scp is bounded in time, never in bytes.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CYCLE_FILES = 500;
const MAX_CYCLE_BYTES = 256 * 1024 * 1024;

// see .ai/contexts/session-cache.md ("Remote hosts — incremental fetch")
const cycleStreaks = new Map(); // manifestPath -> Map<rel, count>

function isLogTier(count) {
  return count === 1 || (count & (count - 1)) === 0; // 1, 2, 4, 8, 16, ...
}

// Returns { count, shouldLog }. see .ai/contexts/session-cache.md ("Remote hosts — incremental fetch")
function bumpStreak(manifestPath, rel) {
  let streaks = cycleStreaks.get(manifestPath);
  if (!streaks) { streaks = new Map(); cycleStreaks.set(manifestPath, streaks); }
  const count = (streaks.get(rel) || 0) + 1;
  streaks.set(rel, count);
  return { count, shouldLog: isLogTier(count) };
}

function pruneStreaks(manifestPath, seenThisCycle) {
  const streaks = cycleStreaks.get(manifestPath);
  if (!streaks) return;
  for (const rel of [...streaks.keys()]) {
    if (!seenThisCycle.has(rel)) streaks.delete(rel);
  }
}

function readManifest(manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
      return parsed.files;
    }
  } catch {}
  return {};
}

function writeManifest(manifestPath, files) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = manifestPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, files }), 'utf8');
  fs.renameSync(tmp, manifestPath);
}

function pruneEmptyDirs(root, dir) {
  let current = dir;
  while (current.startsWith(root) && current !== root) {
    let entries;
    try { entries = fs.readdirSync(current); } catch { return; }
    if (entries.length > 0) return;
    try { fs.rmdirSync(current); } catch { return; }
    current = path.dirname(current);
  }
}

/**
 * Bring the local mirror of one host in line with its remote inventory.
 * Injected transport:
 *   listFiles(alias)                            -> Promise<{ files: [{ rel, size, mtimeMs }], sessions: [object] }>
 *   fetchFiles(alias, rels, destRoot)            -> Promise<{ fetched: [], failed: [] }>
 *   fetchIncremental(alias, requests, destRoot)  -> Promise<{ fetched: [], failed: [] }> (optional;
 *     requests is [{ rel, offset }]; a transport without it gets the same
 *     files routed through fetchFiles instead — see "Remote hosts —
 *     incremental fetch" in .ai/contexts/session-cache.md)
 */
async function syncMirror({ alias, transport, projectsDir, manifestPath, log }) {
  const { files, sessions } = await transport.listFiles(alias);
  if (!Array.isArray(files)) throw new Error('transport.listFiles did not return a files array');
  if (files.length > MAX_INVENTORY_ENTRIES) {
    throw new Error(`remote inventory too large (${files.length} entries)`);
  }

  const want = new Map();
  for (const entry of files) {
    if (!entry || !isSafeMirrorRelPath(entry.rel)) continue;
    if (!topFolderOf(entry.rel)) continue; // a transcript must live under a project folder
    want.set(entry.rel, { size: Number(entry.size) || 0, mtimeMs: Number(entry.mtimeMs) || 0 });
  }

  const previous = readManifest(manifestPath);

  // pass 1: full vs incremental per file — see .ai/contexts/session-cache.md ("Remote hosts — incremental fetch")
  const seenThisCycle = new Set();
  let skippedTooLarge = 0;
  const candidates = [];
  for (const [rel, meta] of want) {
    // The inventory already carries the size; scp is bounded in time only, so
    // this is the only place a single oversized transcript can be refused
    // before it lands. See .ai/contexts/session-cache.md, "Remote hosts".
    if (meta.size > MAX_FILE_BYTES) {
      skippedTooLarge++;
      seenThisCycle.add(rel);
      const { count, shouldLog } = bumpStreak(manifestPath, rel);
      if (shouldLog && log && log.warn) {
        log.warn(`[remote:${alias}] ${rel} skipped: over ${MAX_FILE_BYTES} bytes (${count}x consecutive)`);
      }
      continue;
    }
    const prev = previous[rel];
    const localPath = path.join(projectsDir, rel);
    if (prev && prev.size === meta.size && prev.mtimeMs === meta.mtimeMs && fs.existsSync(localPath)) {
      continue;
    }

    let mode = 'full';
    let offset = 0;
    // see .ai/contexts/session-cache.md ("Remote hosts — incremental fetch") for the invalidation rule
    if (!rel.endsWith('.meta.json') && prev && meta.size > prev.size && meta.mtimeMs >= prev.mtimeMs) {
      let localSize = -1;
      try { localSize = fs.statSync(localPath).size; } catch {}
      if (localSize === prev.size) {
        mode = 'incremental';
        offset = localSize;
      }
    }
    const transferSize = mode === 'incremental' ? (meta.size - offset) : meta.size;
    const isMeta = rel.endsWith('.meta.json') ? 1 : 0;
    candidates.push({ rel, meta, mode, offset, transferSize, isMeta });
  }

  // pass 2: transcripts first, then transfer size ascending — see .ai/contexts/session-cache.md (cycle ordering)
  candidates.sort((a, b) => (a.isMeta - b.isMeta) || (a.transferSize - b.transferSize));

  const toFetchFull = [];
  const toFetchIncremental = [];
  let cycleBytes = 0;
  let deferredFiles = 0;
  let deferredBytes = 0;
  for (const c of candidates) {
    const wouldExceedCount = (toFetchFull.length + toFetchIncremental.length) >= MAX_CYCLE_FILES;
    const wouldExceedBytes = cycleBytes + c.transferSize > MAX_CYCLE_BYTES;
    if (!wouldExceedCount && !wouldExceedBytes) {
      if (c.mode === 'incremental') toFetchIncremental.push({ rel: c.rel, offset: c.offset });
      else toFetchFull.push(c.rel);
      cycleBytes += c.transferSize;
    } else {
      deferredFiles++;
      deferredBytes += c.transferSize;
      seenThisCycle.add(c.rel);
      const { count, shouldLog } = bumpStreak(manifestPath, c.rel);
      if (shouldLog && log && log.warn) {
        const reason = wouldExceedCount
          ? 'deferred to next cycle: over the per-cycle file-count ceiling'
          : `deferred to next cycle: ${c.transferSize} bytes over the per-cycle byte ceiling`;
        log.warn(`[remote:${alias}] ${c.rel} ${reason} (${count}x consecutive)`);
      }
    }
  }
  pruneStreaks(manifestPath, seenThisCycle);

  let fetched = [];
  let failed = [];
  if (toFetchFull.length > 0) {
    const result = await transport.fetchFiles(alias, toFetchFull, projectsDir);
    fetched.push(...(Array.isArray(result?.fetched) ? result.fetched : []));
    failed.push(...(Array.isArray(result?.failed) ? result.failed : []));
  }
  if (toFetchIncremental.length > 0) {
    // no fetchIncremental on the transport: route through fetchFiles instead
    const result = typeof transport.fetchIncremental === 'function'
      ? await transport.fetchIncremental(alias, toFetchIncremental, projectsDir)
      : await transport.fetchFiles(alias, toFetchIncremental.map(r => r.rel), projectsDir);
    fetched.push(...(Array.isArray(result?.fetched) ? result.fetched : []));
    failed.push(...(Array.isArray(result?.failed) ? result.failed : []));
  }

  const fetchedSet = new Set(fetched);
  const attempted = new Set([...toFetchFull, ...toFetchIncremental.map(r => r.rel)]);
  const nextFiles = {};
  for (const [rel, meta] of want) {
    if (fetchedSet.has(rel)) { nextFiles[rel] = meta; continue; }
    const prev = previous[rel];
    if (prev && !attempted.has(rel)) nextFiles[rel] = prev;
  }

  // Deletions only run on a clean pull. see .ai/contexts/session-cache.md ("Remote SSH hosts")
  let removed = 0;
  if (failed.length === 0) {
    for (const rel of Object.keys(previous)) {
      if (want.has(rel)) continue;
      const localPath = path.join(projectsDir, rel);
      try {
        fs.rmSync(localPath, { force: true });
        removed++;
        pruneEmptyDirs(projectsDir, path.dirname(localPath));
      } catch (err) {
        if (log) log.warn(`[remote:${alias}] could not remove ${rel}: ${err.message}`);
      }
    }
  }

  // A partial run skipped its deletions; keep them owed for the next run.
  if (failed.length > 0) {
    for (const [rel, prev] of Object.entries(previous)) {
      if (nextFiles[rel] || want.has(rel)) continue;
      if (fs.existsSync(path.join(projectsDir, rel))) nextFiles[rel] = prev;
    }
  }

  writeManifest(manifestPath, nextFiles);

  // see .ai/contexts/session-cache.md ("Remote hosts file-level rescan" and
  // "Remote hosts — meta.json sidecars")
  const changedFolders = new Set();
  const changedFilesByFolder = new Map();
  const markChanged = (rel) => {
    const folder = topFolderOf(rel);
    if (!folder) return;
    changedFolders.add(folder);
    // see .ai/contexts/session-cache.md ("Remote hosts — meta.json sidecars")
    const targetRel = rel.endsWith('.meta.json') ? rel.slice(0, -'.meta.json'.length) + '.jsonl' : rel;
    let set = changedFilesByFolder.get(folder);
    if (!set) { set = new Set(); changedFilesByFolder.set(folder, set); }
    set.add(targetRel.slice(folder.length + 1));
  };
  for (const rel of fetched) markChanged(rel);
  if (failed.length === 0) {
    for (const rel of Object.keys(previous)) {
      if (want.has(rel)) continue;
      markChanged(rel);
    }
  }

  return {
    total: want.size,
    fetched: fetched.length,
    failed: failed.length,
    unchanged: want.size - (toFetchFull.length + toFetchIncremental.length),
    removed,
    changedFolders,
    changedFilesByFolder,
    sessions: Array.isArray(sessions) ? sessions : [],
  };
}

module.exports = { syncMirror, readManifest, writeManifest, MAX_CYCLE_FILES, MAX_CYCLE_BYTES, MAX_FILE_BYTES };
