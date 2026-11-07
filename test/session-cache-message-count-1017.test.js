'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const openStore = require('./fixtures/conversation-store.cjs');
const storeOptions = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };
const line = entry => JSON.stringify(entry) + '\n';

for (const subagent of [false, true]) {
  test(`appended messages refresh the sidebar count and survive database reload: subagent=${subagent}`, storeOptions, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-count-1017-'));
    const previous = process.env.SWITCHBOARD_DATA_DIR;
    process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
    let db = openStore();
    t.after(() => {
      db.closeDb();
      if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
      else process.env.SWITCHBOARD_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const folder = encodeProjectPath(root);
    const relative = subagent ? 'parent/subagents/agent-child.jsonl' : 'parent.jsonl';
    const file = path.join(root, folder, relative);
    const entry = type => ({ type, cwd: root, isSidechain: subagent, agentId: subagent ? 'child' : undefined,
      message: { content: type === 'user' ? 'hello' : 'answer' } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, line(entry('user'))
      + line({ type: 'system', padding: 'x'.repeat(2 * 1024 * 1024) }) + JSON.stringify(entry('assistant')));
    const initialize = async () => {
      const writer = memoryWriter(db, cache);
      await writer.ready;
      writer.initializeCache({ PROJECTS_DIR: root, activeSessions: new Map(), getMainWindow: () => null, log: console });
      return writer;
    };
    let writer = await initialize();
    await writer.refreshFolder(folder);
    const id = db.getAllCached()[0].sessionId;
    const count = () => cache.buildProjectsFromCache(true).flatMap(project => project.sessions).find(row => row.sessionId === id).messageCount;
    assert.equal(count(), 2);
    const descriptors = new Set();
    const open = fs.openSync;
    const read = fs.readSync;
    const close = fs.closeSync;
    const readFile = fs.readFileSync;
    let bytesRead = 0;
    t.mock.method(fs, 'openSync', function (target, ...args) {
      const fd = open.call(this, target, ...args);
      if (target === file) descriptors.add(fd);
      return fd;
    });
    t.mock.method(fs, 'readSync', function (fd, ...args) {
      const n = read.call(this, fd, ...args);
      if (descriptors.has(fd)) bytesRead += n;
      return n;
    });
    t.mock.method(fs, 'closeSync', function (fd) {
      descriptors.delete(fd);
      return close.call(this, fd);
    });
    t.mock.method(fs, 'readFileSync', function (target, ...args) {
      assert.notEqual(target, file, 'incremental refresh must not read the whole transcript');
      return readFile.call(this, target, ...args);
    });
    fs.appendFileSync(file, '\n' + line(entry('user')) + line(entry('assistant')));
    fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
    assert.equal(await writer.refreshFolder(folder, { files: new Set([relative]) }), 'activity');
    assert.equal(count(), 4, 'incremental refresh must count the appended user and assistant');
    assert.ok(bytesRead < 600 * 1024, `bounded display and append reads: ${bytesRead}`);
    db.closeDb();
    db = openStore();
    writer = await initialize();
    assert.equal(count(), 4, 'database reload retains the refreshed count');
    bytesRead = 0;
    fs.appendFileSync(file, line({ type: 'summary', summary: 'compacted' })
      + line({ type: 'message', role: 'user', message: 'next' })
      + line({ type: 'message', role: 'assistant', message: 'reply' })
      + line({ type: 'system' }) + '{malformed}\n');
    fs.utimesSync(file, new Date('2030-01-02'), new Date('2030-01-02'));
    await writer.refreshFolder(folder, { files: new Set([relative]) });
    assert.equal(count(), 6, 'legacy message records count; summary, system and malformed lines do not');
    assert.ok(bytesRead < 600 * 1024, `persisted cursor avoids a recount after reload: ${bytesRead}`);
    fs.appendFileSync(file, '{"type":"assistant","message":"unfinished');
    fs.utimesSync(file, new Date('2030-01-03'), new Date('2030-01-03'));
    await writer.refreshFolder(folder, { files: new Set([relative]) });
    assert.equal(count(), 6, 'a partial JSON tail is not counted');
    fs.appendFileSync(file, '"}');
    fs.utimesSync(file, new Date('2030-01-04'), new Date('2030-01-04'));
    await writer.refreshFolder(folder, { files: new Set([relative]) });
    assert.equal(count(), 7, 'a valid unterminated message counts as in a full read');
    fs.appendFileSync(file, '\n' + line(entry('user')));
    fs.utimesSync(file, new Date('2030-01-05'), new Date('2030-01-05'));
    await writer.refreshFolder(folder, { files: new Set([relative]) });
    assert.equal(count(), 8, 'sealing a tentative message must not count it twice');
    const replacement = line(entry('user')) + line({ ...entry('assistant'), message: 'é'.repeat(40000) });
    fs.writeFileSync(file, replacement);
    fs.utimesSync(file, new Date('2030-01-06'), new Date('2030-01-06'));
    await writer.refreshFolder(folder, { files: new Set([relative]) });
    assert.equal(count(), 2, 'truncation recounts records spanning UTF-8 read chunks');
    const padding = Buffer.byteLength(replacement) - Buffer.byteLength(line(entry('user')))
      - Buffer.byteLength(line({ type: 'system', padding: '' }));
    fs.writeFileSync(file, line(entry('user')) + line({ type: 'system', padding: 'z'.repeat(padding) }));
    assert.equal(fs.statSync(file).size, Buffer.byteLength(replacement));
    fs.utimesSync(file, new Date('2030-01-07'), new Date('2030-01-07'));
    await writer.refreshFolder(folder, { files: new Set([relative]) });
    assert.equal(count(), 1, 'a same-size rewrite must not reuse the old count');
    db.setName(id, 'Keep this name');
    db.connection.exec('ALTER TABLE session_cache DROP COLUMN messageCountIndex');
    db.closeDb();
    db = openStore();
    writer = await initialize();
    assert.equal(db.getMeta(id).name, 'Keep this name', 'adding the cursor column preserves metadata');
    assert.equal(count(), 1, 'adding the cursor column preserves existing rows');
    fs.appendFileSync(file, line(entry('assistant')));
    fs.utimesSync(file, new Date('2030-01-08'), new Date('2030-01-08'));
    await writer.refreshFolder(folder, { files: new Set([relative]) });
    assert.equal(count(), 2, 'a changed legacy row without a cursor is recounted');
  });
}
