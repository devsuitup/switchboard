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

test('unissued inherited tags remain eligible and issued tags expire after 24 hours', t => {
  const at = Date.parse('2026-11-19T12:00:00Z');
  let now = at;
  t.mock.method(Date, 'now', () => now);
  const pending = { tag: codex.originatorTag('expiry-a'), forkFrom: 'parent', projectPath: '/p', spawnedAt: at };
  const signals = { sessionId: REAL_ID, originator: 'switchboard_unissuedparent', forkedFrom: 'parent', startedAt: new Date(at).toISOString() };
  assert.equal(codex.matchesLaunch(signals, pending), 'fork');
  signals.originator = codex.launchEnv('expiry-b').CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  now = at + 24 * 60 * 60 * 1000 - 1;
  assert.equal(codex.matchesLaunch(signals, pending), false, 'issued tags are reserved for the full retention period');
  now++;
  assert.equal(codex.matchesLaunch(signals, pending), 'fork', 'expired tags no longer occupy the launch registry');
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
  test(`an untagged fork rollout once ambiguous between two forks is never adopted after one sibling is ${lifecycle}`, t => {
    const f = transitionsFixture(t);
    const a = f.pend(`amb-a-${lifecycle}`, PARENT_REAL), b = f.pend(`amb-b-${lifecycle}`, PARENT_REAL);
    const file = f.rollout(FORK_REAL, { originator: 'codex_cli_rs', forked_from_id: PARENT_REAL });
    assert.equal(transitions.resolvePendingLaunches(codex, [file]), 0, 'positive control: two open forks stay pending');
    if (lifecycle === 'removed') f.activeSessions.delete(`amb-b-${lifecycle}`); else b.session.exited = true;
    assert.equal(transitions.resolvePendingLaunches(codex, [file]), 0,
      'the rollout may belong to the gone sibling: an ambiguous fork stays under its temporary id');
    assert.equal(f.activeSessions.get(`amb-a-${lifecycle}`), a.session);
    assert.ok(a.session.pendingLaunch);
    assert.deepEqual(f.events, []);
    const own = f.rollout(OTHER_REAL, { originator: 'codex_cli_rs', forked_from_id: PARENT_REAL });
    assert.equal(transitions.resolvePendingLaunches(codex, [file, own]), 1, 'a rollout that only ever matched the remaining fork is adopted');
    assert.equal(f.activeSessions.get(OTHER_REAL), a.session);
    assert.equal(f.activeSessions.has(FORK_REAL), false);
  });
}

test('a lone fork whose rollout inherited the tag of a parent adopted in this app run is adopted', t => {
  const f = transitionsFixture(t);
  const parent = f.pend('parent-launch', null);
  const parentFile = f.rollout(PARENT_REAL, { originator: parent.tag });
  assert.equal(transitions.resolvePendingLaunches(codex, [parentFile]), 1, 'positive control: the parent adopts its tagged rollout');
  assert.equal(f.activeSessions.get(PARENT_REAL), parent.session);
  f.activeSessions.delete(PARENT_REAL);
  const stranger = f.pend('stranger-fork', OTHER_REAL);
  const strangerFile = f.rollout('55555555-5555-4555-8555-555555555555', { originator: parent.tag, forked_from_id: OTHER_REAL });
  assert.equal(transitions.resolvePendingLaunches(codex, [strangerFile]), 0,
    'a tag issued to a launch that is not this fork\'s parent is still foreign');
  assert.ok(stranger.session.pendingLaunch);
  f.activeSessions.delete('stranger-fork');
  const fork = f.pend('inherited-fork', PARENT_REAL);
  const forkFile = f.rollout(FORK_REAL, { originator: parent.tag, forked_from_id: PARENT_REAL });
  assert.equal(transitions.resolvePendingLaunches(codex, [forkFile]), 1,
    'the parent\'s own issued tag is inherited, not foreign: the lone fork adopts its lone rollout');
  assert.equal(f.activeSessions.get(FORK_REAL), fork.session);
  assert.equal(fork.session.pendingLaunch, null);
});
