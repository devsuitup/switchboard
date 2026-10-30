'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bg = require('../bg-agents');
const { createSessionIndexWriter } = require('../session-index-writer');

function fixture(t, indexed = true) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bg-882-')));
  t.after(() => { bg.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const descriptors = [{ kind: 'interactive', sessionId: 'session-a', cwd: dir }];
  let descriptorChanged, resolvedFile, lookups = 0, stats = 0, throws = 0;
  const stat = fs.statSync;
  const file = path.join(dir, 'session-a.jsonl');
  resolvedFile = file;
  const resolveFile = () => { lookups++; return indexed ? resolvedFile : null; };
  fs.writeFileSync(file, 'transcript');
  t.mock.method(fs, 'statSync', (p, opts) => {
    if (p === file || p === file + '.missing') stats++;
    try { return stat(p, opts); } catch (err) { throws++; throw err; }
  });
  bg.init({ jobsDir: path.join(dir, 'jobs'), homeDir: dir,
    runClaude: async () => ({ code: 0, stdout: '[]' }),
    resolveProjectRoots: async () => ({ projectRoot: dir, worktreeRoot: dir }),
    resolveTranscriptPath: resolveFile,
    cliSessionState: { readAllDescriptors: () => descriptors, ensureWatching() {},
      onDescriptorsChanged: cb => { descriptorChanged = cb; return () => {}; } },
  });
  bg.start();
  return { file, descriptors, counts: () => ({ lookups, stats, throws }),
    setResolvedFile: value => { resolvedFile = value; },
    setIndexed: value => { indexed = value; }, change: () => descriptorChanged(),
    indexed: ids => bg.invalidateTranscripts(ids) };
}

function nextPush(action, allowUnchanged = false) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      if (allowUnchanged) resolve(bg.getSnapshot());
      else reject(new Error('roster push timed out'));
    }, 3000);
    const off = bg.onChange(snapshot => { clearTimeout(timer); off(); resolve(snapshot); });
    action();
  });
}

test('882 unchanged descriptor rebuilds reuse transcript lookup and stat, reconcile rechecks', async t => {
  const f = fixture(t);
  const first = await bg.reconcile();
  assert.equal(first.roster[0].transcriptAvailable, true);
  assert.deepEqual(f.counts(), { lookups: 1, stats: 1, throws: 0 });
  for (let n = 0; n < 4; n++) {
    await nextPush(() => { f.descriptors[0].name = 'revision-' + n; f.change(); });
  }
  assert.deepEqual(f.counts(), { lookups: 1, stats: 1, throws: 0 });
  await bg.reconcile();
  assert.equal(f.counts().stats, 2);
});

test('882 indexed transcript invalidates only its session and pushes availability without reconcile', async t => {
  const f = fixture(t, false);
  f.descriptors.push({ kind: 'interactive', sessionId: 'session-b' });
  assert.equal((await bg.reconcile()).roster[0].transcriptAvailable, false);
  assert.equal(f.counts().lookups, 2);
  assert.equal(typeof bg.invalidateTranscripts, 'function', 'index commits must be able to invalidate transcript availability');
  f.setIndexed(true);
  const snapshot = await nextPush(() => f.indexed(['SESSION-A']), true);
  assert.equal(snapshot.roster[0].transcriptAvailable, true);
  assert.equal(snapshot.roster[1].transcriptAvailable, false);
  assert.equal(f.counts().lookups, 3);
});

test('882 fallback path changes recheck and missing transcripts never throw', async t => {
  const f = fixture(t);
  bg.stop();
  let changed;
  fs.mkdirSync(path.join(path.dirname(f.file), 'jobs', 'aaaaaaaa'), { recursive: true });
  const state = path.join(path.dirname(f.file), 'jobs', 'aaaaaaaa', 'state.json');
  const write = file => fs.writeFileSync(state, JSON.stringify({ state: 'stopped', sessionId: '11111111-1111-4111-8111-111111111111', linkScanPath: file }));
  write(f.file);
  bg.init({ jobsDir: path.dirname(path.dirname(state)), homeDir: path.dirname(f.file),
    runClaude: async () => ({ code: 0, stdout: '[]' }),
    cliSessionState: { readAllDescriptors: () => [], ensureWatching() {}, onDescriptorsChanged: cb => { changed = cb; return () => {}; } },
    resolveProjectRoots: async () => null });
  bg.start();
  assert.equal((await bg.reconcile()).roster[0].transcriptAvailable, true);
  write(f.file + '.missing');
  const result = await nextPush(() => changed());
  assert.equal(result.roster[0].transcriptAvailable, false);
  assert.equal(f.counts().throws, 0);
});

test('882b committed upserts keep available memos and deletions recheck them', async t => {
  const f = fixture(t);
  assert.equal((await bg.reconcile()).roster[0].transcriptAvailable, true);
  let db, metadataOnly = false, scheduled = 0;
  const writer = createSessionIndexWriter({
    readonlyBackend: { getSetting: () => 0, getCachedSession: () => ({ sessionId: 'session-a', folder: 'folder' }), getMeta: () => null },
    onSessionsChanged: (...args) => bg.invalidateTranscripts(...args),
    client: { ready: Promise.resolve(), request: async () => {} },
  }, { init: ctx => { db = ctx.db; }, refreshFolder() {
    if (!metadataOnly) db.upsertCachedSessions([{ sessionId: 'session-a', folder: 'folder' }]);
    db.touchCachedModified('session-a', 1);
    db.setCachedFileSize('session-a', 10);
  } });
  await writer.ready;
  writer.initializeCache({});
  const off = bg.onChange(() => {});
  t.after(off);
  await nextPush(() => { f.descriptors[0].name = 'settled'; f.change(); });
  const before = f.counts();
  const realTimeout = setTimeout;
  const timerMock = t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    if (ms === bg.FLUSH_MS) scheduled++;
    return realTimeout(callback, ms, ...args);
  });
  await writer.refreshFolder('folder');
  await writer.upsertCachedSessions([{ sessionId: 'SESSION-A', folder: 'folder' }]);
  assert.equal(scheduled, 0, 'upserts cannot flip an already available transcript');
  assert.deepEqual(f.counts(), before);
  metadataOnly = true;
  await writer.refreshFolder('folder');
  await writer.setCachedFileSize('session-a', 20);
  assert.equal(scheduled, 0, 'touch/size effects must schedule no rebuild');
  timerMock.mock.restore();
  fs.unlinkSync(f.file);
  const pushed = nextPush(() => {}, true);
  await writer.deleteCachedSession('SESSION-A');
  const snapshot = await pushed;
  assert.equal(snapshot.roster[0].transcriptAvailable, false, 'deletions must evict previously available entries');
  assert.equal(f.counts().lookups, before.lookups + 1);
});

for (const mode of ['compute', 'direct']) {
  test(`894 ${mode} upserts recheck available transcripts only when their indexed folder changes`, async t => {
    const f = fixture(t);
    assert.equal((await bg.reconcile()).roster[0].transcriptAvailable, true);
    let db, folder = 'local', committed = { sessionId: 'session-a', folder };
    const events = [];
    const writer = createSessionIndexWriter({
      readonlyBackend: { getSetting: () => 0, getCachedSession: () => committed, getMeta: () => null },
      onSessionsChanged: (...args) => { events.push(args); bg.invalidateTranscripts(...args); },
      client: { ready: Promise.resolve(), async request(name, ...args) {
        const rows = name === 'effects' ? args[0].find(effect => effect.name === 'upsertCachedSessions').args[0] : args[0];
        committed = { ...rows[0] };
        f.setResolvedFile(committed.folder === 'local' ? f.file : f.file + '.missing');
      } },
    }, { init: ctx => { db = ctx.db; }, refreshFolder() {
      db.upsertCachedSessions([{ sessionId: 'session-a', folder }]);
      return true;
    } });
    await writer.ready;
    writer.initializeCache({});
    const upsert = () => mode === 'compute' ? writer.refreshFolder(folder) : writer.upsertCachedSessions([{ sessionId: 'session-a', folder }]);
    await nextPush(() => { f.descriptors[0].name = 'settled'; f.change(); });
    const before = f.counts().lookups;
    await upsert();
    await nextPush(() => { f.descriptors[0].name = 'same-folder'; f.change(); });
    assert.equal(f.counts().lookups, before, 'same-folder upserts preserve available memos');
    events.length = 0;
    folder = 'remote-alias::local';
    const pushed = nextPush(() => {}, true);
    await upsert();
    const snapshot = await pushed;
    assert.equal(snapshot.roster[0].transcriptAvailable, false, 'moving to an unmirrored folder invalidates available transcripts');
    assert.equal(f.counts().lookups, before + 1);
    assert.deepEqual(events, [[['session-a'], undefined]], 'folder moves notify without upsertOnly');
  });
}

test('894 a malformed id cannot discard valid transcript invalidations in the same batch', async t => {
  const f = fixture(t);
  assert.equal((await bg.reconcile()).roster[0].transcriptAvailable, true);
  fs.unlinkSync(f.file);
  const pushed = nextPush(() => {}, true);
  assert.doesNotThrow(() => bg.invalidateTranscripts([null, 42, undefined, {}, 'SESSION-A']));
  const snapshot = await pushed;
  assert.equal(snapshot.roster[0].transcriptAvailable, false);
  assert.equal(f.counts().lookups, 2);
});
