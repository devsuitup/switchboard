'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cache = require('../session-cache');
const { fixture, OLD } = require('./fixtures/continuation-718.cjs');

test('the delayed worker fixture wraps async reconciliation and delays after folder progress', async t => {
  const h = fixture(t); h.write(OLD);
  const reconcile = cache.reconcileCacheFromFilesystemAsync, sync = cache.reconcileCacheFromFilesystem;
  t.after(() => { cache.reconcileCacheFromFilesystemAsync = reconcile; cache.reconcileCacheFromFilesystem = sync; });
  const events = [];
  const filename = path.join(__dirname, 'fixtures/projects-worker-delayed.cjs');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === 'node:worker_threads') return { workerData: { reconcileFolderDelayMs: 17 } };
      if (name === '../../session-cache') return cache;
      assert.equal(name, '../../workers/projects-query');
      return {};
    },
    Atomics: { wait(_array, index, value, delay) { assert.equal(index, 0); assert.equal(value, 0); events.push(['delay', delay]); } },
  }, { filename });
  await cache.reconcileCacheFromFilesystemAsync({ throttle: false, onFolder: folder => events.push(['progress', folder]) });
  assert.deepEqual(events, [['progress', h.folder], ['delay', 17]]);
  assert.ok(h.rows.has(OLD), 'the actual async sweep indexed the source');
});
