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
  if (current) for (const file of files) current.enumeratedFiles.add(file);
}

function failedRead(file) { current?.failedFiles.add(file); }

function measureFolder(read) {
  const previous = current;
  const counters = { readFiles: new Set(), failedFiles: new Set(), enumeratedFiles: new Set(), bodyDepth: 0,
    readOperations: 0, bytesRead: 0, auxiliaryBytesRead: 0 };
  current = counters;
  const started = performance.now();
  try {
    const result = read();
    const stats = { filesEnumerated: counters.enumeratedFiles.size, filesRead: counters.readFiles.size,
      filesSkipped: 0, filesDeleted: result?.toDelete?.length || 0, filesFailed: counters.failedFiles.size,
      readOperations: counters.readOperations, bytesRead: counters.bytesRead, bytesSkipped: 0,
      auxiliaryBytesRead: counters.auxiliaryBytesRead, scanMs: performance.now() - started };
    return { result, counters: stats };
  } finally { current = previous; }
}

module.exports = { countBytes, bodyRead, readBodyFile, readAuxiliaryFile, enumerateReads, measureFolder, failedRead };
