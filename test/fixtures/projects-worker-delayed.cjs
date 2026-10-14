'use strict';

const { workerData } = require('node:worker_threads');
const cache = require('../../session-cache');
const reconcile = cache.reconcileCacheFromFilesystem;

cache.reconcileCacheFromFilesystem = options => reconcile({
  ...options,
  onFolder: folder => {
    options.onFolder(folder);
    if (workerData.reconcileFolderDelayMs) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.reconcileFolderDelayMs);
    }
  },
});

require('../../workers/projects-query');
