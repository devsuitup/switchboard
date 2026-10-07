// see .ai/contexts/session-cache.md ("A transcript moved into a worktree folder", "A running session keeps its row")
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const sessionCache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');
const { deriveProjectPath, resolveSessionRealCwd } = require('../derive-project-path');
const { listSessionTouchedFiles } = require('../session-touched-files');

const WINDOW = 256 * 1024;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-wmt-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const userLine = (cwd, content = 'hi') => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content } }) + '\n';

function writeMovedTranscript(filePath, repo, worktree, { tailCwd = worktree } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const pad = 'x'.repeat(4000);
  let body = '';
  for (let i = 0; i < 80; i++) body += userLine(repo, 'before the worktree ' + pad);
  body += JSON.stringify({ type: 'worktree-state', worktreeSession: { worktreePath: worktree } }) + '\n';
  if (tailCwd) for (let i = 0; i < 3; i++) body += userLine(tailCwd, 'inside the worktree');
  fs.writeFileSync(filePath, body, 'utf8');
  assert.ok(fs.statSync(filePath).size > WINDOW + 50 * 1024, 'fixture must exceed the head scan window');
}

function makeLayout({ longRepo = false } = {}) {
  const tmp = mkTmp();
  const projectsDir = path.join(tmp, 'projects');
  const repo = longRepo ? path.join(tmp, 'r'.repeat(120), 'repository-with-a-long-name-' + 'y'.repeat(40)) : path.join(tmp, 'repo');
  const worktree = path.join(repo, '.claude', 'worktrees', 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  return { tmp, projectsDir, repo, worktree, rootFolder: encodeProjectPath(repo), wtFolder: encodeProjectPath(worktree) };
}

test('deriveProjectPath resolves a worktree folder whose only transcript was moved there from the root', () => {
  const l = makeLayout();
  try {
    const folderPath = path.join(l.projectsDir, l.wtFolder);
    writeMovedTranscript(path.join(folderPath, 'moved.jsonl'), l.repo, l.worktree);
    const rejected = [];
    assert.equal(deriveProjectPath(folderPath, l.wtFolder, { onRejected: (c) => rejected.push(c) }), l.repo);
    assert.deepEqual(rejected, []);
  } finally {
    cleanup(l.tmp);
  }
});

test('deriveProjectPath resolves a moved transcript when the folder name is hashed for a long path', () => {
  const l = makeLayout({ longRepo: true });
  try {
    assert.ok(l.wtFolder.length > 200, 'precondition: the worktree folder name is hashed');
    const folderPath = path.join(l.projectsDir, l.wtFolder);
    writeMovedTranscript(path.join(folderPath, 'moved.jsonl'), l.repo, l.worktree);
    assert.equal(deriveProjectPath(folderPath, l.wtFolder), l.repo);
    assert.equal(resolveSessionRealCwd(l.projectsDir, 'moved'), l.worktree);
  } finally {
    cleanup(l.tmp);
  }
});

test('deriveProjectPath still rejects a folder whose transcript never carries a cwd that encodes to it', () => {
  const l = makeLayout();
  try {
    const folderPath = path.join(l.projectsDir, l.wtFolder);
    writeMovedTranscript(path.join(folderPath, 'forged.jsonl'), l.repo, l.worktree, { tailCwd: path.join(l.repo, 'elsewhere') });
    const rejected = [];
    assert.equal(deriveProjectPath(folderPath, l.wtFolder, { onRejected: (c) => rejected.push(c) }), null);
    assert.deepEqual(rejected, [l.repo]);
  } finally {
    cleanup(l.tmp);
  }
});

test('resolveSessionRealCwd finds the worktree cwd of a moved transcript', () => {
  const l = makeLayout();
  try {
    writeMovedTranscript(path.join(l.projectsDir, l.wtFolder, 'moved.jsonl'), l.repo, l.worktree);
    assert.equal(resolveSessionRealCwd(l.projectsDir, 'moved'), l.worktree);
  } finally {
    cleanup(l.tmp);
  }
});

test('the tail scan keeps a complete line that starts exactly at the tail window', () => {
  const l = makeLayout();
  try {
    const filePath = path.join(l.projectsDir, l.wtFolder, 'edge.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const last = userLine(l.worktree);
    const fillerLine = (n) => JSON.stringify({ type: 'assistant', message: 'x'.repeat(n) }) + '\n';
    const overhead = fillerLine(0).length;
    fs.writeFileSync(filePath, userLine(l.repo) + fillerLine(WINDOW - overhead) + last + fillerLine(WINDOW - last.length - overhead));
    const size = fs.statSync(filePath).size;
    assert.equal(fs.readFileSync(filePath).indexOf(last), size - WINDOW, 'precondition: the worktree line starts the tail window');
    assert.equal(resolveSessionRealCwd(l.projectsDir, 'edge'), l.worktree);
  } finally {
    cleanup(l.tmp);
  }
});

function countReads(fn) {
  const original = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => {
    const n = original.apply(fs, args);
    bytes += n;
    return n;
  };
  try {
    return { result: fn(), bytes };
  } finally {
    fs.readSync = original;
  }
}

test('deriveProjectPath bounds the tail reads of one derivation and does not re-read unchanged unresolved transcripts', () => {
  const l = makeLayout();
  try {
    const folderPath = path.join(l.projectsDir, l.wtFolder);
    for (let i = 0; i < 10; i++) {
      writeMovedTranscript(path.join(folderPath, `unresolved-${i}.jsonl`), l.repo, l.worktree, { tailCwd: null });
    }
    const first = countReads(() => deriveProjectPath(folderPath, l.wtFolder));
    assert.equal(first.result, null);
    assert.ok(first.bytes >= 10 * WINDOW, `the count must see the head reads; got ${first.bytes}`);
    assert.ok(first.bytes <= 10 * WINDOW + 4 * (WINDOW + 1), `first derivation read ${first.bytes} bytes`);

    const unchangedPasses = [];
    for (let pass = 0; pass < 3; pass++) unchangedPasses.push(countReads(() => deriveProjectPath(folderPath, l.wtFolder)).bytes);
    const settled = countReads(() => deriveProjectPath(folderPath, l.wtFolder));
    assert.equal(settled.bytes, 0, `passes read ${JSON.stringify(unchangedPasses)} then ${settled.bytes} bytes`);

    fs.appendFileSync(path.join(folderPath, 'unresolved-3.jsonl'), userLine(l.worktree));
    const afterAppend = countReads(() => deriveProjectPath(folderPath, l.wtFolder));
    assert.equal(afterAppend.result, l.repo);
    assert.ok(afterAppend.bytes <= 2 * WINDOW + 4096, `re-read ${afterAppend.bytes} bytes for one changed file`);
  } finally {
    cleanup(l.tmp);
  }
});

test('deriveProjectPath resolves a transcript whose session started in a subdirectory of the repository', () => {
  const l = makeLayout();
  try {
    const sub = path.join(l.repo, 'packages', 'api');
    fs.mkdirSync(sub, { recursive: true });
    const folderPath = path.join(l.projectsDir, l.wtFolder);
    writeMovedTranscript(path.join(folderPath, 'moved.jsonl'), sub, l.worktree);
    assert.equal(deriveProjectPath(folderPath, l.wtFolder), l.repo);
  } finally {
    cleanup(l.tmp);
  }
});

test('a folder left unresolved by the tail budget is not marked as indexed, so reconcile derives it again', () => {
  const l = makeLayout();
  try {
    const folderPath = path.join(l.projectsDir, l.wtFolder);
    for (let i = 0; i < 10; i++) {
      writeMovedTranscript(path.join(folderPath, `unresolved-${i}.jsonl`), l.repo, l.worktree, { tailCwd: null });
    }
    const metas = [];
    const { db } = makeFakeDb({});
    db.setFolderMeta = (folder, projectPath, indexMtimeMs) => metas.push({ projectPath, indexMtimeMs });
    sessionCache.init({ PROJECTS_DIR: l.projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: null, db });
    sessionCache.refreshFolder(l.wtFolder);
    assert.deepEqual(metas[0], { projectPath: null, indexMtimeMs: 0 });
    for (let pass = 0; pass < 5 && metas[metas.length - 1].indexMtimeMs === 0; pass++) sessionCache.refreshFolder(l.wtFolder);
    const last = metas[metas.length - 1];
    assert.equal(last.projectPath, null);
    assert.ok(last.indexMtimeMs > 0, `a completely scanned folder is marked as indexed; got ${JSON.stringify(metas)}`);
  } finally {
    cleanup(l.tmp);
  }
});

test('a moved transcript past the tail budget still resolves on a later derivation', () => {
  const l = makeLayout();
  try {
    const folderPath = path.join(l.projectsDir, l.wtFolder);
    for (let i = 0; i < 9; i++) {
      writeMovedTranscript(path.join(folderPath, `a-unresolved-${i}.jsonl`), l.repo, l.worktree, { tailCwd: null });
    }
    writeMovedTranscript(path.join(folderPath, 'z-moved.jsonl'), l.repo, l.worktree);
    let result = null;
    for (let pass = 0; pass < 5 && result === null; pass++) result = deriveProjectPath(folderPath, l.wtFolder);
    assert.equal(result, l.repo);
  } finally {
    cleanup(l.tmp);
  }
});

test('Touched leaves a relative path written before the move unresolved instead of resolving it in the worktree', async () => {
  const l = makeLayout();
  try {
    fs.writeFileSync(path.join(l.repo, 'rel.txt'), 'root');
    fs.writeFileSync(path.join(l.worktree, 'rel.txt'), 'worktree');
    const filePath = path.join(l.projectsDir, l.wtFolder, 'S1.jsonl');
    writeMovedTranscript(filePath, l.repo, l.worktree);
    const body = fs.readFileSync(filePath, 'utf8');
    const write = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: 'rel.txt', content: 'x' } },
    ] } }) + '\n';
    fs.writeFileSync(filePath, userLine(l.repo) + write + body);
    const r = await listSessionTouchedFiles('S1', {
      projectsDir: l.projectsDir,
      getCachedFolder: () => l.wtFolder,
      isRemoteFolder: () => false,
      isSensitive: async () => false,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.map((f) => f.path), []);
    assert.deepEqual(r.unresolved.map((u) => u.raw), ['rel.txt']);
  } finally {
    cleanup(l.tmp);
  }
});

function makeFakeDb(rowsByFolder) {
  const deleted = [];
  const deletedFolders = [];
  const db = {
    deleteCachedFolder: (folder) => deletedFolders.push(folder),
    getCachedByFolder: (folder) => rowsByFolder[folder] || [],
    upsertCachedSessions: () => {},
    touchCachedModified: () => {},
    deleteCachedSession: (id) => deleted.push(id),
    replaceSessionMetrics: () => {},
    deleteSearchFolder: (folder) => deletedFolders.push('search:' + folder),
    deleteSearchSession: () => {},
    upsertSearchEntries: () => {},
    setFolderMeta: () => {},
    getFolderMeta: () => null,
    getAllFolderMeta: () => new Map(),
    getAllMeta: () => new Map(),
    getAllCached: () => [],
    getSetting: () => ({}),
    getMeta: () => null,
    setName: () => {},
  };
  return { db, deleted, deletedFolders };
}

function rowFor(sessionId, folder, folderPath, projectPath) {
  return {
    sessionId, folder, projectPath, modified: '2026-01-01T00:00:00.000Z', fileMtime: '2026-01-01T00:00:00.000Z',
    filePath: path.join(folderPath, sessionId + '.jsonl'), parentSessionId: null, agentId: null,
  };
}

function setupRootFolder(l, activeSessions) {
  const folderPath = path.join(l.projectsDir, l.rootFolder);
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, 'other.jsonl'), userLine(l.repo));
  const rows = {
    [l.rootFolder]: [
      rowFor('live', l.rootFolder, folderPath, l.repo),
      rowFor('gone', l.rootFolder, folderPath, l.repo),
    ],
  };
  const fake = makeFakeDb(rows);
  sessionCache.init({ PROJECTS_DIR: l.projectsDir, activeSessions, getMainWindow: () => null, log: null, db: fake.db });
  return { ...fake, folderPath };
}

const running = () => new Map([['live', { exited: false, isPlainTerminal: false }]]);

test('refreshFolder keeps the row of a running session whose transcript left the folder (full walk)', () => {
  const l = makeLayout();
  try {
    const { deleted } = setupRootFolder(l, running());
    sessionCache.refreshFolder(l.rootFolder);
    assert.deepEqual(deleted, ['gone']);
  } finally {
    cleanup(l.tmp);
  }
});

test('refreshFolder keeps the row of a running session whose transcript left the folder (targeted)', () => {
  const l = makeLayout();
  try {
    const { deleted } = setupRootFolder(l, running());
    sessionCache.refreshFolder(l.rootFolder, { files: new Set(['live.jsonl', 'gone.jsonl']) });
    assert.deepEqual(deleted, ['gone']);
  } finally {
    cleanup(l.tmp);
  }
});

test('refreshFolder keeps the row of a running session when the transcript folder itself is removed', () => {
  const l = makeLayout();
  try {
    const { deleted, deletedFolders, folderPath } = setupRootFolder(l, running());
    fs.rmSync(folderPath, { recursive: true, force: true });
    sessionCache.refreshFolder(l.rootFolder);
    assert.deepEqual(deletedFolders, []);
    assert.deepEqual(deleted, ['gone']);
  } finally {
    cleanup(l.tmp);
  }
});

test('dropFolderRows, the watcher\'s path for a vanished folder, keeps the row of a running session', () => {
  const l = makeLayout();
  try {
    const { deleted, deletedFolders } = setupRootFolder(l, running());
    sessionCache.dropFolderRows(l.rootFolder);
    assert.deepEqual(deletedFolders, []);
    assert.deepEqual(deleted, ['gone']);
  } finally {
    cleanup(l.tmp);
  }
});

test('the watcher drops a vanished folder through dropFolderRows', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const flush = main.slice(main.indexOf('function flushChanges()'), main.indexOf('function recordChange('));
  assert.match(flush, /sessionCache\.dropFolderRows\(folder\)/);
  assert.doesNotMatch(flush, /deleteCachedFolder\(/);
});

test('refreshFolder drops the row once the session has exited', () => {
  const l = makeLayout();
  try {
    const { deleted } = setupRootFolder(l, new Map([['live', { exited: true, isPlainTerminal: false }]]));
    sessionCache.refreshFolder(l.rootFolder);
    assert.deepEqual(deleted.sort(), ['gone', 'live']);
  } finally {
    cleanup(l.tmp);
  }
});

test('releaseLiveSession re-checks the folder that kept the row, which then drops it', () => {
  const l = makeLayout();
  try {
    const activeSessions = running();
    const { deleted } = setupRootFolder(l, activeSessions);
    sessionCache.refreshFolder(l.rootFolder);
    assert.deepEqual(deleted, ['gone']);
    activeSessions.delete('live');
    assert.equal(sessionCache.releaseLiveSession('live'), true);
    assert.ok(deleted.includes('live'), `live must be dropped after exit; got ${JSON.stringify(deleted)}`);
  } finally {
    cleanup(l.tmp);
  }
});

test('refreshFolder keeps a running session\'s row when its folder no longer resolves to a project', () => {
  const l = makeLayout();
  try {
    const folderPath = path.join(l.projectsDir, l.wtFolder);
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, 'stray.jsonl'), userLine(path.join(l.repo, 'elsewhere')));
    const rows = {
      [l.wtFolder]: [
        rowFor('live', l.wtFolder, folderPath, l.repo),
        rowFor('stray', l.wtFolder, folderPath, l.repo),
      ],
    };
    const { db, deleted, deletedFolders } = makeFakeDb(rows);
    sessionCache.init({ PROJECTS_DIR: l.projectsDir, activeSessions: running(), getMainWindow: () => null, log: null, db });
    sessionCache.refreshFolder(l.wtFolder);
    assert.deepEqual(deletedFolders, []);
    assert.deepEqual(deleted, ['stray']);
  } finally {
    cleanup(l.tmp);
  }
});

function runExitHandler({ releaseLiveSession }) {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = main.indexOf('  ptyProcess.onExit(');
  const end = main.indexOf('\n  });', start) + '\n  });'.length;
  assert.ok(start > 0 && end > start, 'the PTY exit handler is found in main.js');
  const calls = { released: [], notified: 0, warned: [], deletedBeforeRelease: null };
  const activeSessions = new Map([['real', {}], ['orig', {}]]);
  let handler = null;
  const ctx = vm.createContext({
    ptyProcess: { onExit: (cb) => { handler = cb; } },
    session: { stopRequested: false, realSessionId: 'real', generation: 1 },
    sessionId: 'orig',
    activeSessions,
    ptyExitSignalName: () => null,
    shutdownMcpServer: () => {},
    TRACE: { on: false },
    trace: () => {},
    mainWindow: null,
    activityReporter: { sessionEnded: () => {} },
    sessionCache: {
      releaseLiveSession: (id) => {
        if (calls.deletedBeforeRelease === null) calls.deletedBeforeRelease = activeSessions.size === 0;
        calls.released.push(id);
        return releaseLiveSession(id);
      },
    },
    notifyRendererProjectsChanged: () => { calls.notified++; },
    log: { warn: (m) => calls.warned.push(m) },
  });
  vm.runInContext(main.slice(start, end), ctx);
  handler({ exitCode: 0, signal: 0 });
  return calls;
}

test('the PTY exit handler releases both ids after dropping the session, and refreshes the sidebar when a row was released', () => {
  const calls = runExitHandler({ releaseLiveSession: (id) => id === 'real' });
  assert.equal(calls.deletedBeforeRelease, true);
  assert.deepEqual(calls.released, ['real', 'orig']);
  assert.equal(calls.notified, 1);
});

test('the PTY exit handler survives a release that throws on a closed database', () => {
  const calls = runExitHandler({ releaseLiveSession: () => { throw new Error('The database connection is not open'); } });
  assert.equal(calls.notified, 0);
  assert.equal(calls.warned.length, 1);
  assert.match(calls.warned[0], /database connection is not open/);
});
