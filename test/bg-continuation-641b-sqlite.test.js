'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OLD = '11111111-1111-4111-8111-111111111111';
const HEAD = '22222222-2222-4222-8222-222222222222';

for (const version of [9, 42]) test(`metadata revision index preserves db_version ${version} and cached sessions`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641d-revisions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    assert.equal(db.getSetting('db_version'), 9);
    db.setName('old', 'User rename'); db.setName('head', 'Indexed title', 'transcript');
    db.upsertCachedSessions([{ sessionId: 'cached', folder: 'project', summary: 'Keep me' }]);
    db.setFolderMeta('project', '/project', 123);
    db.setInitialScanComplete();
    db.closeDb();
    const sql = new (require('better-sqlite3'))(require('node:path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
    for (const index of sql.prepare('PRAGMA index_list(session_meta_fields)').all()) {
      if (index.origin === 'c') sql.exec('DROP INDEX "' + index.name + '"');
    }
    sql.prepare("UPDATE settings SET value = ? WHERE key = 'db_version'").run(String(${version}));
    sql.close();
    delete require.cache[require.resolve('./test/fixtures/writer-store.cjs')];
    const reopened = require('./test/fixtures/writer-store.cjs');
    assert.equal(reopened.getSetting('db_version'), ${version});
    const inspect = new (require('better-sqlite3'))(reopened.DB_PATH);
    const plan = inspect.prepare('EXPLAIN QUERY PLAN SELECT MAX(revision) FROM session_meta_fields').all();
    assert.match(plan.map(row => row.detail).join(' '), /USING COVERING INDEX idx_session_meta_fields_revision/);
    assert.equal(reopened.getCachedSession('cached').summary, 'Keep me');
    assert.equal(reopened.getFolderMeta('project').indexMtimeMs, 123);
    assert.equal(reopened.isInitialScanComplete(), true);
    reopened.setName('old', 'Newest rename');
    const revisions = inspect.prepare("SELECT sessionId, revision FROM session_meta_fields WHERE field = 'name'").all();
    assert.ok(revisions.find(row => row.sessionId === 'old').revision > revisions.find(row => row.sessionId === 'head').revision);
    reopened.rekeySessionMeta('old', 'head');
    assert.equal(reopened.getMeta('head').name, 'Newest rename');
    inspect.close(); reopened.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('SQLite continuation copies metadata, avoids title names and keeps the newest value per field', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    db.setName('old', 'original'); db.toggleStar('old'); db.setArchived('old', true);
    db.setName('new', 'newer'); db.setArchived('new', false);
    db.rekeySessionMeta('old', 'new', 'title');
    assert.equal(db.getMeta('old').name, 'original');
    assert.deepEqual(db.getMeta('new'), { sessionId: 'new', name: 'newer', starred: 1, archived: 0 });
    db.setName('old', 'latest'); db.toggleStar('new');
    db.rekeySessionMeta('old', 'new');
    assert.deepEqual(db.getMeta('new'), { sessionId: 'new', name: 'latest', starred: 0, archived: 0 });
    db.rekeySessionMeta('absent', 'title-only', 'transcript title');
    assert.equal(db.getMeta('title-only')?.name ?? null, null);
    db.setName('transcript', 'transcript title', 'transcript');
    db.rekeySessionMeta('transcript', 'no-rename');
    assert.equal(db.getMeta('no-rename').name, null);
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a newer indexed transcript title cannot defeat a genuine Switchboard rename', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-title-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    db.setName('old', 'Switchboard rename');
    db.setName('new', 'Original (2)', 'transcript');
    db.rekeySessionMeta('old', 'new', 'Original');
    assert.equal(db.getMeta('new').name, 'Switchboard rename');
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a legacy genuine rename retains its provenance across successive background continuations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    db.closeDb();
    const sql = new (require('better-sqlite3'))(require('node:path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
    sql.prepare('INSERT INTO session_meta(sessionId, name) VALUES (?, ?)').run('legacy', 'Legacy rename');
    sql.close();
    delete require.cache[require.resolve('./test/fixtures/writer-store.cjs')];
    const reopened = require('./test/fixtures/writer-store.cjs');
    reopened.setName('next', 'Original (2)', 'transcript');
    reopened.rekeySessionMeta('legacy', 'next', 'Original');
    assert.equal(reopened.getMeta('next').name, 'Legacy rename');
    reopened.rekeySessionMeta('next', 'third', 'Original');
    assert.equal(reopened.getMeta('third').name, 'Legacy rename');
    reopened.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a newer genuine head rename selected by SQLite also appears on the merged sidebar row', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-sidebar-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    const { mergeLocalBackgroundSessions } = require('./sidebar-bg-sessions');
    db.setName('${OLD}', 'Older Switchboard rename');
    db.setName('${HEAD}', 'Newer Switchboard rename');
    db.rekeySessionMeta('${OLD}', '${HEAD}', 'Original title');
    const row = { sessionId: '${OLD}', folder: '-project', name: 'Older Switchboard rename', customTitle: 'Original title',
      projectPath: '/project', continuationIndex: JSON.stringify({ format: 3, complete: true, ids: ['${HEAD}'] }) };
    const projects = [{ projectPath: '/project', sessions: [row] }];
    mergeLocalBackgroundSessions(projects, [row], [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(row.name, 'Newer Switchboard rename');
    assert.equal(projects[0].sessions.length, 1);
    assert.equal(db.getMeta('${OLD}').name, 'Older Switchboard rename');
    db.setName('${HEAD}', null);
    const cleared = { ...row, sessionId: '${OLD}', name: 'Older Switchboard rename', mergedMemberIds: [] };
    mergeLocalBackgroundSessions([{ projectPath: '/project', sessions: [cleared] }], [cleared],
      [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(cleared.name, 'Original title');
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a newer original rename survives indexed titles and older head renames before a tab rekey', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-sidebar-title-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    const { mergeLocalBackgroundSessions } = require('./sidebar-bg-sessions');
    db.setName('${OLD}', 'Switchboard rename'); db.setName('${HEAD}', 'Original (2)', 'transcript');
    const row = { sessionId: '${OLD}', folder: '-project', name: 'Switchboard rename', customTitle: 'Original',
      projectPath: '/project', continuationIndex: JSON.stringify({ format: 3, complete: true, ids: ['${HEAD}'] }) };
    const projects = [{ projectPath: '/project', sessions: [row] }];
    mergeLocalBackgroundSessions(projects, [row], [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(row.name, 'Switchboard rename');
    db.setName('${HEAD}', 'Older head rename'); db.setName('${OLD}', 'Newest original rename');
    const newerOriginal = { ...row, sessionId: '${OLD}', name: 'Newest original rename', mergedMemberIds: [] };
    const nextProjects = [{ projectPath: '/project', sessions: [newerOriginal] }];
    mergeLocalBackgroundSessions(nextProjects, [newerOriginal], [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(newerOriginal.name, 'Newest original rename');
    db.setName('${OLD}', null);
    const cleared = { ...newerOriginal, sessionId: '${OLD}', name: 'Original', mergedMemberIds: [] };
    mergeLocalBackgroundSessions([{ projectPath: '/project', sessions: [cleared] }], [cleared],
      [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(cleared.name, 'Original');
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
