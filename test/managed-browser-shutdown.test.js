'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { extractFunction } = require('./app-source');

test('source quit signals browser synchronously after the repeat guard and before bounded drain', () => {
  const filename = require.resolve('../main');
  const events = [], pending = Promise.resolve();
  const context = vm.createContext({ shutdownPromise: null, queueMicrotask,
    managedBrowser: { stopForQuit: () => { events.push('browser'); } },
    boundedShutdown: () => { events.push('drain'); return pending; },
    stopWorkersForExit: async () => {}, log: { error() {} }, shutdownComplete: false,
  });
  vm.runInContext(extractFunction(fs.readFileSync(filename, 'utf8'), 'shutdownForExit'), context, { filename });
  const first = context.shutdownForExit();
  assert.deepEqual(events, ['browser', 'drain']);
  assert.equal(context.shutdownForExit(), first);
  assert.deepEqual(events, ['browser', 'drain']);
});
