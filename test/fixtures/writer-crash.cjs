'use strict';
const { workerData } = require('node:worker_threads');
const storeModule = require('../../session-index-store');
const open = storeModule.openSessionIndexStore;
storeModule.openSessionIndexStore = options => {
  const store = open(options);
  const transact = store.transact;
  store.transact = command => {
    if (workerData.phase === 'before-commit') return transact(() => { command(); process.exit(17); });
    transact(command);
    process.exit(18);
  };
  return store;
};
require('../../workers/session-index-writer');
