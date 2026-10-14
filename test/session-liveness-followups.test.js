'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cli = require('../cli-session-state');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions, extractFunction } = require('./app-source');

function bootMain(t, opts = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-576-')));
  fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({
    pid: 4242, sessionId: 'A', cwd: dir, procStart: '111', status: 'idle', statusUpdatedAt: 10000,
  }));
  let alive = true;
  const sent = [];
  const timers = [];
  let unsubscribe;
  const context = vm.createContext({
    activeSessions: new Map(), log: { info() {}, debug() {}, warn() {} },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: channel => sent.push(channel) } }),
    setTimeout: fn => { timers.push(fn); return timers.length; },
    require: () => ({
      init: ctx => cli.init({ ...ctx, dir, isProcessAlive: () => alive, readParentPid: () => null, ...opts }),
      onDescriptorsChanged: fn => { unsubscribe = cli.onDescriptorsChanged(fn); return unsubscribe; },
      onStatusesChanged: fn => { unsubscribe = cli.onStatusesChanged(fn); return unsubscribe; },
    }),
  });
  const cache = fs.readFileSync(path.join(__dirname, '../session-cache.js'), 'utf8');
  vm.runInContext(cache.slice(cache.indexOf('const NOTIFY_THROTTLE_MS'), cache.indexOf('function sendStatus')), context);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  vm.runInContext(main.slice(main.indexOf("const cliSessionState = require('./cli-session-state');"), main.indexOf('const ptyPids =')), context);
  assert.ok(cli.ensureWatching());
  t.after(() => { unsubscribe?.(); cli.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, sent, timers, context, kill: () => { alive = false; } };
}

test('576 item 1: a process dying without a descriptor write pushes projects-changed without a manual refresh', { timeout: 8000 }, t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const h = bootMain(t);
  assert.equal(cli.getStatus('A').status, 'idle');
  h.kill();
  t.mock.timers.tick(5000);
  assert.deepEqual(h.sent, ['projects-changed']);
  assert.equal(cli.getStatus('A'), undefined);
  h.timers.shift()();
  t.mock.timers.tick(10000);
  assert.equal(h.sent.length, 1, 'empty descriptor maps do not keep pushing rebuilds');
});

test('576 descriptor changes share the existing leading/trailing projects-changed throttle', { timeout: 8000 }, async t => {
  const h = bootMain(t);
  const notified = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('descriptor notification did not arrive')), 3000);
    const off = cli.onDescriptorsChanged(() => { clearTimeout(timeout); off(); resolve(); });
    t.after(() => { clearTimeout(timeout); off(); });
  });
  h.kill();
  fs.unlinkSync(path.join(h.dir, '4242.json'));
  await notified;
  assert.deepEqual(h.sent, ['projects-changed']);
  vm.runInContext('notifyRendererProjectsChanged(); notifyRendererProjectsChanged();', h.context);
  assert.equal(h.sent.length, 1);
  h.timers.shift()();
  assert.equal(h.sent.length, 2, 'descriptor and other project pushes coalesce into one trailing send');
});

test('576 a lazy status read detecting death before the probe still pushes the renderer', { timeout: 8000 }, t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const h = bootMain(t);
  assert.equal(cli.getStatus('A').status, 'idle');
  h.kill();
  t.mock.timers.setTime(16000);
  assert.equal(cli.getStatus('A'), undefined);
  assert.deepEqual(h.sent, ['projects-changed']);
  t.mock.timers.tick(5000);
  assert.equal(h.sent.length, 1);
});

function sidebar(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const timers = new Map();
  let nextId = 0;
  ctx.window.setTimeout = fn => { timers.set(++nextId, fn); return nextId; };
  ctx.window.clearTimeout = id => timers.delete(id);
  const { dedup } = loadAppFunctions(ctx.context, { functions: ['dedup'] });
  const render = sessions => {
    const projects = [makeSampleProject({ sessions })];
    dedup(projects);
    ctx.sidebar.renderProjects(projects, true);
    return ctx.document.getElementById('si-A');
  };
  const expire = () => {
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  };
  return { ...ctx, render, expire, timers };
}

test('576 item 2: a formerly standalone merged member refreshes its own descriptor on every load', { timeout: 8000 }, t => {
  const h = sidebar(t);
  h.render([{ sessionId: 'B', status: 'idle' }]);
  assert.ok(h.document.getElementById('si-B').classList.contains('is-alive'));
  const statuses = new Map([['B', { status: 'idle', statusUpdatedAt: 10 }]]);
  const mainContext = vm.createContext({ cliSessionState: { getStatus: id => statuses.get(id) } });
  vm.runInContext(extractFunction(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), 'annotateRemoteAttachable'), mainContext);
  const loadMerged = () => {
    const projects = [{ sessions: [{ sessionId: 'A', mergedMemberIds: ['B'] }] }];
    mainContext.annotateRemoteAttachable(projects);
    return h.render(projects[0].sessions);
  };
  assert.ok(loadMerged().classList.contains('is-alive'), 'a live hidden member still drives its row');
  statuses.clear();
  assert.equal(loadMerged().classList.contains('is-alive'), false, 'the hidden member cannot keep its stale standalone status');
  statuses.set('B', { status: 'idle', statusUpdatedAt: 20 });
  assert.ok(loadMerged().classList.contains('is-alive'), 'a returning member descriptor reaches the row');
});

test('576 item 3: a descriptor loss clears the old inference and leaves unknown liveness', { timeout: 8000 }, t => {
  const h = sidebar(t);
  h.render([{ sessionId: 'A', status: 'idle' }]);
  h.emitSessionTranscriptActivity({ sessionId: 'A', at: 10 });
  h.expire();
  assert.equal(h.document.querySelector('#si-A .session-icon').title, 'Waiting for input');
  const missed = h.render([{ sessionId: 'A', status: undefined }]);
  assert.equal(h.read('localPtyStates.get("A").snapshot().liveness'), 'unknown');
  assert.equal(h.read('localTranscriptStates.has("A")'), false);
  assert.equal(missed.classList.contains('is-alive'), false);
  assert.equal(missed.querySelector('.session-icon').title, 'Idle');
  const returned = h.render([{ sessionId: 'A', status: 'idle' }]);
  assert.ok(returned.classList.contains('is-alive'));
  assert.equal(returned.querySelector('.session-icon').title, 'Waiting for input');
});

test('576 a never-standalone merged member uses its own descriptor without creating a sidebar map entry', { timeout: 8000 }, t => {
  const h = sidebar(t);
  const row = { sessionId: 'A', headSessionId: 'B', mergedMemberIds: ['B'], mergedMemberStatuses: { B: { status: 'idle', statusUpdatedAt: 10 } } };
  assert.ok(h.render([row]).classList.contains('is-alive'));
  assert.deepEqual([...h.window.sessionMap.keys()], ['A']);
  h.emitSessionTranscriptActivity({ sessionId: 'B' });
  h.expire();
  assert.equal(h.document.querySelector('#si-A .session-icon').title, 'Waiting for input');
  assert.equal(h.read('localTranscriptStates.get("B").snapshot().liveness'), 'alive');
  h.render([{ ...row, mergedMemberStatuses: { B: null } }]);
  h.expire();
  assert.equal(h.document.querySelector('#si-A .session-icon').title, 'Idle');
  assert.deepEqual([...h.window.sessionMap.keys()], ['A']);
});

test('576 watcher stop pushes an unknown status instead of leaving the external row alive', { timeout: 8000 }, t => {
  const main = bootMain(t);
  const h = sidebar(t);
  h.render([{ sessionId: 'A', ...cli.getStatus('A') }]);
  cli.stop();
  assert.deepEqual(main.sent, ['projects-changed']);
  const item = h.render([{ sessionId: 'A', status: undefined }]);
  assert.equal(item.classList.contains('is-alive'), false);
  assert.equal(h.read('localPtyStates.get("A").snapshot().liveness'), 'unknown');
});

test('576 item 4: a late transcript write after descriptor loss cannot leave Waiting beyond decay', { timeout: 8000 }, t => {
  const h = sidebar(t);
  h.render([{ sessionId: 'A', status: 'idle' }]);
  h.emitSessionTranscriptActivity({ sessionId: 'A', at: 10 });
  h.render([{ sessionId: 'A', status: undefined }]);
  h.expire();
  h.emitSessionTranscriptActivity({ sessionId: 'A', at: 20 });
  assert.equal(h.document.getElementById('si-A').classList.contains('cli-busy'), false);
  h.expire();
  const item = h.document.getElementById('si-A');
  assert.equal(item.querySelector('.session-icon').title, 'Idle');
  assert.equal(item.classList.contains('is-alive'), false);
  assert.equal(h.read('localTranscriptStates.has("A")'), false);
  assert.equal(h.timers.size, 0);
});

test('576 repeated descriptor misses leave no old transcript state or grace timer', { timeout: 8000 }, t => {
  const h = sidebar(t);
  h.render([{ sessionId: 'A', status: 'idle' }]);
  h.emitSessionTranscriptActivity({ sessionId: 'A' });
  h.expire();
  h.render([{ sessionId: 'A', status: undefined }]);
  assert.equal(h.read('localTranscriptDecayTimers.has("A")'), false);
  h.render([{ sessionId: 'A', status: undefined }]);
  assert.equal(h.read('localTranscriptDecayTimers.has("A")'), false);
  h.expire();
  assert.equal(h.document.querySelector('#si-A .session-icon').title, 'Idle');
  assert.equal(h.read('localTranscriptStates.has("A")'), false);
});

test('576 late subagent writes with unknown liveness expire both parent signals', { timeout: 8000 }, t => {
  const h = sidebar(t);
  h.render([{ sessionId: 'A', status: 'idle' }]);
  h.emitSessionTranscriptActivity({ sessionId: 'A' });
  h.render([{ sessionId: 'A', status: undefined }]);
  h.expire();
  h.emitSessionTranscriptActivity({ sessionId: 'A' });
  h.emitSessionTranscriptActivity({ kind: 'subagent', parentSessionId: 'A' });
  assert.equal(h.document.getElementById('si-A').classList.contains('has-busy-agents'), false);
  h.expire();
  assert.equal(h.document.querySelector('#si-A .session-icon').title, 'Idle');
  assert.equal(h.document.getElementById('si-A').classList.contains('has-busy-agents'), false);
  assert.equal(h.read('localTranscriptStates.has("A")'), false);
  assert.equal(h.timers.size, 0);
});

function descriptorBatch(t, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('descriptor batch did not flush')), 3000);
    const off = cli.onDescriptorsChanged(() => { clearTimeout(timeout); off(); resolve(); });
    t.after(() => { clearTimeout(timeout); off(); });
    action();
  });
}

test('576r2 minor 1: an unchanged Windows process-table refresh never pushes projects-changed', { timeout: 8000 }, async t => {
  const h = bootMain(t, {
    platform: 'win32', readParentPid: undefined,
    readProcessTable: async () => new Map([[4242, { ppid: 1, created: '111' }]]),
  });
  await cli.refreshProcessTable();
  assert.deepEqual(h.sent, [], 'ownership-only process table refresh must not rebuild the sidebar');
  assert.equal(cli.getStatus('A').status, 'idle');
});

test('576r2 minor 1: unchanged descriptor writes do not push but status changes and new sessions do', { timeout: 8000 }, async t => {
  const h = bootMain(t);
  const file = path.join(h.dir, '4242.json');
  const descriptor = JSON.parse(fs.readFileSync(file, 'utf8'));
  await descriptorBatch(t, () => fs.writeFileSync(file, JSON.stringify({ ...descriptor, statusUpdatedAt: 20000 })));
  assert.deepEqual(h.sent, [], 'a timestamp-only flush must not rebuild the sidebar');
  await descriptorBatch(t, () => fs.writeFileSync(file, JSON.stringify({ ...descriptor, status: 'waiting' })));
  assert.deepEqual(h.sent, ['projects-changed']);
  assert.equal(cli.getStatus('A').status, 'waiting');
  h.timers.shift()();
  await descriptorBatch(t, () => fs.writeFileSync(path.join(h.dir, '4343.json'), JSON.stringify({ ...descriptor, pid: 4343, sessionId: 'B' })));
  h.timers.shift()();
  assert.deepEqual(h.sent, ['projects-changed', 'projects-changed']);
  assert.equal(cli.getStatus('B').status, 'idle');
});

test('576r2 minor 2: a descriptor read miss keeps the previous status while its known PID is alive', { timeout: 8000 }, async t => {
  let clock = 10000;
  const h = bootMain(t, { now: () => clock });
  await descriptorBatch(t, () => fs.unlinkSync(path.join(h.dir, '4242.json')));
  assert.deepEqual(cli.getStatus('A'), { status: 'idle', statusUpdatedAt: 10000 }, 'a live idle process survives a transient descriptor read miss');
  assert.deepEqual(h.sent, [], 'a retained live status needs no rebuild');
  h.kill();
  clock += 6000;
  assert.equal(cli.getStatus('A'), undefined);
  assert.deepEqual(h.sent, ['projects-changed'], 'the retained PID is still probed and an actual death is pushed');
});

test('576r2 minor 4: a stale archived merged owner cannot override the current emitted row', { timeout: 8000 }, t => {
  const h = sidebar(t);
  h.render([{ sessionId: 'old', archived: 1, mergedMemberIds: ['B'], mergedMemberStatuses: { B: { status: 'idle' } } }]);
  const item = h.render([{ sessionId: 'A', mergedMemberIds: ['B'], mergedMemberStatuses: { B: null } }]);
  assert.equal(item.classList.contains('is-alive'), false, 'an archived cached row cannot supply a live member status');
  h.emitSessionTranscriptActivity({ sessionId: 'B' });
  assert.equal(h.read('localTranscriptStates.get("B").snapshot().liveness'), 'unknown');
  h.expire();
  assert.equal(item.querySelector('.session-icon').title, 'Idle', 'a transcript write without head liveness cannot imply a prompt');
  h.render([{ sessionId: 'A', mergedMemberIds: ['B'], mergedMemberStatuses: { B: { status: 'idle' } } }]);
  assert.equal(h.read('localSessionForStatus("B").status'), 'idle');
  const dead = h.render([{ sessionId: 'A', mergedMemberIds: ['B'], mergedMemberStatuses: { B: null } }]);
  h.expire();
  assert.equal(dead.classList.contains('is-alive'), false);
  assert.equal(dead.querySelector('.session-icon').title, 'Idle');
});

function missedDescriptor(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  let event;
  t.mock.method(fs, 'watch', (_dir, callback) => {
    event = callback;
    return { close() {}, on() {} };
  });
  const h = bootMain(t);
  const file = path.join(h.dir, '4242.json');
  const descriptor = fs.readFileSync(file, 'utf8');
  const flush = () => { event('rename', '4242.json'); t.mock.timers.tick(150); };
  return { ...h, file, descriptor, flush };
}

test('576r3 a deleted descriptor with a reused live PID expires within two probe periods', { timeout: 8000 }, t => {
  const h = missedDescriptor(t);
  fs.unlinkSync(h.file);
  h.flush();
  assert.equal(cli.getStatus('A').status, 'idle');
  t.mock.timers.tick(4850);
  assert.equal(cli.getStatus('A').status, 'idle', 'one probe preserves the exit grace');
  h.flush();
  t.mock.timers.tick(4850);
  assert.equal(cli.getStatus('A'), undefined, 'a repeated miss must not extend the ten-second bound');
  assert.deepEqual(h.sent, ['projects-changed']);
});

test('576r3 an existing unreadable descriptor keeps its live status but expires within two probes', { timeout: 8000 }, t => {
  const h = missedDescriptor(t);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === h.file) throw Object.assign(new Error('busy descriptor'), { code: 'EPERM' });
    return read(file, ...args);
  });
  h.flush();
  assert.equal(fs.existsSync(h.file), true);
  assert.deepEqual(cli.getStatus('A'), { status: 'idle', statusUpdatedAt: 10000 });
  assert.deepEqual(h.sent, []);
  t.mock.timers.tick(4850);
  assert.equal(cli.getStatus('A').status, 'idle');
  h.flush();
  t.mock.timers.tick(4850);
  assert.equal(cli.getStatus('A'), undefined, 'read errors must not retain a reused PID forever');
  assert.deepEqual(h.sent, ['projects-changed']);
});

test('576r3 a partial descriptor write keeps its live status but expires within two probes', { timeout: 8000 }, t => {
  const h = missedDescriptor(t);
  fs.writeFileSync(h.file, '{"pid":4242');
  h.flush();
  assert.equal(cli.getStatus('A').status, 'idle');
  t.mock.timers.tick(4850);
  t.mock.timers.tick(5000);
  assert.equal(cli.getStatus('A'), undefined, 'a partial write must have the same retention bound');
});

test('576r3 a deleted descriptor is forgotten at the next probe after its PID exits', { timeout: 8000 }, t => {
  const h = missedDescriptor(t);
  fs.unlinkSync(h.file);
  h.flush();
  assert.equal(cli.getStatus('A').status, 'idle');
  h.kill();
  t.mock.timers.tick(4850);
  assert.deepEqual(h.sent, ['projects-changed']);
  assert.equal(cli.getStatus('A'), undefined);
});

test('576r3 a descriptor returning between probes clears the old miss budget', { timeout: 8000 }, t => {
  const h = missedDescriptor(t);
  fs.unlinkSync(h.file);
  h.flush();
  t.mock.timers.tick(4850);
  fs.writeFileSync(h.file, h.descriptor);
  t.mock.timers.tick(5000);
  assert.equal(cli.getStatus('A').status, 'idle', 'a valid descriptor read at the probe cancels expiry');
  fs.unlinkSync(h.file);
  h.flush();
  t.mock.timers.tick(4850);
  assert.equal(cli.getStatus('A').status, 'idle', 'a new miss starts a new two-probe budget');
  t.mock.timers.tick(5000);
  assert.equal(cli.getStatus('A'), undefined);
});

test('576r3 the liveness probe does not keep the Node process alive', { timeout: 8000 }, t => {
  const schedule = global.setTimeout;
  const probes = [];
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    const timer = schedule(callback, ms, ...args);
    if (ms === 5000) probes.push(timer);
    return timer;
  });
  bootMain(t);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].hasRef(), false);
});
