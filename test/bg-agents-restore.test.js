'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bg = require('../src/main/bg-agents/bg-agents');
const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-restore-785-'));
  const jobsDir = path.join(home, 'jobs');
  fs.mkdirSync(jobsDir);
  fs.writeFileSync(path.join(home, SID + '.jsonl'), JSON.stringify({ type: 'user', sessionId: SID }) + '\n');
  bg.init({ jobsDir, homeDir: home, resolveTranscriptPath: id => path.join(home, id + '.jsonl'), cliSessionState: { readAllDescriptors: () => [],
    refreshProcessTable: async () => {}, readWorkerProcessEvidence: () => ({ processTableFresh: true, tableEntry: () => undefined }) } });
  fs.mkdirSync(path.join(home, 'daemon'));
  fs.writeFileSync(path.join(home, 'daemon', 'roster.json'), JSON.stringify({ proto: 1, updatedAt: '2000-01-01T00:00:00Z', workers: {} }));
  t.after(() => { bg.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const write = (id, fields = {}) => {
    fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, id, 'state.json'), JSON.stringify({ state: 'working', sessionId: SID, ...fields }));
  };
  write.jobsDir = jobsDir;
  return write;
}

for (const state of ['done', 'failed', 'stopped']) {
  for (const liveness of ['unknown', 'dead', 'live']) {
    const expected = liveness === 'live' || liveness === 'dead' && state !== 'stopped' ? 'attach'
      : state === 'done' && liveness === 'unknown' ? 'retire' : 'refuse';
    test(`1065 ${state}/${liveness} without pending work returns ${expected}`, async t => {
      const write = fixture(t);
      write('aaaaaaaa', { state, updatedAt: '2026-11-04T06:28:00Z' });
      const handlers = new Map();
      const calls = [];
      let checked = 0;
      t.mock.method(bg, 'conversationCheck', async () => {
        checked++;
        return { known: true, state, workerLiveness: liveness, sessionIds: [SID] };
      });
      t.mock.method(bg, 'runVerb', async (...args) => { calls.push(args); return { ok: true }; });
      require('../src/main/bg-agents/bg-agents-ipc').init({
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, bgAgents: bg,
        getMainWindow: () => null, log: { warn() {} }, activeSessions: new Map(),
        getSetting: () => ({ openWorkingSet: [{ sessionId: SID, bg: true, attachJobId: 'aaaaaaaa' }] }),
        sessionHasPty: () => false, ptyPids: () => [],
        cliSessionState: { readAllDescriptors: () => [{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: SID }], onDescriptorsChanged: () => () => {},
          liveElsewhereChecked: async () => ({ known: true, live: null }) },
      });
      const result = await handlers.get('restore-background-job')({}, SID);
      assert.equal(result.action, expected, `${state}/${liveness} must preserve worker recovery`);
      assert.ok(checked > 0, 'worker classification must precede retirement');
      assert.deepEqual(calls, liveness === 'dead' && state !== 'stopped' ? [['respawn', 'aaaaaaaa']] : []);
    });
  }
}

test('1065fix2 async restore lookups share a bounded jobs snapshot', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const write = fixture(t);
  write('aaaaaaaa', { sessionId: SID });
  write('bbbbbbbb', { sessionId: OTHER });
  const readdir = fs.readdirSync;
  const read = fs.readFileSync;
  let scans = 0;
  const reads = new Map();
  t.mock.method(fs, 'readdirSync', function(file, ...args) {
    if (file === write.jobsDir) scans++;
    return readdir.call(this, file, ...args);
  });
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (String(file).startsWith(write.jobsDir) && String(file).endsWith('state.json')) reads.set(String(file), (reads.get(String(file)) || 0) + 1);
    return read.call(this, file, ...args);
  });
  t.mock.method(bg, 'conversationCheck', async () => ({ known: true, state: 'working', workerLiveness: 'unknown' }));
  const handlers = new Map();
  const saved = [{ sessionId: SID, bg: true, attachJobId: 'aaaaaaaa' }, { sessionId: OTHER, bg: true, attachJobId: 'bbbbbbbb' }];
  require('../src/main/bg-agents/bg-agents-ipc').init({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, bgAgents: bg,
    getMainWindow: () => null, log: { warn() {} }, getSetting: async () => {
      await new Promise(resolve => setImmediate(resolve));
      return { openWorkingSet: saved };
    },
  });
  const restore = handlers.get('restore-background-job');
  const results = [await restore({}, SID), await restore({}, OTHER)];
  assert.deepEqual(results.map(result => result.action), ['refuse', 'refuse']);
  assert.equal(scans, 1, 'async saved entries share one directory scan within the time window');
  assert.deepEqual([...reads.values()], [1, 1], 'each state is read once within the time window');
  t.mock.timers.tick(1001);
  write('aaaaaaaa', { state: 'done', sessionId: SID, updatedAt: '2026-11-04T06:28:00Z' });
  await restore({}, SID);
  assert.equal(scans, 2, 'an expired snapshot must refresh the directory');
  assert.deepEqual([...reads.values()], [2, 2], 'an expired snapshot must read fresh job records');
});

test('1065fix2 a resumeSessionId-only candidate does not supersede a saved job', t => {
  const write = fixture(t);
  write('aaaaaaaa', { updatedAt: '2026-11-04T06:28:00Z' });
  write('bbbbbbbb', { updatedAt: '2026-11-10T06:28:00Z', sessionId: undefined, resumeSessionId: SID });
  const lookup = bg.findRestoreJob(SID, 'aaaaaaaa', { findNewer: true });
  assert.equal(lookup.known, true);
  assert.equal(lookup.supersededBy, undefined, 'a resume origin alone must not supersede the saved working job');
});

test('1065fix2 a shared restore snapshot is keyed by jobs directory', t => {
  const first = fixture(t);
  first('aaaaaaaa', { updatedAt: '2026-11-04T06:28:00Z' });
  first('bbbbbbbb', { updatedAt: '2026-11-10T06:28:00Z', sessionId: OTHER });
  const restoreScan = { records: new Map() };
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa', { findNewer: true, restoreScan }).supersededBy, undefined);
  const second = fixture(t);
  second('aaaaaaaa', { updatedAt: '2026-11-04T06:28:00Z' });
  second('bbbbbbbb', { updatedAt: '2026-11-10T06:28:00Z', sessionId: SID });
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa', { findNewer: true, restoreScan }).supersededBy,
    'bbbbbbbb', 'a different jobs directory must supply fresh records');
});

test('1065 a newer job must match the conversation before superseding a saved job', t => {
  const write = fixture(t);
  write('aaaaaaaa', { updatedAt: '2026-11-04T06:28:00Z' });
  write('bbbbbbbb', { updatedAt: '2026-11-10T06:28:00Z', sessionId: OTHER });
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa', { findNewer: true }).supersededBy, undefined);
  write('bbbbbbbb', { updatedAt: '2026-11-10T06:28:00Z', sessionId: OTHER, resumeSessionId: SID });
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa', { findNewer: true }).supersededBy, undefined, 'fork origin must not supersede its parent conversation');
  write('bbbbbbbb', { updatedAt: '2026-11-10T06:28:00Z', sessionId: SID });
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa', { findNewer: true }).supersededBy, 'bbbbbbbb');
  write('bbbbbbbb', { updatedAt: '2026-11-10T06:28:00Z', sessionId: OTHER, linkScanPath: '/fixture/' + SID + '.jsonl' });
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa', { findNewer: true }).supersededBy, 'bbbbbbbb');
});

for (const fields of [
  { inFlight: { tasks: 1, kinds: ['local_agent'] } },
  { inFlight: { tasks: 0, kinds: [], queued: 1 } },
  { fan: [{ id: 'pending', kind: 'agent', startedAt: 1 }] },
  { updatedAt: null },
]) {
  test(`1065 pending or unreadable task evidence stays held: ${JSON.stringify(fields)}`, async t => {
    const write = fixture(t);
    write('aaaaaaaa', { state: 'done', updatedAt: '2026-11-04T06:28:00Z', ...fields });
    const handlers = new Map();
    t.mock.method(bg, 'conversationCheck', async () => ({ known: true, state: 'done', workerLiveness: 'unknown' }));
    require('../src/main/bg-agents/bg-agents-ipc').init({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, bgAgents: bg,
      getMainWindow: () => null, log: { warn() {} },
      getSetting: () => ({ openWorkingSet: [{ sessionId: SID, bg: true, attachJobId: 'aaaaaaaa' }] }),
    });
    assert.equal((await handlers.get('restore-background-job')({}, SID)).action, 'refuse');
  });
}

for (const [state, liveness, action] of [['done', 'unknown', 'retire'], ['working', 'dead', 'retire'], ['working', 'unknown', 'retire'], ['done', 'live', 'attach']]) {
  test(`1065 superseded ${state}/${liveness} returns ${action} without respawn`, async t => {
    const write = fixture(t);
    write('aaaaaaaa', { state, updatedAt: '2026-11-04T06:28:00Z', inFlight: { tasks: 1, kinds: ['local_agent'] } });
    write('bbbbbbbb', { updatedAt: '2026-11-10T06:28:00Z', resumeSessionId: SID });
    const handlers = new Map();
    const calls = [];
    t.mock.method(bg, 'conversationCheck', async () => ({ known: true, state, workerLiveness: liveness }));
    t.mock.method(bg, 'runVerb', async (...args) => { calls.push(args); return { ok: true }; });
    require('../src/main/bg-agents/bg-agents-ipc').init({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, bgAgents: bg,
      getMainWindow: () => null, log: { warn() {} },
      getSetting: () => ({ openWorkingSet: [{ sessionId: SID, bg: true, attachJobId: 'aaaaaaaa' }] }),
      cliSessionState: { readAllDescriptors: () => [{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: SID }], onDescriptorsChanged: () => () => {} },
    });
    assert.equal((await handlers.get('restore-background-job')({}, SID)).action, action);
    assert.deepEqual(calls, []);
  });
}

test('B lookup reads saved attachJobId directly and refuses a different conversation', t => {
  const write = fixture(t);
  write('aaaaaaaa'); write('bbbbbbbb');
  assert.equal(typeof bg.findRestoreJob, 'function', 'fresh restore lookup exists');
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa').job.id, 'aaaaaaaa');
  write('aaaaaaaa', { sessionId: OTHER });
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa').known, false);
  assert.equal(bg.findRestoreJob(SID, '../bbbbbbbb').job?.id, 'bbbbbbbb', 'invalid saved id falls back to the matching conversation');
  assert.equal(bg.findRestoreJob(SID, 'cccccccc').known, false);
});

test('B legacy lookup matches either identity field and refuses ambiguous or unreadable records', t => {
  const write = fixture(t);
  assert.equal(typeof bg.findRestoreJob, 'function', 'fresh restore lookup exists');
  assert.equal(bg.findRestoreJob(SID).known, false);
  write('aaaaaaaa', { sessionId: OTHER, resumeSessionId: SID });
  assert.equal(bg.findRestoreJob(SID.toUpperCase()).job.id, 'aaaaaaaa');
  write('bbbbbbbb');
  const ambiguous = bg.findRestoreJob(SID);
  assert.equal(ambiguous.known, false);
  assert.match(ambiguous.reason, /aaaaaaaa.*bbbbbbbb/);
  write('bbbbbbbb', { sessionId: OTHER });
  write('cccccccc', { state: 'future-state', sessionId: SID });
  assert.equal(bg.findRestoreJob(SID).known, false, 'unknown records cannot hide another matching job');
});

test('S1e explicit saved id stays unknown when jobsDir is a file', t => {
  const write = fixture(t);
  fs.rmdirSync(write.jobsDir);
  fs.writeFileSync(write.jobsDir, 'not a directory');
  const result = bg.findRestoreJob(SID, 'aaaaaaaa');
  assert.equal(result.known, false);
  assert.equal(result.missing, undefined, 'a stat error cannot prove the saved job is missing');
  assert.match(result.reason, /cannot identify/);
});

for (const savedId of [null, '', '../invalid', 42]) {
  test(`C2/C4 absent or invalid saved job id ${savedId} falls back to legacy identity`, t => {
    const write = fixture(t);
    write('aaaaaaaa');
    assert.equal(bg.findRestoreJob(SID, savedId).job?.id, 'aaaaaaaa');
  });
}

for (const bad of [{ state: 'future-state', sessionId: OTHER }, null]) {
  test(`C6 legacy restore skips unrelated ${bad ? 'unknown-state' : 'missing-state'} record`, t => {
    const write = fixture(t);
    write('aaaaaaaa');
    write('bbbbbbbb', bad || {});
    if (!bad) {
      fs.unlinkSync(path.join(write.jobsDir, 'bbbbbbbb', 'state.json'));
    }
    assert.equal(bg.findRestoreJob(SID).job?.id, 'aaaaaaaa');
  });
}

test('C6 GUARD unreadable explicit saved id refuses despite another good match', t => {
  const write = fixture(t);
  write('aaaaaaaa');
  write('bbbbbbbb', { state: 'future-state', sessionId: OTHER });
  assert.equal(bg.findRestoreJob(SID, 'bbbbbbbb').known, false);
});

for (const unreadable of ['truncated', 'missing-state']) {
  test(`M-B legacy ${unreadable} record stays unknown rather than missing`, t => {
    const write = fixture(t);
    write('aaaaaaaa');
    const state = path.join(write.jobsDir, 'aaaaaaaa', 'state.json');
    if (unreadable === 'truncated') fs.writeFileSync(state, `{"state":"working","sessionId":"${SID}"`);
    else fs.unlinkSync(state);
    const result = bg.findRestoreJob(SID);
    assert.equal(result.known, false);
    assert.equal(result.missing, undefined, 'an unreadable record cannot prove absence');
    assert.match(result.reason, /unreadable|cannot read/i);
  });
}

test('M-B GUARD all readable unrelated records prove the legacy job is missing', t => {
  const write = fixture(t);
  write('aaaaaaaa', { sessionId: OTHER });
  write('bbbbbbbb', { sessionId: OTHER });
  assert.equal(bg.findRestoreJob(SID).missing, true);
});

test('M-B GUARD a matching readable record wins over an unrelated truncated record', t => {
  const write = fixture(t);
  write('aaaaaaaa');
  write('bbbbbbbb');
  fs.writeFileSync(path.join(write.jobsDir, 'bbbbbbbb', 'state.json'), '{"state":');
  assert.equal(bg.findRestoreJob(SID).job?.id, 'aaaaaaaa');
});

test('C4 GUARD missing record is explicitly distinguished from ambiguity and unreadability', t => {
  const write = fixture(t);
  assert.equal(bg.findRestoreJob(SID).missing, true);
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa').missing, true);
  write('aaaaaaaa', { state: 'future-state' });
  assert.equal(bg.findRestoreJob(SID).missing, undefined);
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa').missing, undefined);
});

test('C6 GUARD unknown-state resume identity matching the saved conversation refuses', t => {
  const write = fixture(t);
  write('aaaaaaaa');
  write('bbbbbbbb', { state: 'future-state', sessionId: OTHER, resumeSessionId: SID });
  assert.equal(bg.findRestoreJob(SID).known, false);
});

test('C1 GUARD evidence for one job cannot hide another hosted job of the conversation', t => {
  const write = fixture(t);
  write('aaaaaaaa'); write('bbbbbbbb');
  assert.equal(bg.liveJobCheck(SID, { workerLiveness: new Map([['aaaaaaaa', 'dead']]) }).job?.id, 'bbbbbbbb');
});

for (const state of ['working', 'blocked']) {
  test(`C1 integration restores dead ${state} through real conversation and deletion guards`, async t => {
    const write = fixture(t);
    write('aaaaaaaa', { state });
    assert.equal((await bg.conversationCheck('aaaaaaaa', { workerLiveness: 'all' })).workerLiveness, 'dead');
    assert.equal(bg.liveJobCheck(SID).job?.id, 'aaaaaaaa', 'GUARD no-evidence lookup stays conservative');
    const handlers = new Map();
    const descriptors = [];
    const calls = [];
    t.mock.method(bg, 'runVerb', async (...args) => {
      calls.push(args);
      descriptors.push({ kind: 'bg', jobId: 'aaaaaaaa', sessionId: SID });
      return { ok: true };
    });
    require('../src/main/bg-agents/bg-agents-ipc').init({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, bgAgents: bg,
      getMainWindow: () => null, log: { warn() {} }, activeSessions: new Map(),
      getSetting: () => ({ openWorkingSet: [{ sessionId: SID, bg: true, attachJobId: 'aaaaaaaa' }] }),
      sessionHasPty: () => false, ptyPids: () => [],
      cliSessionState: { readAllDescriptors: () => descriptors, onDescriptorsChanged: () => () => {},
        liveElsewhereChecked: async () => ({ known: true, live: null }) },
    });
    const ordinary = await handlers.get('bg-agent-verb')({}, 'rm', 'aaaaaaaa');
    assert.equal(ordinary.ok, false, 'GUARD ordinary rm retains no-evidence refusal');
    assert.deepEqual(calls, []);
    const result = await handlers.get('restore-background-job')({}, SID);
    assert.deepEqual(calls, state === 'working' ? [['respawn', 'aaaaaaaa']] : []);
    assert.equal(result.action, state === 'working' ? 'attach' : 'refuse');
    if (state === 'blocked') assert.equal(result.recovery, 'respawn');
  });
}

for (const state of ['done', 'failed', 'stopped']) {
  test(`B restore requests S1a worker classification for ${state} as well`, async t => {
    const write = fixture(t);
    write('aaaaaaaa', { state });
    const result = await bg.conversationCheck('aaaaaaaa', { workerLiveness: 'all' });
    assert.equal(result.workerLiveness, 'dead');
  });
}


test('S2-T8 resumeTarget uses validated raw identity rather than link scan identity', t => {
  const write = fixture(t);
  for (const [fields, target] of [
    [{ sessionId: SID, resumeSessionId: 'ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF' }, 'abcdefab-abcd-4abc-8abc-abcdefabcdef'],
    [{ sessionId: SID.toUpperCase() }, SID],
    [{ sessionId: SID, resumeSessionId: OTHER, linkScanPath: '/fixture/' + SID + '.jsonl' }, OTHER],
    [{ sessionId: SID, resumeSessionId: 'not-a-uuid' }, null],
    [{ sessionId: SID, resumeSessionId: '' }, null],
  ]) {
    write('aaaaaaaa', fields);
    assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa').job.resumeTarget, target);
  }
});

test('S2c GUARD default lookup keeps unrelated invalid raw identity despite a matching link-scan id', t => {
  const write = fixture(t);
  write('aaaaaaaa');
  write('bbbbbbbb', { state: 'future-state', sessionId: OTHER, linkScanPath: '/fixture/' + SID + '.jsonl' });
  assert.equal(bg.findRestoreJob(SID).job?.id, 'aaaaaaaa');
  assert.equal(bg.findRestoreJob(SID, undefined, { ignoreUnrelatedInvalid: true }).known, false);
});
