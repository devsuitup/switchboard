'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessionFile } = require('../read-session-file');
const openStore = require('./fixtures/conversation-store.cjs');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const { encodeProjectPath } = require('../encode-project-path');
let isolatedCodex, previousCodex;
test.before(() => {
  previousCodex = process.env.CODEX_HOME;
  isolatedCodex = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-codex-1144-'));
  process.env.CODEX_HOME = isolatedCodex;
});
test.after(() => { process.env.CODEX_HOME = previousCodex; fs.rmSync(isolatedCodex, { recursive: true, force: true }); });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'full-read-1144-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('whole Claude readers certify ordinary, nested, legacy and workflow source observations', t => {
  const root = fixture(t);
  for (const relative of ['ordinary.jsonl', 'parent/subagents/agent-a.jsonl', 'parent/agent-b.jsonl', 'parent/subagents/workflows/wf_abcdef/agent-c.jsonl']) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const subagent = relative !== 'ordinary.jsonl';
    fs.writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: subagent, message: { role: 'user', content: 'full body' } }) + '\n');
    const row = readSessionFile(file, 'folder', root, subagent ? { parentSessionId: 'parent', workflowRunId: relative.includes('workflows') ? 'wf_abcdef' : null } : {});
    assert.ok(row?.fullReadStamp, relative + ' has a complete-read candidate');
    const stamp = JSON.parse(row.fullReadStamp), stat = fs.statSync(file, { bigint: true });
    assert.equal(stamp.format, 1);
    assert.equal(stamp.runtime, 'claude');
    assert.equal(stamp.relativePath, relative);
    for (const key of ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs', 'size']) assert.equal(stamp[key], String(stat[key]), key);
    if (subagent) assert.equal(stamp.dependencies.meta, null);
  }
});

test('whole Claude reads refuse a same-size rewrite with restored mtime and sidecar races', t => {
  const root = fixture(t), file = path.join(root, 'ordinary.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }) + '\n');
  const before = fs.statSync(file), original = fs.readFileSync;
  t.after(() => { fs.readFileSync = original; });
  fs.readFileSync = function (target, ...args) {
    const bytes = original.call(this, target, ...args);
    if (target === file) {
      fs.writeFileSync(file, bytes.toString().replace('first', 'other'));
      fs.utimesSync(file, before.atime, before.mtime);
    }
    return bytes;
  };
  const row = readSessionFile(file, 'folder', root);
  assert.equal(row.fullReadStamp, null, 'raced content cannot be certified');
});

test('subagent sidecar changes and failed auxiliary reads cannot certify a coherent row', t => {
  const root = fixture(t), file = path.join(root, 'parent', 'subagents', 'agent-sidecar.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'subagent body' } }) + '\n');
  const meta = file.replace('.jsonl', '.meta.json');
  fs.writeFileSync(meta, JSON.stringify({ description: 'before' }));
  const original = fs.readFileSync;
  let fail = false;
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    if (target === meta && fail) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    const value = original.call(this, target, ...args);
    if (target === meta) fs.writeFileSync(meta, JSON.stringify({ description: 'changed during read' }));
    return value;
  });
  const options = { parentSessionId: 'parent' };
  assert.equal(readSessionFile(file, 'folder', root, options).fullReadStamp, null);
  fail = true;
  assert.equal(readSessionFile(file, 'folder', root, options).fullReadStamp, null);
});

test('subagent certification requires the sidecar read to reach observed EOF', t => {
  const root = fixture(t), file = path.join(root, 'parent', 'subagents', 'agent-short.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'subagent body' } }) + '\n');
  const meta = file.replace('.jsonl', '.meta.json');
  fs.writeFileSync(meta, JSON.stringify({ description: 'complete metadata' }) + '\n');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    const bytes = read.call(this, target, ...args);
    return target === meta ? bytes.subarray(0, bytes.length - 1) : bytes;
  });
  assert.equal(readSessionFile(file, 'folder', root, { parentSessionId: 'parent' }).fullReadStamp, null, 'short auxiliary read cannot certify observed EOF');
});

test('header refresh cannot certify body freshness and recount modified override clears its candidate',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'full-read-1144-')), previous = process.env.SWITCHBOARD_DATA_DIR;
    process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
    const db = openStore(), cache = require('../session-cache'), writer = memoryWriter(db, cache);
    t.after(() => { db.closeDb(); process.env.SWITCHBOARD_DATA_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const folder = encodeProjectPath(root), projects = path.join(root, 'projects'), dir = path.join(projects, folder);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ordinary.jsonl');
    const line = (text, uuid) => JSON.stringify({ type: 'user', cwd: root, uuid, timestamp: '2024-01-01T00:00:00.000Z', message: { content: text } }) + '\n';
    fs.writeFileSync(file, line('original body', 'a'));
    await writer.ready;
    writer.initializeCache({ PROJECTS_DIR: projects, activeSessions: new Map(), getMainWindow: () => null, log: console });
    await writer.refreshFolder(folder);
    let original = db.getCachedSession('ordinary').fullReadStamp;
    assert.ok(original, 'NEW watcher full read publishes its certificate');
    const pinned = fs.statSync(file);
    fs.appendFileSync(file, line('pinned size change', 'pinned'));
    fs.utimesSync(file, pinned.atime, pinned.mtime);
    await writer.refreshFolder(folder);
    assert.notEqual(db.getCachedSession('ordinary').fullReadStamp, original, 'pinned-mtime size branch performs a new full read');
    original = db.getCachedSession('ordinary').fullReadStamp;
    assert.ok(original);
    fs.appendFileSync(file, line('appended body', 'b'));
    fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
    await writer.refreshFolder(folder);
    assert.equal(db.getCachedSession('ordinary').fullReadStamp, original, 'header and message-count reads retain the old observation');
    assert.notEqual(original, readSessionFile(file, folder, root).fullReadStamp);
    db.touchCachedModified('ordinary', '2030-01-01T00:00:00.000Z');
    db.setCachedFileSize('ordinary', fs.statSync(file).size);
    db.setCachedEntrypoints([{ sessionId: 'ordinary', entrypoint: 'cli' }]);
    db.setCachedCustomTitles([{ sessionId: 'ordinary', customTitle: '', fileMtime: '2030-01-01T00:00:00.000Z' }]);
    assert.equal(db.getCachedSession('ordinary').fullReadStamp, original);
    const bridge = JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'cse_fixture' }) + '\n';
    fs.writeFileSync(path.join(dir, 'parent.jsonl'), line('shared', 'shared') + bridge);
    fs.writeFileSync(path.join(dir, 'member.jsonl'), line('shared', 'shared') + line('own', 'own') + bridge);
    await writer.refreshFolder(folder);
    db.connection.exec("UPDATE session_cache SET messageCountIndex = NULL WHERE sessionId = 'member'");
    fs.appendFileSync(path.join(dir, 'member.jsonl'), line('extra', 'extra'));
    fs.utimesSync(path.join(dir, 'member.jsonl'), new Date('2030-01-02'), new Date('2030-01-02'));
    await writer.refreshFolder(folder);
    assert.equal(db.getCachedSession('member').fullReadStamp, null, 'mtime modified override cannot retain a canonical certificate');
    const logs = [];
    writer.initializeCache({ PROJECTS_DIR: projects, activeSessions: new Map(), getMainWindow: () => null, log: { info: line => logs.push(line), warn() {}, error() {} } });
    await cache.populateCacheViaWorker();
    await cache.populateCacheViaWorker();
    const scans = logs.filter(line => line.startsWith('[session-cache] folder-indexed ')).map(line => JSON.parse(line.slice('[session-cache] folder-indexed '.length)));
    assert.equal(scans.length, 2, 'A1 still performs a full population on each startup request');
    assert.ok(scans.every(scan => scan.mode === 'full' && scan.filesRead === 3 && scan.bytesRead > 0));
    await cache.shutdownProducers();
  });

test('scan full, filtered subset and deletion-driven bridge readers all propose certificates', t => {
  const root = fixture(t), folder = encodeProjectPath(root), dir = path.join(root, folder);
  fs.mkdirSync(dir);
  const line = (uuid, day) => ({ type: 'user', uuid, cwd: root, timestamp: `2024-01-${day}T00:00:00.000Z`, message: { content: uuid } });
  const bridge = { type: 'bridge-session', bridgeSessionId: 'cse_readers' };
  for (const [name, rows] of [['parent', [line('opening', '01'), line('shared', '02'), bridge]], ['member', [line('shared', '02'), line('member', '03'), bridge]]]) {
    fs.writeFileSync(path.join(dir, name + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  const filename = path.join(__dirname, '../workers/scan-projects.js'), native = require('node:module').createRequire(filename);
  const scan = data => {
    const messages = [];
    require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), { Buffer, process, console,
      require: name => name === 'worker_threads' ? { workerData: { projectsDir: root, ...data }, parentPort: { postMessage: message => messages.push(message) } } : native(name),
    }, { filename });
    return messages.find(message => message.type === 'folder').result;
  };
  const full = scan({ folders: [folder] });
  assert.ok(full.sessions.length === 2 && full.sessions.every(row => row.fullReadStamp), 'full folder and filtered mirror reread candidates');
  fs.appendFileSync(path.join(dir, 'member.jsonl'), JSON.stringify(line('appended', '04')) + '\n');
  const subset = scan({ folders: [], targets: [{ folder, files: ['member.jsonl'], existingRows: full.sessions }] });
  assert.ok(subset.sessions.length > 0 && subset.sessions.every(row => row.fullReadStamp), 'targeted subset rereads certify');
  fs.unlinkSync(path.join(dir, 'parent.jsonl'));
  const deletion = scan({ folders: [], targets: [{ folder, files: ['parent.jsonl'], existingRows: full.sessions }] });
  assert.ok(deletion.sessions.some(row => row.sessionId === 'member' && row.fullReadStamp), 'winner deletion rereads the surviving mirror');
});
