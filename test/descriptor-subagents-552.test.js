'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const transitions = require('../session-transitions');
const cli = require('../cli-session-state');
const { encodeProjectPath } = require('../encode-project-path');
const { createTaskRecordsClient } = require('../task-records-client');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');

const id = fixture.parentSessionId;
const silent = { info() {}, warn() {}, debug() {} };

function descriptorFixture(t) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'descriptor-991-')));
  const folder = encodeProjectPath(tmp);
  const dir = path.join(tmp, folder);
  fs.mkdirSync(dir);
  const events = [];
  const seeds = [];
  const warnings = [];
  const activeSessions = new Map();
  const descriptors = [];
  const options = { PROJECTS_DIR: tmp, activeSessions, log: { ...silent, warn: message => warnings.push(message) },
    rekeyMcpServer() {}, clearOwner: () => 'mine', getLiveDescriptors: () => descriptors,
    onDescriptorSession: (sessionId, session) => seeds.push({ sessionId, session }),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  t.after(() => {
    transitions.init({ PROJECTS_DIR: tmp, activeSessions: new Map(), log: silent });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const child = sessionId => {
    const subdir = path.join(dir, sessionId, 'subagents');
    fs.mkdirSync(subdir, { recursive: true });
    const file = path.join(subdir, 'agent-active.jsonl');
    fs.writeFileSync(file, '{}\n');
    return file;
  };
  const descriptor = sessionId => ({ sessionId, cwd: tmp, pid: 123, startedAt: 1, kind: 'bg' });
  return { tmp, folder, dir, events, seeds, warnings, activeSessions, descriptors, options, child, descriptor };
}

test('987r concurrent writers keep last-writer status without resetting observation', async t => {
  const f = descriptorFixture(t);
  t.mock.timers.reset();
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  const alive = new Set([123, 456]);
  const write = (pid, status) => fs.writeFileSync(path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({ ...f.descriptor(id), pid, status, startedAt: pid }));
  write(123, 'idle');
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {},
    isProcessAlive: pid => alive.has(pid), readParentPid: () => null });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  transitions.init({ ...f.options, getLiveDescriptors: () => cli.getSidebarDescriptors({ allWriters: true }) });
  const file = f.child(id);
  transitions.refreshDescriptorSessions();
  const changed = async (pid, status) => {
    const notification = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('descriptor update timed out')); }, 5000);
      const off = cli.onDescriptorsChanged(() => { clearTimeout(timer); off(); resolve(); });
    });
    write(pid, status);
    await notification;
    transitions.refreshDescriptorSessions();
  };
  await changed(456, 'busy');
  assert.equal(cli.getStatus(id).status, 'busy', 'the second live writer supplies status');
  assert.equal(cli.getSidebarDescriptors()[0].pid, 456, 'sidebar status follows the last writer');
  assert.equal(f.seeds.length, 1, 'the second writer does not replay task history');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  transitions.detectSessionTransitions(f.folder);
  assert.equal(f.events.filter(([channel]) => channel === 'subagent-spawned').length, 1);
  await changed(123, 'idle');
  assert.equal(cli.getStatus(id).status, 'idle');
  await changed(456, 'idle');
  await changed(123, 'busy');
  await changed(456, 'busy');
  assert.equal(f.seeds.length, 1, 'competing live writers do not replay or reset observation');
  assert.equal(f.events.filter(([channel]) => channel === 'subagent-spawned').length, 1);
  assert.equal(f.events.filter(([channel]) => channel === 'subagent-completed').length, 0, 'status flips do not complete the child');
  alive.delete(123);
  await changed(123, 'idle');
  assert.equal(cli.getSidebarDescriptors()[0].pid, 456, 'the surviving writer takes over when the first owner dies');
  assert.equal(f.seeds.length, 1, 'a surviving writer in the same folder continues observation without replay');
  await changed(123, 'busy');
  assert.equal(cli.getSidebarDescriptors()[0].pid, 456, 'a dead competing writer cannot remove the live owner');
});

test('987 task records stop inferred events and the settle loop', t => {
  const f = descriptorFixture(t);
  const file = f.child(id);
  f.descriptors.push(f.descriptor(id));
  let recorded = false;
  let checks = 0;
  transitions.init({ ...f.options, hasTaskRecord: () => { checks++; return recorded; } });
  transitions.refreshDescriptorSessions();
  recorded = true;
  t.mock.timers.tick(5000);
  const settledChecks = checks;
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  t.mock.timers.tick(10000);
  assert.equal(checks, settledChecks, 'recorded tasks do not keep the settle loop alive');
  assert.equal(f.events.length, 0, 'task records suppress inferred file events');
});

test('987r stale pid reuse yields to the live writer and accepts its waiting update', async t => {
  const f = descriptorFixture(t);
  t.mock.timers.reset();
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  const write = (pid, status) => fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
    ...f.descriptor(id), pid, status, procStart: '111', startedAt: pid,
  }));
  write(100, 'busy');
  write(200, 'idle');
  let identityAvailable = true;
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {}, platform: 'linux',
    isProcessAlive: () => true, readProcStart: pid => identityAvailable ? (pid === 200 ? '222' : '111') : null,
    readParentPid: () => null });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  identityAvailable = false;
  assert.equal(cli.getStatus(id)?.status, 'busy', 'a stale writer seeded last cannot overwrite the live status');
  identityAvailable = true;
  assert.equal(cli.getSidebarDescriptors()[0]?.pid, 100, 'sidebar descriptors select the live writer');
  assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }).map(d => d.pid), [100], 'observation excludes the stale writer');
  transitions.init({ ...f.options, getLiveDescriptors: () => cli.getSidebarDescriptors({ allWriters: true }) });
  f.child(id);
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 1, 'the live writer is observed despite an earlier stale descriptor');
  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('descriptor update timed out')); }, 5000);
    const off = cli.onDescriptorsChanged(() => { clearTimeout(timer); off(); resolve(); });
  });
  write(100, 'waiting');
  await changed;
  transitions.refreshDescriptorSessions();
  assert.equal(cli.getStatus(id).status, 'waiting', 'a live waiting update remains authoritative');
  assert.equal(f.seeds.length, 1, 'waiting does not replay observation');
});

test('1000 observing a dead last writer cannot promote an older status after PID reuse', t => {
  const f = descriptorFixture(t);
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  const alive = new Set([100, 200]);
  for (const [pid, status] of [[100, 'waiting'], [200, 'busy']]) {
    fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ ...f.descriptor(id), pid, status }));
  }
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {},
    platform: 'darwin', readParentPid: () => null, isProcessAlive: pid => alive.has(pid) });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  assert.equal(cli.getStatus(id)?.status, 'busy');
  alive.delete(200);
  assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }).map(d => d.pid), [100]);
  alive.add(200);
  assert.equal(cli.getStatus(id), undefined, 'an observed death deletes last-writer status without promotion');
  assert.deepEqual(cli.getSidebarDescriptors(), [], 'default sidebar status cannot promote the older live writer');
});

for (const deathProbe of ['observation', 'status', 'timer', 'seed', 'write']) {
  test(`1000 an exited descriptor stays excluded after unknown-identity PID reuse (${deathProbe})`, t => {
    const f = descriptorFixture(t);
    const sessionsDir = path.join(f.tmp, 'sessions');
    fs.mkdirSync(sessionsDir);
    let alive = deathProbe !== 'seed';
    let event;
    t.mock.method(fs, 'watch', (_dir, callback) => {
      event = callback;
      return { on() {}, close() {} };
    });
    const write = () => fs.writeFileSync(path.join(sessionsDir, '100.json'), JSON.stringify({
      ...f.descriptor(id), pid: 100, status: 'busy',
    }));
    write();
    cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {},
      platform: 'darwin', readParentPid: () => null, isProcessAlive: () => alive });
    t.after(() => cli.stop());
    assert.ok(cli.ensureWatching());
    f.child(id);
    transitions.init({ ...f.options, getLiveDescriptors: () => cli.getSidebarDescriptors({ allWriters: true }) });
    if (alive) {
      assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }).map(d => d.pid), [100]);
      transitions.refreshDescriptorSessions();
    }
    const seeds = f.seeds.length;
    alive = false;
    if (deathProbe === 'status') assert.equal(cli.getStatus(id), undefined);
    if (deathProbe === 'timer') t.mock.timers.tick(5000);
    if (deathProbe === 'write') { event('change', '100.json'); t.mock.timers.tick(150); }
    if (deathProbe === 'observation') {
      assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }), []);
      transitions.refreshDescriptorSessions();
    } else {
      assert.equal(cli.getStatus(id), undefined);
    }
    alive = true;
    assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }), [],
      'PID reuse without a descriptor write cannot resurrect an exited writer');
    assert.equal(cli.getStatus(id), undefined, 'status fallback also excludes the exited writer');
    transitions.refreshDescriptorSessions();
    assert.equal(f.seeds.length, seeds, 'PID reuse cannot replay task history');
    write();
    event('change', '100.json');
    t.mock.timers.tick(150);
    assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }).map(d => d.pid), [100],
      'a fresh valid descriptor write clears the exited mark');
    assert.equal(cli.getStatus(id)?.status, 'busy');
    transitions.refreshDescriptorSessions();
    assert.equal(f.seeds.length, seeds + 1, 'a fresh descriptor can start observation again');
  });
}

test('1000 owner exit fires when observation precedes PID reuse within the probe window', async t => {
  const f = descriptorFixture(t);
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  fs.writeFileSync(path.join(sessionsDir, '100.json'), JSON.stringify({
    ...f.descriptor(id), pid: 100, status: 'busy', procStart: '111',
  }));
  let alive = true;
  const deaths = [];
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {},
    platform: 'linux', readParentPid: () => null, readProcStart: () => null,
    isProcessAlive: () => alive, onOwnerExit: sessionId => deaths.push(sessionId) });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  assert.equal(cli.getStatus(id)?.status, 'busy');
  alive = false;
  assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }), []);
  alive = true;
  assert.equal(cli.getStatus(id), undefined);
  await Promise.resolve();
  assert.deepEqual(deaths, [id], 'an observed dead writer cannot suppress owner exit after PID reuse');
});

test('1006 owner exit ignores an exited status writer after PID reuse', async t => {
  const f = descriptorFixture(t);
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  const alive = new Set([100, 200]);
  const deaths = [];
  let event;
  t.mock.method(fs, 'watch', (_dir, callback) => {
    event = callback;
    return { on() {}, close() {} };
  });
  for (const [pid, status] of [[100, 'waiting'], [200, 'busy']]) {
    fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ ...f.descriptor(id), pid, status }));
  }
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {},
    platform: 'darwin', readParentPid: () => null, isProcessAlive: pid => alive.has(pid),
    onOwnerExit: sessionId => deaths.push(sessionId) });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  assert.equal(cli.getStatus(id)?.status, 'busy', 'B is the last status writer');
  alive.clear();
  assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }), [], 'observation marks both writers exited');
  alive.add(200);
  event('change', '100.json');
  t.mock.timers.tick(cli.FLUSH_MS);
  await Promise.resolve();
  assert.deepEqual(deaths, [id], 'A exiting must notify owner exit before any getStatus despite B PID reuse');
  const status = cli.getStatus(id);
  await Promise.resolve();
  assert.deepEqual(deaths, [id], 'reading status after the owner-exit flush must not notify twice');
  assert.equal(status, undefined, 'owner exit removes the exited cached status writer');
  assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }), [], 'B remains excluded after PID reuse');
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(deaths, [id], 'observation and the liveness timer must not notify twice');
});

test('1000 a rewritten descriptor with a different PID cannot expose its missing cached writer', t => {
  const f = descriptorFixture(t);
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  let event;
  t.mock.method(fs, 'watch', (_dir, callback) => {
    event = callback;
    return { on() {}, close() {} };
  });
  const write = pid => fs.writeFileSync(path.join(sessionsDir, '100.json'), JSON.stringify({
    ...f.descriptor(id), pid, status: 'busy', procStart: '111',
  }));
  write(100);
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {},
    platform: 'linux', readParentPid: () => null, readProcStart: () => null,
    isProcessAlive: pid => pid === 100 });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  assert.equal(cli.getStatus(id)?.status, 'busy');
  write(200);
  event('change', '100.json');
  t.mock.timers.tick(150);
  assert.doesNotThrow(() => cli.getStatus(id), 'a missing cached writer must be treated as stale');
  assert.equal(cli.getStatus(id), undefined);
  assert.deepEqual(cli.getSidebarDescriptors(), []);
});

test('987r observation chooses earliest startedAt independently of descriptor order', t => {
  const f = descriptorFixture(t);
  f.child(id);
  f.descriptors.push({ ...f.descriptor(id), pid: 100, startedAt: 20, cwd: path.join(f.tmp, 'other') },
    { ...f.descriptor(id), pid: 200, startedAt: 10 });
  transitions.init(f.options);
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 1, 'only the earliest live owner bootstraps');
  assert.equal(f.seeds[0].session.projectFolder, f.folder, 'earliest startedAt chooses the transcript folder');
  f.descriptors.reverse();
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 1, 'readdir order cannot reset observation');
});

test('987r observation resets for disjoint owners, folder changes and disappearance', t => {
  const f = descriptorFixture(t);
  f.child(id);
  f.descriptors.push(f.descriptor(id));
  transitions.init(f.options);
  transitions.refreshDescriptorSessions();
  f.descriptors[0] = { ...f.descriptor(id), pid: 456, startedAt: 2 };
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 2, 'disjoint owner sets bootstrap once');
  f.descriptors[0].cwd = path.join(f.tmp, 'other');
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 3, 'a different transcript folder bootstraps once');
  const owner = f.descriptors.pop();
  transitions.refreshDescriptorSessions();
  f.descriptors.push(owner);
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 4, 'disappearance releases observation identity');
});

test('987r pid reuse after caching replaces stale status with the earliest live writer', t => {
  const f = descriptorFixture(t);
  t.mock.timers.reset();
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  let reused = false;
  for (const [pid, startedAt, status] of [[100, 20, 'idle'], [200, 10, 'waiting'], [300, 30, 'busy']]) {
    fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
      ...f.descriptor(id), pid, startedAt, status, procStart: '111',
    }));
  }
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {}, platform: 'linux',
    isProcessAlive: () => true, readProcStart: pid => reused && pid === 300 ? '222' : '111' });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  assert.equal(cli.getStatus(id).status, 'busy', 'seeding keeps last-writer status');
  reused = true;
  assert.equal(cli.getStatus(id).status, 'waiting', 'stale status falls back by earliest startedAt');
  assert.equal(cli.getSidebarDescriptors()[0].pid, 200, 'fallback ignores readdir order');
});

test('987r an invalid descriptor cannot shadow a valid owner', t => {
  const f = descriptorFixture(t);
  f.descriptors.push({ get sessionId() { throw new Error('bad id'); } },
    { ...f.descriptor(id), cwd: null, startedAt: 0 }, f.descriptor(id));
  transitions.init(f.options);
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 1, 'normalization failures do not block valid observation');
  assert.deepEqual(f.warnings, ['[descriptor-subagents] ?: bad id']);
});

test('987r observation retains stale competitor proof when the Windows table becomes unavailable', async t => {
  const f = descriptorFixture(t);
  t.mock.timers.reset();
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  let clock = Date.now() + 1000;
  let readable = true;
  for (const pid of [100, 200]) fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
    ...f.descriptor(id), pid, status: 'busy', procStart: '134319945380279381', pidDomain: 'win32:anchor',
  }));
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {}, platform: 'win32',
    now: () => clock, isProcessAlive: () => true,
    readProcessTable: async () => readable ? new Map([[100, { ppid: 1, created: 134319945380280000n }],
      [200, { ppid: 1, created: 134319945380279381n }]]) : null });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  await cli.refreshProcessTable();
  assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }).map(d => d.pid), [200]);
  readable = false;
  clock += 5000;
  await cli.refreshProcessTable({ force: true });
  assert.deepEqual(cli.getSidebarDescriptors({ allWriters: true }).map(d => d.pid), [200],
    'losing the table must not resurrect a proven stale competing writer');
});

test('987 a pass without a rekey reads descriptors only once', t => {
  const f = descriptorFixture(t);
  let reads = 0;
  transitions.init({ ...f.options, getLiveDescriptors: () => { reads++; return []; } });
  transitions.detectSessionTransitions(f.folder);
  assert.equal(reads, 1, 'an ordinary folder pass does not repeat descriptor reconciliation');
});

test('987 failed descriptor identities back off for 30 seconds and warn once', t => {
  const f = descriptorFixture(t);
  f.child(id);
  f.descriptors.push(f.descriptor(id));
  let scans = 0;
  let fail = true;
  transitions.init({ ...f.options, getMainWindow: () => {
    scans++;
    if (fail) throw new Error('persistent scan failure');
    return null;
  } });
  transitions.refreshDescriptorSessions();
  transitions.refreshDescriptorSessions();
  assert.equal(scans, 1, 'the same failing identity is not retried immediately');
  t.mock.timers.tick(29999);
  transitions.refreshDescriptorSessions();
  assert.equal(scans, 1, 'the failure backoff lasts the full 30 seconds');
  t.mock.timers.tick(1);
  transitions.refreshDescriptorSessions();
  assert.equal(scans, 2, 'the same identity is retried at the backoff boundary');
  assert.equal(f.warnings.length, 1, 'repeated failures of one identity produce one warning');
  fail = false;
  t.mock.timers.tick(30000);
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 1, 'the same identity can recover after backoff');
  f.descriptors[0] = { ...f.descriptor(id), pid: 456 };
  fail = true;
  transitions.refreshDescriptorSessions();
  assert.equal(f.warnings.length, 2, 'a changed identity gets its own warning and immediate attempt');
  f.descriptors.length = 0;
  transitions.refreshDescriptorSessions();
  f.descriptors.push(f.descriptor(id));
  transitions.refreshDescriptorSessions();
  assert.equal(f.warnings.length, 3, 'disappearance releases failure state');
});

test('991 direct descriptor refresh contains a failing reader', t => {
  const f = descriptorFixture(t);
  transitions.init({ ...f.options, getLiveDescriptors: () => { throw new Error('reader unavailable'); } });
  assert.doesNotThrow(() => transitions.refreshDescriptorSessions(), 'every refresh caller is protected from reader failures');
  assert.deepEqual(f.warnings, ['[descriptor-subagents] refresh failed: reader unavailable']);
});

test('991 a failing descriptor does not skip another descriptor or removed-owner pruning', t => {
  const f = descriptorFixture(t);
  const removedId = '11111111-1111-1111-1111-111111111111';
  const badId = '22222222-2222-2222-2222-222222222222';
  const goodId = '33333333-3333-3333-3333-333333333333';
  const removedChild = f.child(removedId);
  f.child(badId);
  f.child(goodId);
  let fail = false;
  transitions.init({ ...f.options, getMainWindow: () => {
    if (fail) { fail = false; throw new Error('descriptor scan failed'); }
    return f.options.getMainWindow();
  } });
  f.descriptors.push(f.descriptor(removedId));
  transitions.refreshDescriptorSessions();
  f.descriptors.splice(0, 1, f.descriptor(badId), f.descriptor(goodId));
  fail = true;
  assert.doesNotThrow(() => transitions.refreshDescriptorSessions(), 'a failed descriptor scan is isolated');
  assert.deepEqual(f.seeds.map(seed => seed.sessionId), [removedId, goodId], 'later descriptors still hydrate');
  assert.deepEqual(f.warnings, [`[descriptor-subagents] ${badId}: descriptor scan failed`], 'one warning identifies the failing descriptor');
  transitions.refreshDescriptorSessions();
  assert.deepEqual(f.seeds.map(seed => seed.sessionId), [removedId, goodId], 'the failed descriptor waits for its retry window');
  t.mock.timers.tick(30000);
  transitions.refreshDescriptorSessions();
  assert.deepEqual(f.seeds.map(seed => seed.sessionId), [removedId, goodId, badId], 'the failed descriptor is retried on the next refresh');
  fs.appendFileSync(removedChild, '{}\n');
  fs.utimesSync(removedChild, new Date(), new Date(Date.now() + 1000));
  t.mock.timers.tick(5000);
  assert.equal(f.events.filter(([, event]) => event.parentSessionId === removedId).length, 0, 'removed descriptors are pruned despite a scan failure');
});

for (const kind of ['fork', 'clear']) {
  test(`991 ${kind} drops an earlier descriptor observation in the rekey pass`, t => {
    const f = descriptorFixture(t);
    const oldId = '11111111-1111-1111-1111-111111111111';
    const file = f.child(id);
    f.descriptors.push(f.descriptor(id));
    f.activeSessions.set(oldId, { projectFolder: f.folder, knownJsonlFiles: new Set(), pty: { pid: 7 } });
    transitions.init(f.options);
    transitions.refreshDescriptorSessions();
    const observed = f.seeds[0].session.knownSubagents.get('active');
    const before = observed.mtimeMs;
    const record = kind === 'fork' ? { type: 'user', forkedFrom: { sessionId: oldId } }
      : { sessionId: id, type: 'user', message: { role: 'user',
        content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } };
    fs.writeFileSync(path.join(f.dir, id + '.jsonl'), JSON.stringify(record) + '\n');
    transitions.detectSessionTransitions(f.folder);
    assert.ok(f.activeSessions.has(id) && !f.activeSessions.has(oldId));
    transitions.detectSubagentTransitions(id, f.activeSessions.get(id), f.dir);
    t.mock.timers.tick(5000);
    fs.appendFileSync(file, '{}\n');
    fs.utimesSync(file, new Date(), new Date());
    t.mock.timers.tick(5000);
    assert.equal(observed.mtimeMs, before, 'the descriptor observation is absent immediately after the rekey pass');
    assert.equal(f.events.filter(([channel]) => channel === 'subagent-spawned').length, 1, 'only the owned observer announces growth');
    t.mock.timers.tick(5000);
    t.mock.timers.tick(30000);
    assert.equal(f.events.filter(([channel]) => channel === 'subagent-completed').length, 1, 'only the owned observer announces completion');
  });
}

for (const kind of ['bg', 'interactive']) {
  test(`987 stale ${kind} descriptor children can become active after bootstrap`, t => {
    const f = descriptorFixture(t);
    const file = f.child(id);
    const stale = new Date(Date.now() - 120000);
    fs.utimesSync(file, stale, stale);
    f.descriptors.push({ ...f.descriptor(id), kind });
    transitions.init(f.options);
    transitions.refreshDescriptorSessions();
    assert.equal(f.events.length, 0, 'bootstrap stays silent for historical children');
    t.mock.timers.tick(5000);
    fs.appendFileSync(file, '{}\n');
    fs.utimesSync(file, new Date(), new Date());
    t.mock.timers.tick(5000);
    assert.equal(f.events.filter(([channel]) => channel === 'subagent-spawned').length, 1, 'a stale descriptor child resumes through the settle tick without a folder event');
    t.mock.timers.tick(5000);
    t.mock.timers.tick(30000);
    assert.equal(f.events.filter(([channel]) => channel === 'subagent-completed').length, 1);
  });
}

function mainWiring(taskRecords, { descriptors = [], hiddenProjects = [] } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("const sessionTransitions = require('./session-transitions');");
  const end = source.indexOf('// a session with a live PTY', start);
  assert.ok(start >= 0 && end > start);
  let options;
  let listener;
  let refreshed = 0;
  const cliState = { init() {}, onStatusesChanged: fn => { listener = fn; }, getSidebarDescriptors: () => descriptors };
  const ctx = vm.createContext({
    require: name => name === './public/worktree-nesting' ? require('../public/worktree-nesting')
      : name === './cli-session-state' ? cliState : { init: value => { options = value; },
      refreshDescriptorSessions: () => { refreshed++; }, detectPendingBackgroundContinuations() {} },
    PROJECTS_DIR: '/projects', activeSessions: new Map(), mainWindow: null, log: silent, rekeyMcpServer() {},
    persistBackgroundHandoff() {}, activityReporter: {}, writer: {}, bgAgents: {},
    path, notifyRendererProjectsChanged() {}, taskRecords,
    getSetting: () => ({ hiddenProjects }),
    parseFolderKey: require('../src/main/remote/remote-hosts').parseFolderKey,
    normalizeArchivedProjectPath: require('../src/main/shared/normalize-project-path').normalizeProjectPath,
  });
  vm.runInContext(source.slice(start, end), ctx, { filename: path.join(__dirname, '../main.js'),
    lineOffset: source.slice(0, start).split('\n').length - 1 });
  return { options, notify: () => listener(), refreshes: () => refreshed };
}

test('startup seeds descriptor activity without waiting for a status edge', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(source, /cliSessionState.ensureWatching\(\);\s+sessionTransitions.refreshDescriptorSessions\(\);/);
});

test('552b settle ticks never refresh the process table without a descriptor change', async t => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cost-552b-')));
  const folder = encodeProjectPath(tmp);
  const subdir = path.join(tmp, folder, id, 'subagents');
  fs.mkdirSync(subdir, { recursive: true });
  const activeSessions = new Map([[id, { projectFolder: folder }]]);
  let refreshes = 0;
  cli.init({ dir: tmp, activeSessions, platform: 'win32', log: silent, now: () => Date.now(),
    readProcessTable: async () => { refreshes++; return new Map(); } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  transitions.init({ PROJECTS_DIR: tmp, activeSessions, log: silent,
    getLiveDescriptors: () => cli.getSidebarDescriptors(),
    getMainWindow: () => null, rekeyMcpServer() {} });
  t.after(() => {
    transitions.init({ PROJECTS_DIR: tmp, activeSessions: new Map(), log: silent });
    cli.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  transitions.detectSessionTransitions(folder);
  fs.writeFileSync(path.join(subdir, 'agent-fresh.jsonl'), '{}\n');
  transitions.detectSessionTransitions(folder);
  await cli.refreshProcessTable();
  refreshes = 0;
  for (let tick = 0; tick < 12; tick++) {
    t.mock.timers.tick(5000);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(refreshes, 0, 'settle ticks must not refresh the process table, even with no descriptors');
});

test('552b idle descriptors skip attach clients and still select an owned worker', async t => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'attach-idle-552b-')));
  const file = path.join(tmp, '123.json');
  const attach = { isAttach: true, projectFolder: 'folder', realSessionId: id };
  const activeSessions = new Map([['attach-tab', attach]]);
  const rescans = [];
  const write = status => fs.writeFileSync(file, JSON.stringify({ pid: 123, sessionId: id,
    status, procStart: '111', cwd: tmp }));
  write('busy');
  cli.init({ dir: tmp, activeSessions, log: silent, isProcessAlive: () => true,
    readProcStart: () => '111', readParentPid: () => null,
    onIdle: (sessionId, session) => rescans.push({ sessionId, session }) });
  t.after(() => { cli.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
  assert.ok(cli.ensureWatching());
  const change = async status => {
    const notification = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { off(); reject(new Error('status change timed out')); }, 5000);
      const off = cli.onStatusesChanged(() => { clearTimeout(timeout); off(); resolve(); });
    });
    write(status);
    await notification;
  };
  await change('idle');
  assert.equal(rescans.length, 0, 'an attach client must not receive onIdle or acquire duplicate subagent state');
  const worker = { projectFolder: 'folder', realSessionId: id };
  activeSessions.set('owned-tab', worker);
  await change('busy');
  await change('idle');
  assert.deepEqual(rescans, [{ sessionId: id, session: worker }], 'the owned worker behind the attach entry still receives onIdle');
});

for (const kind of ['fork', 'clear']) {
  test(`552b a throwing descriptor reader preserves owned ${kind} detection`, t => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-error-552b-')));
    const folder = 'folder';
    fs.mkdirSync(path.join(tmp, folder));
    const activeSessions = new Map([['old-id', { projectFolder: folder, knownJsonlFiles: new Set(), pty: { pid: 7 } }]]);
    const warnings = [];
    transitions.init({ PROJECTS_DIR: tmp, activeSessions,
      log: { ...silent, warn: message => warnings.push(message) },
      getLiveDescriptors: () => { throw new Error('descriptor reader unavailable'); },
      clearOwner: () => 'mine', getMainWindow: () => null, rekeyMcpServer() {} });
    t.after(() => {
      transitions.init({ PROJECTS_DIR: tmp, activeSessions: new Map(), log: silent });
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    const record = kind === 'fork' ? { type: 'user', forkedFrom: { sessionId: 'old-id' } }
      : { sessionId: 'new-id', type: 'user', message: { role: 'user',
        content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } };
    fs.writeFileSync(path.join(tmp, folder, 'new-id.jsonl'), JSON.stringify(record) + '\n');
    assert.doesNotThrow(() => transitions.detectSessionTransitions(folder), 'descriptor errors must not abort owned transition detection');
    assert.ok(activeSessions.has('new-id') && !activeSessions.has('old-id'), `${kind} still rekeys the owned PTY`);
    assert.ok(warnings.some(message => message.includes('descriptor reader unavailable')), 'the descriptor failure is logged');
  });
}

for (const attached of [false, true]) {
  test(`a live bg descriptor hydrates tasks and paints its row with attached=${attached}`, async t => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'descriptor-552-')));
    const projects = path.join(tmp, 'projects');
    const folder = encodeProjectPath(tmp);
    const dir = path.join(projects, folder);
    const subdir = path.join(dir, id, 'subagents');
    const descriptors = path.join(tmp, 'sessions');
    fs.mkdirSync(subdir, { recursive: true });
    fs.mkdirSync(descriptors);
    fs.writeFileSync(path.join(descriptors, '123.json'), JSON.stringify({ pid: 123, sessionId: id,
      kind: 'bg', jobId: 'abcdef12', cwd: tmp, status: 'busy', startedAt: 1 }));
    const secondAgent = 'a2222222222222222';
    const secondUse = structuredClone(fixture.use);
    secondUse.uuid = 'use-2';
    secondUse.message.content[0].id = 'toolu_222';
    secondUse.message.content[0].input.run_in_background = false;
    fs.writeFileSync(path.join(dir, id + '.jsonl'), [fixture.use, fixture.launch, secondUse].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const child = path.join(subdir, `agent-${fixture.agentId}.jsonl`);
    fs.writeFileSync(child, '{}\n');
    fs.writeFileSync(child.replace('.jsonl', '.meta.json'), JSON.stringify(fixture.childMeta));
    const secondChild = path.join(subdir, `agent-${secondAgent}.jsonl`);
    fs.writeFileSync(secondChild, '{}\n');
    fs.writeFileSync(secondChild.replace('.jsonl', '.meta.json'), JSON.stringify({ ...fixture.childMeta, toolUseId: 'toolu_222' }));
    const ctx = setupSidebarDom();
    const row = { sessionId: id, name: 'Background conversation', status: 'busy', bgJobId: 'abcdef12',
      modified: new Date().toISOString() };
    ctx.window.sessionMap.set(id, row);
    if (attached) {
      ctx.window.activePtyIds.add(id);
      ctx.window.openSessions.set(id, { session: row, attach: true, attachJobId: 'abcdef12' });
    }
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [row] })], true);
    const client = createTaskRecordsClient({ onSnapshot: snapshot => ctx.emitTaskSnapshot(snapshot) });
    const reads = [];
    const hydrations = [];
    const { options } = mainWiring({ ...client, read: (...args) => { reads.push(args[1]); return client.read(...args); } });
    const activeSessions = attached ? new Map([[id, { isAttach: true, projectFolder: folder }]]) : new Map();
    cli.init({ dir: descriptors, activeSessions, isProcessAlive: () => true, readProcStart: () => null,
      readParentPid: () => null, log: silent, onIdle() {} });
    cli.ensureWatching();
    transitions.init({ PROJECTS_DIR: projects, activeSessions, log: silent, rekeyMcpServer() {},
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send(channel, payload) {
        if (channel === 'subagent-spawned') ctx.emitSubagentSpawned(payload);
      } } }),
      getLiveDescriptors: () => cli.getSidebarDescriptors(),
      onDescriptorSession: (...args) => {
        const hydration = options.onDescriptorSession(...args);
        hydrations.push(hydration);
        return hydration;
      },
    });
    t.after(async () => {
      cli.stop();
      transitions.detectSessionTransitions(folder);
      await client.dispose();
      ctx.destroy();
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    transitions.detectSessionTransitions(folder);
    assert.deepEqual(reads, [id], 'descriptor discovery replays existing tasks without an open PTY');
    await Promise.all(hydrations);
    const item = ctx.document.getElementById('si-' + id);
    assert.equal(item.querySelector('.session-subagent-count')?.textContent, '2 subagents running');
    assert.ok(ctx.window.taskRegistry.agents(id).some(agent => agent.id === secondAgent), 'unindexed child metadata resolves the synchronous agent identity');
    assert.ok(item.querySelector('.session-icon').classList.contains('session-icon--busy'), 'the replayed open turn has a live working indicator');
    fs.appendFileSync(path.join(dir, id + '.jsonl'), JSON.stringify(fixture.aggregateStopped) + '\n');
    await client.read(path.join(dir, id + '.jsonl'), id);
    assert.equal(item.querySelector('.session-subagent-count'), null, 'completion removes the count');
    assert.equal(ctx.window.taskRegistry.runningAgentCount([id]), 0);
  });
}

test('descriptor watches reuse folder changes and settle ticks, deduplicate PTYs and release disappeared owners', t => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'descriptor-tick-552-')));
  const folder = encodeProjectPath(tmp);
  const dir = path.join(tmp, folder);
  const subdir = path.join(dir, id, 'subagents');
  fs.mkdirSync(subdir, { recursive: true });
  let descriptors = [{ sessionId: id, cwd: tmp, pid: 123, startedAt: 1, kind: 'bg' }];
  const activeSessions = new Map();
  const events = [];
  const seeds = [];
  transitions.init({ PROJECTS_DIR: tmp, activeSessions, log: silent, rekeyMcpServer() {},
    getLiveDescriptors: () => descriptors,
    onDescriptorSession: (...args) => seeds.push(args),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  t.after(() => { descriptors = []; transitions.detectSessionTransitions(folder); fs.rmSync(tmp, { recursive: true, force: true }); });
  transitions.detectSessionTransitions(folder);
  assert.equal(seeds.length, 1, 'descriptor alone starts observation');
  const child = path.join(subdir, 'agent-fresh.jsonl');
  fs.writeFileSync(child, '{}\n');
  transitions.detectSessionTransitions(folder);
  assert.equal(events.filter(([channel]) => channel === 'subagent-spawned').length, 1);
  t.mock.timers.tick(5000);
  t.mock.timers.tick(30000);
  assert.equal(events.filter(([channel]) => channel === 'subagent-completed').length, 1, 'the existing settle tick handles a silent bg owner');
  descriptors = [];
  transitions.detectSessionTransitions(folder);
  fs.writeFileSync(path.join(subdir, 'agent-after.jsonl'), '{}\n');
  transitions.detectSessionTransitions(folder);
  assert.equal(events.filter(([channel]) => channel === 'subagent-spawned').length, 1, 'no observation after descriptor loss');
  descriptors = [{ sessionId: id, cwd: tmp, pid: 124, startedAt: 2, kind: 'interactive' }];
  activeSessions.set(id, { projectFolder: folder });
  transitions.detectSessionTransitions(folder);
  assert.equal(seeds.length, 1, 'an owned PTY keeps its existing observer');
  activeSessions.clear();
  transitions.detectSessionTransitions(folder);
  assert.equal(seeds.length, 2, 'a descriptor works for interactive external owners too');
});

test('main wires descriptor observation to the task worker and descriptor status updates', () => {
  const reads = [];
  const wiring = mainWiring({ read: async (...args) => reads.push(['parent', ...args]), child: async (...args) => reads.push(['child', ...args]) });
  const { options } = wiring;
  assert.equal(typeof options.getLiveDescriptors, 'function', 'transitions receive live descriptors');
  assert.equal(typeof options.onDescriptorSession, 'function', 'new descriptor sessions hydrate the task worker');
  wiring.notify();
  assert.equal(wiring.refreshes(), 1, 'status changes reconcile descriptor observers even without transcript writes');
  return options.onDescriptorSession(id, { _subFileList: [`agent-${fixture.agentId}.jsonl`] }, '/projects/folder').then(() => {
    assert.deepEqual(reads, [['parent', path.join('/projects/folder', id + '.jsonl'), id],
      ['child', path.join('/projects/folder', id, 'subagents', `agent-${fixture.agentId}.jsonl`), id, fixture.agentId]]);
  });
});

test('987 seeded observation survives last-writer death without promoting cached status', t => {
  const f = descriptorFixture(t);
  t.mock.timers.reset();
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  const alive = new Set([123, 456]);
  let now = Date.now();
  for (const pid of alive) {
    fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
      ...f.descriptor(id), pid, status: pid === 123 ? 'busy' : 'waiting', waitingFor: 'input needed',
    }));
  }
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {},
    now: () => now, isProcessAlive: pid => alive.has(pid), readParentPid: () => null });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  transitions.init({ ...f.options, getLiveDescriptors: () => cli.getSidebarDescriptors({ allWriters: true }) });
  f.child(id);
  transitions.refreshDescriptorSessions();
  assert.equal(cli.getSidebarDescriptors()[0].pid, 456, 'seeding retains the last live writer status');
  alive.delete(456);
  now += 6000;
  assert.equal(cli.getStatus(id), undefined, 'a death probe does not promote an older cached status');
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 1, 'the surviving writer keeps observing the same folder without replay');
});

test('987 hidden local projects skip observation and replay while visible worktrees remain eligible', t => {
  const f = descriptorFixture(t);
  const file = f.child(id);
  const descriptors = [f.descriptor(id)];
  const hiddenProjects = [f.tmp.replace(/\\/g, '/')];
  const { options } = mainWiring({}, { descriptors, hiddenProjects });
  transitions.init({ ...f.options, getLiveDescriptors: options.getLiveDescriptors });
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 0, 'hidden project descriptors never bootstrap or replay tasks');
  hiddenProjects.length = 0;
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 1, 'unhiding a project starts observation on the next refresh');
  hiddenProjects.push(f.tmp);
  transitions.refreshDescriptorSessions();
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  t.mock.timers.tick(5000);
  assert.equal(f.events.length, 0, 'hiding a project releases its existing settle observation');
  hiddenProjects.splice(0, 1, 'host::' + f.tmp);
  transitions.refreshDescriptorSessions();
  assert.equal(f.seeds.length, 2, 'a remote hidden entry does not hide a local project');
  hiddenProjects.splice(0, 1, f.tmp);
  descriptors[0] = { ...f.descriptor(id), cwd: path.join(f.tmp, '.work-files', 'worktrees', '987') };
  assert.equal(options.getLiveDescriptors().length, 1, 'a separately visible worktree of a hidden repository stays eligible');
});

test('987r hidden repositories exclude nested claude worktree descriptors', t => {
  const f = descriptorFixture(t);
  const descriptors = [{ ...f.descriptor(id), cwd: path.join(f.tmp, '.claude', 'worktrees', 'nested') }];
  const hiddenProjects = [f.tmp.replace(/\\/g, '/')];
  const { options } = mainWiring({}, { descriptors, hiddenProjects });
  assert.equal(options.getLiveDescriptors().length, 0, 'a hidden repository also hides its claude worktree');
});
