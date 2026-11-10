'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const openStore = require('./fixtures/conversation-store.cjs');
const commandModule = require('../session-index-commands');
const { createSessionIndexWriter } = require('../session-index-writer');
const { commitTransaction, createProjectDeleteProgress, operationId } = require('../src/main/projects/project-delete-progress');

const supported = { skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22' };
const names = ['querySessionRequestOutcome', 'recordConsumedSessionStatusRequest', 'recordSessionRequestConflict',
  'claimSessionResultNamespace', 'recordSessionResultPublication'];
const sha = char => char.repeat(64);

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-request-'));
  const previous = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = root;
  let db = openStore({ readonly: false });
  t.after(() => {
    db.closeDb();
    if (previous === undefined) delete process.env.SWITCHBOARD_DATA_DIR;
    else process.env.SWITCHBOARD_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const commands = () => {
    const c = commandModule.createWriterCommands(db);
    for (const name of names) assert.equal(typeof c[name], 'function', `writer command ${name} must exist`);
    assert.equal(typeof commandModule.hashSessionRequestCommand, 'function', 'candidate hash binds exact submitted bytes');
    return c;
  };
  function candidate(extra = {}) {
    return { stemKey: 'AbC', actualStem: 'AbC', suppliedHash: sha('a'), family: 'session-status',
      resultBytes: Buffer.from('{"state":"busy","observed_at":10,"evidence_at":9}\n'), actionToken: randomUUID(), ...extra };
  }
  function bind(name, input) {
    commands();
    return { ...input, argsHash: commandModule.hashSessionRequestCommand(name, input) };
  }
  function send(name, input) {
    const c = commands();
    return commitTransaction(db, () => c[name](input)).result;
  }
  return { root, get db() { return db; }, commands, candidate, bind, send,
    consume: input => send('recordConsumedSessionStatusRequest', bind('recordConsumedSessionStatusRequest', input || candidate())),
    query: (input = { stemKey: 'ABC', suppliedHash: sha('a') }) => commands().querySessionRequestOutcome(input),
    reopen() { db.closeDb(); db = openStore({ readonly: false }); },
  };
}

test('status replay preserves consumed bytes and original observation after author/head changes and restart', supported, t => {
  const h = setup(t), input = h.candidate();
  assert.equal(h.query().state, 'absent');
  const first = h.consume(input);
  assert.equal(first.state, 'completed');
  assert.deepEqual(Buffer.from(first.owner.resultBytes), input.resultBytes);
  h.db.setSetting('author-open', false);
  h.db.setSetting('target-head', 'closed');
  h.reopen();
  let gathers = 0;
  const replay = h.query();
  if (replay.state === 'absent') gathers++;
  assert.equal(gathers, 0, 'exact outcome replay must not gather a new snapshot');
  assert.deepEqual(replay.owner, first.owner, 'stored bytes, evidence timestamps, creation time and revision are immutable');
  const changed = h.consume({ ...input, actionToken: randomUUID(), resultBytes: Buffer.from('{"state":"idle","observed_at":30,"evidence_at":29}\n') });
  assert.deepEqual(changed.owner, first.owner, 'a competing candidate returns the first consumed snapshot');
});

test('same command token replays its receipt without writes; changed candidate or command refuses', supported, t => {
  const h = setup(t), input = h.candidate();
  const first = h.consume(input), revision = h.db.getSetting('_writer_revision'), changes = h.db.changeCount();
  assert.deepEqual(h.consume(input), first);
  assert.equal(h.db.getSetting('_writer_revision'), revision);
  assert.equal(h.db.changeCount(), changes, 'receipt replay is write-free');
  assert.equal(first.receipt.revision, revision, 'receipt and owner share the single commit revision');
  assert.throws(() => h.consume({ ...input, resultBytes: Buffer.from('changed\n') }), { code: 'SESSION_REQUEST_TOKEN_CONFLICT' });
  const publication = h.bind('recordSessionResultPublication', input);
  assert.throws(() => h.send('recordSessionResultPublication', publication), { code: 'SESSION_REQUEST_TOKEN_CONFLICT' });
  const bound = h.bind('recordConsumedSessionStatusRequest', input);
  assert.throws(() => h.send('recordConsumedSessionStatusRequest', { ...bound, resultBytes: Buffer.from('changed\n') }), { code: 'SESSION_REQUEST_ARGS_HASH' });
  assert.deepEqual(h.query().owner, first.owner);
});

test('same and different hash contenders across case and families never overwrite the namespace', supported, async t => {
  const h = setup(t), first = h.consume();
  assert.equal(h.query({ stemKey: 'abc' }).state, 'owned');
  const same = h.consume(h.candidate({ stemKey: 'abc', actualStem: 'abc', resultBytes: Buffer.from('second\n') }));
  assert.deepEqual(same.owner, first.owner);
  for (const family of ['legacy', 'action']) {
    const input = h.candidate({ family, actualStem: family === 'action' ? 'abc' : 'AbC', suppliedHash: sha('b'), resultBytes: undefined });
    delete input.resultBytes;
    const result = h.send('claimSessionResultNamespace', h.bind('claimSessionResultNamespace', input));
    assert.equal(result.state, 'conflict');
    assert.deepEqual(result.owner, first.owner, 'foreign family cannot replace bytes or physical publication stem');
  }
  const other = h.consume(h.candidate({ suppliedHash: sha('b') }));
  assert.equal(other.state, 'conflict');
  assert.deepEqual(h.query().owner, first.owner);
  const writer = createSessionIndexWriter({ readonlyBackend: {}, client: { ready: Promise.resolve(),
    request: async (name, value) => h.send(name, value) } }, {});
  await writer.ready;
  for (const different of [false, true]) {
    const stem = different ? 'race-other' : 'race';
    const a = h.candidate({ stemKey: stem, actualStem: stem.toUpperCase() });
    const b = h.candidate({ stemKey: stem.toUpperCase(), actualStem: stem, suppliedHash: different ? sha('c') : sha('a'), resultBytes: Buffer.from('losing candidate\n') });
    const [won, lost] = await Promise.all([a, b].map(input => writer.recordConsumedSessionStatusRequest(h.bind('recordConsumedSessionStatusRequest', input))));
    assert.equal(won.state, 'completed');
    assert.equal(lost.state, different ? 'conflict' : 'completed');
    assert.deepEqual(lost.owner, won.owner, 'concurrent facade submissions serialize to one immutable owner');
  }
});

test('legacy and action tombstones retain first claim and only matching publication can complete them', supported, t => {
  const h = setup(t);
  for (const family of ['legacy', 'action']) {
    const input = { stemKey: family, actualStem: family === 'legacy' ? 'LEGACY' : family, family,
      suppliedHash: sha('a'), rawHash: sha('b'), actionToken: randomUUID() };
    const pending = h.send('claimSessionResultNamespace', h.bind('claimSessionResultNamespace', input));
    assert.equal(pending.state, 'pending');
    assert.equal(pending.owner.resultBytes, null);
    const foreign = { ...input, family: 'session-status', resultBytes: Buffer.from('foreign\n'), actionToken: randomUUID() };
    assert.equal(h.consume(foreign).state, 'conflict');
    const publication = { ...input, actionToken: randomUUID(), resultBytes: Buffer.from('original\n') };
    const completed = h.send('recordSessionResultPublication', h.bind('recordSessionResultPublication', publication));
    assert.equal(completed.state, 'completed');
    assert.equal(completed.owner.actualStem, input.actualStem);
    const second = { ...publication, resultBytes: Buffer.from('replacement\n'), actionToken: randomUUID() };
    assert.deepEqual(h.send('recordSessionResultPublication', h.bind('recordSessionResultPublication', second)).owner, completed.owner);
    h.reopen();
    assert.deepEqual(h.query({ stemKey: family, suppliedHash: sha('a') }).owner, completed.owner);
  }
});

test('unproven legacy identity stays owned and cannot authorize an invented matching replay', supported, t => {
  const h = setup(t);
  const input = { stemKey: 'old', actualStem: 'Old', family: 'legacy', suppliedHash: null, actionToken: randomUUID() };
  const claimed = h.send('claimSessionResultNamespace', h.bind('claimSessionResultNamespace', input));
  assert.equal(claimed.state, 'owned');
  const published = { ...input, actionToken: randomUUID(), resultBytes: Buffer.from('pre-upgrade\n') };
  const saved = h.send('recordSessionResultPublication', h.bind('recordSessionResultPublication', published));
  assert.equal(saved.owner.resultBytes, null, 'a new token with no identity cannot complete an uncertain effect');
  assert.equal(h.query({ stemKey: 'OLD', suppliedHash: sha('a') }).state, 'conflict');
  assert.deepEqual(h.query({ stemKey: 'old' }).owner, claimed.owner);
});

test('legacy filename stems keep the existing basename contract before the json suffix', supported, t => {
  const h = setup(t);
  for (const stem of ['', '.', '..', 'with space ', 'with dot.', 'unicode-été']) {
    const input = { stemKey: stem, actualStem: stem, family: 'legacy', suppliedHash: sha('a'), actionToken: randomUUID(), resultBytes: Buffer.from('saved\n') };
    let result;
    assert.doesNotThrow(() => { result = h.send('claimSessionResultNamespace', h.bind('claimSessionResultNamespace', input)); }, `legacy basename ${JSON.stringify(stem + '.json')} remains valid`);
    assert.equal(result.state, 'completed');
    assert.equal(result.owner.actualStem, stem);
    assert.deepEqual(h.query({ stemKey: stem, suppliedHash: sha('a') }).owner, result.owner);
  }
  for (const stem of ['../escape', 'path/escape', 'bad\0stem', ...(process.platform === 'win32' ? ['path\\escape', 'C:escape'] : [])]) {
    const input = { stemKey: stem, actualStem: stem, family: 'legacy', suppliedHash: sha('a'), actionToken: randomUUID() };
    assert.throws(() => h.send('claimSessionResultNamespace', h.bind('claimSessionResultNamespace', input)), { code: 'SESSION_REQUEST_INPUT' });
  }
});

test('conflict envelopes and receipts replay by original stem plus raw hash after reopen', supported, t => {
  const h = setup(t), first = h.consume();
  const input = { stemKey: 'ABC', actualStem: 'abc', rawHash: sha('b'), resultBytes: Buffer.from('{"error":"conflict","at":10}\n'), actionToken: randomUUID() };
  const bound = h.bind('recordSessionRequestConflict', input);
  const conflict = h.send('recordSessionRequestConflict', bound);
  assert.equal(conflict.state, 'conflict');
  assert.deepEqual(conflict.owner, first.owner);
  assert.deepEqual(Buffer.from(conflict.conflict.resultBytes), input.resultBytes);
  const next = { ...input, actionToken: randomUUID(), resultBytes: Buffer.from('new conflict\n') };
  assert.deepEqual(h.send('recordSessionRequestConflict', h.bind('recordSessionRequestConflict', next)).conflict, conflict.conflict);
  h.reopen();
  assert.deepEqual(h.query({ stemKey: 'abc', rawHash: sha('b') }).conflict, conflict.conflict);
  assert.deepEqual(h.send('recordSessionRequestConflict', bound), conflict);
  assert.equal(h.query({ stemKey: 'abc', rawHash: sha('c'), suppliedHash: sha('c') }).conflict, null);
  assert.deepEqual(h.query().owner, first.owner);
});

test('an owner replay cannot be recorded as its own conflict', supported, t => {
  const h = setup(t);
  const first = h.consume(h.candidate({ rawHash: sha('d') }));
  for (const identity of [{ rawHash: sha('d') }, { rawHash: sha('e'), suppliedHash: sha('a') }]) {
    const input = h.bind('recordSessionRequestConflict', { stemKey: 'abc', actualStem: 'ABC',
      ...identity, resultBytes: Buffer.from('not a conflict\n'), actionToken: randomUUID() });
    assert.throws(() => h.send('recordSessionRequestConflict', input), { code: 'SESSION_REQUEST_INPUT' }, 'an owner replay must refuse conflict recording');
    assert.deepEqual(h.query().owner, first.owner);
    assert.equal(h.query({ stemKey: 'abc', rawHash: sha('d'), suppliedHash: sha('a') }).state, 'completed');
  }
});

test('result, receipt and revision rollback together when receipt insertion fails', supported, t => {
  const h = setup(t);
  h.commands();
  h.db.connection.exec("CREATE TRIGGER reject_session_receipt BEFORE INSERT ON session_request_commands BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
  const revision = h.db.getSetting('_writer_revision');
  assert.throws(() => h.consume(), /receipt rejected/);
  assert.equal(h.query().state, 'absent', 'failed receipt must roll back the result owner');
  assert.equal(h.db.getSetting('_writer_revision'), revision);
  assert.equal(h.db.connection.prepare('SELECT COUNT(*) AS n FROM session_request_commands').get().n, 0);
  h.db.connection.exec('DROP TRIGGER reject_session_receipt');
  const consumed = h.consume();
  h.db.connection.exec("CREATE TRIGGER reject_session_receipt BEFORE INSERT ON session_request_commands BEGIN SELECT RAISE(ABORT, 'conflict receipt rejected'); END");
  const conflict = h.bind('recordSessionRequestConflict', { stemKey: 'abc', actualStem: 'abc', rawHash: sha('b'), resultBytes: Buffer.from('conflict\n'), actionToken: randomUUID() });
  assert.throws(() => h.send('recordSessionRequestConflict', conflict), /conflict receipt rejected/);
  assert.equal(h.query({ stemKey: 'abc', rawHash: sha('b') }).conflict, null, 'failed receipt cannot leave a conflict envelope');
  assert.deepEqual(h.query().owner, consumed.owner);
  h.db.connection.exec('DROP TRIGGER reject_session_receipt');
  const before = h.db.getSetting('_writer_revision');
  assert.throws(() => commitTransaction(h.db, () => { h.commands().recordConsumedSessionStatusRequest(h.bind('recordConsumedSessionStatusRequest', h.candidate({ stemKey: 'other', actualStem: 'other' }))); throw new Error('abort outer commit'); }), /abort outer commit/);
  assert.equal(h.query({ stemKey: 'other' }).state, 'absent');
  assert.equal(h.db.getSetting('_writer_revision'), before);
});

test('readonly pre-migration opens need no journal schema; writable reopen upgrades additively', supported, t => {
  const h = setup(t);
  h.commands();
  h.db.setSetting('sentinel', 7);
  h.db.connection.exec('DROP TABLE session_request_commands; DROP TABLE session_requests');
  let reader;
  assert.doesNotThrow(() => { reader = openStore({ readonly: true }); });
  try {
    assert.equal(reader.getSetting('sentinel'), 7);
    assert.equal(reader.sessionRequests.available(), false);
    for (const read of [() => reader.sessionRequests.get('abc'), () => reader.sessionRequests.receipt('abc', 'token'),
      () => reader.sessionRequests.conflict('abc', sha('b'))]) {
      assert.throws(read, { code: 'SESSION_REQUEST_SCHEMA' }, 'raw reads must distinguish missing schema from absence');
    }
    assert.throws(() => commandModule.createWriterCommands(reader).querySessionRequestOutcome({ stemKey: 'abc' }), { code: 'SESSION_REQUEST_SCHEMA' }, 'missing readonly journal schema is never authoritative absence');
    assert.equal(reader.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('session_requests','session_request_commands')").get().n, 0);
  } finally { reader?.closeDb(); }
  h.reopen();
  assert.equal(h.db.getSetting('sentinel'), 7);
  assert.equal(h.query().state, 'absent');
  const consumed = h.consume();
  reader = openStore({ readonly: true });
  try { assert.deepEqual(Buffer.from(reader.sessionRequests.get('abc').resultBytes), consumed.owner.resultBytes); }
  finally { reader.closeDb(); }
});

test('deletion transactions, receipt trimming and cache rebuild preserve data-dir lifetime journal rows', supported, t => {
  const h = setup(t), p = createProjectDeleteProgress(h.db, { now: () => 1000 });
  const project = { alias: null, projectPath: h.root }, scope = p.readScope({ project });
  const input = { project, operationId: operationId(project, scope.projectEpoch), expectedProjectEpoch: scope.projectEpoch,
    expectedRevision: scope.writerRevision, writerMembershipDigest: scope.writerMembershipDigest, membershipDigest: 'inventory',
    options: { sessions: false, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false },
    units: [{ category: 'cache', target: 'abc' }] };
  p.admit(input);
  p.stage(input, input.units);
  p.apply(input, () => { h.db.deleteCachedSession('abc'); h.db.deleteSearchSession('abc'); return 'done'; });
  assert.equal(p.read(input).state, 'committed');
  const before = h.db.getSetting('_writer_revision');
  const consumedInput = h.candidate(), first = h.consume(consumedInput);
  assert.equal(first.owner.revision, before + 1, 'consume advances the shared revision exactly once');
  const old = createProjectDeleteProgress(h.db, { now: () => 10 * 86400000 });
  old.purge();
  h.db.deleteCachedFolder('folder');
  h.db.connection.exec('DELETE FROM session_cache; DELETE FROM cache_meta; DELETE FROM session_meta; DELETE FROM session_meta_fields; DELETE FROM search_map; DELETE FROM search_content;');
  h.db.setSetting('db_version', 0);
  h.reopen();
  assert.deepEqual(h.query().owner, first.owner, 'cache reconciliation and deletion maintenance never purge #380');
  assert.deepEqual(h.consume(consumedInput), first, 'the original command receipt also survives deletion and rebuild');
});

test('typed open refusal and indivisible oversized status result remain immutable', supported, t => {
  const h = setup(t);
  const input = h.candidate({ family: 'open-session', resultBytes: Buffer.from('unsupported trigger type\n' + 'x'.repeat(70000)) });
  const c = h.commands(), bound = h.bind('recordConsumedSessionStatusRequest', input);
  const first = commitTransaction(h.db, () => h.db.chunkUnit(() => c.recordConsumedSessionStatusRequest(bound), 0).result).result;
  assert.equal(first.state, 'completed');
  assert.equal(first.owner.family, 'open-session');
  assert.deepEqual(first.owner.resultBytes, input.resultBytes);
  h.reopen();
  assert.deepEqual(h.query().owner, first.owner);
  assert.equal(h.db.connection.pragma('synchronous', { simple: true }), 1, 'NORMAL remains unchanged');
});

test('invalid supplied families refuse instead of becoming a default status request', supported, t => {
  const h = setup(t);
  for (const family of ['', null, false, 0, 'unknown']) {
    assert.throws(() => h.consume(h.candidate({ family })), { code: 'SESSION_REQUEST_INPUT' }, 'only omitted family selects the status default');
    assert.equal(h.query().state, 'absent');
  }
  assert.equal(h.consume(h.candidate({ family: undefined })).owner.family, 'session-status');
});

for (const mode of ['held', 'rejected', 'late']) {
  test(`facade ${mode} ACK publishes and cleans up nothing; ordered outcome query recovers committed bytes`, supported, async t => {
    const h = setup(t), input = h.candidate(), calls = [];
    let release, publications = 0, cleanups = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const client = { ready: Promise.resolve(), async request(name, value) {
      calls.push(name);
      const outcome = name === 'querySessionRequestOutcome' ? h.query(value) : h.send(name, value);
      if (name !== 'querySessionRequestOutcome') {
        if (mode === 'rejected') throw new Error('ACK lost');
        await gate;
      }
      return outcome;
    } };
    const writer = createSessionIndexWriter({ client, readonlyBackend: {} }, {});
    await writer.ready;
    for (const name of names) assert.equal(typeof writer[name], 'function', `typed facade forwards ${name}`);
    const bound = h.bind('recordConsumedSessionStatusRequest', input);
    let active = true;
    const pending = writer.recordConsumedSessionStatusRequest(bound).then(value => { if (active) { publications++; cleanups++; } return value; });
    const settled = pending.catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(publications, 0); assert.equal(cleanups, 0);
    active = false;
    const queried = await writer.querySessionRequestOutcome({ stemKey: 'abc', suppliedHash: sha('a') });
    assert.equal(queried.state, 'completed', 'ACK absence is not rollback');
    release(); await settled;
    assert.equal(publications, 0); assert.equal(cleanups, 0, 'late ACK cannot revive an abandoned publication attempt');
    assert.deepEqual(calls, ['recordConsumedSessionStatusRequest', 'querySessionRequestOutcome']);
  });
}

test('journal facade waits for admitted ACKs on close and refuses new queries during shutdown', async () => {
  let release;
  const events = [], gate = new Promise(resolve => { release = resolve; });
  const writer = createSessionIndexWriter({ readonlyBackend: { closeDb: () => events.push('reader-close') },
    client: { ready: Promise.resolve(), request: async name => { events.push(name); await gate; return { state: 'completed' }; }, close: async () => events.push('writer-close') } }, {});
  await writer.ready;
  assert.equal(typeof writer.recordConsumedSessionStatusRequest, 'function', 'journal writes use normal admission');
  const pending = writer.recordConsumedSessionStatusRequest({});
  await new Promise(resolve => setImmediate(resolve));
  const closing = writer.closeDb();
  await assert.rejects(writer.querySessionRequestOutcome({ stemKey: 'new' }), /closing/);
  assert.deepEqual(events, ['recordConsumedSessionStatusRequest']);
  release(); await pending; await closing;
  assert.deepEqual(events, ['recordConsumedSessionStatusRequest', 'reader-close', 'writer-close']);
});
