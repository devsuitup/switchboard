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

// #1125: the reconcile throttle after a cold scan, undelivered reconciles, stale deliveries and conflict diagnostics.
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a completed cold scan advances the reconcile throttle', async () => {
  let now = 100000, scanDone = false, finishScan;
  const requests = [];
  const scan = new Promise(resolve => { finishScan = resolve; });
  const invoke = handler({
    Date: { now: () => now },
    isInitialScanComplete: () => scanDone,
    populateCacheViaWorker: () => scan,
    projectsClient: { request: async options => { requests.push(options); return { defaultProjects: [], allProjects: [] }; } },
  });
  await invoke(null, false);
  assert.equal(requests[0].reconcile, false, 'a cold load never reconciles');
  scanDone = true;
  finishScan({ ok: true });
  await flush();
  await invoke(null, false);
  assert.equal(requests[1].reconcile, false, 'the scan just read every file: the first post-scan load is a plain build');
  now += 5000;
  await invoke(null, false);
  assert.equal(requests[2].reconcile, true);
});

test('a cold scan that ends without the completeness marker leaves the throttle alone', async () => {
  const requests = [];
  const invoke = handler({
    isInitialScanComplete: () => false,
    populateCacheViaWorker: async () => {},
    projectsClient: { request: async options => { requests.push(options); return { defaultProjects: [], allProjects: [] }; } },
  });
  await invoke(null, false);
  await flush();
  assert.equal(invoke.reconciledAt(), 0);
});

test('an undelivered reconcile notifies the renderer once, a delivered one never', () => {
  const notifications = [];
  const invoke = handler({ notifyRendererProjectsChanged: cause => notifications.push(cause) });
  invoke.accepted({ reconciled: true }, { delivered: false });
  assert.deepEqual(notifications, ['reconcile']);
  assert.ok(invoke.reconciledAt() > 0);
  invoke.accepted({ reconciled: true }, { delivered: true });
  invoke.accepted({ reconciled: false }, { delivered: false });
  assert.deepEqual(notifications, ['reconcile'], 'a delivered result or a plain build never notifies');
});

test('a stale delivery returns both views, projectsStale: true, and schedules a conflict notification', async () => {
  const notifications = [];
  const projects = [{ projectPath: '/fixture', sessions: [] }];
  const invoke = handler({
    notifyRendererProjectsChanged: cause => notifications.push(cause),
    projectsClient: { request: async () => ({ defaultProjects: projects, allProjects: projects, stale: true }) },
  });
  const reply = await invoke(null, 'both');
  assert.deepEqual(reply.defaultProjects, projects);
  assert.deepEqual(reply.allProjects, projects);
  assert.equal(reply.projectsStale, true);
  assert.equal(reply.projectsError, undefined);
  assert.deepEqual(notifications, ['conflict']);
  const fresh = handler({
    notifyRendererProjectsChanged: cause => notifications.push(cause),
    projectsClient: { request: async () => ({ defaultProjects: projects, allProjects: projects }) },
  });
  const accepted = await fresh(null, 'both');
  assert.equal(accepted.projectsStale, undefined);
  assert.deepEqual(notifications, ['conflict'], 'an accepted reply never notifies');
});

test('a terminal conflict logs the changed live component', async () => {
  const warnings = [];
  const conflict = fields => Object.assign(new Error('Projects changed while loading; reload to retry.'),
    { code: 'PROJECTS_SNAPSHOT_CONFLICT', dispatches: 3, reconcile: false, ...fields });
  let error;
  const invoke = handler({ log: { warn: line => warnings.push(line) }, projectsClient: { request: async () => { throw error; } } });
  const same = { activeSessions: [], remoteRoots: [], localJobs: [] };
  error = conflict({ reason: 'live', before: JSON.stringify({ ...same, localDescriptors: [] }), after: JSON.stringify({ ...same, localDescriptors: [{ sessionId: 'new' }] }) });
  assert.deepEqual(JSON.parse(JSON.stringify(await invoke(null, 'both'))), { projectsError: { code: 'PROJECTS_SNAPSHOT_CONFLICT', message: 'Projects changed while loading; reload to retry.' } });
  assert.match(warnings[0], /^\[projects\] snapshot conflict after 3 dispatches: reason=live changed=localDescriptors reconcile=false$/);
  error = conflict({ reason: 'live', before: 'not json', after: JSON.stringify(same) });
  await invoke(null, 'both');
  assert.match(warnings[1], /reason=live changed=unknown/);
  error = conflict({ reason: 'live', before: JSON.stringify({ ...same, localDescriptors: [] }), after: JSON.stringify({ activeSessions: [{}], remoteRoots: [], localJobs: [{}], localDescriptors: [] }) });
  await invoke(null, 'both');
  assert.match(warnings[2], /changed=activeSessions,localJobs/);
  error = conflict({ reason: 'db', reconcile: true });
  await invoke(null, 'both');
  assert.match(warnings[3], /^\[projects\] snapshot conflict after 3 dispatches: reason=db reconcile=true$/);
});

test('a caller timeout logs the job options and dispatch count, or unknown when the error carries none', async () => {
  const warnings = [];
  let error;
  const invoke = handler({ log: { warn: line => warnings.push(line) }, console: { ...console, error() {} }, projectsClient: { request: async () => { throw error; } } });
  error = Object.assign(new Error('projects worker timed out'), { code: 'PROJECTS_WORKER_TIMEOUT', timeoutMs: 30000, reconcile: true, dispatches: 2 });
  await assert.rejects(invoke(null, 'both'), /timed out/);
  assert.equal(warnings[0], '[projects] get-projects timed out after 30000 ms: reconcile=true dispatches=2');
  error = Object.assign(new Error('projects worker timed out'), { code: 'PROJECTS_WORKER_TIMEOUT', timeoutMs: 30000 });
  await assert.rejects(invoke(null, 'both'), /timed out/);
  assert.equal(warnings[1], '[projects] get-projects timed out after 30000 ms: reconcile=unknown dispatches=unknown');
});

test('an accepted paired reply is remembered as the last known projects; stale and boolean replies are not', async () => {
  const remembered = [];
  const projects = [{ projectPath: '/fixture', sessions: [] }];
  let stale = false;
  const invoke = handler({
    lastKnownProjects: { remember: payload => remembered.push(payload) },
    projectsClient: { request: async () => ({ defaultProjects: projects, allProjects: projects, projection: { buildId: 1 }, ...(stale ? { stale: true } : {}) }) },
  });
  await invoke(null, false);
  assert.equal(remembered.length, 0, 'a boolean reply is not the sidebar payload');
  await invoke(null, 'both');
  assert.equal(remembered.length, 1, 'an accepted paired reply is remembered');
  assert.deepEqual(Object.keys(remembered[0]).sort(), ['allProjects', 'defaultProjects'], 'the projection is not persisted');
  assert.deepEqual(remembered[0].defaultProjects, projects);
  stale = true;
  await invoke(null, 'both');
  assert.equal(remembered.length, 1, 'a stale delivery is never remembered');
});
