'use strict';

const fs = require('fs');

const DEFAULT_DELAYS = [10, 30, 100, 300];
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function renameWithRetry(src, dest, {
  attempts = 5, delays = DEFAULT_DELAYS,
  sleep = ms => Atomics.wait(sleepBuffer, 0, 0, ms), rename = fs.renameSync,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5
      || !Array.isArray(delays) || delays.length < attempts - 1
      || delays.slice(0, attempts - 1).some(ms => !Number.isFinite(ms) || ms < 0)
      || delays.slice(0, attempts - 1).reduce((sum, ms) => sum + ms, 0) >= 500) {
    throw new RangeError('rename retries require 1-5 attempts and delays totalling less than 500 ms');
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return rename(src, dest);
    } catch (err) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)
          || attempt === attempts - 1) throw err;
      sleep(delays[attempt]);
    }
  }
}

module.exports = { renameWithRetry };
