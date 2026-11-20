const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { deriveProjectPath, resolveWorktreePath, storedProjectPathMatchesFolder, resolveSessionRealCwd } = require('../derive-project-path');
const { readSessionFile } = require('../read-session-file');
const { getFolderIndexMtimeMs } = require('../folder-index-state');
const openStore = require('./fixtures/conversation-store.cjs');
const storeOptions = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wt-1137-')));
  const cleanup = { before: () => {} };
  t.after(() => { cleanup.before(); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'repo');
  const cwd = path.join(repo, '.work-files', 'worktrees', '1137');
  const projects = path.join(root, 'projects');
  const folder = encodeProjectPath(cwd);
  const dir = path.join(projects, folder);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, moved = false) => {
    const entry = (where, content) => JSON.stringify({ type: 'user', cwd: where,
      timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content } }) + '\n';
    const body = (moved ? entry(repo, 'x'.repeat(4000)).repeat(80) : '') + entry(cwd, 'hello');
    const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, body);
    return file;
  };
  return { root, repo, cwd, projects, folder, dir, write, cleanup };
}

for (const separator of ['/', '\\']) {
  for (const trailing of ['', separator]) {
    test(`harness worktree grouping accepts separator ${separator} and suffix ${JSON.stringify(trailing)}`, t => {
      const h = fixture(t);
      const cwd = h.repo + separator + ['.work-files', 'worktrees', '1137'].join(separator) + trailing;
      assert.equal(resolveWorktreePath(cwd), h.repo);
    });
  }
}

test('harness grouping requires an existing parent and exactly one worktree name', t => {
  const h = fixture(t);
  for (const cwd of [path.join(h.root, 'missing', '.work-files', 'worktrees', '1137'),
    path.join(h.repo, '.work-files', 'worktrees'), path.join(h.cwd, 'src'),
    path.join(h.repo, 'work-files', 'worktrees', '1137')]) {
    assert.equal(resolveWorktreePath(cwd), cwd);
  }
});

test('stored repository metadata accepts every supported encoded worktree layout and rejects lookalikes', t => {
  const h = fixture(t);
  for (const layout of ['.worktrees', '.claude-worktrees', '.claude/worktrees', '.work-files/worktrees']) {
    assert.equal(storedProjectPathMatchesFolder(h.repo, encodeProjectPath(path.join(h.repo, layout, '1137'))), true, layout);
  }
  for (const suffix of ['/.work-files/worktrees/', '/.work-files/elsewhere/1137', '-other/.work-files/worktrees/1137']) {
    assert.equal(storedProjectPathMatchesFolder(h.repo, encodeProjectPath(h.repo + suffix)), false, suffix);
  }
});

for (const moved of [false, true]) {
  test(`transcript derives repository grouping while preserving recorded cwd (moved=${moved})`, t => {
    const h = fixture(t);
    const file = h.write('source', moved);
    const before = fs.readFileSync(file);
    assert.equal(deriveProjectPath(h.dir, h.folder), h.repo);
    assert.equal(resolveSessionRealCwd(h.projects, 'source', encodeProjectPath(h.repo)), h.cwd);
    assert.deepEqual(fs.readFileSync(file), before);
  });
}

for (const mode of ['refresh', 'targeted', 'reconcile']) {
  test(`existing harness cache migrates unchanged transcripts through ${mode}`, storeOptions, t => {
    const h = fixture(t);
    const previous = process.env.SWITCHBOARD_DATA_DIR;
    process.env.SWITCHBOARD_DATA_DIR = path.join(h.root, 'data');
    const db = openStore();
    h.cleanup.before = () => {
      db.closeDb();
      if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
      else process.env.SWITCHBOARD_DATA_DIR = previous;
    };
    db.setSetting('global', { disabledHarnesses: ['codex'] });
    const files = [h.write('source'), h.write('second')];
    const originals = files.map(file => fs.readFileSync(file));
    db.upsertCachedSessions(files.map(file => readSessionFile(file, h.folder, h.cwd)));
    db.setFolderMeta(h.folder, h.cwd, getFolderIndexMtimeMs(h.dir));
    db.setInitialScanComplete();
    cache.init({ PROJECTS_DIR: h.projects, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
    if (mode === 'reconcile') cache.reconcileCacheFromFilesystem();
    else cache.refreshFolder(h.folder, mode === 'targeted' ? { files: new Set(['source.jsonl']) } : {});
    assert.equal(db.getFolderMeta(h.folder).projectPath, h.repo, 'existing metadata must be re-derived');
    assert.deepEqual(db.getCachedByFolder(h.folder).map(row => row.projectPath), [h.repo, h.repo], 'all unchanged rows must move together');
    const projects = cache.buildProjectsFromCache(false);
    assert.deepEqual(projects.map(project => project.projectPath), [h.repo]);
    assert.equal(projects[0].sessions.length, 2);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), originals[i]));
    assert.equal(resolveSessionRealCwd(h.projects, 'source'), h.cwd);
    cache.reconcileCacheFromFilesystem();
    assert.equal(db.getFolderMeta(h.folder).projectPath, h.repo);
  });
}

test('nested layouts finish migration and open no transcripts on the second refresh or reconcile', storeOptions, t => {
  const h = fixture(t);
  const nested = path.join(h.cwd, '.claude', 'worktrees', 'agent-x');
  fs.mkdirSync(nested, { recursive: true });
  const folder = encodeProjectPath(nested);
  const dir = path.join(h.projects, folder);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'nested.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: nested, timestamp: '2026-11-20T10:00:00Z',
    message: { role: 'user', content: 'nested work' } }) + '\n');
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(h.root, 'data');
  const db = openStore();
  h.cleanup.before = () => {
    db.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
  };
  db.setSetting('global', { disabledHarnesses: ['codex'] });
  db.upsertCachedSessions([readSessionFile(file, folder, nested)]);
  db.setFolderMeta(folder, nested, getFolderIndexMtimeMs(dir));
  db.setInitialScanComplete();
  cache.init({ PROJECTS_DIR: h.projects, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
  cache.refreshFolder(folder);
  let opens = 0;
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', function (name, ...args) {
    if (String(name).endsWith('.jsonl')) opens++;
    return original.call(this, name, ...args);
  });
  cache.refreshFolder(folder);
  cache.reconcileCacheFromFilesystem({ throttle: false });
  assert.equal(opens, 0, 'nested migration must not reopen transcripts on the second refresh');
  assert.equal(db.getFolderMeta(folder).projectPath, h.repo);
});

test('layout matching ignores case only on win32 and reuses uppercase folder metadata', t => {
  const h = fixture(t);
  const cwd = path.join(h.repo, '.WORK-FILES', 'WORKTREES', '1137');
  assert.equal(resolveWorktreePath(cwd), process.platform === 'win32' ? h.repo : cwd);
  assert.equal(storedProjectPathMatchesFolder(h.repo, encodeProjectPath(cwd)), process.platform === 'win32');
});

test('moved transcripts recognize uppercase worktree layouts only on win32', t => {
  const h = fixture(t);
  const cwd = path.join(h.repo, '.WORK-FILES', 'WORKTREES', '1137');
  const folder = encodeProjectPath(cwd);
  const dir = path.join(h.projects, folder);
  fs.mkdirSync(dir, { recursive: true });
  const entry = where => JSON.stringify({ type: 'user', cwd: where, message: { role: 'user', content: 'x'.repeat(4000) } }) + '\n';
  fs.writeFileSync(path.join(dir, 'moved-upper.jsonl'), entry(h.repo).repeat(80) + entry(cwd));
  assert.equal(deriveProjectPath(dir, folder), process.platform === 'win32' ? h.repo : null);
});

for (const deleted of [false, true]) {
  test(`Claude and Codex rows group under one repository and retain launch identity (deleted=${deleted})`, storeOptions, async t => {
    const h = fixture(t);
    const previous = { CODEX_HOME: process.env.CODEX_HOME, SWITCHBOARD_DATA_DIR: process.env.SWITCHBOARD_DATA_DIR };
    process.env.CODEX_HOME = path.join(h.root, 'codex');
    process.env.SWITCHBOARD_DATA_DIR = path.join(h.root, 'data');
    const db = openStore();
    h.cleanup.before = () => {
      db.closeDb();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    };
    h.write('claude-source');
    const codex = require('../harnesses/codex');
    const folder = 'codex/2026/11/20';
    const dir = codex.folderPath(folder);
    fs.mkdirSync(dir, { recursive: true });
    const id = '11111111-1111-4111-8111-111111111111';
    const file = path.join(dir, `rollout-2026-11-20T10-00-00-${id}.jsonl`);
    fs.writeFileSync(file, [
      { type: 'session_meta', timestamp: '2026-11-20T10:00:00Z', payload: { cwd: h.cwd } },
      { type: 'response_item', timestamp: '2026-11-20T10:00:01Z', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'worktree task' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    if (deleted) fs.rmdirSync(h.cwd);
    cache.init({ PROJECTS_DIR: h.projects, activeSessions: new Map(), getMainWindow: () => null, log: console, db });
    cache.setRemoteRoots(new Map());
    cache.refreshFolder(h.folder);
    cache.refreshFolder(folder);
    const projects = cache.buildProjectsFromCache(false);
    assert.deepEqual(projects.map(p => p.projectPath), [h.repo], 'both runtimes must share the repository group');
    assert.equal(projects[0].sessions.length, 2);
    assert.equal(projects[0].missing, false);
    assert.equal(db.getCachedSession(id).projectPath, h.cwd, 'Codex cache keeps the raw launch cwd');
    const session = projects[0].sessions.find(s => s.sessionId === id);
    const context = vm.createContext({ window: { api: {
      getEffectiveSettings: async projectPath => projectPath === h.repo
        ? { codexSandbox: 'read-only', codexApproval: 'on-request' } : {},
    } }, normalizeBrowserSettings: value => value, SETTING_DEFAULTS: require('../public/setting-defaults').SETTING_DEFAULTS });
    const { resolveDefaultSessionOptions } = require('./app-source').loadAppFunctions(context, {
      functions: ['resolveDefaultSessionOptions'], sourcePath: path.join(__dirname, '../public/dialogs.js'),
    });
    const options = await resolveDefaultSessionOptions(session);
    const argv = codex.buildLaunchArgs({ sessionId: id, isNew: false, options });
    assert.ok(argv.includes('--sandbox') && argv.includes('read-only'), 'Codex resume must inherit repository sandbox');
    assert.ok(argv.includes('--ask-for-approval') && argv.includes('on-request'), 'Codex resume must inherit repository approval');
    assert.equal(session.projectPath, h.repo);
    assert.equal(session.cwd, h.cwd);
    assert.equal(db.getCachedSession('claude-source').projectPath, h.repo);
    const signals = codex.readLaunchSignals(file);
    const pending = { projectPath: h.cwd, spawnedAt: Date.parse('2026-11-20T09:59:59Z') };
    assert.equal(codex.matchesLaunch(signals, pending), 'cwd');
    assert.equal(codex.matchesLaunch(signals, { ...pending, projectPath: h.repo }), false);
    assert.equal(cache.refreshFolder(folder), false, 'existing Codex rows need no reindex for grouping');
  });
}

test('nested layouts collapse past a deleted intermediate worktree', t => {
  const h = fixture(t);
  fs.rmdirSync(h.cwd);
  assert.equal(resolveWorktreePath(path.join(h.cwd, '.claude', 'worktrees', 'agent-x')), h.repo);
});

test('stored worktree metadata compares the entire encoded repository without case on Windows', t => {
  const h = fixture(t);
  assert.equal(storedProjectPathMatchesFolder(h.repo, encodeProjectPath(h.cwd).toUpperCase()), process.platform === 'win32');
});

for (const fork of [false, true]) {
  test(`main launch cwd selection preserves harness cwd after grouping (${fork ? 'fork' : 'resume'})`, t => {
    const h = fixture(t);
    h.write('source', true);
    const filename = path.join(__dirname, '..', 'main.js');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf('  let spawnCwd = projectPath;');
    const end = source.indexOf('  const isAttach =', start);
    assert.ok(start >= 0 && end > start, 'launch cwd selection anchors exist');
    const context = vm.createContext({ projectPath: h.repo, triggerPermit: null,
      sessionOptions: fork ? { forkFrom: 'source' } : {}, isNew: fork,
      sessionId: fork ? 'new-fork' : 'source', PROJECTS_DIR: h.projects,
      getCachedSession: () => null, getHarness: require('../harnesses').getHarness,
      encodeProjectPath, resolveSessionRealCwd, fs });
    vm.runInContext(source.slice(start, end), context, { filename });
    assert.equal(vm.runInContext('spawnCwd', context), h.cwd);
  });
}
