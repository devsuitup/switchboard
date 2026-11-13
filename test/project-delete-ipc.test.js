'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const openStore = require('./fixtures/conversation-store.cjs');
const { createSessionIndexWriter } = require('../session-index-writer');
const { createProjectOperationGate } = require('../src/main/shared/project-operation-gate');
const { createProjectDeleteInventory } = require('../src/main/projects/project-delete-inventory');
const { createProjectDeletePlanner } = require('../src/main/projects/project-delete-plan');
const { createProjectDeleteStop } = require('../src/main/projects/project-delete-stop');
const { operationId } = require('../src/main/projects/project-delete-progress');
const supported = { skip: !openStore.supported && 'real SQLite requires Node 22 or matching native ABI' };
const options = { sessions: true, settings: false, schedules: false, transcripts: false, stopBackgroundJobs: true };
const flush = () => new Promise(resolve => setImmediate(resolve));
async function finishReconciliation(h, start) {
  const hook = h.transport.hook;
  let observed;
  const firstRead = new Promise(resolve => { observed = resolve; });
  h.transport.hook = async (command, result) => {
    await hook?.(command, result);
    if (command === 'getProjectDeletionState') observed();
  };
  const pending = start(); await firstRead;
  let done = false;
  const idle = Promise.all([pending, h.service.whenIdle()]).then(() => { done = true; });
  for (let i = 0; i < 200 && !done; i++) { h.time.advance(1000); await flush(); }
  assert.ok(done, 'reconciliation must settle within the fake-clock bound');
  await idle; h.transport.hook = hook;
}
function clock() {
  let time = Date.now(), sequence = 0;
  const timers = new Map();
  return { now: () => time, schedule(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: time + ms }); return id; },
    cancel: id => timers.delete(id), advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } }, timers };
}
function windowFixture() {
  const win = new EventEmitter(), wc = new EventEmitter();
  win.webContents = wc; win.isDestroyed = wc.isDestroyed = () => false; wc.mainFrame = {};
  wc.url = 'file:///switchboard/index.html'; wc.getURL = () => wc.url;
  return win;
}
async function setup(t, running = false) {
  assert.equal(typeof serviceModule?.createProjectDeleteService, 'function', 'production deletion service must exist');
  assert.equal(typeof ipcModule?.registerProjectDeleteIpc, 'function', 'production IPC registration must exist');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-ipc-'))), projectPath = path.join(root, 'repo');
  const projectsDir = path.join(root, 'transcripts'), transcript = path.join(projectsDir, 'folder', 'part.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.mkdirSync(projectPath);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: 'part', cwd: projectPath, message: { content: 'keep' } }) + '\n');
  const previousDataDir = process.env.SWITCHBOARD_DATA_DIR;
  process.env.SWITCHBOARD_DATA_DIR = path.join(root, 'data');
  t.after(() => { if (previousDataDir === undefined) delete process.env.SWITCHBOARD_DATA_DIR; else process.env.SWITCHBOARD_DATA_DIR = previousDataDir; });
  const db = openStore();
  db.setFolderMeta('folder', projectPath, 1);
  db.upsertCachedSessions([{ sessionId: 'part', folder: 'folder', projectPath, runtime: 'claude' }]);
  db.setSetting('global', { openWorkingSet: [{ sessionId: 'part', projectPath }] }); db.setInitialScanComplete();
  const worker = require('./fixtures/project-deletion-worker.cjs')(db), calls = [];
  const transport = { mode: null, readFail: false, fenceFail: false, hook: null };
  let request = worker.client.request;
  worker.client.request = async (command, ...args) => {
    calls.push(command);
    if (command === 'getProjectDeletionState' && transport.readFail || command === 'fenceProjectDeletion' && transport.fenceFail) throw new Error('transport unavailable');
    if (command === 'completeProjectDeletion') {
      if (transport.mode === 'queued') { transport.queued = () => request(command, ...args); throw new Error('lost before delivery'); }
      const result = await request(command, ...args);
      if (transport.mode === 'lost') throw new Error('lost committed reply');
      return result;
    }
    const result = await request(command, ...args);
    await transport.hook?.(command, result);
    return result;
  };
  const sessionNotifications = [];
  const writer = createSessionIndexWriter({ client: worker.client, readonlyBackend: db,
    onSessionsChanged: (...args) => sessionNotifications.push(args) }, {}); await writer.ready;
  let submissions = 0;
  const complete = writer.completeProjectDeletion;
  writer.completeProjectDeletion = input => { submissions++; return complete(input); };
  const time = clock(), activeSessions = new Map(), notifications = [], effects = [];
  const identity = { pid: 123, procStart: 'start', generation: 1 };
  const target = { id: running === 'job' ? 'job' : 'part', kind: running === 'job' ? 'job' : 'pty', conversationId: 'part',
    sessionIds: ['part'], identity, sessionKey: running === 'job' ? 'job' : 'part', ...(running === 'job' ? { jobId: 'job' } : {}) };
  const session = { projectPath, sessionId: 'part', kind: 'local-pty', generation: 1, statusPtyStart: 'start', pty: { pid: 123 }, exitDrain: Promise.resolve() };
  if (running === true) activeSessions.set('part', session);
  const state = { alive: running, remove: false, fail: false, onStop: null, discovery: null };
  const binding = { ...target, session, supported: true, attachments: [] };
  const stopPorts = { ...time, activeSessions, platform: 'win32', readTarget: async () => binding,
    readConversation: async conversation => ({ known: true, complete: true, owners: running && conversation.id === 'part'
      ? [{ id: target.id, identity: { ...identity }, treeState: state.alive ? 'live' : 'dead' }] : [] }),
    bg: { checkStop: async () => ({ ok: true, workerLiveness: state.alive ? 'live' : 'dead' }),
      runStop: async () => { effects.push('stop:job'); state.alive = false; return { ended: true, jobId: 'job', sessionIds: ['part'] }; } },
    getScheduleRunSnapshot: () => [], stopPtyWithEvidence: async () => {
      effects.push('stop:part');
      if (state.fail) return { ended: false, generation: 1, pid: 123 };
      state.alive = false; if (state.remove) activeSessions.delete('part');
      await state.onStop?.();
      return { ended: true, generation: 1, pid: 123 };
    } };
  const inventory = createProjectDeleteInventory({ writer, projectsDir, dataDir: path.join(root, 'data'), activeSessions,
    now: time.now, schedule: time.schedule, cancel: time.cancel,
    getScheduleRunSnapshot: () => [], readJobs: async () => ({ complete: true, jobs: running === 'job' ? [{ id: 'job', jobId: 'job',
      conversationId: 'part', sessionIds: ['part'], projectPath, alias: null, runtime: 'claude', verified: true,
      liveness: state.alive ? { state: 'running', source: 'job', targetId: 'job', identity: { ...identity } } : { state: 'stopped', source: 'job' } }] : [] }),
    readLiveness: async row => {
      await state.discovery?.();
      if (row.id === state.stoppedSibling) return { state: 'stopped', source: 'descriptor' };
      return state.alive ? { state: 'running', source: running === 'job' ? 'job' : 'pty', targetId: target.id, identity: { ...identity } } : { state: 'stopped', source: 'descriptor' };
    } });
  const planner = createProjectDeletePlanner({ ...inventory, ...time }), gate = createProjectOperationGate();
  let minted = 0;
  const serviceDeps = { ...time, writer, inventory, planner, stop: createProjectDeleteStop(stopPorts), gate,
    randomToken: () => { minted++; return require('node:crypto').randomBytes(32).toString('hex'); },
    notifyProjects: (targets, id) => notifications.push(['projects', targets, id]),
    notifySchedules: (targets, id) => notifications.push(['schedules', targets, id]), replyTimeoutMs: 1000 };
  const service = serviceModule.createProjectDeleteService(serviceDeps); await service.initialize();
  const handlers = new Map(), ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  const win = windowFixture(); let currentWindow = win;
  const registration = ipcModule.registerProjectDeleteIpc({ ipcMain, service, getMainWindow: () => currentWindow });
  registration.attach(win);
  const event = () => ({ sender: currentWindow.webContents, senderFrame: currentWindow.webContents.mainFrame });
  const invoke = (name, input, sender = event()) => handlers.get(name)(sender, input);
  const preview = (extra = {}) => invoke('preview-project-delete', { projectPath, options, ...extra });
  const execute = p => invoke('delete-project', { token: p.token, fingerprint: p.plan.fingerprint });
  const count = () => submissions;
  t.after(() => { registration.dispose(); service.dispose(); db.closeDb(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, writer, worker, calls, transport, time, gate, state, effects, notifications, sessionNotifications, identity, session, activeSessions,
    service, serviceDeps, registration, handlers, invoke, event, win, preview, execute, count, minted: () => minted, projectPath, transcript,
    replace() { currentWindow = windowFixture(); registration.attach(currentWindow); return currentWindow; },
    restartWorker() { request = require('./fixtures/project-deletion-worker.cjs')(db).client.request; } };
}
let serviceModule, ipcModule;
try { serviceModule = require('../src/main/projects/project-delete'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
try { ipcModule = require('../src/main/projects/project-delete-ipc'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

test('known operation state and recovery announcement identify the exact host and path', supported, async t => {
  const h = await setup(t);
  const preview = await h.preview();
  const result = await h.execute(preview);
  const state = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.deepEqual({ host: state.host, projectPath: state.projectPath }, { host: null, projectPath: preview.plan.project.projectPath });
  assert.deepEqual(h.registration.rebind(), [{ operationId: result.operationId, host: null, projectPath: preview.plan.project.projectPath }]);
});

for (const failedRead of [2, 3]) test(`post-stop revalidation read ${failedRead} is not an ownership change`, supported, async t => {
  const h = await setup(t, true);
  const p = await h.preview(); assert.ok(p.token);
  const planner = h.serviceDeps.planner, original = planner.revalidate;
  let reads = 0;
  planner.revalidate = async (...args) => ++reads === failedRead ? { ok: false, code: 'DISCOVERY_UNAVAILABLE', error: 'read offline' } : original(...args);
  const result = await h.execute(p);
  assert.equal(result.code, 'REVALIDATION_UNAVAILABLE', 'read failure must not report changed ownership');
  assert.match(result.error, /read offline/);
  assert.equal(h.count(), 0);
  assert.equal(result.stopped.length, 1);
});

test('A4c3 ships callable service and actual IPC registration', () => {
  assert.equal(typeof serviceModule?.createProjectDeleteService, 'function', 'production deletion service must exist');
  assert.equal(typeof ipcModule?.registerProjectDeleteIpc, 'function', 'production IPC registration must exist');
});

test('actual callbacks commit once and forward only receipt invalidation while keeping transcripts', supported, async t => {
  const h = await setup(t), before = h.db.changeCount(), bytes = fs.readFileSync(h.transcript);
  const p = await h.preview(); assert.equal(p.ok, true); assert.ok(p.token); assert.equal(h.db.changeCount(), before);
  const result = await h.execute(p);
  assert.equal(result.state, 'committed', JSON.stringify(result)); assert.equal(h.count(), 1);
  assert.equal(h.calls.filter(command => command === 'completeProjectDeletion').length, 1);
  assert.deepEqual(result.invalidation.sessionIds, ['part']); assert.deepEqual(result.invalidation.folderKeys, ['folder']);
  assert.deepEqual(h.notifications.map(n => n.slice(0, 2)), [['projects', result.invalidation], ['schedules', result.invalidation]]);
  assert.deepEqual(fs.readFileSync(h.transcript), bytes);
  assert.equal((await h.invoke('project-delete-state', { operationId: result.operationId })).state, 'committed');
  assert.equal(h.notifications.length, 2); assert.equal(h.count(), 1);
  assert.equal((await h.execute(p)).code, 'INVALID_TOKEN');
});

test('failed stop preserves attempted effects and submits no deletion', supported, async t => {
  const h = await setup(t, true); h.state.fail = true;
  const result = await h.execute(await h.preview());
  assert.equal(h.count(), 0, 'failed stop must submit zero deletion commands');
  assert.equal(result.ok, false); assert.equal(result.failed[0].code, 'STOP_UNKNOWN');
  assert.deepEqual(result.stopped.map(x => [x.id, x.effect]), [['part', 'attempted']]);
  assert.deepEqual(h.notifications, []); assert.equal(h.db.getCachedSession('part')?.sessionId, 'part');
});

test('poststop liveness and proven tab disappearance do not reject accepted membership', supported, async t => {
  const h = await setup(t, true); h.state.remove = true;
  h.state.onStop = () => h.db.setSetting('global', { openWorkingSet: [] });
  const result = await h.execute(await h.preview());
  assert.equal(result.state, 'committed', JSON.stringify(result)); assert.equal(h.count(), 1);
  assert.deepEqual(result.stopped.map(x => [x.id, x.effect]), [['part', 'proven-dead']]);
});

test('no-tab background job and its member aliases stop once with explicit consent', supported, async t => {
  const h = await setup(t, 'job'); h.db.setSetting('global', { openWorkingSet: [] });
  const refused = await h.preview({ options: { ...options, stopBackgroundJobs: false } });
  assert.equal(refused.token, null); assert.ok(refused.plan.refusals.some(row => row.code === 'BACKGROUND_CONSENT'));
  const result = await h.execute(await h.preview());
  assert.equal(result.state, 'committed', JSON.stringify(result)); assert.deepEqual(h.effects, ['stop:job']); assert.equal(h.count(), 1);
});

for (const change of ['process', 'schedule', 'member']) test(`before stop changed ${change} requires fresh preview`, supported, async t => {
  const h = await setup(t, true), p = await h.preview();
  if (change === 'process') h.identity.procStart = 'replacement';
  else if (change === 'member') h.db.upsertCachedSessions([{ sessionId: 'added', folder: 'folder', projectPath: h.projectPath }]);
  else { const dir = path.join(h.projectPath, '.claude', 'commands'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'schedule-new.md'), '---\ncron: * * * * *\n---\nnew'); }
  const result = await h.execute(p);
  assert.equal(result.refresh, true); assert.equal(h.count(), 0); assert.deepEqual(h.effects, []);
});

test('poststop new membership and fresh-scope race refuse without submission', supported, async t => {
  const h = await setup(t, true);
  h.state.onStop = () => h.db.upsertCachedSessions([{ sessionId: 'new', folder: 'folder', projectPath: h.projectPath }]);
  const result = await h.execute(await h.preview());
  assert.equal(result.refresh, true); assert.equal(h.count(), 0); assert.equal(result.stopped[0].effect, 'proven-dead');
});

test('lost committed reply reconciles without replay and publishes exact targets once', supported, async t => {
  const h = await setup(t); h.transport.mode = 'lost';
  const result = await h.execute(await h.preview());
  assert.equal(result.state, 'committed', JSON.stringify(result)); assert.equal(h.count(), 1, 'unknown completion must never replay');
  assert.ok(h.calls.includes('getProjectDeletionState')); assert.equal(h.notifications.length, 2);
});

test('read and fence failures retain both holds; queued command is fenced before release', supported, async t => {
  const h = await setup(t); h.transport.mode = 'queued'; h.transport.readFail = h.transport.fenceFail = true;
  const result = await h.execute(await h.preview());
  assert.equal(result.state, 'unknown'); assert.equal(result.retryable, false); assert.equal(h.count(), 1);
  assert.equal(h.gate.tryAdmit(h.projectPath) === null, true, 'unknown outcome must retain launch hold');
  assert.throws(() => h.writer.reserveProjectDeletion([{ alias: null, projectPath: h.projectPath }]), { code: 'WORKFLOW_BUSY' });
  assert.deepEqual(h.notifications, []);
  h.transport.readFail = h.transport.fenceFail = false;
  await finishReconciliation(h, () => h.invoke('project-delete-state', { operationId: result.operationId }));
  const state = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.equal(state.state, 'notStarted', JSON.stringify(state)); assert.equal(h.count(), 1);
  await assert.rejects(h.transport.queued());
  const admission = h.gate.tryAdmit(h.projectPath); assert.ok(admission); admission.release();
});

test('reply timeout before admission leaves work owned and state cannot fence its pending owner', supported, async t => {
  const h = await setup(t), admission = h.gate.tryAdmit(h.projectPath), p = await h.preview();
  const pending = h.execute(p); await flush(); h.time.advance(1000);
  const result = await pending; assert.equal(result.state, 'unknown'); assert.ok(result.operationId); assert.equal(h.count(), 0);
  const stateRead = h.invoke('project-delete-state', { operationId: result.operationId });
  await flush(); h.time.advance(1000);
  assert.equal((await stateRead).state, 'unknown');
  assert.equal(h.calls.includes('fenceProjectDeletion'), false);
  admission.release();
  await h.service.whenIdle();
  assert.equal((await h.invoke('project-delete-state', { operationId: result.operationId })).state, 'committed');
});

test('simultaneous valid tokens cannot stop or submit the project twice', supported, async t => {
  const h = await setup(t, true), a = await h.preview(), b = await h.preview(), admission = h.gate.tryAdmit(h.projectPath);
  const pending = h.execute(a), busy = await h.execute(b);
  assert.equal(busy.code, 'BUSY'); assert.ok(busy.operationId); assert.equal(h.count(), 0);
  admission.release(); const result = await pending;
  assert.equal(result.operationId, busy.operationId); assert.equal(h.count(), 1); assert.deepEqual(h.effects, ['stop:part']);
});

test('foreign sender and subframe cannot consume a legitimate token or read an operation', supported, async t => {
  const h = await setup(t), p = await h.preview();
  for (const event of [{ sender: {}, senderFrame: {} }, { sender: h.win.webContents, senderFrame: {} }]) {
    assert.equal((await h.invoke('delete-project', { token: p.token, fingerprint: p.plan.fingerprint }, event)).code, 'UNAUTHORIZED');
    assert.equal((await h.invoke('preview-project-delete', { projectPath: h.projectPath, options }, event)).code, 'UNAUTHORIZED');
    assert.equal((await h.invoke('project-delete-state', { operationId: 'guessed' }, event)).code, 'UNAUTHORIZED');
  }
  assert.equal(h.count(), 0); assert.equal((await h.execute(p)).state, 'committed');
});

test('navigation during preview cannot mint a token and old document cannot read rebound results', supported, async t => {
  const h = await setup(t); let navigated = false;
  h.state.discovery = () => { if (!navigated) { navigated = true; h.win.webContents.emit('did-navigate', {}, 'app'); } };
  const p = await h.preview(); assert.equal(p.token, null, 'preview must recheck document before minting'); assert.equal(p.code, 'UNAUTHORIZED');
  assert.equal(h.minted(), 0, 'navigation must prevent token minting even when IPC suppresses the reply');
  h.state.discovery = null; h.replace();
  const result = await h.execute(await h.preview()), old = h.event(); h.replace();
  assert.equal((await h.invoke('project-delete-state', { operationId: result.operationId }, old)).code, 'UNAUTHORIZED');
  assert.equal((await h.invoke('project-delete-state', { operationId: result.operationId })).state, 'committed');
});

test('strict callback inputs, expired tokens and fingerprint mismatches cause zero effects', supported, async t => {
  const h = await setup(t), p = await h.preview();
  for (const extra of [{ worktreeConsents: [] }, { options: { ...options, sessions: 1 } }, { options: { ...options, transcripts: true } }, { options: { ...options, schedules: true } }]) {
    assert.equal((await h.preview(extra)).code, 'INVALID_REQUEST');
  }
  assert.equal((await h.invoke('delete-project', { token: p.token, fingerprint: p.plan.fingerprint, options })).code, 'INVALID_REQUEST');
  assert.equal((await h.invoke('project-delete-state', { operationId: 'guess', projectPath: h.projectPath })).code, 'INVALID_REQUEST');
  assert.equal((await h.invoke('project-delete-state', { operationId: 'guess' })).code, 'UNAUTHORIZED');
  assert.equal((await h.invoke('delete-project', { token: p.token, fingerprint: 'wrong' })).code, 'INVALID_TOKEN');
  h.time.advance(300000); assert.equal((await h.execute(p)).code, 'INVALID_TOKEN');
  assert.equal(h.count(), 0); assert.deepEqual(h.effects, []);
});

test('32-token capacity expires with injected time; restart invalidates tokens', supported, async t => {
  const h = await setup(t);
  assert.ok((await h.preview()).token); for (let i = 1; i < 32; i++) assert.ok((await h.preview()).token);
  assert.equal((await h.preview()).code, 'TOKEN_LIMIT'); h.time.advance(300000);
  const fresh = await h.preview(); assert.ok(fresh.token);
  const other = serviceModule.createProjectDeleteService(h.serviceDeps); await other.initialize();
  assert.equal((await other.execute({}, { token: fresh.token, fingerprint: fresh.plan.fingerprint })).code, 'INVALID_TOKEN'); other.dispose();
});

test('receipt eviction yields unknown details and never replays completion', supported, async t => {
  const h = await setup(t); h.transport.mode = 'lost'; h.transport.readFail = h.transport.fenceFail = true;
  const result = await h.execute(await h.preview());
  assert.equal(result.state, 'unknown');
  h.db.projectDeletion.purgeOperation(result.operationId);
  h.transport.readFail = h.transport.fenceFail = false;
  const read = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.equal(read.state, 'unknown'); assert.equal(read.ok, false); assert.deepEqual(read.completed, []);
  assert.equal(h.count(), 1); assert.equal(h.notifications.length, 0);
});

test('restart enumerates committed lost replies and rebinds only the replacement trusted document', supported, async t => {
  const h = await setup(t), result = await h.execute(await h.preview());
  h.registration.dispose(); h.service.dispose();
  const restarted = serviceModule.createProjectDeleteService(h.serviceDeps); await restarted.initialize();
  t.after(() => restarted.dispose());
  const handlers = new Map(), win = windowFixture();
  const registration = ipcModule.registerProjectDeleteIpc({ ipcMain: { handle: (k, fn) => handlers.set(k, fn), removeHandler: k => handlers.delete(k) },
    service: restarted, getMainWindow: () => win });
  registration.attach(win); t.after(() => registration.dispose());
  const read = await handlers.get('project-delete-state')({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, { operationId: result.operationId });
  assert.equal(read.state, 'committed'); assert.equal(read.stoppedHistoryUnknown, true); assert.deepEqual(read.stopped, []);
  assert.deepEqual(read.invalidation, result.invalidation); assert.equal(h.count(), 1);
});

test('chunk failure returns actual prefix and pending units without final notification', supported, async t => {
  const h = await setup(t), original = h.db.transact;
  let injected = false;
  h.db.transact = fn => {
    const result = original(fn);
    const row = h.db.projectDeletion.active()[0];
    if (!injected && row?.nextUnit > 0) { injected = true; h.db.setSetting('_writer_revision', (h.db.getSetting('_writer_revision') || 0) + 1); }
    return result;
  };
  const result = await h.execute(await h.preview());
  assert.equal(injected, true); assert.equal(result.state, 'partial', JSON.stringify(result));
  assert.deepEqual(result.completed.map(unit => [unit.category, unit.status]), [['session', 'completed']]);
  assert.deepEqual(result.skipped.map(unit => [unit.category, unit.status]), [['folderMeta', 'pending'], ['finalize', 'pending']]);
  assert.equal(result.observations.projectHidden, false); assert.deepEqual(h.notifications, []); assert.equal(h.count(), 1);
});

test('scope await cannot adopt new process ownership', supported, async t => {
  const h = await setup(t, true), p = await h.preview(); let scopes = 0;
  h.transport.hook = command => { if (command === 'readProjectDeletionScope' && ++scopes === 2) h.identity.procStart = 'successor'; };
  const result = await h.execute(p);
  assert.equal(result.refresh, true); assert.equal(h.count(), 0); assert.equal(result.stopped[0].effect, 'proven-dead');
});

test('retention bounds 128 terminal results and 24 hours without forgetting unresolved ownership', supported, async t => {
  const h = await setup(t);
  const progress = require('../src/main/projects/project-delete-progress').createProjectDeleteProgress(h.db, { now: h.time.now });
  for (let i = 0; i < 129; i++) {
    const project = { alias: null, projectPath: path.join(h.root, 'retained-' + i) };
    progress.fence({ project, operationId: operationId(project, 0), expectedProjectEpoch: 0 });
  }
  const service = serviceModule.createProjectDeleteService(h.serviceDeps); await service.initialize();
  const sender = { valid: () => true };
  assert.equal(service.rebind(sender).length, 128);
  h.time.advance(86399999); assert.equal(service.rebind(sender).length, 128);
  h.time.advance(1); assert.deepEqual(service.rebind(sender), []); service.dispose();
});

test('recovery fence waits for the archive reservation ready before any writer fence', supported, async t => {
  const h = await setup(t), project = { alias: null, projectPath: h.projectPath };
  let finish;
  const workflows = require('../src/main/projects/project-archive-workflow').projectArchiveWorkflows(h.worker.client);
  const lease = workflows.run([project], () => new Promise(resolve => { finish = resolve; }));
  h.transport.mode = 'queued';
  const pending = h.execute(await h.preview()); await flush(); h.time.advance(1000);
  const result = await pending;
  assert.equal(result.state, 'unknown'); assert.equal(h.calls.includes('fenceProjectDeletion'), false); assert.equal(h.count(), 0);
  await finishReconciliation(h, async () => { finish(); await lease; });
  assert.equal((await h.invoke('project-delete-state', { operationId: result.operationId })).state, 'notStarted');
});

test('notification failure preserves committed state and a retained-file warning never replays', supported, async t => {
  const h = await setup(t);
  h.serviceDeps.notifyProjects = () => { fs.rmSync(h.transcript, { force: true }); throw new Error('notification unavailable'); };
  const result = await h.execute(await h.preview());
  assert.equal(result.state, 'committed'); assert.equal(result.refresh, true); assert.match(result.notificationWarning, /notification/);
  const read = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.equal(read.state, 'committed'); assert.equal(read.refresh, true); assert.match(read.readbackWarning, /ENOENT/); assert.equal(h.count(), 1);
});

test('recovery acquisition failure cannot leave an unfenced operation registered on retry', supported, async t => {
  const h = await setup(t), project = { alias: null, projectPath: h.projectPath };
  const id = operationId(project, 0);
  await h.worker.client.request('fenceProjectDeletion', { project, operationId: id, expectedProjectEpoch: 0 });
  const list = h.writer.listProjectDeletionOperations;
  h.writer.listProjectDeletionOperations = async input => { const page = await list(input); return { ...page, rows: page.rows.map(row => ({ ...row, sealed: 0 })) }; };
  const held = h.gate.hold(h.projectPath); await held.ready;
  const service = serviceModule.createProjectDeleteService(h.serviceDeps), sender = { valid: () => true };
  await assert.rejects(service.initialize());
  assert.deepEqual(service.rebind(sender), [], 'failed acquisition must not expose an unowned recovery operation');
  held.release(); await service.initialize(); assert.deepEqual(service.rebind(sender), [{ operationId: id, host: null,
    projectPath: require('../src/main/projects/project-delete-identity').identity(project).projectPath }]); service.dispose();
});

test('worker replacement seals an interrupted command and service only reconciles', supported, async t => {
  const h = await setup(t, true); h.transport.mode = 'queued'; h.transport.readFail = h.transport.fenceFail = true;
  const result = await h.execute(await h.preview());
  h.restartWorker(); h.transport.readFail = h.transport.fenceFail = false;
  await finishReconciliation(h, () => h.service.recover());
  const read = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.equal(read.state, 'notStarted'); assert.equal(read.stopped[0].effect, 'proven-dead'); assert.equal(h.count(), 1);
  assert.equal(h.time.timers.size, 0);
});

test('recovery never exceeds 32 unresolved holds and retries after those outcomes resolve', supported, async t => {
  const h = await setup(t);
  for (let i = 0; i < 33; i++) {
    const project = { alias: null, projectPath: path.join(h.root, 'unresolved-' + i) };
    await h.worker.client.request('fenceProjectDeletion', { project, operationId: operationId(project, 0), expectedProjectEpoch: 0 });
  }
  h.transport.readFail = h.transport.fenceFail = true;
  const list = h.writer.listProjectDeletionOperations;
  h.writer.listProjectDeletionOperations = async input => { const page = await list(input); return { ...page, rows: page.rows.map(row => ({ ...row, sealed: 0 })) }; };
  const service = serviceModule.createProjectDeleteService(h.serviceDeps), sender = { valid: () => true };
  await assert.rejects(service.initialize(), { code: 'OPERATION_LIMIT' });
  assert.equal(service.rebind(sender).length, 32);
  h.time.advance(86400000); assert.equal(service.rebind(sender).length, 32, 'unresolved operations must not expire');
  h.transport.readFail = h.transport.fenceFail = false;
  await service.recover(); service.dispose();
});

for (const event of ['render-process-gone', 'destroyed']) test(`${event} revokes tokens and unregister removes actual callbacks`, supported, async t => {
  const h = await setup(t), p = await h.preview();
  h.win.webContents.emit(event);
  assert.equal((await h.execute(p)).code, 'UNAUTHORIZED'); assert.equal(h.count(), 0);
  h.registration.dispose(); assert.equal(h.handlers.size, 0); assert.equal(h.win.webContents.listenerCount('did-navigate'), 0);
});

test('navigation while state read is pending cannot deliver a previous document result', supported, async t => {
  const h = await setup(t); h.transport.mode = 'lost'; h.transport.readFail = h.transport.fenceFail = true;
  const result = await h.execute(await h.preview()); h.transport.readFail = false;
  h.transport.hook = command => { if (command === 'getProjectDeletionState') h.win.webContents.emit('did-navigate', {}, 'app'); };
  const read = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.equal(read.code, 'UNAUTHORIZED', 'asynchronous state result must remain document-bound'); assert.equal(h.count(), 1);
});

test('a stopped continuation is verified but is not added to the live PTY target binding', supported, async t => {
  const h = await setup(t, true), sibling = path.join(path.dirname(h.transcript), 'sibling.jsonl');
  fs.writeFileSync(sibling, JSON.stringify({ type: 'user', sessionId: 'sibling', cwd: h.projectPath, message: { content: 'kept' } }) + '\n');
  h.db.upsertCachedSessions([{ sessionId: 'sibling', folder: 'folder', projectPath: h.projectPath, runtime: 'claude', mergedIntoSessionId: 'part' }]);
  h.db.connection.prepare('UPDATE session_cache SET mergedIntoSessionId=? WHERE sessionId=?').run('part', 'sibling');
  h.state.stoppedSibling = 'sibling';
  const result = await h.execute(await h.preview());
  assert.equal(result.state, 'committed', JSON.stringify(result));
  assert.deepEqual(result.invalidation.sessionIds, ['part', 'sibling']); assert.equal(h.count(), 1);
});

test('poststop schedule addition and arbitrary dormant tab disappearance require new consent', supported, async t => {
  for (const change of ['schedule', 'dormant']) {
    const h = await setup(t, true);
    if (change === 'dormant') {
      h.state.stoppedSibling = 'dormant';
      h.db.setSetting('global', { openWorkingSet: [{ sessionId: 'part', projectPath: h.projectPath }, { sessionId: 'dormant', projectPath: h.projectPath }] });
    }
    h.state.onStop = () => {
      if (change === 'dormant') h.db.setSetting('global', { openWorkingSet: [{ sessionId: 'part', projectPath: h.projectPath }] });
      else { const dir = path.join(h.projectPath, '.claude', 'commands'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'schedule-new.md'), '---\ncron: * * * * *\n---\nnew'); }
    };
    const result = await h.execute(await h.preview());
    assert.equal(result.refresh, true, change); assert.equal(h.count(), 0, change); assert.equal(result.stopped[0]?.effect, 'proven-dead');
  }
});

test('empty registered project refuses settings erasure and can hide with settings kept', supported, async t => {
  const h = await setup(t), empty = path.join(h.root, 'empty'); fs.mkdirSync(empty);
  h.db.setSetting('scheduleProjects', [empty]);
  const refused = await h.preview({ projectPath: empty, options: { ...options, settings: true } });
  assert.equal(refused.token, null); assert.ok(refused.plan.refusals.some(row => row.code === 'DISCOVERY_CANDIDATE'));
  const result = await h.execute(await h.preview({ projectPath: empty }));
  assert.equal(result.state, 'committed', JSON.stringify(result)); assert.deepEqual(result.invalidation.sessionIds, []); assert.equal(h.count(), 1);
});

test('actual execute callback caps live operations at 32 while their launches drain', supported, async t => {
  const h = await setup(t), paths = Array.from({ length: 33 }, (_, index) => path.join(h.root, 'busy-' + index));
  for (const project of paths) fs.mkdirSync(project);
  h.db.setSetting('scheduleProjects', paths);
  const admissions = [], replies = [];
  for (const projectPath of paths.slice(0, 32)) {
    const p = await h.preview({ projectPath }); assert.ok(p.token, JSON.stringify(p));
    admissions.push(h.gate.tryAdmit(projectPath)); replies.push(h.execute(p));
  }
  const result = await h.execute(await h.preview({ projectPath: paths[32] }));
  assert.equal(result.code, 'OPERATION_LIMIT'); assert.equal(h.count(), 0);
  h.time.advance(1000); const pending = await Promise.all(replies);
  assert.equal(new Set(pending.map(row => row.operationId)).size, 32);
  h.serviceDeps.planner.revalidate = async () => ({ same: false });
  for (const admission of admissions) admission.release();
  await h.service.whenIdle(); assert.equal(h.count(), 0);
});

test('worker restart seals a committed prefix while main preserves its holds and stopped effects', supported, async t => {
  const h = await setup(t, true), transact = h.db.transact;
  h.db.transact = fn => {
    if (h.db.projectDeletion.active().some(row => row.nextUnit > 0)) throw new Error('worker storage unavailable after prefix');
    return transact(fn);
  };
  h.transport.readFail = h.transport.fenceFail = true;
  const result = await h.execute(await h.preview());
  assert.equal(result.state, 'unknown'); assert.equal(h.db.projectDeletion.active()[0]?.nextUnit, 1);
  assert.equal(h.gate.tryAdmit(h.projectPath) === null, true);
  h.db.transact = transact; h.transport.readFail = h.transport.fenceFail = false; h.restartWorker();
  await h.service.recover();
  const state = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.equal(state.state, 'partial', JSON.stringify(state));
  assert.deepEqual(state.completed.map(row => row.target.id), ['part']);
  assert.equal(state.stopped[0].effect, 'proven-dead'); assert.equal(state.observations.projectHidden, false);
  assert.deepEqual(h.notifications, []); assert.equal(h.count(), 1);
});

test('released terminal view is cached without receipt or retained-file rescans', supported, async t => {
  const h = await setup(t), committed = await h.execute(await h.preview());
  assert.equal(committed.state, 'committed');
  const reads = h.calls.filter(c => c === 'getProjectDeletionState').length;
  let inspections = 0;
  h.serviceDeps.inventory.inspectRetainedFiles = async () => { inspections++; return []; };
  const read = await h.invoke('project-delete-state', { operationId: committed.operationId });
  assert.deepEqual(read, committed);
  assert.equal(h.calls.filter(c => c === 'getProjectDeletionState').length, reads, 'terminal polls must not reread receipts');
  assert.equal(inspections, 0, 'terminal polls must not rescan retained files');
});

test('cancelled navigation preserves authority but committed foreign navigation remains unauthorized after load', supported, async t => {
  const h = await setup(t), p = await h.preview(), wc = h.win.webContents;
  wc.emit('did-start-navigation', {}, 'https://example.invalid', false, true);
  assert.ok((await h.preview()).token, 'a cancelled navigation must preserve preview authority');
  const result = await h.execute(p);
  assert.equal(result.state, 'committed');
  assert.equal((await h.invoke('project-delete-state', { operationId: result.operationId })).state, 'committed');
  wc.emit('did-navigate', {}, 'https://example.invalid'); wc.url = 'https://example.invalid';
  assert.equal((await h.preview()).code, 'UNAUTHORIZED');
  wc.emit('did-finish-load');
  assert.equal((await h.preview()).code, 'UNAUTHORIZED', 'a foreign committed document cannot rebind');
});

test('progressing multi-chunk completion outlives sixty seconds without being fenced', supported, async t => {
  const h = await setup(t), transact = h.db.transact, complete = h.writer.completeProjectDeletion;
  const rows = Array.from({ length: 30 }, (_, index) => ({ sessionId: 'chunk-' + index, folder: 'folder', projectPath: h.projectPath, runtime: 'claude' }));
  for (const row of rows) fs.writeFileSync(path.join(path.dirname(h.transcript), row.sessionId + '.jsonl'),
    JSON.stringify({ type: 'user', sessionId: row.sessionId, cwd: h.projectPath, message: { content: 'keep' } }) + '\n');
  h.db.upsertCachedSessions(rows);
  let chunks = 0, started;
  let finished;
  const completion = new Promise(resolve => { finished = resolve; });
  h.writer.completeProjectDeletion = input => {
    started = h.time.now();
    h.db.transact = fn => { const result = transact(fn); chunks++; h.time.advance(3000); return result; };
    return complete(input).finally(finished);
  };
  const first = await h.execute(await h.preview());
  await completion; h.time.advance(2000); await flush();
  await h.service.whenIdle();
  const result = await h.invoke('project-delete-state', { operationId: first.operationId });
  assert.ok(chunks > 2 && h.time.now() - started > 60000, 'real worker completion must span multiple slow chunks');
  assert.equal(result.state, 'committed', 'advancing completion must not be sealed partial at sixty seconds');
  assert.equal(h.calls.includes('fenceProjectDeletion'), false);
});

test('stalled completion is polled before fencing after its progress deadline', supported, async t => {
  const h = await setup(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  h.writer.completeProjectDeletion = () => { entered(); return new Promise(() => {}); };
  let reads = 0, fences = 0;
  h.writer.getProjectDeletionState = async () => { reads++; return { state: 'inProgress', nextUnit: 1, lastRevision: 10 }; };
  const fence = h.writer.fenceProjectDeletion;
  h.writer.fenceProjectDeletion = (...args) => { fences++; return fence(...args); };
  const pending = h.execute(await h.preview()); await started; h.time.advance(60000); await flush();
  const first = await pending;
  assert.equal(fences, 0, 'a successful inProgress read must not immediately fence');
  for (let i = 0; i < 65; i++) { h.time.advance(1000); await flush(); }
  await h.service.whenIdle();
  assert.ok(reads > 1, 'stalled progress must be observed repeatedly'); assert.equal(fences, 1);
  assert.equal((await h.invoke('project-delete-state', { operationId: first.operationId })).state, 'notStarted');
  assert.equal(h.time.timers.size, 0);
});

test('sealed receipts sharing a project recover without holds even when the first read fails', supported, async t => {
  const h = await setup(t), project = { alias: null, projectPath: h.projectPath };
  const progress = require('../src/main/projects/project-delete-progress').createProjectDeleteProgress(h.db, { now: h.time.now });
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const epoch = progress.readScope({ project }).projectEpoch, id = operationId(project, epoch);
    progress.fence({ project, operationId: id, expectedProjectEpoch: epoch }); ids.push(id);
  }
  const first = ids.slice().sort()[0], read = h.writer.getProjectDeletionState;
  h.writer.getProjectDeletionState = input => input.operationId === first ? Promise.reject(new Error('read unavailable')) : read(input);
  h.transport.fenceFail = true;
  const service = serviceModule.createProjectDeleteService(h.serviceDeps); t.after(() => service.dispose());
  let error;
  try { await service.initialize(); } catch (caught) { error = caught; }
  assert.equal(error, undefined, 'sealed receipt recovery must not acquire conflicting holds');
  assert.equal(service.rebind({ valid: () => true }).length, 12);
  assert.equal(h.calls.includes('fenceProjectDeletion'), false, 'sealed history needs no fence');
});

test('restart invalidations carry stable operation epoch and revision for downstream deduplication', supported, async t => {
  const h = await setup(t), notices = [];
  h.serviceDeps.notifyProjects = (...args) => notices.push(args);
  const result = await h.execute(await h.preview());
  h.service.dispose();
  const service = serviceModule.createProjectDeleteService(h.serviceDeps); t.after(() => service.dispose());
  await service.initialize();
  assert.equal(notices.length, 2);
  assert.equal(notices[0][1], result.operationId);
  assert.ok(Number.isSafeInteger(notices[0][2]?.expectedProjectEpoch), 'project invalidation must include its epoch');
  assert.ok(Number.isSafeInteger(notices[0][2]?.committedRevision), 'project invalidation must include its receipt revision');
  assert.deepEqual(notices[1][2], notices[0][2]);
  const sessionChanges = h.sessionNotifications;
  assert.equal(sessionChanges[0][1]?.operationId, result.operationId, 'session invalidation must carry its operation identity');
  assert.deepEqual(sessionChanges.at(-1)[1], sessionChanges[0][1]);
});

test('hanging notification ports are bounded and preserve the committed result', supported, async t => {
  const h = await setup(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  h.serviceDeps.notifyProjects = h.serviceDeps.notifySchedules = () => { entered(); return new Promise(() => {}); };
  const first = h.execute(await h.preview());
  await started;
  for (let i = 0; i < 3; i++) { h.time.advance(10000); await flush(); }
  const result = await first;
  const read = await h.invoke('project-delete-state', { operationId: result.operationId });
  assert.equal(read.state, 'committed');
  assert.equal(read.refresh, true, 'notification timeout must produce a warning');
  assert.match(read.notificationWarning, /unavailable/i);
  await h.service.whenIdle(); assert.equal(h.time.timers.size, 0);
});

test('operation ID failure after token consumption returns a coded failure with no holds', supported, async t => {
  const h = await setup(t), p = await h.preview(); h.serviceDeps.randomUUID = () => 'invalid';
  const result = await h.execute(p).catch(error => ({ thrown: error.message }));
  assert.equal(result.code, 'DELETION_ID', 'invalid operation identity must return a coded failure');
  assert.equal((await h.execute(p)).code, 'INVALID_TOKEN'); assert.equal(h.count(), 0);
  const admission = h.gate.tryAdmit(h.projectPath); assert.ok(admission); admission.release();
});
