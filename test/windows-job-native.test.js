'use strict';

const test = require('node:test');
const { runNative } = require('./windows-job-native-runner');

for (const mode of ['simultaneous', 'helper-death', 'helper-timeout', 'pipe-eof', 'release', 'shutdown', 'pid-guard', 'detached',
  'daemon', 'worker', 'roster', 'stale-roster', 'daemon-eof', 'parent-exit', 'lookalike']) {
  test(`Windows jobs native: ${mode}`, { skip: process.platform !== 'win32' && 'Windows job APIs only' }, async t => {
    await new Promise(resolve => setImmediate(resolve));
    runNative(t, mode);
  });
}
