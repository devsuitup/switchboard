'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readSessionDisplayHeader } = require('../read-session-file');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rename-680-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const fixture = `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const db = require('./test/fixtures/writer-store.cjs');
  const cache = require('./session-cache');
  const { createWriterCommands } = require('./session-index-commands');
  const commands = createWriterCommands(db);
  const root = process.env.SWITCHBOARD_DATA_DIR;
  const projectsDir = path.join(root, 'projects');
  const folder = require('./encode-project-path').encodeProjectPath(root);
  const id = '11111111-1111-4111-8111-111111111111';
  const file = path.join(projectsDir, folder, id + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const title = name => JSON.stringify({ type: 'custom-title', customTitle: name }) + '\\n';
  fs.writeFileSync(file, title('X (3)') + JSON.stringify({ type: 'user', cwd: root,
    message: { content: 'fixture prompt' } }) + '\\n' +
    (JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(2048) } }) + '\\n').repeat(600) + title('X'));
  let tick = 0;
  const refresh = () => {
    fs.utimesSync(file, new Date(1900000000000 + ++tick * 1000), new Date(1900000000000 + tick * 1000));
    cache.refreshFolder(folder);
  };
  const init = (extra = {}) => cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(),
    getMainWindow: () => null, log: { warn() {}, info() {}, error() {}, debug() {} }, db, ...extra });
  const displayed = () => cache.buildProjectsFromCache(false).flatMap(p => p.sessions).find(s => s.sessionId === id).name;
  init();
`;

function run(root, code) {
  const result = spawnSync(require('electron'), ['-e', code], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('bounded header prefers the last tail title and falls back to the last head title', t => {
  const file = path.join(temp(t), 'session.jsonl');
  const title = customTitle => JSON.stringify({ type: 'custom-title', customTitle }) + '\n';
  const prompt = JSON.stringify({ type: 'user', message: { content: 'prompt' } }) + '\n';
  fs.writeFileSync(file, title('X (3)') + prompt + title('head') + ' '.repeat(600000) + '\n' + title('X') + '{"type":');
  const original = fs.readSync;
  let bytes = 0;
  fs.readSync = function(...args) { const n = original.apply(this, args); bytes += n; return n; };
  try {
    assert.equal(readSessionDisplayHeader(file).customTitle, 'X');
    assert.ok(bytes <= 512 * 1024, `bounded reads: ${bytes}`);
  } finally { fs.readSync = original; }
  fs.writeFileSync(file, title('X (3)') + prompt + title('head') + ' '.repeat(600000) + '\n');
  assert.equal(readSessionDisplayHeader(file).customTitle, 'head');
});

test('refresh keeps a Switchboard rename through transcript echoes and accepts a subsequent /rename', t => {
  run(temp(t), fixture + `
    refresh();
    assert.equal(displayed(), 'X');
    commands.renameSession(id, 'Y');
    fs.appendFileSync(file, title('X'));
    refresh();
    assert.equal(displayed(), 'Y', 'an unchanged transcript title cannot replace a user rename');
    assert.equal(db.getCachedSession(id).customTitle, 'X');
    fs.appendFileSync(file, title('Z'));
    refresh();
    assert.equal(displayed(), 'Z', 'a later CLI rename wins');
    assert.equal(db.getCachedSession(id).customTitle, 'Z');
    db.closeDb();
  `);
});

test('full scans and direct transcript writes preserve the rename baseline across restarts', t => {
  const root = temp(t);
  run(root, fixture + `
    refresh();
    commands.renameSession(id, 'Y');
    cache.writeScannedFolder({ folder, projectPath: root, sessions: [cache.readSessionFile(file, folder, root)], indexMtimeMs: 0 });
    assert.equal(displayed(), 'Y');
    db.closeDb();
  `);
  run(root, `
    const assert = require('node:assert/strict');
    const db = require('./test/fixtures/writer-store.cjs');
    const id = '11111111-1111-4111-8111-111111111111';
    db.setName(id, 'X', 'transcript');
    assert.equal(db.getMeta(id).name, 'Y');
    db.setName(id, 'Z', 'transcript');
    assert.equal(db.getMeta(id).name, 'Z');
    db.closeDb();
  `);
});

for (const method of ['backfill', 'refresh']) {
  test(`legacy wrong cached titles are repaired by ${method} without clobbering a saved user name`, t => {
    const root = temp(t);
    run(root, fixture + `
      refresh();
      commands.renameSession(id, 'Y');
      const Database = require('better-sqlite3');
      const sql = new Database(db.DB_PATH);
      sql.prepare('UPDATE session_cache SET customTitle = ?').run('X (3)');
      sql.prepare("DELETE FROM settings WHERE key = 'custom_title_backfill_version'").run();
      if (sql.prepare('PRAGMA table_info(session_meta_fields)').all().some(c => c.name === 'transcriptTitle')) {
        sql.exec('ALTER TABLE session_meta_fields DROP COLUMN transcriptTitle');
      }
      sql.close();
      db.closeDb();
    `);
    run(root, `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const db = require('./test/fixtures/writer-store.cjs');
      const cache = require('./session-cache');
      const root = process.env.SWITCHBOARD_DATA_DIR;
      const folder = require('./encode-project-path').encodeProjectPath(root);
      const id = '11111111-1111-4111-8111-111111111111';
      const file = path.join(root, 'projects', folder, id + '.jsonl');
      cache.init({ PROJECTS_DIR: path.join(root, 'projects'), activeSessions: new Map(), getMainWindow: () => null, log: console, db });
      (async () => {
        if ('${method}' === 'backfill') await cache.backfillCustomTitles();
        else {
          fs.utimesSync(file, new Date(1900000100000), new Date(1900000100000));
          cache.refreshFolder(folder);
        }
        assert.equal(db.getCachedSession(id).customTitle, 'X', 'repair the old first title without reindex');
        assert.equal(db.getMeta(id).name, 'Y', 'repair is not a new CLI rename');
        fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Z' }) + '\\n');
        fs.utimesSync(file, new Date(1900000200000), new Date(1900000200000));
        cache.refreshFolder(folder);
        assert.equal(db.getMeta(id).name, 'Z');
        db.closeDb();
      })().catch(err => { console.error(err); process.exitCode = 1; });
    `);
  });
}

test('a collision-named background job still prevents transcript name promotion', t => {
  run(temp(t), fixture + `
    init({ getLocalJobs: () => new Map([['job', { sessionId: id, nameSource: 'collision', name: 'X (3)' }]]) });
    refresh();
    commands.renameSession(id, 'Y');
    fs.appendFileSync(file, title('Z'));
    refresh();
    assert.equal(db.getMeta(id).name, 'Y');
    assert.equal(db.getCachedSession(id).customTitle, 'Z');
    db.closeDb();
  `);
});

test('a first CLI title after a Switchboard rename of an untitled session can win', t => {
  run(temp(t), fixture + `
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: root, message: { content: 'untitled prompt' } }) + '\\n');
    refresh();
    commands.renameSession(id, 'Y');
    fs.appendFileSync(file, title('Z'));
    refresh();
    assert.equal(displayed(), 'Z');
    db.closeDb();
  `);
});

test('a full scan establishes an absent transcript baseline for an unknown legacy user name', t => {
  run(temp(t), fixture + `
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: root, message: { content: 'untitled prompt' } }) + '\\n');
    commands.renameSession(id, 'Y');
    cache.writeScannedFolder({ folder, projectPath: root, sessions: [cache.readSessionFile(file, folder, root)], indexMtimeMs: 0 });
    assert.equal(displayed(), 'Y');
    fs.appendFileSync(file, title('Z'));
    refresh();
    assert.equal(displayed(), 'Z');
    db.closeDb();
  `);
});

test('re-keying a user name carries its transcript baseline to the continued session', t => {
  run(temp(t), fixture + `
    refresh();
    commands.renameSession(id, 'Y');
    const next = '22222222-2222-4222-8222-222222222222';
    db.upsertCachedSessions([{ ...db.getCachedSession(id), sessionId: next }]);
    db.rekeySessionMeta(id, next, 'X');
    db.setName(next, 'X', 'transcript');
    assert.equal(db.getMeta(next).name, 'Y');
    db.setName(next, 'Z', 'transcript');
    assert.equal(db.getMeta(next).name, 'Z');
    db.closeDb();
  `);
});

test('backfill repairs a legacy transcript-owned displayed name as well as its cached title', t => {
  const root = temp(t);
  run(root, fixture + `
    refresh();
    db.setName(id, 'X (3)', 'transcript');
    const Database = require('better-sqlite3');
    const sql = new Database(db.DB_PATH);
    sql.prepare('UPDATE session_cache SET customTitle = ?').run('X (3)');
    sql.prepare("DELETE FROM settings WHERE key = 'custom_title_backfill_version'").run();
    sql.close();
    db.closeDb();
  `);
  run(root, `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const db = require('./test/fixtures/writer-store.cjs');
    const cache = require('./session-cache');
    const id = '11111111-1111-4111-8111-111111111111';
    cache.init({ PROJECTS_DIR: path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects'), activeSessions: new Map(),
      getMainWindow: () => null, log: console, db });
    (async () => {
      await cache.backfillCustomTitles();
      assert.equal(cache.buildProjectsFromCache(false).flatMap(p => p.sessions).find(s => s.sessionId === id).name, 'X');
      db.closeDb();
    })().catch(err => { console.error(err); process.exitCode = 1; });
  `);
});

test('the projects worker keeps user precedence in both views while reconciling title changes', t => {
  run(temp(t), fixture + `
    const { Worker } = require('node:worker_threads');
    refresh();
    commands.renameSession(id, 'Y');
    db.setInitialScanComplete();
    const worker = new Worker(path.join(process.cwd(), 'workers/projects-query.js'), { workerData: { dbPath: db.DB_PATH, projectsDir } });
    let requestId = 0;
    const request = () => new Promise((resolve, reject) => {
      const effects = [];
      const id = ++requestId;
      const receive = message => {
        if (message.id !== id) return;
        if (message.error) { worker.off('message', receive); reject(new Error(message.error)); return; }
        if (message.progress) effects.push(...message.progress.effects);
        if (message.result) { worker.off('message', receive); resolve({ ...message.result, effects: [...effects, ...message.result.effects] }); }
      };
      worker.on('message', receive);
      worker.postMessage({ id, reconcile: true, activeSessions: [], remoteRoots: [] });
    });
    (async () => {
      try {
        for (const [append, expected] of [['X', 'Y'], ['Z', 'Z']]) {
          fs.appendFileSync(file, title(append));
          fs.utimesSync(file, new Date(1900000000000 + ++tick * 1000), new Date(1900000000000 + tick * 1000));
          const result = await request();
          for (const view of [result.defaultProjects, result.allProjects]) {
            assert.equal(view.flatMap(p => p.sessions).find(s => s.sessionId === id).name, expected);
          }
          for (const effect of result.effects) db[effect.name](...effect.args);
          assert.equal(db.getMeta(id).name, expected);
        }
      } finally { await worker.terminate(); db.closeDb(); }
    })().catch(err => { console.error(err); process.exitCode = 1; });
  `);
});
