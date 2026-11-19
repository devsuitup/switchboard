'use strict';
const store = require('../../session-index-store');
const openStore = require('./conversation-store.cjs');
const spin = ms => { const until = performance.now() + ms; while (performance.now() < until); };
store.openSessionIndexStore = options => {
  const db = openStore(options);
  const chunkUnit = db.chunkUnit;
  db.chunkUnit = (fn, count) => { spin(15); return chunkUnit(fn, count); };
  return db;
};
require('../../workers/session-index-writer');
