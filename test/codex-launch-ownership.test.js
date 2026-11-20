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
