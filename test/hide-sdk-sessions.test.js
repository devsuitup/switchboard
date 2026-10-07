// Sessions started through the Agent SDK (entrypoint sdk-cli / sdk-py / sdk-ts)
// are hidden from the project list unless the hideSdkSessions setting is off.
// see .ai/contexts/session-cache.md ("SDK-launched sessions")

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile, readSessionEntrypoint } = require('../read-session-file');
const sessionCache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-sdk-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(dir, sessionId, entries) {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return filePath;
}

function user(text, extra = {}) {
  return { type: 'user', timestamp: '2026-10-07T11:42:12.808Z', message: { role: 'user', content: text }, ...extra };
}

function assistant(extra = {}) {
  return { type: 'assistant', timestamp: '2026-10-07T11:42:20.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...extra };
}

test('readSessionFile records the entrypoint of the first user turn', () => {
  const tmp = mkTmp();
  try {
    const sdk = write(tmp, 'sdk', [
      { type: 'queue-operation', operation: 'enqueue', content: 'Review this change' },
      user('Review this change', { entrypoint: 'sdk-py', promptSource: 'sdk' }),
      assistant({ entrypoint: 'sdk-py' }),
    ]);
    assert.equal(readSessionFile(sdk, 'f', '/p').entrypoint, 'sdk-py');

    const interactive = write(tmp, 'cli', [user('hello', { entrypoint: 'cli' }), assistant({ entrypoint: 'cli' })]);
    assert.equal(readSessionFile(interactive, 'f', '/p').entrypoint, 'cli');
  } finally {
    cleanup(tmp);
  }
});

test('a scheduled run keeps no entrypoint: its first user turn is pre-seeded by Switchboard', () => {
  const tmp = mkTmp();
  try {
    const scheduled = write(tmp, 'sched', [
      user('Scheduled Task: summarize'),
      user('continue', { entrypoint: 'sdk-cli' }),
      assistant({ entrypoint: 'sdk-cli' }),
    ]);
    assert.equal(readSessionFile(scheduled, 'f', '/p').entrypoint, '');
  } finally {
    cleanup(tmp);
  }
});

test('an SDK session later typed into from a terminal counts as interactive', () => {
  const tmp = mkTmp();
  try {
    const resumed = write(tmp, 'resumed', [
      user('Invoque le skill workitem-develop', { entrypoint: 'sdk-ts' }),
      assistant({ entrypoint: 'sdk-ts' }),
      user('and now fix the test', { entrypoint: 'cli' }),
    ]);
    assert.equal(readSessionFile(resumed, 'f', '/p').entrypoint, 'cli');
  } finally {
    cleanup(tmp);
  }
});

test('refreshFolder notices a terminal turn appended to a cached SDK session', () => {
  const projectsDir = mkTmp();
  try {
    const projectPath = projectsDir;
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(projectsDir, folder);
    fs.mkdirSync(folderPath);
    const filePath = write(folderPath, 'resumed', [
      user('Invoque le skill workitem-develop', { entrypoint: 'sdk-ts', cwd: projectPath }),
      assistant({ entrypoint: 'sdk-ts', cwd: projectPath }),
      user('and now fix the test', { entrypoint: 'cli', cwd: projectPath }),
    ]);
    const store = new Map([['resumed', {
      ...row('resumed', folder, projectPath, 'sdk-ts'),
      fileMtime: '2000-01-01T00:00:00.000Z',
    }]]);
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      db: {
        deleteCachedFolder: () => {},
        deleteSearchFolder: () => {},
        getCachedByFolder: (f) => Array.from(store.values()).filter(r => r.folder === f),
        getAllCached: () => Array.from(store.values()),
        upsertCachedSessions: (rows) => { for (const r of rows) store.set(r.sessionId, { ...store.get(r.sessionId), ...r }); },
        touchCachedModified: () => {},
        deleteCachedSession: () => {},
        replaceSessionMetrics: () => {},
        deleteSearchSession: () => {},
        upsertSearchEntries: () => {},
        setFolderMeta: () => {},
        getAllFolderMeta: () => new Map(),
        getAllMeta: () => new Map(),
        getSetting: () => ({}),
        getMeta: () => null,
        setName: () => {},
      },
    });
    sessionCache.setRemoteRoots(new Map());
    sessionCache.refreshFolder(folder, { files: new Set([path.basename(filePath)]) });
    assert.equal(store.get('resumed').entrypoint, 'cli');
  } finally {
    cleanup(projectsDir);
  }
});

function makeFakeDb({ cachedRows, global }) {
  return {
    getAllMeta: () => new Map(),
    getAllCached: () => cachedRows,
    getSetting: (key) => (key === 'global' ? global : {}),
  };
}

function row(sessionId, folder, projectPath, entrypoint) {
  return {
    sessionId, folder, projectPath, summary: sessionId, firstPrompt: sessionId,
    modified: '2026-10-07T10:00:00.000Z', created: '2026-10-07T10:00:00.000Z',
    messageCount: 1, parentSessionId: null, agentId: null, subagentType: null,
    description: null, slug: null, aiTitle: null, entrypoint,
  };
}

function visibleIds(global) {
  const projectsDir = mkTmp();
  try {
    const projectPath = '/srv/runner';
    const folder = encodeProjectPath(projectPath);
    const cachedRows = [
      row('interactive', folder, projectPath, 'cli'),
      row('scheduled', folder, projectPath, null),
      row('sdk-cli-run', folder, projectPath, 'sdk-cli'),
      row('sdk-py-run', folder, projectPath, 'sdk-py'),
      row('sdk-ts-run', folder, projectPath, 'sdk-ts'),
      { ...row('sub:sdk-py-run:a1', folder, projectPath, null), parentSessionId: 'sdk-py-run', agentId: 'a1' },
    ];
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      db: makeFakeDb({ cachedRows, global }),
    });
    sessionCache.setRemoteRoots(new Map());
    return sessionCache.buildProjectsFromCache(true)
      .flatMap(p => p.sessions.map(s => s.sessionId))
      .sort();
  } finally {
    cleanup(projectsDir);
  }
}

test('SDK-launched sessions and their subagents are hidden by default', () => {
  assert.deepEqual(visibleIds({}), ['interactive', 'scheduled']);
});

test('turning hideSdkSessions off shows them again', () => {
  assert.deepEqual(visibleIds({ hideSdkSessions: false }),
    ['interactive', 'scheduled', 'sdk-cli-run', 'sdk-py-run', 'sdk-ts-run', 'sub:sdk-py-run:a1']);
});

function buildWith({ cachedRows, global = {}, activeSessions = new Map(), folders = [] }) {
  const projectsDir = mkTmp();
  try {
    for (const f of folders) fs.mkdirSync(path.join(projectsDir, f));
    const folderMeta = new Map(folders.map(f => [f, { folder: f, projectPath: cachedRows.find(r => r.folder === f).projectPath }]));
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions,
      getMainWindow: () => null,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      db: { ...makeFakeDb({ cachedRows, global }), getAllFolderMeta: () => folderMeta, setFolderMeta: () => {} },
    });
    sessionCache.setRemoteRoots(new Map());
    return sessionCache.buildProjectsFromCache(true);
  } finally {
    cleanup(projectsDir);
  }
}

const ids = (projects) => projects.flatMap(p => p.sessions.map(s => s.sessionId)).sort();

test('an SDK session open in a terminal or in the saved working set stays listed', () => {
  const folder = encodeProjectPath('/srv/runner');
  const cachedRows = [
    row('open-now', folder, '/srv/runner', 'sdk-py'),
    row('saved', folder, '/srv/runner', 'sdk-py'),
    row('closed', folder, '/srv/runner', 'sdk-py'),
    row('exited', folder, '/srv/runner', 'sdk-py'),
  ];
  const activeSessions = new Map([['open-now', { exited: false }], ['exited', { exited: true }]]);
  const projects = buildWith({ cachedRows, activeSessions, global: { openWorkingSet: [{ sessionId: 'saved' }] } });
  assert.deepEqual(ids(projects), ['open-now', 'saved']);
});

test('an SDK session continued from a terminal in a compaction mirror is listed', () => {
  const folder = encodeProjectPath('/srv/runner');
  const cachedRows = [
    row('parent', folder, '/srv/runner', 'sdk-ts'),
    { ...row('mirror', folder, '/srv/runner', 'cli'), mergedIntoSessionId: 'parent' },
  ];
  assert.deepEqual(ids(buildWith({ cachedRows })), ['parent']);
});

test('a project holding only SDK sessions gets no empty header', () => {
  const folder = encodeProjectPath('/srv/only-sdk');
  const cachedRows = [row('sdk', folder, '/srv/only-sdk', 'sdk-cli')];
  assert.deepEqual(buildWith({ cachedRows, folders: [folder] }).map(p => p.projectPath), []);
});

test('readSessionEntrypoint reads the head, and the tail of a large SDK transcript', () => {
  const tmp = mkTmp();
  try {
    assert.equal(readSessionEntrypoint(write(tmp, 'cli', [user('hi', { entrypoint: 'cli' }), assistant()])), 'cli');
    assert.equal(readSessionEntrypoint(write(tmp, 'sched', [user('Scheduled Task: x'), user('go', { entrypoint: 'sdk-cli' })])), '');
    assert.equal(readSessionEntrypoint(write(tmp, 'odd', [user('hi', { entrypoint: 42 })])), '');
    assert.equal(readSessionEntrypoint(write(tmp, 'pure', [user('review', { entrypoint: 'sdk-py' }), assistant({ entrypoint: 'sdk-py' })])), 'sdk-py');
    assert.equal(readSessionEntrypoint(write(tmp, 'queued', [{ type: 'queue-operation', operation: 'enqueue' }])), null);
    const filler = assistant({ entrypoint: 'sdk-py', pad: 'x'.repeat(4096) });
    const big = write(tmp, 'big', [
      user('review', { entrypoint: 'sdk-py' }),
      ...Array(700).fill(filler),
      user('typed later', { entrypoint: 'cli' }),
    ]);
    assert.ok(fs.statSync(big).size > 2 * 1024 * 1024);
    assert.equal(readSessionEntrypoint(big), 'cli');
  } finally {
    cleanup(tmp);
  }
});

test('backfillEntrypoints fills the rows cached before the column existed', async () => {
  const projectsDir = mkTmp();
  try {
    const folder = encodeProjectPath('/srv/runner');
    const folderPath = path.join(projectsDir, folder);
    fs.mkdirSync(folderPath);
    write(folderPath, 'old-sdk', [user('review', { entrypoint: 'sdk-py' }), assistant()]);
    write(folderPath, 'old-cli', [user('hello', { entrypoint: 'cli' }), assistant()]);
    const written = [];
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
      db: {
        getCachedMissingEntrypoint: () => [{ sessionId: 'old-sdk', folder }, { sessionId: 'old-cli', folder }],
        setCachedEntrypoints: (pairs) => written.push(...pairs),
      },
    });
    sessionCache.setRemoteRoots(new Map());
    await sessionCache.backfillEntrypoints();
    assert.deepEqual(written, [
      { sessionId: 'old-sdk', entrypoint: 'sdk-py' },
      { sessionId: 'old-cli', entrypoint: 'cli' },
    ]);
  } finally {
    cleanup(projectsDir);
  }
});

test('adding the entrypoint column keeps the cached sessions', () => {
  const { spawnSync } = require('child_process');
  const electronBin = require('electron');
  const appDir = path.join(__dirname, '..');
  const dir = mkTmp();
  const run = (code) => spawnSync(electronBin, ['-e', code], {
    cwd: appDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
    encoding: 'utf8',
  });
  const loadDb = `require(${JSON.stringify(path.join(appDir, 'db.js'))})`;
  try {
    assert.equal(run(loadDb).status, 0);
    const seed = run(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec('ALTER TABLE session_cache DROP COLUMN entrypoint');
      db.prepare('INSERT INTO session_cache (sessionId, folder, projectPath, summary, modified) VALUES (?, ?, ?, ?, ?)')
        .run('kept', 'f1', '/tmp/p1', 'hello', '2026-10-07T10:00:00.000Z');
    `);
    assert.equal(seed.status, 0, seed.stderr);
    assert.equal(run(loadDb).status, 0);
    const r = run(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
      console.log(JSON.stringify(db.prepare('SELECT sessionId, entrypoint FROM session_cache').all()));
    `);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [{ sessionId: 'kept', entrypoint: null }]);
  } finally {
    cleanup(dir);
  }
});
