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

test('A4c2a unknown folder with inaccessible foreign cwd does not block this project', supported, async t => {
  const io = Object.create(fs.promises);
  io.realpath = async file => {
    if (String(file).endsWith('denied')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.promises.realpath(file);
  };
  const h = await setup(t, { fs: io });
  h.write(path.join(h.projectsDir, 'unknown', 'foreign.jsonl'), JSON.stringify({ cwd: path.join(h.root, 'denied') }) + '\n');
  h.write(path.join(h.projectsDir, 'unknown', 'owned.jsonl'), JSON.stringify({ cwd: path.join(h.project.projectPath, 'denied') }) + '\n');
  const b = budget(); await h.inventory.readSnapshot(b);
  const result = await h.inventory.discoverOwnership(h.project, b);
  assert.equal(result.candidates.some(row => row.path?.endsWith('foreign.jsonl')), false, 'inaccessible foreign cwd must not refuse this project');
  assert.equal(result.candidates.some(row => row.path?.endsWith('owned.jsonl')), true, 'lexically owned unreadable cwd must still refuse');
});

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

test('A4c1FIX unrelated orphan metadata does not refuse another project', supported, async t => {
  const h = await setup(t); h.db.setName('orphan', 'historical');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.deepEqual(result.plan.refusals, [], 'unrelated orphan metadata must not block this project');
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

test('A4c1FIX cached rows without attributable ownership do not block another project', supported, async t => {
  const h = await setup(t);
  h.db.upsertCachedSessions([{ sessionId: 'lost-cache', folder: 'unknown', projectPath: null }]);
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.plan.refusals, [], 'unattributed cache rows must not block this project');
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

for (const [count, size] of [[1, 20 << 20], [40, 2 << 20]]) test('A4c1FIX bounded transcript heads ' + count, supported, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let bytesRead = 0, pageBytes = 0;
  const io = Object.create(fs.promises);
  io.open = async (...args) => {
    const handle = await fs.promises.open(...args), read = handle.read.bind(handle);
    handle.read = async (...values) => { const result = await read(...values); bytesRead += result.bytesRead; return result; };
    return handle;
  };
  const h = await setup(t, { fs: io });
  for (let i = 0; i < count; i++) {
    const id = 'large-' + i, file = path.join(h.projectsDir, 'local', id + '.jsonl');
    h.write(file, JSON.stringify({ sessionId: id, cwd: h.project.projectPath }) + '\n');
    fs.truncateSync(file, size);
    h.db.upsertCachedSessions([{ sessionId: id, folder: 'local', projectPath: h.project.projectPath, runtime: 'claude' }]);
  }
  const readPage = h.writer.readProjectDeletionSnapshot;
  h.writer.readProjectDeletionSnapshot = async input => { const result = await readPage(input); pageBytes += result.bytes; return result; };
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true, 'large transcripts must fit discovery: ' + JSON.stringify(result));
  assert.deepEqual(result.plan.refusals, []);
  assert.ok(bytesRead < (count + 10) * 16384, 'only bounded transcript heads are read');
  const exactBytes = bytesRead + pageBytes + Buffer.byteLength(JSON.stringify({ complete: true, jobs: [] })) + 2;
  bytesRead = 0; pageBytes = 0;
  const exact = await createProjectDeletePlanner(inventoryModule.createProjectDeleteInventory({ ...h.deps, maxBytes: exactBytes })).preview({ projectPath: h.project.projectPath, options });
  assert.equal(exact.ok, true, 'budget must charge bytes read, not transcript sizes: ' + JSON.stringify(exact));
  const short = await createProjectDeletePlanner(inventoryModule.createProjectDeleteInventory({ ...h.deps, maxBytes: exactBytes - 1 })).preview({ projectPath: h.project.projectPath, options });
  assert.equal(short.code, 'DISCOVERY_LIMIT', 'every byte actually read is charged');
});

test('A4c1FIX subagent accepts known worktree and first recorded cwd', supported, async t => {
  const h = await setup(t);
  h.write(path.join(h.projectsDir, 'local', 'head/subagents/agent-worker.jsonl'),
    JSON.stringify({ sessionId: 'head', cwd: h.child }) + '\n' + JSON.stringify({ sessionId: 'head', cwd: path.join(h.root, 'later') }) + '\n');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.refusals, [], 'first cwd in known child worktree belongs to the parent');
});

test('A4c1FIX unindexed foreign head excluded and own members refuse', supported, async t => {
  const h = await setup(t);
  h.write(path.join(h.projectsDir, 'foreign', 'other.jsonl'), JSON.stringify({ cwd: path.join(h.root, 'foreign') }) + '\n');
  let result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.deepEqual(result.plan.refusals, [], 'another project unindexed transcript must be excluded');
  h.write(path.join(h.projectsDir, 'unmapped', 'own.jsonl'), JSON.stringify({ cwd: h.project.projectPath }) + '\n');
  const encoded = require('../encode-project-path').encodeProjectPath(h.project.projectPath);
  h.write(path.join(h.projectsDir, encoded, 'empty.jsonl'), '');
  result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.ok(result.plan.refusals.some(row => row.target?.endsWith('own.jsonl')));
  assert.ok(result.plan.refusals.some(row => row.target?.endsWith('empty.jsonl')));
  assert.ok(!result.plan.refusals.some(row => row.target?.endsWith('other.jsonl')));
});

test('A4c1FIX two MiB settings paginate within page budget', supported, async t => {
  const h = await setup(t);
  for (let i = 0; i < 64; i++) h.db.setSetting('large-setting-' + i, 'x'.repeat(32768));
  let snapshot, error;
  try { snapshot = await h.inventory.readSnapshot(budget()); } catch (e) { error = e; }
  assert.equal(error, undefined, 'rows below budget must shorten pages instead of refusing');
  assert.equal(snapshot.settings.filter(row => row.key.startsWith('large-setting-')).length, 64);
});

test('A4c1FIX2 single oversized setting retries within the store hard cap', supported, async t => {
  const h = await setup(t); h.db.setSetting('oversized', 'x'.repeat(1048576));
  const bounds = [], read = h.writer.readProjectDeletionSnapshot;
  h.writer.readProjectDeletionSnapshot = async input => { bounds.push(input.maxBytes); return read(input); };
  let snapshot, error;
  try { snapshot = await h.inventory.readSnapshot(budget()); } catch (e) { error = e; }
  assert.equal(error, undefined, 'a lone setting below the hard cap must retry');
  assert.equal(JSON.parse(snapshot.settings.find(row => row.key === 'oversized').value).length, 1048576);
  assert.ok(bounds.some(bound => bound > 1048576));
  assert.ok(bounds.every(bound => bound <= 8 << 20));
  await assert.rejects(inventoryModule.createProjectDeleteInventory({ ...h.deps, maxBytes: 1048576 }).readSnapshot(budget()), { code: 'DISCOVERY_LIMIT' });
  h.db.setSetting('oversized', 'x'.repeat(2 << 20));
  await assert.rejects(h.inventory.readSnapshot(budget()), { code: 'DISCOVERY_LIMIT' });
});

for (const persistent of [false, true]) test('A4c1FIX snapshot restart persistent=' + persistent, supported, async t => {
  const h = await setup(t, { snapshotAttempts: 3 });
  for (let i = 0; i < 260; i++) h.db.setSetting('paged-' + i, i);
  const read = h.writer.readProjectDeletionSnapshot;
  let bumps = 0, starts = 0;
  h.writer.readProjectDeletionSnapshot = async input => {
    if (input.section === 'sessions' && input.cursor === null) starts++;
    const result = await read(input);
    if (input.section === 'settings' && result.nextCursor !== null && (persistent || !bumps)) {
      bumps++; await h.writer.setSetting('_writer_revision', result.revision + 1);
    }
    return result;
  };
  let snapshot, error;
  try { snapshot = await h.inventory.readSnapshot(budget()); } catch (e) { error = e; }
  if (persistent) { assert.equal(error?.code, 'SNAPSHOT_STALE'); assert.equal(starts, 3, 'retry count is bounded'); }
  else { assert.equal(error, undefined, 'one indexing revision change must retry'); assert.equal(starts, 2); assert.equal(snapshot.complete, true); }
});

test('A4c1FIX empty project settings refusal follows selected option', supported, async t => {
  const h = await setup(t), empty = path.join(h.root, 'empty'); fs.mkdirSync(empty);
  h.db.setSetting('scheduleProjects', [empty]);
  for (const settings of [false, true]) {
    const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: empty, options: { ...options, settings } });
    assert.equal(result.ok, true);
    assert.equal(result.plan.refusals.some(row => /settings.*ownership/i.test(row.error)), settings, 'settings ownership is only required for erasure');
  }
});

test('A4c1FIX raw string setting uses getSetting fallback', supported, async t => {
  const h = await setup(t);
  h.db.connection.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('raw', 'not JSON');
  let snapshot, error;
  try { snapshot = await h.inventory.readSnapshot(budget()); } catch (e) { error = e; }
  assert.equal(error, undefined, 'raw strings must not throw SyntaxError');
  assert.equal(snapshot.settings.find(row => row.key === 'raw').value, h.db.getSetting('raw'));
});

test('A4c1FIX unmapped cache head belonging to selected project remains a candidate', supported, async t => {
  const h = await setup(t);
  h.db.upsertCachedSessions([{ sessionId: 'unmapped-member', folder: 'unknown', projectPath: null }]);
  h.write(path.join(h.projectsDir, 'unknown', 'unmapped-member.jsonl'), JSON.stringify({ sessionId: 'unmapped-member', cwd: h.project.projectPath }) + '\n');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true);
  assert.ok(result.plan.refusals.some(row => row.target?.endsWith('unmapped-member.jsonl')), 'bounded cwd must attribute unmappable cached members');
});

for (const shape of ['real main head', '40 KiB subagent record']) test('A4c1FIX2 bounded identity and verified cwd for ' + shape, supported, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const reads = new Map(), io = Object.create(fs.promises);
  io.open = async (file, ...args) => {
    const handle = await fs.promises.open(file, ...args), read = handle.read.bind(handle);
    handle.read = async (...values) => { const result = await read(...values); reads.set(file, (reads.get(file) || 0) + result.bytesRead); return result; };
    return handle;
  };
  const h = await setup(t, { fs: io }), parent = '11111111-1111-4111-8111-111111111111';
  const subagent = shape.startsWith('40'), id = subagent ? `subagent:${parent}:worker` : parent;
  const folder = require('../encode-project-path').encodeProjectPath(h.project.projectPath);
  const file = path.join(h.projectsDir, folder, subagent ? `${parent}/subagents/agent-worker.jsonl` : id + '.jsonl');
  const prefix = subagent ? JSON.stringify({ parentUuid: null, isSidechain: true, promptId: 'p', agentId: 'worker', type: 'user',
    message: { content: 'x'.repeat(40 << 10) }, uuid: 'u', userType: 'external', cwd: h.project.projectPath, sessionId: parent }) + '\n'
    : ['custom-title', 'agent-name', 'mode', 'permission-mode', 'atis-latch'].map(type => JSON.stringify({ type, value: 'recorded metadata' }) + '\n').join('')
      + JSON.stringify({ type: 'progress', data: 'x'.repeat(1100000) }) + '\n' + JSON.stringify({ sessionId: id, cwd: h.project.projectPath }) + '\n';
  h.write(file, prefix); fs.truncateSync(file, 24 << 20);
  h.db.setFolderMeta(folder, h.project.projectPath, 1);
  h.db.upsertCachedSessions([{ sessionId: id, folder, projectPath: h.project.projectPath, runtime: 'claude',
    parentSessionId: subagent ? parent : null, agentId: subagent ? 'worker' : null }]);
  if (subagent) {
    h.write(path.join(h.projectsDir, folder, parent + '.jsonl'), JSON.stringify({ sessionId: parent, cwd: h.project.projectPath }) + '\n');
    h.db.upsertCachedSessions([{ sessionId: parent, folder, projectPath: h.project.projectPath, runtime: 'claude' }]);
  }
  let pageBytes = 0;
  const readPage = h.writer.readProjectDeletionSnapshot;
  h.writer.readProjectDeletionSnapshot = async input => { const result = await readPage(input); pageBytes += result.bytes; return result; };
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.plan.refusals, [], 'real transcript shapes must have provable identity and cwd');
  assert.ok(result.plan.members.some(row => row.id === id && row.present && row.size === (24 << 20)));
  assert.equal(reads.get(file), 16 << 10, 'large transcript uses only one bounded prefix');
  const bytes = [...reads.values()].reduce((sum, value) => sum + value, 0) + pageBytes + Buffer.byteLength(JSON.stringify({ complete: true, jobs: [] })) + 2;
  const exact = await createProjectDeletePlanner(inventoryModule.createProjectDeleteInventory({ ...h.deps, maxBytes: bytes })).preview({ projectPath: h.project.projectPath, options });
  assert.equal(exact.ok, true); assert.deepEqual(exact.plan.refusals, []);
  const short = await createProjectDeletePlanner(inventoryModule.createProjectDeleteInventory({ ...h.deps, maxBytes: bytes - 1 })).preview({ projectPath: h.project.projectPath, options });
  assert.equal(short.code, 'DISCOVERY_LIMIT', 'every prefix byte must be charged');
});

test('A4c1FIX2 verified foreign cwd stays outside selected members', supported, async t => {
  const h = await setup(t), foreign = path.join(h.root, 'foreign'), id = '22222222-2222-4222-8222-222222222222';
  const folder = require('../encode-project-path').encodeProjectPath(foreign);
  h.write(path.join(h.projectsDir, folder, id + '.jsonl'), JSON.stringify({ sessionId: id, cwd: foreign }) + '\n');
  h.db.setFolderMeta(folder, foreign, 1);
  h.db.upsertCachedSessions([{ sessionId: id, folder, projectPath: foreign, runtime: 'claude' }]);
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.deepEqual(result.plan.refusals, []);
  assert.ok(!result.plan.members.some(row => row.id === id));
});

test('A4c1FIX2 orphan metadata follows transcript identity in an owned folder', supported, async t => {
  const h = await setup(t);
  h.db.setName('own-orphan', 'own'); h.db.setName('foreign-orphan', 'foreign');
  h.db.connection.prepare('INSERT INTO session_meta_fields (sessionId,field,revision,source) VALUES (?,?,?,?)').run('fields-orphan', 'name', 1, 'user');
  for (const id of ['own-orphan', 'fields-orphan']) h.write(path.join(h.projectsDir, 'local', id + '.jsonl'), JSON.stringify({ sessionId: id, cwd: h.project.projectPath }) + '\n');
  h.write(path.join(h.projectsDir, 'foreign', 'foreign-orphan.jsonl'), JSON.stringify({ sessionId: 'foreign-orphan', cwd: path.join(h.root, 'foreign') }) + '\n');
  const b = budget(); await h.inventory.readSnapshot(b);
  const result = await h.inventory.discoverOwnership(h.project, b);
  for (const id of ['own-orphan', 'fields-orphan']) assert.ok(result.candidates.some(row => row.path === id && /metadata/i.test(row.reason)), 'attributable orphan metadata must refuse: ' + id);
  assert.ok(!result.candidates.some(row => row.path === 'foreign-orphan'), 'unrelated orphan metadata is ignored');
});

test('A4c1FIX2 worktree cwd uses normalized bounded io without synchronous probes', supported, async t => {
  const realpaths = new Map(), io = Object.create(fs.promises);
  io.realpath = async file => { realpaths.set(file, (realpaths.get(file) || 0) + 1); return fs.promises.realpath(file); };
  const h = await setup(t, { fs: io });
  const cwd = path.join(h.project.projectPath, '.claude', 'worktrees', 'branch');
  h.write(path.join(h.projectsDir, 'local', 'head/subagents/agent-worker.jsonl'), JSON.stringify({ sessionId: 'head', cwd }) + '\n');
  const b = budget(); await h.inventory.readSnapshot(b);
  let syncCalls = 0;
  const original = fs.existsSync;
  t.mock.method(fs, 'existsSync', (...args) => { syncCalls++; return original(...args); });
  const result = await h.inventory.discoverOwnership(h.project, b);
  assert.equal(syncCalls, 0, 'ownership must not bypass the bounded injected io');
  assert.deepEqual(result.candidates, []);
  assert.ok(realpaths.size > 0);
  assert.ok([...realpaths.values()].every(count => count === 1), 'realpath checks are memoized');
});

test('A4c1FIX2 unindexed foreign cwd in an owned folder refuses', supported, async t => {
  const h = await setup(t), file = path.join(h.projectsDir, 'local', 'contradiction.jsonl');
  h.write(file, JSON.stringify({ sessionId: 'contradiction', cwd: path.join(h.root, 'foreign') }) + '\n');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.ok(result.plan.refusals.some(row => row.target === file && row.code === 'DISCOVERY_CANDIDATE'), 'owned-folder foreign cwd must remain a refusal candidate');
});

for (const suffix of ['.work-files/live', '.work-files/worktrees', '../foreign']) test('A4c1FIX3 subagent follows parent ownership for ' + suffix, supported, async t => {
  const h = await setup(t), file = path.join(h.projectsDir, 'local', 'head/subagents/agent-worker.jsonl');
  const cwd = path.resolve(h.project.projectPath, suffix);
  h.write(file, JSON.stringify({ agentId: 'worker', type: 'user', cwd, sessionId: 'head' }) + '\n');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.refusals, [], 'subagent ownership follows the indexed parent and folder');
  assert.ok(result.plan.members.some(row => row.id === 'subagent:head:worker' && row.present));
  h.write(path.join(h.projectsDir, 'local', 'head.jsonl'), JSON.stringify({ sessionId: 'head', cwd }) + '\n');
  const main = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.ok(main.plan.refusals.some(row => row.target?.endsWith('head.jsonl')), 'main transcripts retain strict cwd ownership');
});

test('A4c1FIX3 per-file realpath denial cannot hide later unindexed transcripts', supported, async t => {
  const io = Object.create(fs.promises);
  io.opendir = async directory => {
    const handle = await fs.promises.opendir(directory);
    if (path.basename(directory) !== 'unknown') return handle;
    const entries = [];
    let entry;
    while ((entry = await handle.read())) entries.push(entry);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { read: async () => entries.shift() || null, close: () => handle.close() };
  };
  io.realpath = async file => {
    if (String(file).includes('denied')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.promises.realpath(file);
  };
  const h = await setup(t, { fs: io }), directory = path.join(h.projectsDir, 'unknown');
  const first = path.join(directory, 'a.jsonl'), later = path.join(directory, 'b.jsonl');
  h.write(first, JSON.stringify({ sessionId: 'a', cwd: path.join(h.project.projectPath, 'denied', 'x') }) + '\n');
  h.write(later, JSON.stringify({ sessionId: 'b', cwd: h.project.projectPath }) + '\n');
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath: h.project.projectPath, options });
  assert.equal(result.ok, true);
  assert.ok(result.plan.refusals.some(row => row.target === later), 'realpath denial must not hide the later owned transcript');
  assert.ok(result.plan.refusals.some(row => row.target === first), 'unresolved ownership remains a candidate');
});

test('A4c1FIX3 raw cwd defeats a colliding encoded folder with an incomplete first record', supported, async t => {
  const h = await setup(t), projectPath = h.project.projectPath + '-nested', foreign = path.join(h.project.projectPath, 'nested');
  const { encodeProjectPath } = require('../encode-project-path');
  const folder = encodeProjectPath(projectPath), id = '33333333-3333-4333-8333-333333333333';
  assert.equal(encodeProjectPath(foreign), folder);
  const file = path.join(h.projectsDir, folder, id + '.jsonl');
  h.write(file, JSON.stringify({ cwd: foreign, sessionId: id, message: { content: 'x'.repeat(40 << 10) } }) + '\n');
  h.db.setFolderMeta(folder, projectPath, 1);
  h.db.upsertCachedSessions([{ sessionId: id, folder, projectPath, runtime: 'claude' }]);
  const result = await createProjectDeletePlanner(h.inventory).preview({ projectPath, options });
  assert.equal(result.ok, true);
  assert.ok(result.plan.refusals.some(row => row.target === file && /ownership/i.test(row.error)), 'bounded raw cwd must override a colliding folder fallback');
});
