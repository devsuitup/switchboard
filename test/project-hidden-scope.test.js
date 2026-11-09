'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { applyAndPersistArchived } = require('../archived-projects');
const { isHiddenRepositoryWorktree } = require('../public/worktree-nesting');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const { extractFunction } = require('./app-source');

function storage(t, global) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ global }));
  const db = {
    getSetting: key => JSON.parse(fs.readFileSync(file, 'utf8'))[key],
    setSetting(key, value) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state[key] = value;
      fs.writeFileSync(file, JSON.stringify(state));
    },
    getAllCached: () => [], deleteCachedFolder() {}, deleteSearchFolder() {},
  };
  return { db, writer: memoryWriter(db), dir };
}

test('scoped archive filtering keeps same-path other hosts and their worktrees', () => {
  const global = { hiddenProjects: ['/srv/repo', 'box::/srv/other'],
    hiddenProjectScopes: { '/srv/repo': { alias: null } } };
  const projects = [null, 'box', 'other'].flatMap(remoteAlias => ['/srv/repo', '/srv/other'].map(projectPath => ({ remoteAlias, projectPath, sessions: [] })));
  const visible = applyAndPersistArchived(projects, true, { getSetting: key => key === 'global' ? global : {}, setSetting() {} });
  assert.deepEqual(visible.map(p => [p.remoteAlias, p.projectPath]), [
    [null, '/srv/other'], ['box', '/srv/repo'], ['other', '/srv/repo'], ['other', '/srv/other'],
  ], 'a scoped local mark must leave the same-path remote sentinel visible');
  assert.equal(isHiddenRepositoryWorktree('/srv/repo/.claude/worktrees/w', 'box', global.hiddenProjects, global.hiddenProjectScopes), false,
    'the remote worktree must remain outside a local delete scope');
  assert.equal(isHiddenRepositoryWorktree('/srv/repo/.claude/worktrees/w', null, global.hiddenProjects, global.hiddenProjectScopes), true);
});

test('writer persists explicit scopes and unhide clears only the selected identity', async t => {
  const h = storage(t, { openWorkingSet: ['sentinel'] });
  await h.writer.hideProject('/srv/repo', 'delete', { alias: null });
  await h.writer.hideProject('box::/srv/repo', 'delete', { alias: 'box' });
  assert.deepEqual(h.db.getSetting('global').hiddenProjectScopes, {
    '/srv/repo': { alias: null }, 'box::/srv/repo': { alias: 'box' },
  }, 'writer ACK must persist both scopes');
  await h.writer.revealAddedProject('/srv/repo');
  assert.deepEqual(h.db.getSetting('global'), { openWorkingSet: ['sentinel'], hiddenProjects: ['box::/srv/repo'],
    hiddenProjectKinds: { 'box::/srv/repo': 'delete' }, hiddenProjectScopes: { 'box::/srv/repo': { alias: 'box' } } });
  await h.writer.unhideProject('box::/srv/repo', 'box', '/srv/repo');
  assert.deepEqual(h.db.getSetting('global').hiddenProjectScopes, {});
});

test('worktree cleanup retains the existing path-wide deletion behaviour', async t => {
  const global = { hiddenProjects: ['/srv/repo'], hiddenProjectKinds: { '/srv/repo': 'delete' },
    hiddenProjectScopes: { '/srv/repo': { alias: 'box' } } };
  const h = storage(t, global);
  const deleted = [];
  h.db.getAllCached = () => [{ sessionId: 'local', projectPath: '/srv/repo', folder: '-srv-repo' },
    { sessionId: 'remote', projectPath: '/srv/repo', folder: 'box::-srv-repo' }];
  h.db.deleteCachedSession = id => deleted.push(id);
  h.db.deleteSearchSession = () => {};
  await h.writer.cleanupWorktree('/srv/repo');
  assert.deepEqual(h.db.getSetting('global').hiddenProjects, [], 'cleanup must clear the stored path mark');
  assert.deepEqual(deleted, ['local', 'remote'], 'cleanup keeps its existing path-wide cache deletion');
});

test('file-list policy versions change when only a scope changes', () => {
  const sourcePath = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const global = { hiddenProjects: ['/srv/repo'], hiddenProjectScopes: { '/srv/repo': { alias: null } } };
  const context = vm.createContext({ getSetting: () => global, fileListStates: new Map([['memory', { epoch: 1 }]]), activeSessions: new Map() });
  vm.runInContext(extractFunction(source, 'fileListsPolicy'), context, { filename: sourcePath });
  const before = context.fileListsPolicy('memory').version;
  global.hiddenProjectScopes['/srv/repo'].alias = 'box';
  assert.notEqual(context.fileListsPolicy('memory').version, before, 'scope-only changes must invalidate worker results');
});

test('working-set fallback treats persisted entries as local identities', async () => {
  const sourcePath = path.join(__dirname, '..', 'public', 'app.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const item = { sessionId: 'local', projectPath: '/srv/repo' };
  const opens = [];
  const context = vm.createContext({ activeSessionId: item.sessionId, openSessions: new Map(), indexedSessionById: () => null,
    pendingSessions: new Map(), sessionMap: new Map(), encodeProjectPath: p => p,
    ...require('../public/worktree-nesting'),
    window: { api: { getSetting: async () => ({ openWorkingSet: [item], hiddenProjects: [item.projectPath],
      hiddenProjectScopes: { [item.projectPath]: { alias: null } } }), getActiveSessions: async () => [item] } },
    openSession: async (...args) => opens.push(args),
  });
  vm.runInContext(extractFunction(source, 'reopenActiveSessionAfterReload'), context, { filename: sourcePath });
  await context.reopenActiveSessionAfterReload();
  assert.equal(opens.length, 0, 'local scope must suppress local working-set restore');
});

test('local archive launch policy honours local scopes including normalized paths', t => {
  const h = storage(t, {});
  const sourcePath = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  h.db.setSetting('global', { hiddenProjects: [h.dir], hiddenProjectScopes: { [h.dir]: { alias: null } } });
  const context = vm.createContext({ getSetting: h.db.getSetting,
    normalizeArchivedProjectPath: require('../src/main/shared/normalize-project-path').normalizeProjectPath,
    parseFolderKey: require('../src/main/remote/remote-hosts').parseFolderKey,
    require: createRequire(sourcePath) });
  vm.runInContext(extractFunction(source, 'isProjectSettingsArchived'), context, { filename: sourcePath });
  assert.equal(context.isProjectSettingsArchived(h.dir), true, 'local scope must block local admission');
});

test('writer never narrows an existing bare entry when a scope is supplied', async t => {
  const h = storage(t, { hiddenProjects: ['/srv/repo'] });
  await h.writer.hideProject('/srv/repo', 'delete', { alias: null });
  assert.equal(Object.hasOwn(h.db.getSetting('global').hiddenProjectScopes || {}, '/srv/repo'), false,
    'an existing bare entry must stay unscoped after Delete');
});

test('matcher treats a path containing double colons as an unqualified path', () => {
  const { isProjectHidden } = require('../public/worktree-nesting');
  assert.equal(isProjectHidden(['/a::b'], null, '/a::b'), true, '/a::b is a local path, not a host key');
  assert.equal(isProjectHidden(['/a::b'], 'box', '/a::b'), true, 'bare paths retain every-host matching');
});

test('matcher restricts a bare mark scoped to a remote host to that host', () => {
  const { isProjectHidden } = require('../public/worktree-nesting');
  const scopes = { '/srv/repo': { alias: 'box' } };
  assert.equal(isProjectHidden(['/srv/repo'], null, '/srv/repo', scopes), false, 'remote scope must leave local identity visible');
  assert.equal(isProjectHidden(['/srv/repo'], 'other', '/srv/repo', scopes), false, 'remote scope must leave another host visible');
  assert.equal(isProjectHidden(['/srv/repo'], 'box', '/srv/repo', scopes), true, 'remote scope must hide its selected host');
});

test('matcher factory normalizes stored entries once across repeated queries', () => {
  const { projectHiddenMatcher } = require('../public/worktree-nesting');
  assert.equal(typeof projectHiddenMatcher, 'function', 'a reusable hidden matcher factory must be exported');
  const calls = [];
  const matcher = projectHiddenMatcher(['/hidden', 'box::/remote'], {}, value => { calls.push(value); return value; });
  for (let i = 0; i < 20; i++) assert.equal(matcher(null, '/visible'), false);
  assert.equal(calls.filter(value => value === '/hidden').length, 1, 'normalize each hidden entry once');
  assert.equal(calls.filter(value => value === '/remote').length, 1, 'normalize each qualified entry once');
  const empty = projectHiddenMatcher([], {}, () => assert.fail('empty lists must not normalize paths'));
  assert.equal(empty(null, '/visible'), false);
});

function mainPolicy(global, descriptors, normalize) {
  const filename = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const context = vm.createContext({ getSetting: () => global, normalizeArchivedProjectPath: normalize,
    parseFolderKey: require('../src/main/remote/remote-hosts').parseFolderKey,
    cliSessionState: { getSidebarDescriptors: () => descriptors }, require: createRequire(filename) });
  vm.runInContext(extractFunction(source, 'isProjectSettingsArchived'), context, { filename });
  const start = source.indexOf('getLiveDescriptors: () => {', source.indexOf('sessionTransitions.init({')) + 'getLiveDescriptors: '.length;
  const end = source.indexOf('\n  },', start) + 4;
  return { archived: context.isProjectSettingsArchived, descriptors: vm.runInContext(source.slice(start, end), context, { filename }) };
}

test('local admission preserves the base parent comparison for a missing Windows worktree',
  { skip: process.platform !== 'win32' }, t => {
    const h = storage(t, {});
    const repo = path.join(h.dir, 'MixedCaseRepo');
    fs.mkdirSync(repo);
    const missing = path.join(repo, '.claude', 'worktrees', 'missing');
    const normalize = require('../src/main/shared/normalize-project-path').normalizeProjectPath;
    const policy = mainPolicy({ hiddenProjects: [repo] }, [], normalize);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(policy.archived(repo), true, 'the existing repository itself stays hidden');
    assert.equal(policy.archived(missing), false, 'the normalized missing-worktree parent must not be canonicalized again');
  });

for (const kind of ['descriptors', 'admission']) test(`${kind} policy normalizes each hidden entry once per call`, () => {
  const hiddenProjects = Array.from({ length: 40 }, (_, i) => '/missing/' + i);
  const calls = [];
  const descriptors = Array.from({ length: 20 }, (_, i) => ({ cwd: '/visible/' + i }));
  const policy = mainPolicy({ hiddenProjects }, descriptors, value => { calls.push(value); return value; });
  if (kind === 'descriptors') assert.equal(policy.descriptors().length, 20);
  else assert.equal(policy.archived('/visible/.claude/worktrees/w'), false);
  for (const entry of hiddenProjects) assert.equal(calls.filter(value => value === entry).length, 1,
    kind + ' call must normalize each hidden entry once');
});

for (const kind of ['descriptors', 'admission']) test(`empty hidden lists skip all ${kind} normalization`, () => {
  const descriptors = [{ cwd: '/visible' }];
  let calls = 0;
  const policy = mainPolicy({}, descriptors, value => { calls++; return value; });
  if (kind === 'descriptors') assert.equal(policy.descriptors(), descriptors, 'empty-list shortcut must return the original descriptors');
  else assert.equal(policy.archived('/visible'), false);
  assert.equal(calls, 0, 'empty policies must do no filesystem normalization');
});
