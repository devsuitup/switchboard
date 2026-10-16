'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('espree');
const archive = require('../archived-projects');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const { encodeProjectPath } = require('../encode-project-path');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });

function handler(name, deps) {
  const nodes = [];
  function walk(node) { if (!node || typeof node !== 'object') return; nodes.push(node); for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value); } }
  walk(ast);
  const registration = nodes.find(node => node.type === 'ExpressionStatement'
    && node.expression.callee?.object?.name === 'ipcMain'
    && node.expression.arguments[0]?.value === name);
  assert.ok(registration, name);
  const callback = registration.expression.arguments[1];
  return vm.runInNewContext(`(${source.slice(...callback.range)})`, {
    ...deps, writer: memoryWriter(deps),
  });
}

function settings(initial) {
  const values = structuredClone(initial);
  const writes = [];
  return {
    values, writes,
    getSetting: key => structuredClone(values[key] ?? null),
    setSetting: (key, value) => { values[key] = structuredClone(value); writes.push(key); },
  };
}

test('rename reads the current summary after storing metadata and patches only the search title', async () => {
  const calls = [];
  const rename = handler('rename-session', {
    setName: (...args) => calls.push(['name', ...args]),
    getCachedSession: id => { calls.push(['read', id]); return { summary: 'summary' }; },
    updateSearchTitle: (...args) => calls.push(['title', ...args]),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await rename(null, 'id', 'new'))), { name: 'new' });
  assert.deepEqual(calls, [['name', 'id', 'new'], ['read', 'id'], ['title', 'id', 'session', 'new summary']]);
  calls.length = 0;
  await rename(null, 'id', '');
  assert.deepEqual(calls, [['name', 'id', null], ['read', 'id'], ['title', 'id', 'session', 'summary']]);
});

test('worktree cleanup selects matching rows, preserves unrelated settings and retires the archive into an offer', async () => {
  const project = '/repo/.worktrees/task';
  const entry = archive.archivedEntry(null, project);
  const state = settings({
    global: { hiddenProjects: [project, '/other'], hiddenProjectKinds: { [project]: 'archive', '/other': 'delete' }, openWorkingSet: ['kept'] },
    archivedProjects: { [entry]: { archivedAt: 'then', disabledSchedules: ['schedule.md'] } },
    scheduleReenableOffers: { other: { disabledSchedules: ['other.md'] } },
  });
  const deleted = [];
  const remove = handler('delete-worktree', {
    ...state, clearArchivedEntry: archive.clearArchivedEntry,
    WORKTREE_PATH_RE: /^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/([^/]+)\/?$/,
    isKnownProjectRoot: () => true,
    execFile: (_exe, _args, cb) => cb(null, '', ''),
    getAllCached: () => [{ sessionId: 'a', projectPath: project }, { sessionId: 'b', projectPath: '/other' }],
    deleteCachedSession: id => deleted.push(['cache', id]),
    deleteSearchSession: id => deleted.push(['search', id]),
    encodeProjectPath,
    deleteCachedFolder: folder => deleted.push(['folder', folder]),
    deleteSearchFolder: folder => deleted.push(['fts-folder', folder]),
    log: { info() {}, warn() {} }, notifyRendererProjectsChanged() {},
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await remove(null, project))), { ok: true, removed: 1 });
  assert.deepEqual(deleted, [['cache', 'a'], ['search', 'a'], ['folder', encodeProjectPath(project)], ['fts-folder', encodeProjectPath(project)]]);
  assert.deepEqual(state.values.global, { hiddenProjects: ['/other'], hiddenProjectKinds: { '/other': 'delete' }, openWorkingSet: ['kept'] });
  assert.deepEqual(state.values.archivedProjects, {});
  assert.deepEqual(state.values.scheduleReenableOffers[entry], { archivedAt: 'then', disabledSchedules: ['schedule.md'] });
  assert.deepEqual(state.values.scheduleReenableOffers.other, { disabledSchedules: ['other.md'] });
});

test('archive reappearance honors global visibility and retains existing schedule offers', async () => {
  const project = path.resolve('/repo');
  const state = settings({
    global: { hiddenProjects: ['/hidden'] },
    archivedProjects: { [project]: { knownSessionIds: ['old'], archivedAt: 'then', disabledSchedules: ['schedule.md'] } },
    scheduleReenableOffers: { other: { disabledSchedules: ['other.md'] } },
  });
  const result = await archive.applyAndPersistArchived([
    { projectPath: '/hidden', sessions: [{ sessionId: 'hidden' }] },
    { projectPath: project, sessions: [{ sessionId: 'new' }] },
  ], false, { ...state, scheduleName: () => 'schedule' });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].reenableOffer, { names: ['schedule'] });
  assert.deepEqual(state.writes, ['archivedProjects', 'scheduleReenableOffers']);
  assert.deepEqual(state.values.archivedProjects, {});
  assert.ok(state.values.scheduleReenableOffers.other);
});

test('reenable failures remain offered, dismiss removes only the selected entry', async () => {
  const project = path.resolve('/repo');
  const state = settings({ scheduleReenableOffers: {
    [project]: { archivedAt: 'then', disabledSchedules: ['a', 'b'] }, other: { disabledSchedules: ['c'] },
  } });
  const deps = { ...state, notify() {}, reenable: () => ({ enabled: ['A'], failed: [{ filePath: 'b', name: 'B', error: 'denied' }] }) };
  assert.deepEqual(await archive.reenableOfferedSchedules(project, null, deps), { ok: true, enabled: ['A'], failed: [{ name: 'B', error: 'denied' }] });
  assert.deepEqual(state.values.scheduleReenableOffers[project], { archivedAt: 'then', disabledSchedules: ['b'], failed: [{ name: 'B', error: 'denied' }] });
  assert.deepEqual(await archive.dismissReenableOffer(project, null, deps), { ok: true });
  assert.deepEqual(state.values.scheduleReenableOffers, { other: { disabledSchedules: ['c'] } });
});
