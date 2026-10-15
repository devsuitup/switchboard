'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCacheEffects } = require('../cache-effects');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('cache dependency writes are recorded without writing through the main reader', () => {
  const forbidden = () => assert.fail('main connection write');
  const backend = { getAllCached: () => [], getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(),
    listSettingKeys: () => [], replaceSessionMetrics: forbidden, touchCachedModified: forbidden };
  const effects = createCacheEffects(backend);
  effects.begin();
  effects.adapter.replaceSessionMetrics('id', []);
  effects.adapter.touchCachedModified('id', 'time');
  assert.deepEqual(effects.finish(), [
    { name: 'replaceSessionMetrics', args: ['id', []] },
    { name: 'touchCachedModified', args: ['id', 'time'] },
  ]);
});

test('cache computation reads its own changes without persisting them on main', () => {
  const effects = createCacheEffects({ getAllCached: () => [], getAllMeta: () => new Map(),
    getAllFolderMeta: () => new Map(), listSettingKeys: () => [] });
  effects.begin();
  effects.adapter.upsertCachedSessions([{ sessionId: 'id', folder: 'folder' }]);
  assert.equal(effects.adapter.getCachedSession('id').folder, 'folder');
  effects.adapter.deleteCachedSession('id');
  assert.equal(effects.adapter.getCachedSession('id'), null);
  assert.equal(effects.finish().length, 2);
});

test('main awaits writer bootstrap before opening its readonly store', () => {
  const source = read('main.js');
  assert.ok(source.indexOf('await writer.ready') < source.indexOf("} = require('./db');"));
  assert.ok(read('db.js').includes('openSessionIndexStore({ readonly: true })'));
});
