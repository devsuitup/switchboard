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
const { randomUUID } = require('node:crypto');
const { hashSessionRequestCommand } = require('../session-index-commands');

test('session request commands cross the real worker queue and receipt rejection rolls back both rows', {
  skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22',
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'requests-worker-380-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  const db = openStore();
  t.after(() => {
    db.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const port = new EventEmitter(), replies = new Map();
  port.postMessage = message => {
    if (message.id && !message.started) replies.get(message.id)?.(message);
  };
  const filename = require.resolve('../workers/session-index-writer');
  const nativeRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) {
      if (name === 'node:worker_threads') return { parentPort: port };
      if (name === '../session-index-store') return { openSessionIndexStore: () => db };
      return nativeRequire(name);
    }, setInterval: () => ({ unref() {} }),
  }, { filename });
  let id = 0;
  const send = (command, input) => new Promise((resolve, reject) => {
    const token = ++id, timer = setTimeout(() => reject(new Error('worker deadline')), 3000);
    replies.set(token, value => { clearTimeout(timer); resolve(value); });
    if (command !== 'querySessionRequestOutcome') {
      input = { ...input, actionToken: randomUUID() };
      input.argsHash = hashSessionRequestCommand(command, input);
    }
    port.emit('message', { id: token, command, args: [input] });
  });
  const hash = 'a'.repeat(64);
  const input = { stemKey: 'worker', actualStem: 'worker', suppliedHash: hash, rawHash: hash, family: 'legacy' };
  assert.equal((await send('querySessionRequestOutcome', input)).result.state, 'absent');
  for (const command of ['claimSessionResultNamespace', 'recordConsumedSessionStatusRequest']) {
    db.connection.exec("CREATE TRIGGER reject_session_receipt BEFORE INSERT ON session_request_commands BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
    const revision = db.getSetting('_writer_revision');
    const rejected = await send(command, { ...input, ...(command === 'recordConsumedSessionStatusRequest'
      ? { family: 'session-status', resultBytes: Buffer.from('status\n') } : {}) });
    assert.match(rejected.error?.message || '', /receipt rejected/);
    assert.equal(db.sessionRequests.get('worker'), null, 'receipt rejection must roll back the owner row through the worker');
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS n FROM session_request_commands').get().n, 0, 'neither row is present');
    assert.equal(db.getSetting('_writer_revision'), revision);
    db.connection.exec('DROP TRIGGER reject_session_receipt');
  }
  assert.equal((await send('claimSessionResultNamespace', input)).result.state, 'pending');
  db.connection.exec("CREATE TRIGGER reject_session_receipt BEFORE INSERT ON session_request_commands BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
  const failed = await send('recordSessionResultPublication', { ...input, resultBytes: Buffer.from('result\n') });
  assert.match(failed.error?.message || '', /receipt rejected/);
  assert.equal(db.sessionRequests.get('worker').resultBytes, null, 'publication also rolls back without a receipt');
  db.connection.exec('DROP TRIGGER reject_session_receipt');
  const published = await send('recordSessionResultPublication', { ...input, resultBytes: Buffer.from('result\n') });
  assert.equal(published.result.state, 'completed');
  const conflict = await send('recordSessionRequestConflict', { stemKey: 'worker', actualStem: 'worker', rawHash: 'b'.repeat(64), resultBytes: Buffer.from('conflict\n') });
  assert.equal(conflict.result.state, 'conflict');
  assert.deepEqual(Buffer.from((await send('querySessionRequestOutcome', input)).result.owner.resultBytes), Buffer.from('result\n'));
});

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
