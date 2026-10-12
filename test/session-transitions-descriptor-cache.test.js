'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cliSessionState = require('../cli-session-state');
const sessionTransitions = require('../session-transitions');
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const ft = (n) => String(134360000000000000n + BigInt(n) * 1000n);
const table = (rows) => new Map(Object.entries(rows).map(([pid, [ppid, created]]) => [Number(pid), { ppid, created: ft(created) }]));
const OWN_TREE = () => table({ 900: [4, 10], 5001: [900, 20], 5002: [5001, 30], 7003: [1, 55], 7004: [7003, 60] });

test('Windows foreign-target cache survives ten process-table refreshes four seconds apart', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-p4-')));
  t.after(() => {
    cliSessionState.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const desc = path.join(root, 'desc');
  const proj = path.join(root, 'projects');
  fs.mkdirSync(desc);
  fs.mkdirSync(path.join(proj, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(desc, '7004.json'), JSON.stringify({ pid: 7004, sessionId: 'new-id', kind: 'interactive', status: 'idle', pidDomain: 'win32:anchor', procStart: ft(60) }));
  fs.writeFileSync(path.join(proj, 'proj', 'old-id.jsonl'), JSON.stringify({ type: 'continued-in', sessionId: 'old-id', continuedInSessionId: 'new-id' }) + '\n');
  fs.writeFileSync(path.join(proj, 'proj', 'new-id.jsonl'), JSON.stringify({ sessionId: 'new-id', type: 'user', message: { content: 'x' } }) + '\n');
  const clock = { t: 1_000_000 };
  let reads = 0;
  const activeSessions = new Map();
  cliSessionState.init({ dir: desc, activeSessions, log: silentLog, onIdle() {}, isProcessAlive: () => true, readProcStart: () => null, ownPid: 900, platform: 'win32', now: () => clock.t, readProcessTable: async () => { reads++; return OWN_TREE(); } });
  let calls = 0;
  sessionTransitions.init({ PROJECTS_DIR: proj, activeSessions, log: silentLog, rekeyMcpServer() {}, getMainWindow: () => null,
    clearOwner: (id, pid) => { calls++; return cliSessionState.clearOwner(id, pid); },
    getDescriptorRevision: () => cliSessionState.getDescriptorRevision() });
  const session = { exited: false, isPlainTerminal: false, projectFolder: 'proj', knownJsonlFiles: new Set(['old-id.jsonl']), forkFrom: null, realSessionId: null, pty: { pid: 5001 } };
  activeSessions.set('old-id', session);
  await cliSessionState.refreshProcessTable();
  const revision = cliSessionState.getDescriptorRevision();
  for (let pass = 0; pass < 10; pass++) {
    clock.t += 4000;
    await cliSessionState.refreshProcessTable();
    const descriptorPath = path.join(desc, '7004.json');
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    fs.writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, status: pass % 2 ? 'busy' : 'idle' }));
    sessionTransitions.detectSessionTransitions('proj');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
  }
  assert.ok(calls <= 1, `clearOwner called ${calls} times, table read ${reads} times`);
  assert.equal(cliSessionState.getDescriptorRevision(), revision);
  assert.equal(activeSessions.get('old-id'), session);
  assert.equal(cliSessionState.clearOwner('new-id', 5001), 'other');
  assert.equal(reads, 11);

  fs.writeFileSync(path.join(desc, '5002.json'), JSON.stringify({
    pid: 5002, sessionId: 'new-id', kind: 'interactive', pidDomain: 'win32:anchor', procStart: ft(30),
  }));
  assert.ok(cliSessionState.getDescriptorRevision() > revision);
  sessionTransitions.detectSessionTransitions('proj');
  assert.equal(calls, 2);
  assert.equal(activeSessions.get('new-id'), session);
});

test('descriptor revisions track the identity set, including id, pid, addition and removal', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-revision-')));
  t.after(() => { cliSessionState.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  cliSessionState.init({ dir: root, activeSessions: new Map(), log: silentLog, onIdle() {}, isProcessAlive: () => true });
  const file = path.join(root, '7004.json');
  const write = fields => fs.writeFileSync(file, JSON.stringify({ pid: 7004, sessionId: 'a', status: 'idle', ...fields }));
  let revision = cliSessionState.getDescriptorRevision();
  for (const fields of [{}, { sessionId: 'b' }, { sessionId: 'b', pid: 7005 }]) {
    write(fields);
    assert.equal(cliSessionState.getDescriptorRevision(), ++revision);
  }
  write({ sessionId: 'b', pid: 7005, status: 'busy', statusUpdatedAt: Date.now() });
  assert.equal(cliSessionState.getDescriptorRevision(), revision);
  fs.unlinkSync(file);
  assert.equal(cliSessionState.getDescriptorRevision(), revision + 1);
});
