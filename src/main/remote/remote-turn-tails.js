// see .ai/contexts/session-cache.md ("Oversized remote transcripts (#699)")
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readManifest, writeManifest } = require('./remote-mirror');
const { isSafeRelPath } = require('./remote-hosts');
const { MAX_SESSION_DESCRIPTORS } = require('./remote-transport');

const tailLogStates = new WeakMap();

async function syncTurnTails({ alias, transport, projectsDir, oversizedFiles = [], sessions = [], log, cancelled = () => false }) {
  if (cancelled()) return [];
  const root = path.join(path.dirname(projectsDir), 'turn-state');
  const manifestPath = path.join(root, 'inventory.json');
  const owner = transport || log;
  let roots = tailLogStates.get(owner);
  if (!roots) tailLogStates.set(owner, roots = new Map());
  let entry = roots.get(root);
  if (!entry) roots.set(root, entry = { heads: new Map(), notes: new Map() });
  const states = entry.heads;
  const warnOnce = (key, err, line) => {
    const signature = err.code || err.name;
    if (entry.notes.get(key) !== signature) log.warn(line);
    entry.notes.set(key, signature);
  };
  const previous = readManifest(manifestPath);
  const live = new Set(sessions.slice(0, MAX_SESSION_DESCRIPTORS).map(s => s?.sessionId));
  const wanted = oversizedFiles.filter(f => isSafeRelPath(f.rel) && f.rel.split('/').length === 2
    && live.has(path.posix.basename(f.rel, '.jsonl'))).slice(0, MAX_SESSION_DESCRIPTORS);
  const next = {};
  const rows = [];
  for (const { rel, size, mtimeMs } of wanted) {
    if (cancelled()) return [];
    const file = path.join(root, rel + '.tail');
    const prev = previous[rel];
    let available = fs.existsSync(file) && prev?.partial === true;
    if (!available || prev.size !== size || prev.mtimeMs !== mtimeMs) {
      try {
        if (typeof transport.readTurnTail !== 'function') throw new Error('transport does not support turn-state tails');
        await transport.readTurnTail(alias, { rel, mtimeMs }, file);
        if (cancelled()) return [];
        next[rel] = { size, mtimeMs, partial: true };
        available = true;
        if (states.get(rel) !== 'ok') log.info(`[remote:${alias}] ${rel} turn-state tail refreshed; full transcript is not mirrored`);
        states.set(rel, 'ok');
      } catch (err) {
        if (cancelled()) return [];
        const signature = `error:${err.message}`;
        if (states.get(rel) !== signature) log.warn(`[remote:${alias}] ${rel} turn-state tail failed: ${err.message}`);
        states.set(rel, signature);
        if (available) next[rel] = prev;
      }
    } else next[rel] = prev;
    if (available) rows.push({ alias, file, parentSessionId: path.posix.basename(rel, '.jsonl'), turnOnly: true });
  }
  const keep = new Set(wanted.map(f => f.rel));
  for (const rel of states.keys()) {
    if (!keep.has(rel)) states.delete(rel);
  }
  const owed = new Set();
  for (const rel of Object.keys(previous)) {
    if (!isSafeRelPath(rel) || keep.has(rel)) continue;
    try {
      fs.rmSync(path.join(root, rel + '.tail'), { force: true });
    } catch (err) {
      next[rel] = previous[rel];
      owed.add(`remove:${rel}`);
      warnOnce(`remove:${rel}`, err, `[remote:${alias}] could not remove ${rel} turn-state tail: ${err.message}`);
    }
  }
  if (wanted.length || Object.keys(previous).length) {
    try {
      writeManifest(manifestPath, next);
    } catch (err) {
      owed.add('manifest');
      warnOnce('manifest', err, `[remote:${alias}] could not write turn-state tail manifest: ${err.message}`);
    }
  }
  for (const key of [...entry.notes.keys()]) {
    if (!owed.has(key)) entry.notes.delete(key);
  }
  if (!states.size && !entry.notes.size) roots.delete(root);
  return rows;
}

module.exports = { syncTurnTails };
