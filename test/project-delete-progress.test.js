'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createSessionIndexWriter } = require('../session-index-writer');
const openStore = require('./fixtures/conversation-store.cjs');
const { createProjectDeleteProgress, operationId, commitTransaction } = require('../src/main/projects/project-delete-progress');
const supported = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-progress-'));
  const prior = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  let db = openStore();
  t.after(() => {
    if (db) db.closeDb();
    if (prior === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = { alias: null, projectPath: root };
  let now = 1000;
  const progress = () => createProjectDeleteProgress(db, { now: () => now });
  function manifest(units = [{ category: 'probe', target: 'one' }, { category: 'probe', target: 'two' }]) {
    const scope = progress().readScope({ project });
    return { project, operationId: operationId(project, scope.projectEpoch), expectedProjectEpoch: scope.projectEpoch,
      expectedRevision: scope.writerRevision, writerMembershipDigest: scope.writerMembershipDigest,
      membershipDigest: 'inventory-digest', options: { sessions: false, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false }, units };
  }
  return { get db() { return db; }, project, progress, manifest, advance: ms => { now += ms; },
    reopen() { db.closeDb(); db = openStore(); },
  };
}

test('retention admission and apply keep the next owned chunk valid', supported, t => {
  const h = setup(t), p = h.progress();
  const { createWriterCommands, hashSessionRequestCommand } = require('../session-index-commands');
  const commands = createWriterCommands(h.db);
  const input = { stemKey: 'kept-request', actualStem: 'kept-request', actionToken: 'claim', family: 'action', rawHash: 'a'.repeat(64) };
  input.argsHash = hashSessionRequestCommand('claimSessionResultNamespace', input);
  const receipt = commitTransaction(h.db, () => commands.claimSessionResultNamespace(input)).result;
  assert.equal(receipt.receipt.revision, h.db.getSetting('_writer_revision'), 'session-request commit has its single exact revision');
  const large = h.manifest(Array.from({ length: 160 }, (_, i) => ({ category: 'probe', target: i })));
  p.admit(large);
  for (let i = 0; i < large.units.length; i += 16) p.stage(large, large.units.slice(i, i + 16));
  p.fence(large);
  for (let i = 0; i < 128; i++) p.fence(h.manifest([]));
  const next = h.manifest();
  p.admit(next);
  assert.doesNotThrow(() => p.stage(next, next.units), 'retention must not stale its own admission');
  p.apply(next, () => ({ status: 'completed' }));
  assert.doesNotThrow(() => p.apply(next, () => ({ status: 'completed' })), 'retention must not stale its own apply');
  assert.deepEqual(commands.querySessionRequestOutcome({ stemKey: input.stemKey, rawHash: input.rawHash }).owner, receipt.owner, 'deletion retention leaves #380 ownership and bytes untouched');
  assert.equal(h.db.sessionRequests.receipt(input.stemKey, input.actionToken).revision, receipt.receipt.revision);
});

test('retention finishes one purging receipt before selecting another', supported, t => {
  const h = setup(t), p = h.progress();
  const large = h.manifest(Array.from({ length: 160 }, (_, i) => ({ category: 'probe', target: i })));
  p.admit(large);
  for (let i = 0; i < large.units.length; i += 16) p.stage(large, large.units.slice(i, i + 16));
  p.fence(large);
  h.advance(1);
  for (let i = 0; i < 128; i++) p.fence(h.manifest([]));
  const firstRemaining = h.db.projectDeletion.units(large.operationId).length;
  h.advance(8 * 86400000);
  p.purge();
  assert.equal(h.db.projectDeletion.units(large.operationId).length, firstRemaining - 16, 'continue the existing purging receipt');
  assert.equal(h.db.projectDeletion.terminal().filter(row => row.phase === 'purging').length, 1);
  assert.equal(p.read(large).receiptAvailable, false);
});

test('existing database gains writable-only deletion tables without erasing existing data', supported, t => {
  const h = setup(t);
  h.db.setSetting('sentinel', 7);
  const names = h.db.connection.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'project_delete_%' AND type='table'").all();
  assert.equal(names.length, 3, 'three durable deletion tables exist');
  h.db.connection.exec('DROP TABLE project_delete_units; DROP TABLE project_delete_operations; DROP TABLE project_delete_fences');
  h.reopen();
  assert.equal(h.db.getSetting('sentinel'), 7);
  assert.equal(h.db.connection.prepare("SELECT COUNT(*) AS n FROM project_delete_operations").get().n, 0);
});

test('readonly opening an unmigrated database needs no deletion tables', supported, t => {
  const h = setup(t);
  h.db.setSetting('sentinel', 7);
  h.db.connection.exec('DROP TABLE project_delete_units; DROP TABLE project_delete_operations; DROP TABLE project_delete_fences');
  let reader;
  assert.doesNotThrow(() => { reader = openStore({ readonly: true }); }, 'readonly bootstrap must tolerate missing deletion tables');
  try {
    assert.equal(reader.getSetting('sentinel'), 7);
    assert.equal(reader.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'project_delete_%' AND type='table'").get().n, 0);
  } finally { reader?.closeDb(); }
});

test('scope memoizes repeated identities and failures only for one read', supported, t => {
  const h = setup(t), broken = path.join(h.project.projectPath, 'broken'), calls = new Map();
  h.db.upsertCachedSessions([
    ...['one', 'two'].map(sessionId => ({ sessionId, folder: '-local', projectPath: h.project.projectPath })),
    ...['bad-one', 'bad-two'].map(sessionId => ({ sessionId, folder: '-local', projectPath: broken })),
    { sessionId: 'foreign', folder: 'remote::-local', projectPath: h.project.projectPath },
  ]);
  const filename = require.resolve('../src/main/projects/project-delete-progress'), nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process,
    require: id => id === '../shared/normalize-project-path' ? { normalizeProjectPath(value) {
      calls.set(value, (calls.get(value) || 0) + 1);
      if (value === broken) throw new Error('path resolution failed');
      return nativeRequire(id).normalizeProjectPath(value);
    } } : nativeRequire(id) }, { filename });
  const p = module.exports.createProjectDeleteProgress(h.db);
  for (let read = 1; read <= 2; read++) {
    const scope = p.readScope({ project: h.project }).scope;
    assert.deepEqual(Array.from(scope.rows, row => row.sessionId), ['one', 'two']);
    assert.equal(scope.ownership.length, 5, 'failed and foreign ownership remains in the digest');
    assert.equal(calls.get(broken), read, 'a throwing identity is attempted once per read');
    assert.equal(calls.get(h.project.projectPath), read, 'selected identity is resolved afresh once per read');
  }
});

for (const alias of [null, 'remote']) {
  test(`scope ignores malformed ${alias === null ? 'local' : 'remote'} rows but digests their ownership`, supported, t => {
    const h = setup(t), p = h.progress();
    const project = alias === null ? h.project : { alias, projectPath: '/workspace' };
    const before = p.readScope({ project });
    h.db.upsertCachedSessions([{ sessionId: 'malformed', folder: alias === null ? '-local' : 'remote::-workspace',
      projectPath: alias === null ? 'relative/path' : 'C:\\workspace', summary: null, created: null, modified: null }]);
    let after;
    assert.doesNotThrow(() => { after = p.readScope({ project }); }, 'malformed cached ownership must not poison scope reads');
    assert.equal(after.scope.rows.length, 0, 'malformed row never matches the project');
    assert.equal(after.scope.ownership.length, 1, 'raw ownership remains in the digest');
    assert.notEqual(after.writerMembershipDigest, before.writerMembershipDigest);
  });
}

test('admission refuses another unsealed owner without writes', supported, t => {
  const h = setup(t), p = h.progress(), x = h.manifest();
  p.admit(x);
  const y = h.manifest(), before = p.read(x), changes = h.db.changeCount();
  assert.throws(() => p.admit(y), { code: 'DELETION_BUSY' }, 'a second operation cannot take an unsealed owner');
  assert.deepEqual(p.read(x), before, 'refusal preserves the owner receipt and epoch');
  assert.equal(h.db.changeCount(), changes, 'busy admission is write-free');
  p.stage(x, x.units);
  p.apply(x, () => 'done'); p.apply(x, () => 'done');
  assert.equal(p.read(x).state, 'committed');
});

test('foreign absent fence preserves an unsealed owner and its ability to commit', supported, t => {
  const h = setup(t), p = h.progress(), x = h.manifest();
  p.admit(x);
  const y = h.manifest(), before = p.read(x), changes = h.db.changeCount();
  const refused = p.fence(y);
  assert.deepEqual(p.read(x), before, 'foreign fence must preserve the owner receipt and epoch');
  assert.equal(refused.reason, 'project-owned-by-another-operation');
  assert.equal(refused.ownerOperationId, x.operationId);
  assert.equal(refused.noLateCommit, false);
  assert.equal(refused.terminal, false);
  assert.equal(h.db.changeCount(), changes, 'foreign fence is write-free');
  p.stage(x, x.units);
  p.apply(x, () => 'done');
  assert.equal(p.fence(x).state, 'partial', 'only the owning fence seals its prefix');
  assert.equal(p.read(x).noLateCommit, true);
});

test('sealing a displaced unsealed receipt cannot clear another fence owner', supported, t => {
  const h = setup(t), p = h.progress(), x = h.manifest();
  p.admit(x);
  const key = h.db.connection.prepare('SELECT projectKey FROM project_delete_operations WHERE operationId=?').get(x.operationId).projectKey;
  const y = operationId(h.project, p.read(x).projectEpoch);
  h.db.projectDeletion.setFence(key, 9, y, 1);
  p.fence(x);
  assert.equal(h.db.projectDeletion.fence(key).operationId, y, 'sealing must not clear a different owner');
  assert.equal(h.db.projectDeletion.fence(key).epoch, 9, 'sealing must not advance a different owned epoch');
});

test('automatic retention bounds maintenance turns for a large receipt', supported, t => {
  const h = setup(t), p = h.progress();
  const large = h.manifest(Array.from({ length: 160 }, (_, i) => ({ category: 'probe', target: i })));
  p.admit(large);
  for (let i = 0; i < large.units.length; i += 16) p.stage(large, large.units.slice(i, i + 16));
  p.fence(large);
  for (let i = 0; i < 127; i++) {
    h.advance(1);
    const m = h.manifest([]); p.admit(m); p.apply(m, () => assert.fail('empty manifest'));
  }
  h.advance(1);
  const m = h.manifest([]); p.admit(m);
  const before = h.db.changeCount();
  p.apply(m, () => assert.fail('empty manifest'));
  assert.ok(h.db.changeCount() - before <= 24, 'one completion must not drain a large receipt in an unbounded loop');
  assert.ok(h.db.projectDeletion.units(large.operationId).length > 0, 'remaining purge work waits for later calls');
  for (let i = 0; i < 12; i++) p.fence(m);
  assert.equal(h.db.projectDeletion.terminal().length, 128, 'later calls converge to the retention cap');
});

test('partially purged receipt is unavailable from the first bounded turn through removal', supported, t => {
  const h = setup(t), p = h.progress();
  const large = h.manifest(Array.from({ length: 160 }, (_, i) => ({ category: 'probe', target: i })));
  p.admit(large);
  for (let i = 0; i < large.units.length; i += 16) p.stage(large, large.units.slice(i, i + 16));
  for (let i = 0; i < 5; i++) p.apply(large, () => ({ status: 'completed' }));
  p.fence(large);
  assert.equal(p.read(large).completed.length, 5, 'the intact receipt records the committed prefix');
  for (let i = 0; i < 128; i++) {
    h.advance(1);
    const m = h.manifest([]); p.admit(m); p.apply(m, () => assert.fail('empty manifest'));
  }
  assert.equal(h.db.projectDeletion.units(large.operationId).length, 144, 'only one bounded purge turn ran');
  let state = p.read(large);
  assert.equal(state.receiptAvailable, false, 'a partially purged receipt must be unavailable');
  assert.equal(state.reason, 'receipt-expired-or-unavailable');
  assert.equal(state.noLateCommit, true, 'the sealed epoch still forbids late commits');
  h.reopen();
  const reopened = h.progress();
  assert.equal(reopened.read(large).receiptAvailable, false, 'unavailability persists across reopening the store');
  for (let i = 0; i < 9; i++) assert.equal(reopened.purge(), true);
  assert.ok(!h.db.projectDeletion.operation(large.operationId), 'the bounded turns drain the header');
  state = reopened.read(large);
  assert.equal(state.receiptAvailable, false, 'a removed receipt stays unavailable');
  assert.equal(state.reason, 'receipt-expired-or-unavailable');
  assert.equal(state.noLateCommit, true, 'the epoch fence survives receipt removal');
});

test('missing receipt retains no-late-commit proof after a later epoch clears blocked', supported, t => {
  const h = setup(t), p = h.progress(), m = h.manifest([]);
  p.fence(m);
  h.advance(8 * 86400000);
  assert.equal(p.purge(), true);
  assert.ok(!h.db.projectDeletion.operation(m.operationId));
  const fence = h.db.connection.prepare('SELECT * FROM project_delete_fences').get();
  h.db.projectDeletion.setFence(fence.projectKey, fence.epoch + 1, null, 0);
  const state = p.read(m);
  assert.equal(state.receiptAvailable, false);
  assert.equal(state.noLateCommit, true, 'an advanced epoch forbids late commits even with blocked cleared');
  assert.equal(state.reason, 'receipt-expired-or-unavailable');
});

test('admission, effects, progress and exact revision commit or roll back together', supported, t => {
  const h = setup(t), p = h.progress(), m = h.manifest();
  p.admit(m);
  let state = p.read(m);
  assert.equal(state.state, 'inProgress', 'admission persists an unsealed header');
  assert.equal(state.lastRevision, h.db.getSetting('_writer_revision'));
  p.stage(m, m.units);
  const before = h.db.getSetting('_writer_revision');
  assert.throws(() => p.admit({ ...m, options: { ...m.options, schedules: true } }), { code: 'DELETION_MANIFEST' });
  assert.throws(() => p.apply(m, unit => { h.db.setSetting(unit.target, true); return 'written'; }, {
    beforeCommit() { throw new Error('fault before commit'); },
  }), /fault before commit/, 'fault injection reaches the production commit hook');
  state = p.read(m);
  assert.equal(h.db.getSetting('one'), null, 'effect rolled back');
  assert.equal(state.completed.length, 0, 'progress rolled back with effect');
  assert.equal(h.db.getSetting('_writer_revision'), before, 'revision rolled back');
  p.apply(m, unit => { h.db.setSetting(unit.target, true); return 'written'; });
  state = p.read(m);
  assert.equal(state.completed.length, 1);
  assert.equal(state.remaining.length, 1);
  assert.equal(state.lastRevision, h.db.getSetting('_writer_revision'), 'receipt has exact committed revision');
  const reader = openStore({ readonly: true });
  try {
    assert.equal(reader.projectDeletion.operation(m.operationId).lastRevision, state.lastRevision, 'independent reader sees the committed receipt');
    assert.equal(reader.getSetting('one'), true, 'independent reader sees the same committed effect');
  } finally { reader.closeDb(); }
  assert.equal(state.terminal, false, 'unsealed prefix never reports committed');
  const receiptRevision = state.lastRevision;
  commitTransaction(h.db, () => h.db.setSetting('project:' + h.project.projectPath, { fresh: true }));
  state = p.read(m);
  assert.equal(state.lastRevision, receiptRevision);
  assert.ok(state.readRevision > receiptRevision, 'fresh observations have their own revision');
  assert.equal(state.revision, state.readRevision, 'contract revision describes current observations');
  assert.equal(state.settingsPresent, true);
  assert.throws(() => p.apply(m, () => { throw new Error('must not execute'); }), { code: 'WRITER_STALE' });
});

test('absent observation is nonterminal; positive fence rejects delayed admission', supported, t => {
  const h = setup(t), p = h.progress(), m = h.manifest();
  assert.equal(p.read(m).noLateCommit, false);
  const sealed = p.fence(m);
  assert.equal(sealed.state, 'notStarted', 'absent fence persists positive proof');
  assert.equal(sealed.noLateCommit, true);
  assert.equal(sealed.terminal, true);
  let affected = false;
  assert.throws(() => p.admit(m, () => { affected = true; }), { code: 'DELETION_TERMINAL' });
  assert.equal(affected, false);
  assert.equal(p.read(m).projectEpoch, m.expectedProjectEpoch + 1);
});

test('stale revision, digest, foreign identity and reused hash refuse before affected writes', supported, t => {
  const h = setup(t), p = h.progress(), m = h.manifest();
  let effects = 0;
  assert.throws(() => p.admit({ ...m, expectedRevision: 100 }, () => effects++), { code: 'WRITER_STALE' }, 'revision preflight rejects');
  assert.throws(() => p.admit({ ...m, writerMembershipDigest: 'wrong' }, () => effects++), { code: 'DELETION_SCOPE' });
  assert.throws(() => p.fence({ ...m, project: { alias: 'other', projectPath: '/other' } }), { code: 'DELETION_ID' });
  assert.equal(p.read(m).state, 'absent');
  p.admit(m);
  assert.throws(() => p.admit({ ...m, units: [] }, () => effects++), { code: 'DELETION_HASH' });
  p.admit(m, () => effects++);
  assert.equal(effects, 0, 'same hash duplicate is observation only');
});

test('fencing preserves partial prefix and never overwrites a newer owner', supported, t => {
  const h = setup(t), p = h.progress(), old = h.manifest();
  p.admit(old); p.stage(old, old.units); p.apply(old, () => 'done');
  const partial = p.fence(old);
  assert.equal(partial.state, 'partial', 'fence seals incomplete operation partial');
  assert.equal(partial.completed.length, 1);
  assert.equal(partial.remaining.length, 1);
  assert.throws(() => p.apply(old, () => assert.fail('late effect')), { code: 'DELETION_TERMINAL' });
  const newer = h.manifest();
  p.admit(newer);
  const epoch = p.read(newer).projectEpoch;
  p.fence(old);
  assert.equal(p.read(newer).projectEpoch, epoch, 'old fence preserves newer epoch');
  assert.equal(p.read(newer).state, 'inProgress');
  p.stage(newer, newer.units);
  p.apply(newer, () => 'still owned');
  assert.equal(p.read(newer).completed.length, 1, 'newer ownership survives old fence');
});

test('bootstrap seals unfinished work, keeps prefix, and never replays pending effects', supported, t => {
  const h = setup(t), m = h.manifest();
  h.progress().admit(m); h.progress().stage(m, m.units);
  h.progress().apply(m, unit => h.db.setSetting(unit.target, true));
  h.reopen();
  const p = h.progress();
  p.recover();
  const state = p.read(m);
  assert.equal(state.state, 'partial', 'restart seals unfinished receipt');
  assert.equal(state.completed.length, 1);
  assert.equal(h.db.getSetting('two'), null, 'bootstrap never replays pending unit');
  assert.equal(state.noLateCommit, true);
  assert.throws(() => p.apply(m, () => assert.fail('restart replay')), { code: 'DELETION_TERMINAL' });
  const unsent = h.manifest();
  h.reopen(); h.progress().recover();
  assert.equal(h.progress().read(unsent).state, 'absent', 'restart before admission invents no receipt');
});

test('staging is ordered, verified and bounded before effects, terminal success is immutable', supported, t => {
  const h = setup(t), p = h.progress(), m = h.manifest();
  p.admit(m);
  assert.throws(() => p.apply(m, () => assert.fail('unstaged effect')), { code: 'DELETION_STAGING' }, 'unstaged manifest cannot affect data');
  assert.throws(() => p.stage(m, [{ category: 'probe', target: 'forged' }]), { code: 'DELETION_HASH' });
  p.stage(m, m.units);
  p.apply(m, () => 'done'); p.apply(m, () => 'done');
  const state = p.read(m);
  assert.equal(state.state, 'committed');
  assert.equal(state.noLateCommit, true);
  assert.equal(state.completed.length, 2);
  assert.equal(p.fence(m).lastRevision, state.lastRevision, 'terminal fence is idempotent');
});

test('receipt retention purges bounded units, keeps epochs and distinguishes expired evidence', supported, t => {
  const h = setup(t), p = h.progress(), m = h.manifest(Array.from({ length: 40 }, (_, i) => ({ category: 'probe', target: i })));
  p.admit(m);
  for (let i = 0; i < 40; i += 16) p.stage(m, m.units.slice(i, i + 16));
  p.fence(m);
  h.advance(8 * 86400000);
  assert.equal(p.read(m).state, 'unknown', 'expired receipt is unavailable evidence');
  const before = h.db.changeCount(); p.purge();
  assert.ok(h.db.changeCount() - before <= 18, 'purge is bounded');
  while (p.purge()) { /* bounded maintenance turns */ }
  assert.equal(p.read(m).receiptAvailable, false);
  assert.equal(p.fence(m).noLateCommit, true);
  assert.equal(p.read(m).state, 'unknown');
  assert.throws(() => p.admit({ ...m, expectedProjectEpoch: p.read(m).projectEpoch }), { code: 'DELETION_ID' });
});

test('nonterminal admission cap refuses the 33rd operation without evicting active receipts', supported, t => {
  const h = setup(t), p = h.progress();
  for (let i = 0; i < 32; i++) {
    const m = h.manifest();
    m.project = { alias: null, projectPath: path.join(h.project.projectPath, String(i)) };
    const scope = p.readScope(m); Object.assign(m, { operationId: operationId(m.project, 0), writerMembershipDigest: scope.writerMembershipDigest });
    p.admit(m);
  }
  assert.throws(() => p.admit(h.manifest()), { code: 'DELETION_LIMIT' }, 'active receipts are never evicted');
});

test('shipped worker bootstrap and read/fence ports use real store and omit read mirror updates', supported, async t => {
  const h = setup(t), m = h.manifest();
  h.progress().admit(m);
  const port = new EventEmitter(), messages = [], waiters = new Map();
  port.postMessage = msg => { messages.push(msg); if (msg.id && !msg.started) waiters.get(msg.id)?.(msg); };
  const filename = require.resolve('../workers/session-index-writer'), nativeRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'node:worker_threads' ? { parentPort: port }
      : name === '../session-index-store' ? { openSessionIndexStore: () => h.db } : nativeRequire(name),
    setInterval: () => ({ unref() {} }), clearInterval() {},
  }, { filename });
  assert.equal(h.progress().read(m).state, 'partial', 'worker seals recovery before ready');
  assert.ok(messages.find(msg => msg.ready));
  assert.equal(messages.find(msg => msg.ready).recoveredProjectDeletions[0].operationId, m.operationId);
  async function request(id, command, arg) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('writer deadline')), 3000);
      waiters.set(id, msg => { clearTimeout(timer); resolve(msg); });
      port.emit('message', { id, command, args: [arg] });
    });
  }
  const before = h.db.getSetting('_writer_revision');
  const state = await request(1, 'getProjectDeletionState', m);
  assert.equal(state.error, undefined);
  assert.equal(state.result.state, 'partial');
  assert.equal(Object.hasOwn(state, 'settings'), false, 'read bypasses mirror publication');
  assert.equal(h.db.getSetting('_writer_revision'), before);
  const unsent = h.manifest();
  const fenced = await request(2, 'fenceProjectDeletion', unsent);
  assert.equal(fenced.error, undefined);
  assert.equal(fenced.result.state, 'notStarted');
  assert.throws(() => h.progress().admit(unsent), { code: 'DELETION_TERMINAL' });
  const scope = await request(3, 'readProjectDeletionScope', { project: h.project });
  assert.equal(scope.error, undefined);
  assert.equal(scope.result.writerRevision, h.db.getSetting('_writer_revision'));
  assert.equal(Object.hasOwn(scope, 'settings'), false);
  let nextId = 10;
  const writer = createSessionIndexWriter({ readonlyBackend: h.db, client: { ready: Promise.resolve(),
    async request(command, input) {
      const reply = await request(++nextId, command, input);
      if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
      return reply.result;
    },
  } }, {});
  await writer.ready;
  assert.equal((await writer.getProjectDeletionState(m)).state, 'partial');
  const next = h.manifest();
  assert.equal((await writer.fenceProjectDeletion(next)).state, 'notStarted');
  assert.equal((await writer.readProjectDeletionScope({ project: h.project })).projectEpoch, next.expectedProjectEpoch + 1);
});

test('admission rollback leaves no header, fence or first affected write', supported, t => {
  const h = setup(t), p = h.progress(), m = h.manifest();
  assert.throws(() => p.admit(m, () => { h.db.setSetting('admission-effect', true); throw new Error('admission fault'); }), /admission fault/);
  assert.equal(p.read(m).state, 'absent');
  assert.equal(p.read(m).projectEpoch, 0);
  assert.equal(h.db.getSetting('admission-effect'), null);
  const admitted = p.admit(m, unit => { h.db.setSetting('admission-effect', unit.target); return 'first-effect'; });
  assert.equal(admitted.completed.length, 1, 'first affected write and its unit result share admission');
  assert.equal(admitted.nextUnit, 1);
  assert.equal(h.db.getSetting('admission-effect'), 'one');
  assert.equal(admitted.lastRevision, h.db.getSetting('_writer_revision'));
});

test('staging reserves ledger overhead and defers a second large target', supported, t => {
  const h = setup(t), p = h.progress(), m = h.manifest(Array.from({ length: 3 }, (_, i) => ({ category: 'large', target: String(i).repeat(40000) })));
  p.admit(m); p.stage(m, m.units);
  assert.equal(p.read(m).stagedUnits, 1, 'byte budget defers second large staged target');
  assert.throws(() => p.apply(m, () => assert.fail('early effect')), { code: 'DELETION_STAGING' });
  p.stage(m, m.units.slice(1)); p.stage(m, m.units.slice(2));
  assert.equal(p.read(m).stagedUnits, 3);
});

test('terminal duplicate observes receipt and retention exposes at most 128 detailed receipts', supported, t => {
  const h = setup(t), p = h.progress();
  let last;
  for (let i = 0; i < 130; i++) {
    const m = h.manifest([]); p.admit(m); p.apply(m, () => assert.fail('empty manifest')); last = m;
  }
  assert.equal(p.admit(last).state, 'committed', 'same-hash terminal duplicate never reruns');
  assert.ok(h.db.projectDeletion.terminal().length <= 128, 'terminal receipt retention count is enforced');
});

test('readback respects persisted scoped hidden marks, host identity and fresh metadata', supported, t => {
  const h = setup(t), p = h.progress();
  const project = { alias: 'remote', projectPath: '/workspace' };
  const ref = { project, operationId: operationId(project, 0) };
  h.db.upsertCachedSessions([{ sessionId: 'remote-row', folder: 'remote::-workspace', projectPath: '/workspace', summary: null, created: null, modified: null }]);
  h.db.setName('remote-row', 'fresh');
  h.db.setSetting('global', { hiddenProjects: ['remote::/workspace'], hiddenProjectScopes: { 'remote::/workspace': { alias: 'remote' } } });
  assert.equal(p.read(ref).projectHidden, true);
  assert.equal(p.read(ref).metadata[0].name, 'fresh');
  const other = { alias: 'other', projectPath: '/workspace' };
  assert.equal(p.read({ project: other, operationId: operationId(other, 0) }).projectHidden, false);
});
