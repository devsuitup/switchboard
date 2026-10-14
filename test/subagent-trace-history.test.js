'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const activity = require('../activity-trace');
const originalTrace = activity.trace;
let records;
const scheduled = [];
const originalTimeout = globalThis.setTimeout;
test.before(() => { globalThis.setTimeout = (fn) => { scheduled.push(fn); return { unref() {} }; }; });
activity.trace = (cat, sid, data) => records.push({ cat, sid, ...data });
const { init, detectSubagentTransitions } = require('../session-transitions');
const { createTaskRecordsClient } = require('../task-records-client');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');
const NOW = Date.parse('2026-10-15T00:00:00Z');

test.after(() => { activity.trace = originalTrace; globalThis.setTimeout = originalTimeout; });

function fireTimers() {
  for (const fn of scheduled.splice(0)) fn();
}

function setup(t, options = {}) {
  records = [];
  const previousOn = activity.state.on;
  activity.state.on = options.trace !== false;
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-trace-630-'));
  const events = [];
  const sessions = new Map();
  init({ PROJECTS_DIR: dir, activeSessions: sessions,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, data) => events.push({ channel, ...data }) } }),
    log: { info() {} }, rekeyMcpServer() {}, hasTaskRecord: options.hasTaskRecord });
  fireTimers();
  scheduled.length = 0;
  const session = { projectFolder: '.' };
  const id = fixture.parentSessionId;
  sessions.set(id, session);
  const children = path.join(dir, id, 'subagents');
  fs.mkdirSync(children, { recursive: true });
  const seed = (agent, age) => {
    const file = path.join(children, `agent-${agent}.jsonl`);
    fs.writeFileSync(file, '');
    fs.utimesSync(file, (Date.now() - age) / 1000, (Date.now() - age) / 1000);
    fs.utimesSync(children, Date.now() / 1000, Date.now() / 1000);
    return file;
  };
  t.after(() => { activity.state.on = previousOn; t.mock.timers.reset(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, id, session, events, seed, scan: () => detectSubagentTransitions(id, session, dir) };
}

test('bootstrap summarizes static history once and attributes a recent reversible candidate separately', t => {
  const h = setup(t);
  for (let i = 0; i < 40; i++) h.seed(`old-${i}`, 120000 + i * 1000);
  const recent = h.seed('recent', 5000);
  h.scan();
  assert.deepEqual(records.filter(r => r.cat === 'subagent.history-summary'), [
    { cat: 'subagent.history-summary', sid: h.id, historyCount: 40, newestAgeMs: 120000, source: 'transcript-mtime', confidence: 'historical' },
  ]);
  assert.deepEqual(records.filter(r => r.cat === 'subagent.bootstrap-candidate'), [
    { cat: 'subagent.bootstrap-candidate', sid: h.id, agentId: 'recent', ageMs: 5000, recheck: true, source: 'transcript-mtime', confidence: 'inferred' },
  ]);
  assert.equal(records.filter(r => ['subagent.assumed-finished', 'subagent.spawned', 'subagent.completed'].includes(r.cat)).length, 0);
  assert.equal(h.events.length, 0);
  h.scan();
  assert.equal(records.filter(r => r.cat === 'subagent.history-summary').length, 1);
  t.mock.timers.tick(1000);
  fs.appendFileSync(recent, '{}\n');
  fs.utimesSync(recent, Date.now() / 1000, Date.now() / 1000);
  h.scan();
  h.scan();
  const rehabilitated = records.filter(r => r.cat === 'subagent.rehabilitated');
  assert.equal(rehabilitated.length, 1);
  assert.equal(rehabilitated[0].agentId, 'recent');
  assert.equal(rehabilitated[0].source, 'transcript-mtime');
  assert.equal(h.events.filter(e => e.channel === 'subagent-spawned').length, 1);
  assert.equal(h.events.filter(e => e.channel === 'subagent-completed').length, 0);
});

for (const recent of [false, true]) {
  test(`bootstrap with no historical files reports zero and null (recent candidate: ${recent})`, t => {
    const h = setup(t);
    if (recent) h.seed('recent', 59999);
    h.scan();
    h.scan();
    const summary = records.filter(r => r.cat === 'subagent.history-summary');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].historyCount, 0);
    assert.equal(summary[0].newestAgeMs, null);
  });
}

test('the freshness boundary belongs to historical bootstrap, not a reversible candidate', t => {
  const h = setup(t);
  h.seed('boundary', 60000);
  h.scan();
  assert.equal(records.find(r => r.cat === 'subagent.history-summary')?.historyCount, 1);
  assert.equal(records.find(r => r.cat === 'subagent.history-summary')?.newestAgeMs, 60000);
  assert.equal(records.filter(r => r.cat === 'subagent.bootstrap-candidate').length, 0);
});

test('post-bootstrap stale sightings remain attributable fallback assumptions', t => {
  const h = setup(t);
  h.scan();
  t.mock.timers.tick(1000);
  h.seed('late', 90000);
  h.scan();
  assert.deepEqual(records.find(r => r.cat === 'subagent.assumed-finished'),
    { cat: 'subagent.assumed-finished', sid: h.id, agentId: 'late', ageMs: 90000, bootstrap: false, recheck: true, source: 'transcript-mtime', confidence: 'inferred' });
  assert.equal(records.filter(r => r.cat === 'subagent.history-summary').length, 1);
  assert.equal(h.events.length, 0);
});

test('spawn, heartbeat and silence completion retain distinct fallback evidence', t => {
  const h = setup(t);
  h.scan();
  t.mock.timers.tick(1000);
  const file = h.seed('live', 0);
  h.scan();
  t.mock.timers.tick(20000);
  fs.utimesSync(file, Date.now() / 1000, Date.now() / 1000);
  h.scan();
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(5000); fireTimers(); }
  const spawned = records.filter(r => r.cat === 'subagent.spawned');
  assert.deepEqual(spawned.map(r => r.kind), ['spawn', 'heartbeat']);
  assert.ok(spawned.every(r => r.source === 'transcript-mtime' && r.confidence === 'inferred'));
  const completed = records.filter(r => r.cat === 'subagent.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].reason, 'mtime-stable');
  assert.equal(completed[0].confidence, 'inferred');
});

test('disabled tracing emits nothing while preserving transition behavior', t => {
  const h = setup(t, { trace: false });
  h.seed('old', 120000);
  h.scan();
  t.mock.timers.tick(1000);
  h.seed('live', 0);
  h.scan();
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(5000); fireTimers(); }
  assert.deepEqual(records, []);
  assert.deepEqual(h.events.map(e => e.channel), ['subagent-spawned', 'subagent-completed']);
});

test('real worker explicit lifecycle survives silence and traces completion once without replaying history', async t => {
  let client;
  const h = setup(t, { hasTaskRecord: (id, agent) => client.hasRecord(id, agent) });
  client = createTaskRecordsClient();
  t.after(() => client.dispose());
  const file = path.join(h.dir, `${h.id}.jsonl`);
  fs.writeFileSync(file, [fixture.use, fixture.launch].map(e => JSON.stringify(e) + '\n').join(''));
  await client.read(file, h.id);
  h.seed(fixture.agentId, 120000);
  h.scan();
  t.mock.timers.tick(600000);
  h.scan();
  assert.equal(records.filter(r => r.cat === 'subagent.completed').length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(client.snapshots()[0].tasks.find(r => r.id === fixture.agentId).terminal, false);
  fs.appendFileSync(file, JSON.stringify(fixture.notification) + '\n');
  await client.read(file, h.id);
  await client.read(file, h.id);
  const completed = records.filter(r => r.cat === 'subagent.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].agentId, fixture.agentId);
  assert.equal(completed[0].reason, 'cli-task-terminal');
  assert.equal(completed[0].cause, 'cli-task-terminal');
  assert.equal(completed[0].source, 'cli-task');
  assert.equal(completed[0].confidence, 'explicit');
  await client.dispose();
  client = createTaskRecordsClient();
  await client.read(file, h.id);
  assert.equal(records.filter(r => r.cat === 'subagent.completed').length, 1, 'historical terminal replay is not a live completion');
});

for (const enabled of [true, false]) {
  test(`owner death ends three open agents without claiming recorded completion (trace: ${enabled})`, async t => {
    const h = setup(t, { trace: enabled });
    const client = createTaskRecordsClient();
    t.after(() => client.dispose());
    const file = path.join(h.dir, `${h.id}.jsonl`);
    const entries = [1, 2, 3].flatMap(index => [fixture.use, fixture.launch].map(entry => {
      const copy = JSON.parse(JSON.stringify(entry).replaceAll(fixture.agentId, `agent-${index}`).replaceAll('toolu_111', `toolu_${index}`));
      copy.uuid += `-${index}`;
      return copy;
    }));
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry) + '\n').join(''));
    await client.read(file, h.id);
    assert.equal(client.snapshots()[0].tasks.filter(task => !task.terminal).length, 3);
    await client.ownerDied(h.id);
    await client.ownerDied(h.id);
    await client.read(file, h.id);
    assert.equal(client.snapshots()[0].tasks.filter(task => task.terminal).length, 3);
    const completed = records.filter(record => record.cat === 'subagent.completed');
    assert.equal(completed.length, enabled ? 3 : 0);
    if (enabled) {
      assert.deepEqual(completed.map(record => record.agentId).sort(), ['agent-1', 'agent-2', 'agent-3']);
      for (const record of completed) {
        assert.equal(record.confidence, 'inferred');
        assert.equal(record.cause, 'owner-death');
        assert.equal(record.reason, 'owner-death');
        assert.equal(record.source, 'cli-task');
      }
    } else assert.deepEqual(records, []);
  });
}

test('CLI completion after owner restart stays explicit despite an earlier death snapshot', async t => {
  const h = setup(t);
  const client = createTaskRecordsClient();
  t.after(() => client.dispose());
  await client.ownerDied(h.id);
  await client.ownerAlive(h.id);
  const diedAt = client.snapshots()[0].ownerDiedAt;
  const entries = [fixture.use, fixture.launch, fixture.notification].map((entry, index) => ({
    ...structuredClone(entry), timestamp: new Date(diedAt + (index + 1) * 1000).toISOString(),
  }));
  const file = path.join(h.dir, `${h.id}.jsonl`);
  fs.writeFileSync(file, entries.slice(0, 2).map(entry => JSON.stringify(entry) + '\n').join(''));
  await client.read(file, h.id);
  assert.equal(client.snapshots()[0].tasks[0].terminal, false);
  fs.appendFileSync(file, JSON.stringify(entries[2]) + '\n');
  await client.read(file, h.id);
  await client.ownerDied(h.id);
  const completed = records.filter(record => record.cat === 'subagent.completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].reason, 'cli-task-terminal');
  assert.equal(completed[0].cause, 'cli-task-terminal');
  assert.equal(completed[0].confidence, 'explicit');
});

test('disabled registry tracing never evaluates the lifecycle comparison payload', async t => {
  const h = setup(t, { trace: false });
  const worker = new EventEmitter();
  const snapshot = { parentSessionId: h.id,
    get tasks() { throw new Error('trace-only task enumeration while disabled'); },
    get ownerDiedAt() { throw new Error('trace-only death cause evaluation while disabled'); } };
  worker.postMessage = message => {
    worker.emit('message', { snapshot });
    worker.emit('message', { requestId: message.requestId });
  };
  worker.terminate = async () => {};
  const client = createTaskRecordsClient({ workerFactory: () => worker });
  t.after(() => client.dispose());
  await client.ownerAlive(h.id);
  await client.ownerDied(h.id);
  assert.deepEqual(records, []);
  assert.equal(client.snapshots()[0], snapshot);
});
