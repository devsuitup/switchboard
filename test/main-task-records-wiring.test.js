'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createTaskRegistry } = require('../public/task-registry');
const { parseFolderKey } = require('../remote-hosts');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(/\r\n/g, '\n');

test('shipped main bootstrap replays old open tasks for live local owners and forwards worker continuation identity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-tasks-624-'));
  const id = fixture.parentSessionId;
  const dead = '33333333-3333-4333-8333-333333333333';
  const remote = '44444444-4444-4444-8444-444444444444';
  const next = '22222222-2222-4222-8222-222222222222';
  const content = [fixture.use, fixture.launch].map(e => JSON.stringify(e) + '\n').join('');
  for (const parent of [id, dead, remote]) fs.writeFileSync(path.join(dir, `${parent}.jsonl`), content);
  fs.utimesSync(path.join(dir, `${id}.jsonl`), 100, 100);
  const renderer = createTaskRegistry();
  let handler;
  const ctx = vm.createContext({ require: name => name === './task-records-client' ? require('../task-records-client') : null,
    refreshRemoteHeadTurnsFromCache: require('../remote-index').refreshRemoteHeadTurns,
    path, mainWindow: { isDestroyed: () => false, webContents: { send: (channel, payload) => {
      if (channel === 'task-snapshot') renderer.applySnapshot(payload);
      if (channel === 'task-rekey') renderer.rekey(payload.oldId, payload.newId, { continued: payload.continued });
    } } }, log: { warn(message) { throw new Error(message); } },
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    cliSessionState: { getSidebarDescriptors: () => [{ sessionId: id }, { sessionId: remote }], readAllDescriptors: () => [] },
    activeSessions: new Map(), bgAgents: { getSnapshot: () => ({ roster: [] }) },
    getAllCached: () => [{ sessionId: id, folder: 'folder' }, { sessionId: dead, folder: 'folder' }, { sessionId: remote, folder: 'host::folder' }],
    getAllMeta: () => new Map(), parseFolderKey,
    remoteIndexer: { getRemoteSessions: () => ({ sessions: [{ sessionId: remote }] }) },
    projectsDirForFolder: () => dir, getCachedByParent: () => [],
  });
  const start = source.indexOf("const { createTaskRecordsClient } = require('./task-records-client');");
  const end = source.indexOf('const sessionTransitions =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx, { filename: path.join(__dirname, '../main.js') });
  const client = vm.runInContext('taskRecords', ctx);
  t.after(async () => { await client.dispose(); assert.equal(path.dirname(fs.realpathSync.native(dir)), fs.realpathSync.native(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); assert.equal(fs.existsSync(dir), false); });
  const snapshots = await handler();
  assert.deepEqual(snapshots.map(s => s.parentSessionId).sort(), [id, remote].sort());
  assert.equal(renderer.agents(remote).length, 0, 'remote head reads never replay remote tasks');
  assert.equal(snapshots.find(s => s.parentSessionId === remote).headTurn.state, 'open');
  assert.equal(renderer.agents(id).length, 1, 'old write timestamp does not expire explicit live-owner evidence');
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'continued-in', sessionId: id, continuedInSessionId: next, timestamp: '2026-10-14T00:02:00Z' }) + '\n');
  await client.read(path.join(dir, `${id}.jsonl`), id);
  assert.equal(renderer.agents(id).length, 0);
  assert.equal(renderer.agents(next).length, 1);
  fs.writeFileSync(path.join(dir, `${next}.jsonl`), JSON.stringify(fixture.notification) + '\n');
  await client.read(path.join(dir, `${next}.jsonl`), next);
  assert.equal(renderer.agents(next).length, 0);
});

for (const failure of ['metadata', 'cache-once', 'cache-persistent']) {
  test(`get-task-snapshots retains worker snapshots and reads available local tasks after ${failure} failure`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-tasks-873-'));
    const id = fixture.parentSessionId;
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), [fixture.use, fixture.launch].map(e => JSON.stringify(e) + '\n').join(''));
    const warnings = [];
    let handler;
    let failing = false;
    let failedOnce = false;
    const ctx = vm.createContext({
      require: name => name === './task-records-client' ? require('../task-records-client') : null,
      refreshRemoteHeadTurnsFromCache: require('../remote-index').refreshRemoteHeadTurns,
      path, mainWindow: null, log: { warn: message => warnings.push(message) },
      ipcMain: { handle: (channel, callback) => { assert.equal(channel, 'get-task-snapshots'); handler = callback; } },
      cliSessionState: { getSidebarDescriptors: () => [{ sessionId: id }], readAllDescriptors: () => [] },
      activeSessions: new Map(), bgAgents: { getSnapshot: () => ({ roster: [] }) },
      getAllCached: () => {
        if (failing && failure.startsWith('cache') && (!failedOnce || failure === 'cache-persistent')) {
          failedOnce = true;
          throw new Error('local cache read failed');
        }
        return [{ sessionId: id, folder: 'folder' }];
      },
      getAllMeta: () => { if (failing && failure === 'metadata') throw new Error('local metadata read failed'); return new Map(); },
      parseFolderKey, remoteIndexer: { getRemoteSessions: () => ({ sessions: [] }) },
      projectsDirForFolder: () => dir, getCachedByParent: () => [],
    });
    const start = source.indexOf("const { createTaskRecordsClient } = require('./task-records-client');");
    const end = source.indexOf('const sessionTransitions =', start);
    assert.ok(start >= 0 && end > start);
    const slice = source.slice(start, end);
    vm.runInContext(slice, ctx, {
      filename: path.join(__dirname, '../main.js'), lineOffset: source.slice(0, source.indexOf(slice)).split('\n').length - 1,
    });
    const client = vm.runInContext('taskRecords', ctx);
    t.after(async () => { await client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
    const existing = await handler();
    assert.equal(existing.find(s => s.parentSessionId === id).tasks.length, 1);
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify(fixture.notification) + '\n');
    failing = true;
    let snapshots;
    await assert.doesNotReject(async () => { snapshots = await handler(); }, 'a head-turn cache failure must not reject the IPC call');
    assert.equal(snapshots.find(s => s.parentSessionId === id).tasks.filter(task => !task.terminal).length, failure === 'cache-persistent' ? 1 : 0,
      'readable local tasks refresh; an unavailable cache retains the previous worker snapshot');
    assert.ok(warnings.some(message => /head-turn.*local (metadata|cache) read failed/.test(message)), 'the remote head-turn failure is logged');
    if (failure === 'cache-persistent') assert.ok(warnings.some(message => /local.*cache read failed/.test(message)));
    failing = false;
    const recovered = await handler();
    assert.equal(recovered.find(s => s.parentSessionId === id).tasks.filter(task => !task.terminal).length, 0);
  });
}

test('get-task-snapshots skips failing child cache rows, warns once per call and returns all available snapshots', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-tasks-885-'));
  const ids = [fixture.parentSessionId, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const retained = '44444444-4444-4444-8444-444444444444';
  for (const id of [...ids, retained]) {
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), [fixture.use, fixture.launch].map(e => JSON.stringify(e) + '\n').join(''));
  }
  const synchronousUse = structuredClone(fixture.use);
  synchronousUse.message.content[0].input.run_in_background = false;
  fs.writeFileSync(path.join(dir, `${ids[2]}.jsonl`), JSON.stringify(synchronousUse) + '\n');
  const childrenDir = path.join(dir, ids[2], 'subagents');
  fs.mkdirSync(childrenDir, { recursive: true });
  fs.writeFileSync(path.join(childrenDir, `agent-${fixture.agentId}.meta.json`), JSON.stringify(fixture.childMeta));
  const warnings = [];
  const childReads = [];
  let failing = true;
  let handler;
  const ctx = vm.createContext({
    require: name => name === './task-records-client' ? require('../task-records-client') : null,
    refreshRemoteHeadTurnsFromCache: require('../remote-index').refreshRemoteHeadTurns,
    path, resolveJsonlPath: require('../read-session-file').resolveJsonlPath, mainWindow: null, log: { warn: message => warnings.push(message) },
    ipcMain: { handle: (channel, callback) => { assert.equal(channel, 'get-task-snapshots'); handler = callback; } },
    cliSessionState: { getSidebarDescriptors: () => ids.map(sessionId => ({ sessionId })), readAllDescriptors: () => [] },
    activeSessions: new Map(), bgAgents: { getSnapshot: () => ({ roster: [] }) },
    getAllCached: () => ids.map(sessionId => ({ sessionId, folder: 'folder' })),
    getAllMeta: () => new Map(), parseFolderKey,
    remoteIndexer: { getRemoteSessions: () => ({ sessions: [] }) },
    projectsDirForFolder: () => dir,
    getCachedByParent: id => {
      childReads.push(id);
      if (failing && id !== ids[2]) throw new Error(`child cache unavailable for ${id}`);
      return id === ids[2] ? [{ agentId: fixture.agentId, parentSessionId: id }] : [];
    },
  });
  const start = source.indexOf("const { createTaskRecordsClient } = require('./task-records-client');");
  const end = source.indexOf('const sessionTransitions =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx, {
    filename: path.join(__dirname, '../main.js'), lineOffset: source.slice(0, start).split('\n').length - 1,
  });
  const client = vm.runInContext('taskRecords', ctx);
  t.after(async () => { await client.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.read(path.join(dir, `${retained}.jsonl`), retained);
  for (let call = 1; call <= 2; call++) {
    let snapshots;
    await assert.doesNotReject(async () => { snapshots = await handler(); }, 'a per-row child cache failure must not reject the IPC call');
    assert.deepEqual(snapshots.map(s => s.parentSessionId).sort(), [...ids, retained].sort());
    for (const snapshot of snapshots) {
      assert.equal(snapshot.tasks.length, 1, 'initial task pills and existing worker tasks remain available');
      assert.equal(snapshot.headTurn.state, 'open', 'initial head-turn spinner evidence remains available');
    }
    assert.equal(snapshots.find(s => s.parentSessionId === ids[2]).tasks[0].id, fixture.agentId,
      'a readable later row still correlates child metadata through the real worker');
    assert.deepEqual(childReads.slice((call - 1) * ids.length), ids, 'later rows are still visited');
    assert.equal(warnings.length, call, 'multiple failing rows warn only once per IPC call');
    assert.match(warnings.at(-1), /\[task-records\].*child.*cache.*child cache unavailable/);
  }
  failing = false;
  await handler();
  assert.equal(warnings.length, 2, 'recovered child reads do not warn');
});

test('status changes notify task liveness only for a changed owner identity', () => {
  const start = source.indexOf('cliSessionState.onStatusesChanged(');
  const end = source.indexOf('\n});', start) + '\n});'.length;
  let callback;
  let descriptors = [{ sessionId: 'owner', pid: 12, startedAt: 1 }];
  const live = [];
  const ctx = vm.createContext({
    notifyRendererProjectsChanged() {},
    activeSessions: new Map(), detectSessionTransitions() {},
    sessionTransitions: { detectPendingBackgroundContinuations() {} },
    taskOwnerLiveness: new Map(),
    taskRecords: { ownerAlive: id => live.push(id) },
    cliSessionState: { onStatusesChanged: cb => { callback = cb; }, getSidebarDescriptors: () => descriptors },
  });
  vm.runInContext(source.slice(start, end), ctx);
  callback();
  descriptors[0].status = 'working';
  callback();
  assert.deepEqual(live, ['owner'], 'a status-only change must not send ownerAlive again');
  descriptors = [{ sessionId: 'owner', pid: 13, startedAt: 2 }];
  callback();
  assert.deepEqual(live, ['owner', 'owner']);
  descriptors = [{ sessionId: 'owner', pid: 13, startedAt: 3 }];
  callback();
  assert.deepEqual(live, ['owner', 'owner', 'owner'], 'PID reuse is distinguished by the descriptor start time');
  descriptors = [];
  callback();
  descriptors = [{ sessionId: 'owner', pid: 13, startedAt: 3 }];
  callback();
  assert.deepEqual(live, ['owner', 'owner', 'owner', 'owner']);
});
