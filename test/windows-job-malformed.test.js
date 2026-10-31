'use strict';

const test = require('node:test');
const { runNative } = require('./windows-job-native-runner');

test('Windows jobs native: malformed argv does not abort sibling cleanup',
  { skip: process.platform !== 'win32' && 'Windows job APIs only' }, async t => {
    await new Promise(resolve => setImmediate(resolve));
    runNative(t, 'malformed');
  });
