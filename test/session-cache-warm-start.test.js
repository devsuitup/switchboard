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
    assert.equal(db.getCachedSession('ordinary').fullReadStamp, null, 'header and message-count reads clear the old certificate');
    assert.notEqual(original, readSessionFile(file, folder, root).fullReadStamp);
    db.touchCachedModified('ordinary', '2030-01-01T00:00:00.000Z');
    db.setCachedFileSize('ordinary', fs.statSync(file).size);
    db.setCachedEntrypoints([{ sessionId: 'ordinary', entrypoint: 'cli' }]);
    db.setCachedCustomTitles([{ sessionId: 'ordinary', customTitle: '', fileMtime: '2030-01-01T00:00:00.000Z' }]);
    assert.equal(db.getCachedSession('ordinary').fullReadStamp, null);
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
    assert.equal(scans.length, 2, 'both population requests acknowledge the folder');
    assert.equal(scans[0].mode, 'full');
    assert.equal(scans[0].filesRead, 3);
    assert.equal(scans[1].filesSkipped, 1, 'the ordinary body is skipped while the unindexed suppressed mirror reopens its bridge group');
    assert.equal(scans[1].filesRead, 2);
    await cache.shutdownProducers();
  });

test('A2 metadata-only repair preserves cleared user names and promotes released collision titles without reading bodies',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    f.write('named', 'summary', [{ type: 'custom-title', customTitle: 'Transcript title' }]);
    f.write('collision', 'collision summary', [{ type: 'custom-title', customTitle: 'Collision title' }]);
    f.descriptors.push({ sessionId: 'collision', nameSource: 'collision' });
    await f.cache.populateCacheViaWorker();
    await f.writer.renameSession('named', 'user title');
    await f.writer.renameSession('named', null);
    f.descriptors.length = 0;
    await f.restart();
    assert.equal(f.db.getMeta('named', true)?.name, null, 'clearing a user rename preserves user provenance like a full rebuild');
    assert.equal(f.db.getMeta('collision', true)?.name, 'Collision title', 'descriptor removal retries a collision-pending promotion');
    assert.equal(f.scans()[0].filesRead, 0, 'metadata-only repair does not read certified transcript bodies');
  });

for (const gate of ['pending', 'version', 'configuration', 'empty-search', 'cold', 'repair', 'force']) {
  test('A2 full scan gate: ' + gate, { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    f.write('ordinary');
    await f.cache.populateCacheViaWorker();
    if (gate === 'pending') f.db.connection.prepare("UPDATE cache_meta SET fullIndexPending = 'interrupted' WHERE folder = ?").run(f.folder);
    if (gate === 'version') f.db.connection.prepare('UPDATE cache_meta SET fullIndexVersion = 999 WHERE folder = ?').run(f.folder);
    if (gate === 'configuration') f.db.connection.prepare("UPDATE cache_meta SET fullIndexConfig = '{}' WHERE folder = ?").run(f.folder);
    if (gate === 'empty-search') f.db.deleteSearchFolder(f.folder);
    if (gate === 'cold') f.db.setSetting('initial_scan_complete', false);
    if (gate === 'repair') f.db.setSetting('bridge_uuid_reindex_folders', [f.folder]);
    const result = await f.restart({ force: gate === 'force' });
    assert.equal(result?.ok, true, 'gate completes with an explicit successful outcome');
    assert.equal(f.scans().length, 1, 'repair and startup share one folder result');
    assert.equal(f.scans()[0].mode, 'full', gate + ' overrides warm selection');
    assert.equal(f.scans()[0].filesRead, 1);
    assert.equal(f.db.getFolderMeta(f.folder).fullIndexPending, null);
    if (gate === 'repair') assert.deepEqual(Array.from(f.db.getSetting('bridge_uuid_reindex_folders') || []), []);
  });
}

test('scan full, filtered subset and deletion-driven bridge readers all propose certificates', t => {
  const root = fixture(t), folder = encodeProjectPath(root), dir = path.join(root, folder);
  fs.mkdirSync(dir);
  const line = (uuid, day) => ({ type: 'user', uuid, cwd: root, timestamp: `2024-01-${day}T00:00:00.000Z`, message: { content: uuid } });
  const bridge = { type: 'bridge-session', bridgeSessionId: 'cse_readers' };
  for (const [name, rows] of [['parent', [line('opening', '01'), line('shared', '02'), bridge]], ['member', [line('shared', '02'), line('member', '03'), bridge]]]) {
    fs.writeFileSync(path.join(dir, name + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  const filename = path.join(__dirname, '../workers/scan-projects.js'), native = require('node:module').createRequire(filename);
  let bytesRead = 0;
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    const value = originalRead.call(this, file, ...args);
    if (path.dirname(file) === dir && file.endsWith('.jsonl')) bytesRead += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
    return value;
  });
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
  bytesRead = 0;
  const subset = scan({ folders: [], targets: [{ folder, files: ['member.jsonl'], existingRows: full.sessions }] });
  assert.equal(subset.counters.bytesRead, bytesRead, 'folder bytes count every returned UTF-8 byte including dependency rereads');
  assert.ok(subset.sessions.length > 0 && subset.sessions.every(row => row.fullReadStamp), 'targeted subset rereads certify');
  fs.unlinkSync(path.join(dir, 'parent.jsonl'));
  const deletion = scan({ folders: [], targets: [{ folder, files: ['parent.jsonl'], existingRows: full.sessions }] });
  assert.ok(deletion.sessions.some(row => row.sessionId === 'member' && row.fullReadStamp), 'winner deletion rereads the surviving mirror');
});

test('A2 warm restart skips certified ordinary bodies and preserves the complete logical index',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-a2-')), previous = process.env.SWITCHBOARD_DATA_DIR;
    process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
    const db = openStore(), cache = require('../session-cache');
    const worker = require('./fixtures/project-deletion-worker.cjs')(db);
    const calls = [], logs = [];
    const writer = require('../session-index-writer').createSessionIndexWriter({ readonlyBackend: db,
      client: { ready: Promise.resolve(), request: async (name, ...args) => {
        calls.push({ name, args });
        return worker.client.request(name, ...args);
      } } });
    t.after(async () => {
      await cache.shutdownProducers();
      db.closeDb();
      process.env.SWITCHBOARD_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const projects = path.join(root, 'projects'), folder = encodeProjectPath(root), dir = path.join(projects, folder);
    fs.mkdirSync(dir, { recursive: true });
    for (const id of ['first', 'second']) fs.writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({
      type: 'user', cwd: root, timestamp: '2024-01-01T00:00:00.000Z', message: { content: id + ' unique body' },
    }) + '\n');
    await writer.ready;
    const initialize = () => writer.initializeCache({ PROJECTS_DIR: projects, activeSessions: new Map(), getMainWindow: () => null,
      log: { info: line => logs.push(line), warn() {}, error() {} } });
    initialize();
    await cache.populateCacheViaWorker();
    const before = JSON.stringify(db.getAllCached());
    calls.length = 0;
    logs.length = 0;
    initialize();
    await cache.populateCacheViaWorker();
    const scans = logs.filter(line => line.startsWith('[session-cache] folder-indexed '))
      .map(line => JSON.parse(line.slice('[session-cache] folder-indexed '.length)));
    assert.equal(scans.length, 1, 'unchanged folder still emits exactly one acknowledged result');
    assert.equal(scans[0].filesRead, 0, 'certified ordinary transcripts have zero body reads after restart');
    assert.equal(scans[0].filesSkipped, 2);
    assert.equal(scans[0].bytesRead, 0);
    assert.equal(JSON.stringify(db.getAllCached()), before);
    const effects = calls.filter(call => call.name === 'effects').flatMap(call => call.args[0]);
    assert.equal(effects.filter(effect => ['upsertCachedSessions', 'replaceSessionMetrics', 'upsertSearchEntries'].includes(effect.name)).length,
      0, 'unchanged bodies cause no session, metric or FTS replacement');
  });

test('A2 continuation deferrals clear only after ACK and preserve newer deferrals',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    f.write('source');
    f.write('other');
    await f.cache.populateCacheViaWorker();
    f.cache.applyContinuationRefresh(f.folder, { deferred: new Set(['source.jsonl']), accounted: new Set() });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const original = f.writer.writeScannedFolderPartial.bind(f.writer);
    f.writer.writeScannedFolderPartial = async result => { entered(); await gate; return original(result); };
    const pending = f.cache.populateCacheViaWorker();
    await started;
    try {
      assert.ok(f.cache.continuationRefreshScope(f.folder, { files: new Set(['other.jsonl']) }).files.has('source.jsonl'),
        'the source stays deferred until its writer ACK');
      f.cache.applyContinuationRefresh(f.folder, { deferred: new Set(['newer.jsonl']), accounted: new Set() });
    } finally { release(); await pending; }
    const scope = f.cache.continuationRefreshScope(f.folder, { files: new Set(['other.jsonl']) }).files;
    assert.ok(!scope.has('source.jsonl'), 'successful publication clears the accounted source');
    assert.ok(scope.has('newer.jsonl'), 'successful publication preserves a newer unrelated deferral');
  });

test('A2 metadata-only certification rejects a rename between its effect ACK and certificate',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    f.write('ordinary', 'summary', [{ type: 'custom-title', customTitle: 'Transcript' }]);
    await f.cache.populateCacheViaWorker();
    const stamp = f.db.getCachedSession('ordinary').fullReadStamp;
    const { nameDerivationWitness } = require('../src/main/session-index/full-read-state');
    const previousWitness = f.db.getNameDerivation('ordinary');
    const request = f.worker.client.request;
    let injected = false;
    f.worker.client.request = async (name, ...args) => {
      if (name === 'certifyNameDerivation' && !injected) {
        injected = true;
        await f.writer.renameSession('ordinary', 'Concurrent user name');
      }
      return request(name, ...args);
    };
    assert.equal(await f.writer.deriveCachedName('ordinary', stamp, nameDerivationWitness(f.db.getMeta('ordinary', true), false), false), false,
      'a metadata certificate cannot cover a later user rename');
    assert.equal(f.db.getNameDerivation('ordinary'), previousWitness);
    assert.equal(f.db.getMeta('ordinary').name, 'Concurrent user name');
    assert.equal(f.db.getCachedSession('ordinary').fullReadStamp, stamp, 'metadata repair never advances the body certificate');
  });

test('A2 lost subset ACK retains deferred scope and leaves publication pending',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    const file = f.write('source');
    f.write('neighbor');
    await f.cache.populateCacheViaWorker();
    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'changed' } }) + '\n');
    f.cache.applyContinuationRefresh(f.folder, { deferred: new Set(['source.jsonl']), accounted: new Set() });
    const request = f.worker.client.request;
    let lost = false;
    f.worker.client.request = async (name, ...args) => {
      const reply = await request(name, ...args);
      if (name === 'effects' && !lost) { lost = true; throw new Error('lost committed effects ACK'); }
      return reply;
    };
    assert.equal((await f.cache.populateCacheViaWorker()).ok, false);
    assert.ok(f.cache.continuationRefreshScope(f.folder, { files: new Set(['other.jsonl']) }).files.has('source.jsonl'));
    assert.ok(f.db.getFolderMeta(f.folder).fullIndexPending, 'unknown body outcome cannot be sealed');
  });

test('A2 failed subset does not acknowledge global population completion',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    f.write('ordinary');
    await f.cache.populateCacheViaWorker();
    f.writer.writeScannedFolderPartial = async () => { throw new Error('injected partial publication failure'); };
    const result = await f.restart();
    assert.equal(result.ok, false);
    assert.equal(f.calls.filter(call => call.name === 'setInitialScanComplete').length, 0, 'failed subset cannot mark population complete');
    assert.equal(f.scans()[0].ok, false);
  });

test('A2 continuation race in a later sibling retains only the raced file and its derived effects', t => {
  const root = fixture(t), folder = encodeProjectPath(root), dir = path.join(root, folder);
  fs.mkdirSync(dir);
  const source = path.join(dir, 'source.jsonl'), other = path.join(dir, 'other.jsonl');
  const line = text => JSON.stringify({ type: 'user', cwd: root, timestamp: '2024-01-01', message: { content: text } }) + '\n';
  fs.writeFileSync(source, line('source baseline'));
  fs.writeFileSync(other, line('other baseline'));
  const rows = [source, other].map(file => readSessionFile(file, folder, root));
  fs.appendFileSync(source, line('source new'));
  fs.appendFileSync(other, line('other new'));
  const filename = require.resolve('../workers/scan-projects'), native = require('node:module').createRequire(filename), messages = [];
  const config = require('../src/main/session-index/full-read-state').fullIndexConfig({}, root);
  let changed = false;
  require('node:vm').runInNewContext(fs.readFileSync(filename, 'utf8'), { Buffer, process, console,
    require: name => name === 'worker_threads' ? { parentPort: { postMessage: message => messages.push(message) }, workerData: {
      projectsDir: root, folders: [], startup: { config, inventory: [{ folder, rows, deferred: ['source.jsonl', 'other.jsonl'],
        meta: { projectPath: root, fullIndexVersion: 1, fullIndexConfig: config, fullIndexPending: null } }] },
    } } : name === '../read-session-file' ? { ...native(name), readSessionFile: (file, ...args) => {
      const row = readSessionFile(file, ...args);
      if (file === other && !changed) { changed = true; fs.appendFileSync(source, line('raced after source read')); }
      return row;
    } } : native(name),
  }, { filename });
  const result = messages.find(message => message.type === 'folder')?.result;
  assert.ok(result?.sessions.some(row => row.sessionId === 'other'), 'an unrelated stable sibling is still published');
  assert.ok(!result.sessions.some(row => row.sessionId === 'source'), 'raced source and its name/metrics/search rows are withheld');
  assert.ok(result.deferred?.includes('source.jsonl'), 'raced source remains deferred per file');
  assert.ok(!result.toDelete.includes('source'));
});

test('A2 failed population never starts the continuation choice sweep', async () => {
  const filename = path.join(__dirname, '../main.js'), source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    populateCacheViaWorker', source.indexOf('app.whenReady'));
  assert.ok(start >= 0, 'startup population anchor exists');
  const statement = source.slice(start, source.indexOf('\n', start));
  let sweeps = 0;
  require('node:vm').runInNewContext(statement, { searchFtsRecreated: false,
    populateCacheViaWorker: async () => ({ ok: false }), sweepContinuationChoices: () => { sweeps++; }, log: { warn() {} },
  }, { filename });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sweeps, 0, 'a resolved failed population must not reconcile continuation choices');
});

test('A2 incremental restart equals a full rebuild of the same final transcript tree and metadata',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const { fixture: startupFixture, logicalIndex } = require('./fixtures/warm-start-1144.cjs');
    const f = await startupFixture(t);
    const previousCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(f.root, 'codex');
    t.after(() => { process.env.CODEX_HOME = previousCodex; });
    const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '08', '26');
    fs.mkdirSync(day, { recursive: true });
    const codexId = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';
    const codexFile = path.join(day, 'rollout-2026-08-26T11-55-02-' + codexId + '.jsonl');
    fs.writeFileSync(codexFile, [
      { type: 'session_meta', timestamp: '2026-08-26T10:00:00.000Z', payload: { id: codexId, cwd: f.root, originator: 'codex_cli_rs' } },
      { type: 'response_item', timestamp: '2026-08-26T10:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'codexunique' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const titleFile = path.join(process.env.CODEX_HOME, 'session_index.jsonl');
    fs.writeFileSync(titleFile, JSON.stringify({ id: codexId, thread_name: 'before codex title' }) + '\n');
    f.write('unchanged', 'unchangedtoken');
    const appended = f.write('append', 'appendbefore');
    const header = f.write('header', 'headerbefore');
    const rewritten = f.write('head', 'headbefore');
    const removed = f.write('gone', 'deletedunique');
    f.write('named', 'namedsummary', [{ type: 'custom-title', customTitle: 'Transcript title' }]);
    f.write('collision', 'collisionsummary', [{ type: 'custom-title', customTitle: 'Collision title' }]);
    f.descriptors.push({ sessionId: 'collision', nameSource: 'collision' });
    const sub = (relativePath, description) => {
      const file = path.join(f.dir, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: true, cwd: f.root,
        timestamp: '2024-01-01T00:00:00.000Z', message: { content: description } }) + '\n');
      return file;
    };
    const nested = sub('parent/subagents/agent-a.jsonl', 'subbefore');
    const workflow = sub('parent/subagents/workflows/wf_abcdef/agent-w.jsonl', 'workflowbefore');
    const bridge = { type: 'bridge-session', bridgeSessionId: 'cse_oracle' };
    f.write('bridge-a', 'bridgefirst', [bridge]);
    const mirror = f.write('bridge-b', 'bridgesecond', [bridge]);
    f.write('continued', 'continuationunique', [{ type: 'continued-in', sessionId: 'continued', continuedInSessionId: 'continuation-head', timestamp: '2024-01-02' }]);
    f.write('continuation-head', 'continuedheadunique');
    const worktree = path.join(f.root, '.work-files', 'worktrees', 'oracle');
    fs.mkdirSync(worktree, { recursive: true });
    const worktreeFolder = encodeProjectPath(worktree), worktreeDir = path.join(f.projects, worktreeFolder);
    fs.mkdirSync(worktreeDir);
    fs.writeFileSync(path.join(worktreeDir, 'worktree.jsonl'), JSON.stringify({ type: 'user', cwd: worktree,
      timestamp: '2024-01-01', message: { content: 'worktreeunique' } }) + '\n');
    const initial = await f.cache.populateCacheViaWorker();
    assert.equal(initial.ok, true, 'initial full publication succeeds');
    const line = token => JSON.stringify({ type: 'user', cwd: f.root, uuid: token,
      timestamp: '2024-01-02T00:00:00.000Z', message: { content: token } }) + '\n';
    fs.appendFileSync(appended, line('appendafterunique'));
    fs.appendFileSync(header, line('headerafterunique'));
    fs.utimesSync(header, new Date('2030-01-01'), new Date('2030-01-01'));
    await f.writer.refreshFolder(f.folder, { files: new Set(['header.jsonl']) });
    assert.equal(f.db.getCachedSession('header').fullReadStamp, null, 'actual header refresh leaves body uncertified');
    fs.writeFileSync(rewritten, fs.readFileSync(rewritten, 'utf8').replace('headbefore', 'headafterr'));
    f.write('new', 'newunique');
    fs.unlinkSync(removed);
    fs.writeFileSync(nested.replace('.jsonl', '.meta.json'), JSON.stringify({ description: 'sidecarafter' }));
    fs.unlinkSync(workflow);
    sub('parent/subagents/workflows/wf_bcdefa/agent-new.jsonl', 'workflowafter');
    fs.appendFileSync(mirror, line('bridgeafterunique'));
    fs.writeFileSync(titleFile, JSON.stringify({ id: codexId, thread_name: 'after codex title' }) + '\n');
    await f.writer.renameSession('named', 'User override');
    await f.writer.renameSession('named', null);
    f.db.setStarred('named', true);
    f.db.setArchived(['named'], true);
    f.descriptors.length = 0;
    const worktreeMeta = f.db.getFolderMeta(worktreeFolder);
    f.db.setFolderMeta(worktreeFolder, worktree, worktreeMeta.indexMtimeMs);
    const meta = ['session_meta', 'session_meta_fields'].map(table => [table,
      JSON.parse(JSON.stringify(f.db.connection.prepare('SELECT * FROM ' + table).all()))]);
    const incremental = await f.restart();
    assert.equal(incremental.ok, true, 'incremental publication succeeds');
    assert.equal(f.scans().filter(scan => scan.runtime === 'codex').length, 1, 'Codex has exactly one full pass');
    assert.equal(f.scans().find(scan => scan.runtime === 'codex').mode, 'full');
    assert.equal(f.db.getFolderMeta(worktreeFolder).projectPath, f.root);
    assert.deepEqual(JSON.parse(f.db.getCachedSession('continued').continuationIndex).ids, ['continuation-head']);
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans().filter(scan => scan.runtime === 'claude').reduce((sum, scan) => sum + scan.filesRead, 0), 0,
      'subsequent no-change pass reads no Claude body');
    const incrementalData = process.env.SWITCHBOARD_DATA_DIR;
    const referenceData = path.join(f.root, 'reference');
    process.env.SWITCHBOARD_DATA_DIR = referenceData;
    const reference = openStore();
    t.after(() => reference.closeDb());
    for (const [table, rows] of meta) for (const row of rows) {
      const columns = Object.keys(row);
      reference.connection.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
    }
    const referenceWorker = require('./fixtures/project-deletion-worker.cjs')(reference);
    const referenceWriter = require('../session-index-writer').createSessionIndexWriter({ readonlyBackend: reference, client: referenceWorker.client });
    await referenceWriter.ready;
    referenceWriter.initializeCache({ PROJECTS_DIR: f.projects, activeSessions: new Map(), getMainWindow: () => null, log: { info() {}, warn() {}, error() {} } });
    assert.equal((await f.cache.populateCacheViaWorker({ force: true })).ok, true, 'reference full rebuild succeeds');
    await f.cache.shutdownProducers();
    reference.closeDb();
    f.db.closeDb();
    const referenceReader = openStore({ readonly: true });
    process.env.SWITCHBOARD_DATA_DIR = incrementalData;
    const incrementalReader = openStore({ readonly: true });
    try {
      assert.deepEqual(logicalIndex(incrementalReader), logicalIndex(referenceReader), 'all logical index tables equal a full rebuild');
      for (const token of ['appendafterunique', 'headerafterunique', 'newunique', 'bridgeafterunique', 'deletedunique', 'continuationunique', 'worktreeunique']) {
        const query = 'SELECT m.id FROM search_fts f JOIN search_map m ON m.rowid = f.rowid WHERE search_fts MATCH ? ORDER BY m.id';
        assert.deepEqual(JSON.parse(JSON.stringify(incrementalReader.connection.prepare(query).all(token))),
          JSON.parse(JSON.stringify(referenceReader.connection.prepare(query).all(token))), 'MATCH equivalence: ' + token);
      }
      assert.equal(incrementalReader.connection.prepare('SELECT count(*) AS n FROM search_map m LEFT JOIN search_content c ON c.rowid=m.rowid WHERE c.rowid IS NULL').get().n, 0);
    } finally { incrementalReader.closeDb(); referenceReader.closeDb(); }
  });

for (const change of ['append', 'truncate', 'same-size-ctime', 'pinned-size', 'atomic']) {
  test('A2 selects only the changed source: ' + change, { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    const file = f.write('changed', 'beforeword');
    f.write('neighbor');
    fs.utimesSync(file, 1704067200, 1704067200);
    await f.cache.populateCacheViaWorker();
    const old = f.db.getCachedSession('changed').fullReadStamp;
    const before = fs.readFileSync(file);
    if (change === 'append' || change === 'pinned-size') fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: '2024-01-02', message: { content: 'appendedunique' } }) + '\n');
    if (change === 'truncate') fs.writeFileSync(file, before.toString().replace('beforeword', 'short'));
    if (change === 'same-size-ctime') fs.writeFileSync(file, before.toString().replace('beforeword', 'afterwords'));
    if (change === 'atomic') {
      fs.writeFileSync(file + '.new', before.toString().replace('beforeword', 'afterwords'));
      fs.renameSync(file + '.new', file);
    }
    if (['same-size-ctime', 'pinned-size', 'atomic'].includes(change)) fs.utimesSync(file, 1704067200, 1704067200);
    f.db.setFolderMeta(f.folder, f.root, 0);
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans()[0].filesRead, 1, 'a zero folder marker must not widen a per-file restart');
    assert.equal(f.scans()[0].filesSkipped, 1);
    assert.notEqual(f.db.getCachedSession('changed').fullReadStamp, old);
  });
}

test('A2 force during an admitted warm subset queues one full follow-up',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    f.write('ordinary');
    await f.cache.populateCacheViaWorker();
    const first = f.restart();
    const second = f.cache.populateCacheViaWorker({ force: true });
    await Promise.all([first, second]);
    assert.deepEqual(f.scans().map(scan => scan.mode), ['partial', 'full'], 'force cannot disappear into the warm single-flight promise');
  });

test('A2 pre-1149 worktree metadata forces fresh full derivation and matches rebuild grouping',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    const worktree = path.join(f.root, '.work-files', 'worktrees', 'old');
    fs.mkdirSync(worktree, { recursive: true });
    const folder = encodeProjectPath(worktree), dir = path.join(f.projects, folder);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'worktree.jsonl'), JSON.stringify({ type: 'user', cwd: worktree,
      timestamp: '2024-01-01', message: { content: 'worktree body' } }) + '\n');
    await f.cache.populateCacheViaWorker();
    const initial = f.db.getFolderMeta(folder);
    f.db.setFolderMeta(folder, worktree, initial.indexMtimeMs);
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans().find(scan => scan.folder === folder).mode, 'full');
    assert.equal(f.db.getFolderMeta(folder).projectPath, f.root, 'stored worktree paths are freshly collapsed');
    const warm = JSON.parse(JSON.stringify(f.db.getFolderMeta(folder)));
    await f.restart({ force: true });
    assert.deepEqual(JSON.parse(JSON.stringify(f.db.getFolderMeta(folder))), warm, 'grouping and seals equal a full rebuild');
  });

test('A2 a deleted source recreated before publication is retained and reselected',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    const file = f.write('ordinary');
    f.write('neighbor');
    await f.cache.populateCacheViaWorker();
    fs.unlinkSync(file);
    const Worker = require('node:worker_threads').Worker, emit = Worker.prototype.emit;
    let recreated = false;
    t.mock.method(Worker.prototype, 'emit', function (event, message, ...args) {
      if (event === 'message' && message?.result?.startup && !recreated) {
        recreated = true;
        f.write('ordinary', 'recreatedunique');
      }
      return emit.call(this, event, message, ...args);
    });
    assert.equal((await f.restart()).ok, false, 'reappeared source rejects the stale deletion plan');
    assert.ok(f.db.getCachedSession('ordinary'), 'stale deletion cannot remove its row');
    assert.equal((await f.restart({ force: true })).ok, true);
    assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH 'recreatedunique'").get().n, 1);
  });

test('A2 a configuration change during selection coalesces a full follow-up',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    f.write('ordinary');
    await f.cache.populateCacheViaWorker();
    const Worker = require('node:worker_threads').Worker, emit = Worker.prototype.emit;
    let changed = false;
    t.mock.method(Worker.prototype, 'emit', function (event, message, ...args) {
      if (event === 'message' && message?.result?.startup && !changed) {
        changed = true;
        f.db.setSetting('global', { disabledHarnesses: ['codex'] });
      }
      return emit.call(this, event, message, ...args);
    });
    assert.equal((await f.restart()).ok, true);
    assert.deepEqual(f.scans().map(scan => [scan.mode, scan.ok]), [['partial', false], ['full', true]]);
    assert.deepEqual(JSON.parse(f.db.getFolderMeta(f.folder).fullIndexConfig).disabledHarnesses, ['codex']);
  });

test('A2 disabling then re-enabling Claude invalidates its old baseline without pruning',
  { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
    const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
    f.write('ordinary');
    await f.cache.populateCacheViaWorker();
    await f.writer.setSetting('global', { disabledHarnesses: ['claude'] });
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans().length, 0);
    assert.ok(f.db.getCachedSession('ordinary'), 'disabled history is retained');
    await f.writer.setSetting('global', { disabledHarnesses: [] });
    assert.equal((await f.restart()).ok, true);
    assert.equal(f.scans()[0].mode, 'full', 're-enabled provider must validate the invalidated baseline');
  });

for (const live of [false, true]) {
  test('A2 confirmed folder disappearance preserves only live rows until release: ' + live,
    { skip: !openStore.supported && 'SQLite requires native binding or Node 22' }, async t => {
      const f = await require('./fixtures/warm-start-1144.cjs').fixture(t);
      f.write('ordinary');
      await f.cache.populateCacheViaWorker();
      if (live) f.activeSessions.set('ordinary', { exited: false });
      fs.rmSync(f.dir, { recursive: true });
      assert.equal((await f.restart()).ok, true);
      assert.equal(!!f.db.getCachedSession('ordinary'), live, 'missing folder retains only running sessions');
      if (live) {
        f.activeSessions.delete('ordinary');
        await f.writer.releaseLiveSession('ordinary');
      }
      assert.equal(f.db.getCachedSession('ordinary'), null);
      assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM session_metrics').get().n, 0);
      assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM search_map WHERE type='session'").get().n, 0);
      assert.equal(f.db.getAllFolderMeta().has(f.folder), false, 'gone folder metadata equals an empty full rebuild');
    });
}
