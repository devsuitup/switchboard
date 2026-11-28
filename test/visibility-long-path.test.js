'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyAndPersistArchived, groupedHiddenMatcher } = require('../archived-projects');
const { memoryWriter } = require('./fixtures/writer-memory.cjs');
const { encodeProjectPath } = require('../encode-project-path');
const openStore = require('./fixtures/conversation-store.cjs');
const { longPathForms, longPathLookup } = require('../src/main/shared/long-path');

const SHORT = 'C:/Users/JEAN-B~1/proj';
const LONG = 'C:/Users/Jean-Baptiste/proj';
const fakeLong = map => value => Object.hasOwn(map, value) ? map[value] : value;

function shortSpelling(long) {
  return require('node:child_process').execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${long}") do @echo %~sI`],
    { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
}

function spellings(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'long-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const long = fs.realpathSync.native(dir);
  const short = shortSpelling(long);
  if (short.toLowerCase() === long.toLowerCase()) return null;
  assert.equal(fs.realpathSync.native(short), long, 'fixture must address the same real directory');
  return { dir, long, short };
}

test('GIVEN a long-form hide entry WHEN a project uses the short spelling THEN the injected resolver hides it', () => {
  const hidden = groupedHiddenMatcher([LONG], {}, fakeLong({ [SHORT]: LONG }));
  assert.equal(hidden(null, SHORT), true, 'the short spelling must match its long-form hide entry');
  assert.equal(hidden(null, 'C:/Users/JEAN-B~1/other'), false, 'an unrelated short path must stay visible');
});

test('GIVEN a short-form hide entry WHEN the project uses the long spelling THEN it is hidden too', () => {
  const hidden = groupedHiddenMatcher([SHORT], {}, fakeLong({ [SHORT]: LONG }));
  assert.equal(hidden(null, LONG), true);
});

test('GIVEN a hidden worktree group WHEN a session recorded its cwd in short form THEN the session is hidden', () => {
  const group = LONG + '/.work-files/worktrees/topic';
  const cwd = SHORT + '/.work-files/worktrees/topic';
  const hidden = groupedHiddenMatcher([group], {}, fakeLong({ [cwd]: group }));
  assert.equal(hidden(null, SHORT, { runtime: 'claude', recordedCwd: cwd }), true, 'a short recorded cwd must fall under its long hidden group');
  assert.equal(hidden(null, SHORT, { runtime: 'claude', recordedCwd: SHORT + '/.work-files/worktrees/other' }), false, 'a sibling worktree must stay visible');
});

test('GIVEN the session shapes the project build emits WHEN a Claude worktree folder is grouped under its short-spelled repository THEN its long hidden group hides it', () => {
  const group = LONG + '/.work-files/worktrees/topic';
  const folder = encodeProjectPath(SHORT + '/.work-files/worktrees/topic');
  const sibling = encodeProjectPath(SHORT + '/.work-files/worktrees/other');
  const hidden = groupedHiddenMatcher([group], {}, fakeLong({ [SHORT]: LONG }));
  assert.equal(hidden(null, SHORT, { runtime: 'claude', folder, cwd: SHORT }), true, 'the cache-pass row shape must be hidden');
  assert.equal(hidden(null, SHORT, { runtime: 'claude', sourceFolder: folder, cwd: SHORT, projectPath: SHORT }), true, 'the assembled session shape must be hidden');
  assert.equal(hidden(null, SHORT, { runtime: 'claude', folder: sibling, cwd: SHORT }), false, 'a sibling worktree must stay visible');
  assert.equal(hidden(null, SHORT, { runtime: 'claude', folder: encodeProjectPath('C:/elsewhere/.work-files/worktrees/topic'), cwd: SHORT }), false,
    'a folder that does not extend the session path must not be rewritten');
  assert.equal(groupedHiddenMatcher([group], {}, null)(null, SHORT, { runtime: 'claude', folder, cwd: SHORT }), false, 'without a resolver the plain comparison stays');
});

test('GIVEN a remote project WHEN its path looks short THEN the resolver is never asked and bare entries still match it', () => {
  const asked = [];
  const hidden = groupedHiddenMatcher([LONG, 'box::/srv/JEAN-B~1'], {}, value => { asked.push(value); return value; });
  assert.equal(hidden('box', '/srv/JEAN-B~1'), true);
  assert.equal(hidden('other', LONG), true, 'a bare entry must keep matching every host');
  assert.deepEqual(asked.filter(value => value.startsWith('/srv')), [], 'a remote path must never reach the local resolver');
});

test('GIVEN no resolver WHEN the spellings differ THEN they do not match', () => {
  const hidden = groupedHiddenMatcher([LONG], {}, null);
  assert.equal(hidden(null, SHORT), false);
});

test('Windows: a deleted project stays hidden when its sessions use the real 8.3 short spelling', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const entry = s.long.replaceAll('\\', '/').toLowerCase();
  const global = { hiddenProjects: [entry], hiddenProjectKinds: { [entry]: 'delete' } };
  const projects = [{ remoteAlias: null, projectPath: s.short, sessions: [{ runtime: 'claude', recordedCwd: s.short }] }];
  const longPath = longPathLookup(await longPathForms([entry, s.short]));
  const visible = applyAndPersistArchived(projects, true, { getSetting: key => key === 'global' ? global : {}, setSetting() {}, longPath });
  assert.deepEqual(visible, [], 'the short spelling must match the long-form deletion entry');
});

function settingsWriter(dir, global) {
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
  return { db, writer: memoryWriter(db) };
}

test('Windows: Add project under the short spelling clears its long-form hide entry', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const entry = s.long.replaceAll('\\', '/').toLowerCase();
  const sibling = path.join(s.dir, 'missing~1');
  const h = settingsWriter(s.dir, { hiddenProjects: [entry, sibling], hiddenProjectKinds: { [entry]: 'delete', [sibling]: 'archive' } });
  await h.writer.revealAddedProject(s.short);
  assert.deepEqual(h.db.getSetting('global').hiddenProjects, [sibling], 'the long-form entry must be cleared and a missing path kept');
});

test('Windows: unhiding a long-form entry from a project spelled short removes it', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const h = settingsWriter(s.dir, { hiddenProjects: [s.long], hiddenProjectKinds: { [s.long]: 'archive' } });
  await h.writer.unhideProject(s.long, null, s.short);
  assert.deepEqual(h.db.getSetting('global').hiddenProjects, [], 'the entry must be removed when the project is spelled short');
});

function worktreeSpellings(t) {
  const s = spellings(t);
  if (!s) return null;
  const tail = path.join('repo', '.work-files', 'worktrees', 'topic');
  fs.mkdirSync(path.join(s.long, tail), { recursive: true });
  return { ...s, shortRepo: path.join(s.short, 'repo'), shortCwd: path.join(s.short, tail), longCwd: path.join(s.long, tail) };
}

function hiddenMatchingSyncRealpath(t) {
  const original = fs.realpathSync.native;
  const calls = [];
  fs.realpathSync.native = (...args) => {
    if (/long-path\.js|worktree-nesting\.js|archived-projects\.js/.test(new Error().stack)) calls.push(args[0]);
    return original(...args);
  };
  t.after(() => { fs.realpathSync.native = original; });
  return calls;
}

test('Windows: the project build hides a Claude worktree session whose row carries the real short cwd', {
  skip: process.platform !== 'win32' ? '8.3 short names exist only on Windows' : !openStore.supported && 'real SQLite requires Node 22 or matching native ABI',
}, async t => {
  const s = worktreeSpellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'long-path-data-'));
  process.env.SWITCHBOARD_DATA_DIR = data;
  const db = openStore();
  t.after(() => { db.closeDb(); process.env.SWITCHBOARD_DATA_DIR = previous; fs.rmSync(data, { recursive: true, force: true }); });
  const cache = require('../session-cache');
  const entry = s.longCwd.replaceAll('\\', '/').toLowerCase();
  db.setSetting('global', { hiddenProjects: [entry], hiddenProjectKinds: { [entry]: 'delete' } });
  db.upsertCachedSessions([
    { sessionId: 'own', runtime: 'claude', folder: encodeProjectPath(s.shortRepo), projectPath: s.shortRepo, modified: '2026-11-20T10:00:00Z' },
    { sessionId: 'wt', runtime: 'claude', folder: encodeProjectPath(s.shortCwd), projectPath: s.shortRepo, modified: '2026-11-20T10:00:00Z' },
  ]);
  cache.init({ PROJECTS_DIR: path.join(s.long, 'projects'), db, activeSessions: new Map(), getMainWindow: () => null, log: console });
  const ids = projects => projects.flatMap(p => p.sessions.map(session => session.sessionId));
  const syncCalls = hiddenMatchingSyncRealpath(t);
  assert.deepEqual(ids(cache.buildProjectsFromCache(true)), ['own', 'wt'], 'a build without a resolver keeps the plain comparison');
  assert.deepEqual(syncCalls, [], 'a build without a resolver must not resolve paths for hidden matching');
  const { createLongPathResolver } = require('../src/main/shared/long-path');
  assert.deepEqual(ids(cache.buildProjectsFromCache(true, { longPath: createLongPathResolver() })), ['own'],
    'the short worktree session must fall under its long-form hide entry');
});

test('projects worker hands the project build a long-path resolver', () => {
  const source = fs.readFileSync(path.join(__dirname, '../workers/projects-query.js'), 'utf8');
  assert.match(source, /buildProjectsFromCache\(false, \{ longPath \}\)/);
  assert.match(source, /buildProjectsFromCache\(true, \{ longPath \}\)/);
  assert.match(source, /const longPath = createLongPathResolver\(\)/);
});

test('Windows: archive assembly on main hides a short-spelled project without synchronous realpath', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const entry = s.long.replaceAll('\\', '/').toLowerCase();
  const h = settingsWriter(s.dir, { hiddenProjects: [entry], hiddenProjectKinds: { [entry]: 'delete' } });
  const syncCalls = hiddenMatchingSyncRealpath(t);
  const kept = await h.writer.applyAndPersistArchived([{ remoteAlias: null, projectPath: s.short,
    sessions: [{ sessionId: 'a', runtime: 'claude', cwd: s.short, sourceFolder: encodeProjectPath(s.short) }] }], true);
  assert.deepEqual(kept, [], 'the short spelling must match the long-form deletion entry');
  assert.deepEqual(syncCalls, [], 'hidden matching on main must never resolve synchronously');
});

test('Windows: worktree cleanup after removal clears a short-spelled hide entry through its surviving ancestor', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = worktreeSpellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const h = settingsWriter(s.dir, { hiddenProjects: [s.shortCwd], hiddenProjectKinds: { [s.shortCwd]: 'archive' } });
  fs.rmSync(s.longCwd, { recursive: true });
  await h.writer.cleanupWorktree(s.longCwd);
  assert.deepEqual(h.db.getSetting('global').hiddenProjects, [], 'the removed worktree must not stay hidden under its short spelling');
});

test('Windows: delete-worktree resolves the long form before removal and hands it to cleanup', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const repo = path.join(s.short, 'repo').replaceAll('\\', '/');
  const target = repo + '/.claude/worktrees/task';
  fs.mkdirSync(target, { recursive: true });
  const cleanups = [];
  const handlers = require('./project-action-harness').loadProjectActionHandlers({
    getKnownProjectPaths: () => [repo], localGitEnv: require('../src/main/changes/git-changes-runner').localGitEnv,
    os: { homedir: () => s.short }, cliSessionState: { getSidebarDescriptors: () => [] },
    execFile(_cmd, args, _options, cb) {
      if (args.includes('rev-parse')) return cb(null, target + '/.git\n', '');
      if (args.includes('status')) return cb(null, '', '');
      if (args.includes('list')) return cb(null, `worktree ${repo}\nHEAD def\n\nworktree ${target}\nHEAD abc\nbranch refs/heads/topic\n\n`, '');
      if (args.includes('ls-files')) return cb(null, '', '');
      if (args.includes('remove')) fs.rmSync(target, { recursive: true });
      cb(null, '', '');
    },
    writer: { cleanupWorktree: async (...args) => { cleanups.push(args); return 0; } },
    log: { info() {} }, notifyRendererProjectsChanged() {},
  });
  const shown = await handlers.get('worktree-status')(null, target);
  assert.equal((await handlers.get('delete-worktree')(null, target, shown)).ok, true);
  assert.equal(fs.existsSync(target), false, 'the fixture must have removed the directory');
  assert.equal(cleanups.length, 1);
  const forms = cleanups[0][2];
  const key = target.toLowerCase();
  assert.equal(forms?.[key], path.join(s.long, 'repo', '.claude', 'worktrees', 'task'), 'cleanup must receive the long form resolved before removal');
});

test('Windows: worktree cleanup uses the long form carried from before removal when the short segment itself is gone', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const longTree = path.join(s.long, 'repo', '.claude', 'worktrees', 'a-long-worktree-name');
  fs.mkdirSync(longTree, { recursive: true });
  const shortTree = shortSpelling(longTree);
  if (path.basename(shortTree).toLowerCase() === 'a-long-worktree-name') { t.skip('the worktree directory has no 8.3 alias'); return; }
  const entry = longTree.split(path.sep).join('/').toLowerCase();
  const h = settingsWriter(s.dir, { hiddenProjects: [entry], hiddenProjectKinds: { [entry]: 'archive' } });
  const forms = await longPathForms([shortTree]);
  fs.rmSync(longTree, { recursive: true });
  await h.writer.cleanupWorktree(shortTree, { warn() {} }, forms);
  assert.deepEqual(h.db.getSetting('global').hiddenProjects, [], 'the carried long form must match the long hide entry');
});

function fakeAsyncRealpath(t, resolve) {
  const original = fs.promises.realpath;
  fs.promises.realpath = async value => {
    const long = await resolve(String(value).split(path.sep).join('/'));
    if (long === null) throw Object.assign(new Error('ENOENT: ' + value), { code: 'ENOENT' });
    return long;
  };
  t.after(() => { fs.promises.realpath = original; });
}

test('Windows: archive assembly resolves a short hide entry added while its long forms were being computed', {
  skip: process.platform !== 'win32' && 'long forms are computed only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const project = 'C:/Fake/JEAN-B~1/proj', entry = 'C:/Fake/JEANBA~1/proj', long = 'C:/Fake/Jean-Baptiste/proj';
  const h = settingsWriter(s.dir, { hiddenProjects: [] });
  fakeAsyncRealpath(t, async value => {
    if (value === project) {
      h.db.setSetting('global', { hiddenProjects: [entry], hiddenProjectKinds: { [entry]: 'archive' } });
      return long;
    }
    return value === entry ? long : null;
  });
  const kept = await h.writer.applyAndPersistArchived([{ remoteAlias: null, projectPath: project, sessions: [] }], true);
  assert.deepEqual(kept, [], 'the first pass must resolve the hide entry added during precompute');
});

test('Windows: archive assembly hides a project whose short alias appeared while another resolution was pending', {
  skip: process.platform !== 'win32' && 'long forms are computed only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const alias = 'C:/Fake/JEAN-B~1/a', other = 'C:/Fake/JEAN-B~1/b';
  const h = settingsWriter(s.dir, { hiddenProjects: ['C:/Fake/Jean-Baptiste/a'] });
  let aliasExists = false;
  fakeAsyncRealpath(t, async value => {
    if (value === alias) return aliasExists ? 'C:/Fake/Jean-Baptiste/a' : null;
    if (value === other) {
      await new Promise(resolve => setImmediate(resolve));
      aliasExists = true;
      return 'C:/Fake/Jean-Baptiste/b';
    }
    return null;
  });
  const kept = await h.writer.applyAndPersistArchived([
    { remoteAlias: null, projectPath: alias, sessions: [] }, { remoteAlias: null, projectPath: other, sessions: [] }], true);
  assert.deepEqual(kept.map(p => p.projectPath), [other], 'an alias created during precompute must be hidden in the same pass');
});

test('Windows: delete-worktree by long path clears a hide entry stored under the short leaf', {
  skip: process.platform !== 'win32' && '8.3 short names exist only on Windows',
}, async t => {
  const s = spellings(t);
  if (!s) { t.skip('8.3 aliases are disabled on this Windows volume'); return; }
  const repo = s.long.split(path.sep).join('/') + '/repo';
  const target = repo + '/.claude/worktrees/a-long-worktree-name';
  fs.mkdirSync(target, { recursive: true });
  const shortTarget = shortSpelling(target);
  if (path.basename(shortTarget).toLowerCase() === 'a-long-worktree-name') { t.skip('the worktree directory has no 8.3 alias'); return; }
  const h = settingsWriter(s.dir, { hiddenProjects: [shortTarget], hiddenProjectKinds: { [shortTarget]: 'archive' } });
  const handlers = require('./project-action-harness').loadProjectActionHandlers({
    getKnownProjectPaths: () => [repo], localGitEnv: require('../src/main/changes/git-changes-runner').localGitEnv,
    os: { homedir: () => s.long }, cliSessionState: { getSidebarDescriptors: () => [] },
    getSetting: key => h.db.getSetting(key),
    execFile(_cmd, args, _options, cb) {
      if (args.includes('rev-parse')) return cb(null, target + '/.git\n', '');
      if (args.includes('status')) return cb(null, '', '');
      if (args.includes('list')) return cb(null, `worktree ${repo}\nHEAD def\n\nworktree ${target}\nHEAD abc\nbranch refs/heads/topic\n\n`, '');
      if (args.includes('ls-files')) return cb(null, '', '');
      if (args.includes('remove')) fs.rmSync(target, { recursive: true });
      cb(null, '', '');
    },
    writer: h.writer, log: { info() {}, warn() {} }, notifyRendererProjectsChanged() {},
  });
  const shown = await handlers.get('worktree-status')(null, target);
  assert.equal((await handlers.get('delete-worktree')(null, target, shown)).ok, true);
  assert.equal(fs.existsSync(target), false, 'the fixture must have removed the directory');
  assert.deepEqual(h.db.getSetting('global').hiddenProjects, [], 'cleanup must clear a stored short leaf when deletion was requested by long path');
});
