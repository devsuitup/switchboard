const store = require('../../session-index-store');
const open = store.openSessionIndexStore;
store.openSessionIndexStore = options => {
  const db = open(options);
  const chunkUnit = db.chunkUnit;
  let units = 0;
  db.chunkUnit = (fn, count) => {
    const result = chunkUnit(fn, count);
    if (++units === 3) throw Object.assign(new Error('injected lock after three units'), { code: 'SQLITE_BUSY' });
    return result;
  };
  return db;
};
require('../../workers/session-index-writer');
