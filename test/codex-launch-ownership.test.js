'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../harnesses/codex');
const transitions = require('../session-transitions');
const cache = require('../session-cache');
const openStore = require('./fixtures/conversation-store.cjs');

const REAL_ID = '11111111-1111-4111-8111-111111111111';

for (const lifecycle of ['exited', 'removed', 'adopted then removed']) {
  test(`a ${lifecycle} sibling keeps ownership of its issued launch tag`, { skip: !openStore.supported }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ownership-'));
    const previous = { CODEX_HOME: process.env.CODEX_HOME, SWITCHBOARD_DATA_DIR: process.env.SWITCHBOARD_DATA_DIR };
    process.env.CODEX_HOME = path.join(root, 'codex');
    process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
    const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '19');
    fs.mkdirSync(day, { recursive: true });
    const db = openStore();
    const activeSessions = new Map(), events = [];
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    cache.init({ PROJECTS_DIR: path.join(root, 'projects'), activeSessions, db, log, getMainWindow: () => null });
    cache.setRemoteRoots(new Map());
    transitions.init({ PROJECTS_DIR: path.join(root, 'projects'), activeSessions, log,
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
      rekeyMcpServer() {}, rekeyActivity() {}, rekeyMetadata() {}, setTimeout: () => ({ unref() {} }) });
    t.after(() => {
      transitions.init({ activeSessions: new Map() });
      db.closeDb();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const pend = id => {
      const tag = codex.launchEnv(id).CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
      const session = { pty: { pid: 7 }, exited: false, runtime: 'codex', generation: 1,
        pendingLaunch: { tag, forkFrom: 'parent', projectPath: root, spawnedAt: Date.parse('2026-11-19T12:00:00Z') } };
      activeSessions.set(id, session);
      return session;
    };
    const aId = `a-${lifecycle}`, bId = `b-${lifecycle}`;
    const a = pend(aId), b = pend(bId);
    const file = path.join(day, `rollout-2026-11-19T12-00-01-${REAL_ID}.jsonl`);
    fs.writeFileSync(file, [
      { type: 'session_meta', timestamp: '2026-11-19T12:00:01Z', payload: {
        id: REAL_ID, cwd: root, originator: codex.originatorTag(bId), forked_from_id: 'parent' } },
      { type: 'response_item', timestamp: '2026-11-19T12:00:02Z', payload: {
        type: 'message', role: 'user', content: [{ type: 'text', text: 'sibling transcript' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    cache.refreshFolder('codex/2026/11/19');
    assert.equal(db.getCachedSession(REAL_ID).runtime, 'codex');
    if (lifecycle === 'adopted then removed') {
      assert.equal(transitions.resolvePendingLaunches(codex, [file]), 1);
      assert.equal(activeSessions.get(REAL_ID), b);
      activeSessions.delete(REAL_ID);
      events.length = 0;
    } else if (lifecycle === 'removed') activeSessions.delete(bId);
    else b.exited = true;
    assert.equal(transitions.resolvePendingLaunches(codex, [file]), 0,
      'a rollout explicitly tagged for the stopped sibling must not be adopted by the remaining fork');
    assert.equal(activeSessions.get(aId), a);
    assert.ok(a.pendingLaunch);
    assert.deepEqual(events, []);
    assert.equal(db.getCachedSession(REAL_ID).sessionFile, file);
  });
}

test('a fork is graded by its own tag only: the parent\'s tag, a sibling\'s tag or no tag never matches it', () => {
  const at = Date.parse('2026-11-19T12:00:00Z');
  const pending = { tag: codex.originatorTag('tag-only-a'), forkFrom: 'parent', projectPath: '/p', spawnedAt: at };
  const signals = { sessionId: REAL_ID, originator: 'switchboard_parentslaunch', forkedFrom: 'parent', cwd: '/p', startedAt: new Date(at).toISOString() };
  assert.equal(codex.matchesLaunch(signals, pending), false, 'an inherited parent tag is not this fork\'s evidence');
  signals.originator = codex.launchEnv('tag-only-b').CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  assert.equal(codex.matchesLaunch(signals, pending), false, 'a sibling\'s tag is not this fork\'s evidence');
  signals.originator = 'codex_cli_rs';
  assert.equal(codex.matchesLaunch(signals, pending), false, 'forked_from_id plus start time is a guess, not evidence');
  signals.originator = pending.tag;
  assert.equal(codex.matchesLaunch(signals, pending), 'tag');
});

test('a fresh launch\'s cwd fallback never grades a rollout that declares a fork parent', () => {
  const at = Date.parse('2026-11-20T12:00:00Z');
  const pending = { tag: codex.originatorTag('fresh-only'), forkFrom: null, projectPath: '/p', spawnedAt: at };
  const signals = { sessionId: REAL_ID, originator: 'codex_cli_rs', forkedFrom: 'parent', cwd: '/p', startedAt: new Date(at + 1000).toISOString() };
  assert.equal(codex.matchesLaunch(signals, pending), false, 'a rollout with forked_from_id belongs to some fork, not to a fresh launch');
  signals.forkedFrom = null;
  assert.equal(codex.matchesLaunch(signals, pending), 'cwd', 'positive control: the same header without a parent is the fresh fallback');
  signals.forkedFrom = 'parent';
  signals.originator = pending.tag;
  assert.equal(codex.matchesLaunch(signals, pending), 'tag', 'the launch\'s own tag still wins over the header shape');
});

const PARENT_REAL = '22222222-2222-4222-8222-222222222222';
const FORK_REAL = '33333333-3333-4333-8333-333333333333';
const OTHER_REAL = '44444444-4444-4444-8444-444444444444';

function transitionsFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ambiguous-'));
  const activeSessions = new Map(), events = [];
  transitions.init({ PROJECTS_DIR: path.join(root, 'projects'), activeSessions,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
    rekeyMcpServer() {}, rekeyActivity() {}, rekeyMetadata() {}, setTimeout: () => ({ unref() {} }) });
  t.after(() => {
    transitions.init({ activeSessions: new Map() });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const spawnedAt = Date.parse('2026-11-20T12:00:00Z');
  const pend = (id, forkFrom) => {
    const tag = codex.launchEnv(id).CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    const session = { pty: { pid: 7 }, exited: false, runtime: 'codex', projectFolder: null, generation: 1,
      pendingLaunch: { tag, forkFrom, projectPath: root, spawnedAt } };
    activeSessions.set(id, session);
    return { session, tag };
  };
  const rollout = (id, meta) => {
    const file = path.join(root, `rollout-2026-11-20T12-00-01-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', timestamp: '2026-11-20T12:00:01Z',
      payload: { id, cwd: root, timestamp: '2026-11-20T12:00:01Z', ...meta } }) + '\n');
    return file;
  };
  return { root, activeSessions, events, pend, rollout };
}

for (const lifecycle of ['exited', 'removed']) {
  test(`an untagged fork rollout stays pending after one of two forks is ${lifecycle}, even when it is the only rollout left`, t => {
    const f = transitionsFixture(t);
    const a = f.pend(`amb-a-${lifecycle}`, PARENT_REAL), b = f.pend(`amb-b-${lifecycle}`, PARENT_REAL);
    const file = f.rollout(FORK_REAL, { originator: 'codex_cli_rs', forked_from_id: PARENT_REAL });
    assert.equal(transitions.resolvePendingLaunches(codex, [file]), 0, 'positive control: two open forks stay pending');
    if (lifecycle === 'removed') f.activeSessions.delete(`amb-b-${lifecycle}`); else b.session.exited = true;
    assert.equal(transitions.resolvePendingLaunches(codex, [file]), 0,
      'the rollout may belong to the gone sibling: an untagged fork stays under its temporary id');
    assert.equal(f.activeSessions.get(`amb-a-${lifecycle}`), a.session);
    assert.ok(a.session.pendingLaunch);
    assert.deepEqual(f.events, []);
    const second = f.rollout(OTHER_REAL, { originator: 'codex_cli_rs', forked_from_id: PARENT_REAL });
    assert.equal(transitions.resolvePendingLaunches(codex, [file, second]), 0, 'a second untagged same-parent rollout is not evidence either');
    assert.ok(a.session.pendingLaunch);
    assert.equal(f.activeSessions.has(OTHER_REAL), false);
    assert.equal(f.activeSessions.has(FORK_REAL), false);
    const own = f.rollout('66666666-6666-4666-8666-666666666666', { originator: a.tag, forked_from_id: PARENT_REAL });
    assert.equal(transitions.resolvePendingLaunches(codex, [file, second, own]), 1, 'only the rollout carrying this fork\'s own tag is adopted');
    assert.equal(f.activeSessions.get('66666666-6666-4666-8666-666666666666'), a.session);
    assert.equal(a.session.pendingLaunch, null);
  });
}

test('an untagged fork rollout whose sibling exited before the first detection is not donated to the remaining fork', t => {
  const f = transitionsFixture(t);
  const a = f.pend('early-a', PARENT_REAL), b = f.pend('early-b', PARENT_REAL);
  const file = f.rollout(FORK_REAL, { originator: 'codex_cli_rs', forked_from_id: PARENT_REAL });
  b.session.exited = true;
  assert.equal(transitions.resolvePendingLaunches(codex, [file]), 0,
    'a sibling exit before the 500 ms debounce or the 3 s sweep is not ownership evidence');
  assert.equal(f.activeSessions.get('early-a'), a.session);
  assert.ok(a.session.pendingLaunch, 'the fork stays under its temporary id');
  assert.equal(f.activeSessions.has(FORK_REAL), false);
  assert.deepEqual(f.events, []);
});

test('a lone fork whose rollout carries the parent\'s inherited tag stays pending; its own tag adopts it', t => {
  const f = transitionsFixture(t);
  const parent = f.pend('parent-launch', null);
  const parentFile = f.rollout(PARENT_REAL, { originator: parent.tag });
  assert.equal(transitions.resolvePendingLaunches(codex, [parentFile]), 1, 'positive control: the parent adopts its tagged rollout');
  assert.equal(f.activeSessions.get(PARENT_REAL), parent.session);
  f.activeSessions.delete(PARENT_REAL);
  f.events.length = 0;
  const fork = f.pend('inherited-fork', PARENT_REAL);
  const inheritedFile = f.rollout(FORK_REAL, { originator: parent.tag, forked_from_id: PARENT_REAL });
  assert.equal(transitions.resolvePendingLaunches(codex, [inheritedFile]), 0,
    'the parent\'s tag on a lone same-parent rollout is still a guess: the fork stays under its temporary id');
  assert.ok(fork.session.pendingLaunch);
  assert.deepEqual(f.events, []);
  const ownFile = f.rollout(OTHER_REAL, { originator: fork.tag, forked_from_id: PARENT_REAL });
  assert.equal(transitions.resolvePendingLaunches(codex, [inheritedFile, ownFile]), 1, 'the fork\'s own tag is exact evidence');
  assert.equal(f.activeSessions.get(OTHER_REAL), fork.session);
  assert.equal(fork.session.pendingLaunch, null);
  assert.deepEqual(f.events, [['session-forked', 'inherited-fork', OTHER_REAL, 'fork']]);
});

test('an untagged fork rollout is not donated to a fresh launch open in the same cwd; the fresh launch still adopts its own rollout', t => {
  const f = transitionsFixture(t);
  const fresh = f.pend('mixed-fresh', null), fork = f.pend('mixed-fork', PARENT_REAL);
  const forkFile = f.rollout(FORK_REAL, { originator: 'codex_cli_rs', forked_from_id: PARENT_REAL });
  assert.equal(codex.matchesLaunch(codex.readLaunchSignals(forkFile), fork.session.pendingLaunch), false, 'accepted rule: the fork does not guess');
  assert.equal(transitions.resolvePendingLaunches(codex, [forkFile]), 0,
    'a rollout that declares a fork parent is never the fresh launch\'s by cwd and start time');
  assert.equal(f.activeSessions.get('mixed-fresh'), fresh.session);
  assert.ok(fresh.session.pendingLaunch);
  assert.ok(fork.session.pendingLaunch);
  assert.equal(f.activeSessions.has(FORK_REAL), false);
  assert.deepEqual(f.events, []);
  const freshFile = f.rollout(OTHER_REAL, { originator: 'codex_cli_rs' });
  assert.equal(transitions.resolvePendingLaunches(codex, [forkFile, freshFile]), 1, 'the parentless rollout is the fresh launch\'s cwd fallback');
  assert.equal(f.activeSessions.get(OTHER_REAL), fresh.session);
  assert.equal(fresh.session.pendingLaunch, null);
  assert.ok(fork.session.pendingLaunch, 'the untagged fork stays pending');
  assert.deepEqual(f.events, [['session-forked', 'mixed-fresh', OTHER_REAL, 'new']]);
});
