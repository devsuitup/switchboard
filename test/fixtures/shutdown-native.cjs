'use strict';

const { parentPort } = require('node:worker_threads');
const Database = require('better-sqlite3');

require('../../workers/session-index-writer');

parentPort.on('message', message => {
  if (!message.nativeBlock) return;
  const db = new Database(':memory:');
  parentPort.postMessage({ nativeStarted: true });
  db.prepare('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get();
  db.close();
});
