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

test('browser quit exception is logged and bounded shutdown still completes once', async () => {
  const filename = require.resolve('../main'); const events = [];
  const context = vm.createContext({ shutdownPromise: null,
    managedBrowser: { stopForQuit: () => { events.push('browser'); throw new Error('browser quit failed'); } },
    boundedShutdown: () => { events.push('drain'); return Promise.resolve(); },
    stopWorkersForExit: async () => { events.push('workers'); return true; },
    log: { error: (...args) => events.push(args.map(String).join(' ')) }, shutdownComplete: false,
  });
  vm.runInContext(extractFunction(fs.readFileSync(filename, 'utf8'), 'shutdownForExit'), context, { filename });
  let first;
  assert.doesNotThrow(() => { first = context.shutdownForExit(); });
  assert.equal(context.shutdownForExit(), first);
  await first;
  assert.equal(context.shutdownComplete, true);
  assert.equal(events.filter(event => event === 'browser').length, 1);
  assert.ok(events.some(event => event.includes('browser quit failed')));
  assert.ok(events.includes('drain')); assert.ok(events.includes('workers'));
});
