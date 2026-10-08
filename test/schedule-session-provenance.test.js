const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupSidebarDom } = require('./dom-setup');
const { readSessionFile, readSessionDisplayHeader } = require('../read-session-file');

test('readers only accept a nonempty schedule marker on a user record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedule-marker-'));
  try {
    const file = path.join(root, 'run.jsonl');
    for (const marker of [
      { type: 'assistant', scheduleSlug: 'journal-morning' },
      { type: 'user', scheduleSlug: 1 },
      { type: 'user', scheduleSlug: ['journal-morning'] },
      { type: 'user', scheduleSlug: '' },
    ]) {
      fs.writeFileSync(file, [
        { type: 'user', message: { content: 'Scheduled Task: Write notes' }, slug: 'journal-morning' },
        marker,
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
      assert.equal(readSessionFile(file, 'folder', root).scheduleSlug, null);
      assert.equal(readSessionDisplayHeader(file).scheduleSlug, null);
    }
    fs.appendFileSync(file, JSON.stringify({ type: 'user', scheduleSlug: 'journal-morning' }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ type: 'user', scheduleSlug: 'another-schedule', slug: 'cli-changed' }) + '\n');
    assert.equal(readSessionFile(file, 'folder', root).scheduleSlug, 'journal-morning');
    assert.equal(readSessionDisplayHeader(file).scheduleSlug, 'journal-morning');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runIsolated(code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-schedule-provenance-'));
  try {
    const result = spawnSync(require('electron'), ['-e', code], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: path.join(root, 'data'), SWITCHBOARD_TEST_HOME: root },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('runner provenance survives full indexing, SQLite, header refresh and sidebar rendering', () => {
  const projects = runIsolated(`
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    require('node:os').homedir = () => process.env.SWITCHBOARD_TEST_HOME;
    const db = require('./db');
    const cache = require('./session-cache');
    const { createScheduleSession } = require('./schedule-runner');
    const { readSessionFile, readSessionDisplayHeader } = require('./read-session-file');
    const { encodeProjectPath } = require('./encode-project-path');
    const projectPath = path.join(process.env.SWITCHBOARD_TEST_HOME, 'project');
    fs.mkdirSync(projectPath);
    const folder = encodeProjectPath(projectPath);
    const projectsDir = path.join(process.env.SWITCHBOARD_TEST_HOME, '.claude', 'projects');
    const schedule = { projectPath, folder, slug: 'journal-morning', prompt: 'Write notes' };
    const runs = [createScheduleSession(schedule), createScheduleSession(schedule, Date.now() - 60000)];
    for (const run of runs) {
      assert.equal(JSON.parse(fs.readFileSync(run.jsonlPath, 'utf8')).scheduleSlug, schedule.slug, 'runner marker');
      assert.equal(readSessionFile(run.jsonlPath, folder, projectPath).scheduleSlug, schedule.slug, 'full reader');
      assert.equal(readSessionDisplayHeader(run.jsonlPath).scheduleSlug, schedule.slug, 'header reader');
    }
    const ordinary = { type: 'user', cwd: projectPath, slug: schedule.slug, message: { content: 'Scheduled Task: Write notes' } };
    fs.writeFileSync(path.join(projectsDir, folder, 'plain.jsonl'), JSON.stringify(ordinary) + '\\n');
    cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, db,
      log: { info() {}, debug() {}, warn() {}, error() {} } });
    cache.refreshFolder(folder);
    for (const run of runs) assert.equal(db.getCachedSession(run.sessionId).scheduleSlug, schedule.slug, 'SQLite round trip');
    assert.equal(db.getCachedSession('plain').scheduleSlug, null, 'typed prefix has no marker');
    for (const run of runs) {
      db.upsertCachedSessions([{ ...db.getCachedSession(run.sessionId), scheduleSlug: null, fileMtime: 'stale' }]);
      assert.equal(db.getCachedSession(run.sessionId).scheduleSlug, null, 'SQLite updates an existing marker');
      fs.appendFileSync(run.jsonlPath, JSON.stringify({ type: 'assistant', message: { content: 'Done' } }) + '\\n');
    }
    cache.refreshFolder(folder);
    for (const run of runs) assert.equal(db.getCachedSession(run.sessionId).scheduleSlug, schedule.slug, 'header refresh backfills marker');
    console.log(JSON.stringify(cache.buildProjectsFromCache(true)));
    db.closeDb();
  `);
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects(projects, true);
    assert.equal(ctx.document.querySelector('[data-session-id="plain"]').closest('.slug-group'), null);
    const groups = ctx.document.querySelectorAll('.slug-group');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].querySelector('.slug-group-name').textContent, 'journal-morning');
    assert.equal(groups[0].querySelectorAll('.session-item').length, 2);
  } finally {
    ctx.destroy();
  }
});

test('schema upgrade preserves old cached rows without guessing schedule provenance', () => {
  const row = runIsolated(`
    const fs = require('node:fs');
    const path = require('node:path');
    const Database = require('better-sqlite3');
    fs.mkdirSync(process.env.SWITCHBOARD_DATA_DIR);
    const raw = new Database(path.join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
    raw.exec(\`CREATE TABLE session_cache (
      sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
      summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT, messageCount INTEGER,
      slug TEXT, aiTitle TEXT, parentSessionId TEXT, agentId TEXT, subagentType TEXT,
      description TEXT, fileMtime TEXT, bridgeSessionId TEXT, mergedIntoSessionId TEXT, entrypoint TEXT
    ); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('db_version', '999');
    INSERT INTO session_cache (sessionId, folder, slug, firstPrompt) VALUES ('old', 'folder', 'journal-morning', 'Scheduled Task: Write notes');\`);
    raw.close();
    const db = require('./db');
    console.log(JSON.stringify(db.getCachedSession('old')));
    db.closeDb();
  `);
  assert.equal(row.sessionId, 'old');
  assert.equal(row.scheduleSlug, null);
  assert.equal(row.slug, 'journal-morning');
});
