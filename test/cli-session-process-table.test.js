// Tests for the process-table reader behind "is this CLI one of this instance's own?"
// on platforms without /proc. See .ai/contexts/cli-session-state.md ("Own descendants
// outside Linux") and .ai/contexts/bg-agents.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cliSessionState = require('../cli-session-state');
const { mergeRoster } = require('../bg-agents-roster');

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const noPty = () => false;

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-proc-table-')));
}

function writeState(dir, pid, fields = {}) {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: 'sess-1', cwd: 'C:\\work\\proj', startedAt: 1790685077444, kind: 'interactive', status: 'idle', ...fields,
  }), 'utf8');
}

// Switchboard.exe(900) -> bash(5001, the PTY pid) -> bash(5002) -> sh(5003) -> claude(5004)
const OWN_TREE = new Map([[5004, 5003], [5003, 5002], [5002, 5001], [5001, 900], [900, 4], [7004, 7003], [7003, 1]]);

function boot(dir, opts = {}) {
  const clock = { t: 1_000_000 };
  const reads = { count: 0 };
  cliSessionState.init({
    dir,
    activeSessions: new Map(),
    log: silentLog,
    onIdle: () => {},
    isProcessAlive: () => true,
    readProcStart: () => null,
    ownPid: opts.ownPid ?? 900,
    platform: opts.platform || 'win32',
    now: () => clock.t,
    readParentPid: opts.readParentPid,
    readProcessTable: opts.readProcessTable || (async () => { reads.count++; return OWN_TREE; }),
  });
  return { clock, reads };
}

async function withDir(fn) {
  const dir = mkTmp();
  try { return await fn(dir); } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('on win32 a CLI three levels under a PTY pid is this instance\'s own, not live elsewhere', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir, { readProcessTable: async () => new Map([[5004, 5003], [5003, 5002], [5002, 5001], [5001, 1]]) });
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]), null);
}));

test('on win32 a CLI whose chain reaches this main process is its own', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir);
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty, () => []), null);
}));

test('on win32 a CLI under another process tree is still live elsewhere', () => withDir(async (dir) => {
  writeState(dir, 7004);
  boot(dir);
  const live = await cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]);
  assert.equal(live.pid, 7004);
}));

test('liveElsewhereChecked and liveElsewhereMany also recognise an own descendant on win32', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir);
  assert.deepEqual(await cliSessionState.liveElsewhereChecked('sess-1', noPty, () => [5001]), { known: true, live: null });
  assert.deepEqual(await cliSessionState.liveElsewhereMany(['sess-1'], noPty, () => [5001]), {});
}));

test('a process-table snapshot that fails degrades to the PTY pids alone and does not throw', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir, { readProcessTable: async () => { throw new Error('powershell timed out'); } });
  const live = await cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]);
  assert.equal(live.pid, 5004);
  assert.equal(cliSessionState.ownProcessFilter(() => [5001])(5001), true);
}));

test('a snapshot that returns nothing usable degrades the same way', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir, { readProcessTable: async () => 'not a map' });
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, () => [5001])).pid, 5004);
}));

test('one snapshot serves every check inside the cache window, and a later one reads again', () => withDir(async (dir) => {
  writeState(dir, 5004);
  const { clock, reads } = boot(dir);
  await cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]);
  await cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]);
  await cliSessionState.liveElsewhereMany(['sess-1'], noPty, () => [5001]);
  assert.equal(reads.count, 1);
  clock.t += cliSessionState.PROCESS_TABLE_TTL_MS + 1;
  await cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]);
  assert.equal(reads.count, 2);
}));

test('concurrent checks share one in-flight snapshot', () => withDir(async (dir) => {
  writeState(dir, 5004);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  boot(dir, { readProcessTable: async () => { calls++; await gate; return OWN_TREE; } });
  const pending = [
    cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]),
    cliSessionState.liveElsewhere('sess-1', noPty, () => [5001]),
    cliSessionState.refreshProcessTable(),
  ];
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.equal(results[0], null);
  assert.equal(results[1], null);
}));

test('a failed snapshot is not retried inside the cache window', () => withDir(async (dir) => {
  writeState(dir, 5004);
  let calls = 0;
  boot(dir, { readProcessTable: async () => { calls++; throw new Error('boom'); } });
  await cliSessionState.liveElsewhere('sess-1', noPty, () => []);
  await cliSessionState.liveElsewhere('sess-1', noPty, () => []);
  assert.equal(calls, 1);
}));

test('no descriptor for the asked session means no snapshot is taken', () => withDir(async (dir) => {
  writeState(dir, 5004, { sessionId: 'other' });
  const { reads } = boot(dir);
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty, () => []), null);
  assert.equal(reads.count, 0);
}));

test('the synchronous filter never reads the table itself, then knows the descendants once a snapshot landed', () => withDir(async (dir) => {
  const { reads } = boot(dir);
  const isOwn = cliSessionState.ownProcessFilter(() => [5001]);
  assert.equal(isOwn(5004), false);
  assert.equal(isOwn(5001), true);
  await cliSessionState.refreshProcessTable();
  assert.equal(reads.count, 1);
  assert.equal(isOwn(5004), true);
  assert.equal(isOwn(7004), false);
}));

test('building the synchronous filter starts a snapshot and tells descriptor listeners when it lands', () => withDir(async (dir) => {
  const { reads } = boot(dir);
  let changed = 0;
  const off = cliSessionState.onDescriptorsChanged(() => { changed++; });
  try {
    cliSessionState.ownProcessFilter(() => [5001]);
    cliSessionState.ownProcessFilter(() => [5001]);
    await cliSessionState.refreshProcessTable();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads.count, 1);
    assert.equal(changed, 1);
  } finally { off(); }
}));

test('on Linux the table is never read: the injected parent-pid reader decides', () => withDir(async (dir) => {
  writeState(dir, 5001);
  const { reads } = boot(dir, { platform: 'linux', readParentPid: (pid) => ({ 5001: 5000, 5000: 900 })[pid] || null });
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty), null);
  cliSessionState.ownProcessFilter(() => []);
  assert.equal(await cliSessionState.refreshProcessTable(), null);
  assert.equal(reads.count, 0);
}));

test('an injected parent-pid reader wins over the table on win32', () => withDir(async (dir) => {
  writeState(dir, 5004);
  const { reads } = boot(dir, { readParentPid: () => null });
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, () => [5001])).pid, 5004);
  assert.equal(reads.count, 0);
}));

test('an own descendant is not an External row in the roster', () => withDir(async (dir) => {
  boot(dir);
  await cliSessionState.refreshProcessTable();
  const descriptors = [
    { pid: 5004, sessionId: 'sess-own', kind: 'interactive', jobId: null, agent: null, name: 'mine', cwd: 'C:\\a', status: 'busy', startedAt: 1 },
    { pid: 7004, sessionId: 'sess-foreign', kind: 'interactive', jobId: null, agent: null, name: 'theirs', cwd: 'C:\\b', status: 'busy', startedAt: 2 },
  ];
  const roster = mergeRoster({ cli: null, jobs: new Map(), descriptors, isOwnPid: cliSessionState.ownProcessFilter(() => [5001]), isAttachedHere: () => false });
  assert.deepEqual(roster.map((e) => e.sessionId), ['sess-foreign']);
}));

test('parseProcessTable keeps pid/ppid pairs and skips noise', () => {
  const table = cliSessionState.parseProcessTable('ProcessId ParentProcessId\r\n4 0\r\n 140 4 \r\n\r\nx y\r\n5004 5003\r\n');
  assert.deepEqual([...table], [[4, 0], [140, 4], [5004, 5003]]);
});

test('probeProcessTable runs one bounded powershell on win32 and parses its lines', async () => {
  const calls = [];
  const exec = (exe, args, opts, cb) => { calls.push({ exe, args, opts }); cb(null, '5004 5003\r\n5003 5002\r\n'); };
  const table = await cliSessionState.probeProcessTable('win32', 1234, exec);
  assert.equal(calls.length, 1);
  assert.match(calls[0].exe, /powershell\.exe$/i);
  assert.match(calls[0].args.join(' '), /Win32_Process/);
  assert.equal(calls[0].opts.timeout, 1234);
  assert.equal(table.get(5004), 5003);
});

test('probeProcessTable runs ps on darwin and spawns nothing on Linux', async () => {
  const calls = [];
  const exec = (exe, args, opts, cb) => { calls.push({ exe, args }); cb(null, '  10     1\n  11    10\n'); };
  const table = await cliSessionState.probeProcessTable('darwin', 1000, exec);
  assert.deepEqual(calls[0].args, ['-A', '-o', 'pid=,ppid=']);
  assert.equal(table.get(11), 10);
  const none = await cliSessionState.probeProcessTable('linux', 1000, exec);
  assert.equal(none.size, 0);
  assert.equal(calls.length, 1);
});

test('probeProcessTable rejects when the command fails', async () => {
  const exec = (exe, args, opts, cb) => cb(Object.assign(new Error('killed'), { killed: true }), '');
  await assert.rejects(cliSessionState.probeProcessTable('win32', 10, exec));
});
