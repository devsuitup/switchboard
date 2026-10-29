'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const openStore = require('./fixtures/conversation-store.cjs');

test('F8 an interleaved write rejects the remaining effect chunks and fresh admission repairs the partial cache', {
  skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22',
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-retry-719b-'));
  const prior = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  const db = openStore();
  t.after(() => {
    db.closeDb();
    if (prior === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  db.nextChunkSize = () => 1;
  const port = new EventEmitter(), replies = new Map(), waiters = new Map();
  port.postMessage = message => {
    if (!message.id || message.started) return;
    replies.set(message.id, message);
    waiters.get(message.id)?.(message);
  };
  const reply = id => replies.has(id) ? Promise.resolve(replies.get(id)) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('writer reply deadline')), 3000);
    waiters.set(id, value => { clearTimeout(timer); resolve(value); });
  });
  const filename = require.resolve('../workers/session-index-writer');
  const nativeRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === 'node:worker_threads') return { parentPort: port };
      if (name === '../session-index-store') return { openSessionIndexStore: () => db };
      return nativeRequire(name);
    }, setInterval: () => ({ unref() {} }),
  }, { filename });
  const row = id => ({ sessionId: id, folder: '-p', projectPath: '/p', summary: id, firstPrompt: null, created: null, modified: null });
  port.emit('message', { id: 1, command: 'effects', args: [[{ name: 'upsertCachedSessions', args: [[row('first'), row('last')]] }], 0] });
  port.emit('message', { id: 2, command: 'setName', args: ['first', 'JB rename'] });
  await reply(2);
  const rejected = await reply(1);
  assert.equal(rejected.error.code, 'WRITER_STALE', JSON.stringify(rejected));
  assert.ok(db.getCachedSession('first'), 'the first bounded chunk committed');
  assert.equal(db.getCachedSession('last'), null, 'the stale remainder was not admitted');
  assert.equal(db.getMeta('first').name, 'JB rename');
  const revision = db.getSetting('_writer_revision');
  port.emit('message', { id: 3, command: 'effects', args: [[{ name: 'upsertCachedSessions', args: [[row('first'), row('last')]] }], revision] });
  const accepted = await reply(3);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result.committedRevision, db.getSetting('_writer_revision'));
  assert.ok(db.getCachedSession('last'));
  assert.equal(db.getMeta('first').name, 'JB rename', 'fresh source refresh preserves the interleaved user metadata');
  const beforeAdoption = { ...db.getCachedSession('first') };
  port.emit('message', { id: 4, command: 'effects', args: [[{ name: 'setCachedFileSize', args: ['first', 123] }], db.getSetting('_writer_revision')] });
  const adopted = await reply(4);
  assert.equal(adopted.error, undefined, 'writer admits the size-only effect');
  assert.deepEqual({ ...db.getCachedSession('first') }, { ...beforeAdoption, fileSize: 123 });
  assert.equal(adopted.result.committedRevision, db.getSetting('_writer_revision'));
  assert.ok(adopted.result.committedRevision > accepted.result.committedRevision);
  assert.equal(db.getMeta('first').name, 'JB rename');
});
