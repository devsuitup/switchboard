// A reused pid must not read as "live elsewhere" on Windows either -- see
// .ai/contexts/cli-session-state.md ("Live elsewhere").
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cliSessionState = require('../cli-session-state');

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const noPty = () => false;
const FT_A = '134350561856777853';
const FT_B = '134351483470939507';

function writeState(dir, pid, fields = {}) {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: `sess-${pid}`,
    cwd: 'C:\work',
    startedAt: 1790582588062,
    procStart: FT_A,
    pidDomain: 'win32:anchor',
    status: 'idle',
    ...fields,
  }), 'utf8');
}

function boot(dir, readProcStartMany, platform) {
  cliSessionState.init({
    dir,
    activeSessions: new Map(),
    log: silentLog,
    onIdle: () => {},
    isProcessAlive: () => true,
    readProcStartMany,
    platform,
    readParentPid: () => null,
  });
}

function withDir(fn) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-procstart-')));
  return Promise.resolve().then(() => fn(dir)).finally(() => {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('a live pid whose creation time equals the descriptor procStart is live elsewhere', () => withDir(async (dir) => {
  writeState(dir, 4242);
  boot(dir, async () => new Map([[4242, FT_A]]));
  const live = await cliSessionState.liveElsewhere('sess-4242', noPty);
  assert.equal(live.pid, 4242);
}));

test('a live pid created at another time than the descriptor procStart is a reused pid, not live', () => withDir(async (dir) => {
  writeState(dir, 4242);
  boot(dir, async () => new Map([[4242, FT_B]]));
  assert.equal(await cliSessionState.liveElsewhere('sess-4242', noPty), null);
}));

test('a failed or timed-out probe is undecidable: the session stays live', () => withDir(async (dir) => {
  writeState(dir, 4242);
  boot(dir, async () => { throw new Error('powershell timed out'); });
  assert.equal((await cliSessionState.liveElsewhere('sess-4242', noPty)).pid, 4242);
  boot(dir, async () => null);
  assert.equal((await cliSessionState.liveElsewhere('sess-4242', noPty)).pid, 4242);
}));

test('a pid the probe does not report is undecidable: the session stays live', () => withDir(async (dir) => {
  writeState(dir, 4242);
  boot(dir, async () => new Map());
  assert.equal((await cliSessionState.liveElsewhere('sess-4242', noPty)).pid, 4242);
}));

test('an unrecognised procStart format or pidDomain is undecidable: the session stays live', () => withDir(async (dir) => {
  writeState(dir, 4242, { procStart: 'not-a-filetime' });
  writeState(dir, 4343, { pidDomain: 'win32:something-new' });
  boot(dir, async () => new Map([[4242, FT_B], [4343, FT_B]]));
  const found = await cliSessionState.liveElsewhereMany(['sess-4242', 'sess-4343'], noPty);
  assert.deepEqual(Object.keys(found).sort(), ['sess-4242', 'sess-4343']);
}));

test('a whole batch is decided with one probe call covering every candidate pid', () => withDir(async (dir) => {
  writeState(dir, 4242);
  writeState(dir, 4343);
  writeState(dir, 4444);
  const calls = [];
  boot(dir, async (pids) => {
    calls.push([...pids].sort());
    return new Map([[4242, FT_A], [4343, FT_B], [4444, FT_A]]);
  });
  const found = await cliSessionState.liveElsewhereMany(['sess-4242', 'sess-4343', 'sess-4444'], noPty);
  assert.deepEqual(Object.keys(found).sort(), ['sess-4242', 'sess-4444']);
  assert.deepEqual(calls, [[4242, 4343, 4444]]);
}));

test('no probe is spawned when no candidate needs one', () => withDir(async (dir) => {
  writeState(dir, 4242, { procStart: null });
  writeState(dir, 4343);
  let calls = 0;
  cliSessionState.init({
    dir, activeSessions: new Map(), log: silentLog, onIdle: () => {},
    isProcessAlive: (pid) => pid === 4242,
    readProcStartMany: async () => { calls++; return new Map(); },
  });
  const found = await cliSessionState.liveElsewhereMany(['sess-4242', 'sess-4343'], noPty);
  assert.deepEqual(Object.keys(found), ['sess-4242']);
  assert.equal(calls, 0);
}));

test('candidates past the probe cap are not asked about and stay live', () => withDir(async (dir) => {
  const cap = cliSessionState.MAX_PROBE_PIDS;
  const ids = [];
  for (let i = 0; i < cap + 3; i++) { writeState(dir, 1000 + i); ids.push(`sess-${1000 + i}`); }
  let asked = 0;
  boot(dir, async (pids) => { asked = pids.length; return new Map([...pids].map((p) => [p, FT_B])); });
  const found = await cliSessionState.liveElsewhereMany(ids, noPty);
  assert.equal(asked, cap);
  assert.equal(Object.keys(found).length, 3, 'only the probed (mismatching) candidates are dropped');
}));

test('on Windows, the default probe reads the real creation time of this process', { skip: process.platform !== 'win32' }, async () => {
  const got = await cliSessionState.probeProcStartWindows([process.pid]);
  assert.match(got.get(process.pid), /^\d{17,19}$/);
});

test('on Windows, a descriptor without pidDomain is never decided: the session stays live', () => withDir(async (dir) => {
  writeState(dir, 4242, { pidDomain: undefined });
  boot(dir, async () => new Map([[4242, FT_B]]), 'win32');
  assert.equal((await cliSessionState.liveElsewhere('sess-4242', noPty)).pid, 4242);
}));

test('on Windows, a numeric procStart (precision already lost in JSON) is never decided', () => withDir(async (dir) => {
  writeState(dir, 4242, { procStart: 134350561856777853 });
  boot(dir, async () => new Map([[4242, FT_B]]), 'win32');
  assert.equal((await cliSessionState.liveElsewhere('sess-4242', noPty)).pid, 4242);
}));

test('on Windows, a win32:anchor string procStart is still decided', () => withDir(async (dir) => {
  writeState(dir, 4242);
  boot(dir, async () => new Map([[4242, FT_B]]), 'win32');
  assert.equal(await cliSessionState.liveElsewhere('sess-4242', noPty), null);
}));

function fakeExec(err, stdout) {
  return (_exe, _args, _opts, cb) => cb(err, stdout, '');
}

test('a probe whose PowerShell exits 1 keeps the valid lines it printed', async () => {
  const exitOne = Object.assign(new Error('Command failed'), { code: 1, killed: false });
  const got = await cliSessionState.probeProcStartWindows([4242, 999999], 2000,
    fakeExec(exitOne, '4242 ' + FT_A + String.fromCharCode(13, 10)));
  assert.equal(got.get(4242), FT_A);
  assert.equal(got.has(999999), false);
});

test('a probe that timed out or could not spawn rejects', async () => {
  const timedOut = Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null });
  await assert.rejects(cliSessionState.probeProcStartWindows([4242], 2000, fakeExec(timedOut, '4242 ' + FT_A)));
  const spawnError = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  await assert.rejects(cliSessionState.probeProcStartWindows([4242], 2000, fakeExec(spawnError, '')));
});
