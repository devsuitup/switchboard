'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cache = require('../session-cache');
const { scanContinuationIndex, continuationStamp } = require('../session-continuations');
const { fixture, OLD, HEAD, OTHER, tick, line } = require('./fixtures/continuation-718.cjs');

for (const cold of [false, true]) test('B1 changed linked source survives OTHER-first refresh, cold=' + cold, { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link()); h.write(OTHER); cache.refreshFolder(h.folder);
  if (cold) h.init();
  for (let n = 0; n < 3; n++) {
    h.append(OLD); h.append(OTHER);
    const opts = { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) };
    const preparedContinuations = await cache.prepareContinuationRefresh(h.folder, opts);
    const changed = cache.refreshFolder(h.folder, { ...opts, preparedContinuations });
    assert.notEqual(changed, true, 'a stable-edge suffix only changes activity');
    const row = h.rows.get(OLD), index = JSON.parse(row.continuationIndex);
    assert.deepEqual(index.ids, [HEAD]); assert.equal(index.mtime, row.fileMtime);
    assert.deepEqual(index.stamp, continuationStamp(fs.statSync(h.file(OLD), { bigint: true })));
    assert.equal(h.views().length, 1); assert.ok(h.views()[0].mergedMemberIds.includes(OLD));
  }
});

test('B2 preparation yields beyond the ordinary budget', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.init();
  h.append(OLD, h.padding); let yielded = false;
  setImmediate(() => { yielded = true; });
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  assert.equal(yielded, true);
  cache.refreshFolder(h.folder, { preparedContinuations });
  const index = JSON.parse(h.rows.get(OLD).continuationIndex);
  assert.equal(index.complete, true); assert.equal(index.bytes, fs.statSync(h.file(OLD)).size);
});

for (const suffix of ['branch', 'partial', 'malformed', 'replacement', 'shrink']) test('B3/B4 publishes parser truth for ' + suffix, { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link()); cache.refreshFolder(h.folder); h.init();
  if (suffix === 'branch') h.append(OLD, h.link(OTHER));
  if (suffix === 'partial') h.append(OLD, '{"type":"continued-in"');
  if (suffix === 'malformed') h.append(OLD, '{"type":"continued-in",oops}\n');
  if (suffix === 'replacement') { fs.renameSync(h.file(OLD), h.file(OLD) + '.bak'); h.write(OLD, h.padding + h.link(OTHER) + h.padding); }
  if (suffix === 'shrink') h.write(OLD, h.link(OTHER));
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  cache.refreshFolder(h.folder, { preparedContinuations });
  const actual = JSON.parse(h.rows.get(OLD).continuationIndex);
  const expected = JSON.parse(scanContinuationIndex(h.file(OLD), OLD, undefined, 20 * 1024 * 1024));
  for (const field of ['ids', 'sealedIds', 'complete', 'unresolved', 'pending', 'invalid']) assert.deepEqual(actual[field], expected[field], field);
});

test('B5/B7 raw exhausted refresh defers the whole row, targeted OTHER retries it', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link()); h.write(OTHER); cache.refreshFolder(h.folder); h.init();
  const before = structuredClone(h.rows.get(OLD));
  h.append(OLD); h.append(OTHER); h.effects.length = 0;
  const changedAt = new Date(Date.parse(before.fileMtime) + 1000);
  fs.utimesSync(h.file(OLD), changedAt, changedAt);
  cache.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) });
  assert.deepEqual(h.rows.get(OLD), before);
  assert.equal(h.folders.get(h.folder).indexMtimeMs, 0); assert.equal(h.folders.get(h.folder).projectPath, h.root);
  assert.equal(h.views().length, 1);
  const opts = { files: new Set([OTHER + '.jsonl']) };
  assert.ok(cache.continuationRefreshScope(h.folder, opts).files.has(OLD + '.jsonl'));
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder, opts);
  cache.refreshFolder(h.folder, { ...opts, preparedContinuations });
  assert.notEqual(h.rows.get(OLD).fileMtime, before.fileMtime);
  const index = JSON.parse(h.rows.get(OLD).continuationIndex);
  assert.deepEqual(index.ids, [HEAD]); assert.equal(index.complete, true);
  assert.equal(index.bytes, fs.statSync(h.file(OLD)).size);
  assert.deepEqual(index.stamp, continuationStamp(fs.statSync(h.file(OLD), { bigint: true })));
  assert.ok(h.folders.get(h.folder).indexMtimeMs > 0);
  assert.equal(cache.continuationRefreshScope(h.folder, { files: new Set([OTHER + '.jsonl']) }).files.has(OLD + '.jsonl'), false);
});

test('#733 watcher between index save and targeted refresh retains a coherent row', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding); h.write(OTHER); cache.refreshFolder(h.folder); h.init();
  h.append(OLD, h.link());
  await cache.resolveSessionContinuations(OLD, { getSessionLiveElsewhere: async () => ({ known: true, live: {} }) });
  const before = structuredClone(h.rows.get(OLD)); h.append(OTHER);
  cache.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']) });
  assert.ok(h.rows.get(OLD).continuationIndex);
  if (h.rows.get(OLD).fileMtime === before.fileMtime) assert.deepEqual(h.rows.get(OLD), before);
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder, { files: new Set([OLD + '.jsonl']) });
  cache.refreshFolder(h.folder, { files: new Set([OLD + '.jsonl']), preparedContinuations });
  assert.equal(h.views().length, 1);
});

test('B6 unchanged legacy linked row without stamp does no continuation scan', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder);
  const row = h.rows.get(OLD), index = JSON.parse(row.continuationIndex); delete index.stamp; delete index.head;
  row.continuationIndex = JSON.stringify(index); h.init(); h.effects.length = 0;
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  assert.equal(preparedContinuations.size, 0); cache.refreshFolder(h.folder, { preparedContinuations });
  assert.equal(h.effects.length, 0);
  await tick();
});

test('B5 same-identity growth across a yield reaches its verified new EOF', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  setImmediate(() => h.append(OLD, h.link(OTHER)));
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  cache.refreshFolder(h.folder, { preparedContinuations });
  assert.deepEqual(JSON.parse(h.rows.get(OLD).continuationIndex).ids, [HEAD, OTHER]);
});

test('B5 two identity races leave whole row untouched and retry exactly once', { timeout: 9000 }, async t => {
  const { memoryWriter } = require('./fixtures/writer-memory.cjs');
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  const before = structuredClone(h.rows.get(OLD));
  const writer = memoryWriter(h.db, cache); await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: h.root, activeSessions: h.activeSessions, getMainWindow: () => null, log: h.log });
  let races = 0; const immediate = setImmediate;
  const hook = t.mock.method(global, 'setImmediate', callback => immediate(() => {
    fs.renameSync(h.file(OLD), h.file(OLD) + '.' + ++races);
    h.write(OLD, h.padding + h.link()); callback();
  }));
  await writer.refreshFolder(h.folder); hook.mock.restore();
  assert.equal(races, 2); assert.deepEqual(h.rows.get(OLD), before);
  assert.equal(h.folders.get(h.folder).indexMtimeMs, 0); assert.equal(h.folders.get(h.folder).projectPath, h.root);
  assert.equal(h.logs.filter(row => row.join(' ').includes('continuation-refresh-raced')).length, 1);
  await writer.refreshFolder(h.folder); assert.ok(h.folders.get(h.folder).indexMtimeMs > 0);
});

for (const race of ['previous', 'stamp', 'header']) test('B5 rejects stale prepared ' + race + ' before publishing', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  if (race === 'previous') h.rows.get(OLD).continuationIndex = h.rows.get(OLD).continuationIndex.replace('"complete":true', '"complete":false');
  if (race === 'stamp') h.append(OLD);
  const before = structuredClone(h.rows.get(OLD));
  if (race === 'header') {
    const read = fs.readSync; let mutated = false;
    t.mock.method(fs, 'readSync', (...args) => {
      const n = read(...args);
      if (!mutated) { mutated = true; h.append(OLD); }
      return n;
    });
  }
  cache.refreshFolder(h.folder, { preparedContinuations });
  assert.deepEqual(h.rows.get(OLD), before); assert.equal(h.folders.get(h.folder).indexMtimeMs, 0);
});

test('B4 equal-size replacement with unchanged head/tail exposes its changed middle target', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link() + h.padding); cache.refreshFolder(h.folder); h.init();
  const stat = fs.statSync(h.file(OLD));
  fs.writeFileSync(h.file(OLD), fs.readFileSync(h.file(OLD), 'utf8').replace('continuedInSessionId":"' + HEAD, 'continuedInSessionId":"' + OTHER));
  fs.utimesSync(h.file(OLD), stat.atime, new Date(stat.mtimeMs + 1000));
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  cache.refreshFolder(h.folder, { preparedContinuations });
  assert.deepEqual(JSON.parse(h.rows.get(OLD).continuationIndex).ids, [OTHER]);
});

test('B4 cold growing replacement with identical head and cursor tail cannot resume old middle IDs', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link() + h.padding); cache.refreshFolder(h.folder); h.init();
  const bytes = fs.readFileSync(h.file(OLD), 'utf8');
  fs.renameSync(h.file(OLD), h.file(OLD) + '.old');
  fs.writeFileSync(h.file(OLD), bytes.replace('continuedInSessionId":"' + HEAD, 'continuedInSessionId":"' + OTHER) + h.padding);
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  cache.refreshFolder(h.folder, { preparedContinuations });
  assert.deepEqual(JSON.parse(h.rows.get(OLD).continuationIndex).ids, [OTHER]);
});

test('B4 equal-size sub-millisecond rewrite with unchanged witnesses restarts at zero', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.padding + h.link() + h.padding);
  const seconds = Date.parse('2030-01-01T00:00:00.000Z') / 1000;
  fs.utimesSync(h.file(OLD), seconds, seconds + 0.0001); cache.refreshFolder(h.folder); h.init();
  const before = fs.statSync(h.file(OLD), { bigint: true });
  fs.writeFileSync(h.file(OLD), fs.readFileSync(h.file(OLD), 'utf8').replace('continuedInSessionId":"' + HEAD, 'continuedInSessionId":"' + OTHER));
  fs.utimesSync(h.file(OLD), seconds, seconds + 0.0002);
  const after = fs.statSync(h.file(OLD), { bigint: true });
  assert.notEqual(before.mtimeNs, after.mtimeNs); assert.equal(before.mtimeMs / 1n, after.mtimeMs / 1n);
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  cache.refreshFolder(h.folder, { preparedContinuations });
  assert.deepEqual(JSON.parse(h.rows.get(OLD).continuationIndex).ids, [OTHER]);
});

test('B3 completing a partial link and a cycle preserve graph truth', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); h.write(HEAD, JSON.stringify({ type: 'continued-in', sessionId: HEAD, continuedInSessionId: OLD }) + '\n');
  cache.refreshFolder(h.folder); h.append(OLD, '{"type":"continued-in"');
  let preparedContinuations = await cache.prepareContinuationRefresh(h.folder); cache.refreshFolder(h.folder, { preparedContinuations });
  assert.equal(JSON.parse(h.rows.get(OLD).continuationIndex).complete, false);
  h.append(OLD, ',"sessionId":"' + OLD + '","continuedInSessionId":"' + OTHER + '"}\n');
  preparedContinuations = await cache.prepareContinuationRefresh(h.folder); cache.refreshFolder(h.folder, { preparedContinuations });
  assert.deepEqual(JSON.parse(h.rows.get(OLD).continuationIndex).ids, [HEAD, OTHER]);
  assert.ok(h.views().length > 1);
});

test('B4 exact persisted identity/stamps distinguish values colliding as Numbers', () => {
  const { matchesContinuationStamp } = require('../session-continuations');
  const stat = Object.fromEntries(['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'size'].map(field => [field, 9007199254740992n]));
  const stamp = continuationStamp(stat);
  for (const field of Object.keys(stamp)) assert.equal(matchesContinuationStamp({ ...stamp, [field]: '9007199254740993' }, stat), false, field);
  const previous = JSON.stringify({ head: 'abcd', stamp });
  assert.equal(cache.resumesPersistedContinuation(previous, { ...stat, ino: stat.ino + 1n, size: stat.size + 1n }, 'abcd'), false);
});

for (const kind of ['subagent', 'remote', 'no-link', 'out-of-scope']) test('B6 preparation excludes ' + kind + ' rows', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.init(); h.append(OLD, h.padding);
  if (kind === 'subagent') h.rows.get(OLD).parentSessionId = HEAD;
  if (kind === 'no-link') h.rows.get(OLD).continuationIndex = JSON.stringify({ format: 3, version: 3, ids: [] });
  const folder = kind === 'remote' ? 'server::' + h.folder : h.folder;
  if (kind === 'remote') { h.rows.get(OLD).folder = folder; cache.setRemoteRoots(new Map([['server', h.root]])); }
  const opts = kind === 'out-of-scope' ? { files: new Set([OTHER + '.jsonl']) } : {};
  assert.equal((await cache.prepareContinuationRefresh(folder, opts)).size, 0);
});

test('B2/B6 separate scan budget, bounded headers, and scoped unchanged rows', { timeout: 9000 }, async t => {
  const h = fixture(t); h.write(OLD, h.link()); h.write(OTHER); cache.refreshFolder(h.folder); h.init();
  h.append(OLD, h.padding); h.append(OTHER, h.padding);
  const read = fs.readSync, open = fs.openSync, descriptors = new Map(), bytes = new Map();
  t.mock.method(fs, 'openSync', (file, ...args) => { const fd = open(file, ...args); descriptors.set(fd, file); return fd; });
  t.mock.method(fs, 'readSync', (...args) => { const n = read(...args), file = descriptors.get(args[0]); bytes.set(file, (bytes.get(file) || 0) + n); return n; });
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  assert.equal(preparedContinuations.size, 1); assert.ok(bytes.get(h.file(OLD)) > 2 * 1024 * 1024); assert.equal(bytes.get(h.file(OTHER)), undefined);
  bytes.clear(); cache.refreshFolder(h.folder, { files: new Set([OTHER + '.jsonl', OLD + '.jsonl']), preparedContinuations });
  assert.ok(bytes.get(h.file(OLD)) < 600 * 1024); assert.ok(bytes.get(h.file(OTHER)) < 1600 * 1024);
  bytes.clear(); assert.equal((await cache.prepareContinuationRefresh(h.folder)).size, 0); assert.equal(bytes.size, 0);
});

test('B5 deferred linked source receives no bridge-merge effects from a new predecessor', { timeout: 9000 }, async t => {
  const h = fixture(t), predecessor = '00000000-0000-4000-8000-000000000000';
  const bridge = line({ type: 'bridge-session', bridgeSessionId: 'cse_deferred_718' });
  h.write(OLD, bridge + h.link()); cache.refreshFolder(h.folder); h.init();
  const before = structuredClone(h.rows.get(OLD));
  h.append(OLD);
  fs.writeFileSync(h.file(predecessor), line({ type: 'user', sessionId: predecessor, cwd: h.root,
    timestamp: '2026-10-18T08:00:00.000Z', message: { content: 'earlier part' } }) + bridge);
  h.effects.length = 0;
  const preparedContinuations = new Map([[OLD, null]]);
  cache.refreshFolder(h.folder, { files: new Set([OLD + '.jsonl', predecessor + '.jsonl']), preparedContinuations });
  assert.deepEqual(h.rows.get(OLD), before, 'bridge merging must preserve the entire deferred source row');
  assert.equal(h.effects.some(([kind, value]) => kind === 'upsert' ? value.some(row => row.sessionId === OLD) : value === OLD), false);
  assert.equal(h.folders.get(h.folder).indexMtimeMs, 0);
});

for (const failure of ['missing-projects', 'folder-read']) test('718b reconcile tolerates ' + failure + ' and continues healthy folders', async t => {
  const path = require('node:path');
  const h = fixture(t), errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  if (failure === 'missing-projects') {
    fs.rmSync(h.dir, { recursive: true });
    fs.rmdirSync(h.root);
  } else {
    h.write(OLD);
    const healthyRoot = path.join(h.root, 'healthy');
    const healthyFolder = require('../encode-project-path').encodeProjectPath(healthyRoot);
    fs.mkdirSync(healthyRoot);
    fs.mkdirSync(path.join(h.root, healthyFolder));
    fs.writeFileSync(path.join(h.root, healthyFolder, OTHER + '.jsonl'), line({ type: 'user', sessionId: OTHER,
      cwd: healthyRoot, message: { content: 'healthy' } }));
    let reads = 0;
    h.db.getCachedByFolder = folder => { if (folder === h.folder && ++reads === 2) throw Error('folder read failed'); return []; };
    h.init();
  }
  await assert.doesNotReject(cache.reconcileCacheFromFilesystemAsync({ throttle: false }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'Error reconciling cache:');
  assert.match(errors[0][1].message, failure === 'missing-projects' ? /ENOENT/ : /folder read failed/);
  if (failure === 'folder-read') assert.ok(h.rows.has(OTHER), 'healthy folder is still reconciled');
});

for (const missing of ['file', 'folder', 'project-path']) test('718b deleted deferred ' + missing + ' is forgotten', async t => {
  const h = fixture(t); h.write(OLD, h.link()); h.write(OTHER); cache.refreshFolder(h.folder); h.init();
  h.append(OLD, h.padding); cache.refreshFolder(h.folder);
  const scope = () => cache.continuationRefreshScope(h.folder, { files: new Set([OTHER + '.jsonl']) }).files;
  assert.equal(scope().has(OLD + '.jsonl'), true);
  if (missing === 'folder') fs.rmSync(h.dir, { recursive: true });
  else if (missing === 'project-path') {
    h.folders.delete(h.folder); fs.unlinkSync(h.file(OTHER)); fs.writeFileSync(h.file(OLD), '{}\n');
  } else fs.unlinkSync(h.file(OLD));
  cache.refreshFolder(h.folder);
  assert.equal(scope().has(OLD + '.jsonl'), false, 'a full refresh clears obsolete deferred work');
  if (missing === 'file') {
    const committed = h.folders.get(h.folder).indexMtimeMs;
    assert.ok(committed > 0);
    const visited = [];
    await cache.reconcileCacheFromFilesystemAsync({ throttle: false, onFolder: folder => visited.push(folder) });
    assert.equal(h.folders.get(h.folder).indexMtimeMs, committed);
    assert.deepEqual(visited, [h.folder]);
  }
});

test('718b final stamp check defers a source changed after its header was accepted', async t => {
  const h = fixture(t); h.write(OLD, h.link()); cache.refreshFolder(h.folder); h.append(OLD, h.padding);
  const preparedContinuations = await cache.prepareContinuationRefresh(h.folder);
  const before = structuredClone(h.rows.get(OLD)), stat = fs.statSync; let checks = 0;
  const hook = t.mock.method(fs, 'statSync', (file, options) => {
    if (file === h.file(OLD) && options?.bigint && ++checks === 3) h.append(OLD);
    return stat(file, options);
  });
  cache.refreshFolder(h.folder, { preparedContinuations }); hook.mock.restore();
  assert.equal(checks, 3, 'the race reaches the final pre-commit stamp check');
  assert.deepEqual(h.rows.get(OLD), before, 'a late file change must not publish a stale row');
  assert.equal(h.folders.get(h.folder).indexMtimeMs, 0);
  assert.ok(cache.continuationRefreshScope(h.folder, { files: new Set([OTHER + '.jsonl']) }).files.has(OLD + '.jsonl'));
});
