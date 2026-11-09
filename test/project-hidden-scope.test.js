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
    hiddenProjectScopes: { '/srv/repo': { alias: null }, 'box::/srv/other': { alias: 'box' } } };
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

test('local worktree cleanup preserves a mark scoped to another host', async t => {
  const global = { hiddenProjects: ['/srv/repo'], hiddenProjectKinds: { '/srv/repo': 'delete' },
    hiddenProjectScopes: { '/srv/repo': { alias: 'box' } } };
  const h = storage(t, global);
  const deleted = [];
  h.db.getAllCached = () => [{ sessionId: 'local', projectPath: '/srv/repo', folder: '-srv-repo' },
    { sessionId: 'remote', projectPath: '/srv/repo', folder: 'box::-srv-repo' }];
  h.db.deleteCachedSession = id => deleted.push(id);
  h.db.deleteSearchSession = () => {};
  await h.writer.cleanupWorktree('/srv/repo');
  assert.deepEqual(h.db.getSetting('global'), global, 'cleanup must not clear a remote scope');
  assert.deepEqual(deleted, ['local'], 'local cleanup must leave the remote cache sentinel unchanged');
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

test('working-set restore allows a same-path remote session outside a local scope', async () => {
  const sourcePath = path.join(__dirname, '..', 'public', 'app.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const item = { sessionId: 'remote', remoteAlias: 'box', projectPath: '/srv/repo' };
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
  assert.equal(opens.length, 1, 'local delete must not suppress a remote working-set restore');
  assert.equal(opens[0][0].remoteAlias, 'box', 'restored remote identity must reach the opener');
});

test('local archive launch policy ignores remote scopes including normalized paths', t => {
  const h = storage(t, {});
  const sourcePath = path.join(__dirname, '..', 'main.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  h.db.setSetting('global', { hiddenProjects: [h.dir], hiddenProjectScopes: { [h.dir]: { alias: 'box' } } });
  const context = vm.createContext({ getSetting: h.db.getSetting,
    normalizeArchivedProjectPath: require('../src/main/shared/normalize-project-path').normalizeProjectPath,
    parseFolderKey: require('../src/main/remote/remote-hosts').parseFolderKey,
    require: createRequire(sourcePath) });
  vm.runInContext(extractFunction(source, 'isProjectSettingsArchived'), context, { filename: sourcePath });
  assert.equal(context.isProjectSettingsArchived(h.dir), false, 'remote scope must not block local admission');
});
