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

test('bounded header reports head and tail titles separately without inventing a tail fallback', t => {
  const file = path.join(temp(t), 'session.jsonl');
  const title = customTitle => JSON.stringify({ type: 'custom-title', customTitle }) + '\n';
  const prompt = JSON.stringify({ type: 'user', message: { content: 'prompt' } }) + '\n';
  fs.writeFileSync(file, title('X (3)') + prompt + title('head') + ' '.repeat(600000) + '\n' + title('X') + '{"type":');
  const original = fs.readSync;
  let bytes = 0;
  fs.readSync = function(...args) { const n = original.apply(this, args); bytes += n; return n; };
  try {
    const header = readSessionDisplayHeader(file);
    assert.equal(header.tailTitle, 'X');
    assert.equal(header.headTitle, 'head');
    assert.ok(bytes <= 512 * 1024 + 1, `bounded reads: ${bytes}`);
  } finally { fs.readSync = original; }
  fs.writeFileSync(file, title('X (3)') + prompt + title('head') + ' '.repeat(600000) + '\n');
  assert.equal(readSessionDisplayHeader(file).headTitle, 'head');
  assert.equal(readSessionDisplayHeader(file).tailTitle, null);
});

test('a tail window exactly at a line start retains its complete first title', t => {
  const file = path.join(temp(t), 'session.jsonl');
  const title = JSON.stringify({ type: 'custom-title', customTitle: 'boundary' }) + '\n';
  const head = JSON.stringify({ type: 'user', message: { content: 'prompt' } }) + '\n';
  fs.writeFileSync(file, head + ' '.repeat(300000) + '\n' + title + ' '.repeat(256 * 1024 - Buffer.byteLength(title)));
  assert.equal(readSessionDisplayHeader(file).customTitle, 'boundary');
});

test('a title-free gap larger than the tail keeps the cached title and user rename', t => {
  run(temp(t), fixture + `
    refresh();
    commands.renameSession(id, 'Y');
    fs.appendFileSync(file, ' '.repeat(300000) + '\\n');
    refresh();
    assert.equal(displayed(), 'Y', 'the old head title cannot undo a user rename');
    assert.equal(db.getCachedSession(id).customTitle, 'X');
    db.closeDb();
  `);
});

for (const [first, next] of [['X (3)', 'X'], ['X', 'X (3)']]) {
  test(`CLI deduplication ${first} to ${next} keeps a user rename until /rename Z`, t => {
    run(temp(t), fixture + `
      fs.writeFileSync(file, title('${first}') + JSON.stringify({ type: 'user', cwd: root, message: { content: 'prompt' } }) + '\\n');
      refresh();
      commands.renameSession(id, 'Y');
      fs.appendFileSync(file, title('${next}'));
      refresh();
      assert.equal(displayed(), 'Y', 'deduplication is not a user rename');
      fs.appendFileSync(file, title('Z'));
      refresh();
      assert.equal(displayed(), 'Z');
      db.closeDb();
    `);
  });
}

for (const adapter of ['SQLite', 'recorder']) {
  test(`a NULL baseline adopts the first CLI title and accepts the next distinct rename through ${adapter} refresh`, t => {
    run(temp(t), fixture + `
      refresh();
      const Database = require('better-sqlite3');
      const sql = new Database(db.DB_PATH);
      sql.prepare('UPDATE session_cache SET customTitle = NULL WHERE sessionId = ?').run(id);
      commands.renameSession(id, 'Y');
      assert.equal(db.getMeta(id, true).nameTranscriptTitle, null);
      assert.equal(db.getCachedSession(id).customTitle, null);
      const recorder = '${adapter}' === 'recorder' ? require('./cache-effects').createCacheEffects(db) : null;
      if (recorder) { init({ db: recorder.adapter }); recorder.begin(); }
      fs.appendFileSync(file, title('Z'));
      refresh();
      assert.equal(displayed(), 'Y', 'the first observed title establishes the missing baseline');
      fs.appendFileSync(file, title('W'));
      refresh();
      assert.equal(displayed(), 'W', 'the next distinct CLI rename replaces the user name');
      if (recorder) for (const effect of recorder.finish()) db[effect.name](...effect.args);
      assert.equal(db.getMeta(id, true).nameTranscriptTitle, 'W');
      assert.equal(db.getMeta(id).name, 'W');
      sql.close();
      db.closeDb();
    `);
  });
}

for (const method of ['writeScannedFolder', 'recorder', 'refreshFolder']) {
  test(`a NULL baseline and cached title preserve the user name through ${method}`, t => {
    run(temp(t), fixture + `
      refresh();
      commands.renameSession(id, 'Y');
      const Database = require('better-sqlite3');
      const sql = new Database(db.DB_PATH);
      sql.prepare('UPDATE session_cache SET customTitle = NULL WHERE sessionId = ?').run(id);
      sql.prepare('UPDATE session_meta_fields SET transcriptTitle = NULL WHERE sessionId = ?').run(id);
      assert.equal(db.getMeta(id, true).nameTranscriptTitle, null);
      assert.equal(db.getCachedSession(id).customTitle, null);
      const recorder = '${method}' === 'recorder' ? require('./cache-effects').createCacheEffects(db) : null;
      if (recorder) { init({ db: recorder.adapter }); recorder.begin(); }
      if ('${method}' === 'refreshFolder') refresh();
      else cache.writeScannedFolder({ folder, projectPath: root,
        sessions: [cache.readSessionFile(file, folder, root)], indexMtimeMs: 0 });
      assert.equal(displayed(), 'Y', 'an unchanged transcript title cannot replace the user name after migration');
      if (recorder) {
        const effects = recorder.finish();
        assert.equal(effects.find(effect => effect.name === 'upsertSearchEntries').args[0][0].title, 'Y fixture prompt');
        for (const effect of effects) db[effect.name](...effect.args);
      }
      assert.equal(db.getMeta(id).name, 'Y');
      assert.equal(db.getMeta(id, true).nameTranscriptTitle, 'X');
      assert.equal(db.getCachedSession(id).customTitle, 'X');
      sql.close();
      db.closeDb();
    `);
  });
}

test('refresh hydrates a NULL baseline from an already cached title and keeps the user name', t => {
  run(temp(t), fixture + `
    refresh();
    commands.renameSession(id, 'Y');
    const Database = require('better-sqlite3');
    const sql = new Database(db.DB_PATH);
    sql.prepare('UPDATE session_meta_fields SET transcriptTitle = NULL WHERE sessionId = ?').run(id);
    refresh();
    assert.equal(displayed(), 'Y');
    assert.equal(db.getMeta(id, true).nameTranscriptTitle, 'X');
    sql.close();
    db.closeDb();
  `);
});

for (const method of ['refresh', 'backfill']) {
  test(`baseline-only ${method} hydration cannot outrank a newer user name during rekey`, t => {
    run(temp(t), fixture + `
      refresh();
      const Database = require('better-sqlite3');
      const sql = new Database(db.DB_PATH);
      if ('${method}' === 'backfill') sql.prepare('UPDATE session_cache SET customTitle = NULL WHERE sessionId = ?').run(id);
      commands.renameSession(id, 'Y');
      sql.prepare('UPDATE session_meta_fields SET transcriptTitle = NULL WHERE sessionId = ?').run(id);
      const revision = db.getMeta(id, true).nameRevision;
      const next = '22222222-2222-4222-8222-222222222222';
      commands.renameSession(next, 'newer user name');
      if ('${method}' === 'backfill') {
        db.setCachedCustomTitles([{ sessionId: id, customTitle: 'X', fileMtime: db.getCachedSession(id).fileMtime }]);
      } else refresh();
      assert.equal(db.getMeta(id, true).nameTranscriptTitle, 'X');
      assert.equal(db.getMeta(id, true).nameRevision, revision, 'baseline hydration must preserve the name revision');
      db.rekeySessionMeta(id, next, 'X');
      assert.equal(db.getMeta(next).name, 'newer user name');
      sql.close();
      db.closeDb();
    `);
  });
}

for (const method of ['refresh', 'backfill']) {
  for (const newer of ['source', 'target']) {
    test(`baseline-only ${method} hydration keeps the field-backed ${newer} name over a field-less name during rekey`, t => {
      run(temp(t), fixture + `
        const Database = require('better-sqlite3');
        const sql = new Database(db.DB_PATH);
        const next = '22222222-2222-4222-8222-222222222222';
        const legacyId = '${newer}' === 'source' ? next : id;
        const newerId = '${newer}' === 'source' ? id : next;
        sql.prepare('INSERT INTO session_meta (sessionId, name) VALUES (?, ?)').run(legacyId, 'legacy old');
        commands.renameSession(newerId, 'newer user name');
        assert.equal(db.getMeta(legacyId, true).nameRevision, null);
        assert.equal(db.getMeta(newerId, true).nameRevision, 1);
        if ('${method}' === 'backfill') {
          db.upsertCachedSessions([{ sessionId: legacyId, folder, projectPath: root, customTitle: null }]);
          db.setCachedCustomTitles([{ sessionId: legacyId, customTitle: 'X' }]);
        } else {
          fs.writeFileSync(path.join(path.dirname(file), next + '.jsonl'), title('X') +
            JSON.stringify({ type: 'user', cwd: root, message: { content: 'continued prompt' } }) + '\\n');
          refresh();
        }
        db.rekeySessionMeta(id, next, 'X');
        assert.equal(db.getMeta(next).name, 'newer user name', 'a baseline cannot make a legacy name win a rekey');
        assert.equal(db.getMeta(legacyId, true).nameRevision, '${newer}' === 'source' ? 1 : 0);
        assert.equal(db.getMeta(next, true).nameRevision, 1);
        sql.close();
        db.closeDb();
      `);
    });
  }
}

for (const row of [{ folder: 'host::-fixture' }, { folder: '-fixture', parentSessionId: 'parent' }]) {
  test(`migration preserves ${row.parentSessionId ? 'subagent' : 'remote'} titles and NULL baselines accept /rename`, t => {
    const root = temp(t);
    run(root, fixture + `
      db.upsertCachedSessions([{ sessionId: id, ...${JSON.stringify(row)}, customTitle: 'X' }]);
      commands.renameSession(id, 'Y');
      const Database = require('better-sqlite3');
      const sql = new Database(db.DB_PATH);
      sql.prepare("DELETE FROM settings WHERE key = 'custom_title_backfill_version'").run();
      sql.close();
      db.closeDb();
    `);
    run(root, `
      const assert = require('node:assert/strict');
      const db = require('./test/fixtures/writer-store.cjs');
      const id = '11111111-1111-4111-8111-111111111111';
      assert.equal(db.getCachedSession(id).customTitle, 'X');
      assert.equal(db.getMeta(id, true).nameTranscriptTitle, 'X');
      const Database = require('better-sqlite3');
      const sql = new Database(db.DB_PATH);
      sql.prepare("UPDATE session_meta_fields SET transcriptTitle = NULL WHERE sessionId = ?").run(id);
      sql.prepare("UPDATE session_cache SET customTitle = NULL WHERE sessionId = ?").run(id);
      sql.close();
      db.upsertCachedSessions([{ ...db.getCachedSession(id), customTitle: 'Z' }]);
      db.setName(id, 'Z', 'transcript');
      assert.equal(db.getMeta(id).name, 'Z');
      db.closeDb();
    `);
  });
}

for (const method of ['writeScannedFolder', 'writeScannedFolderPartial']) {
  test(`${method} recorder keeps the search title consistent with the user name`, t => {
    run(temp(t), fixture + `
      const { createCacheEffects } = require('./cache-effects');
      refresh();
      commands.renameSession(id, 'Y');
      const recorder = createCacheEffects(db);
      cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null,
        log: console, db: recorder.adapter });
      recorder.begin();
      cache.${method}({ folder, projectPath: root, sessions: [cache.readSessionFile(file, folder, root)], indexMtimeMs: 0 });
      const effects = recorder.finish();
      const entries = effects.find(effect => effect.name === 'upsertSearchEntries').args[0];
      assert.equal(entries[0].title, 'Y fixture prompt');
      for (const effect of effects) db[effect.name](...effect.args);
      assert.equal(db.getMeta(id).name, 'Y');
      db.closeDb();
    `);
  });
}

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
  test(`legacy unknown titles are repaired by ${method} without clobbering a user name`, t => {
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
        assert.equal(db.getMeta(id).name, 'Y', 'repair establishes a baseline from the incoming title');
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

test('re-keying legacy metadata preserves its missing revision as zero', t => {
  run(temp(t), fixture + `
    refresh();
    commands.renameSession(id, 'Y');
    const Database = require('better-sqlite3');
    const sql = new Database(db.DB_PATH);
    sql.prepare('DELETE FROM session_meta_fields WHERE sessionId = ?').run(id);
    sql.close();
    const next = '22222222-2222-4222-8222-222222222222';
    db.rekeySessionMeta(id, next, 'X');
    assert.equal(db.getMeta(next, true).nameRevision, 0);
    assert.equal(db.getMeta(next).name, 'Y');
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

test('the projects worker preserves a user name when the first title establishes a NULL baseline', t => {
  run(temp(t), fixture + `
    const { Worker } = require('node:worker_threads');
    refresh();
    const Database = require('better-sqlite3');
    const sql = new Database(db.DB_PATH);
    sql.prepare('UPDATE session_cache SET customTitle = NULL WHERE sessionId = ?').run(id);
    commands.renameSession(id, 'Y');
    sql.close();
    db.setInitialScanComplete();
    fs.appendFileSync(file, title('Z'));
    fs.utimesSync(file, new Date(1900000100000), new Date(1900000100000));
    const worker = new Worker(path.join(process.cwd(), 'workers/projects-query.js'), { workerData: { dbPath: db.DB_PATH, projectsDir } });
    (async () => {
      try {
        const result = await new Promise((resolve, reject) => {
          const effects = [];
          worker.on('error', reject);
          worker.on('message', message => {
            if (message.error) { reject(new Error(message.error)); return; }
            if (message.progress) effects.push(...message.progress.effects);
            if (message.result) resolve({ ...message.result, effects: [...effects, ...message.result.effects] });
          });
          worker.postMessage({ id: 1, reconcile: true, activeSessions: [], remoteRoots: [] });
        });
        for (const view of [result.defaultProjects, result.allProjects]) {
          assert.equal(view.flatMap(p => p.sessions).find(s => s.sessionId === id).name, 'Y');
        }
        for (const effect of result.effects) db[effect.name](...effect.args);
        assert.equal(db.getMeta(id).name, 'Y');
        assert.equal(db.getMeta(id, true).nameTranscriptTitle, 'Z');
      } finally { await worker.terminate(); db.closeDb(); }
    })().catch(err => { console.error(err); process.exitCode = 1; });
  `);
});

test('the projects worker keeps user precedence in both views while reconciling title changes', t => {
  run(temp(t), fixture + `
    const { Worker } = require('node:worker_threads');
    fs.writeFileSync(file, title('X (3)') + JSON.stringify({ type: 'user', cwd: root, message: { content: 'fixture prompt' } }) + '\\n');
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
        for (const [append, expected] of [['X', 'Y'], [null, 'Y'], ['X (3)', 'Y'], ['Z', 'Z']]) {
          fs.appendFileSync(file, append ? title(append) : ' '.repeat(300000) + '\\n');
          fs.utimesSync(file, new Date(1900000000000 + ++tick * 1000), new Date(1900000000000 + tick * 1000));
          const result = await request();
          for (const view of [result.defaultProjects, result.allProjects]) {
            assert.equal(view.flatMap(p => p.sessions).find(s => s.sessionId === id).name, expected);
          }
          for (const effect of result.effects) db[effect.name](...effect.args);
          assert.equal(db.getMeta(id).name, expected);
          if (append === null) assert.equal(db.getCachedSession(id).customTitle, 'X');
        }
      } finally { await worker.terminate(); db.closeDb(); }
    })().catch(err => { console.error(err); process.exitCode = 1; });
  `);
});
