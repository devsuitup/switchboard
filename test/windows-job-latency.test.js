'use strict';

const test = require('node:test');
const { runNative } = require('./windows-job-native-runner');

test('Windows jobs native: ten cold helper latency samples',
  { skip: process.platform !== 'win32' && 'Windows job APIs only' }, t => {
    runNative(t, 'latencies');
  });
