// see .ai/contexts/cli-session-state.md ("Own descendants outside Linux")
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cliSessionState = require('../cli-session-state');
const { mergeRoster } = require('../bg-agents-roster');
const { makeDeleteSessionGuard } = require('../delete-session-guard');

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const noPty = () => false;

const ft = (n) => String(134360000000000000n + BigInt(n) * 1000n);

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-proc-table-')));
}

function writeState(dir, pid, fields = {}) {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId: 'sess-1', cwd: 'C:\\work\\proj', startedAt: 1790685077444, kind: 'interactive', status: 'idle',
    pidDomain: 'win32:anchor', procStart: ft(pid === 5004 ? 50 : 60), ...fields,
  }), 'utf8');
}

function table(rows) {
  return new Map(Object.entries(rows).map(([pid, [ppid, created]]) => [Number(pid), { ppid, created: created == null ? null : ft(created) }]));
}

const OWN_TREE = () => table({ 900: [4, 10], 5001: [900, 20], 5002: [5001, 30], 5003: [5002, 40], 5004: [5003, 50], 7003: [1, 55], 7004: [7003, 60] });
const convPty = (pids) => (id) => (id === undefined || id === 'sess-1' ? pids : []);

function boot(dir, opts = {}) {
  const clock = { t: 1_000_000 };
  const reads = { count: 0 };
  const state = { table: OWN_TREE };
  cliSessionState.init({
    dir,
    activeSessions: opts.activeSessions || new Map(),
    log: silentLog,
    onIdle: () => {},
    isProcessAlive: () => true,
    readProcStart: () => null,
    ownPid: opts.ownPid ?? 900,
    platform: opts.platform || 'win32',
    now: () => clock.t,
    readParentPid: opts.readParentPid,
    readProcessTable: opts.readProcessTable || (async () => { reads.count++; return state.table(); }),
  });
  return { clock, reads, state };
}

async function withDir(fn) {
  const dir = mkTmp();
  try { return await fn(dir); } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mapHasPty = (activeSessions) => (id) => {
  for (const [key, session] of activeSessions) if (session && !session.exited && (session.realSessionId || key) === id) return true;
  return false;
};

test('a CLI three levels under the PTY of that conversation is its own, not live elsewhere', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir);
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001])), null);
}));

test('liveElsewhereChecked and liveElsewhereMany recognise the same own descendant', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir);
  assert.deepEqual(await cliSessionState.liveElsewhereChecked('sess-1', noPty, convPty([5001])), { known: true, live: null });
  assert.deepEqual(await cliSessionState.liveElsewhereMany(['sess-1'], noPty, convPty([5001])), {});
}));

test('a CLI under another process tree is live elsewhere', () => withDir(async (dir) => {
  writeState(dir, 7004, { procStart: ft(60) });
  boot(dir);
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]))).pid, 7004);
}));

test('a CLI under this main process but under no PTY of that conversation is live elsewhere', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir);
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([]))).pid, 5004);
  assert.equal((await cliSessionState.liveElsewhereChecked('sess-1', noPty, convPty([]))).live.pid, 5004);
}));

test('a CLI started by hand in a panel shell or plain terminal stays live for every guard', () => withDir(async (dir) => {
  writeState(dir, 5004);
  const active = new Map([['panel:other', { pty: { pid: 5001 }, isPlainTerminal: true, panelFor: 'other' }]]);
  boot(dir, { activeSessions: active });
  const ptyPids = cliSessionState.makePtyPids(active);
  const hasPty = mapHasPty(active);
  assert.equal((await cliSessionState.liveElsewhere('sess-1', hasPty, ptyPids)).pid, 5004);
  assert.equal((await cliSessionState.liveElsewhereChecked('sess-1', hasPty, ptyPids)).live.pid, 5004);
  assert.equal((await cliSessionState.liveElsewhereMany(['sess-1'], hasPty, ptyPids))['sess-1'].pid, 5004);
  const guard = makeDeleteSessionGuard({
    activeSessions: active,
    bgAgents: { liveJobCheck: () => ({ known: true, job: null }) },
    cliSessionState,
    sessionHasPty: hasPty,
    ptyPids,
  });
  assert.match(await guard('sess-1'), /still running outside this window/);
}));

test('the conversation tab itself is never live elsewhere (re-attach)', () => withDir(async (dir) => {
  writeState(dir, 5004);
  const active = new Map([['sess-1', { pty: { pid: 5001 } }]]);
  boot(dir, { activeSessions: active });
  assert.equal(await cliSessionState.liveElsewhere('sess-1', mapHasPty(active), cliSessionState.makePtyPids(active)), null);
}));

test('makePtyPids lists every live PTY pid, or only those of one conversation, ids compared lowercased', () => {
  const active = new Map([
    ['Pending', { pty: { pid: 11 }, realSessionId: 'Real-One' }],
    ['panel:x', { pty: { pid: 12 }, isPlainTerminal: true }],
    ['gone', { pty: { pid: 13 }, exited: true }],
    ['nopid', { pty: {} }],
  ]);
  const ptyPids = cliSessionState.makePtyPids(active);
  assert.deepEqual(ptyPids(), [11, 12]);
  assert.deepEqual(ptyPids('real-one'), [11]);
  assert.deepEqual(ptyPids('pending'), []);
});

test('a scheduled run keeps its live conversation protected in the checked path and the delete guard', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir);
  const child = new EventEmitter();
  child.pid = 5003;
  cliSessionState.trackScheduleRun('sess-1', child, 'C:\\work\\proj');
  const checked = await cliSessionState.liveElsewhereChecked('sess-1', noPty, convPty([5003]));
  assert.equal(checked.known, true);
  assert.equal(checked.live.kind, 'schedule');
  const guard = makeDeleteSessionGuard({
    activeSessions: new Map(),
    bgAgents: { liveJobCheck: () => ({ known: true, job: null }) },
    cliSessionState,
    sessionHasPty: noPty,
    ptyPids: convPty([5003]),
  });
  assert.match(await guard('sess-1'), /still running outside this window/);
  child.emit('exit');
  assert.equal(await guard('sess-1'), null);
}));

test('includeOwnProcesses bypasses the PTY short-circuit and the exclusion', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir);
  const checked = await cliSessionState.liveElsewhereChecked('sess-1', () => true, convPty([5001]), { includeOwnProcesses: true });
  assert.equal(checked.live.pid, 5004);
}));

test('a descriptor creation time a few ticks off the CIM one (microsecond precision) still matches', () => withDir(async (dir) => {
  writeState(dir, 5004, { procStart: String(BigInt(ft(50)) + 5n) });
  boot(dir);
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001])), null);
}));

test('a leaf pid reused inside the cache window stays visible: its creation time is not the descriptor\'s', () => withDir(async (dir) => {
  writeState(dir, 5004);
  const { state, reads } = boot(dir);
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001])), null);
  state.table = () => table({ 900: [4, 10], 5001: [900, 20], 5004: [7003, 900], 7003: [4, 800] });
  fs.writeFileSync(path.join(dir, '5004.json'), JSON.stringify({ pid: 5004, sessionId: 'sess-1', kind: 'interactive', status: 'idle', pidDomain: 'win32:anchor', procStart: ft(900) }));
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]))).pid, 5004);
  assert.equal(reads.count, 1);
}));

test('a dead parent\'s number reused by a newer process breaks the chain in a fresh snapshot', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir, { readProcessTable: async () => table({ 900: [4, 10], 5001: [900, 500], 5002: [5001, 510], 5004: [5002, 50] }) });
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]))).pid, 5004);
}));

test('unknown creation times or a descriptor without a creation anchor keep the writer visible to the guards', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir, { readProcessTable: async () => new Map([[5004, 5003], [5003, 5001], [5001, 900]]) });
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]))).pid, 5004);
  cliSessionState.stop();
  writeState(dir, 5004, { pidDomain: undefined, procStart: null });
  boot(dir);
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]))).pid, 5004);
}));

test('a snapshot that fails or returns nothing keeps the writer visible and does not throw', () => withDir(async (dir) => {
  writeState(dir, 5004);
  boot(dir, { readProcessTable: async () => { throw new Error('powershell timed out'); } });
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]))).pid, 5004);
  assert.equal(cliSessionState.ownProcessFilter(() => [5001])(5001), true);
  cliSessionState.stop();
  boot(dir, { readProcessTable: async () => 'not a map' });
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]))).pid, 5004);
}));

test('one snapshot serves every check inside the cache window, and a later one reads again', () => withDir(async (dir) => {
  writeState(dir, 5004);
  const { clock, reads } = boot(dir);
  await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]));
  await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]));
  await cliSessionState.liveElsewhereMany(['sess-1'], noPty, convPty([5001]));
  assert.equal(reads.count, 1);
  clock.t += cliSessionState.PROCESS_TABLE_TTL_MS + 1;
  await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]));
  assert.equal(reads.count, 2);
}));

test('concurrent checks share one in-flight snapshot', () => withDir(async (dir) => {
  writeState(dir, 5004);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  boot(dir, { readProcessTable: async () => { calls++; await gate; return OWN_TREE(); } });
  const pending = [
    cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001])),
    cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001])),
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
  await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]));
  await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]));
  assert.equal(calls, 1);
}));

test('no snapshot is taken without a live descriptor for the asked session, or without a PTY for that conversation', () => withDir(async (dir) => {
  writeState(dir, 5004, { sessionId: 'other' });
  const { reads } = boot(dir);
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001])), null);
  cliSessionState.stop();
  writeState(dir, 5004);
  const second = boot(dir);
  await cliSessionState.liveElsewhere('sess-1', noPty, convPty([]));
  assert.equal(reads.count + second.reads.count, 0);
}));

test('the synchronous roster filter never reads the table itself, then knows the descendants once a snapshot landed', () => withDir(async (dir) => {
  const { reads } = boot(dir);
  const isOwn = cliSessionState.ownProcessFilter(() => [5001]);
  assert.equal(isOwn(5004), false);
  assert.equal(isOwn(5001), true);
  await cliSessionState.refreshProcessTable();
  assert.equal(reads.count, 1);
  assert.equal(isOwn(5004), true);
  assert.equal(isOwn(7004), false);
}));

test('the roster rule stays broad: a descendant of this main process is own for visibility', () => withDir(async (dir) => {
  boot(dir);
  await cliSessionState.refreshProcessTable();
  assert.equal(cliSessionState.ownProcessFilter(() => [])(5004), true);
}));

test('the roster drops a chain whose parent is newer than its child', () => withDir(async (dir) => {
  boot(dir, { readProcessTable: async () => table({ 900: [4, 10], 5001: [900, 500], 5004: [5001, 50] }) });
  await cliSessionState.refreshProcessTable();
  assert.equal(cliSessionState.ownProcessFilter(() => [])(5004), false);
}));

test('a sync-first snapshot tells descriptor listeners once when it lands', () => withDir(async (dir) => {
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

test('an async-first snapshot tells descriptor listeners once, and a roster filter built meanwhile sees it', () => withDir(async (dir) => {
  writeState(dir, 5004);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  boot(dir, { readProcessTable: async () => { await gate; return OWN_TREE(); } });
  let changed = 0;
  const off = cliSessionState.onDescriptorsChanged(() => { changed++; });
  try {
    const check = cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]));
    await new Promise((resolve) => setImmediate(resolve));
    const isOwn = cliSessionState.ownProcessFilter(() => [5001]);
    assert.equal(isOwn(5004), false);
    release();
    await check;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(changed, 1);
    assert.equal(isOwn(5004), true);
  } finally { off(); }
}));

test('on Linux the table is never read: the injected parent-pid reader decides', () => withDir(async (dir) => {
  writeState(dir, 5001);
  const parents = { 5001: 5000, 5000: 900 };
  const { reads } = boot(dir, { platform: 'linux', readParentPid: (pid) => parents[pid] || null });
  assert.equal(await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5000])), null);
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([]))).pid, 5001);
  cliSessionState.ownProcessFilter(() => []);
  assert.equal(await cliSessionState.refreshProcessTable(), null);
  assert.equal(reads.count, 0);
}));

test('an injected parent-pid reader wins over the table on win32', () => withDir(async (dir) => {
  writeState(dir, 5004);
  const { reads } = boot(dir, { readParentPid: () => null });
  assert.equal((await cliSessionState.liveElsewhere('sess-1', noPty, convPty([5001]))).pid, 5004);
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

test('parseProcessTable keeps pid, ppid and creation time, and skips noise', () => {
  const t = cliSessionState.parseProcessTable('ProcessId\r\n4 0\r\n 140 4 134360000000000000 \r\n\r\nx y\r\n5004 5003 134360000050000000\r\n');
  assert.deepEqual([...t.keys()], [4, 140, 5004]);
  assert.deepEqual(t.get(4), { ppid: 0, created: null });
  assert.deepEqual(t.get(5004), { ppid: 5003, created: 134360000050000000n });
});

test('parseProcessTable reads the lstart column ps prints on macOS', () => {
  const t = cliSessionState.parseProcessTable('  10     1 Thu Oct  9 10:00:00 2026\n  11    10 Thu Oct  9 10:00:05 2026\n');
  assert.equal(t.get(11).ppid, 10);
  assert.equal(t.get(11).created - t.get(10).created, 5000n);
});

test('probeProcessTable runs one bounded powershell on win32 and asks for creation dates', async () => {
  const calls = [];
  const exec = (exe, args, opts, cb) => { calls.push({ exe, args, opts }); cb(null, '5004 5003 134360000050000000\r\n5003 5002 134360000040000000\r\n'); };
  const t = await cliSessionState.probeProcessTable('win32', 1234, exec);
  assert.equal(calls.length, 1);
  assert.match(calls[0].exe, /powershell\.exe$/i);
  assert.match(calls[0].args.join(' '), /Win32_Process/);
  assert.match(calls[0].args.join(' '), /CreationDate/);
  assert.equal(calls[0].opts.timeout, 1234);
  assert.equal(t.get(5004).ppid, 5003);
});

test('probeProcessTable runs ps with lstart on darwin and spawns nothing on Linux', async () => {
  const calls = [];
  const exec = (exe, args, opts, cb) => { calls.push({ exe, args }); cb(null, '  10     1 Thu Oct  9 10:00:00 2026\n'); };
  const t = await cliSessionState.probeProcessTable('darwin', 1000, exec);
  assert.deepEqual(calls[0].args, ['-A', '-o', 'pid=,ppid=,lstart=']);
  assert.equal(t.get(10).ppid, 1);
  assert.equal((await cliSessionState.probeProcessTable('linux', 1000, exec)).size, 0);
  assert.equal(calls.length, 1);
});

test('probeProcessTable rejects when the command fails', async () => {
  const exec = (exe, args, opts, cb) => cb(Object.assign(new Error('killed'), { killed: true }), '');
  await assert.rejects(cliSessionState.probeProcessTable('win32', 10, exec));
});
