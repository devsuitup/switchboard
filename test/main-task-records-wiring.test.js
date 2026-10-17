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
  vm.runInContext(source.slice(start, end), ctx);
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
