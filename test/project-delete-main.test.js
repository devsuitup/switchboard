'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const openStore = require('./fixtures/conversation-store.cjs');
const { createSessionIndexWriter } = require('../session-index-writer');
const { createProjectOperationGate } = require('../src/main/shared/project-operation-gate');
let implementation;
try { implementation = require('../src/main/projects/project-delete-main'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const supported = { skip: !openStore.supported && 'SQLite needs Node 22 or a matching native ABI' };
const options = { sessions: true, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: false };
const flush = () => new Promise(resolve => setImmediate(resolve));
function startupFixture(projectDeleteHolds, overrides = {}) {
  const filename = path.join(__dirname, '..', 'main.js'), source = fs.readFileSync(filename, 'utf8');
  const oldStart = source.indexOf('    void projectDeleteRecovery.then(');
  const start = oldStart >= 0 ? oldStart : source.lastIndexOf('    try {', source.indexOf('scheduleIpc.init(log, runScheduleCommand'));
  const end = source.indexOf('    // Full cache rebuild', start);
  assert.ok(start > 0 && end > start, 'startup callbacks must be extractable without running Electron');
  const order = [], errors = [];
  const context = vm.createContext({
    projectDeleteRecovery: new Promise(() => {}), projectDeleteHolds, appQuitting: false, shutdownPromise: undefined,
    scheduleIpc: { init: () => order.push('ipc') }, runScheduleCommand() {}, isAllowedMemoryPath() {}, isProjectSettingsArchived() {},
    log: { error: (...args) => errors.push(args) }, scheduleProjects: () => ({ list: async () => { order.push('seed'); return []; } }),
    startScheduler: () => order.push('scheduler'), powerMonitor: {}, path, DB_PATH: '/data/db', activeSessions: new Map(),
    cliSessionState: {}, PROJECTS_DIR: '/projects', triggerLifecycleDeps: () => ({}), writer: {},
    createTriggerContext: value => value, require: () => ({ start: () => order.push('trigger') }), ...overrides,
  });
  vm.runInContext(source.slice(start, end), context, { filename });
  return { order, errors, context };
}
function clock() {
  let time = Date.now(), id = 0;
  const timers = new Map();
  return { now: () => time, schedule(fn, ms) { timers.set(++id, { fn, at: time + ms }); return id; },
    cancel: key => timers.delete(key), advance(ms) { time += ms; for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); } }, timers };
}
function windowFixture() {
  const win = new EventEmitter(), wc = new EventEmitter();
  win.webContents = wc; win.isDestroyed = wc.isDestroyed = () => false;
  wc.mainFrame = {}; wc.url = ''; wc.getURL = () => wc.url;
  return win;
}
async function setup(t, populated = false, overrides = {}) {
  assert.equal(typeof implementation?.createProjectDeleteMain, 'function', 'main deletion composition must exist');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-main-')));
  const projectPath = path.join(root, 'repo'), projectsDir = path.join(root, 'transcripts');
  fs.mkdirSync(projectPath); fs.mkdirSync(projectsDir);
  const previousDataDir = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  t.after(() => { process.env.SWITCHBOARD_DATA_DIR = previousDataDir; });
  const db = openStore(); db.setSetting('scheduleProjects', [projectPath]); db.setInitialScanComplete();
  let transcript;
  if (populated) {
    fs.mkdirSync(path.join(projectsDir, 'folder'));
    transcript = path.join(projectsDir, 'folder', 'part.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: 'part', cwd: projectPath, message: { content: 'keep' } }) + '\n');
    db.setFolderMeta('folder', projectPath, 1);
    db.upsertCachedSessions([{ sessionId: 'part', projectPath, folder: 'folder', runtime: 'claude' }]);
  }
  const worker = require('./fixtures/project-deletion-worker.cjs')(db);
  const calls = [], faults = {}, request = worker.client.request;
  worker.client.request = async (command, ...args) => {
    calls.push(command);
    if (faults[command]) return faults[command](...args);
    const result = await request(command, ...args);
    if (command === 'completeProjectDeletion' && faults.lost) throw new Error('lost ACK');
    return result;
  };
  worker.client.requestForWorkflow = (_lease, ...args) => worker.client.request(...args);
  const writer = createSessionIndexWriter({ client: worker.client, readonlyBackend: db }, {}); await writer.ready;
  const time = clock(), notifications = [], handlers = new Map(), bootListeners = new Set();
  let win = windowFixture();
  const activeSessions = new Map();
  const ports = { writer, projectsDir, dataDir: path.join(root, 'data'), activeSessions,
    jobsDir: path.join(root, 'jobs'), runClaude: async () => ({ code: 0, stdout: '[]' }),
    cliSessionState: { getScheduleRunSnapshot: () => [], readStatusEvidence: async () => ({ known: true, live: null }),
      liveElsewhereV1Checked: async () => ({ known: true, live: null }), deliveryPtyStart: () => 'start' },
    ...time, gate: createProjectOperationGate(),
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    getMainWindow: () => win,
    onBootstrap: fn => { bootListeners.add(fn); return () => bootListeners.delete(fn); },
    notifyProjects: (...args) => notifications.push(['projects', ...args]),
    notifySchedules: (...args) => notifications.push(['schedules', ...args]),
    announce: ids => notifications.push(['recovery', ids]),
    getProjectsSnapshot: () => { db.setSetting('preview-mutation', true); return []; },
    scheduleProjects: () => { throw new Error('mutating schedule list'); }, ...overrides };
  const controllers = [];
  const compose = () => { const value = implementation.createProjectDeleteMain(ports); controllers.push(value); return value; };
  const main = compose(); main.attach(win);
  const load = () => { win.webContents.url = 'file:///switchboard/index.html'; win.webContents.emit('did-finish-load'); };
  const invoke = (channel, input) => handlers.get(channel)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, input);
  const preview = () => invoke('preview-project-delete', { projectPath, options });
  const execute = p => invoke('delete-project', { token: p.token, fingerprint: p.plan.fingerprint });
  t.after(() => { controllers.forEach(c => c.dispose()); db.closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
  return { main, ports, compose, db, writer, calls, faults, request, notifications, time, load, invoke, preview, execute, activeSessions, projectPath, transcript,
    replace() { win = windowFixture(); main.attach(win); load(); }, bootstrap() { for (const fn of bootListeners) fn(); } };
}

for (const populated of [false, true]) test(`real composition previews and commits ${populated ? 'populated' : 'empty'} project only after ACK`, supported, async t => {
  const h = await setup(t, populated); h.load(); await h.main.startRecovery();
  const before = h.db.changeCount(); const p = await h.preview();
  assert.equal(p.ok, true, JSON.stringify(p)); assert.ok(p.token, JSON.stringify(p));
  assert.equal(h.db.changeCount(), before, 'preview must not seed, refresh or mutate project lists');
  assert.equal(h.notifications.filter(n => n[0] !== 'recovery').length, 0, 'no publication before committed ACK');
  const result = await h.execute(p);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.calls.filter(c => c === 'completeProjectDeletion').length, 1);
  for (const kind of ['projects', 'schedules']) {
    const notices = h.notifications.filter(n => n[0] === kind);
    assert.equal(notices.length, 1); assert.deepEqual(notices[0][1], result.invalidation);
    assert.equal(notices[0][2], result.operationId); assert.equal(notices[0][3].operationId, result.operationId);
  }
  const state = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.equal(state.state, 'committed');
  if (populated) assert.ok(fs.existsSync(h.transcript));
});

test('early attach binds first loaded document and reload revokes old token', supported, async t => {
  const h = await setup(t); await h.main.startRecovery();
  assert.equal((await h.preview()).code, 'UNAUTHORIZED');
  h.load(); const p = await h.preview(); assert.ok(p.token, 'first load must not remain permanently unauthorized');
  h.replace(); assert.equal((await h.execute(p)).code, 'INVALID_TOKEN');
  assert.ok((await h.preview()).token);
});

for (const failure of ['reject', 'hang']) test(`recovery ${failure} reaches window immediately and startup barrier is bounded`, supported, async t => {
  const warnings = [];
  const h = await setup(t, false, { log: { warn: text => warnings.push(text) } });
  h.faults.listProjectDeletionOperations = () => failure === 'reject' ? Promise.reject(new Error('offline')) : new Promise(() => {});
  const order = [];
  const filename = path.join(__dirname, '..', 'main.js'), source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    const projectDeleteRecovery =') >= 0 ? source.indexOf('    const projectDeleteRecovery =') : source.indexOf('    void projectDeleteMain.startRecovery();');
  const end = source.indexOf('    startProjectsWatcher();', start);
  assert.ok(start > 0 && end > start, 'main startup composition must exist');
  const context = vm.createContext({ projectDeleteMain: h.main, buildMenu() {}, createWindow() { order.push('createWindow'); h.load(); } });
  vm.runInContext(source.slice(start, end), context, { filename, lineOffset: source.slice(0, start).split('\n').length - 1 });
  const recovery = vm.runInContext('projectDeleteHolds', context);
  const startup = startupFixture(recovery);
  assert.deepEqual(order, ['createWindow']);
  await flush(); h.time.advance(120000); await recovery; await flush();
  assert.deepEqual(startup.order, ['ipc', 'seed', 'scheduler', 'trigger'], 'failed recovery must still start automation after the bounded wait');
  assert.equal(warnings.length, 1, 'failed holds wait logs exactly one reason');
  assert.match(warnings[0], failure === 'reject' ? /offline/ : /HOLDS_TIMEOUT.*120000/);
  assert.equal((await h.preview()).code, 'NOT_READY'); assert.equal((await h.preview()).retryable, true);
  assert.equal((await h.invoke('delete-project', { token: 'x', fingerprint: 'x' })).code, 'NOT_READY');
  assert.equal((await h.invoke('project-delete-state', { operationId: 'x' })).code, 'NOT_READY');
});

for (const kind of ['failed-stop', 'replacement', 'success', 'late-natural']) test(`local runtime composition ${kind} preserves pinned stop and housekeeping evidence`, supported, async t => {
  const h = await setup(t, true, { platform: 'win32' });
  const session = { kind: 'local-pty', sessionId: 'part', projectPath: h.projectPath, generation: 7,
    statusPtyStart: 'start', pty: { pid: 123 }, exitDrain: Promise.resolve() };
  h.activeSessions.set('part', session);
  h.main.dispose();
  let kills = 0;
  h.ports.stopPtyWithEvidence = async () => {
    kills++;
    if (kind === 'failed-stop') return { ended: false, generation: 7, pid: 123 };
    session.exited = true;
    session.pty.stopEvidence = Promise.resolve({ ended: true, generation: 7, pid: 123 });
    if (kind === 'late-natural') {
      session.pty.stopEvidence = Promise.resolve({ ended: false, generation: 7, pid: 123 });
      session.pty.statusTreeExit = Promise.resolve({ ended: true, observedAt: h.time.now() });
    }
    h.activeSessions.delete('part');
    if (kind === 'replacement') h.activeSessions.set('part', { ...session, exited: false, generation: 8, pty: { pid: 456 } });
    return kind === 'late-natural' ? { ended: false, generation: 7, pid: 123 } : { ended: true, generation: 7, pid: 123 };
  };
  const composed = h.compose();
  h.replace();
  const win = h.ports.getMainWindow(); composed.attach(win); h.load(); await composed.startRecovery();
  const p = await h.preview(); assert.ok(p.token, JSON.stringify(p));
  const result = await h.execute(p);
  assert.equal(kills, 1);
  const success = ['success', 'late-natural'].includes(kind);
  assert.equal(result.ok, success, JSON.stringify(result));
  assert.equal(h.calls.filter(c => c === 'completeProjectDeletion').length, success ? 1 : 0);
  assert.equal(h.notifications.filter(n => n[0] === 'projects').length, success ? 1 : 0);
});

test('no-tab background records and headless schedules cannot disappear from preview', supported, async t => {
  const h = await setup(t);
  fs.mkdirSync(path.join(h.ports.jobsDir, '1234abcd'), { recursive: true });
  fs.writeFileSync(path.join(h.ports.jobsDir, '1234abcd', 'state.json'), JSON.stringify({ state: 'done', cwd: h.projectPath,
    sessionId: '12345678-1234-1234-1234-123456789abc' }));
  h.ports.cliSessionState.getScheduleRunSnapshot = () => [{ sessionId: 'headless', cwd: h.projectPath, pid: 987, scheduleName: 'scheduled' }];
  h.load(); await h.main.startRecovery(); const p = await h.preview();
  assert.equal(p.token, null); assert.ok(p.plan.jobs.some(row => row.id === '1234abcd')); assert.ok(p.plan.jobs.some(row => row.id === 'headless'));
  assert.ok(p.plan.refusals.some(row => row.error.includes('#1090')));
  assert.equal(h.calls.filter(c => c === 'completeProjectDeletion').length, 0);
});

test('local tab cannot conceal a second external owner of the conversation', supported, async t => {
  const h = await setup(t, true);
  h.activeSessions.set('part', { kind: 'local-pty', projectPath: h.projectPath, generation: 7,
    statusPtyStart: 'start', pty: { pid: 123 }, exitDrain: Promise.resolve() });
  h.ports.cliSessionState.liveElsewhereV1Checked = async () => ({ known: true, live: { pid: 999, procStart: 'other' } });
  h.load(); await h.main.startRecovery(); const p = await h.preview();
  assert.equal(p.token, null, 'external owner must block confirmation despite an active local tab');
  assert.equal(h.calls.filter(c => c === 'completeProjectDeletion').length, 0);
});

test('malformed authoritative background list cannot become an empty inventory', supported, async t => {
  const h = await setup(t, false, { runClaude: async () => ({ code: 0, stdout: '[{"kind":"background","id":"1234abcd"}]' }) });
  h.load(); await h.main.startRecovery();
  assert.equal((await h.preview()).token, null, 'invalid background entry must refuse, never disappear');
});

test('bootstrap during an old recovery read retries before making the service ready', supported, async t => {
  const h = await setup(t); let rejectRead, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  h.faults.listProjectDeletionOperations = () => { entered(); return new Promise((_, reject) => { rejectRead = reject; }); };
  const recovering = h.main.startRecovery(); await reading;
  delete h.faults.listProjectDeletionOperations; h.bootstrap(); rejectRead(new Error('old worker exited'));
  await recovering; h.load();
  assert.ok((await h.preview()).token, 'latest bootstrap must not be lost behind an older recovery');
});

test('late runtime directory handle closes after its read deadline', async () => {
  assert.equal(typeof implementation?.createProjectDeleteRuntime, 'function');
  const time = clock(); let resolveOpen, entered, closed = 0;
  const opening = new Promise(resolve => { entered = resolve; });
  const runtime = implementation.createProjectDeleteRuntime({ ...time, jobsDir: '/jobs', activeSessions: new Map(),
    fs: { lstat: async () => ({ isSymbolicLink: () => false }), opendir: () => { entered(); return new Promise(resolve => { resolveOpen = resolve; }); } } });
  const result = runtime.readJobs({ alias: null, projectPath: '/repo' }, { deadline: time.now() + 100, limit: 10 });
  const refusal = assert.rejects(result, { code: 'DISCOVERY_TIMEOUT' });
  await opening; time.advance(100); await refusal;
  resolveOpen({ close: async () => { closed++; } }); await flush();
  assert.equal(closed, 1, 'late opened directory must be released');
});

test('deletion background discovery bounds the shipped CLI runner output before allocating an unbounded list', async () => {
  const filename = path.join(__dirname, '..', 'main.js'), source = fs.readFileSync(filename, 'utf8');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.pid = 123; child.exitCode = child.signalCode = null;
  const time = clock(); let stopped = 0;
  let measured = 0;
  const countedBuffer = { byteLength: value => { measured += value.length; return Buffer.byteLength(value); } };
  const context = vm.createContext({ Buffer: countedBuffer, path, getSetting: () => ({}), SETTING_DEFAULTS: { shellProfile: 'test' },
    resolveShell: () => ({ path: '/bin/sh' }), isWindows: false, cleanPtyEnv: {}, shellArgs: () => [], quoteArgvForShell: () => '',
    spawnChild: () => child, stopProcessTree: async () => { stopped++; return true; },
    setTimeout: time.schedule, clearTimeout: time.cancel });
  vm.runInContext(require('./app-source').extractFunction(source, 'runClaudeCommand'), context, { filename });
  const pending = context.runClaudeCommand(['agents', '--json', '--all'], { timeout: 1000, maxOutputBytes: 8 });
  child.stdout.emit('data', Buffer.alloc(4, 'x')); child.stderr.emit('data', Buffer.alloc(4, 'y'));
  child.stdout.emit('data', Buffer.alloc(1, 'z')); child.emit('close', 0);
  const result = await pending;
  assert.equal(stopped, 1, 'oversized discovery output must stop its own reader process');
  assert.equal(result.code, null); assert.ok(result.stdout.length <= 8);
  assert.equal(measured, 0, 'buffer chunks must use a running byte count, never rescan collected output');
});

test('recovery deadline covers sequential receipt limits; bootstrap retries before admitting callbacks', supported, async t => {
  const h = await setup(t);
  assert.ok(h.main.recoveryTimeoutMs >= 4096 * 30000 + 65 * 10000, 'deadline must cover bounded enumeration and sequential receipt reconciliation');
  h.faults.listProjectDeletionOperations = () => Promise.reject(new Error('offline'));
  await h.main.startRecovery(); h.load(); assert.equal((await h.preview()).code, 'NOT_READY');
  delete h.faults.listProjectDeletionOperations; h.bootstrap(); await h.main.startRecovery();
  assert.ok((await h.preview()).token);
});

test('lost ACK is read back once; replacement document gets recovered identity', supported, async t => {
  const h = await setup(t, true); h.load(); await h.main.startRecovery();
  const p = await h.preview(); h.faults.lost = true; const result = await h.execute(p);
  assert.equal(result.state, 'committed', JSON.stringify(result));
  h.replace();
  assert.equal((await h.invoke('project-delete-state', { operationId: result.operationId })).state, 'committed');
  assert.equal(h.calls.filter(c => c === 'completeProjectDeletion').length, 1);
  assert.ok(h.notifications.some(n => n[0] === 'recovery' && n[1].includes(result.operationId)));
});

test('repeated notifications after service restart are deduped and reopened epochs are dropped', supported, async t => {
  const h = await setup(t); h.load(); await h.main.startRecovery();
  const p = await h.preview(); const result = await h.execute(p); assert.equal(result.ok, true, JSON.stringify(result));
  h.main.dispose(); const restarted = h.compose(); await restarted.startRecovery();
  assert.equal(h.notifications.filter(n => n[0] === 'projects').length, 1, 'recovery replay must dedupe operation/epoch');
  restarted.dispose();
  await h.writer.revealAddedProject(h.projectPath);
  h.ports.notificationState = new Map();
  const newer = h.compose(); await newer.startRecovery();
  assert.equal(h.notifications.filter(n => n[0] === 'projects').length, 1, 'old receipt cannot invalidate reopened project epoch');
});

test('non-Windows PTY stop refuses without completing deletion', supported, async t => {
  const h = await setup(t, true, { platform: 'linux', stopPtyWithEvidence: () => assert.fail('unsupported stop must not run') });
  h.activeSessions.set('part', { kind: 'local-pty', projectPath: h.projectPath, generation: 7,
    statusPtyStart: 'start', pty: { pid: 123 }, exitDrain: Promise.resolve() });
  h.load(); await h.main.startRecovery();
  const p = await h.preview(); assert.ok(p.token);
  const result = await h.execute(p);
  assert.equal(result.failed[0].code, 'STOP_UNSUPPORTED');
  assert.equal(h.calls.filter(c => c === 'completeProjectDeletion').length, 0);
});

for (const code of ['ENOENT', 'EACCES']) test(`foreign job cwd ${code} stays local to that record`, supported, async t => {
  const h = await setup(t);
  const missing = path.join(h.projectPath, 'missing');
  for (const [id, cwd] of [['1234abcd', missing], ['abcd1234', h.projectPath]]) {
    fs.mkdirSync(path.join(h.ports.jobsDir, id), { recursive: true });
    fs.writeFileSync(path.join(h.ports.jobsDir, id, 'state.json'), JSON.stringify({ state: 'done', cwd,
      sessionId: '12345678-1234-1234-1234-123456789abc' }));
  }
  let roots = 0;
  const runtime = implementation.createProjectDeleteRuntime({ ...h.ports, fs: { ...fs.promises, realpath: async file => {
    if (file === h.projectPath) roots++;
    if (file === missing) throw Object.assign(new Error('unreadable cwd'), { code });
    return fs.promises.realpath(file);
  } } });
  const result = await runtime.readJobs({ alias: null, projectPath: h.projectPath }, { deadline: h.time.now() + 10000, limit: 100 })
    .catch(error => ({ error: error.code }));
  assert.equal(result.complete, true, 'one foreign cwd must not reject all discovery');
  assert.deepEqual(result.jobs.map(row => row.id), ['abcd1234']);
  assert.equal(result.candidates.some(row => row.id === '1234abcd'), code !== 'ENOENT');
  assert.equal(roots, 1, 'project realpath is memoized for the entire job scan');
});

test('background CLI inventory uses the supplied home cwd', supported, async t => {
  let cwd;
  const h = await setup(t, false, { homeDir: os.tmpdir(), runClaude: async (_args, opts) => { cwd = opts.cwd; return { code: 0, stdout: '[]' }; } });
  h.load(); await h.main.startRecovery(); await h.preview();
  assert.equal(cwd, os.tmpdir());
});

test('runtime identity and exited PTY pins do not survive an operation scope', async () => {
  const time = clock(), activeSessions = new Map();
  const runtime = implementation.createProjectDeleteRuntime({ ...time, activeSessions, cliSessionState: {
    readStatusEvidence: async () => ({ known: true, live: null }) } });
  assert.equal(typeof runtime.withScope, 'function', 'runtime must isolate preview and operation identity storage');
  const row = { id: 'old', sessionId: 'old', alias: null, runtime: 'terminal' };
  const session = { kind: 'local-pty', statusPtyStart: 'start', generation: 1, pty: { pid: 123 } };
  activeSessions.set('old', session);
  await runtime.withScope(async () => {
    assert.equal((await runtime.readLiveness(row, { deadline: time.now() + 1000 })).state, 'running');
    activeSessions.clear(); session.exited = true; session.pty.stopEvidence = { ended: true };
    assert.equal((await runtime.readLiveness(row, { deadline: time.now() + 1000 })).state, 'stopped');
  });
  await runtime.withScope(async () => {
    assert.equal((await runtime.readConversation({ sessionIds: ['old'] })).known, false);
    assert.equal((await runtime.readLiveness(row, { deadline: time.now() + 1000 })).state, 'unknown', 'previous operation must not retain exited PTY proof');
  });
});

test('recovered holds precede slow reconciliation of every recovered receipt', supported, async t => {
  const h = await setup(t);
  const other = path.join(h.projectPath, 'other');
  h.faults.listProjectDeletionOperations = async () => ({ revision: 1, nextCursor: null, rows: [h.projectPath, other].map((projectPath, i) => ({
    operationId: `recovered-${i}`, projectKey: JSON.stringify([null, projectPath]), expectedEpoch: 0, optionsJson: JSON.stringify(options), sealed: false,
  })) });
  h.faults.getProjectDeletionState = () => new Promise(() => {});
  const recovery = h.main.startRecovery();
  assert.equal(typeof h.main.whenHoldsInstalled, 'function', 'startup needs a separate recovered-holds milestone');
  let completed = false; recovery.then(() => { completed = true; });
  let installed;
  const milestone = h.main.whenHoldsInstalled().then(value => { installed = value; });
  await flush();
  assert.equal(installed, true, 'holds milestone must settle before slow receipt readback');
  await milestone;
  assert.equal(completed, false, 'milestone must not wait for sequential reconcile');
  assert.equal(h.ports.gate.tryAdmit(h.projectPath), null);
  assert.equal(h.ports.gate.tryAdmit(other), null, 'all recovered projects must be held before reconciling the first');
  h.time.advance(1000); await flush(); assert.equal(completed, false);
});

test('holds milestone reports its short deadline and disposal settles it', supported, async t => {
  const h = await setup(t);
  h.faults.listProjectDeletionOperations = () => new Promise(() => {});
  h.main.startRecovery();
  assert.equal(typeof h.main.whenHoldsInstalled, 'function');
  let result;
  const pending = h.main.whenHoldsInstalled().then(value => { result = value; });
  h.time.advance(120000); await flush();
  assert.equal(result, false, 'timed-out enumeration must report incomplete holds');
  await pending;
  h.main.dispose();
  assert.equal(await h.main.whenHoldsInstalled(), false);
});

test('dispose during enumeration settles both recovery barriers false', supported, async t => {
  const h = await setup(t);
  h.faults.listProjectDeletionOperations = () => new Promise(() => {});
  const recovery = h.main.startRecovery(), holds = h.main.whenHoldsInstalled();
  h.main.dispose();
  let installed;
  holds?.then(value => { installed = value; });
  await flush();
  assert.equal(installed, false, 'quit must settle the pending holds barrier');
  assert.equal(await recovery, false);
});

for (const shutdown of ['none', 'quitting', 'promise']) test(`main startup isolates recovery and respects shutdown=${shutdown}`, async () => {
  const filename = path.join(__dirname, '..', 'main.js'), source = fs.readFileSync(filename, 'utf8');
  assert.equal(source.includes('    await projectDeleteRecovery;'), false, 'cache, updater and activate must not wait for recovery');
  let resolveRecovery, resolveHolds;
  const { order } = startupFixture(new Promise(resolve => { resolveHolds = resolve; }), {
    projectDeleteRecovery: new Promise(resolve => { resolveRecovery = resolve; }),
    appQuitting: shutdown === 'quitting', shutdownPromise: shutdown === 'promise' ? Promise.resolve() : undefined,
  });
  await flush();
  assert.deepEqual(order, shutdown === 'none' ? ['ipc'] : [], 'schedule IPC must not wait for sequential receipt recovery');
  resolveHolds(true); await flush();
  assert.deepEqual(order, shutdown === 'none' ? ['ipc', 'seed', 'scheduler', 'trigger'] : []);
  resolveRecovery(false); await flush();
  assert.deepEqual(order, shutdown === 'none' ? ['ipc', 'seed', 'scheduler', 'trigger'] : []);
});

for (const method of ['readLiveness', 'readConversation']) test(`runtime ${method} outside a scope returns a typed discovery failure`, async () => {
  const runtime = implementation.createProjectDeleteRuntime({ activeSessions: new Map() });
  await assert.rejects(runtime[method]({ id: 'unscoped', sessionIds: ['unscoped'] }, { deadline: Date.now() + 1000 }),
    { code: 'DISCOVERY_UNAVAILABLE' }, 'unscoped reads must fail with DISCOVERY_UNAVAILABLE');
});

test('startup seed ordering rationale is recorded in its context', () => {
  const schedules = fs.readFileSync(path.join(__dirname, '../.ai/contexts/schedule-runner.md'), 'utf8');
  assert.match(schedules, /seeded before any session can run/i, 'schedule context must preserve seed ordering rationale');
  assert.match(schedules, /sandboxed one cannot plant into the seed/i);
});

test('I3 rationale is recorded in the trigger context', () => {
  const triggers = fs.readFileSync(path.join(__dirname, '../.ai/contexts/trigger-watcher.md'), 'utf8');
  assert.match(triggers, /I3:.*try\/catch/, 'trigger context must preserve I3 boot failure containment');
  assert.match(triggers, /auto-updater/);
});

for (const failure of ['enumeration', 'limit']) test(`recovery retries missed ${failure} holds without starting automation twice`, supported, async t => {
  const warnings = [];
  const h = await setup(t, false, { log: { warn: text => warnings.push(text) } });
  const paths = Array.from({ length: failure === 'limit' ? 33 : 1 }, (_, i) => path.join(h.projectPath, `recovered-${i}`));
  const rows = paths.map((projectPath, i) => ({ operationId: `retry-${i}`, projectKey: JSON.stringify([null, projectPath]),
    expectedEpoch: 0, optionsJson: JSON.stringify(options), sealed: false }));
  h.faults.listProjectDeletionOperations = async () => {
    if (failure === 'enumeration') throw new Error('enumeration offline');
    return { revision: 1, nextCursor: null, rows };
  };
  const first = h.main.startRecovery();
  const startup = startupFixture(h.main.whenHoldsInstalled());
  assert.equal(await first, false); await flush();
  assert.deepEqual(startup.order, ['ipc', 'seed', 'scheduler', 'trigger'], 'failed recovery must not strand automation');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], failure === 'limit' ? /OPERATION_LIMIT/ : /enumeration offline/);
  if (failure === 'limit') assert.equal(h.ports.gate.tryAdmit(paths[0]), null, 'already installed holds survive failure');
  const missed = h.ports.gate.tryAdmit(paths.at(-1));
  assert.ok(missed, 'last operation was not held on the first attempt'); missed.release();
  h.faults.listProjectDeletionOperations = async () => ({ revision: 1, nextCursor: null, rows });
  h.faults.getProjectDeletionState = async ({ operationId }) => operationId === rows.at(-1).operationId
    ? { state: 'unknown' } : { state: 'partial', terminal: true, receiptAvailable: true };
  h.faults.fenceProjectDeletion = async () => ({ state: 'unknown' });
  const retry = h.main.startRecovery();
  assert.equal(await h.main.whenHoldsInstalled(), true, 'retry must install operations omitted by the first pass');
  assert.equal(await retry, true);
  assert.equal(h.ports.gate.tryAdmit(paths.at(-1)), null, 'missed operation is now guarded');
  await flush();
  assert.deepEqual(startup.order, ['ipc', 'seed', 'scheduler', 'trigger'], 'retry must not start scheduler or trigger twice');
});

for (const shutdown of ['appQuitting', 'shutdownPromise']) test(`shutdown during schedule seed suppresses automation via ${shutdown}`, async () => {
  let seed;
  const { order, context } = startupFixture(Promise.resolve(true), {
    scheduleProjects: () => ({ list: () => new Promise(resolve => { seed = resolve; }) }),
  });
  await flush(); context[shutdown] = true; seed([]); await flush();
  assert.deepEqual(order, ['ipc']);
});

test('trigger boot failure is contained and logged after scheduler startup', async () => {
  const { order, errors } = startupFixture(Promise.resolve(true), {
    require: () => ({ start() { throw new Error('watcher unavailable'); } }),
  });
  await flush();
  assert.deepEqual(order, ['ipc', 'seed', 'scheduler']);
  assert.equal(errors.length, 1);
  assert.match(errors[0].join(' '), /trigger-watcher.*watcher unavailable/);
});

test('notification context specifies the cross-process 24-hour replay boundary', () => {
  const context = fs.readFileSync(path.join(__dirname, '../.ai/contexts/project-delete.md'), 'utf8');
  assert.match(context, /committed receipts younger than 24 hours notify again/, 'restart replay age and outcome must be explicit');
  assert.match(context, /idempotent\s+refreshes/);
});
