'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const cliSessionState = require('../cli-session-state');
const loadGetProjectsHandler = require('./get-projects-handler.cjs');

function handler(overrides = {}) {
  const context = {
    console,
    TRACE: { on: false },
    performance,
    projectsReconciledAt: 0,
    getSetting: () => null,
    setSetting: () => {},
    isInitialScanComplete: () => true,
    isCachePopulated: () => true,
    isSearchIndexPopulated: () => true,
    normalizeHosts: () => [],
    parseFolderKey: () => ({ alias: null }),
    populateCacheViaWorker: () => assert.fail('warm cache must not populate'),
    backfillEntrypoints: () => {},
    backfillCustomTitles: () => {},
    reconcileCacheFromFilesystem: () => assert.fail('sync sweep ran on main'),
    buildProjectsFromCache: () => assert.fail('sync build ran on main'),
    projectsClient: { request: async () => ({ defaultProjects: [], allProjects: [], rows: 0 }) },
    mergePlaceholderSessions: projects => projects,
    applyAndPersistArchived: projects => projects,
    annotateRemoteAttachable: projects => projects,
    ...overrides,
  };
  context.writer = { applyAndPersistArchived: context.applyAndPersistArchived };
  return loadGetProjectsHandler(context);
}

test('warm get-projects relays to the worker without sweeping or building on main', async () => {
  let requests = 0;
  const projects = [{ projectPath: '/fixture', sessions: [] }];
  const invoke = handler({ projectsClient: { request: async () => {
    requests++;
    return { defaultProjects: projects, allProjects: projects, rows: 3 };
  } } });
  assert.deepEqual(await invoke(null, false), projects);
  assert.equal(requests, 1);
});

test('get-projects exposes a live scheduled member in both views and removes it after exit', async t => {
  const child = new EventEmitter();
  child.pid = 12345;
  cliSessionState.trackScheduleRun('scheduled-head', child, '/fixture', 'Audit');
  t.after(() => child.emit('exit', 0));
  const local = { sessionId: 'root', headSessionId: 'scheduled-head', mergedMemberIds: ['scheduled-head'] };
  const remote = { sessionId: 'scheduled-head', remoteAlias: 'host' };
  const projects = [{ projectPath: '/fixture', sessions: [local] }, { projectPath: '/fixture', remoteAlias: 'host', sessions: [remote] }];
  const invoke = handler({ projectsClient: { request: async () => ({ defaultProjects: projects, allProjects: projects, rows: 2 }) } });
  const running = await invoke(null, 'both');
  for (const view of [running.defaultProjects, running.allProjects]) {
    assert.deepEqual(view[0].sessions[0].runningScheduleIds, ['scheduled-head']);
    assert.equal(view[1].sessions[0].runningScheduleIds, undefined);
  }
  child.emit('exit', 0);
  const ended = await invoke(null, 'both');
  for (const view of [ended.defaultProjects, ended.allProjects]) assert.equal(view[0].sessions[0].runningScheduleIds, undefined);
});

test('paired get-projects traces worker-measured bytes without serializing views on main', async () => {
  const visible = [{ sessions: [{ sessionId: 'v' }] }];
  const all = [...visible, { sessions: [{ sessionId: 'a', archived: 1 }] }];
  const events = [];
  const invoke = handler({
    TRACE: { on: true },
    Buffer,
    JSON: { stringify: () => assert.fail('full reply serialized on main') },
    trace: (...args) => events.push(args),
    projectsClient: { request: async () => ({ defaultProjects: visible, allProjects: all, rows: 2, replyBytes: { both: 123, default: 45, all: 67 } }) },
  });
  const reply = await invoke(null, 'both');
  assert.deepEqual(reply.defaultProjects, visible);
  assert.deepEqual(reply.allProjects, all);
  assert.equal(events[0][0], 'ipc.get-projects');
  assert.equal(events[0][2].rows, 2);
  assert.equal(events[0][2].replyBytes, 123);
  assert.ok(events[0][2].totalMs >= 0);
});

test('boolean and paired replies apply archive policy in the original order', async () => {
  const flags = [];
  const invoke = handler({ applyAndPersistArchived: (projects, archived) => {
    flags.push(archived);
    return projects;
  } });
  await invoke(null, false);
  await invoke(null, true);
  await invoke(null, 'both');
  assert.deepEqual(flags, [false, true, false, true]);
});

test('projects snapshot carries cached background state and attach identity in its version', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function projectsSnapshot()');
  const end = source.indexOf('\nconst projectsClient', start);
  const descriptor = { sessionId: 'head', kind: 'bg', jobId: 'job', name: 'registry', nameSource: 'user' };
  const job = { state: 'working', name: 'launch', nameSource: 'collision', sessionId: 'head' };
  const context = {
    activeSessions: new Map([['tab', { isAttach: true, attachJobId: 'job', realSessionId: 'head', cwd: '/fixture', host: null }]]),
    cliSessionState: { getSidebarDescriptors: () => [descriptor] },
    bgAgents: { getCachedJobs: () => new Map([['job', job]]) },
    sessionCache: { getRemoteRoots: () => new Map() },
    getProjectsRevision: () => 'db-version',
  };
  vm.runInNewContext(source.slice(start, end), context, { filename: path.join(__dirname, '../main.js'),
    lineOffset: source.slice(0, start).split('\n').length - 1 });
  const first = context.projectsSnapshot();
  assert.equal(first.localDescriptors[0].name, 'registry');
  assert.equal(first.localJobs[0][1].state, 'working');
  assert.equal(first.localJobs[0][1].nameSource, 'collision');
  assert.equal(first.localJobs[0][1].sessionId, 'head');
  const attach = first.activeSessions[0][1];
  for (const field of ['isAttach', 'attachJobId', 'realSessionId', 'cwd', 'host']) {
    assert.equal(attach[field], context.activeSessions.get('tab')[field]);
  }
  descriptor.name = 'renamed';
  const renamed = context.projectsSnapshot();
  assert.notEqual(renamed.version, first.version);
  assert.notEqual(renamed.liveVersion, first.liveVersion);
  job.state = 'completed';
  const completed = context.projectsSnapshot();
  assert.notEqual(completed.version, renamed.version);
  assert.notEqual(completed.liveVersion, renamed.liveVersion);
});
