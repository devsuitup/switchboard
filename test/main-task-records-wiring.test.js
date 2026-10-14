'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createTaskRegistry } = require('../public/task-registry');
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
      if (channel === 'task-rekey') renderer.rekey(payload.oldId, payload.newId);
    } } }, log: { warn(message) { throw new Error(message); } },
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    cliSessionState: { getSidebarDescriptors: () => [{ sessionId: id }, { sessionId: remote }] },
    activeSessions: new Map(), bgAgents: { getSnapshot: () => ({ roster: [] }) },
    getAllCached: () => [{ sessionId: id }, { sessionId: dead }, { sessionId: remote, remoteAlias: 'host' }],
    getCachedFolder: () => 'folder', projectsDirForFolder: () => dir, getCachedByParent: () => [],
  });
  const start = source.indexOf("const { createTaskRecordsClient } = require('./task-records-client');");
  const end = source.indexOf('const sessionTransitions =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx);
  const client = vm.runInContext('taskRecords', ctx);
  t.after(async () => { await client.dispose(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const snapshots = await handler();
  assert.deepEqual(snapshots.map(s => s.parentSessionId), [id]);
  assert.equal(renderer.agents(id).length, 1, 'old write timestamp does not expire explicit live-owner evidence');
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'continued-in', sessionId: id, continuedInSessionId: next, timestamp: '2026-10-14T00:02:00Z' }) + '\n');
  await client.read(path.join(dir, `${id}.jsonl`), id);
  assert.equal(renderer.agents(id).length, 0);
  assert.equal(renderer.agents(next).length, 1);
  fs.writeFileSync(path.join(dir, `${next}.jsonl`), JSON.stringify(fixture.notification) + '\n');
  await client.read(path.join(dir, `${next}.jsonl`), next);
  assert.equal(renderer.agents(next).length, 0);
});
