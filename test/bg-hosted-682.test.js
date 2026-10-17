'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const bg = require('../bg-agents');
const cli = require('../cli-session-state');
const ipc = require('../bg-agents-ipc');
const { mergeRoster, isHostedJob } = require('../bg-agents-roster');
const { parseFolderKey } = require('../remote-hosts');

const SID = 'aaaaaaaa-1234-4321-abcd-123456789abc';
const JOB = 'aaaaaaaa';

function fixture(t, { state = 'done', alive = true, kind = 'bg', jobId = JOB, sessionId = SID } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hosted-682-'));
  const jobs = path.join(dir, 'jobs');
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(path.join(jobs, JOB), { recursive: true });
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(jobs, JOB, 'state.json'), JSON.stringify({ state, sessionId: SID }));
  const descriptor = path.join(sessions, '77.json');
  const writeDescriptor = () => fs.writeFileSync(descriptor, JSON.stringify({ pid: 77, kind, jobId, sessionId, status: 'idle', statusUpdatedAt: 1 }));
  writeDescriptor();
  cli.init({ dir: sessions, activeSessions: new Map(), onIdle() {}, isProcessAlive: () => alive, readProcStartMany: async () => new Map() });
  const calls = [], pushes = [], handlers = new Map();
  bg.init({ jobsDir: jobs, homeDir: dir, cliSessionState: cli, resolveProjectRoots: async () => null,
    runClaude: async args => {
      calls.push(args);
      return { code: 0, stdout: args[0] === 'agents' ? JSON.stringify([{ id: JOB, sessionId: SID, state, kind: 'background', cwd: dir }]) : '', stderr: '' };
    } });
  ipc.init({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, bgAgents: bg, cliSessionState: cli,
    activeSessions: new Map(), sessionHasPty: () => false, ptyPids: () => [],
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (name, snapshot) => pushes.push([name, snapshot]) } }), log: { warn() {} } });
  t.after(() => { bg.stop(); cli.stop(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  return { calls, pushes, handlers, descriptor, writeDescriptor, jobFile: path.join(jobs, JOB, 'state.json') };
}

test('done with live bg descriptor allows Stop and refuses destructive verbs at service and IPC boundaries', async t => {
  const f = fixture(t);
  await f.handlers.get('get-bg-agents')();
  assert.equal(bg.getSnapshot().roster[0].hosted, true);
  assert.equal(bg.liveJobCheck(SID).job.id, JOB);
  for (const verb of ['rm', 'respawn']) {
    assert.equal((await bg.runVerb(verb, JOB)).ok, false);
    assert.equal((await f.handlers.get('bg-agent-verb')(null, verb, JOB)).ok, false);
    assert.equal(f.calls.some(args => args[0] === verb), false);
  }
  assert.equal((await f.handlers.get('bg-agent-verb')(null, 'stop', JOB)).ok, true);
  assert.equal(f.calls.some(args => args[0] === 'stop'), true);
});

for (const options of [
  { alive: false }, { state: 'failed' }, { state: 'stopped' },
  { kind: 'interactive', sessionId: 'unrelated' }, { jobId: 'bbbbbbbb', sessionId: 'unrelated' },
]) {
  test(`hosted excludes ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    await f.handlers.get('get-bg-agents')();
    assert.equal(bg.getSnapshot().roster.find(e => e.id === JOB).hosted, false);
    assert.equal(bg.liveJobCheck(SID).job, null);
  });
}

test('a different explicit job id cannot host a done job with the same session id', async t => {
  const f = fixture(t, { jobId: 'bbbbbbbb', sessionId: SID.toUpperCase() });
  await f.handlers.get('get-bg-agents')();
  assert.equal(bg.getSnapshot().roster.find(e => e.id === JOB).hosted, false);
});

test('only the named job is hosted when two done jobs share their resumed session', () => {
  const roster = mergeRoster({ jobs: new Map([JOB, 'bbbbbbbb'].map(id => [id, { state: 'done', sessionId: SID }])),
    descriptors: [{ kind: 'bg', jobId: 'bbbbbbbb', sessionId: SID }] });
  assert.equal(roster.find(e => e.id === JOB).hosted, false);
  assert.equal(roster.find(e => e.id === 'bbbbbbbb').hosted, true);
});

test('a descriptor without a job id hosts a matching case-insensitive session', async t => {
  const f = fixture(t, { jobId: null, sessionId: SID.toUpperCase() });
  await f.handlers.get('get-bg-agents')();
  assert.equal(bg.getSnapshot().roster[0].hosted, true);
});

for (const platform of ['win32', 'linux']) {
  test(`a live reused pid is excluded from hosting on ${platform}`, async t => {
    const f = fixture(t);
    cli.stop();
    const sessions = path.dirname(f.descriptor);
    fs.writeFileSync(f.descriptor, JSON.stringify({ pid: 77, kind: 'bg', jobId: JOB, sessionId: SID,
      procStart: '134000000000000000', pidDomain: platform === 'win32' ? 'win32:anchor' : undefined, status: 'idle' }));
    cli.init({ dir: sessions, platform, activeSessions: new Map(), onIdle() {}, now: () => Date.now() + 10000, isProcessAlive: () => true,
      readProcStart: () => '134000000000100000',
      readProcessTable: async () => new Map([[77, { ppid: 1, created: '134000000000100000' }]]) });
    await cli.refreshProcessTable();
    assert.equal(cli.ensureWatching(), true);
    await f.handlers.get('get-bg-agents')();
    assert.deepEqual(cli.readAllDescriptors(), []);
    assert.deepEqual(cli.getSidebarDescriptors(), []);
    assert.equal(bg.getSnapshot().roster.find(e => e.id === JOB).hosted, false);
    assert.equal(bg.liveJobCheck(SID).job, null);
  });
}

test('runVerb reads working state written after a finished roster snapshot', async t => {
  const f = fixture(t, { alive: false });
  await f.handlers.get('get-bg-agents')();
  assert.equal(bg.getSnapshot().roster[0].hosted, false);
  fs.writeFileSync(f.jobFile, JSON.stringify({ state: 'working', sessionId: SID }));
  for (const verb of ['rm', 'respawn']) {
    const result = await bg.runVerb(verb, JOB);
    assert.equal(result.ok, false);
    assert.match(result.error, /working.*stop it first/);
  }
  assert.equal(f.calls.some(args => ['rm', 'respawn'].includes(args[0])), false);
});

test('matching bg job id hosts a done job even when its descriptor names another session id', async t => {
  const f = fixture(t, { sessionId: 'another-session' });
  await f.handlers.get('get-bg-agents')();
  assert.equal(bg.getSnapshot().roster[0].hosted, true);
});

test('an unknown state rewrite does not authorize deleting a cached hosted job', async t => {
  const f = fixture(t, { state: 'working', alive: false });
  await f.handlers.get('get-bg-agents')();
  fs.writeFileSync(f.jobFile, JSON.stringify({ state: 'unknown', sessionId: SID }));
  assert.equal((await bg.runVerb('rm', JOB)).ok, false);
  assert.equal(f.calls.some(args => args[0] === 'rm'), false);
});

test('main continuation, task snapshot and transcript consumers include hosted done jobs', async t => {
  const f = fixture(t);
  await f.handlers.get('get-bg-agents')();
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');
  const block = marker => {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1);
    return source.slice(start, source.indexOf('\n});', start) + 4);
  };
  let transitions, tracker, snapshots;
  const reads = [];
  const context = {
    PROJECTS_DIR: '/projects', activeSessions: new Map(), log: {}, rekeyMcpServer() {},
    sessionTransitions: { init: options => { transitions = options; } },
    cliSessionState: { readAllDescriptors: () => cli.readAllDescriptors(), getSidebarDescriptors: () => [], getStatus: () => null },
    bgAgents: bg, isHostedJob, path, sessionHasPty: () => false,
    taskRecords: { read: async (...args) => reads.push(args), snapshots: () => 'snapshots' },
    getAllCached: () => [{ sessionId: SID, folder: 'folder' }], parseFolderKey,
    projectsDirForFolder: () => '/projects/folder', getCachedByParent: () => [],
    refreshRemoteHeadTurns: async () => {},
    ipcMain: { handle: (_name, handler) => { snapshots = handler; } },
    createLocalTranscriptTracker: options => { tracker = options; },
  };
  vm.runInNewContext(block('sessionTransitions.init({'), context, { filename: 'main.js' });
  assert.equal(transitions.backgroundJobExists(JOB), true);
  assert.equal(transitions.getBackgroundTarget(SID).jobId, JOB);
  vm.runInNewContext(block("ipcMain.handle('get-task-snapshots'"), context, { filename: 'main.js' });
  assert.equal(await snapshots(), 'snapshots');
  assert.equal(reads.length, 1);
  vm.runInNewContext(block('const localTranscriptTracker = createLocalTranscriptTracker('), context, { filename: 'main.js' });
  tracker.onTranscript('/projects/folder/transcript.jsonl', SID);
  assert.equal(reads.length, 2);
  fs.unlinkSync(f.descriptor);
  assert.equal(transitions.backgroundJobExists(JOB), false);
  assert.equal(transitions.getBackgroundTarget(SID), null);
});

test('descriptor appearance and disappearance push badge membership with Agents closed', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.descriptor);
  const dom = new JSDOM('', { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  let receive;
  w.api = { getBgAgents: () => f.handlers.get('get-bg-agents')(), onBgAgentsChanged: cb => { receive = cb; } };
  w.refreshSidebar = () => {};
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/agents-view.js'), 'utf8'), dom.getInternalVMContext(), { filename: path.join(__dirname, '../public/agents-view.js') });
  w.initAgentsView();
  const read = expr => vm.runInContext(expr, dom.getInternalVMContext(), { filename: 'hosted-assertions.js' });
  const wait = predicate => new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    function check() {
      for (const [, snapshot] of f.pushes.splice(0)) receive(snapshot);
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('descriptor push did not update badge'));
      setTimeout(check, 20);
    }
    check();
  });
  await wait(() => bg.getSnapshot().roster.length > 0);
  assert.equal(read('agentsViewActive'), false);
  assert.equal(read(`bgAgentSessionIds.has('${SID}')`), false);
  f.writeDescriptor();
  await wait(() => read(`bgAgentSessionIds.has('${SID}')`));
  assert.equal(read('agentsViewActive'), false);
  fs.unlinkSync(f.descriptor);
  await wait(() => !read(`bgAgentSessionIds.has('${SID}')`));
  assert.equal(bg.getSnapshot().roster[0].hosted, false);
});

test('file-only roster publishes hosted for working and blocked and finished for unhosted done', () => {
  for (const state of ['working', 'blocked', 'done']) {
    const [entry] = mergeRoster({ jobs: new Map([[JOB, { state, sessionId: SID }]]), descriptors: [] });
    assert.equal(entry.hosted, state !== 'done');
  }
});
