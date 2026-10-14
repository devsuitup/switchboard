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
    setImmediate, activeSessions: new Map(), getSetting: () => ({}),
    getSearchFileIds: () => [], applySearchFileBatch: () => {}, ...overrides,
  });
  vm.runInContext(source.slice(start, end), context);
  return context;
}

function delta(count) {
  return {
    manifest: Array.from({ length: count }, (_, i) => [String(i), 'sig']),
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
