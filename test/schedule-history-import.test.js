'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isolatedHome } = require('./fixtures/isolated-home.cjs');
const { encodeProjectPath } = require('../encode-project-path');
const { readSessionDisplayHeader } = require('../read-session-file');

const CLI_VERSION = '2.0.14';

function seedV025(sessionId, { cwd, slug, prompt, timestamp }) {
  return { type: 'user', parentUuid: null, uuid: crypto.randomUUID(), sessionId, cwd, slug, timestamp,
    message: { role: 'user', content: 'Scheduled Task: ' + prompt } };
}

function seedV087CatchUp(sessionId, { cwd, slug, prompt, timestamp, dueMs }) {
  return { type: 'user', parentUuid: null, uuid: crypto.randomUUID(), sessionId, cwd, slug, timestamp,
    message: { role: 'user', content: `Scheduled Task (catch-up: due ${new Date(dueMs).toISOString()}, started ${timestamp}): ` + prompt } };
}

function seedV090(sessionId, fields) {
  const seed = seedV025(sessionId, fields);
  return { type: seed.type, parentUuid: null, uuid: seed.uuid, sessionId, cwd: seed.cwd, slug: seed.slug, scheduleSlug: seed.slug,
    timestamp: seed.timestamp, message: seed.message };
}

function cliResume(sessionId, { cwd, timestamp, parentUuid }) {
  const uuid = crypto.randomUUID();
  return [
    { parentUuid, isSidechain: false, userType: 'external', cwd, sessionId, version: CLI_VERSION, gitBranch: 'main',
      entrypoint: 'sdk-cli', type: 'user', message: { role: 'user', content: 'Run the scheduled task' }, uuid, timestamp },
    { parentUuid: uuid, isSidechain: false, userType: 'external', cwd, sessionId, version: CLI_VERSION, gitBranch: 'main',
      entrypoint: 'sdk-cli', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      uuid: crypto.randomUUID(), timestamp },
  ];
}

function handStarted(sessionId, { cwd, slug, content, timestamp }) {
  return [
    { type: 'permission-mode', permissionMode: 'default', sessionId },
    { parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId, version: CLI_VERSION, gitBranch: 'main',
      entrypoint: 'cli', slug, type: 'user', message: { role: 'user', content }, uuid: crypto.randomUUID(), timestamp },
    { parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId, version: CLI_VERSION, gitBranch: 'main',
      entrypoint: 'cli', slug, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Ok.' }] },
      uuid: crypto.randomUUID(), timestamp },
  ];
}

function fixture(t) {
  const home = isolatedHome(t, { projects: () => [] });
  home.install();
  const root = path.join(home.home, 'work');
  const projectsDir = path.join(home.home, 'transcripts');
  const dataDir = path.join(home.home, 'data');
  fs.mkdirSync(projectsDir, { recursive: true });
  const projects = [];
  const rowsByFolder = new Map();
  const addProject = (name, schedules = {}) => {
    const projectPath = path.join(root, name);
    const commands = path.join(projectPath, '.claude', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    for (const [slug, front] of Object.entries(schedules)) {
      fs.writeFileSync(path.join(commands, `schedule-${slug}.md`), `---\n${front || 'cron: 0 7 * * *'}\n---\nWrite the notes`);
    }
    projects.push(projectPath);
    const folder = encodeProjectPath(projectPath);
    fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
    rowsByFolder.set(folder, []);
    return { projectPath, folder };
  };
  const writeSession = (project, records, { sessionId = records.find(r => r.sessionId)?.sessionId, index = true } = {}) => {
    const file = path.join(projectsDir, project.folder, `${sessionId}.jsonl`);
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    if (index) {
      const header = readSessionDisplayHeader(file);
      assert.ok(header, 'the fixture transcript is indexable');
      const created = records.find(r => r.timestamp)?.timestamp;
      rowsByFolder.get(project.folder).push({ sessionId, folder: project.folder, projectPath: project.projectPath, created,
        messageCount: records.filter(r => r.type === 'user' || r.type === 'assistant').length,
        firstPrompt: header.firstPrompt, summary: header.summary, slug: header.slug, scheduleSlug: header.scheduleSlug || null, parentSessionId: null });
    }
    return sessionId;
  };
  const settings = {};
  const marks = [];
  const progress = [];
  const reads = [];
  const make = (extra = {}) => {
    delete require.cache[require.resolve('../src/main/schedules/schedule-history-import')];
    const { createScheduleHistoryImport } = require('../src/main/schedules/schedule-history-import');
    const { listScheduleFiles } = require('../src/main/schedules/schedule-runner');
    const { readSeedLine } = require('../src/main/schedules/schedule-history-import');
    return createScheduleHistoryImport({
      dataDir, projectsDir,
      scheduleProjects: () => ({ list: async () => [...projects] }),
      listSchedules: projectPaths => listScheduleFiles(projectPaths, { home: home.home, platform: 'linux' }),
      getCachedByFolder: async folder => rowsByFolder.get(folder) || [],
      isIndexReady: () => true,
      isMarked: () => settings.scheduleHistoryImported === true,
      mark: async () => { marks.push(Date.now()); settings.scheduleHistoryImported = true; },
      onProgress: projectPath => progress.push(projectPath),
      readHead: async file => { reads.push(path.basename(file, '.jsonl')); return readSeedLine(file); },
      log: { info() {}, warn() {} },
      ...extra,
    });
  };
  const list = async (historyImport, extra = {}) => {
    const { buildScheduleList } = require('../src/main/schedules/schedule-list');
    return buildScheduleList({ home: home.home, platform: 'linux', getSetting: () => ({}), defaultSandbox: false,
      stateDir: path.join(dataDir, 'state'), projectsDir, runsDir: path.join(dataDir, 'schedule-runs'),
      scheduleProjects: () => ({ list: async () => [...projects] }), getCachedByFolder: async folder => rowsByFolder.get(folder) || [],
      isScheduleRunLive: () => false, isArchived: () => false, isKnownProject: () => true, catchUpActive: false,
      historyImport, now: () => Date.parse('2026-11-24T12:00Z'), ...extra });
  };
  return { home, root, projectsDir, dataDir, addProject, writeSession, make, list, settings, marks, progress, reads, rowsByFolder };
}

function schedulesOf(listing, slug) {
  return listing.projects.flatMap(project => project.schedules).find(schedule => schedule.slug === slug);
}

test('imports runs of each pre-v0.0.90 era from the seed shape and lists them as imported with no result', async t => {
  const f = fixture(t);
  const p = f.addProject('notes', { journal: 'cron: 0 7 * * *\ncatch-up: true' });
  const v025 = crypto.randomUUID();
  const seed = seedV025(v025, { cwd: p.projectPath, slug: 'journal', prompt: 'Write the notes', timestamp: '2026-05-02T07:00:01.120Z' });
  f.writeSession(p, [seed, ...cliResume(v025, { cwd: p.projectPath, timestamp: '2026-05-02T07:00:03.000Z', parentUuid: seed.uuid })]);
  const v087 = crypto.randomUUID();
  const dueMs = Date.parse('2026-10-01T07:00:00.000Z');
  const catchUp = seedV087CatchUp(v087, { cwd: p.projectPath, slug: 'journal', prompt: 'Old prompt text', timestamp: '2026-10-01T09:12:44.501Z', dueMs });
  f.writeSession(p, [catchUp]);
  const v090 = crypto.randomUUID();
  const marked = seedV090(v090, { cwd: p.projectPath, slug: 'journal', prompt: 'Write the notes', timestamp: '2026-10-20T07:00:00.900Z' });
  f.writeSession(p, [marked, ...cliResume(v090, { cwd: p.projectPath, timestamp: '2026-10-20T07:00:02.000Z', parentUuid: marked.uuid })]);

  const before = schedulesOf(await f.list(null), 'journal');
  assert.deepEqual(before.runs.map(run => run.sessionId), [v090], 'without the import only the marked run is listed');

  const historyImport = f.make();
  historyImport.ensureStarted();
  await historyImport.whenIdle();
  assert.equal(historyImport.status().state, 'done');
  assert.equal(f.marks.length, 1, 'the marker is written once the registry is imported');
  assert.deepEqual(f.reads.sort(), [v025, v087].sort(), 'only unmarked candidates have their head read');

  const listing = await f.list(historyImport);
  const runs = schedulesOf(listing, 'journal').runs;
  assert.deepEqual(runs.map(run => run.sessionId), [v090, v087, v025], 'imported runs join the marked one, newest first');
  assert.equal(runs[0].imported, undefined, 'a marked run is not reported as imported');
  for (const run of runs.slice(1)) {
    assert.equal(run.imported, true);
    assert.equal(run.result, null, 'no result is fabricated for an imported run');
  }
  assert.equal(runs.find(run => run.sessionId === v087).dueMs, dueMs, 'a catch-up run keeps the minute it was due');
  assert.equal(runs.find(run => run.sessionId === v025).replied, true);
  assert.deepEqual(listing.history, { state: 'done', unattributed: 0 });
  const store = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'schedule-history', 'imported.json'), 'utf8'));
  assert.equal(store.v, 1);
  assert.deepEqual(Object.keys(store.projects), [p.projectPath]);
});

test('a hand-started session titled like a scheduled run is never imported', async t => {
  const f = fixture(t);
  const p = f.addProject('notes', { journal: '' });
  const other = f.addProject('other', {});
  const typed = crypto.randomUUID();
  f.writeSession(p, handStarted(typed, { cwd: p.projectPath, slug: 'journal', content: 'Scheduled Task: Write the notes', timestamp: '2026-06-01T07:00:00.000Z' }));
  const extraKey = crypto.randomUUID();
  f.writeSession(p, [{ ...seedV025(extraKey, { cwd: p.projectPath, slug: 'journal', prompt: 'Write the notes', timestamp: '2026-06-02T07:00:00.000Z' }), version: CLI_VERSION }]);
  const wrongId = crypto.randomUUID();
  f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'journal', prompt: 'Write the notes', timestamp: '2026-06-03T07:00:00.000Z' })], { sessionId: wrongId });
  const elsewhere = crypto.randomUUID();
  f.writeSession(p, [seedV025(elsewhere, { cwd: other.projectPath, slug: 'journal', prompt: 'Write the notes', timestamp: '2026-06-04T07:00:00.000Z' })]);
  const badCatchUp = crypto.randomUUID();
  const forged = seedV087CatchUp(badCatchUp, { cwd: p.projectPath, slug: 'journal', prompt: 'x', timestamp: '2026-06-05T07:00:00.000Z', dueMs: Date.parse('2026-06-05T06:00:00.000Z') });
  forged.message.content = forged.message.content.replace('started 2026-06-05T07:00:00.000Z', 'started 2026-06-05T08:00:00.000Z');
  f.writeSession(p, [forged]);
  const otherSlug = crypto.randomUUID();
  f.writeSession(p, [seedV025(otherSlug, { cwd: p.projectPath, slug: 'gone', prompt: 'Write the notes', timestamp: '2026-06-06T07:00:00.000Z' })]);

  const historyImport = f.make();
  historyImport.ensureStarted();
  await historyImport.whenIdle();
  const listing = await f.list(historyImport);
  assert.deepEqual(schedulesOf(listing, 'journal').runs, [], 'none of the look-alikes is attributed');
  assert.deepEqual(listing.history, { state: 'done', unattributed: 5 },
    'look-alikes that fail the seed check are counted as gaps; a valid seed of a schedule that no longer exists is not');
});

test('the import is idempotent: a marked import reads nothing and a fresh rerun stores the same runs', async t => {
  const f = fixture(t);
  const p = f.addProject('notes', { journal: '' });
  const id = crypto.randomUUID();
  f.writeSession(p, [seedV025(id, { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:01.120Z' })]);
  const first = f.make();
  first.ensureStarted();
  await first.whenIdle();
  const storeFile = path.join(f.dataDir, 'schedule-history', 'imported.json');
  const stored = fs.readFileSync(storeFile, 'utf8');
  f.reads.length = 0;

  const again = f.make();
  again.ensureStarted();
  await again.whenIdle();
  assert.deepEqual(f.reads, [], 'with the marker and its store present nothing is read again');
  assert.equal(again.status().state, 'done');
  assert.deepEqual([...again.importedRuns().keys()], [id]);
  assert.equal(f.marks.length, 1);

  delete f.settings.scheduleHistoryImported;
  fs.rmSync(storeFile);
  const rerun = f.make();
  rerun.ensureStarted();
  await rerun.whenIdle();
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile, 'utf8')), JSON.parse(stored), 'a rerun from scratch stores the same attributions');
  const listing = await f.list(rerun);
  assert.equal(schedulesOf(listing, 'journal').runs.length, 1, 'the run is listed once');
});

test('an interrupted import resumes with the projects it had not finished', async t => {
  const f = fixture(t);
  const a = f.addProject('a', { journal: '' });
  const b = f.addProject('b', { report: '' });
  const ida = crypto.randomUUID();
  f.writeSession(a, [seedV025(ida, { cwd: a.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const idb = crypto.randomUUID();
  f.writeSession(b, [seedV025(idb, { cwd: b.projectPath, slug: 'report', prompt: 'Report', timestamp: '2026-05-03T07:00:00.000Z' })]);
  const { readSeedLine } = require('../src/main/schedules/schedule-history-import');
  const broken = f.make({ readHead: async file => {
    f.reads.push(path.basename(file, '.jsonl'));
    if (file.includes(b.folder)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return readSeedLine(file);
  } });
  broken.ensureStarted();
  await broken.whenIdle();
  assert.equal(broken.status().state, 'failed');
  assert.match(broken.status().error, /EIO/);
  assert.equal(f.marks.length, 0, 'an unfinished import does not write the marker');
  assert.deepEqual([...broken.importedRuns().keys()], [ida], 'the finished project is kept');
  f.reads.length = 0;

  const resumed = f.make();
  resumed.ensureStarted();
  await resumed.whenIdle();
  assert.deepEqual(f.reads, [idb], 'the finished project is not read again');
  assert.equal(resumed.status().state, 'done');
  assert.deepEqual([...resumed.importedRuns().keys()].sort(), [ida, idb].sort());
  assert.equal(f.marks.length, 1);
});

test('the import never blocks the listing: runs appear once a project is done', async t => {
  const f = fixture(t);
  const p = f.addProject('notes', { journal: '' });
  const id = crypto.randomUUID();
  f.writeSession(p, [seedV025(id, { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const { readSeedLine } = require('../src/main/schedules/schedule-history-import');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const historyImport = f.make({ readHead: async file => { await gate; return readSeedLine(file); } });
  const started = historyImport.ensureStarted();
  assert.equal(started, undefined, 'starting returns at once, without a promise to await');
  const pending = await f.list(historyImport);
  assert.equal(pending.history.state, 'running');
  assert.deepEqual(schedulesOf(pending, 'journal').runs, []);
  assert.deepEqual(f.progress, []);
  release();
  await historyImport.whenIdle();
  assert.deepEqual(f.progress, [p.projectPath], 'progress is announced per project');
  assert.equal(schedulesOf(await f.list(historyImport), 'journal').runs[0].sessionId, id);
});

test('the import waits for the session index before reading anything', async t => {
  const f = fixture(t);
  const p = f.addProject('notes', { journal: '' });
  f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  let ready = false;
  const historyImport = f.make({ isIndexReady: () => ready });
  historyImport.ensureStarted();
  await historyImport.whenIdle();
  assert.equal(historyImport.status().state, 'waiting');
  assert.deepEqual(f.reads, []);
  assert.equal(f.marks.length, 0);
  ready = true;
  historyImport.ensureStarted();
  await historyImport.whenIdle();
  assert.equal(historyImport.status().state, 'done');
  assert.equal(historyImport.importedRuns().size, 1);
});

test('thousands of indexed sessions: only candidates are read, with yields between them', async t => {
  const f = fixture(t);
  const p = f.addProject('busy', { journal: '' });
  const rows = f.rowsByFolder.get(p.folder);
  for (let i = 0; i < 4000; i++) {
    rows.push({ sessionId: crypto.randomUUID(), folder: p.folder, created: '2026-05-01T00:00:00.000Z', messageCount: 4,
      firstPrompt: `Review merge request ${i}`, slug: `brisk-fox-${i}`, scheduleSlug: null, parentSessionId: null });
  }
  const ids = [];
  for (let i = 0; i < 300; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    f.writeSession(p, [seedV025(id, { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: new Date(Date.parse('2026-05-01T07:00:00.000Z') + i * 86400000).toISOString() })]);
  }
  let pauses = 0;
  const historyImport = f.make({ pause: async () => { pauses++; } });
  historyImport.ensureStarted();
  await historyImport.whenIdle();
  assert.equal(f.reads.length, 300, 'sessions that are neither titled nor slugged like a schedule are never opened');
  assert.ok(pauses >= 300 / 32, `the main thread is yielded to between batches (${pauses} yields)`);
  assert.equal(historyImport.importedRuns().size, 300);
  const runs = schedulesOf(await f.list(historyImport), 'journal').runs;
  assert.equal(runs.length, 20, 'the listing keeps its 20-run cap');
  assert.equal(runs[0].sessionId, ids[299]);
});

test('the seed reader reads a bounded head and refuses a first line past its cap', async t => {
  const f = fixture(t);
  const { readSeedLine, SEED_MAX_BYTES } = require('../src/main/schedules/schedule-history-import');
  const file = path.join(f.home.home, 'huge.jsonl');
  fs.writeFileSync(file, 'x'.repeat(SEED_MAX_BYTES * 4));
  assert.equal(await readSeedLine(file), null);
  fs.writeFileSync(file, '{"a":1}\n' + 'y'.repeat(SEED_MAX_BYTES * 4));
  assert.equal(await readSeedLine(file), '{"a":1}');
  assert.ok(SEED_MAX_BYTES <= 64 * 1024);
});
