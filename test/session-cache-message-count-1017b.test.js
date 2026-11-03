'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { readSessionFile } = require('../read-session-file');
const { readMessageCount } = require('../src/main/session-index/message-count');
const { encodeProjectPath } = require('../encode-project-path');
const { joinFolderKey } = require('../src/main/remote/remote-hosts');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const openStore = require('./fixtures/conversation-store.cjs');
const storeOptions = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };
const line = entry => JSON.stringify(entry) + '\n';

async function fixture(t, remote = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-count-1017b-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  const roots = cache.getRemoteRoots();
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  const db = openStore();
  t.after(() => {
    db.closeDb();
    cache.setRemoteRoots(roots);
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const diskFolder = encodeProjectPath(root);
  const folder = remote ? joinFolderKey('fixture', diskFolder) : diskFolder;
  const projects = path.join(root, 'projects');
  const dir = path.join(projects, diskFolder);
  fs.mkdirSync(dir, { recursive: true });
  if (remote) cache.setRemoteRoots(new Map([['fixture', projects]]));
  const writer = memoryWriter(db, cache);
  await writer.ready;
  const initialize = () => writer.initializeCache({ PROJECTS_DIR: projects, activeSessions: new Map(), getMainWindow: () => null, log: console });
  initialize();
  const user = (uuid, day, content = uuid) => ({ type: 'user', uuid, cwd: root,
    timestamp: `2026-10-${day}T10:00:00.000Z`, message: { content } });
  const write = (relative, entries) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map(line).join(''));
    return file;
  };
  return { root, dir, folder, db, writer, initialize, user, write };
}

function measureReads(t, files) {
  const descriptors = new Set();
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync, readFile = fs.readFileSync;
  const totals = { bytes: 0, full: 0 };
  t.mock.method(fs, 'openSync', function (target, ...args) {
    const fd = open.call(this, target, ...args);
    if (files.has(target)) descriptors.add(fd);
    return fd;
  });
  t.mock.method(fs, 'readSync', function (fd, ...args) {
    const n = read.call(this, fd, ...args);
    if (descriptors.has(fd)) totals.bytes += n;
    return n;
  });
  t.mock.method(fs, 'closeSync', function (fd) {
    descriptors.delete(fd);
    return close.call(this, fd);
  });
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (files.has(target)) totals.full++;
    return readFile.call(this, target, ...args);
  });
  return totals;
}

function replaceByAppend(file, suffix) {
  fs.copyFileSync(file, file + '.part');
  fs.appendFileSync(file + '.part', suffix);
  fs.renameSync(file + '.part', file);
  fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
}

for (const kind of ['parent', 'subagent', 'merged']) {
  test(`remote copy append rename keeps bounded message counts: ${kind}`, storeOptions, async t => {
    const h = await fixture(t, true);
    const relative = kind === 'subagent' ? 'parent/subagents/agent-child.jsonl' : 'member.jsonl';
    const entries = [h.user('own', '03')];
    if (kind === 'subagent') Object.assign(entries[0], { isSidechain: true, agentId: 'child' });
    if (kind === 'merged') {
      const shared = h.user('shared', '02');
      const bridge = { type: 'bridge-session', bridgeSessionId: 'cse_fixture' };
      h.write('parent.jsonl', [h.user('opening', '01'), shared, bridge]);
      entries.unshift(shared);
      entries.push(bridge);
    }
    entries.push({ type: 'system', padding: 'x'.repeat(2 * 1024 * 1024) });
    const file = h.write(relative, entries);
    await h.writer.refreshFolder(h.folder);
    const id = kind === 'subagent' ? 'sub:parent:child' : 'member';
    const initial = h.db.getCachedSession(id);
    assert.equal(initial.messageCount, 1);
    if (kind === 'merged') assert.equal(initial.mergedIntoSessionId, 'parent');
    replaceByAppend(file, line(h.user('appended', '04')));
    assert.notEqual(fs.statSync(file, { bigint: true }).ino.toString(), JSON.parse(initial.messageCountIndex).stamp.ino);
    const totals = measureReads(t, new Set([file]));
    const count = readMessageCount(file, initial.messageCountIndex, fs.statSync(file, { bigint: true }), kind === 'merged', true);
    assert.equal(count.messageCount, 2);
    assert.ok(totals.bytes < 600 * 1024, `bounded count after atomic replacement: ${totals.bytes}`);
    t.diagnostic(`count bytes (${kind}): ${totals.bytes}`);
    totals.bytes = 0;
    await h.writer.refreshFolder(h.folder, { files: new Set([relative]) });
    assert.equal(h.db.getCachedSession(id).messageCount, 2);
    assert.equal(totals.full, 0, 'sealed mirror growth must not trigger a full read or bridge remerge');
    const continuationBudget = kind === 'subagent' ? 0 : 1024 * 1024;
    assert.ok(totals.bytes < continuationBudget + 600 * 1024, `bounded header, count and continuation reads: ${totals.bytes}`);
    t.diagnostic(`refresh bytes (${kind}): ${totals.bytes}`);
    h.initialize();
    replaceByAppend(file, line(h.user('after-reinitialize', '05')));
    await h.writer.refreshFolder(h.folder, { files: new Set([relative]) });
    assert.equal(h.db.getCachedSession(id).messageCount, 3, 'persisted cursor retains the filtered baseline');
    assert.equal(totals.full, 0);
  });
}

test('a legacy divergent bridge row is recounted with UUID filtering', storeOptions, async t => {
  const h = await fixture(t);
  const shared = h.user('shared', '02');
  const bridge = { type: 'bridge-session', bridgeSessionId: 'cse_fixture' };
  h.write('parent.jsonl', [h.user('opening', '01'), shared, h.user('late', '09'), bridge]);
  const file = h.write('member.jsonl', [shared, h.user('own', '03'), bridge]);
  await h.writer.refreshFolder(h.folder);
  const initial = h.db.getCachedSession('member');
  assert.equal(initial.messageCount, 1);
  assert.equal(initial.mergedIntoSessionId, null);
  assert.equal(JSON.parse(initial.messageCountIndex).filtered, true);
  h.db.upsertCachedSessions([{ ...initial, messageCountIndex: null }]);
  fs.appendFileSync(file, line(h.user('appended', '04')));
  fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
  await h.writer.refreshFolder(h.folder, { files: new Set(['member.jsonl']) });
  const refreshed = h.db.getCachedSession('member');
  assert.equal(refreshed.messageCount, 2, 'legacy recount must not restore the shared UUID');
  assert.equal(refreshed.mergedIntoSessionId, null);
  assert.equal(JSON.parse(refreshed.messageCountIndex).filtered, true);
  h.initialize();
  await h.writer.refreshFolder(h.folder);
  assert.equal(h.db.getCachedSession('member').messageCount, 2, 'the deduplicated count persists');
});

for (const header of [true, false]) {
  test(`a failed filtered full read advances file freshness: header=${header}`, storeOptions, async t => {
    const h = await fixture(t);
    const file = h.write('member.jsonl', [h.user('own', '03'), { type: 'bridge-session', bridgeSessionId: 'cse_fixture' }]);
    await h.writer.refreshFolder(h.folder);
    const initial = h.db.getCachedSession('member');
    h.db.upsertCachedSessions([{ ...initial, mergedIntoSessionId: 'missing-parent', messageCountIndex: null }]);
    if (header) fs.appendFileSync(file, line({ type: 'custom-title', customTitle: 'Updated title' }));
    else fs.writeFileSync(file, line({ type: 'system', content: 'No display header' }));
    fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
    const readFile = fs.readFileSync;
    let fullReads = 0;
    t.mock.method(fs, 'readFileSync', function (target, ...args) {
      if (target === file) { fullReads++; throw new Error('synthetic full-read failure'); }
      return readFile.call(this, target, ...args);
    });
    await h.writer.refreshFolder(h.folder, { files: new Set(['member.jsonl']) });
    const refreshed = h.db.getCachedSession('member');
    assert.equal(fullReads, 1);
    assert.equal(refreshed.fileMtime, '2030-01-01T00:00:00.000Z', 'failed full reads must not leave the row permanently dirty');
    assert.equal(refreshed.fileSize, fs.statSync(file).size);
    assert.equal(refreshed.messageCount, initial.messageCount, 'failed recount preserves the cached count');
    assert.equal(refreshed.needsFullRead, undefined);
    if (header) assert.equal(refreshed.customTitle, 'Updated title');
    await h.writer.refreshFolder(h.folder, { files: new Set(['member.jsonl']) });
    assert.equal(fullReads, 1, 'an unchanged watcher flush must not retry the failed full read');
  });
}

test('full reader shares one final stamp observation for both indexes', storeOptions, async t => {
  const h = await fixture(t);
  const file = h.write('member.jsonl', [h.user('own', '03')]);
  const stat = fs.statSync, read = fs.readFileSync;
  let readBody = false, finalStats = 0;
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    const result = read.call(this, target, ...args);
    if (target === file) readBody = true;
    return result;
  });
  t.mock.method(fs, 'statSync', function (target, ...args) {
    if (target === file && readBody) finalStats++;
    return stat.call(this, target, ...args);
  });
  const row = readSessionFile(file, h.folder, h.root);
  assert.ok(row.messageCountIndex);
  assert.ok(row.continuationIndex);
  assert.equal(finalStats, 1, 'both indexes use the same post-read stamp validation');
});

for (const remote of [false, true]) {
  for (const change of ['head', 'tail', 'shrink', 'same-size', ...(!remote ? ['middle'] : [])]) {
    test(`replacement invalidates the message cursor: remote=${remote}, change=${change}`, storeOptions, async t => {
      const h = await fixture(t, remote);
      const entries = [h.user('first', '01'), { type: 'system', padding: 'x'.repeat(1000) },
        h.user('middle', '02'), { type: 'system', padding: 'y'.repeat(1000) }, { type: 'user', message: 'last' }];
      const file = h.write('member.jsonl', entries);
      const initial = readSessionFile(file, h.folder, h.root);
      const rewritten = entries.map(entry => ({ ...entry }));
      if (change === 'head') rewritten[0].type = 'nope';
      if (change === 'tail') rewritten[4].type = 'nope';
      if (change === 'middle' || change === 'same-size') rewritten[2].type = 'nope';
      let content = rewritten.map(line).join('');
      if (change === 'shrink') content = line(h.user('short', '01'));
      else if (change !== 'same-size') content += line(h.user('appended', '04'));
      fs.writeFileSync(file + '.part', content);
      fs.renameSync(file + '.part', file);
      fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
      const expected = readSessionFile(file, h.folder, h.root).messageCount;
      const result = readMessageCount(file, initial.messageCountIndex, fs.statSync(file, { bigint: true }), false, remote);
      assert.equal(result.messageCount, expected, 'a rewritten prefix must be recounted');
    });
  }
}
