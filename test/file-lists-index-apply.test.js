'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function mainIndex(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('const fileListStates =');
  const end = source.indexOf('const fileListClients =');
  const context = vm.createContext({
    Buffer, path, process, CLAUDE_DIR: path.resolve('test-claude'),
    require: require('node:module').createRequire(path.join(__dirname, '..', 'main.js')),
    setImmediate, activeSessions: new Map(), getSetting: () => ({}),
    getSearchFileIds: () => [], applySearchFileBatch: () => {}, ...overrides,
  });
  vm.runInContext(source.slice(start, end), context, { filename: path.join(__dirname, '..', 'main.js') });
  return context;
}

function delta(count) {
  return {
    manifest: Array.from({ length: count }, (_, i) => [String(i), JSON.stringify([JSON.stringify([1, 4, String(i)]), 'title'])]),
    deletes: [], upserts: Array.from({ length: count }, (_, i) => ({ id: String(i), type: 'memory', body: 'body' })),
  };
}

test('main writes at most 50 entries per transaction, yields and acknowledges only written signatures', async () => {
  const batches = [];
  let turns = 0;
  const ctx = mainIndex({
    applySearchFileBatch: (kind, deletes, entries) => batches.push({ kind, deletes, entries }),
    setImmediate: fn => setImmediate(() => { turns++; fn(); }),
  });
  ctx.fileListsSnapshot('memory');
  assert.equal(await ctx.applyFileListIndex('memory', delta(115), () => true), true);
  assert.deepEqual(batches.map(batch => batch.entries.length), [50, 50, 15]);
  assert.equal(turns, 3);
  assert.equal(ctx.fileListsSnapshot('memory').indexed.length, 115);
});

test('a hidden-project change between transactions stops further writes', async () => {
  let hiddenProjects = [];
  const batches = [];
  const ctx = mainIndex({
    getSetting: () => ({ hiddenProjects }),
    applySearchFileBatch: (_kind, _deletes, entries) => batches.push(entries),
    setImmediate: fn => setImmediate(() => { hiddenProjects = ['repo']; fn(); }),
  });
  const version = ctx.fileListsSnapshot('memory').version;
  assert.equal(await ctx.applyFileListIndex('memory', delta(115), () => ctx.fileListsSnapshot('memory').version === version), false);
  assert.equal(batches.length, 1);
  assert.equal(ctx.fileListsSnapshot('memory').indexed.length, 50);
});

test('a failed DB transaction does not acknowledge its signatures', async () => {
  const ctx = mainIndex({ applySearchFileBatch: () => { throw new Error('DB failed'); } });
  ctx.fileListsSnapshot('memory');
  await assert.rejects(ctx.applyFileListIndex('memory', delta(1), () => true), /DB failed/);
  assert.equal(ctx.fileListsSnapshot('memory').indexed.length, 0);
});

test('snapshots carry only live roots and hidden-project state without filesystem work', () => {
  const ctx = mainIndex({
    activeSessions: new Map([['one', { projectPath: 'repo' }]]),
    getSetting: () => ({ hiddenProjects: ['hidden'] }),
    getSearchFileIds: () => ['existing'],
  });
  const state = ctx.fileListsSnapshot('memory');
  assert.deepEqual(JSON.parse(JSON.stringify(state.activeProjectPaths)), ['repo']);
  assert.deepEqual(JSON.parse(JSON.stringify(state.hiddenProjects)), ['hidden']);
  assert.deepEqual(JSON.parse(JSON.stringify(state.indexed)), [['existing', null]]);
});

test('session start and stop change Memory policy but leave Work Files jobs valid', () => {
  const sessions = new Map();
  const ctx = mainIndex({ activeSessions: sessions });
  const workVersion = ctx.fileListsSnapshot('work-file').version;
  const memoryVersion = ctx.fileListsSnapshot('memory').version;
  sessions.set('one', { projectPath: 'repo' });
  assert.equal(ctx.fileListsSnapshot('work-file').version, workVersion);
  assert.notEqual(ctx.fileListsSnapshot('memory').version, memoryVersion);
  sessions.clear();
  assert.equal(ctx.fileListsSnapshot('work-file').version, workVersion);
});

test('index transactions bound UTF-8 body bytes as well as entry count', async () => {
  const batches = [];
  const ctx = mainIndex({ applySearchFileBatch: (_kind, _deletes, entries) => batches.push(entries) });
  ctx.fileListsSnapshot('memory');
  const result = delta(5);
  for (const entry of result.upserts) entry.body = '\u754c'.repeat(32768);
  assert.equal(await ctx.applyFileListIndex('memory', result, () => true), true);
  assert.ok(batches.every(entries => entries.length <= 50 && entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.body), 0) <= 128 * 1024));
  assert.equal(batches.flat().length, 5);
  assert.ok(batches.flat().every(entry => entry.body.length === 32768));
});

test('unrelated Markdown saves leave both list versions and invalidations unchanged', () => {
  const ctx = mainIndex();
  for (const kind of ['memory', 'work-file']) {
    const before = ctx.fileListsSnapshot(kind);
    ctx.invalidateFtsSignature(kind, path.join(path.parse(process.cwd()).root, 'unrelated-repo', 'docs', 'guide.md'));
    const after = ctx.fileListsSnapshot(kind);
    assert.equal(after.version, before.version);
    assert.equal(after.invalidated.length, 0);
    assert.equal(after.indexed.length, 0);
  }
});

test('invalidations stay bounded across saves while a list is not being requested', () => {
  const ctx = mainIndex();
  ctx.fileListsSnapshot('memory');
  for (let i = 0; i < 1000; i++) ctx.invalidateFtsSignature('memory', path.resolve(`repo/.claude/${i}.md`));
  const state = ctx.fileListsSnapshot('memory');
  assert.ok(state.invalidated.length <= 256);
  assert.equal(state.invalidateAll, true);
  assert.equal(state.indexed.length, 0, 'saving an unlisted file must not grow the accepted index');
});

test('saves before a first list snapshot retain no per-path invalidations', () => {
  const ctx = mainIndex();
  for (let i = 0; i < 1000; i++) ctx.invalidateFtsSignature('memory', path.resolve(`repo/.claude/${i}.md`));
  const state = ctx.fileListsSnapshot('memory');
  assert.equal(state.invalidated.length, 0);
  assert.equal(state.invalidateAll, true);
});

test('a successful apply clears bounded whole-type invalidation for the next snapshot', async () => {
  const ctx = mainIndex();
  ctx.fileListsSnapshot('memory');
  for (let i = 0; i < 1000; i++) ctx.invalidateFtsSignature('memory', path.resolve(`repo/.claude/${i}.md`));
  assert.equal(await ctx.applyFileListIndex('memory', delta(0), () => true), true);
  const state = ctx.fileListsSnapshot('memory');
  assert.equal(state.invalidated.length, 0);
  assert.equal(state.invalidateAll, false);
});

test('path keys fold Windows case and separators while preserving POSIX case', () => {
  const { fileListPathKey } = require('../file-lists-path');
  const file = path.resolve('repo/.claude/Note.md');
  assert.equal(fileListPathKey(file, 'win32'), file.replace(/\\/g, '/').toLowerCase());
  assert.equal(fileListPathKey(file, 'linux'), file.replace(/\\/g, '/'));
});

test('Windows invalidation matches accepted file IDs with different case and separators', () => {
  const file = path.resolve('repo/.claude/Note.md');
  const ctx = mainIndex({ process: { platform: 'win32' }, getSearchFileIds: () => [file] });
  ctx.fileListsSnapshot('memory');
  ctx.invalidateFtsSignature('memory', file.toUpperCase().replace(/\\/g, '/'));
  const state = ctx.fileListsSnapshot('memory');
  assert.equal(state.indexed.length, 1);
  assert.equal(state.indexed[0][1], null);
  assert.equal(state.invalidated[0], file.replace(/\\/g, '/').toLowerCase());
});

test('repeated saves of a resolved Memory alias keep invalidating after its signature was cleared', async () => {
  const ctx = mainIndex();
  const alias = path.resolve('repo/.claude/commands/alias.md');
  const target = path.join(path.parse(process.cwd()).root, 'unrelated-repo', 'docs', 'source.md');
  const signature = JSON.stringify([JSON.stringify([1, 6, target]), 'alias']);
  ctx.fileListsSnapshot('memory');
  await ctx.applyFileListIndex('memory', { manifest: [[alias, signature]], deletes: [], upserts: [{ id: alias, body: 'before' }] }, () => true);
  ctx.invalidateFtsSignature('memory', target);
  const before = ctx.fileListsSnapshot('memory');
  ctx.invalidateFtsSignature('memory', target);
  const after = ctx.fileListsSnapshot('memory');
  assert.notEqual(after.epoch, before.epoch);
  assert.equal(after.indexed.length, 1);
  assert.equal(after.indexed[0][1], null);
});
