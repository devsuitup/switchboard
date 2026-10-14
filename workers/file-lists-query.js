'use strict';

// see .ai/contexts/viewer-panel.md (File list workers)
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { listMemories, listWorkFiles } = require('../file-lists');
const memoryBodies = new Map();
let previousEpoch;

function build(message) {
  const options = { ...workerData, ...message };
  const indexed = new Map(message.indexed || []);
  const touched = new Set();
  const invalidated = new Set(message.invalidated || []);
  if (previousEpoch !== message.epoch) {
    if (message.invalidateAll) memoryBodies.clear();
    else for (const [file, cached] of memoryBodies) {
      if (invalidated.has(file) || invalidated.has(JSON.parse(cached.signature)[2])) memoryBodies.delete(file);
    }
  }
  previousEpoch = message.epoch;
  const readContent = (file, stat) => {
    touched.add(file);
    const signature = JSON.stringify([stat.mtimeMs, stat.size, fs.realpathSync(file)]);
    let cached = memoryBodies.get(file);
    if (!cached || cached.signature !== signature) {
      const content = fs.readFileSync(file, 'utf8');
      cached = { signature, content: content.slice(0, 32768), nonempty: !!content.trim() };
      memoryBodies.set(file, cached);
    }
    return cached;
  };
  const listing = message.kind === 'memory' ? listMemories(options, readContent) : listWorkFiles(options);
  for (const file of memoryBodies.keys()) if (!touched.has(file)) memoryBodies.delete(file);
  const manifest = new Map();
  const upserts = new Map();
  for (const file of listing.files) {
    let signature;
    if (message.kind === 'memory') signature = JSON.stringify([memoryBodies.get(file.filePath)?.signature, file.title]);
    else signature = JSON.stringify([file.modified, file.size, file.title]);
    manifest.set(file.filePath, signature);
    const target = message.kind === 'memory' ? JSON.parse(memoryBodies.get(file.filePath).signature)[2] : file.filePath;
    if (!message.invalidateAll && !invalidated.has(target) && !invalidated.has(file.filePath) && indexed.get(file.filePath) === signature) continue;
    let body = '';
    if (message.kind === 'memory') body = listing.bodies.get(file.filePath) ?? '';
    else if (!file.relativePath.endsWith('.jsonl') && file.size <= 64 * 1024) {
      try { body = fs.readFileSync(file.filePath, 'utf8'); } catch {}
    }
    upserts.set(file.filePath, { id: file.filePath, type: message.kind, folder: null, title: file.title, body: body.slice(0, 32768) });
  }
  return {
    view: listing.view, entries: listing.files.length, manifest: [...manifest], upserts: [...upserts.values()],
    deletes: [...indexed.keys()].filter(file => !manifest.has(file)),
  };
}

parentPort.on('message', message => {
  try { parentPort.postMessage({ id: message.id, result: build(message) }); }
  catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
});
