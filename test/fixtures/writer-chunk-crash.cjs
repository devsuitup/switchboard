const store = require('../../session-index-store');
const open = store.openSessionIndexStore;
store.openSessionIndexStore = options => {
  const db = open(options);
  const transact = db.transact;
  let transactions = 0;
  db.transact = fn => {
    const result = transact(fn);
    if (++transactions === 2) process.exit(19);
    return result;
  };
  return db;
};
require('../../workers/session-index-writer');
