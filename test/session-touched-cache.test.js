'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const touched = require('../session-touched-files');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const DAY = 86400000;

test('remote Touched refresh reuses the transcript cache while repeating one disk batch', async t => {
  const w = world(t);
  const mirror = path.join(w.root, 'remote', 'host', 'projects', '-repo');
  fs.mkdirSync(mirror, { recursive: true });
  const transcript = path.join(mirror, 'S1.jsonl');
  fs.writeFileSync(transcript, line('/repo/old', 2) + line('/repo/a', 0));
  let calls = 0;
  const deps = { dataDir: w.root, getCachedFolder: () => 'host::-repo', isRemoteFolder: () => true,
    isSensitive: async () => { throw new Error('remote paths must not reach local sensitivity checks'); },
    cache: w.cache, now: () => NOW, windowDays: 1,
    runRemoteCommand: async () => { calls++; return { code: 0, stdout: 'present\t1700000000\n' }; } };
  const initial = await touched.listSessionTouchedFiles('S1', deps);
  assert.equal(initial.ok, true, initial.error);
  assert.deepEqual(initial.files.map(f => f.path), ['/repo/a']);
  assert.equal(initial.hasOlder, true);
  w.reads.length = 0;
  w.parses.length = 0;
  const refreshed = await touched.listSessionTouchedFiles('S1', deps);
  assert.deepEqual(refreshed.files, initial.files);
  assert.equal(w.reads.length, 0);
  assert.equal(w.parses.length, 0);
  assert.equal(calls, 2);
  deps.windowDays = 11;
  deps.runRemoteCommand = async () => { calls++; return { code: 0, stdout: 'present\t1700000000\npresent\t1700000000\n' }; };
  const extended = await touched.listSessionTouchedFiles('S1', deps);
  assert.deepEqual(extended.files.map(f => f.path), ['/repo/a', '/repo/old']);
  assert.equal(calls, 3);
});
function line(name, days = 0, extra = '') {
  return JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - days * DAY).toISOString(), message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: name, content: extra } }] } }) + '\n';
}
function world(t, maxSessions = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touch-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'S1.jsonl');
  const reads = [];
  const parses = [];
  const cache = touched.createTouchedFilesCache({ maxSessions, onRead: (p, start, bytes) => reads.push({ p, start, bytes }), onParse: p => parses.push(p) });
  const options = { folderPath: root, sessionId: 'S1', cache, now: () => NOW, isSensitive: async () => false, pathOps: path.posix, statPath: async () => ({ isFile: () => true, mtimeMs: NOW - 1000 }) };
  const get = (over = {}) => touched.collectSessionTouchedFiles({ ...options, ...over });
  return { root, transcript, reads, parses, cache, get };
}

test('unchanged transcripts have zero reads and appends read only the new range after validation', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/a'));
  await w.get();
  w.reads.length = 0;
  w.parses.length = 0;
  await w.get();
  assert.equal(w.reads.length, 0);
  assert.equal(w.parses.length, 0);
  const end = fs.statSync(w.transcript).size;
  fs.appendFileSync(w.transcript, line('/b'));
  const updated = await w.get();
  assert.deepEqual(updated.files.map(f => f.path).sort(), ['/a', '/b']);
  assert.ok(w.reads.some(r => r.start === end), 'new lines start at the old complete end');
  assert.equal(w.parses.length, 1, 'only the added complete line was parsed');
  assert.equal(updated.files[0].diskMtime, NOW - 1000);
});

test('incremental parsing equals a fresh parse through partial UTF-8 lines and several appends', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/a'));
  await w.get();
  const next = Buffer.from(line('/café', 0.1));
  fs.appendFileSync(w.transcript, next.subarray(0, next.indexOf(Buffer.from('é')) + 1));
  assert.equal((await w.get()).files.length, 1, 'incomplete tail is not parsed');
  fs.appendFileSync(w.transcript, next.subarray(next.indexOf(Buffer.from('é')) + 1));
  for (let i = 0; i < 4; i++) {
    fs.appendFileSync(w.transcript, line(i % 2 ? '/a' : '/café', 0));
    const actual = await w.get();
    const fresh = await w.get({ cache: touched.createTouchedFilesCache() });
    assert.deepEqual(actual.files, fresh.files);
  }
});

test('the initial incomplete tail and a complete line followed by a partial append resume at the last newline', async (t) => {
  const w = world(t);
  const pending = line('/pending');
  fs.writeFileSync(w.transcript, line('/a') + pending.slice(0, 40));
  assert.deepEqual((await w.get()).files.map(f => f.path), ['/a']);
  fs.appendFileSync(w.transcript, pending.slice(40));
  assert.equal((await w.get()).files.length, 2);
  const more = line('/more');
  fs.appendFileSync(w.transcript, line('/complete') + more.slice(0, 40));
  assert.equal((await w.get()).files.length, 3);
  fs.appendFileSync(w.transcript, more.slice(40));
  assert.equal((await w.get()).files.length, 4);
});

test('truncation, same-size rewrite and a changed prefix invalidate previous touches', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/a') + line('/b'));
  await w.get();
  fs.writeFileSync(w.transcript, line('/c'));
  assert.deepEqual((await w.get()).files.map(f => f.path), ['/c']);
  fs.writeFileSync(w.transcript, line('/d'));
  fs.utimesSync(w.transcript, new Date(), new Date(Date.now() + 1000));
  assert.deepEqual((await w.get()).files.map(f => f.path), ['/d']);
  fs.writeFileSync(w.transcript, line('/e') + line('/f'));
  assert.deepEqual((await w.get()).files.map(f => f.path).sort(), ['/e', '/f']);
});

test('session LRU eviction and transcript deletion discard cached entries', async (t) => {
  const w = world(t, 1);
  fs.writeFileSync(w.transcript, line('/a'));
  await w.get();
  fs.writeFileSync(path.join(w.root, 'S2.jsonl'), line('/b'));
  await w.get({ sessionId: 'S2' });
  w.reads.length = 0;
  await w.get();
  assert.ok(w.reads.length > 0);
  fs.unlinkSync(w.transcript);
  assert.equal((await w.get()).reason, 'no-transcript');
  fs.writeFileSync(w.transcript, line('/z'));
  assert.deepEqual((await w.get()).files.map(f => f.path), ['/z']);
  w.cache.dropSession('S1');
  w.reads.length = 0;
  await w.get();
  assert.ok(w.reads.length > 0);
});

test('default day, two extensions, old transcript skip, and latest touch across subagents', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/old', 15) + line('/middle', 5) + line('/new', 0.2));
  const sub = path.join(w.root, 'S1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const oldSub = path.join(sub, 'agent-old.jsonl');
  fs.writeFileSync(oldSub, line('/old-sub', 18));
  fs.utimesSync(oldSub, new Date(NOW - 18 * DAY), new Date(NOW - 18 * DAY));
  fs.writeFileSync(path.join(sub, 'agent-new.jsonl'), line('/new', 0.1));
  const first = await w.get();
  assert.deepEqual(first.files.map(f => f.path), ['/new']);
  assert.equal(first.files[0].lastTouched, NOW - 0.1 * DAY);
  assert.equal(first.hasOlder, true);
  assert.ok(!w.reads.some(r => r.p === oldSub));
  assert.deepEqual((await w.get({ windowDays: 11 })).files.map(f => f.path).sort(), ['/middle', '/new']);
  const last = await w.get({ windowDays: 21 });
  assert.equal(last.files.length, 4);
  assert.equal(last.hasOlder, false);
  assert.equal(last.olderFiles, 0);
  const smaller = await w.get();
  assert.equal(smaller.olderFiles, 3);
});

test('a one-day tail reads a small fraction of a real-sized transcript', async (t) => {
  const w = world(t);
  const content = Array.from({ length: 12000 }, (_, i) => line('/history', 2 + (12000 - i) / 1000, 'x'.repeat(2048))).join('') + line('/recent', 0);
  fs.writeFileSync(w.transcript, content);
  const recent = await w.get();
  const bytes = w.reads.reduce((n, r) => n + r.bytes, 0);
  assert.equal(recent.files.length, 1);
  assert.ok(bytes < Buffer.byteLength(content) / 20, `${bytes} of ${Buffer.byteLength(content)} bytes`);
  t.diagnostic(`one day: ${bytes} bytes; full fixture: ${Buffer.byteLength(content)} bytes`);
  assert.equal((await w.get({ windowDays: Infinity })).files.length, 2);
  let fullBytes = 0;
  const fullCache = touched.createTouchedFilesCache({ onRead: (_p, _start, n) => { fullBytes += n; } });
  const full = await w.get({ cache: fullCache, windowDays: Infinity });
  assert.equal(full.files.length, 2);
  assert.ok(fullBytes >= Buffer.byteLength(content));
  t.diagnostic(`measured one day: ${bytes} bytes; measured full read: ${fullBytes} bytes`);
});

test('an exhausted byte budget can be retried without poisoning the cache', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/a') + line('/b'));
  assert.equal((await w.get({ maxBytes: 20 })).coverage.truncated, true);
  assert.deepEqual((await w.get()).files.map(f => f.path).sort(), ['/a', '/b']);
});

test('a narrowed cached result carries older rows so extending it needs no further read or parse', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/old', 5) + line('/new', 0));
  await w.get({ windowDays: 11 });
  w.reads.length = 0;
  const narrowed = await w.get();
  assert.equal(narrowed.olderFiles, 1);
  assert.deepEqual(narrowed.cachedFiles.map(f => f.path).sort(), ['/new', '/old']);
  assert.equal(w.reads.length, 0);
});

test('only the entry timestamp counts, never a nested tool input timestamp', async (t) => {
  const w = world(t);
  const entry = JSON.parse(line('/a'));
  delete entry.timestamp;
  entry.message.content[0].input.timestamp = new Date(NOW - 5 * DAY).toISOString();
  fs.writeFileSync(w.transcript, JSON.stringify(entry) + '\n' + line('/b'));
  const result = await w.get();
  assert.equal(result.files.length, 2);
  assert.equal(result.files.find(f => f.path === '/a').lastTouched, null);
});

test('the transcript cache ceiling keeps the latest appended path and equals a fresh parse past 1000 touches', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, Array.from({ length: 1000 }, (_, i) => line(`/old-${i}`, 0.9 - i / 2000)).join(''));
  await w.get();
  fs.appendFileSync(w.transcript, line('/latest', 0));
  const result = await w.get({ maxFiles: 1000 });
  assert.ok(result.files.some(f => f.path === '/latest'));
  assert.ok(!result.files.some(f => f.path === '/old-0'));
  const fresh = await w.get({ maxFiles: 1000, cache: touched.createTouchedFilesCache() });
  assert.deepEqual(result.files, fresh.files);
  assert.equal(result.omitted, fresh.omitted);
});

test('an mtime-skipped transcript exposes its newest unread activity for a one-click extension', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/sixty-days', 60));
  fs.utimesSync(w.transcript, new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));
  const initial = await w.get();
  assert.equal(initial.nextOlderTimestamp, NOW - 60 * DAY);
  assert.equal(w.reads.length, 0);
  const extended = await w.get({ windowDays: Math.ceil((NOW - initial.nextOlderTimestamp) / DAY) });
  assert.deepEqual(extended.files.map(f => f.path), ['/sixty-days']);
  assert.equal(extended.hasOlder, false);
});

test('a valid unterminated final line yields one touch and is reread without duplicates on append', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/single').trimEnd());
  assert.equal((await w.get()).files.find(f => f.path === '/single')?.count, 1);
  assert.equal((await w.get()).files.find(f => f.path === '/single')?.count, 1);
  fs.appendFileSync(w.transcript, '\n' + line('/half').slice(0, 40));
  assert.equal((await w.get()).files.find(f => f.path === '/single')?.count, 1);
  fs.appendFileSync(w.transcript, line('/half').slice(40).trimEnd());
  const result = await w.get();
  assert.equal(result.files.find(f => f.path === '/half')?.count, 1);
  fs.appendFileSync(w.transcript, '\n');
  assert.deepEqual((await w.get()).files, result.files);
});

test('each backward transcript line is JSON parsed once', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/a') + line('/b'));
  const original = JSON.parse;
  let parses = 0;
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.includes('"tool_use"')) parses++;
    return original(text, ...args);
  };
  try {
    assert.equal((await w.get()).files.length, 2);
    assert.equal(parses, 2);
  } finally { JSON.parse = original; }
});

test('deleted subagent records are removed even when recreated with the same size and mtime', async (t) => {
  const w = world(t);
  fs.writeFileSync(w.transcript, line('/a'));
  const dir = path.join(w.root, 'S1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const sub = path.join(dir, 'agent-sub.jsonl');
  fs.writeFileSync(sub, line('/b'));
  fs.utimesSync(sub, new Date(NOW), new Date(NOW));
  const stamp = fs.statSync(sub).mtime;
  assert.equal((await w.get()).files.length, 2);
  fs.unlinkSync(sub);
  assert.equal((await w.get()).files.length, 1);
  fs.writeFileSync(sub, line('/c'));
  fs.utimesSync(sub, stamp, stamp);
  assert.deepEqual((await w.get()).files.map(f => f.path).sort(), ['/a', '/c']);
});

for (const changedLine of [0, 9]) {
  test(`a growing rewrite of line ${changedLine} is detected by the prefix or end anchor independently`, async (t) => {
    const w = world(t);
    const entries = Array.from({ length: 10 }, () => line('/a'));
    fs.writeFileSync(w.transcript, entries.join(''));
    await w.get();
    entries[changedLine] = line('/z');
    fs.writeFileSync(w.transcript, entries.join('') + line('/b'));
    const result = await w.get();
    assert.equal(result.files.find(f => f.path === '/a').count, 9);
    assert.equal(result.files.find(f => f.path === '/z')?.count, 1);
  });
}
