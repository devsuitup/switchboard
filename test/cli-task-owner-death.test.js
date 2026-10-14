'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../cli-session-state');
const { createTaskRegistry } = require('../public/task-registry');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');

test('a confirmed external owner PID death ends primary tasks while descriptor unavailability and watcher stop do not', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task-owner-624-')));
  const file = path.join(dir, '4242.json');
  const id = fixture.parentSessionId;
  let alive = true;
  let at = Date.parse('2026-10-14T01:00:00Z');
  const registry = createTaskRegistry({ now: () => at });
  registry.ingest(id, fixture.use);
  registry.ingest(id, fixture.launch);
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, procStart: '111', sessionId: id, cwd: dir, version: '2.1.296', status: 'idle', updatedAt: at, statusUpdatedAt: at }));
  cli.init({ dir, activeSessions: new Map(), isProcessAlive: () => alive, now: () => at, onIdle() {},
    onOwnerExit: sessionId => registry.ownerDied(sessionId), log: { info() {}, warn() {}, debug() {}, error() {} } });
  t.after(() => { cli.stop(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  cli.ensureWatching();
  assert.equal(cli.getStatus(id).status, 'idle');
  fs.writeFileSync(file, '{');
  at += 6000;
  cli.getStatus(id);
  assert.equal(registry.agents(id).length, 1, 'unreadable descriptor is not death');
  alive = false;
  at += 6000;
  assert.equal(cli.getStatus(id), undefined);
  await Promise.resolve();
  assert.equal(registry.agents(id).length, 0, 'cached owner PID probe must feed task completion');
  const before = registry.snapshot(id).revision;
  cli.stop();
  assert.equal(registry.snapshot(id).revision, before, 'watcher stop adds no death assertion');
});

test('a stale dead descriptor does not end tasks owned by another live descriptor for the same session', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'task-owner-624-')));
  const id = fixture.parentSessionId;
  const registry = createTaskRegistry();
  registry.ingest(id, fixture.use);
  registry.ingest(id, fixture.launch);
  for (const pid of [4242, 5252]) {
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: id, status: 'idle', statusUpdatedAt: Date.now() }));
  }
  cli.init({ dir, activeSessions: new Map(), isProcessAlive: pid => pid === 5252, onIdle() {}, onOwnerExit: sessionId => registry.ownerDied(sessionId) });
  t.after(() => { cli.stop(); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  cli.ensureWatching();
  await Promise.resolve();
  assert.equal(cli.getStatus(id).status, 'idle');
  assert.equal(registry.agents(id).length, 1, 'dead duplicate PID is not confirmed conversation-owner death');
});
