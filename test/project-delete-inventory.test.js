'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const openStore = require('./fixtures/conversation-store.cjs');
const { createProjectDeletePlanner } = require('../src/main/projects/project-delete-plan');
const { createSessionIndexWriter } = require('../session-index-writer');
const cli = require('../cli-session-state');
let inventoryModule;
try { inventoryModule = require('../src/main/projects/project-delete-inventory'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const supported = { skip: !openStore.supported && 'real SQLite requires Node 22 or matching native ABI' };
const options = { sessions: false, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: true };
const budget = () => ({ signal: new AbortController().signal, deadline: 10000, limit: 20000 });

async function setup(t, overrides = {}) {
  assert.equal(typeof inventoryModule?.createProjectDeleteInventory, 'function', 'production inventory must export the six bounded planner ports');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-'))), previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  const db = openStore(), projectsDir = path.join(root, 'transcripts'), projectPath = path.join(root, 'repo');
  const project = { alias: null, projectPath }, child = path.join(projectPath, '.work-files', 'worktrees', 'child');
  const files = new Map();
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); files.set(file, data); };
  const add = (id, folder, cwd, relative = id + '.jsonl', runtime = 'claude') => {
    const file = path.join(projectsDir, folder, relative);
    write(file, JSON.stringify(runtime === 'codex' ? { type: 'session_meta', payload: { id, cwd } } : { type: 'user', sessionId: id, cwd, message: { content: 'keep' } }) + '\n');
    db.setFolderMeta(folder, cwd, 1);
    db.upsertCachedSessions([{ sessionId: id, folder, projectPath: cwd, runtime, sessionFile: runtime === 'codex' ? file : null,
      parentSessionId: id === 'subagent:head:worker' ? 'head' : null, agentId: id === 'subagent:head:worker' ? 'worker' : null }]);
    if (runtime === 'codex') db.connection.prepare('UPDATE session_cache SET runtime=?, sessionFile=? WHERE sessionId=?').run(runtime, file, id);
  };
  add('head', 'local', projectPath); add('continuation', 'local', projectPath);
  db.setCachedContinuationIndex('head', JSON.stringify({ ids: ['continuation'] }));
  add('subagent:head:worker', 'local', projectPath, 'head/subagents/agent-worker.jsonl');
  add('codex', 'codex', projectPath, 'codex.jsonl', 'codex');
  add('child', 'child', child);
  db.setSetting('remoteHosts', [{ alias: 'one' }, { alias: 'two' }]);
  for (const alias of ['one', 'two']) {
    db.setFolderMeta(alias + '::remote', '/srv/Repo', 1);
    db.upsertCachedSessions([{ sessionId: alias, folder: alias + '::remote', projectPath: '/srv/Repo', runtime: 'claude' }]);
  }
  db.setSetting('global', { openWorkingSet: [{ sessionId: 'dormant', projectPath, runtime: 'terminal' }] });
  db.setSetting('scheduleProjects', [projectPath]); db.setInitialScanComplete();
  const schedule = path.join(projectPath, '.claude', 'commands', 'schedule-disabled.md');
  write(schedule, '---\nenabled: false\ncron: * * * * *\n---\nretained prompt');
  write(path.join(projectPath, '.claude', 'commands', 'schedule-malformed.md'), 'malformed');
  write(path.join(projectPath, '.work-files', 'keep.md'), 'keep work files');
  const worker = require('./fixtures/project-deletion-worker.cjs')(db);
  const writer = createSessionIndexWriter({ client: worker.client, readonlyBackend: db }, {}); await writer.ready;
  const deps = { writer, projectsDir, dataDir: process.env.SWITCHBOARD_DATA_DIR, activeSessions: new Map(), now: () => 0,
    getScheduleRunSnapshot: () => [], readJobs: async () => ({ complete: true, jobs: [] }),
    readLiveness: async () => ({ state: 'stopped', source: 'descriptor' }), ...overrides };
  const inventory = inventoryModule.createProjectDeleteInventory(deps);
  t.after(() => { db.closeDb(); if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, deps, inventory, writer, project, projectsDir, files, write, schedule, child };
}

test('A4c1 production planner inventory keeps child worktree, disabled files and all continuation parts without writes', supported, async t => {
  const h = await setup(t), before = h.db.changeCount();
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.plan.members.map(row => row.id).sort(), ['codex', 'continuation', 'head', 'subagent:head:worker']);
  assert.ok(result.plan.groups.some(group => group.projectPath.replaceAll('\\', '/').toLowerCase() === h.child.replaceAll('\\', '/').toLowerCase() && group.effect === 'kept'));
  assert.equal(result.plan.schedules.length, 2); assert.equal(result.plan.tabs[0].id, 'dormant');
  assert.equal(result.plan.refusals.length, 0, JSON.stringify(result.plan.refusals));
  assert.equal(h.db.changeCount(), before, 'preview never refreshes, seeds or writes');
  for (const [file, bytes] of h.files) assert.equal(fs.readFileSync(file, 'utf8'), bytes, file);
});

test('A4c1 unreadable schedule stays a candidate and prevents confirmation', supported, async t => {
  const io = Object.create(fs.promises);
  io.open = async (file, ...args) => { if (file.endsWith('schedule-disabled.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.promises.open(file, ...args); };
  const h = await setup(t, { fs: io });
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.plan.refusals.some(row => row.target === h.schedule && row.code === 'DISCOVERY_CANDIDATE'), 'unreadable schedule candidate must survive discovery');
});

test('A4c1 missing and unindexed transcripts refuse; saved active alias deduplicates but no-tab job and schedule remain', supported, async t => {
  const h = await setup(t);
  fs.unlinkSync(path.join(h.projectsDir, 'local', 'continuation.jsonl'));
  h.write(path.join(h.projectsDir, 'local', 'unknown.jsonl'), JSON.stringify({ cwd: h.project.projectPath }) + '\n');
  h.deps.activeSessions.set('dormant', { ...h.project, sessionId: 'dormant', runtime: 'terminal', generation: 1 });
  h.deps.readJobs = async () => ({ complete: true, jobs: [{ ...h.project, id: 'job', runtime: 'claude', verified: true, liveness: { state: 'running', source: 'job', targetId: 'job' } }] });
  h.deps.getScheduleRunSnapshot = () => [{ sessionId: 'scheduled', cwd: h.project.projectPath, pid: 123, startedAt: 55, scheduleName: 'headless' }];
  const result = await createProjectDeletePlanner(inventoryModule.createProjectDeleteInventory(h.deps)).preview({ projectPath: h.project.projectPath, options: { ...options, stopBackgroundJobs: false } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.plan.tabs.length, 1);
  assert.ok(result.plan.jobs.some(row => row.id === 'job')); assert.ok(result.plan.jobs.some(row => row.id === 'scheduled'));
  assert.ok(result.plan.refusals.some(row => row.code === 'BACKGROUND_CONSENT'));
  assert.ok(result.plan.refusals.some(row => row.code === 'EXTERNAL_PROCESS'));
  assert.ok(result.plan.refusals.filter(row => row.code === 'DISCOVERY_CANDIDATE').length >= 2);
});

test('A4c1 local and two remote hosts retain distinct POSIX identities; unreachable remote discovery refuses', supported, async t => {
  const h = await setup(t);
  const snapshot = await h.inventory.readSnapshot(budget());
  assert.ok(snapshot.projects.some(row => row.alias === null));
  for (const alias of ['one', 'two']) assert.ok(snapshot.projects.some(row => row.alias === alias && row.projectPath === '/srv/Repo'));
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: '/srv/Repo', folderKey: 'one::remote', options });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.plan.refusals.some(row => /remote|host/i.test(row.error)), 'unreachable host must refuse rather than omit');
});

for (const kind of ['bytes', 'deadline', 'items', 'revision']) test(`A4c1 bounded inventory refuses ${kind}`, supported, async t => {
  const h = await setup(t), b = budget();
  if (kind === 'bytes') h.deps.maxBytes = 1;
  if (kind === 'items') h.deps.maxItems = 1;
  if (kind === 'deadline') h.deps.now = () => b.deadline;
  if (kind === 'revision') {
    const read = h.writer.readProjectDeletionSnapshot;
    h.writer.readProjectDeletionSnapshot = async input => { const result = await read(input); await h.writer.setSetting('_writer_revision', result.revision + 1); return result; };
  }
  const inventory = inventoryModule.createProjectDeleteInventory(h.deps);
  await assert.rejects(inventory.readSnapshot(b), { code: kind === 'revision' ? 'SNAPSHOT_STALE' : kind === 'deadline' ? 'DISCOVERY_TIMEOUT' : 'DISCOVERY_LIMIT' });
});

test('A4c1 empty registered project without durable ownership cannot promise settings erasure', supported, async t => {
  const h = await setup(t), empty = path.join(h.root, 'empty'); fs.mkdirSync(empty);
  h.db.setSetting('scheduleProjects', [empty]); h.db.setSetting('project:' + empty, { kept: true });
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: empty, options: { ...options, settings: true } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.plan.refusals.some(row => /settings.*ownership/i.test(row.error)), 'unowned settings must refuse during preview');
});

test('A4c1 schedule snapshot is cloned and follows child release', () => {
  assert.equal(typeof cli.getScheduleRunSnapshot, 'function', 'schedule snapshot must be exported');
  const child = new EventEmitter(); child.pid = 123;
  cli.trackScheduleRun('A4C1', child, '/fixture', 'schedule');
  const rows = cli.getScheduleRunSnapshot();
  assert.equal(rows[0].sessionId, 'a4c1'); rows[0].cwd = '/mutated'; rows.length = 0;
  assert.equal(cli.getScheduleRunSnapshot()[0].cwd, '/fixture');
  child.emit('exit'); assert.deepEqual(cli.getScheduleRunSnapshot(), []);
});

test('A4c1 unknown folders and linked layout directories cannot disappear from inventory', supported, async t => {
  const h = await setup(t);
  h.write(path.join(h.projectsDir, 'unmapped', 'lost.jsonl'), JSON.stringify({ cwd: h.project.projectPath }) + '\n');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.ok(result.plan.refusals.some(row => row.target?.endsWith('lost.jsonl')), 'unmapped transcript directory must remain a refusal');
});

test('A4c1 mixed folder ownership refuses instead of certifying a selected group', supported, async t => {
  const h = await setup(t);
  h.db.upsertCachedSessions([{ sessionId: 'foreign', folder: 'local', projectPath: path.join(h.root, 'foreign') }]);
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.ok(result.plan.refusals.some(row => /mixed.*ownership/i.test(row.error)), 'mixed folder needs explicit ownership refusal');
});

test('A4c1 schedule claim and result identities remain read-only retained evidence', supported, async t => {
  const h = await setup(t);
  const key = require('../src/main/schedules/schedule-runner').scheduleStateKey({ filePath: h.schedule });
  h.write(path.join(h.deps.dataDir, 'schedule-state', key + '-123.json'), JSON.stringify({ file: h.schedule }));
  h.write(path.join(h.deps.dataDir, 'schedule-runs', key + '-123-id.json'), JSON.stringify({ file: h.schedule, sessionId: 'run' }));
  const b = budget(); await h.inventory.readSnapshot(b);
  const result = await h.inventory.discoverSchedules(h.project, b);
  assert.equal(result.retained.length, 2);
  for (const [file, bytes] of h.files) assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('A4c1 fake clock expiring inside a port rejects late read without wall-clock assertions', supported, async t => {
  let time = 0;
  const h = await setup(t, { now: () => time });
  const original = h.writer.readProjectDeletionRevision;
  h.writer.readProjectDeletionRevision = async () => { const result = await original(); time = 10000; return result; };
  await assert.rejects(h.inventory.readSnapshot(budget()), { code: 'DISCOVERY_TIMEOUT' });
});

test('A4c1 unsupported or missing runtime roster cannot certify an empty job list', supported, async t => {
  const h = await setup(t, { readJobs: async () => ({ complete: false, jobs: [] }) });
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.code, 'SNAPSHOT_INCOMPLETE');
});

test('A4c1 saved remote tab uses durable host ownership and pending restores stay uncertain', supported, async t => {
  const h = await setup(t);
  h.db.setSetting('global', { openWorkingSet: [{ sessionId: 'one', projectPath: '/srv/Repo' },
    { sessionId: 'pending', projectPath: h.project.projectPath, fresh: true }] });
  const b = budget(); await h.inventory.readSnapshot(b);
  const remote = await h.inventory.readRuntimeState({ alias: 'one', projectPath: '/srv/Repo' }, b);
  assert.equal(remote.tabs.length, 1, 'saved tab must retain durable remote host identity');
  const local = await h.inventory.readRuntimeState(h.project, b);
  assert.ok(local.candidates.some(row => row.id === 'pending'), 'pending restore without durable identity cannot be certified');
});

test('A4c1 historical metadata without durable owner is an explicit candidate', supported, async t => {
  const h = await setup(t); h.db.setName('orphan', 'historical');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.ok(result.plan.refusals.some(row => row.target === 'orphan'), 'unowned metadata must not disappear');
});

test('A4c1 active PTY objects are projected to cloneable pinned runtime identities', supported, async t => {
  const h = await setup(t);
  h.deps.activeSessions.set('active', { ...h.project, type: 'terminal', generation: 7,
    pty: { pid: 456, write() {}, kill() {} }, exitDrain: Promise.resolve() });
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true, 'live PTY objects must not make the planner snapshot uncloneable: ' + result.error);
  const tab = result.plan.tabs.find(row => row.id === 'active');
  assert.equal(tab.runtime, 'terminal'); assert.equal(tab.generation, 7); assert.equal(tab.pid, 456);
  assert.equal(Object.hasOwn(tab, 'pty'), false);
});

test('A4c1 transcript identity mismatch cannot be verified from cwd alone', supported, async t => {
  const h = await setup(t);
  h.write(path.join(h.projectsDir, 'codex', 'codex.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'replacement', cwd: h.project.projectPath } }) + '\n');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.plan.refusals.some(row => row.target?.endsWith('codex.jsonl') && /identity/i.test(row.error)), 'transcript ID mismatch must remain a candidate');
});

test('A4c1 a timed-out file-open port closes its late handle with an injected timer', supported, async t => {
  const timers = new Set(), io = Object.create(fs.promises);
  let entered, release, closed = 0;
  const opened = new Promise(resolve => { entered = resolve; });
  const h = await setup(t, { fs: io,
    setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); } });
  const b = budget(); await h.inventory.readSnapshot(b);
  io.open = () => new Promise(resolve => { release = resolve; entered(); });
  const pending = h.inventory.inspectRetainedFiles([h.schedule], b);
  await opened;
  assert.equal(timers.size, 1);
  [...timers][0].fn();
  await assert.rejects(pending, { code: 'DISCOVERY_TIMEOUT' });
  release({ async close() { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1, 'late file handle must be closed after the port deadline');
  assert.equal(timers.size, 0);
});

test('A4c1 cached rows without a project mapping remain unmappable candidates', supported, async t => {
  const h = await setup(t);
  h.db.upsertCachedSessions([{ sessionId: 'lost-cache', folder: 'unknown', projectPath: null }]);
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.plan.refusals.some(row => row.target === 'lost-cache'), 'unmappable cached row must not be silently omitted');
});

test('A4c1 authoritative remote readers preserve both hosts and POSIX schedule identities', supported, async t => {
  const h = await setup(t, {
    readRemoteOwnership: async project => ({ complete: true, candidates: [],
      groups: [{ ...project, folderKey: project.alias + '::remote', runtime: 'claude', verified: true }],
      members: [{ ...project, id: project.alias, conversationId: project.alias, partId: project.alias,
        folderKey: project.alias + '::remote', runtime: 'claude', cwd: project.projectPath, verified: true,
        indexed: true, present: true, liveness: { state: 'stopped', source: 'remote' } }] }),
    readRemoteSchedules: async project => ({ complete: true, candidates: [], schedules: [{ ...project,
      id: 'remote-schedule', path: '/srv/Repo/.claude/commands/schedule-kept.md', readable: true, verified: true, enabled: false }] }),
  });
  const before = h.db.changeCount();
  for (const alias of ['one', 'two']) {
    const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: '/srv/Repo', folderKey: alias + '::remote', options });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.plan.refusals, [], 'authoritative remote schedule discovery must be used');
    assert.deepEqual(result.plan.members.map(row => row.id), [alias]);
    assert.equal(result.plan.schedules[0].path, '/srv/Repo/.claude/commands/schedule-kept.md');
  }
  assert.equal(h.db.changeCount(), before);
});
