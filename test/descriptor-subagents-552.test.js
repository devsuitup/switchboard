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

test('987 concurrent writers retain the first live descriptor owner and its observation', async t => {
  const f = descriptorFixture(t);
  t.mock.timers.reset();
  const sessionsDir = path.join(f.tmp, 'sessions');
  fs.mkdirSync(sessionsDir);
  const alive = new Set([123, 456]);
  const write = (pid, status) => fs.writeFileSync(path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({ ...f.descriptor(id), pid, status, startedAt: pid }));
  write(123, 'busy');
  cli.init({ dir: sessionsDir, activeSessions: f.activeSessions, log: silent, onIdle() {},
    isProcessAlive: pid => alive.has(pid), readParentPid: () => null });
  t.after(() => cli.stop());
  assert.ok(cli.ensureWatching());
  transitions.init({ ...f.options, getLiveDescriptors: () => cli.getSidebarDescriptors() });
  const file = f.child(id);
  transitions.refreshDescriptorSessions();
  const first = cli.getSidebarDescriptors()[0];
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
  await changed(123, 'idle');
  await changed(456, 'idle');
  assert.equal(cli.getSidebarDescriptors()[0].pid, first.pid, 'the first live owner survives competing status writes');
  assert.equal(f.seeds.length, 1, 'competing live writers do not replay or reset observation');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  transitions.detectSessionTransitions(f.folder);
  assert.equal(f.events.filter(([channel]) => channel === 'subagent-spawned').length, 1);
  alive.delete(123);
  await changed(123, 'idle');
  assert.equal(cli.getSidebarDescriptors()[0].pid, 456, 'the surviving writer takes over when the first owner dies');
  assert.equal(f.seeds.length, 2, 'a real owner replacement bootstraps once');
  await changed(123, 'busy');
  assert.equal(cli.getSidebarDescriptors()[0].pid, 456, 'a dead competing writer cannot remove the live owner');
});

test('987 task records settle descriptor history immediately and stop the settle loop', t => {
  const f = descriptorFixture(t);
  const file = f.child(id);
  f.descriptors.push(f.descriptor(id));
  let recorded = false;
  let checks = 0;
  transitions.init({ ...f.options, hasTaskRecord: () => { checks++; return recorded; } });
  transitions.refreshDescriptorSessions();
  const entry = f.seeds[0].session.knownSubagents.get('active');
  assert.ok(entry._recheckStart);
  recorded = true;
  t.mock.timers.tick(5000);
  assert.equal(entry._recheckStart, null, 'a recorded task releases its historical recheck window');
  const settledChecks = checks;
  fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
  t.mock.timers.tick(10000);
  assert.equal(checks, settledChecks, 'recorded tasks do not keep the settle loop alive');
  assert.equal(f.events.length, 0, 'task records suppress inferred file events');
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
    require: name => name === './cli-session-state' ? cliState : { init: value => { options = value; },
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

test('987 seeded concurrent writers hand over on a lazy death probe without another file write', t => {
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
  transitions.init({ ...f.options, getLiveDescriptors: () => cli.getSidebarDescriptors() });
  f.child(id);
  transitions.refreshDescriptorSessions();
  assert.equal(cli.getSidebarDescriptors()[0].pid, 123, 'seeding retains the first live writer');
  alive.delete(123);
  now += 6000;
  assert.equal(cli.getSidebarDescriptors().length, 1, 'promoting a writer during enumeration yields one descriptor');
  transitions.refreshDescriptorSessions();
  assert.equal(cli.getSidebarDescriptors()[0].pid, 456, 'a lazy probe returns the promoted descriptor, not the dead one');
  assert.equal(cli.getStatus(id).status, 'waiting', 'takeover preserves the replacement status');
  assert.equal(f.seeds.length, 2, 'a lazy owner replacement resets observation exactly once');
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
