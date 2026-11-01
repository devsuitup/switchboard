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

function mainWiring(taskRecords) {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("const sessionTransitions = require('./session-transitions');");
  const end = source.indexOf('// a session with a live PTY', start);
  assert.ok(start >= 0 && end > start);
  let options;
  let listener;
  let refreshed = 0;
  const cliState = { init() {}, onStatusesChanged: fn => { listener = fn; }, getSidebarDescriptors: () => [] };
  const ctx = vm.createContext({
    require: name => name === './cli-session-state' ? cliState : { init: value => { options = value; },
      refreshDescriptorSessions: () => { refreshed++; }, detectPendingBackgroundContinuations() {} },
    PROJECTS_DIR: '/projects', activeSessions: new Map(), mainWindow: null, log: silent, rekeyMcpServer() {},
    persistBackgroundHandoff() {}, activityReporter: {}, writer: {}, bgAgents: {},
    path, notifyRendererProjectsChanged() {}, taskRecords,
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
