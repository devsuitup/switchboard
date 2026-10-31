// see .ai/contexts/session-cache.md ("Oversized remote transcripts (#699)")
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readManifest, writeManifest } = require('./remote-mirror');
const { isSafeRelPath } = require('./remote-hosts');
const { MAX_SESSION_DESCRIPTORS } = require('./remote-transport');

async function syncTurnTails({ alias, transport, projectsDir, oversizedFiles = [], sessions = [], log }) {
  const root = path.join(path.dirname(projectsDir), 'turn-state');
  const manifestPath = path.join(root, 'inventory.json');
  const previous = readManifest(manifestPath);
  const live = new Set(sessions.slice(0, MAX_SESSION_DESCRIPTORS).map(s => s?.sessionId));
  const wanted = oversizedFiles.filter(f => isSafeRelPath(f.rel) && f.rel.split('/').length === 2
    && live.has(path.posix.basename(f.rel, '.jsonl'))).slice(0, MAX_SESSION_DESCRIPTORS);
  const next = {};
  const rows = [];
  for (const { rel, size, mtimeMs } of wanted) {
    const file = path.join(root, rel + '.tail');
    const prev = previous[rel];
    let available = fs.existsSync(file) && prev?.partial === true;
    if (!available || prev.size !== size || prev.mtimeMs !== mtimeMs) {
      try {
        if (typeof transport.readTurnTail !== 'function') throw new Error('transport does not support turn-state tails');
        await transport.readTurnTail(alias, { rel, mtimeMs }, file);
        next[rel] = { size, mtimeMs, partial: true };
        available = true;
        log.info(`[remote:${alias}] ${rel} turn-state tail refreshed; full transcript is not mirrored`);
      } catch (err) {
        log.warn(`[remote:${alias}] ${rel} turn-state tail failed: ${err.message}`);
        if (available) next[rel] = prev;
      }
    } else next[rel] = prev;
    if (available) rows.push({ alias, file, parentSessionId: path.posix.basename(rel, '.jsonl'), turnOnly: true });
  }
  const keep = new Set(wanted.map(f => f.rel));
  for (const rel of Object.keys(previous)) {
    if (!isSafeRelPath(rel) || keep.has(rel)) continue;
    fs.rmSync(path.join(root, rel + '.tail'), { force: true });
  }
  if (wanted.length || Object.keys(previous).length) writeManifest(manifestPath, next);
  return rows;
}

module.exports = { syncTurnTails };
