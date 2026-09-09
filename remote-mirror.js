// see .ai/contexts/session-cache.md ("Remote hosts")
'use strict';

const fs = require('fs');
const path = require('path');
const { isSafeRelPath, topFolderOf } = require('./remote-hosts');

const MAX_INVENTORY_ENTRIES = 20_000;
// Per-file ceiling: scp is bounded in time, never in bytes.
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CYCLE_FILES = 500;
const MAX_CYCLE_BYTES = 256 * 1024 * 1024;

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
 *   listFiles(alias)                  -> Promise<{ files: [{ rel, size, mtimeMs }], sessions: [object] }>
 *   fetchFiles(alias, rels, destRoot) -> Promise<{ fetched: [], failed: [] }>
 */
async function syncMirror({ alias, transport, projectsDir, manifestPath, log }) {
  const { files, sessions } = await transport.listFiles(alias);
  if (!Array.isArray(files)) throw new Error('transport.listFiles did not return a files array');
  if (files.length > MAX_INVENTORY_ENTRIES) {
    throw new Error(`remote inventory too large (${files.length} entries)`);
  }

  const want = new Map();
  for (const entry of files) {
    if (!entry || !isSafeRelPath(entry.rel)) continue;
    if (!topFolderOf(entry.rel)) continue; // a transcript must live under a project folder
    want.set(entry.rel, { size: Number(entry.size) || 0, mtimeMs: Number(entry.mtimeMs) || 0 });
  }

  const previous = readManifest(manifestPath);

  const toFetch = [];
  let skippedTooLarge = 0;
  let cycleBytes = 0;
  let cycleFull = false;
  let deferredFiles = 0;
  let deferredBytes = 0;
  for (const [rel, meta] of want) {
    // The inventory already carries the size; scp is bounded in time only, so
    // this is the only place a single oversized transcript can be refused
    // before it lands. See .ai/contexts/session-cache.md, "Remote hosts".
    if (meta.size > MAX_FILE_BYTES) {
      skippedTooLarge++;
      continue;
    }
    const prev = previous[rel];
    const localPath = path.join(projectsDir, rel);
    if (prev && prev.size === meta.size && prev.mtimeMs === meta.mtimeMs && fs.existsSync(localPath)) {
      continue;
    }
    if (!cycleFull && toFetch.length < MAX_CYCLE_FILES && cycleBytes + meta.size <= MAX_CYCLE_BYTES) {
      toFetch.push(rel);
      cycleBytes += meta.size;
    } else {
      cycleFull = true;
      deferredFiles++;
      deferredBytes += meta.size;
    }
  }
  if (skippedTooLarge && log && log.warn) {
    log.warn(`[remote:${alias}] ${skippedTooLarge} file(s) skipped: over ${MAX_FILE_BYTES} bytes`);
  }
  if (deferredFiles && log && log.warn) {
    log.warn(`[remote:${alias}] ${deferredFiles} file(s) deferred to next cycle: ${deferredBytes} bytes over the per-cycle ceiling`);
  }

  let fetched = [];
  let failed = [];
  if (toFetch.length > 0) {
    const result = await transport.fetchFiles(alias, toFetch, projectsDir);
    fetched = Array.isArray(result?.fetched) ? result.fetched : [];
    failed = Array.isArray(result?.failed) ? result.failed : [];
  }

  const fetchedSet = new Set(fetched);
  const attempted = new Set(toFetch);
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

  // see .ai/contexts/session-cache.md ("Remote hosts file-level rescan")
  const changedFolders = new Set();
  const changedFilesByFolder = new Map();
  const markChanged = (rel) => {
    const folder = topFolderOf(rel);
    if (!folder) return;
    changedFolders.add(folder);
    let set = changedFilesByFolder.get(folder);
    if (!set) { set = new Set(); changedFilesByFolder.set(folder, set); }
    set.add(rel.slice(folder.length + 1));
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
    unchanged: want.size - toFetch.length,
    removed,
    changedFolders,
    changedFilesByFolder,
    sessions: Array.isArray(sessions) ? sessions : [],
  };
}

module.exports = { syncMirror, readManifest, writeManifest, MAX_CYCLE_FILES, MAX_CYCLE_BYTES, MAX_FILE_BYTES };
