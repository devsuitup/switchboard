'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../db');
const cache = require('../../session-cache');
const { encodeProjectPath } = require('../../encode-project-path');

async function run() {
  const project = path.join(process.env.SWITCHBOARD_DATA_DIR, 'repo');
  const projectsDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects');
  const folder = encodeProjectPath(project);
  const dir = path.join(projectsDir, folder);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 121; i++) {
    const id = `session-${i}`;
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: project,
      timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: `Fixture ${i}` } }) + '\n');
  }
  fs.writeFileSync(path.join(dir, 'large-tail.jsonl'), JSON.stringify({ type: 'user', cwd: project,
    timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'Large pending record' } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(900000) } }));
  const config = { PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console };
  cache.init({ ...config, db });
  cache.writeScannedFolder({ ...cache.readFolderFromFilesystem(folder), folder, indexMtimeMs: 0 });
  const expected = db.getCachedByFolder(folder);
  const expectedMetrics = db.getDailyMetrics();
  db.deleteCachedFolder(folder);
  db.deleteSearchFolder(folder);
  let reads = 0;
  let maxRows = 0;
  let yields = 0;
  let immediate;
  let counting = true;
  function tick() { yields++; if (counting) immediate = setImmediate(tick); }
  immediate = setImmediate(tick);
  const wrapped = { ...db,
    getCachedByFolder: (...args) => { reads++; return db.getCachedByFolder(...args); },
    upsertCachedSessions: rows => { maxRows = Math.max(maxRows, rows.length); db.upsertCachedSessions(rows); },
  };
  let startupConflict = false;
  cache.init({ ...config, db: wrapped, trace: (event, data) => {
    if (event === 'indexing.apply' && data.kind === 'scan' && data.accepted && !startupConflict) {
      startupConflict = true;
      setImmediate(() => db.setSetting('startup_conflict_probe', 'external writer'));
    }
  } });
  try {
    await cache.populateCacheViaWorker();
    assert.ok(maxRows <= 50, `main writes must be bounded to 50 rows, got ${maxRows}`);
    assert.equal(reads, 0, 'startup must not bulk-read cached folders on main');
    assert.ok(yields > 2, 'main must yield while applying folder batches');
    assert.equal(db.isInitialScanComplete(), true);
    const actual = db.getCachedByFolder(folder);
    const fields = Object.keys(expected[0]);
    const projectRows = rows => rows.map(row => Object.fromEntries(fields.map(key => [key, row[key] ?? null])))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    assert.deepEqual(projectRows(actual), projectRows(expected));
    assert.deepEqual(db.getDailyMetrics(), expectedMetrics);
    assert.equal(db.searchByType('session', 'Fixture', 200).length, 121);
    assert.deepEqual((await cache.queryCache({ kind: 'parent-files', projectsDir: dir })).sort(),
      fs.readdirSync(dir).filter(file => file.endsWith('.jsonl')).sort());
    const daily = db.getDailyMetrics();
    const date = new Date().toISOString().slice(0, 10);
    assert.deepEqual(await cache.queryCache({ kind: 'stats' }), { dailyActivity: daily,
      dailyModelTokens: db.getDailyModelTokens(), modelUsage: db.getModelUsage(), ...db.getTotalCounts(),
      firstSessionDate: daily[0]?.date || date, lastComputedDate: date });
    const file = path.join(dir, 'session-0.jsonl');
    fs.appendFileSync(file, JSON.stringify({ type: 'user', cwd: project, timestamp: '2026-10-02T00:00:00.000Z',
      message: { role: 'user', content: 'Appended prompt' } }) + '\n');
    const beforeRefresh = db.getCachedSession('session-0');
    const beforeMeta = db.getFolderMeta(folder);
    cache.init({ ...config, db: { ...db, DB_PATH: undefined } });
    cache.refreshFolder(folder, { files: new Set(['session-0.jsonl']) });
    const expectedRefresh = db.getCachedSession('session-0');
    db.upsertCachedSessions([beforeRefresh]);
    db.setFolderMeta(folder, beforeMeta.projectPath, beforeMeta.indexMtimeMs);
    cache.init({ ...config, db: wrapped });
    await cache.refreshFolder(folder, { files: new Set(['session-0.jsonl']) });
    assert.equal(reads, 0, 'watcher refresh must not bulk-read cached folders on main');
    assert.deepEqual(db.getCachedSession('session-0'), expectedRefresh);
    assert.ok(maxRows <= 50);
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `late-${i}.jsonl`), JSON.stringify({ type: 'user', cwd: project,
      timestamp: '2026-10-03T00:00:00.000Z', message: { role: 'user', content: `lateworker ${i}` } }) + '\n');
    let injected = false;
    cache.init({ ...config, db: wrapped, trace: (event, data) => {
      if (event === 'indexing.apply' && data.kind === 'refresh' && data.accepted && !injected) {
        injected = true;
        setImmediate(() => db.setSetting('conflict_probe', 'external writer'));
      }
    } });
    await cache.refreshFolder(folder);
    assert.equal(db.searchByType('session', 'lateworker', 100).length, 60,
      'a conflict after accepted batches must not strand newly cached rows without FTS');
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `failed-${i}.jsonl`), JSON.stringify({ type: 'user', cwd: project,
      timestamp: '2026-10-04T00:00:00.000Z', message: { role: 'user', content: `failedworker ${i}` } }) + '\n');
    let failOnce = true;
    cache.init({ ...config, db: { ...wrapped, upsertSearchEntries: entries => {
      if (failOnce && entries.some(entry => entry.id.startsWith('failed-'))) { failOnce = false; throw new Error('injected late FTS failure'); }
      db.upsertSearchEntries(entries);
    } } });
    await assert.rejects(cache.refreshFolder(folder), /injected late FTS failure/);
    await cache.refreshFolder(folder);
    assert.equal(db.searchByType('session', 'failedworker', 100).length, 60,
      'a failed later batch must be repairable after restarting the worker');
    console.log('startup and refresh equivalence verified');
  } finally {
    counting = false;
    clearImmediate(immediate);
    cache.shutdownIndexing?.();
    db.closeDb();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
