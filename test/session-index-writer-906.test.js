'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionIndexWriter } = require('../session-index-writer');

for (const mode of ['compute', 'direct']) {
  test(`906 ${mode} notifications read only folders beyond the recorder's row reads`, async () => {
    const stored = new Map([
      ['moved', { sessionId: 'moved', folder: 'old' }],
      ['same', { sessionId: 'same', folder: 'old' }],
    ]);
    const fullReads = [], folderReads = [], events = [];
    const rows = [
      { sessionId: 'moved', folder: 'new' },
      { sessionId: 'same', folder: 'old' },
      { sessionId: 'absent', folder: 'new' },
      { sessionId: 'moved', folder: 'old' },
    ];
    let db;
    const writer = createSessionIndexWriter({
      readonlyBackend: {
        getSetting: () => 0,
        getMeta: () => null,
        getCachedSession: id => { fullReads.push(id); return stored.get(id) || null; },
        getCachedFolder: id => { folderReads.push(id); return stored.get(id)?.folder ?? null; },
      },
      onSessionsChanged: (...args) => events.push(args),
      client: { ready: Promise.resolve(), request: async () => {} },
    }, {
      init: ctx => { db = ctx.db; },
      refreshFolder() { db.upsertCachedSessions(rows); },
    });
    await writer.ready;
    writer.initializeCache({});
    if (mode === 'compute') await writer.refreshFolder('old');
    else await writer.upsertCachedSessions(rows);
    assert.deepEqual(fullReads, mode === 'compute' ? ['moved', 'same', 'absent'] : [],
      'notifications must not add full-row reads beyond the recorder');
    assert.deepEqual([...new Set(folderReads)], ['moved', 'same', 'absent']);
    assert.deepEqual(events, [[['moved'], undefined], [['same', 'absent'], { upsertOnly: true }]],
      'moves invalidate once even when moved back; null folders identify new sessions');
  });
}
