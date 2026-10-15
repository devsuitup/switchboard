'use strict';

// Cold-start indexing UX fix.
//
// populateCacheViaWorker() used to accumulate every folder's parsed sessions
// in the worker and write them ALL to the DB in one shot only after the
// worker's single final message — meaning a large ~/.claude/projects/ history
// left the sidebar with nothing at all for the whole scan (witnessed live:
// user force-quit believing the app had hung). It now writes each folder to
// the DB as its message streams in (workers/scan-projects.js), and only
// emits the new indexing-progress event while the initial scan has never run
// to completion (the persistent initial_scan_complete marker is absent) so
// warm-start rebuilds never show a banner. The marker — not a row-count
// check — is what drives the cold/warm split, because per-folder streaming
// means an interrupted scan leaves the cache non-empty (see
// test/get-projects-cold-start-reconcile.test.js for the handler side).
//
// Spins the REAL worker (workers/scan-projects.js has no native deps) against
// a temp PROJECTS_DIR with real fixture .jsonl files — same pattern as
// test/reconcile-cache.test.js (main-thread refreshFolder) and
// test/search-worker-db-failure.test.js (a different real worker).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('node:worker_threads');
const vm = require('node:vm');

const sessionCache = require('../session-cache');
const { encodeProjectPath } = require('../encode-project-path');

function writeSession(projectsDir, name) {
  const cwd = path.join(projectsDir, name);
  const folderPath = path.join(projectsDir, encodeProjectPath(cwd));
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

function makeFakeDb({ initialScanComplete }) {
  const calls = { upsertCachedSessions: [], setFolderMeta: [], deleteCachedFolder: [], setInitialScanComplete: 0 };
  const sentEvents = [];
  return {
    calls,
    sentEvents,
    isInitialScanComplete: () => initialScanComplete,
    setInitialScanComplete: () => { calls.setInitialScanComplete++; },
    deleteCachedFolder: (folder) => calls.deleteCachedFolder.push(folder),
    getCachedByFolder: () => [],
    upsertCachedSessions: (rows) => calls.upsertCachedSessions.push(rows),
    touchCachedModified: () => {},
    deleteCachedSession: () => {},
    replaceSessionMetrics: () => {},
    deleteSearchFolder: () => {},
    deleteSearchSession: () => {},
    upsertSearchEntries: () => {},
    setFolderMeta: (folder, projectPath, indexMtimeMs) => calls.setFolderMeta.push({ folder, projectPath, indexMtimeMs }),
    getAllFolderMeta: () => new Map(),
    getAllMeta: () => new Map(),
    getAllCached: () => [],
    getSetting: () => ({}),
    getMeta: () => null,
    setName: () => {},
  };
}

function initCache(projectsDir, db, extra = {}) {
  const sentEvents = db.sentEvents;
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => sentEvents.push(args) },
    }),
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    db,
    ...extra,
  });
}

for (const exhausted of [false, true]) {
  test(`Rebuild forces a full shared scan during ${exhausted ? 'exhausted retries' : 'retry backoff'}`, async () => {
    const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-force-'));
    let now = 0, fail = true;
    const attempts = [];
    try {
      writeSession(projectsDir, 'good');
      writeSession(projectsDir, 'bad');
      const db = makeFakeDb({ initialScanComplete: false });
      initCache(projectsDir, db, { now: () => now, writer: {
        writeScannedFolder(result) {
          const name = path.basename(result.projectPath);
          attempts.push(name);
          if (fail && name === 'bad') throw new Error('injected write failure');
          return result.sessions.length;
        },
        setInitialScanComplete: db.setInitialScanComplete,
      } });
      await sessionCache.populateCacheViaWorker();
      if (exhausted) {
        for (const delay of [30000, 120000, 600000]) {
          now += delay;
          await sessionCache.populateCacheViaWorker();
        }
      }
      const before = attempts.length;
      await sessionCache.populateCacheViaWorker();
      assert.equal(attempts.length, before);
      fail = false;
      let rebuild;
      const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
      const start = source.indexOf("ipcMain.handle('rebuild-cache'");
      const end = source.indexOf('\n});', start) + 4;
      vm.runInNewContext(source.slice(start, end), {
        ipcMain: { handle: (_name, handler) => { rebuild = handler; } },
        populateCacheViaWorker: sessionCache.populateCacheViaWorker,
        console,
      });
      const rebuilding = rebuild();
      const scan = sessionCache.populateCacheViaWorker();
      assert.equal((await rebuilding).ok, true);
      await scan;
      assert.deepEqual(attempts.slice(before).sort(), ['bad', 'good'], 'Rebuild must scan every folder');
      assert.equal(db.calls.setInitialScanComplete, 1);
      const forced = sessionCache.populateCacheViaWorker({ force: true });
      assert.equal(sessionCache.populateCacheViaWorker({ force: true }), forced, 'forced callers share one scan');
      assert.equal(sessionCache.populateCacheViaWorker(), forced);
      await forced;
      assert.deepEqual(attempts.slice(before + 2).sort(), ['bad', 'good']);
    } finally { fs.rmSync(projectsDir, { recursive: true, force: true }); }
  });
}

test('failed folders retry alone with backoff, a shared scan and a per-start retry limit', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-retry-'));
  let now = 1000;
  const attempts = [];
  try {
    writeSession(projectsDir, 'good');
    writeSession(projectsDir, 'bad');
    const db = makeFakeDb({ initialScanComplete: false });
    const writer = {
      writeScannedFolder(result) {
        attempts.push(path.basename(result.projectPath));
        if (result.projectPath.endsWith('bad')) throw new Error('injected folder write failure');
        return result.sessions.length;
      },
      setInitialScanComplete: db.setInitialScanComplete,
    };
    initCache(projectsDir, db, { writer, now: () => now });
    const first = sessionCache.populateCacheViaWorker();
    assert.equal(sessionCache.populateCacheViaWorker(), first);
    await first;
    assert.deepEqual(attempts.sort(), ['bad', 'good']);
    await sessionCache.populateCacheViaWorker();
    assert.equal(attempts.length, 2, 'get-projects cannot restart before backoff');
    for (const delay of [30000, 120000, 600000]) {
      now += delay - 1;
      await sessionCache.populateCacheViaWorker();
      const before = attempts.length;
      now++;
      const retry = sessionCache.populateCacheViaWorker();
      assert.equal(sessionCache.populateCacheViaWorker(), retry);
      await retry;
      assert.deepEqual(attempts.slice(before), ['bad'], 'only the failed folder retries');
    }
    now += 86400000;
    await sessionCache.populateCacheViaWorker();
    assert.equal(attempts.length, 5, 'no fourth retry until next start');
    assert.equal(db.calls.setInitialScanComplete, 0);
    initCache(projectsDir, db, { writer: { ...writer, writeScannedFolder: result => result.sessions.length }, now: () => now });
    await sessionCache.populateCacheViaWorker();
    assert.equal(db.calls.setInitialScanComplete, 1, 'a new start can complete the scan');
  } finally { fs.rmSync(projectsDir, { recursive: true, force: true }); }
});

test('a successful failed-folder retry completes the initial scan without revisiting good folders', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-retry-success-'));
  let now = 0, fail = true;
  const attempts = [];
  try {
    writeSession(projectsDir, 'good');
    writeSession(projectsDir, 'bad');
    const db = makeFakeDb({ initialScanComplete: false });
    initCache(projectsDir, db, { now: () => now, writer: {
      writeScannedFolder(result) {
        const name = path.basename(result.projectPath);
        attempts.push(name);
        if (name === 'bad' && fail) throw new Error('transient write failure');
        return result.sessions.length;
      },
      setInitialScanComplete: db.setInitialScanComplete,
    } });
    await sessionCache.populateCacheViaWorker();
    fail = false;
    now = 30000;
    await sessionCache.populateCacheViaWorker();
    assert.equal(db.calls.setInitialScanComplete, 1);
    assert.equal(attempts.filter(name => name === 'good').length, 1);
    assert.equal(attempts.filter(name => name === 'bad').length, 2);
  } finally { fs.rmSync(projectsDir, { recursive: true, force: true }); }
});

test('a folder read failure reports its name and still scans the other folders', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-read-failure-'));
  try {
    writeSession(projectsDir, 'bad');
    writeSession(projectsDir, 'good');
    const badFolder = encodeProjectPath(path.join(projectsDir, 'bad'));
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      const state = require(workerData.statePath);
      const read = state.getFolderIndexMtimeMs;
      state.getFolderIndexMtimeMs = dir => {
        if (require('node:path').basename(dir) === workerData.badFolder) throw new Error('injected folder read failure');
        return read(dir);
      };
      require(workerData.scanPath);
    `, { eval: true, workerData: { projectsDir, badFolder,
      statePath: path.resolve(__dirname, '../folder-index-state.js'),
      scanPath: path.resolve(__dirname, '../workers/scan-projects.js'),
    } });
    const messages = [];
    await new Promise((resolve, reject) => {
      worker.on('message', message => messages.push(message));
      worker.on('error', reject);
      worker.on('exit', code => code === 0 ? resolve() : reject(new Error('worker exit ' + code)));
    });
    assert.equal(messages.filter(message => message.result?.projectPath === path.join(projectsDir, 'good')).length, 1);
    assert.deepEqual(messages.at(-1).failedFolders, [badFolder]);
    assert.equal(messages.at(-1).ok, false);
  } finally { fs.rmSync(projectsDir, { recursive: true, force: true }); }
});

test('populateCacheViaWorker writes each folder to the DB as it streams in (not batched at the end)', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cold-'));
  try {
    writeSession(projectsDir, 'proj-a');
    writeSession(projectsDir, 'proj-b');
    writeSession(projectsDir, 'proj-c');

    const db = makeFakeDb({ initialScanComplete: false });
    initCache(projectsDir, db);

    await sessionCache.populateCacheViaWorker();

    assert.equal(db.calls.upsertCachedSessions.length, 3,
      'one upsertCachedSessions call per folder, proving progressive per-folder writes rather than one final batch');
    assert.equal(db.calls.setFolderMeta.length, 3);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('cold start (empty cache) emits indexing-progress events ending in done:true, with increasing counters', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cold-2-'));
  try {
    writeSession(projectsDir, 'proj-a');
    writeSession(projectsDir, 'proj-b');

    const db = makeFakeDb({ initialScanComplete: false });
    initCache(projectsDir, db);

    await sessionCache.populateCacheViaWorker();

    const progressEvents = db.sentEvents
      .filter(([channel]) => channel === 'indexing-progress')
      .map(([, payload]) => payload);

    assert.ok(progressEvents.length >= 2, 'expected at least one progress event per folder plus a final done event');
    for (const p of progressEvents) {
      assert.equal(p.coldStart, true);
      assert.equal(p.total, 2);
    }
    const last = progressEvents[progressEvents.length - 1];
    assert.equal(last.done, true, 'the final indexing-progress event must report done:true');
    assert.equal(last.sessionsSoFar, 2, 'both sessions must be counted by the time indexing finishes');

    // current/sessionsSoFar must never regress across the stream.
    let prevCurrent = 0, prevSessions = 0;
    for (const p of progressEvents) {
      assert.ok(p.current >= prevCurrent, 'current must be monotonically non-decreasing');
      assert.ok(p.sessionsSoFar >= prevSessions, 'sessionsSoFar must be monotonically non-decreasing');
      prevCurrent = p.current;
      prevSessions = p.sessionsSoFar;
    }
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('the completeness marker is written exactly once, on the successful done message', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-marker-'));
  try {
    writeSession(projectsDir, 'proj-a');

    const db = makeFakeDb({ initialScanComplete: false });
    initCache(projectsDir, db);

    await sessionCache.populateCacheViaWorker();

    assert.equal(db.calls.setInitialScanComplete, 1,
      'setInitialScanComplete must run when (and only when) the worker reports done ok -- ' +
      'it is what lets the next launch take the warm-start branch');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('a resumed interrupted scan (marker absent, cache already has rows) still emits the banner events and re-marks completion', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-resume-'));
  try {
    writeSession(projectsDir, 'proj-a');

    // Note the fake db deliberately exposes NO row-count primitive: the
    // cold/warm decision must be a pure function of the marker. Before the
    // marker existed, coldStart was keyed on isCachePopulated(), so a resume
    // after interruption (partial cache -> rows present) silently lost its
    // banner even though the heavy first scan was still running.
    const db = makeFakeDb({ initialScanComplete: false });
    initCache(projectsDir, db);

    await sessionCache.populateCacheViaWorker();

    const progressEvents = db.sentEvents.filter(([channel]) => channel === 'indexing-progress');
    assert.ok(progressEvents.length >= 2,
      'a resumed initial scan must keep reporting progress to the banner');
    assert.equal(db.calls.setInitialScanComplete, 1,
      'completing the resumed scan must persist the marker');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('indexing-progress is throttled: intermediate folder events are dropped, first and final done events always pass', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-throttle-'));
  const realNow = Date.now;
  try {
    for (const name of ['proj-a', 'proj-b', 'proj-c', 'proj-d', 'proj-e']) {
      writeSession(projectsDir, name);
    }

    const db = makeFakeDb({ initialScanComplete: false });
    initCache(projectsDir, db);

    // Freeze main-thread time: every per-folder event lands "at the same
    // millisecond", so the ~4/s throttle must drop ALL of them except the
    // very first (nothing sent yet) and the final done (always exempt).
    // Without the throttle this run would emit 6 events; with it, exactly 2.
    Date.now = () => 1_000_000;
    await sessionCache.populateCacheViaWorker();

    const progressEvents = db.sentEvents
      .filter(([channel]) => channel === 'indexing-progress')
      .map(([, payload]) => payload);

    assert.equal(progressEvents.length, 2,
      'expected exactly the guaranteed pair (first event + final done) when all folder events fall inside one throttle window');
    assert.equal(progressEvents[0].done, false, 'the first folder event must never be throttled away');
    assert.equal(progressEvents[0].current, 1);
    const last = progressEvents[progressEvents.length - 1];
    assert.equal(last.done, true, 'the final done event must never be throttled away');
    assert.equal(last.current, 5, 'the done event must carry the final counters');
  } finally {
    Date.now = realNow;
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('warm start (initial scan already completed) never emits indexing-progress', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-warm-'));
  try {
    writeSession(projectsDir, 'proj-a');

    const db = makeFakeDb({ initialScanComplete: true });
    initCache(projectsDir, db);

    await sessionCache.populateCacheViaWorker();

    const progressEvents = db.sentEvents.filter(([channel]) => channel === 'indexing-progress');
    assert.equal(progressEvents.length, 0, 'a warm-start rebuild must never trigger the first-run banner');

    const finished = db.sentEvents.filter(([channel]) => channel === 'indexing-finished');
    assert.equal(finished.length, 1, 'the restore planner needs the end of a warm-start scan too');
    assert.equal(sessionCache.isIndexingFinished(), true, 'a listener that came late can pull the state');

    // The existing small-status-bar mechanism is untouched by this change.
    const statusEvents = db.sentEvents.filter(([channel]) => channel === 'status-update');
    assert.ok(statusEvents.length > 0, 'status-update should still fire for the small activity indicator');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('cold start also sends indexing-finished, once, after the last progress event', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cold-fin-'));
  try {
    writeSession(projectsDir, 'proj-a');
    const db = makeFakeDb({ initialScanComplete: false });
    initCache(projectsDir, db);
    const run = sessionCache.populateCacheViaWorker();
    assert.equal(sessionCache.isIndexingFinished(), false, 'a run in flight is not finished');
    await run;
    assert.equal(sessionCache.isIndexingFinished(), true);
    const channels = db.sentEvents.map(([channel]) => channel);
    assert.equal(channels.filter((c) => c === 'indexing-finished').length, 1);
    assert.equal(channels.lastIndexOf('indexing-progress') < channels.indexOf('indexing-finished'), true);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
