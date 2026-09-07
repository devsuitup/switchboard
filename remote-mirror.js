// see .ai/contexts/session-cache.md ("Remote hosts")
'use strict';

const fs = require('fs');
const path = require('path');
const { isSafeRelPath, topFolderOf } = require('./remote-hosts');

const MAX_INVENTORY_ENTRIES = 20_000;

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
 *   listFiles(alias)                  -> Promise<[{ rel, size, mtimeMs }]>
 *   fetchFiles(alias, rels, destRoot) -> Promise<{ fetched: [], failed: [] }>
 */
async function syncMirror({ alias, transport, projectsDir, manifestPath, log }) {
  const inventory = await transport.listFiles(alias);
  if (!Array.isArray(inventory)) throw new Error('transport.listFiles did not return an array');
  if (inventory.length > MAX_INVENTORY_ENTRIES) {
    throw new Error(`remote inventory too large (${inventory.length} entries)`);
  }

  const want = new Map();
  for (const entry of inventory) {
    if (!entry || !isSafeRelPath(entry.rel)) continue;
    if (!topFolderOf(entry.rel)) continue; // a transcript must live under a project folder
    want.set(entry.rel, { size: Number(entry.size) || 0, mtimeMs: Number(entry.mtimeMs) || 0 });
  }

  const previous = readManifest(manifestPath);

  const toFetch = [];
  for (const [rel, meta] of want) {
    const prev = previous[rel];
    const localPath = path.join(projectsDir, rel);
    if (prev && prev.size === meta.size && prev.mtimeMs === meta.mtimeMs && fs.existsSync(localPath)) {
      continue;
    }
    toFetch.push(rel);
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

  const changedFolders = new Set();
  for (const rel of fetched) {
    const folder = topFolderOf(rel);
    if (folder) changedFolders.add(folder);
  }
  if (failed.length === 0) {
    for (const rel of Object.keys(previous)) {
      if (want.has(rel)) continue;
      const folder = topFolderOf(rel);
      if (folder) changedFolders.add(folder);
    }
  }

  return {
    total: want.size,
    fetched: fetched.length,
    failed: failed.length,
    unchanged: want.size - toFetch.length,
    removed,
    changedFolders,
  };
}

module.exports = { syncMirror, readManifest, writeManifest };
