'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openStore = require('./fixtures/conversation-store.cjs');
const { createProjectDeleteProgress, operationId, commitTransaction } = require('../src/main/projects/project-delete-progress');
const { createCacheEffects } = require('../cache-effects');
const { createSessionIndexWriter } = require('../session-index-writer');
const { createWriterCommands } = require('../session-index-commands');
const cache = require('../session-cache');
const supported = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };
const deep = (actual, expected, message) => assert.deepEqual(structuredClone(actual), structuredClone(expected), message);
let engine, shared;
try { engine = require('../src/main/projects/project-delete-writer'); shared = require('../src/main/projects/project-delete-identity'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
function api() { assert.equal(typeof engine?.validateDeletionManifest, 'function', 'exact deletion engine must be exported'); return engine; }

function setup(t, { empty = false, sharedHost = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-engine-')));
  const prior = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'db');
  let db = openStore();
  const project = { alias: null, projectPath: root }, folders = ['selected-a', 'selected-b'];
  const selected = empty ? [] : [
    { sessionId: 'head', folder: folders[0], projectPath: root, continuationIndex: JSON.stringify({ ids: ['continuation', 'historical'] }) },
    { sessionId: 'continuation', folder: folders[1], projectPath: root, mergedIntoSessionId: 'head' },
    { sessionId: 'agent', folder: folders[0], projectPath: root, parentSessionId: 'head', isSubagent: 1 },
  ];
  const kept = [
    { sessionId: 'mixed', folder: folders[0], projectPath: path.join(root, 'other') },
    { sessionId: 'remote', folder: 'host::remote', projectPath: sharedHost ? root.replaceAll('\\', '/') : '/srv/other' },
    { sessionId: 'worktree', folder: 'worktree', projectPath: path.join(root, '.work-files', 'worktrees', 'child') },
  ];
  for (const folder of folders) db.setFolderMeta(folder, root, 1);
  db.setFolderMeta('host::remote', kept[1].projectPath, 1);
  db.setFolderMeta('worktree', kept[2].projectPath, 1);
  db.upsertCachedSessions([...selected, ...kept].map(row => ({ ...row, messageCount: 1 })));
  for (const id of [...selected.map(row => row.sessionId), ...(empty ? [] : ['historical']), ...kept.map(row => row.sessionId), 'orphan']) {
    db.setName(id, 'app ' + id); db.setStarred(id, true);
    db.setSetting('continuationChoice:' + id, { selected: id });
  }
  for (const row of [...selected, ...kept]) {
    db.replaceSessionMetrics(row.sessionId, [{ date: '2026-11-10', messageCount: 3 }]);
    db.upsertSearchEntries([{ id: row.sessionId, type: 'session', folder: row.folder, title: row.sessionId, body: 'sentinel' }]);
  }
  db.upsertSearchEntries(['memory', 'workfile'].map(type => ({ id: type, type, folder: folders[0], body: 'keep' })));
  db.setSetting('project:' + root, { sentinel: 'selected settings' });
  db.setSetting('project:other', { sentinel: 'other settings' });
  db.setSetting('defaults', { sentinel: 'defaults' });
  db.setSetting('global', { sentinel: 'global', openWorkingSet: [] });
  const requestInput = { stemKey: 'kept-request', actualStem: 'kept-request', actionToken: 'kept-command', family: 'action', rawHash: 'a'.repeat(64), resultBytes: Buffer.from('kept journal bytes') };
  requestInput.argsHash = require('../session-index-commands').hashSessionRequestCommand('claimSessionResultNamespace', requestInput);
  const journal = commitTransaction(db, () => createWriterCommands(db).claimSessionResultNamespace(requestInput)).result;
  const files = ['schedule.md', '.claude/commands/schedule-file.md', 'source.js', 'memory.md', '.work-files/kept.md', '.work-files/worktrees/child/source.js', 'transcript.jsonl'];
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), file); }
  const bytes = () => files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  const beforeBytes = bytes();
  const groups = folders.map(folderKey => ({ ...project, folderKey, runtime: 'claude', verified: true, effect: 'selected' }));
  const members = selected.map(row => ({ ...project, id: row.sessionId, folderKey: row.folder, runtime: 'claude',
    conversationId: 'head', partId: row.sessionId, parentSessionId: row.parentSessionId || null,
    subagentId: row.isSubagent ? row.sessionId : null, verified: true, indexed: true, present: true, cwd: root }));
  if (!empty) members.push({ ...members[0], id: 'historical', partId: 'historical', metadataOnly: true });
  function manifest(settings = false, sessions = false) {
    api();
    const scope = engine.readDurableScope(db, { project });
    const inventory = { groups, members, tabs: [], jobs: [], schedules: [] };
    return { project, operationId: operationId(project, scope.projectEpoch), expectedProjectEpoch: scope.projectEpoch,
      expectedRevision: scope.writerRevision, writerMembershipDigest: scope.writerMembershipDigest,
      inventory, groups, members, membershipDigest: shared.membershipDigest(project, inventory),
      options: { settings, sessions, schedules: false, transcripts: false, stopBackgroundJobs: false } };
  }
  const reopen = () => { db.closeDb(); db = openStore(); };
  t.after(() => { db.closeDb(); if (prior === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = prior; fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, root, project, groups, members, selected, kept, manifest, reopen, bytes, beforeBytes, journal, requestInput };
}

function execute(h, input) {
  const validated = api().validateDeletionManifest(h.db, input);
  const units = engine.buildDeletionUnits(validated);
  const substrate = { ...input, units }, progress = createProjectDeleteProgress(h.db);
  progress.admit(substrate);
  while (progress.read(substrate).stagedUnits < units.length) {
    const n = progress.read(substrate).stagedUnits; progress.stage(substrate, units.slice(n, n + 16));
  }
  while (!progress.read(substrate).terminal) progress.apply(substrate, unit => engine.applyDeletionUnit(h.db, unit));
  return { validated, units, state: progress.read(substrate) };
}

for (const settings of [false, true]) for (const sessions of [false, true]) {
  test(`exact persisted matrix settings=${settings} sessions=${sessions}`, supported, t => {
    const h = setup(t), input = h.manifest(settings, sessions), beforeFields = h.db.projectDeletion.metadataFields();
    h.db.beginSearchEntry('old-selected', { id: 'head', type: 'session', folder: 'selected-a' });
    h.db.appendSearchBody('old-selected', 'old partial');
    h.db.beginSearchEntry('kept-stage', { id: 'mixed', type: 'session', folder: 'selected-a' });
    const result = execute(h, input);
    assert.equal(result.state.state, 'committed');
    assert.equal(h.db.getSetting('_writer_revision'), result.state.lastRevision, 'progress and effects share exact revision');
    assert.throws(() => h.db.publishSearchEntry('old-selected'), /staging entry missing/, 'old publication across chunks cannot recreate selected session');
    h.db.publishSearchEntry('kept-stage');
    h.reopen();
    const journal = createWriterCommands(h.db).querySessionRequestOutcome({ stemKey: h.requestInput.stemKey, rawHash: h.requestInput.rawHash });
    deep(journal.owner, h.journal.owner, '#380 request ownership and published bytes retained');
    assert.equal(h.db.sessionRequests.receipt(h.requestInput.stemKey, h.requestInput.actionToken).revision, h.journal.receipt.revision, '#380 command receipt retained');
    for (const member of h.members) {
      const meta = h.db.getMeta(member.id, true);
      if (sessions) {
        assert.equal(meta, null, 'selected session metadata erased');
        assert.equal(h.db.projectDeletion.metadataFields().some(row => row.sessionId === member.id), false, 'selected provenance erased');
      } else {
        assert.equal(meta.archived, 1, 'every continuation and subagent archived');
        assert.equal(meta.name, 'app ' + member.id); assert.equal(meta.starred, 1);
        deep(h.db.projectDeletion.metadataFields().filter(row => row.sessionId === member.id && row.field === 'name'), beforeFields.filter(row => row.sessionId === member.id && row.field === 'name'), 'name provenance retained');
      }
      assert.equal(h.db.getCachedSession(member.id), null, 'exact derived cache invalidated');
      assert.equal(h.db.getSearchFileIds('session').includes(member.id), false);
      assert.equal(h.db.getSetting('continuationChoice:' + member.id), null);
    }
    assert.equal(h.db.getFolderMeta('selected-b'), null, 'exclusive folder metadata removed');
    assert.ok(h.db.getFolderMeta('selected-a'), 'mixed folder metadata retained');
    for (const row of h.kept) { assert.ok(h.db.getCachedSession(row.sessionId), 'other host/worktree/mixed rows retained'); assert.equal(h.db.getMeta(row.sessionId).archived, 0); }
    assert.equal(h.db.getMeta('orphan').archived, 0, 'unowned metadata not guessed into scope');
    deep(h.db.getSearchFileIds('memory'), ['memory']); deep(h.db.getSearchFileIds('workfile'), ['workfile']);
    deep(h.db.getSetting('project:' + h.root), settings ? null : { sentinel: 'selected settings' }, 'unchecked settings sentinel retained');
    deep(h.db.getSetting('project:other'), { sentinel: 'other settings' });
    deep(h.db.getSetting('global'), { sentinel: 'global', openWorkingSet: [] });
    deep(h.db.getSetting('defaults'), { sentinel: 'defaults' }); deep(h.bytes(), h.beforeBytes);
    deep(result.validated.invalidation.sessionIds.sort(), h.members.map(row => row.id).sort());
  });
}

test('AC2 retained transcripts reindex through production cache and effects after reopen', supported, async t => {
  const h = setup(t), result = execute(h, h.manifest());
  commitTransaction(h.db, () => { for (const unit of engine.buildFinalizationUnits(result.validated)) engine.applyDeletionUnit(h.db, unit); });
  h.reopen();
  const projectsDir = path.join(h.root, 'projects'), folder = require('../encode-project-path').encodeProjectPath(h.root), dir = path.join(projectsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const id of ['head', 'continuation']) fs.writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', uuid: id, cwd: h.root,
    timestamp: '2026-11-10T10:00:00.000Z', message: { content: 'retained ' + id } }) + '\n');
  const commands = createWriterCommands(h.db);
  const client = { ready: Promise.resolve(), request(name, ...args) {
    if (name === 'effects') {
      if ((h.db.getSetting('_writer_revision') || 0) !== args[1]) throw Object.assign(new Error('stale'), { code: 'WRITER_STALE' });
      return Promise.resolve(commitTransaction(h.db, () => { for (const effect of args[0]) (commands[effect.name] || h.db[effect.name])(...effect.args); }).result);
    }
    return Promise.resolve(commitTransaction(h.db, () => (commands[name] || h.db[name])(...args)).result);
  }, requestForWorkflow(_id, name, ...args) { return this.request(name, ...args); }, retireWorkflow() {}, async fenceWorkflow() {} };
  const writer = createSessionIndexWriter({ client, readonlyBackend: h.db }, cache); await writer.ready;
  writer.initializeCache({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console });
  cache.setRemoteRoots(new Map());
  await writer.revealAddedProject(h.root);
  await writer.refreshFolder(folder);
  const all = await writer.buildProjectsFromCache(true), visible = await writer.buildProjectsFromCache(false);
  const restored = all.filter(project => project.projectPath === h.root).flatMap(project => project.sessions);
  deep(restored.map(row => row.sessionId).sort(), ['continuation', 'head'], 're-add publishes only retained transcript rows');
  for (const row of restored) { assert.equal(row.archived, 1); assert.equal(row.name, 'app ' + row.sessionId); assert.equal(row.starred, 1); }
  assert.equal(visible.filter(project => project.projectPath === h.root).flatMap(project => project.sessions).length, 0, 're-added conversations remain archived in normal view');
  h.reopen();
  for (const id of ['head', 'continuation']) { assert.ok(h.db.getCachedSession(id), 'retained transcript reindexed'); assert.equal(h.db.getMeta(id).archived, 1); assert.equal(h.db.getMeta(id).name, 'app ' + id); assert.equal(h.db.getMeta(id).starred, 1); assert.equal(h.db.getMeta(id, true).nameSource, 'user'); }
  assert.equal(h.db.getCachedSession('historical'), null, 'metadata-only history cannot synthesize cache rows');
  assert.equal(h.db.getCachedSession('orphan'), null, 'orphan cannot synthesize cache rows');
});

test('AC3 same path host ambiguity and unknown settings ownership refuse before every effect', supported, t => {
  const h = setup(t, { sharedHost: true });
  const before = h.db.changeCount();
  assert.throws(() => api().validateDeletionManifest(h.db, h.manifest(true, true)), { code: 'SHARED_SETTINGS' });
  assert.equal(h.db.changeCount(), before);
  execute(h, h.manifest(false, true)); h.reopen();
  deep(h.db.getSetting('project:' + h.root), { sentinel: 'selected settings' });
  assert.ok(h.db.getCachedSession('remote')); assert.equal(h.db.getMeta('remote').archived, 0);
});

for (const change of ['options', 'digest', 'members', 'ownership', 'orphan', 'unknown-settings']) test(`preflight ${change} rejects with zero effects`, supported, t => {
  const h = setup(t), input = h.manifest(true, true);
  if (change === 'options') input.options.schedules = true;
  if (change === 'digest') input.membershipDigest = 'bad';
  if (change === 'members') input.members = input.members.slice(1);
  if (change === 'ownership') h.db.upsertCachedSessions([{ ...h.selected[0], projectPath: path.join(h.root, 'foreign') }]);
  if (change === 'orphan') { input.inventory.members.push({ ...h.members[0], id: 'orphan' }); input.membershipDigest = shared.membershipDigest(input.project, input.inventory); }
  if (change === 'unknown-settings') {
    for (const row of h.db.getAllCached()) h.db.deleteCachedSession(row.sessionId);
    for (const folder of h.db.getAllFolderMeta().keys()) h.db.connection.prepare('DELETE FROM cache_meta WHERE folder=?').run(folder);
    input.writerMembershipDigest = engine.readDurableScope(h.db, { project: h.project }).writerMembershipDigest;
  }
  const before = h.db.changeCount();
  assert.throws(() => engine.validateDeletionManifest(h.db, input), error => typeof error.code === 'string', 'invalid manifest must refuse');
  assert.equal(h.db.changeCount(), before, 'refusal is before every mutation');
});

test('empty project clears only exclusive group markers without phantom metadata', supported, t => {
  const h = setup(t, { empty: true }); execute(h, h.manifest(true, false)); h.reopen();
  assert.equal(h.db.getMeta('head'), null); assert.ok(h.db.getMeta('orphan')); assert.ok(h.db.getCachedSession('mixed'));
});

test('effect and progress roll back together; old computed effects reject a changed revision', supported, async t => {
  const h = setup(t), input = h.manifest(), validated = api().validateDeletionManifest(h.db, input), units = engine.buildDeletionUnits(validated);
  const workerFile = require.resolve('../workers/session-index-writer'), vm = require('node:vm'), { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
  const port = new EventEmitter(), nativeRequire = createRequire(workerFile);
  const reply = new Promise(resolve => { port.postMessage = message => { if (message.id === 1 && !message.started) resolve(message); }; });
  vm.runInNewContext(fs.readFileSync(workerFile, 'utf8'), { require: id => id === 'node:worker_threads' ? { parentPort: port } : id === '../session-index-store' ? { openSessionIndexStore: () => h.db } : nativeRequire(id), setInterval: () => ({ unref() {} }) }, { filename: workerFile });
  const p = createProjectDeleteProgress(h.db), manifest = { ...input, units };
  p.admit(manifest); p.stage(manifest, units.slice(0, 16));
  while (p.read(manifest).stagedUnits < units.length) { const n = p.read(manifest).stagedUnits; p.stage(manifest, units.slice(n, n + 16)); }
  const before = p.read(manifest);
  assert.throws(() => p.apply(manifest, unit => engine.applyDeletionUnit(h.db, unit), { beforeCommit() { throw new Error('rollback'); } }), /rollback/);
  assert.equal(h.db.getMeta('head').archived, 0); assert.equal(p.read(manifest).nextUnit, before.nextUnit);
  const recorder = createCacheEffects(h.db); recorder.begin(); recorder.adapter.setName('head', 'old effect');
  const revision = recorder.revision(), effects = recorder.finish();
  p.apply(manifest, unit => engine.applyDeletionUnit(h.db, unit));
  port.emit('message', { id: 1, command: 'effects', args: [effects, revision] });
  assert.equal((await reply).error.code, 'WRITER_STALE');
});

test('prepared finalization merges current settings by identity and never seeds registrations', supported, t => {
  const h = setup(t), validated = api().validateDeletionManifest(h.db, h.manifest());
  const units = engine.buildFinalizationUnits(validated);
  const remote = 'host::' + h.root.replaceAll('\\', '/');
  h.db.setSetting('archivedProjects', { [h.root]: { disabledSchedules: ['keep-file'] }, [remote]: { remote: true } });
  h.db.setSetting('scheduleReenableOffers', { [h.root]: { selected: true }, [remote]: { remote: true } });
  h.db.setSetting('scheduleProjects', [h.root, path.join(h.root, '.work-files', 'worktrees', 'child')]);
  h.db.setSetting('global', { sentinel: 'latest', hiddenProjects: [h.root], hiddenProjectKinds: { [h.root]: 'repository' },
    openWorkingSet: [{ sessionId: 'head', projectPath: h.root }, { sessionId: 'head', projectPath: '/srv/other', host: 'host' }, { sessionId: 'orphan', projectPath: h.root }, { sessionId: 'worktree', projectPath: h.kept[2].projectPath }] });
  commitTransaction(h.db, () => { for (const unit of units) engine.applyDeletionUnit(h.db, unit); }); h.reopen();
  const global = h.db.getSetting('global');
  assert.equal(global.sentinel, 'latest'); assert.equal(global.hiddenProjectScopes?.[h.root], undefined, 'legacy unscoped mark remains unscoped');
  assert.equal(global.hiddenProjectKinds[h.root], 'delete', 'final hide uses the existing delete kind');
  assert.equal(global.openWorkingSet.length, 3, 'prune only proven selected ID and host/path');
  deep(h.db.getSetting('archivedProjects'), { [remote]: { remote: true } });
  deep(h.db.getSetting('scheduleReenableOffers'), { [remote]: { remote: true } });
  deep(h.db.getSetting('scheduleProjects'), [h.kept[2].projectPath]);
  deep(h.bytes(), h.beforeBytes);
});

test('metadata-only historical provenance participates in stale-scope refusal', supported, t => {
  const h = setup(t), input = h.manifest();
  h.db.setName('historical', 'changed since preview');
  const before = h.db.changeCount();
  assert.throws(() => engine.validateDeletionManifest(h.db, input), { code: 'WRITER_STALE' });
  assert.equal(h.db.changeCount(), before);
});

test('runtime inventory contradictions refuse even with a recomputed membership digest', supported, t => {
  const h = setup(t), input = h.manifest();
  input.inventory.jobs.push({ alias: 'host', projectPath: '/srv/foreign', id: 'job', runtime: 'claude', verified: true });
  input.membershipDigest = shared.membershipDigest(input.project, input.inventory);
  const before = h.db.changeCount();
  assert.throws(() => engine.validateDeletionManifest(h.db, input), { code: 'DELETION_OWNERSHIP' });
  assert.equal(h.db.changeCount(), before);
});

test('settings erasure with only a path key and no independent ownership refuses', supported, t => {
  const h = setup(t, { empty: true });
  for (const row of h.db.getAllCached()) h.db.deleteCachedSession(row.sessionId);
  h.db.connection.exec('DELETE FROM cache_meta'); h.groups.length = 0;
  const input = h.manifest(true, true), before = h.db.changeCount();
  assert.throws(() => engine.validateDeletionManifest(h.db, input), { code: 'SETTINGS_OWNERSHIP_UNKNOWN' });
  assert.equal(h.db.changeCount(), before);
});

test('remote finalization keeps local schedule registration and absent registry is never seeded', supported, t => {
  const h = setup(t);
  const remoteProject = { alias: 'host', projectPath: '/srv/other' }, folderKey = 'host::remote';
  const scope = api().readDurableScope(h.db, { project: remoteProject });
  const groups = [{ ...remoteProject, folderKey, effect: 'selected', runtime: 'claude', verified: true }];
  const members = [{ ...remoteProject, folderKey, id: 'remote', conversationId: 'remote', partId: 'remote', cwd: '/srv/other', runtime: 'claude', verified: true, indexed: true, present: true }];
  const inventory = { groups, members, tabs: [], jobs: [], schedules: [] };
  const input = { project: remoteProject, operationId: operationId(remoteProject, scope.projectEpoch), expectedProjectEpoch: scope.projectEpoch,
    expectedRevision: scope.writerRevision, writerMembershipDigest: scope.writerMembershipDigest, inventory, groups, members,
    membershipDigest: shared.membershipDigest(remoteProject, inventory), options: { sessions: false, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false } };
  const validated = engine.validateDeletionManifest(h.db, input);
  h.db.setSetting('scheduleProjects', ['/srv/other', h.root]);
  commitTransaction(h.db, () => { for (const unit of engine.buildFinalizationUnits(validated)) engine.applyDeletionUnit(h.db, unit); });
  deep(h.db.getSetting('scheduleProjects'), ['/srv/other', h.root]);
  h.db.deleteSetting('scheduleProjects');
  commitTransaction(h.db, () => { for (const unit of engine.buildFinalizationUnits(validated)) engine.applyDeletionUnit(h.db, unit); });
  assert.equal(h.db.getSetting('scheduleProjects'), null);
});

test('finalization removes selected archive spellings by canonical identity and prunes transcriptless saved tabs', supported, t => {
  const h = setup(t), input = h.manifest();
  input.inventory.tabs.push({ ...h.project, id: 'dormant-terminal', runtime: 'terminal', verified: true, cwd: null });
  input.membershipDigest = shared.membershipDigest(input.project, input.inventory);
  const validated = api().validateDeletionManifest(h.db, input), alternate = h.root + path.sep;
  h.db.setSetting('archivedProjects', { [alternate]: { selected: true }, 'host::/elsewhere': { kept: true } });
  h.db.setSetting('scheduleReenableOffers', { [alternate]: { selected: true }, 'host::/elsewhere': { kept: true } });
  h.db.setSetting('global', { hiddenProjects: [alternate], openWorkingSet: [{ sessionId: 'dormant-terminal', projectPath: h.root }] });
  commitTransaction(h.db, () => { for (const unit of engine.buildFinalizationUnits(validated)) engine.applyDeletionUnit(h.db, unit); });
  h.reopen();
  deep(h.db.getSetting('archivedProjects'), { 'host::/elsewhere': { kept: true } }, 'all selected identity spellings removed directly');
  deep(h.db.getSetting('scheduleReenableOffers'), { 'host::/elsewhere': { kept: true } });
  deep(h.db.getSetting('global').openWorkingSet, [], 'proven transcriptless saved tab pruned');
  assert.equal(h.db.getSetting('global').hiddenProjectScopes?.[alternate], undefined, 'legacy spelling stays unscoped');
  assert.ok(validated.invalidation.restoreTargets.some(row => row.sessionId === 'dormant-terminal'));
});

test('selected staging is gone before completion while kept staging can publish between chunks', supported, t => {
  const h = setup(t), input = h.manifest(), validated = api().validateDeletionManifest(h.db, input);
  const units = engine.buildDeletionUnits(validated), manifest = { ...input, units }, p = createProjectDeleteProgress(h.db);
  h.db.beginSearchEntry('selected-token', { id: 'agent', type: 'session', folder: 'selected-a' });
  h.db.beginSearchEntry('kept-token', { id: 'mixed', type: 'session', folder: 'selected-a' });
  p.admit(manifest);
  while (p.read(manifest).stagedUnits < units.length) { const n = p.read(manifest).stagedUnits; p.stage(manifest, units.slice(n, n + 16)); }
  p.apply(manifest, unit => engine.applyDeletionUnit(h.db, unit));
  assert.equal(p.read(manifest).state, 'inProgress');
  assert.equal(p.read(manifest).nextUnit, 1);
  h.db.appendSearchBody('selected-token', 'late old body');
  assert.throws(() => h.db.publishSearchEntry('selected-token'), /staging entry missing/, 'selected old publication refused between chunks');
  assert.doesNotThrow(() => h.db.publishSearchEntry('kept-token'));
  assert.equal(h.db.connection.prepare("SELECT COUNT(*) AS n FROM session_metrics WHERE sessionId='agent'").get().n, 0, 'selected metrics invalidated with its unit');
  assert.equal(h.db.connection.prepare("SELECT COUNT(*) AS n FROM session_metrics WHERE sessionId='mixed'").get().n, 1, 'kept metrics retained');
});

for (const defect of ['missing-epoch', 'unknown-field', 'linked-member', 'missing-part']) test(`manifest shape rejects ${defect}`, supported, t => {
  const h = setup(t), input = h.manifest();
  if (defect === 'missing-epoch') delete input.expectedProjectEpoch;
  if (defect === 'unknown-field') input.purgeAll = true;
  if (defect === 'linked-member') input.members[0].linked = true;
  if (defect === 'missing-part') delete input.members[0].partId;
  input.membershipDigest = shared.membershipDigest(input.project, input.inventory);
  const before = h.db.changeCount();
  assert.throws(() => engine.validateDeletionManifest(h.db, input), error => typeof error.code === 'string', 'invalid shape must refuse');
  assert.equal(h.db.changeCount(), before);
});

test('legacy visibility scope without an alias remains unscoped during finalization', supported, t => {
  const h = setup(t), validated = api().validateDeletionManifest(h.db, h.manifest());
  h.db.setSetting('global', { hiddenProjects: [h.root], hiddenProjectScopes: { [h.root]: {} } });
  assert.doesNotThrow(() => commitTransaction(h.db, () => { for (const unit of engine.buildFinalizationUnits(validated)) engine.applyDeletionUnit(h.db, unit); }), 'legacy scope without alias must remain usable');
  deep(h.db.getSetting('global').hiddenProjectScopes[h.root], {});
});

test('historical bridge metadata is selected only through its durable bridge link', supported, t => {
  const h = setup(t);
  h.db.upsertCachedSessions([{ ...h.selected[0], bridgeSessionId: 'cse_legacy' }]);
  h.db.setName('cse_legacy', 'legacy bridge name');
  h.members.push({ ...h.members[0], id: 'cse_legacy', partId: 'cse_legacy', metadataOnly: true });
  const input = h.manifest(false, true);
  assert.doesNotThrow(() => execute(h, input), 'bridge history has independent durable ownership');
  h.reopen();
  assert.equal(h.db.getMeta('cse_legacy'), null);
  assert.equal(h.db.projectDeletion.metadataFields().some(row => row.sessionId === 'cse_legacy'), false);
  assert.ok(h.db.getMeta('orphan'));
});

test('remote settings keys preserve POSIX case even when the writer runs on Windows', supported, t => {
  const h = setup(t), project = { alias: 'host', projectPath: '/srv/other' }, folderKey = 'host::remote';
  h.db.setSetting('project:/srv/Other', { sentinel: 'different case project' });
  const scope = api().readDurableScope(h.db, { project });
  const groups = [{ ...project, folderKey, runtime: 'claude', verified: true, effect: 'selected' }];
  const members = [{ ...project, folderKey, id: 'remote', conversationId: 'remote', partId: 'remote', cwd: project.projectPath, runtime: 'claude', verified: true, indexed: true, present: true }];
  const inventory = { groups, members, tabs: [], jobs: [], schedules: [] };
  const input = { project, operationId: operationId(project, scope.projectEpoch), expectedProjectEpoch: scope.projectEpoch,
    expectedRevision: scope.writerRevision, writerMembershipDigest: scope.writerMembershipDigest, inventory, groups, members,
    membershipDigest: shared.membershipDigest(project, inventory), options: { sessions: false, settings: true, schedules: false, transcripts: false, stopBackgroundJobs: false } };
  execute(h, input); h.reopen();
  deep(h.db.getSetting('project:/srv/Other'), { sentinel: 'different case project' }, 'unselected POSIX case-sensitive settings key stays');
  assert.equal(h.db.getSetting('project:/srv/other'), null);
});
