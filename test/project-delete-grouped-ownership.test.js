'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');
const { createSessionIndexWriter } = require('../session-index-writer');
const { createProjectDeleteInventory } = require('../src/main/projects/project-delete-inventory');
const { createProjectDeletePlanner } = require('../src/main/projects/project-delete-plan');
const { createProjectDeleteProgress, operationId } = require('../src/main/projects/project-delete-progress');
const { identity, membershipDigest } = require('../src/main/projects/project-delete-identity');
const { readDurableScope, validateDeletionManifest, completeProjectDeletion, bindDeletionProducer, assertDeletionProducer } = require('../src/main/projects/project-delete-writer');
const supported = { skip: !openStore.supported && 'real SQLite requires Node 22 or matching native ABI' };
const options = { sessions: true, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false };

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grouped-delete-')));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  const db = openStore(), projectsDir = path.join(root, 'transcripts');
  const project = { alias: null, projectPath: path.join(root, 'repo') };
  const other = path.join(root, 'other');
  fs.mkdirSync(project.projectPath); fs.mkdirSync(other);
  const files = new Map();
  const add = (id, cwd, runtime) => {
    const folder = id;
    const file = path.join(runtime === 'codex' ? path.join(root, 'codex') : path.join(projectsDir, folder), id + '.jsonl');
    const bytes = JSON.stringify(runtime === 'codex' ? { type: 'session_meta', payload: { id, cwd } }
      : { type: 'user', sessionId: id, cwd, message: { content: 'keep transcript' } }) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); files.set(file, bytes);
    const row = { sessionId: id, folder, projectPath: cwd, runtime, sessionFile: runtime === 'codex' ? file : null };
    db.setFolderMeta(folder, cwd, 1); db.upsertCachedSessions([row]);
    db.setName(id, 'metadata ' + id); db.setStarred(id, true);
    db.upsertSearchEntries([{ id, type: 'session', folder, title: id, body: 'sentinel' }]);
    return row;
  };
  const selected = [add('claude-main', project.projectPath, 'claude'),
    add('claude-worktree', path.join(project.projectPath, '.claude/worktrees/child'), 'claude'),
    add('codex-worktree', path.join(project.projectPath, '.work-files/worktrees/gone/.worktrees/nested'), 'codex')];
  const kept = [add('foreign-main', other, 'claude'), add('foreign-worktree', path.join(other, '.work-files/worktrees/child'), 'codex')];
  db.setInitialScanComplete();
  const worker = require('./fixtures/project-deletion-worker.cjs')(db);
  const writer = createSessionIndexWriter({ client: worker.client, readonlyBackend: db }, {}); await writer.ready;
  const inventory = createProjectDeleteInventory({ writer, projectsDir, dataDir: process.env.SWITCHBOARD_DATA_DIR,
    activeSessions: new Map(), getScheduleRunSnapshot: () => [], readJobs: async () => ({ complete: true, jobs: [] }),
    readLiveness: async () => ({ state: 'stopped', source: 'descriptor' }) });
  t.after(() => { db.closeDb(); process.env.SWITCHBOARD_DATA_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); });
  async function manifest() {
    const preview = await createProjectDeletePlanner(inventory).preview({ projectPath: project.projectPath, options });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.deepEqual(preview.plan.refusals, []);
    const plan = preview.plan, scope = readDurableScope(db, { project });
    const collected = Object.fromEntries(['groups', 'members', 'tabs', 'jobs', 'schedules'].map(key => [key, plan[key]]));
    assert.deepEqual(plan.members.map(row => row.id).sort(), selected.map(row => row.sessionId).sort());
    return { project, operationId: operationId(project, scope.projectEpoch), expectedProjectEpoch: scope.projectEpoch,
      expectedRevision: scope.writerRevision, writerMembershipDigest: scope.writerMembershipDigest,
      inventory: collected, groups: plan.groups, members: plan.members, membershipDigest: plan.membershipDigest, options };
  }
  return { root, db, project, other, selected, kept, files, worker, manifest };
}

test('1137 durable scope includes exactly repository worktree sessions without rewriting paths', supported, async t => {
  const h = await setup(t), scope = readDurableScope(h.db, { project: h.project });
  assert.deepEqual(scope.scope.rows.map(row => row.sessionId).sort(), h.selected.map(row => row.sessionId).sort());
  assert.equal(h.db.getCachedSession('codex-worktree').projectPath, h.selected[2].projectPath);
});

test('1137 regrouped Codex preview must pass durable writer ownership', supported, async t => {
  const h = await setup(t), input = await h.manifest();
  assert.doesNotThrow(() => validateDeletionManifest(h.db, input),
    'the writer must accept the same grouped Codex membership as the corrected preview');
});

test('1137 a grouped manifest still rejects sessions from another repository and its worktree', supported, async t => {
  const h = await setup(t), input = await h.manifest();
  assert.doesNotThrow(() => validateDeletionManifest(h.db, input), 'valid grouped manifest must be accepted first');
  for (const row of h.kept) {
    const forged = structuredClone(input);
    forged.groups.push({ ...h.project, folderKey: row.folder, runtime: row.runtime, verified: true, effect: 'selected' });
    forged.members.push({ ...forged.members[0], id: row.sessionId, partId: row.sessionId, conversationId: row.sessionId, folderKey: row.folder, runtime: row.runtime });
    forged.inventory.groups = forged.groups; forged.inventory.members = forged.members;
    forged.membershipDigest = membershipDigest(h.project, forged.inventory);
    assert.throws(() => validateDeletionManifest(h.db, forged), { code: 'DELETION_OWNERSHIP' }, row.sessionId);
  }
});

test('1137 full writer deletion removes only previewed Claude and Codex metadata and search rows', supported, async t => {
  const h = await setup(t), input = await h.manifest();
  const reply = await h.worker.post('completeProjectDeletion', input);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.state, 'committed');
  assert.deepEqual(Array.from(reply.result.invalidation.sessionIds).sort(), h.selected.map(row => row.sessionId).sort());
  for (const row of h.selected) {
    assert.equal(h.db.getCachedSession(row.sessionId), null);
    assert.equal(h.db.getMeta(row.sessionId), null);
    assert.equal(h.db.getFolderMeta(row.folder), null);
  }
  for (const row of h.kept) {
    assert.equal(h.db.getCachedSession(row.sessionId).projectPath, row.projectPath);
    assert.equal(h.db.getMeta(row.sessionId).name, 'metadata ' + row.sessionId);
    assert.equal(h.db.getFolderMeta(row.folder).projectPath, row.projectPath);
  }
  assert.deepEqual(h.db.getSearchFileIds('session').sort(), h.kept.map(row => row.sessionId).sort());
  for (const [file, bytes] of h.files) assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

for (const kind of ['row', 'folder']) test(`1137 between-chunk ${kind} ownership rejects a move to another repository`, supported, async t => {
  const h = await setup(t), input = await h.manifest();
  let iterator, state;
  assert.doesNotThrow(() => { iterator = completeProjectDeletion(h.db, input); state = iterator.next().value(); });
  assert.equal(state.state, 'inProgress');
  assert.equal(iterator.next().value().state, 'inProgress', 'unchanged grouped ownership survives staging');
  if (kind === 'row') h.db.upsertCachedSessions([{ ...h.selected[2], projectPath: h.kept[1].projectPath }]);
  else h.db.setFolderMeta(h.selected[2].folder, h.kept[1].projectPath, 2);
  const next = iterator.next().value();
  assert.equal(next.state, 'partial');
  assert.equal(next.error.code, 'DELETION_OWNERSHIP');
  assert.ok(h.db.getCachedSession(h.selected[2].sessionId));
});

test('1137 old and new producers share the repository fence for cached, supplied and folder owners', supported, async t => {
  const h = await setup(t), row = h.selected[2];
  const commands = [['setName', [row.sessionId, 'late']], ['upsertCachedSessions', [[{ ...row, sessionId: 'new-codex' }]]],
    ['setFolderMeta', [row.folder, row.projectPath, 2]], ['upsertSearchEntries', [[{ id: 'new-search', type: 'session', folder: row.folder, body: 'late' }]]]];
  const bindings = commands.map(([name, args]) => bindDeletionProducer(h.db, name, args, true));
  const input = await h.manifest();
  createProjectDeleteProgress(h.db).fence(input);
  for (const [i, [name, args]] of commands.entries()) {
    assert.throws(() => assertDeletionProducer(h.db, bindings[i], name, args), { code: 'PROJECT_EPOCH_STALE' }, 'old ' + name);
    const fresh = bindDeletionProducer(h.db, name, args);
    assert.throws(() => assertDeletionProducer(h.db, fresh, name, args), { code: 'PROJECT_EPOCH_STALE' }, 'new ' + name);
  }
  const unrelated = bindDeletionProducer(h.db, 'setName', ['foreign-worktree', 'allowed']);
  assert.doesNotThrow(() => assertDeletionProducer(h.db, unrelated, 'setName', ['foreign-worktree', 'allowed']));
});

test('1137 old worktree receipt identities keep their own fence after repository grouping', supported, async t => {
  const h = await setup(t), project = { alias: null, projectPath: h.selected[2].projectPath };
  const progress = createProjectDeleteProgress(h.db), scope = progress.readScope({ project });
  const input = { project, operationId: operationId(project, scope.projectEpoch), expectedProjectEpoch: scope.projectEpoch,
    expectedRevision: scope.writerRevision, writerMembershipDigest: scope.writerMembershipDigest, membershipDigest: 'historical',
    options, units: [{ category: 'session', target: { id: 'old-history', erase: true } },
      { category: 'finalize', target: { project: identity(project), entry: project.projectPath, folderKeys: ['old-folder'], restoreTargets: [] } }] };
  progress.admit(input); progress.stage(input, input.units);
  for (const _unit of input.units) progress.apply(input, () => ({ status: 'completed' }));
  const bindings = bindDeletionProducer(h.db, 'setName', ['old-history', 'late']);
  assert.equal(bindings[0].key, identity(project).key, 'durable history is already an operation identity');
  assert.throws(() => assertDeletionProducer(h.db, bindings), { code: 'PROJECT_EPOCH_STALE' });
  const folderBindings = bindDeletionProducer(h.db, 'deleteCachedFolder', ['old-folder']);
  assert.equal(folderBindings[0].key, identity(project).key);
  assert.throws(() => assertDeletionProducer(h.db, folderBindings), { code: 'PROJECT_EPOCH_STALE' });
});

test('1137 a legacy blocked worktree fence still protects a newly supplied session', supported, async t => {
  const h = await setup(t), project = { alias: null, projectPath: h.selected[2].projectPath };
  const progress = createProjectDeleteProgress(h.db), scope = progress.readScope({ project });
  progress.fence({ project, operationId: operationId(project, scope.projectEpoch), expectedProjectEpoch: scope.projectEpoch });
  const args = [[{ ...h.selected[2], sessionId: 'never-indexed' }]];
  const bindings = bindDeletionProducer(h.db, 'upsertCachedSessions', args);
  assert.throws(() => assertDeletionProducer(h.db, bindings), error => ['DELETION_OWNERSHIP', 'PROJECT_EPOCH_STALE'].includes(error.code));
});

test('1137 remote ownership retains its host and exact worktree path', supported, async t => {
  const h = await setup(t), project = { alias: 'remote', projectPath: '/srv/repo/.worktrees/child' };
  h.db.upsertCachedSessions([{ sessionId: 'remote-child', folder: 'remote::child', projectPath: project.projectPath }]);
  const scope = readDurableScope(h.db, { project });
  assert.deepEqual(scope.scope.rows.map(row => row.sessionId), ['remote-child']);
  assert.deepEqual(readDurableScope(h.db, { project: { ...project, projectPath: '/srv/repo' } }).scope.rows, []);
  assert.deepEqual(readDurableScope(h.db, { project: { ...project, alias: 'other-host' } }).scope.rows, []);
});
