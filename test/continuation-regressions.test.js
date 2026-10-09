'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cache = require('../session-cache');
const { scanContinuationIndex } = require('../session-continuations');
const { loadAppFunctions } = require('./app-source');
const { setup } = require('./continuations-harness');

function append(h, text) {
  const file = path.join(h.root, h.folder, 'old.jsonl');
  fs.appendFileSync(file, text);
  return file;
}

for (const [name, text] of [
  ['truncated tail', '{"type":"assistant","message":'],
  ['malformed middle line', '{bad json}\n{}\n'],
  ['oversized line', JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024), type: 'assistant' }) + '\n'],
]) {
  for (const mode of ['manual', 'restore']) {
    test(`R2 ${name} without continued-in opens the original id on ${mode}`, { timeout: 9000 }, async t => {
      const h = setup(t, { old: [] });
      append(h, text);
      if (name === 'malformed middle line') cache.refreshFolder(h.folder);
      else delete h.rows.get('old').continuationIndex;
      await (mode === 'manual' ? h.click() : h.restore());
      assert.deepEqual(h.spawned.map(call => call.id), ['old']);
      assert.deepEqual(h.prompts, []);
    });
  }
}

test('R2 cold full scan tolerates malformed ordinary records', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] });
  append(h, '{bad json}\n{}\n');
  h.rows.clear();
  cache.refreshFolder(h.folder);
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
});

test('R2 upgrading a fresh legacy index repairs unrelated cached parse errors', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] });
  const file = append(h, '{bad json}\n{}\n');
  const stat = fs.statSync(file);
  h.rows.get('old').continuationIndex = JSON.stringify({ ids: [], bytes: stat.size,
    complete: true, mtime: stat.mtime.toISOString(), unresolved: true });
  await h.click();
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
  assert.deepEqual(h.prompts, []);
});

test('R2 legacy scan completes beyond its injectable pacing budget and yields', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [], new: [] }, { chunkBytes: 64 });
  append(h, JSON.stringify({ type: 'assistant', padding: 'x'.repeat(4096) }) + '\n'
    + '{"type":"continued-in","sessionId":"old","continuedInSessionId":"new"}\n');
  delete h.rows.get('old').continuationIndex;
  const read = t.mock.method(fs, 'readSync');
  let yielded = false;
  const turn = new Promise(resolve => setImmediate(() => { yielded = true; resolve(); }));
  await h.restore();
  await turn;
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.equal(yielded, true);
  assert.ok(read.mock.calls.every(call => call.arguments[3] <= 64), 'injected budget bounds reads, not total scan progress');
  assert.equal(JSON.parse(h.rows.get('old').continuationIndex).complete, true);
});

for (const [name, graph] of [
  ['two continuations', { old: ['a', 'b'], a: [], b: [], other: [] }],
  ['unresolved continuation', { old: ['missing'], other: [] }],
]) {
  test(`R2 automatic restore holds ${name}, restores others and lists a nonblocking notice`, { timeout: 9000 }, async t => {
    const savedEntries = [{ sessionId: 'old', active: true }, { sessionId: 'other' }];
    const h = setup(t, graph, { savedEntries });
    await h.restore();
    assert.deepEqual(h.prompts, []);
    assert.deepEqual(h.spawned.map(call => call.id), ['other']);
    assert.match(h.dom.window.notice, /old/);
    assert.match(h.dom.window.notice, /sidebar.*choose/i);
    assert.deepEqual(h.settings().openWorkingSet.map(item => item.sessionId), ['old', 'other']);
  });
}

test('R2 automatic failed continuation lookup holds the entry without confirm', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] });
  h.ctx.api.getSessionContinuations = async () => { throw new Error('IPC unavailable'); };
  await h.restore();
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.spawned, []);
  assert.match(h.dom.window.notice, /old/);
});

test('R2 a missing continuation API cannot silently bypass the resume guard', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] });
  delete h.ctx.api.getSessionContinuations;
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
  assert.match(h.dom.window.notice, /old/);
});

for (const graph of [{ old: ['a', 'b'], a: [], b: [] }, { old: ['missing'] }]) {
  test(`R2 manual open can explicitly select the original id (${Object.keys(graph).length} nodes)`, { timeout: 9000 }, async t => {
    const h = setup(t, graph, { answer: message => /Open the original session old\?/.test(message) });
    await h.click();
    assert.deepEqual(h.spawned.map(call => call.id), ['old']);
    assert.match(h.prompts.at(-1), /Open the original session old\?/);
  });
}

test('R2 header refresh skips subagents and bounds synchronous continuation reads', { timeout: 9000 }, t => {
  const h = setup(t, { old: [] });
  const subdir = path.join(h.root, h.folder, 'old', 'subagents');
  fs.mkdirSync(subdir, { recursive: true });
  const subfile = path.join(subdir, 'agent-a.jsonl');
  fs.writeFileSync(subfile, JSON.stringify({ type: 'user', isSidechain: true, agentId: 'a', message: { content: 'subagent' } }) + '\n');
  cache.refreshFolder(h.folder);
  const file = append(h, JSON.stringify({ padding: 'x'.repeat(5 * 1024 * 1024), type: 'assistant' }) + '\n');
  fs.appendFileSync(subfile, JSON.stringify({ padding: 'x'.repeat(5 * 1024 * 1024), type: 'assistant' }) + '\n');
  fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
  fs.utimesSync(subfile, new Date('2030-01-01'), new Date('2030-01-01'));
  const descriptors = new Map(), bytes = new Map();
  const open = fs.openSync, read = fs.readSync;
  t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); descriptors.set(fd, args[0]); return fd; });
  t.mock.method(fs, 'readSync', (...args) => {
    const n = read(...args), name = descriptors.get(args[0]);
    bytes.set(name, (bytes.get(name) || 0) + n);
    return n;
  });
  cache.refreshFolder(h.folder, { files: new Set([path.join('old', 'subagents', 'agent-a.jsonl'), 'old.jsonl']) });
  assert.ok(bytes.get(file) <= 1024 * 1024 + 256 * 1024 + 128, 'top-level header plus at most 1 MiB continuation work');
  assert.ok(bytes.get(subfile) <= 256 * 1024, 'subagents receive only the display-header read');
});

test('R2 one refresh shares a 1 MiB continuation budget across changed parents', { timeout: 9000 }, t => {
  const h = setup(t, { old: [], other: [] });
  for (const id of ['old', 'other']) {
    const file = path.join(h.root, h.folder, id + '.jsonl');
    fs.appendFileSync(file, JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024), type: 'assistant' }) + '\n');
    fs.utimesSync(file, new Date('2030-01-01'), new Date('2030-01-01'));
  }
  const read = t.mock.method(fs, 'readSync');
  cache.refreshFolder(h.folder, { files: new Set(['old.jsonl', 'other.jsonl']) });
  const bytes = read.mock.calls.reduce((sum, call) => sum + call.result, 0);
  assert.ok(bytes <= 1024 * 1024 + 2 * 256 * 1024 + 128, 'one continuation pacing budget per refresh');
});

test('R2 yielded continuation indexing preserves fresher display fields', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [], new: [] }, { chunkBytes: 64 });
  append(h, JSON.stringify({ padding: 'x'.repeat(4096), type: 'assistant' }) + '\n'
    + '{"type":"continued-in","sessionId":"old","continuedInSessionId":"new"}\n');
  delete h.rows.get('old').continuationIndex;
  const resolving = h.ctx.api.getSessionContinuations('old');
  const fresh = { ...h.rows.get('old'), summary: 'new summary', modified: '2030-01-01', fileMtime: '2030-01-02' };
  h.db.upsertCachedSessions([fresh]);
  await resolving;
  const row = h.rows.get('old');
  assert.equal(row.summary, fresh.summary);
  assert.equal(row.modified, fresh.modified);
  assert.equal(row.fileMtime, fresh.fileMtime);
  assert.deepEqual(JSON.parse(row.continuationIndex).ids, ['new']);
});

test('R2 append indexing rejects a rewritten indexed tail', { timeout: 9000 }, t => {
  const h = setup(t, { old: [], a: [], b: [] });
  const file = path.join(h.root, h.folder, 'old.jsonl');
  const line = id => JSON.stringify({ type: 'continued-in', sessionId: 'old', continuedInSessionId: id }) + '\n';
  fs.writeFileSync(file, line('a'));
  const previous = scanContinuationIndex(file, 'old');
  fs.writeFileSync(file, line('b') + '{}\n');
  const current = JSON.parse(scanContinuationIndex(file, 'old', previous));
  assert.deepEqual(current.ids, ['b']);
});

test('R2 small chunks ignore split continuation byte patterns in oversized records', { timeout: 9000 }, async t => {
  const h = setup(t, { old: [] }, { chunkBytes: 65536 });
  const prefix = '{"padding":"', suffix = '","type":"continued-in",broken}\n';
  const pad = 2 * 1024 * 1024 + 65530 - prefix.length - suffix.indexOf('continued-in');
  append(h, prefix + 'x'.repeat(pad) + suffix);
  delete h.rows.get('old').continuationIndex;
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
  assert.deepEqual(h.prompts, []);
});

test('R2 startup resolves an active continued session only once', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] });
  const lookup = t.mock.method(h.ctx.api, 'getSessionContinuations');
  vm.runInContext("activeSessionId = 'old';", h.ctx);
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const end = source.indexOf('\n// Live-reload sidebar');
  const start = source.lastIndexOf('loadProjects().then(', end);
  if (source.includes('async function restoreStartupSessions(')) {
    loadAppFunctions(h.ctx, { functions: ['restoreStartupSessions'] });
  }
  h.ctx.restoreWorkingSet = h.restore;
  h.ctx.restoreAgentsViewAtStartup = () => {};
  let startup;
  h.ctx.loadProjects = () => ({ then: callback => { startup = callback(); } });
  vm.runInContext(source.slice(start, end), h.ctx);
  await startup;
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.deepEqual(lookup.mock.calls.map(call => call.arguments[0]), ['old']);
});

test('R2 restore checks final liveness automatically before spawning', { timeout: 9000 }, async t => {
  const h = setup(t, { old: ['new'], new: [] }, { live: { new: { pid: 7 } }, answer: true });
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
  assert.match(h.dom.window.notice, /pid 7/);
});
