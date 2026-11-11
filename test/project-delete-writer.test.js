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
  const reopen = () => { db.closeDb(); db = openStore(); }, readers = [];
  const openReader = () => { const reader = openStore({ readonly: true }); readers.push(reader); return reader; };
  t.after(() => { for (const reader of readers) if (reader.connection.open) reader.closeDb(); db.closeDb(); if (prior === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = prior; fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, root, project, groups, members, selected, kept, manifest, reopen, bytes, beforeBytes, journal, requestInput, openReader };
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

for (const boundary of ['admission', 'fence', 'tiny']) test(`FIX2 producers received during ${boundary} BUSY backoff retain their epoch`, supported, async t => {
  const tiny = boundary === 'tiny', h = setup(t, { empty: tiny });
  if (tiny) h.groups.length = 0;
  const input = h.manifest(false, true), before = h.db.getSetting('_writer_revision');
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const transact = h.db.transact, during = [];
  let injected = false;
  h.db.transact = fn => {
    if (!injected) {
      injected = true;
      queueMicrotask(() => {
        assert.equal(h.db.projectDeletion.hasHistory(), false, 'producers arrive before durable deletion history');
        during.push(worker.post('upsertCachedSessions', [{ sessionId: 'head', folder: h.groups[0]?.folderKey || 'selected-a', projectPath: h.root, messageCount: 2 }]));
        during.push(worker.post('upsertSearchEntries', [{ id: 'head', type: 'session', folder: 'selected-a', body: 'late resurrected body' }]));
        during.push(worker.post('setName', 'head', 'late resurrected name'));
      });
      throw Object.assign(new Error('admission lock contention'), { code: 'SQLITE_BUSY' });
    }
    return transact(fn);
  };
  const reply = await worker.post(boundary === 'fence' ? 'fenceProjectDeletion' : 'completeProjectDeletion', input);
  const replies = await Promise.all(during);
  assert.equal(injected, true);
  assert.equal(replies.length, 3);
  for (const [index, producer] of replies.entries()) assert.equal(producer.error?.code, 'PROJECT_EPOCH_STALE', `producer ${index} received during ${boundary} backoff must be refused`);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.state, boundary === 'fence' ? 'notStarted' : 'committed');
  if (boundary === 'fence') {
    assert.equal(h.db.getMeta('head').name, 'app head');
    assert.equal(h.db.getCachedSession('head').messageCount, 1);
    assert.equal(h.db.connection.prepare("SELECT body FROM search_content JOIN search_map USING(rowid) WHERE id='head'").get().body, 'sentinel');
  } else {
    assert.equal(h.db.getMeta('head'), null, 'erased names stay erased');
    assert.equal(h.db.getCachedSession('head'), null, 'erased cache stays erased');
    assert.equal(h.db.connection.prepare("SELECT count(*) AS n FROM search_map WHERE id='head'").get().n, 0, 'erased search stays erased');
    if (tiny) assert.equal(reply.result.lastRevision, before + 1, 'tiny deletion commits once');
  }
});

for (const [command, args] of [
  ['setName', ['uncached', 'saved name']], ['toggleStar', ['uncached']],
  ['setSetting', ['continuationChoice:uncached', 'chosen']],
  ['upsertSearchEntries', [[{ id: 'uncached', type: 'session', folder: 'unknown', body: 'find me' }]]],
]) test(`FIX474 reopen alone preserves uncached ${command}`, supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  assert.equal((await worker.post('revealAddedProject', h.root)).error, undefined);
  assert.equal((await worker.post(command, ...args)).error, undefined, 'unblocked reopen is not deletion history');
  if (command === 'setName') assert.equal(h.db.getMeta('uncached').name, 'saved name');
  if (command === 'toggleStar') assert.equal(h.db.getMeta('uncached').starred, 1);
  if (command === 'setSetting') assert.equal(h.db.getSetting(args[0]), 'chosen');
  if (command === 'upsertSearchEntries') assert.equal(h.db.connection.prepare("SELECT count(*) AS n FROM search_map WHERE id='uncached'").get().n, 1);
});

test('FIX474 startup continuation sweep completes after Add project', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  await worker.post('revealAddedProject', h.root);
  const filename = require.resolve('../main.js');
  const source = require('./app-source').extractFunction(fs.readFileSync(filename, 'utf8'), 'sweepContinuationChoices');
  const context = { isInitialScanComplete: () => true, getAllCached: h.db.getAllCached, listSettingKeys: h.db.listSettingKeys,
    deleteSetting: key => worker.client.request('deleteSetting', key) };
  require('node:vm').runInNewContext(source, context, { filename });
  await assert.doesNotReject(context.sweepContinuationChoices(), 'startup sweep must complete');
  assert.equal(h.db.getSetting('continuationChoice:orphan'), null);
  assert.ok(h.db.getSetting('continuationChoice:head'));
});

for (const batch of [false, true]) test(`FIX474 cross-project links without deletion preserve writes batch=${batch}`, supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  h.db.upsertCachedSessions([{ ...h.kept[0], parentSessionId: 'head' }]);
  const reply = batch ? await worker.post('effects', [
    { name: 'setName', args: ['head', 'ambiguous accepted'] }, { name: 'setName', args: ['remote', 'other accepted'] },
  ], h.db.getSetting('_writer_revision') || 0) : await worker.post('setName', 'head', 'ambiguous accepted');
  assert.equal(reply.error, undefined, 'ordinary shared links cannot refuse a producer');
  assert.equal(h.db.getMeta('head').name, 'ambiguous accepted');
  if (batch) assert.equal(h.db.getMeta('remote').name, 'other accepted');
});

test('FIX474 ordinary producers perform zero ownership scans or realpath calls', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  await worker.post('revealAddedProject', h.root);
  const counts = { cached: 0, folders: 0, realpath: 0 };
  for (const [method, key] of [['getAllCached', 'cached'], ['getAllFolderMeta', 'folders']]) {
    const original = h.db[method]; h.db[method] = (...args) => { counts[key]++; return original(...args); };
  }
  const realpath = fs.realpathSync.native;
  fs.realpathSync.native = (...args) => { counts.realpath++; return realpath(...args); };
  try {
    for (const [command, args] of [['setName', ['head', 'new']], ['upsertCachedSessions', [[h.selected[0]]]],
      ['upsertSearchEntries', [[{ id: 'head', type: 'session', folder: 'selected-a', body: 'ordinary indexing' }]]],
      ['effects', [[{ name: 'setName', args: ['head', 'effect'] }], h.db.getSetting('_writer_revision') || 0]]]) {
      if (command === 'effects') args[1] = h.db.getSetting('_writer_revision');
      assert.equal((await worker.post(command, ...args)).error, undefined);
    }
  } finally { fs.realpathSync.native = realpath; }
  assert.deepEqual(counts, { cached: 0, folders: 0, realpath: 0 }, 'normal indexing must not inspect project ownership');
});

test('FIX474 malformed supplied path does not poison sibling cache targets', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const reply = await worker.post('upsertCachedSessions', [{ sessionId: 'bad-path', folder: 'bad', projectPath: 'relative' }, h.kept[0]]);
  assert.equal(reply.error, undefined, 'legacy relative paths remain accepted without deletion');
  assert.equal(h.db.getCachedSession('bad-path').projectPath, 'relative');
  assert.ok(h.db.getCachedSession('mixed'));
});

for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT']) test(`FIX474 deletion retries ${code} without sealing partial`, supported, async t => {
  const h = setup(t), input = h.manifest(true, true), original = h.db.transact;
  let injected = false;
  h.db.transact = fn => {
    if (!injected && h.db.projectDeletion.operation(input.operationId)?.sealed === 0) {
      injected = true; throw Object.assign(new Error('transient writer contention'), { code });
    }
    return original(fn);
  };
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const reply = await worker.post('completeProjectDeletion', input);
  assert.equal(injected, true);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.state, 'committed', 'busy must reach worker retry instead of sealing partial');
});

test('FIX474 deletion history resolves only target owners and folders', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  assert.equal((await worker.post('completeProjectDeletion', h.manifest(false, true))).result.state, 'committed');
  const calls = { cached: 0, folders: 0, operations: 0 }, ids = [], folders = [];
  for (const [method, key] of [['getAllCached', 'cached'], ['getAllFolderMeta', 'folders']]) {
    const original = h.db[method]; h.db[method] = (...args) => { calls[key]++; return original(...args); };
  }
  for (const method of ['active', 'terminal']) {
    const original = h.db.projectDeletion[method]; h.db.projectDeletion[method] = (...args) => { calls.operations++; return original(...args); };
  }
  if (h.db.projectDeletion.ownerRows) {
    const original = h.db.projectDeletion.ownerRows;
    h.db.projectDeletion.ownerRows = id => { ids.push(id); return original(id); };
  }
  const getFolder = h.db.getFolderMeta;
  h.db.getFolderMeta = folder => { folders.push(folder); return getFolder(folder); };
  assert.equal((await worker.post('upsertCachedSessions', [h.kept[1]])).error, undefined);
  assert.deepEqual(calls, { cached: 0, folders: 0, operations: 0 }, 'deletion history must not rescan unrelated ownership');
  assert.deepEqual(ids, ['remote']); assert.deepEqual(folders, ['host::remote']);
});

test('FIX2 known session owner does not load its entire folder after deletion', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  assert.equal((await worker.post('completeProjectDeletion', h.manifest(false, true))).result.state, 'committed');
  const getCachedByFolder = h.db.getCachedByFolder, loaded = [];
  h.db.getCachedByFolder = folder => { loaded.push(folder); return getCachedByFolder(folder); };
  assert.equal((await worker.post('upsertCachedSessions', [h.kept[1]])).error, undefined);
  assert.equal((await worker.post('upsertSearchEntries', [{ id: 'remote', type: 'session', folder: 'host::remote', body: 'kept' }])).error, undefined);
  assert.deepEqual(loaded, [], 'known target IDs must not materialize folder siblings');
});

test('FIX474 ambiguous deleted target and malformed path do not poison unrelated batch targets', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  assert.equal((await worker.post('completeProjectDeletion', h.manifest(false, true))).result.state, 'committed');
  h.db.upsertCachedSessions([{ ...h.kept[0], parentSessionId: 'head' }]);
  const reply = await worker.post('effects', [
    { name: 'setName', args: ['head', 'must refuse'] },
    { name: 'upsertCachedSessions', args: [[{ sessionId: 'bad-path', folder: 'bad', projectPath: 'relative' }]] },
    { name: 'setName', args: ['remote', 'sibling survived'] },
  ], h.db.getSetting('_writer_revision'));
  assert.equal(h.db.getMeta('remote').name, 'sibling survived', 'refusal is per target, even before an unrelated sibling');
  assert.equal(reply.error?.code, 'DELETION_OWNERSHIP');
  assert.equal(h.db.getMeta('head'), null, 'refused name must not resurrect erased metadata');
  assert.equal(h.db.getCachedSession('bad-path'), null);
});

test('FIX474 shared owners unrelated to a deletion bind together and remain writable', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  assert.equal((await worker.post('completeProjectDeletion', h.manifest(false, true))).result.state, 'committed');
  h.db.upsertCachedSessions([{ ...h.kept[0], continuationIndex: JSON.stringify({ ids: ['shared-id'] }) },
    { ...h.kept[1], bridgeSessionId: 'shared-id' }]);
  const reply = await worker.post('setName', 'shared-id', 'both unrelated');
  assert.equal(reply.error, undefined, 'only deletion-related candidate ambiguity refuses');
  assert.equal(h.db.getMeta('shared-id').name, 'both unrelated');
});

test('FIX474 ownership index refreshes after history is purged and deletion protection returns', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db), input = h.manifest(false, true);
  assert.equal((await worker.post('completeProjectDeletion', input)).result.state, 'committed');
  assert.equal((await worker.post('setName', 'remote', 'indexed owner')).error, undefined);
  const proof = await worker.client.request('readProjectArchiveEpochs', [h.project], true);
  assert.equal((await worker.post('revealAddedProject', h.root, proof)).error, undefined);
  h.db.projectDeletion.purgeOperation(input.operationId);
  assert.equal((await worker.post('upsertCachedSessions', [{ ...h.kept[1], bridgeSessionId: 'post-purge-link' }])).error, undefined);
  h.db.projectDeletion.setFence(shared.identity(h.project).key, 4, null, 1);
  const reply = await worker.post('setName', 'post-purge-link', 'fresh owner');
  assert.equal(reply.error, undefined, 'an unrelated link written without history remains owned when protection returns');
  assert.equal(h.db.getMeta('post-purge-link').name, 'fresh owner');
});

for (const command of ['deleteCachedFolder', 'dropRemoteFolder']) test(`FIX474 ${command} retains its folder fence on nested session units`, supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  h.db.projectDeletion.setFence(shared.identity(h.project).key, 1, null, 1);
  const reply = await worker.post(command, 'selected-b');
  assert.equal(reply.error?.code, 'PROJECT_EPOCH_STALE');
  assert.ok(h.db.getCachedSession('continuation'), 'nested row deletion must inherit the blocked folder fence');
  assert.ok(h.db.getFolderMeta('selected-b'));
});

test('COMPLETE archives retained metadata, keeps unselected settings and seals final logical removal', supported, async t => {
  const h = setup(t), input = h.manifest();
  h.db.setSetting('scheduleProjects', [h.root, '/kept']);
  h.db.setSetting('archivedProjects', { [h.root]: { knownSessionIds: [], disabledSchedules: ['kept.md'] } });
  h.db.setSetting('scheduleReenableOffers', { [h.root]: { disabledSchedules: ['kept.md'] } });
  const fresh = h.manifest(); Object.assign(input, fresh);
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const reply = await worker.post('completeProjectDeletion', input);
  assert.equal(reply.error, undefined, 'complete command must execute the exact manifest');
  assert.equal(reply.result.state, 'committed');
  assert.equal(reply.result.projectHidden, true);
  assert.equal(reply.result.metadata.length, h.members.length, 'committed readback observes retained metadata after cache removal');
  for (const member of h.members) { assert.equal(h.db.getMeta(member.id).archived, 1); assert.equal(h.db.getMeta(member.id).name, 'app ' + member.id); }
  deep(h.db.getSetting('project:' + h.root), { sentinel: 'selected settings' }, 'A-erase-unselected-settings: settings=false retains selected sentinel');
  assert.equal(h.db.getSetting('archivedProjects')[h.root], undefined);
  assert.equal(h.db.getSetting('scheduleReenableOffers')[h.root], undefined);
  deep(h.db.getSetting('scheduleProjects'), ['/kept']);
  deep(h.bytes(), h.beforeBytes);
  const revision = h.db.getSetting('_writer_revision');
  const duplicate = await worker.post('completeProjectDeletion', input);
  assert.equal(duplicate.error, undefined); assert.equal(duplicate.result.state, 'committed');
  assert.equal(h.db.getSetting('_writer_revision'), revision, 'same hash never re-enters destructive work');
  const mismatch = await worker.post('completeProjectDeletion', { ...input, options: { ...input.options, settings: true } });
  assert.equal(mismatch.error?.code, 'DELETION_HASH');
});

test('COMPLETE interrupted chunks persist partial prefix without hiding or unregistering', supported, async t => {
  const h = setup(t);
  h.db.setSetting('scheduleProjects', [h.root]);
  const input = h.manifest(true, true), reader = h.openReader();
  const original = h.db.transact;
  let injected = false, commits = 0, prefixHidden;
  h.db.transact = fn => {
    const result = original(fn); commits++;
    const operation = reader.projectDeletion.operation(input.operationId);
    if (!injected && operation?.nextUnit > 0 && !operation.sealed) {
      injected = true;
      prefixHidden = reader.getSetting('global').hiddenProjects?.includes(h.root) || false;
      deep(reader.getSetting('scheduleProjects'), [h.root], 'registration remains until final unit');
      original(() => h.db.setSetting('_writer_revision', (h.db.getSetting('_writer_revision') || 0) + 1));
    }
    return result;
  };
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const reply = await worker.post('completeProjectDeletion', input);
  assert.equal(prefixHidden, false, 'B4-hide-before-last-unit: partial prefix remains visible');
  assert.equal(reply.error, undefined, 'failure must return durable partial state');
  assert.equal(injected, true, 'intermediate real-store commit observed');
  assert.equal(reply.result.state, 'partial', 'B4-no-chunk-revision-fence: unrelated revision seals remainder partial');
  assert.equal(reply.result.projectHidden, false);
  assert.ok(reply.result.completed.length > 0); assert.ok(reply.result.remaining.length > 0);
  assert.ok(commits > 2);
  deep(reader.getSetting('scheduleProjects'), [h.root]);
  reader.closeDb();
});

test('COMPLETE tiny empty manifest commits admission and finalization in one transaction', supported, async t => {
  const h = setup(t, { empty: true }); h.groups.length = 0;
  const input = h.manifest(), before = h.db.getSetting('_writer_revision');
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const reply = await worker.post('completeProjectDeletion', input);
  assert.equal(reply.error, undefined, 'tiny complete command is executable');
  assert.equal(reply.result.state, 'committed');
  assert.equal(reply.result.lastRevision, before + 1, 'tiny completion has one exact commit revision');
});

test('COMPLETE refuses shared-host settings without mutation and leaves #380 journal intact', supported, async t => {
  const h = setup(t, { sharedHost: true }), input = h.manifest(true, true);
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db), before = h.db.changeCount();
  const refused = await worker.post('completeProjectDeletion', input);
  assert.equal(refused.error?.code, 'SHARED_SETTINGS', 'complete repeats durable shared-key ownership checks');
  assert.equal(h.db.changeCount(), before);
  const kept = await worker.post('completeProjectDeletion', h.manifest(false, true));
  assert.equal(kept.error, undefined); assert.equal(kept.result.state, 'committed');
  deep(createWriterCommands(h.db).querySessionRequestOutcome({ stemKey: h.requestInput.stemKey, rawHash: h.requestInput.rawHash }).owner, h.journal.owner);
  assert.equal(h.db.getMeta('head'), null);
});

test('COMPLETE fences staged search publication and new selected producers until explicit re-add', supported, async t => {
  const h = setup(t); h.db.nextChunkSize = () => 1;
  let launch, deletion, captured = false;
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db, message => {
    if (message.started && !captured) {
      captured = true;
      queueMicrotask(() => { deletion = worker.post('completeProjectDeletion', h.manifest(false, true)); launch(); });
    }
  });
  const launched = new Promise(resolve => { launch = resolve; });
  const search = worker.post('upsertSearchEntries', [{ id: 'head', type: 'session', folder: 'selected-a', body: 'queued stale body' }]);
  await launched;
  const done = await deletion, old = await search;
  assert.equal(done.error, undefined, 'deletion takes priority over the old publication');
  assert.equal(done.result.state, 'committed');
  assert.equal(old.error?.code, 'PROJECT_EPOCH_STALE', 'publishSearchEntry must recheck the received epoch');
  for (const [command, args] of [
    ['upsertSearchEntries', [[{ id: 'head', type: 'session', folder: 'selected-a', body: 'new stale body' }]]],
    ['upsertCachedSessions', [[h.selected[0]]]], ['setName', ['head', 'resurrection']],
  ]) {
    const blocked = await worker.post(command, ...args);
    assert.equal(blocked.error?.code, 'PROJECT_EPOCH_STALE', `${command} stays blocked after commit`);
  }
  assert.equal(h.db.connection.prepare("SELECT COUNT(*) AS n FROM search_map WHERE id='head'").get().n, 0);
  const commands = createWriterCommands(h.db);
  commitTransaction(h.db, () => commands.revealAddedProject(h.root, commands.readProjectArchiveEpochs([h.project], true)));
  assert.equal((await worker.post('upsertCachedSessions', [h.selected[0]])).error, undefined, 'fresh producer works after explicit re-add');
});

test('A-revive-deleted-offer: COMPLETE rejects fetched old archive and offer completions even after re-add', supported, async t => {
  const h = setup(t), commands = createWriterCommands(h.db);
  h.db.setSetting('scheduleReenableOffers', { [h.root]: { disabledSchedules: ['kept.md'] } });
  const proof = commands.readProjectArchiveEpochs([h.project]);
  const offer = commands.beginOffer(h.root, proof);
  const accepted = commitTransaction(h.db, () => commands.beginArchive([{ entry: h.root, record: { knownSessionIds: [] }, disabledFiles: [] }], proof)).result;
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const reply = await worker.post('completeProjectDeletion', h.manifest());
  assert.equal(reply.error, undefined, 'complete command seals the deletion epoch');
  commitTransaction(h.db, () => commands.revealAddedProject(h.root, commands.readProjectArchiveEpochs([h.project], true)));
  let staleError;
  try { commands.completeOffer(h.root, offer, { enabled: [], failed: [] }, proof); } catch (error) { staleError = error; }
  assert.equal(h.db.getSetting('scheduleReenableOffers')[h.root], undefined, 'A-revive-deleted-offer: stale completion cannot persist fetched offer after COMPLETE');
  assert.throws(() => { if (staleError) throw staleError; }, { code: 'PROJECT_EPOCH_STALE' }, 'A-revive-deleted-offer: fetched offer cannot resurrect deleted identity');
  assert.throws(() => commands.completeArchive(accepted, {}, proof), { code: 'PROJECT_EPOCH_STALE' });
  assert.equal(h.db.getSetting('scheduleReenableOffers')[h.root], undefined);
});

for (const boundary of ['before', 'prefix', 'final']) test(`COMPLETE facade retains unknown ${boundary} ACK hold until terminal fence/readback`, supported, async t => {
  const h = setup(t), input = h.manifest();
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db), notifications = [];
  const client = { ...worker.client };
  let submissions = 0, lose = true;
  client.request = async (name, ...args) => {
    if (name === 'completeProjectDeletion') {
      submissions++;
      if (boundary === 'final') await worker.client.request(name, ...args);
      if (boundary === 'prefix') {
        const iterator = engine.completeProjectDeletion(h.db, args[0]);
        iterator.next().value(); iterator.next().value(); iterator.next().value();
      }
      if (lose) { lose = false; throw Object.assign(new Error('ACK outcome unknown'), { code: 'WRITER_TIMEOUT' }); }
    }
    return worker.client.request(name, ...args);
  };
  const writer = createSessionIndexWriter({ client, readonlyBackend: h.db, onSessionsChanged: ids => notifications.push(ids) }, {});
  await writer.ready;
  assert.equal(typeof writer.completeProjectDeletion, 'function', 'facade must expose the complete command');
  await assert.rejects(writer.completeProjectDeletion(input), { code: 'WRITER_TIMEOUT' });
  assert.equal(notifications.length, 0, 'exception never publishes invalidations');
  assert.throws(() => writer.reserveProjectDeletion([h.project]), { code: 'WORKFLOW_BUSY' }, 'unknown ACK retains exclusion');
  const observed = await writer.getProjectDeletionState(input);
  assert.equal(observed.state, boundary === 'before' ? 'absent' : boundary === 'prefix' ? 'inProgress' : 'committed');
  if (boundary !== 'final') {
    assert.throws(() => writer.reserveProjectDeletion([h.project]), { code: 'WORKFLOW_BUSY' }, 'nonterminal observation retains exclusion');
    const fenced = await writer.fenceProjectDeletion(input);
    assert.equal(fenced.state, boundary === 'before' ? 'notStarted' : 'partial');
    assert.equal(fenced.noLateCommit, true);
    const late = await worker.post('completeProjectDeletion', input);
    assert.ok(late.error || late.result.terminal, 'late request never re-enters a sealed operation');
  } else deep(notifications, [h.members.map(row => row.id).sort()], 'positively reconciled commit publishes exact invalidations');
  const hold = writer.reserveProjectDeletion([h.project]); await hold.ready; hold.release();
  assert.equal(submissions, 1, 'reconciliation never replays complete');
});

test('COMPLETE rechecks current ownership inside each chunk despite unchanged revision', supported, async t => {
  const h = setup(t), input = h.manifest(false, true), transact = h.db.transact;
  let changed = false;
  h.db.transact = fn => {
    const value = transact(fn), row = h.db.projectDeletion.operation(input.operationId);
    if (!changed && row?.nextUnit > 0 && !row.sealed) {
      changed = true;
      h.db.upsertCachedSessions([{ ...h.selected[0], projectPath: path.join(h.root, 'foreign') }]);
    }
    return value;
  };
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db), reply = await worker.post('completeProjectDeletion', input);
  assert.equal(reply.error, undefined);
  assert.equal(changed, true);
  assert.equal(reply.result.state, 'partial', 'changed ownership seals remaining deletion before effects');
  assert.equal(reply.result.projectHidden, false);
  assert.ok(h.db.getCachedSession('head'), 'foreign row survives');
});

test('COMPLETE large manifest stages before effects and exposes exact receipts on every real commit', supported, async t => {
  const h = setup(t);
  const extra = Array.from({ length: 48 }, (_, i) => ({ ...h.selected[0], sessionId: 'bulk-' + i, continuationIndex: null }));
  h.db.upsertCachedSessions(extra);
  for (const row of extra) { h.db.setName(row.sessionId, 'bulk'); h.members.push({ ...h.members[0], id: row.sessionId, partId: row.sessionId }); }
  const input = h.manifest(true, true), reader = openStore({ readonly: true }), transact = h.db.transact;
  let commits = 0, preparing = 0, applying = 0;
  try {
    h.db.transact = fn => {
      const result = transact(fn), row = reader.projectDeletion.operation(input.operationId);
      if (row) {
        commits++;
        assert.equal(row.lastRevision, reader.getSetting('_writer_revision'), 'every receipt revision is visible with its exact commit');
        if (row.phase === 'preparing') { preparing++; assert.equal(reader.getMeta('head').name, 'app head', 'staging has no metadata effects'); }
        if (!row.sealed) { applying += row.nextUnit > 0 ? 1 : 0; assert.equal(reader.getSetting('global').hiddenProjects?.includes(h.root) || false, false, 'no prefix hides project'); }
      }
      return result;
    };
    const worker = require('./fixtures/project-deletion-worker.cjs')(h.db), reply = await worker.post('completeProjectDeletion', input);
    assert.equal(reply.error, undefined); assert.equal(reply.result.state, 'committed');
    assert.ok(preparing > 1 && applying > 1 && commits > 48, 'bounded staging and effects yield observable intermediate commits');
    assert.equal(reader.getMeta('head'), null); assert.equal(reader.getSetting('project:' + h.root), null);
    assert.equal(reply.result.completed.at(-1).category, 'finalize');
    deep(h.bytes(), h.beforeBytes);
  } finally { reader.closeDb(); }
});

test('COMPLETE duplicate of partially staged manifest returns recorded state without restaging', supported, async t => {
  const h = setup(t), input = h.manifest(), iterator = engine.completeProjectDeletion(h.db, input);
  iterator.next().value();
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const before = h.db.changeCount(), reply = await worker.post('completeProjectDeletion', input);
  assert.equal(reply.error, undefined, 'same hash duplicate after unstaged recovery returns recorded status');
  assert.equal(reply.result.state, 'partial');
  assert.equal(reply.result.unstagedUnits, reply.result.totalUnits);
  assert.equal(reply.result.metadata.length, h.members.length, 'unstaged readback keeps fresh durable metadata observations');
  assert.equal(h.db.changeCount(), before, 'duplicate never restages or applies units');
});

test('COMPLETE responsive transport timeout keeps exclusion through late ACK until fresh readback', supported, async t => {
  const h = setup(t), input = h.manifest(), { EventEmitter } = require('node:events');
  const { createWriterWorkerClient } = require('../session-index-writer-client');
  const port = new EventEmitter(), timers = new Set(), notifications = [], mirrors = [];
  let delayed;
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  port.terminate = async () => 0;
  port.postMessage = message => {
    port.emit('message', { id: message.id, started: true });
    if (message.command === 'completeProjectDeletion') { delayed = message; return; }
    void worker.post(message.command, ...message.args).then(reply => port.emit('message', { ...reply, id: message.id }));
  };
  const client = createWriterWorkerClient({ workerFactory: () => port, timeoutMs: 27,
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); },
    onSettings: entries => mirrors.push(entries) });
  const writer = createSessionIndexWriter({ client, readonlyBackend: h.db, onSessionsChanged: ids => notifications.push(ids) }, {});
  port.emit('message', { ready: true, settings: [] }); await writer.ready;
  try {
    const executing = writer.completeProjectDeletion(input), rejected = assert.rejects(executing, { code: 'WRITER_TIMEOUT' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(delayed, 'completion posted once to responsive worker');
    const deadline = [...timers].find(timer => timer.ms === 27); assert.ok(deadline); deadline.fn();
    await rejected;
    port.emit('message', { heartbeat: true });
    const late = await worker.post(delayed.command, ...delayed.args);
    port.emit('message', { ...late, id: delayed.id });
    assert.ok(mirrors.length > 1, 'late ACK still updates transport settings');
    assert.equal(notifications.length, 0, 'late transport ACK alone never publishes facade completion');
    assert.throws(() => writer.reserveProjectDeletion([h.project]), { code: 'WORKFLOW_BUSY' });
    assert.equal((await writer.getProjectDeletionState(input)).state, 'committed');
    deep(notifications, [h.members.map(row => row.id).sort()]);
    const hold = writer.reserveProjectDeletion([h.project]); await hold.ready; hold.release();
  } finally { await client.terminate(); }
});

test('COMPLETE reports an indivisible oversized final setting measurement', supported, async t => {
  const h = setup(t, { empty: true }); h.groups.length = 0;
  h.db.setSetting('global', { sentinel: 'oversized', payload: 'x'.repeat(180000), openWorkingSet: [] });
  const input = h.manifest(), worker = require('./fixtures/project-deletion-worker.cjs')(h.db), reply = await worker.post('completeProjectDeletion', input);
  assert.equal(reply.error, undefined); assert.equal(reply.result.state, 'committed');
  const oversized = h.db.measurements().filter(sample => sample.bytes > 65536);
  assert.ok(oversized.length > 0, 'indivisible final write is measured rather than called hard-bounded');
  t.diagnostic('oversized final measurements: ' + JSON.stringify(oversized));
});

test('COMPLETE fenced prefix permits fresh reindex and a new cleanup manifest without replaying old deletion', supported, async t => {
  const h = setup(t), input = h.manifest(false, true);
  let worker, fenced, queued = false;
  const transact = h.db.transact;
  h.db.transact = fn => {
    const result = transact(fn), row = h.db.projectDeletion.operation(input.operationId);
    if (!queued && row?.nextUnit > 0 && !row.sealed) {
      queued = true;
      queueMicrotask(() => { fenced = worker.post('fenceProjectDeletion', input); });
    }
    return result;
  };
  worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const old = await worker.post('completeProjectDeletion', input);
  assert.equal(old.error, undefined); assert.equal(old.result.state, 'partial');
  assert.equal(Object.hasOwn(old, 'settings'), true, 'prefix ACK retains settings publication after an intervening fence');
  assert.equal((await fenced).result.noLateCommit, true);
  const revision = h.db.getSetting('_writer_revision');
  assert.equal((await worker.post('completeProjectDeletion', input)).result.state, 'partial');
  assert.equal(h.db.getSetting('_writer_revision'), revision, 'old command cannot replay');
  const reindex = await worker.post('upsertCachedSessions', h.selected);
  assert.equal(reindex.error, undefined, 'freshly bound reindex after sealed partial is allowed');
  const fresh = await worker.post('completeProjectDeletion', h.manifest(false, true));
  assert.equal(fresh.error, undefined, 'fresh cleanup admission accepts sealed partial epoch');
  assert.equal(fresh.result.state, 'committed');
});

for (const boundary of ['before', 'prefix', 'final']) test(`COMPLETE store replacement after ${boundary} seals recovery before ready and never replays`, supported, async t => {
  const h = setup(t), input = h.manifest(false, true);
  if (boundary === 'prefix') {
    const iterator = engine.completeProjectDeletion(h.db, input);
    iterator.next().value(); iterator.next().value(); iterator.next().value();
  } else if (boundary === 'final') for (const step of engine.completeProjectDeletion(h.db, input)) step();
  h.reopen();
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db), ready = worker.messages.find(message => message.ready);
  assert.equal(ready.recoveredProjectDeletions.length, boundary === 'prefix' ? 1 : 0, 'recovery identities supplied before worker ready');
  const observed = await worker.post('getProjectDeletionState', input);
  assert.equal(observed.result.state, boundary === 'before' ? 'absent' : boundary === 'prefix' ? 'partial' : 'committed');
  assert.equal(observed.result.projectHidden, boundary === 'final');
  if (boundary === 'before') assert.equal((await worker.post('fenceProjectDeletion', input)).result.state, 'notStarted');
  const changes = h.db.changeCount(), duplicate = await worker.post('completeProjectDeletion', input);
  assert.ok(duplicate.error || duplicate.result.terminal);
  assert.equal(h.db.changeCount(), changes, 'replacement never re-enters old completion');
  assert.equal(h.db.getMeta('head')?.name || null, boundary === 'final' ? null : 'app head');
  deep(h.bytes(), h.beforeBytes);
});

test('COMPLETE detailed receipt eviction preserves old-epoch no-late-commit proof', supported, async t => {
  const h = setup(t), input = h.manifest(), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  assert.equal((await worker.post('completeProjectDeletion', input)).result.state, 'committed');
  const progress = createProjectDeleteProgress(h.db, { now: () => Date.now() + 8 * 86400000 });
  while (h.db.projectDeletion.operation(input.operationId)) assert.equal(progress.purge(), true);
  const before = h.db.changeCount(), observed = await worker.post('getProjectDeletionState', input);
  assert.equal(observed.result.state, 'unknown'); assert.equal(observed.result.noLateCommit, true);
  const old = await worker.post('completeProjectDeletion', input);
  assert.ok(old.error, 'evicted operation cannot re-enter');
  assert.equal(h.db.changeCount(), before);
  const forged = await worker.post('completeProjectDeletion', { ...input, expectedProjectEpoch: observed.result.projectEpoch });
  assert.equal(forged.error?.code, 'DELETION_ID', 'old operation ID cannot be relabelled with a current epoch');
});

test('COMPLETE unsent transport request arriving after positive fence cannot commit', supported, async t => {
  const h = setup(t), input = h.manifest(false, true), { EventEmitter } = require('node:events');
  const { createWriterWorkerClient } = require('../session-index-writer-client');
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db), port = new EventEmitter();
  let submissions = 0;
  port.terminate = async () => 0;
  port.postMessage = message => {
    submissions++;
    void worker.post(message.command, ...message.args).then(reply => port.emit('message', { ...reply, id: message.id }));
  };
  const client = createWriterWorkerClient({ workerFactory: () => port, timeoutMs: 10000 });
  try {
    const queued = client.request('completeProjectDeletion', input).then(value => ({ value }), error => ({ error }));
    assert.equal(submissions, 0);
    assert.equal((await worker.post('fenceProjectDeletion', input)).result.state, 'notStarted');
    port.emit('message', { ready: true, settings: [] });
    assert.ok((await queued).error, 'previously unsent completion refuses after fence');
    assert.equal(submissions, 1); assert.equal(h.db.getMeta('head').name, 'app head');
    assert.equal((await worker.post('getProjectDeletionState', input)).result.projectHidden, false);
  } finally { await client.terminate(); }
});

test('COMPLETE reserves before its first await and waits for fetched offer filesystem effects and ACK', supported, async t => {
  const h = setup(t), archive = require('../archived-projects');
  const file = path.join(h.root, '.claude', 'commands', 'schedule-file.md'), stateDir = path.join(h.root, 'claims');
  fs.writeFileSync(file, '---\nname: retained\nenabled: false\ncron: * * * * *\ncatch-up: true\n---\nfixture\n');
  h.db.setSetting('scheduleReenableOffers', { [h.root]: { disabledSchedules: [file], archivedAt: 'before' } });
  let fetched, proceed, completions = 0, effects = 0;
  const fetchedPromise = new Promise(resolve => { fetched = resolve; }), proceedPromise = new Promise(resolve => { proceed = resolve; });
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db), client = { ...worker.client };
  client.requestForWorkflow = (_id, command, ...args) => client.request(command, ...args);
  client.retireWorkflow = () => {};
  client.fenceWorkflow = async () => {};
  client.request = async (name, ...args) => {
    if (name === 'completeProjectDeletion') completions++;
    const result = await worker.client.request(name, ...args);
    if (name === 'beginOffer') { fetched(); await proceedPromise; }
    return result;
  };
  const writer = createSessionIndexWriter({ client, readonlyBackend: h.db }, {}); await writer.ready;
  const enabling = writer.reenableOfferedSchedules(h.root, null, { notify() {}, reenable(files) { effects++; return archive.reenableScheduleFiles(files, h.root, { stateDir }); } });
  await fetchedPromise;
  const stale = h.manifest(), deleting = writer.completeProjectDeletion(stale);
  const refusal = assert.rejects(deleting, { code: 'WRITER_STALE' });
  await assert.rejects(writer.reenableOfferedSchedules(h.root, null, { notify() {}, reenable() { effects++; } }), { code: 'WORKFLOW_BUSY' });
  await new Promise(resolve => setImmediate(resolve));
  const early = completions; proceed(); assert.equal((await enabling).ok, true); await refusal;
  assert.equal(early, 0, 'COMPLETE cannot overtake fetched offer filesystem effects and completion ACK');
  assert.equal(effects, 1, 'reservation refuses new filesystem effects');
  const retained = h.bytes(), claims = fs.readdirSync(stateDir).map(name => fs.readFileSync(path.join(stateDir, name), 'utf8'));
  assert.match(fs.readFileSync(file, 'utf8'), /enabled: true/); assert.ok(claims.length > 0);
  assert.equal((await writer.completeProjectDeletion(h.manifest())).state, 'committed');
  deep(h.bytes(), retained, 'complete keeps schedule and source bytes after admitted old effects');
  deep(fs.readdirSync(stateDir).map(name => fs.readFileSync(path.join(stateDir, name), 'utf8')), claims, 'complete keeps catch-up claim bytes');
  await assert.rejects(writer.reenableOfferedSchedules(h.root, null, { notify() {}, reenable() { effects++; } }), { code: 'PROJECT_EPOCH_STALE' });
  assert.equal(effects, 1, 'old deletion cannot re-enable schedules after commit');
});

test('COMPLETE producer fence accepts unrelated metadata and FTS with ownership supplied by the same effects batch', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  assert.equal((await worker.post('completeProjectDeletion', h.manifest(false, true))).result.state, 'committed');
  const row = { sessionId: 'new-unrelated', folder: 'other-new', projectPath: h.kept[0].projectPath };
  const reply = await worker.post('effects', [
    { name: 'setName', args: [row.sessionId, 'unrelated app name'] },
    { name: 'upsertCachedSessions', args: [[row]] },
    { name: 'upsertSearchEntries', args: [[{ id: row.sessionId, folder: row.folder, type: 'session', title: 'unrelated', body: 'unrelated searchable' }]] },
  ], h.db.getSetting('_writer_revision'));
  assert.equal(reply.error, undefined, 'same-batch row ownership authorizes unrelated metadata and search after another project deletion');
  assert.equal(h.db.getMeta(row.sessionId).name, 'unrelated app name');
  assert.equal(h.db.getCachedSession(row.sessionId).projectPath, row.projectPath);
  assert.equal(h.db.searchByType('session', 'searchable').length, 1);
  assert.equal(h.db.getMeta('head'), null, 'selected metadata stays erased');
});

test('COMPLETE competing operation IDs refuse before sharing an owned archive hold', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db), client = { ...worker.client };
  let committed, firstAck, secondAck, submissions = 0;
  const committedPromise = new Promise(resolve => { committed = resolve; });
  const firstPromise = new Promise(resolve => { firstAck = resolve; }), secondPromise = new Promise(resolve => { secondAck = resolve; });
  client.request = async (name, ...args) => {
    if (name !== 'completeProjectDeletion') return worker.client.request(name, ...args);
    if (++submissions === 1) { const result = await worker.client.request(name, ...args); committed(); await firstPromise; return result; }
    await secondPromise;
    return worker.client.request(name, ...args);
  };
  const writer = createSessionIndexWriter({ client, readonlyBackend: h.db }, {}); await writer.ready;
  const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
  const first = outcome(writer.completeProjectDeletion(h.manifest())); await committedPromise;
  const second = outcome(writer.completeProjectDeletion(h.manifest()));
  await new Promise(resolve => setImmediate(resolve));
  firstAck(); const firstResult = await first; secondAck(); const secondResult = await second;
  assert.equal(submissions, 1, 'competing deletion cannot share an owned archive hold');
  assert.equal(firstResult.value?.state, 'committed', 'first ACK cannot be stranded by another operation lease');
  assert.equal(secondResult.error?.code, 'WORKFLOW_BUSY');
  const hold = writer.reserveProjectDeletion([h.project]); await hold.ready; hold.release();
});

test('COMPLETE rejects a search producer whose ownership was unknown when received before deletion admission', supported, async t => {
  const h = setup(t); h.db.nextChunkSize = () => 1;
  let worker, deletion, launch, captured = false;
  const launched = new Promise(resolve => { launch = resolve; });
  worker = require('./fixtures/project-deletion-worker.cjs')(h.db, message => {
    if (message.started && !captured) {
      captured = true;
      queueMicrotask(() => {
        const folderKey = 'future-folder', id = 'future-id';
        commitTransaction(h.db, () => {
          h.db.setFolderMeta(folderKey, h.root, 1);
          h.db.upsertCachedSessions([{ sessionId: id, folder: folderKey, projectPath: h.root }]);
          h.db.setName(id, 'newly proven member');
        });
        h.groups.push({ ...h.project, folderKey, runtime: 'claude', verified: true, effect: 'selected' });
        h.members.push({ ...h.members[0], id, partId: id, folderKey });
        deletion = worker.post('completeProjectDeletion', h.manifest(false, true)); launch();
      });
    }
  });
  const search = worker.post('upsertSearchEntries', [{ id: 'future-id', type: 'session', folder: 'future-folder', body: 'x'.repeat(32768) }]);
  await launched;
  const deleted = await deletion, old = await search;
  assert.equal(deleted.error, undefined);
  assert.equal(deleted.result.state, 'committed', 'initially unowned producer cannot interrupt deletion after it claims the new owner');
  assert.equal(old.error?.code, 'PROJECT_EPOCH_STALE', 'unknown-at-receipt producer must recheck before staged publication');
  assert.equal(h.db.connection.prepare("SELECT COUNT(*) AS n FROM search_map WHERE id='future-id'").get().n, 0);
});

test('validation resolves each distinct owner path at most once', supported, t => {
  const h = setup(t), input = h.manifest(true);
  const realpath = fs.realpathSync.native, resolutions = new Map();
  fs.realpathSync.native = value => {
    const absolute = path.resolve(value);
    resolutions.set(absolute, (resolutions.get(absolute) || 0) + 1);
    return realpath(value);
  };
  let result;
  try { result = api().validateDeletionManifest(h.db, input); }
  finally { fs.realpathSync.native = realpath; }
  deep(result.sessionIds, h.members.map(row => row.id).sort());
  assert.ok(resolutions.size >= 3, 'selected and foreign local ownership paths are exercised');
  for (const [ownerPath, calls] of resolutions) assert.equal(calls, 1, `owner path resolved once: ${ownerPath}`);
});

test('validation scales to 5000 persisted members', supported, t => {
  const h = setup(t), rows = [];
  for (let i = h.selected.length; i < 5000; i++) {
    const sessionId = 'scale-' + i;
    rows.push({ sessionId, folder: h.groups[0].folderKey, projectPath: h.root, messageCount: 1 });
    h.members.push({ ...h.members[0], id: sessionId, partId: sessionId });
  }
  h.db.upsertCachedSessions(rows);
  const input = h.manifest(true), start = performance.now();
  const validated = api().validateDeletionManifest(h.db, input), elapsed = performance.now() - start;
  assert.equal(validated.sessionIds.length, 5001);
  t.diagnostic(`5000 persisted members, ${h.db.getAllCached().length} ownership rows: ${elapsed.toFixed(1)}ms`);
});

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
    openWorkingSet: [{ sessionId: 'head', projectPath: h.root, active: true }, { sessionId: 'head', projectPath: '/srv/other', active: false }, { sessionId: 'orphan', projectPath: h.root, active: false }, { sessionId: 'worktree', projectPath: h.kept[2].projectPath, active: false }] });
  commitTransaction(h.db, () => { for (const unit of units) engine.applyDeletionUnit(h.db, unit); }); h.reopen();
  const global = h.db.getSetting('global');
  assert.equal(global.sentinel, 'latest'); assert.equal(global.hiddenProjectScopes?.[h.root], undefined, 'legacy unscoped mark remains unscoped');
  assert.equal(global.hiddenProjectKinds[h.root], 'delete', 'final hide uses the existing delete kind');
  assert.equal(global.openWorkingSet.length, 3, 'prune only proven selected ID and project path');
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
  const keptTabs = [{ sessionId: 'remote', projectPath: '/srv/elsewhere', active: false }, { sessionId: 'unselected', projectPath: '/srv/other', active: false }];
  h.db.setSetting('global', { openWorkingSet: [{ sessionId: 'remote', projectPath: '/srv/other', active: true, bg: true, attachJobId: 'job' }, ...keptTabs] });
  h.db.setSetting('scheduleProjects', ['/srv/other', h.root]);
  commitTransaction(h.db, () => { for (const unit of engine.buildFinalizationUnits(validated)) engine.applyDeletionUnit(h.db, unit); });
  deep(h.db.getSetting('scheduleProjects'), ['/srv/other', h.root]);
  deep(h.db.getSetting('global').openWorkingSet, keptTabs, 'remote saved tabs use proven IDs and paths without host fields');
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
for (const command of ['completeProjectDeletion', 'fenceProjectDeletion']) test(`A4c1 postcommit history failure preserves ${command} ACK and producer fencing`, supported, async t => {
  const h = setup(t), input = h.manifest(false, true), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const original = h.db.projectDeletion.hasHistory, transact = h.db.transact;
  let afterCommit = false, injected = 0, producer;
  h.db.transact = fn => {
    const result = transact(fn);
    afterCommit = true;
    return result;
  };
  h.db.projectDeletion.hasHistory = () => {
    if (afterCommit) {
      afterCommit = false; injected++;
      producer ||= worker.post('upsertCachedSessions', [{ ...h.selected[0], messageCount: 42 }]);
      throw new Error('postcommit history unavailable');
    }
    return original();
  };
  const reply = await worker.post(command, input);
  assert.ok(injected > 0, 'fault occurred after a committed transaction');
  assert.equal(reply.error, undefined, 'auxiliary history read must not rewrite a committed ACK as failure');
  assert.equal(reply.result.state, command === 'completeProjectDeletion' ? 'committed' : 'notStarted');
  assert.ok(reply.settings, 'committed settings acknowledgment is preserved');
  assert.equal((await producer).error?.code, 'PROJECT_EPOCH_STALE', 'queued producer stays fenced');
});

test('A4c1 worker ordered bounded snapshot pages do not mutate and reject a changed revision', supported, async t => {
  const h = setup(t), worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  const writer = createSessionIndexWriter({ client: worker.client, readonlyBackend: h.db }, cache); await writer.ready;
  assert.equal(typeof writer.readProjectDeletionSnapshot, 'function', 'bounded snapshot read must be exported');
  const before = h.db.changeCount(), revision = await writer.readProjectDeletionRevision();
  let cursor = null, rows = [];
  do {
    const page = await writer.readProjectDeletionSnapshot({ section: 'sessions', cursor, limit: 2, expectedRevision: revision });
    assert.equal(page.revision, revision); assert.ok(page.rows.length <= 2);
    rows.push(...page.rows); cursor = page.nextCursor;
  } while (cursor !== null);
  deep(rows.map(row => row.sessionId).sort(), [...h.selected, ...h.kept].map(row => row.sessionId).sort());
  assert.equal(h.db.changeCount(), before, 'snapshot reads do not change any table or writer revision');
  await assert.rejects(writer.readProjectDeletionSnapshot({ section: 'sessions', maxBytes: 1 }), { code: 'DISCOVERY_LIMIT' });
  await worker.client.request('setName', 'head', 'changed');
  await assert.rejects(writer.readProjectDeletionSnapshot({ section: 'sessions', expectedRevision: revision }), { code: 'SNAPSHOT_STALE' });
});

test('A4c1 recovery exposes sealed interruption and enumerates a committed lost reply through real client and facade', supported, async t => {
  const h = setup(t), first = h.manifest(false, false);
  const worker = require('./fixtures/project-deletion-worker.cjs')(h.db);
  assert.equal((await worker.post('completeProjectDeletion', first)).result.state, 'committed');
  const second = h.manifest(false, false), progress = createProjectDeleteProgress(h.db);
  progress.admit({ ...second, units: [] });
  h.reopen();
  const observed = [];
  const fixture = require('./fixtures/project-deletion-worker.cjs');
  assert.equal(typeof fixture.createWorker, 'function', 'full worker fixture must expose a real-client transport');
  const writer = createSessionIndexWriter({ workerFactory: () => fixture.createWorker(h.db), readonlyBackend: { ...h.openReader(), applySettingsAcknowledgment() {} },
    onBootstrap: bootstrap => observed.push(bootstrap) }, cache);
  t.after(() => writer.terminate());
  await writer.ready;
  assert.equal(observed.length, 1);
  assert.ok(observed[0].recoveredProjectDeletions.some(row => row.operationId === second.operationId), 'sealed interrupted operation must reach the facade');
  const bootstrap = writer.getRecoveryBootstrap();
  bootstrap.recoveredProjectDeletions.length = 0;
  assert.equal(writer.getRecoveryBootstrap().recoveredProjectDeletions.length, 1, 'recovery snapshot is detached');
  const before = h.db.changeCount(), revision = await writer.readProjectDeletionRevision();
  const operations = [];
  let cursor = null;
  do {
    const page = await writer.listProjectDeletionOperations({ cursor, limit: 1, expectedRevision: revision });
    operations.push(...page.rows); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.ok(operations.some(row => row.operationId === first.operationId && row.state === 'committed'), 'committed lost reply is discoverable');
  assert.ok(operations.some(row => row.operationId === second.operationId && row.sealed), 'interruption is sealed before ready');
  assert.equal(h.db.changeCount(), before, 'receipt enumeration never resumes deletion');
  await writer.closeDb();
});

test('A4c1 provenance pages seek a stable key without sorting the entire metadata table', supported, t => {
  const h = setup(t), plans = [];
  h.db.connection.prepare('DELETE FROM session_meta_fields').run();
  h.db.connection.prepare('INSERT INTO session_meta_fields(sessionId, field, revision, source) VALUES (?, ?, ?, ?)').run('page-a', 'name', 1, 'app');
  h.db.connection.prepare('INSERT INTO session_meta_fields(sessionId, field, revision, source) VALUES (?, ?, ?, ?)').run('page-b', 'name', 1, 'app');
  const originalPrepare = Object.getPrototypeOf(h.db.connection).prepare;
  h.db.connection.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql), connection = this;
    return new Proxy(statement, { get(target, key) {
      if (key === 'all') return (...args) => {
        plans.push(...originalPrepare.call(connection, 'EXPLAIN QUERY PLAN ' + sql).all(...args));
        return target.all(...args);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try {
    const first = h.db.projectDeletionSnapshot.read({ section: 'fields', limit: 1 });
    assert.equal(first.rows.length, 1); assert.equal(typeof first.nextCursor, 'string');
    const second = h.db.projectDeletionSnapshot.read({ section: 'fields', limit: 1, cursor: first.nextCursor });
    assert.notEqual(first.rows[0].sessionId, second.rows[0].sessionId);
  } finally { h.db.connection.prepare = originalPrepare; }
  assert.ok(plans.length >= 2, 'inspect the actual SQLite plans for both pages');
  assert.ok(plans.every(row => !/USE TEMP B-TREE/i.test(row.detail)), 'bounded provenance page must not sort the full table');
});
