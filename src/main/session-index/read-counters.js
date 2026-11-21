'use strict';
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
let current = null;

function countBytes(bytes, body = false) {
  if (current) {
    current[body || current.bodyDepth ? 'bytesRead' : 'auxiliaryBytesRead'] += bytes;
    if (current.bodyDepth && current.file) current.readFiles.add(current.file);
  }
}

function bodyRead(file, read) {
  if (!current) return read();
  current.readOperations++;
  const previousFile = current.file;
  current.file = file;
  current.bodyDepth++;
  try { const value = read(); current.readFiles.add(file); return value; }
  catch (error) { current.failedFiles.add(file); throw error; }
  finally { current.bodyDepth--; current.file = previousFile; }
}

function readBodyFile(file) {
  return bodyRead(file, () => {
    const bytes = fs.readFileSync(file);
    countBytes(bytes.length, true);
    return bytes;
  });
}

function readAuxiliaryFile(file) {
  const bytes = fs.readFileSync(file);
  if (current) current.auxiliaryBytesRead += bytes.length;
  return bytes;
}

function enumerateReads(files) {
  if (current) for (const file of files) {
    try { current.enumeratedFiles.set(file, fs.statSync(file).size); } catch {}
  }
}

function failedRead(file) { current?.failedFiles.add(file); }

function measureFolder(read) {
  const previous = current;
  const counters = { readFiles: new Set(), failedFiles: new Set(), enumeratedFiles: new Map(), bodyDepth: 0,
    readOperations: 0, bytesRead: 0, auxiliaryBytesRead: 0 };
  current = counters;
  const started = performance.now();
  let result, failure;
  try { result = read(); } catch (error) { failure = error; }
  try {
    const skipped = [...counters.enumeratedFiles].filter(([file]) => !counters.readFiles.has(file) && !counters.failedFiles.has(file));
    const stats = { filesEnumerated: counters.enumeratedFiles.size, filesRead: counters.readFiles.size,
      filesSkipped: skipped.length, filesDeleted: result?.toDelete?.length || 0, filesFailed: Math.max(counters.failedFiles.size, failure ? 1 : 0),
      readOperations: counters.readOperations, bytesRead: counters.bytesRead, bytesSkipped: skipped.reduce((sum, [, size]) => sum + size, 0),
      auxiliaryBytesRead: counters.auxiliaryBytesRead, scanMs: performance.now() - started };
    if (failure) { failure.counters = stats; throw failure; }
    return { result, counters: stats };
  } finally { current = previous; }
}

module.exports = { countBytes, bodyRead, readBodyFile, readAuxiliaryFile, enumerateReads, measureFolder, failedRead };
