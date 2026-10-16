'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { readSessionDisplayHeader } = require('../read-session-file');

let pairs = [];
for (const row of workerData.files) {
  const header = readSessionDisplayHeader(row.file);
  if (!header || (row.fileMtime && header.modified !== row.fileMtime)) continue;
  pairs.push({ sessionId: row.sessionId, fileMtime: row.fileMtime,
    customTitle: header.tailTitle || header.headTitle || '' });
  if (pairs.length === 200) { parentPort.postMessage(pairs); pairs = []; }
}
if (pairs.length) parentPort.postMessage(pairs);
