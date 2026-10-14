'use strict';

// see .ai/contexts/session-cache.md (Startup indexing worker)
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { readNewSessionSignals } = require('../session-transitions');
const { readSubagentMeta } = require('../read-session-file');
const { scanContinuationIndex } = require('../session-continuations');

function scan(message) {
  const dir = path.join(message.projectsDir, message.folder);
  const observations = { available: true, files: [], stats: new Map(), directories: new Map(),
    signals: new Map(), meta: new Map(), continuations: new Map() };
  try { observations.files = fs.readdirSync(dir).filter(file => file.endsWith('.jsonl')); }
  catch { observations.available = false; return { observations }; }
  const needed = new Set();
  const stat = file => {
    try {
      const value = fs.statSync(file);
      observations.stats.set(file, { size: value.size, mtimeMs: value.mtimeMs });
      return true;
    } catch { return false; }
  };
  for (const session of message.sessions) {
    const sourceId = session.realSessionId || session.id;
    const source = path.join(dir, sourceId + '.jsonl');
    if (stat(source)) {
      try {
        const index = scanContinuationIndex(source, sourceId, session.continuationIndex);
        observations.continuations.set(sourceId, index);
        for (const target of JSON.parse(index).ids) needed.add(target + '.jsonl');
      } catch {}
    }
    const knownFiles = new Set(session.knownJsonlFiles || []);
    for (const file of observations.files) if (!knownFiles.has(file)) needed.add(file);
    const subdir = path.join(dir, sourceId, 'subagents');
    if (!stat(subdir)) continue;
    let files;
    try { files = fs.readdirSync(subdir).filter(file => file.endsWith('.jsonl')); } catch { continue; }
    observations.directories.set(subdir, files);
    const known = new Map(session.knownSubagents || []);
    for (const file of files) {
      const id = file.match(/^agent-(.+)\.jsonl$/)?.[1];
      if (!id) continue;
      const previous = known.get(id);
      if (previous?.completed && !previous._recheckStart) continue;
      const full = path.join(subdir, file);
      if (stat(full)) observations.meta.set(full, readSubagentMeta(full));
    }
  }
  for (const file of needed) {
    const full = path.join(dir, file);
    if (!stat(full)) continue;
    observations.signals.set(full, readNewSessionSignals(full));
  }
  return { observations };
}

parentPort.on('message', message => {
  try { parentPort.postMessage({ id: message.id, type: 'done', result: scan(message) }); }
  catch (error) { parentPort.postMessage({ id: message.id, type: 'done', error: error.message }); }
});
