'use strict';
const { performance } = require('node:perf_hooks');
const store = require('../../session-index-store');
const openStore = require('./conversation-store.cjs');
let clock = 0;
Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });
store.openSessionIndexStore = options => {
  const db = openStore(options);
  const chunkUnit = db.chunkUnit, upsert = db.upsertCachedSessions;
  db.upsertCachedSessions = rows => {
    const result = upsert(rows);
    db.setSetting('applied', (db.getSetting('applied') || '') + rows.map(row => row.sessionId).join(',') + ',');
    return result;
  };
  let calls = 0;
  db.chunkUnit = (fn, count) => {
    const result = chunkUnit(fn, count);
    calls++;
    if (calls === 3) throw Object.assign(new Error('injected lock after three units'), { code: 'SQLITE_BUSY' });
    if (calls === 4) clock += 15;
    return result;
  };
  return db;
};
require('../../workers/session-index-writer');
