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
    if (!rowsByFolder.has(folder)) rowsByFolder.set(folder, []);
    return { projectPath, folder, commands };
  };
  const addFolder = dirPath => {
    const folder = encodeProjectPath(dirPath);
    fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
    if (!rowsByFolder.has(folder)) rowsByFolder.set(folder, []);
    return { projectPath: dirPath, folder };
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
      listSchedules: (projectPaths, options) => listScheduleFiles(projectPaths, { home: home.home, platform: 'linux', ...options }),
      getCachedByFolder: async folder => rowsByFolder.get(folder) || [],
      isIndexReady: () => true,
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
  return { home, root, projectsDir, dataDir, addProject, addFolder, writeSession, make, list, progress, reads, rowsByFolder, projects };
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
  assert.equal(store.v, 2);
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
  assert.deepEqual(listing.history, { state: 'done', unattributed: 6 },
    'look-alikes that fail the seed check and a valid seed of a schedule that no longer exists are counted as gaps');
});

test('the import is idempotent: a finished import reads nothing and a fresh rerun stores the same runs', async t => {
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
  assert.deepEqual(f.reads, [], 'with every project stored as final nothing is read again');
  assert.equal(again.status().state, 'done');
  assert.deepEqual([...again.importedRuns().keys()], [id]);

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
  assert.deepEqual([...broken.importedRuns().keys()], [ida], 'the finished project is kept');
  f.reads.length = 0;

  const resumed = f.make();
  resumed.ensureStarted();
  await resumed.whenIdle();
  assert.deepEqual(f.reads, [idb], 'the finished project is not read again');
  assert.equal(resumed.status().state, 'done');
  assert.deepEqual([...resumed.importedRuns().keys()].sort(), [ida, idb].sort());
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

test('a failed store publication leaves its project to the retry and the pass stays failed (R1)', async t => {
  const f = fixture(t);
  const a = f.addProject('a', { journal: '' });
  const b = f.addProject('b', { journal: '' });
  const ida = f.writeSession(a, [seedV025(crypto.randomUUID(), { cwd: a.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const idb = f.writeSession(b, [seedV025(crypto.randomUUID(), { cwd: b.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-03T07:00:00.000Z' })]);
  const { storeFileOf } = require('../src/main/schedules/schedule-history-import');
  const file = storeFileOf(f.dataDir);
  const rename = fs.renameSync;
  let publications = 0;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file && ++publications === 2) throw Object.assign(new Error('injected EIO publishing the second project'), { code: 'EIO' });
    return rename(from, to);
  });
  let clock = 0;
  const importer = f.make({ now: () => clock });
  importer.ensureStarted();
  await importer.whenIdle();
  assert.equal(importer.status().state, 'failed');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).projects), [a.projectPath]);
  assert.deepEqual([...importer.importedRuns().keys()], [ida], 'an unpublished project is not committed in memory');
  mocked.mock.restore();
  clock += 10 * 60 * 1000;
  importer.ensureStarted();
  await importer.whenIdle();
  assert.equal(importer.status().state, 'done');
  const restarted = f.make();
  restarted.ensureStarted();
  await restarted.whenIdle();
  assert.deepEqual([...restarted.importedRuns().keys()].sort(), [ida, idb].sort(), 'both projects survive a restart');
});

for (const [name, inject] of [
  ['its .claude/commands folder', (t, p) => {
    const readdir = fs.readdirSync;
    return t.mock.method(fs, 'readdirSync', (dir, ...args) => {
      if (path.resolve(String(dir)) === path.resolve(p.commands)) throw Object.assign(new Error('injected EACCES reading schedules'), { code: 'EACCES' });
      return readdir(dir, ...args);
    });
  }],
  ['one of its schedule files', (t, p) => {
    const readFile = fs.readFileSync;
    return t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (path.resolve(String(file)) === path.join(p.commands, 'schedule-journal.md')) throw Object.assign(new Error('injected EACCES reading a schedule'), { code: 'EACCES' });
      return readFile(file, ...args);
    });
  }],
]) {
  test(`a project whose ${name} cannot be read stays retryable instead of being stored as empty (R2)`, async t => {
    const f = fixture(t);
    const p = f.addProject('notes', { journal: '' });
    const id = f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
    const mocked = inject(t, p);
    const first = f.make();
    first.ensureStarted();
    await first.whenIdle();
    assert.equal(first.status().state, 'failed');
    assert.match(first.status().error, /EACCES/);
    mocked.mock.restore();
    const recovered = f.make();
    recovered.ensureStarted();
    await recovered.whenIdle();
    assert.equal(recovered.status().state, 'done');
    const runs = schedulesOf(await f.list(recovered), 'journal').runs;
    assert.deepEqual(runs.map(run => run.sessionId), [id]);
  });
}

test('a seed belongs to the project its cwd names, not to another path with the same encoded folder (R3)', async t => {
  const f = fixture(t);
  const owner = f.addProject('project-a', { journal: '' });
  const other = f.addProject(path.join('project', 'a'), { journal: '' });
  assert.notEqual(owner.projectPath, other.projectPath);
  assert.equal(owner.folder, other.folder, 'the two paths share one transcript folder');
  const id = f.writeSession(owner, [seedV025(crypto.randomUUID(), { cwd: owner.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const historyImport = f.make();
  historyImport.ensureStarted();
  await historyImport.whenIdle();
  assert.equal(historyImport.importedRuns().get(id).projectPath, owner.projectPath);
  const listing = await f.list(historyImport);
  const runsOf = projectPath => listing.projects.find(project => project.projectPath === projectPath).schedules[0].runs.map(run => run.sessionId);
  assert.deepEqual(runsOf(owner.projectPath), [id]);
  assert.deepEqual(runsOf(other.projectPath), [], 'the colliding project does not list it');
  assert.equal(listing.history.unattributed, 0, 'a valid seed of another project is not a gap');
});

test('a failed import is not restarted by the reload its own notification causes (R4)', async t => {
  const f = fixture(t);
  const { JSDOM } = require('jsdom');
  const vm = require('node:vm');
  const dom = new JSDOM('<div id="schedules-content"></div>', { runScripts: 'outside-only' });
  const w = dom.window;
  t.after(() => { w.setSchedulesVisible(false); w.close(); });
  let notify;
  let attempts = 0;
  let clock = 0;
  const importer = f.make({
    now: () => clock,
    scheduleProjects: () => ({ list: async () => { attempts++; throw Object.assign(new Error('persistent EIO in registry'), { code: 'EIO' }); } }),
    onSettled: () => notify(),
  });
  w.SETTING_DEFAULTS = { schedulesTab: true };
  w.api = {
    onScheduleHistoryImported: callback => { notify = callback; },
    listSchedules: async () => {
      importer.ensureStarted();
      await importer.whenIdle();
      return { projects: [], history: importer.status() };
    },
  };
  w.clearAppNotice = () => {};
  w.showAppNotice = () => {};
  const filename = path.join(__dirname, '../public/schedules-view.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  w.renderSchedules = () => {};
  w.Date.now = () => 30000;
  w.setSchedulesVisible(true);
  await new Promise(resolve => setTimeout(resolve, 2150));
  assert.equal(importer.status().state, 'failed');
  assert.equal(attempts, 1, 'one opening runs the failed import once');
  const { RETRY_MS } = require('../src/main/schedules/schedule-history-import');
  clock += RETRY_MS;
  importer.ensureStarted();
  await importer.whenIdle();
  assert.equal(attempts, 2, 'the import is retried once the back-off has passed');
});

async function pass(f, extra) {
  const historyImport = f.make(extra);
  historyImport.ensureStarted();
  await historyImport.whenIdle();
  return historyImport;
}

function storedProjects(f) {
  return JSON.parse(fs.readFileSync(path.join(f.dataDir, 'schedule-history', 'imported.json'), 'utf8')).projects;
}

test('a project unreachable at the first pass is imported at the next launch once its folder is back (#1262)', async t => {
  const f = fixture(t);
  const p = f.addProject('bravo', { nightly: '' });
  const id = f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'nightly', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const parked = path.join(f.home.home, 'parked');
  fs.renameSync(p.projectPath, parked);
  const first = await pass(f);
  assert.equal(first.status().state, 'done');
  assert.equal(first.importedRuns().size, 0);
  assert.deepEqual(f.reads, [], 'no seed is judged against the schedules of a project that cannot be read');
  fs.renameSync(parked, p.projectPath);
  const next = await pass(f);
  assert.deepEqual([...next.importedRuns().keys()], [id], 'the next launch reads the project again');
  assert.deepEqual(schedulesOf(await f.list(next), 'nightly').runs.map(run => run.sessionId), [id]);
});

test('a project with no candidate row at all is read again at the next launch, and a found run is final (#1262)', async t => {
  const f = fixture(t);
  const p = f.addProject('notes', { journal: '' });
  const id = f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const indexed = f.rowsByFolder.get(p.folder).splice(0);
  const first = await pass(f);
  assert.equal(first.importedRuns().size, 0);
  f.rowsByFolder.get(p.folder).push(...indexed);
  const second = await pass(f);
  assert.deepEqual([...second.importedRuns().keys()], [id]);
  f.reads.length = 0;
  const third = await pass(f);
  assert.deepEqual(f.reads, [], 'a project whose run was found is not read again');
  assert.deepEqual([...third.importedRuns().keys()], [id]);
});

test('runs of a renamed schedule are counted, and imported once a schedule of that slug exists again (#1262)', async t => {
  const f = fixture(t);
  const p = f.addProject('notes', { 'new-name': '' });
  const id = f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'old-name', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const first = await pass(f);
  assert.equal(first.importedRuns().size, 0);
  assert.deepEqual(first.status(), { state: 'done', unattributed: 1 }, 'the dropped run shows in the gap note');
  fs.renameSync(path.join(p.commands, 'schedule-new-name.md'), path.join(p.commands, 'schedule-old-name.md'));
  const next = await pass(f);
  assert.deepEqual([...next.importedRuns().keys()], [id]);
  assert.deepEqual(next.status(), { state: 'done', unattributed: 0 });
});

test('a project registered after the import finished is imported without a new launch, and nothing loops (#1262)', async t => {
  const f = fixture(t);
  const a = f.addProject('alpha', { daily: '' });
  const ida = f.writeSession(a, [seedV025(crypto.randomUUID(), { cwd: a.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  let settled = 0;
  const historyImport = await pass(f, { onSettled: () => { settled++; } });
  assert.equal(historyImport.status().state, 'done');
  assert.equal(settled, 1);
  const d = f.addProject('delta', { daily: '' });
  const idd = f.writeSession(d, [seedV025(crypto.randomUUID(), { cwd: d.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-03T07:00:00.000Z' })]);
  historyImport.ensureStarted();
  await historyImport.whenIdle();
  assert.deepEqual([...historyImport.importedRuns().keys()].sort(), [ida, idd].sort());
  assert.ok(Object.hasOwn(storedProjects(f), d.projectPath));
  const notified = settled;
  f.reads.length = 0;
  f.progress.length = 0;
  for (let i = 0; i < 3; i++) {
    historyImport.ensureStarted();
    await historyImport.whenIdle();
  }
  assert.deepEqual(f.reads, [], 'later listings read nothing');
  assert.deepEqual(f.progress, []);
  assert.equal(settled, notified, 'a pass with nothing to do does not reload the tab');
  assert.equal(historyImport.status().state, 'done');
});

test('a store written by a 0.1.0 beta is read again: missed runs are added, imported ones are kept once (#1262)', async t => {
  const f = fixture(t);
  const a = f.addProject('alpha', { daily: '' });
  const b = f.addProject('bravo', { nightly: '' });
  const ida = f.writeSession(a, [seedV025(crypto.randomUUID(), { cwd: a.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const idb = f.writeSession(b, [seedV025(crypto.randomUUID(), { cwd: b.projectPath, slug: 'nightly', prompt: 'Write', timestamp: '2026-05-03T07:00:00.000Z' })]);
  const file = path.join(f.dataDir, 'schedule-history', 'imported.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, projects: {
    [a.projectPath]: { runs: { [ida]: { slug: 'daily', folder: a.folder, created: '2026-05-02T07:00:00.000Z', dueMs: null } }, unattributed: 0 },
    [b.projectPath]: { runs: {}, unattributed: 0 },
  } }) + '\n');
  let settled = 0;
  const historyImport = await pass(f, { onSettled: () => { settled++; } });
  assert.equal(historyImport.status().state, 'done');
  assert.deepEqual([...historyImport.importedRuns().keys()].sort(), [ida, idb].sort());
  assert.ok(settled >= 1, 'the tab reloads to show the added runs');
  const listing = await f.list(historyImport);
  assert.deepEqual(schedulesOf(listing, 'daily').runs.map(run => run.sessionId), [ida], 'the run imported by the beta is listed once');
  assert.deepEqual(schedulesOf(listing, 'nightly').runs.map(run => run.sessionId), [idb]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2);
});

test('a store present at launch keeps the note quiet while it is read again (#1262)', async t => {
  const f = fixture(t);
  const p = f.addProject('notes', { journal: '' });
  f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const file = path.join(f.dataDir, 'schedule-history', 'imported.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, projects: { [p.projectPath]: { runs: {}, unattributed: 0 } } }) + '\n');
  let ready = false;
  const { readSeedLine } = require('../src/main/schedules/schedule-history-import');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const historyImport = f.make({ isIndexReady: () => ready, readHead: async file => { await gate; return readSeedLine(file); } });
  historyImport.ensureStarted();
  assert.equal(historyImport.status().state, 'done', 'no import note while the index is still scanned');
  ready = true;
  historyImport.ensureStarted();
  assert.equal(historyImport.status().state, 'done', 'no import note while a stored project is read again');
  release();
  await historyImport.whenIdle();
  assert.equal(historyImport.importedRuns().size, 1);
});

test('a run started from a worktree of the project is imported and listed; neighbours are not claimed (#1262)', async t => {
  const f = fixture(t);
  const a = f.addProject('alpha', { daily: '' });
  const sub = f.addProject(path.join('alpha', 'sub'), { daily: '' });
  const wt = f.addFolder(path.join(a.projectPath, '.work-files', 'worktrees', 'wt1'));
  fs.mkdirSync(wt.projectPath, { recursive: true });
  const idwt = f.writeSession(wt, [seedV025(crypto.randomUUID(), { cwd: wt.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const subWt = f.addFolder(path.join(sub.projectPath, '.claude', 'worktrees', 'x'));
  fs.mkdirSync(subWt.projectPath, { recursive: true });
  const idsub = f.writeSession(subWt, [seedV025(crypto.randomUUID(), { cwd: subWt.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-03T07:00:00.000Z' })]);
  const sibling = f.addFolder(path.join(f.root, 'alpha-beta'));
  fs.mkdirSync(sibling.projectPath, { recursive: true });
  const idsib = f.writeSession(sibling, [seedV025(crypto.randomUUID(), { cwd: sibling.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-04T07:00:00.000Z' })]);
  const forged = f.addFolder(path.join(a.projectPath, '.work-files', 'worktrees', 'wt2'));
  f.writeSession(forged, handStarted(crypto.randomUUID(), { cwd: forged.projectPath, slug: 'daily', content: 'Scheduled Task: Write', timestamp: '2026-05-05T07:00:00.000Z' }));
  const historyImport = await pass(f);
  const runs = historyImport.importedRuns();
  assert.equal(runs.get(idwt)?.projectPath, a.projectPath, 'the worktree run belongs to its project');
  assert.equal(runs.get(idsub)?.projectPath, sub.projectPath, 'a nested registry project keeps the runs of its own worktrees');
  assert.equal(runs.has(idsib), false, 'a folder that only shares the encoded prefix is not a worktree');
  assert.equal(runs.size, 2, 'the hand-started look-alike in a worktree is not imported');
  const listing = await f.list(historyImport);
  const runsOf = projectPath => listing.projects.find(project => project.projectPath === projectPath).schedules[0].runs.map(run => run.sessionId);
  assert.deepEqual(runsOf(a.projectPath), [idwt]);
  assert.deepEqual(runsOf(sub.projectPath), [idsub]);
  assert.equal(listing.history.unattributed, 0, 'sessions in neighbouring folders are not gaps of this project');
});

test('a registry path whose case differs from the transcript folder imports and lists its runs (#1262, win32)', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const p = f.addProject('Notes', { journal: '' });
  const id = f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const marked = crypto.randomUUID();
  f.writeSession(p, [seedV090(marked, { cwd: p.projectPath, slug: 'journal', prompt: 'Write', timestamp: '2026-10-20T07:00:00.000Z' })]);
  const lower = p.projectPath.toLowerCase();
  assert.notEqual(encodeProjectPath(lower), p.folder);
  f.projects.splice(0, f.projects.length, lower);
  const historyImport = await pass(f);
  assert.deepEqual([...historyImport.importedRuns().keys()], [id]);
  const listing = await f.list(historyImport);
  assert.deepEqual(schedulesOf(listing, 'journal').runs.map(run => run.sessionId), [marked, id]);
});

test('a worktree whose encoded folder is also a nested registry project\'s folder is still imported (#1262 r1)', async t => {
  const f = fixture(t);
  const owner = f.addProject('alpha', { daily: '' });
  const neighbour = f.addProject(path.join('alpha', 'worktrees-feature'), { daily: '' });
  const wt = f.addFolder(path.join(owner.projectPath, 'worktrees', 'feature'));
  fs.mkdirSync(wt.projectPath, { recursive: true });
  assert.equal(wt.folder, neighbour.folder, 'the worktree and the nested project share one transcript folder');
  const id = f.writeSession(wt, [seedV025(crypto.randomUUID(), { cwd: wt.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const own = f.writeSession(neighbour, [seedV025(crypto.randomUUID(), { cwd: neighbour.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-03T07:00:00.000Z' })]);
  const historyImport = await pass(f);
  assert.equal(historyImport.importedRuns().get(id)?.projectPath, owner.projectPath, 'the seed goes to the project its cwd lies in');
  assert.equal(historyImport.importedRuns().get(own)?.projectPath, neighbour.projectPath, 'the nested project keeps its own run');
  assert.equal(historyImport.status().unattributed, 0);
});

test('a run of an unregistered prefix neighbour does not make a project final (#1262 r1)', async t => {
  const f = fixture(t);
  const owner = f.addProject('alpha', { daily: '' });
  const sibling = f.addFolder(path.join(f.root, 'alpha-beta'));
  fs.mkdirSync(sibling.projectPath, { recursive: true });
  f.writeSession(sibling, [seedV025(crypto.randomUUID(), { cwd: sibling.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  const first = await pass(f);
  assert.equal(first.importedRuns().size, 0);
  const id = f.writeSession(owner, [seedV025(crypto.randomUUID(), { cwd: owner.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-03T07:00:00.000Z' })]);
  const next = await pass(f);
  assert.deepEqual([...next.importedRuns().keys()], [id], 'the project stays retryable until it owns a run');
});

test('a seed judged once is not read again at later launches (#1262 r1)', async t => {
  const f = fixture(t);
  const p = f.addProject('alpha', { daily: '' });
  const orphan = f.writeSession(p, [seedV025(crypto.randomUUID(), { cwd: p.projectPath, slug: 'deleted', prompt: 'Write', timestamp: '2026-05-02T07:00:00.000Z' })]);
  f.writeSession(p, handStarted(crypto.randomUUID(), { cwd: p.projectPath, slug: 'daily', content: 'Scheduled Task: Write', timestamp: '2026-05-03T07:00:00.000Z' }));
  const sibling = f.addFolder(path.join(f.root, 'alpha-beta'));
  fs.mkdirSync(sibling.projectPath, { recursive: true });
  f.writeSession(sibling, [seedV025(crypto.randomUUID(), { cwd: sibling.projectPath, slug: 'daily', prompt: 'Write', timestamp: '2026-05-04T07:00:00.000Z' })]);
  const first = await pass(f);
  assert.equal(f.reads.length, 3);
  assert.deepEqual(first.status(), { state: 'done', unattributed: 2 });
  f.reads.length = 0;
  const second = await pass(f);
  assert.deepEqual(f.reads, [], 'the next launch reuses the verdicts instead of reading the heads again');
  assert.deepEqual(second.status(), { state: 'done', unattributed: 2 });
  fs.writeFileSync(path.join(p.commands, 'schedule-deleted.md'), '---\ncron: 0 7 * * *\n---\nWrite');
  const third = await pass(f);
  assert.deepEqual(f.reads, []);
  assert.deepEqual([...third.importedRuns().keys()], [orphan], 'a stored orphan is imported once its schedule exists again');
  assert.deepEqual(third.status(), { state: 'done', unattributed: 1 });
});
