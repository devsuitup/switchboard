'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bg = require('../bg-agents');
const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-restore-785-'));
  const jobsDir = path.join(home, 'jobs');
  fs.mkdirSync(jobsDir);
  bg.init({ jobsDir, homeDir: home, cliSessionState: { readAllDescriptors: () => [],
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
    require('../bg-agents-ipc').init({
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, bgAgents: bg,
      getMainWindow: () => null, log: { warn() {} }, activeSessions: new Map(),
      getSetting: () => ({ openWorkingSet: [{ sessionId: SID, bg: true, attachJobId: 'aaaaaaaa' }] }),
      sessionHasPty: () => false, ptyPids: () => [],
      cliSessionState: { readAllDescriptors: () => descriptors, onDescriptorsChanged: () => () => {},
        liveElsewhereChecked: async () => ({ known: true, live: null }) },
    });
    for (const verb of ['rm', 'respawn']) {
      const ordinary = await handlers.get('bg-agent-verb')({}, verb, 'aaaaaaaa');
      assert.equal(ordinary.ok, false, `GUARD ordinary ${verb} retains no-evidence refusal`);
    }
    assert.deepEqual(calls, []);
    const result = await handlers.get('restore-background-job')({}, SID);
    assert.deepEqual(calls, [['respawn', 'aaaaaaaa']]);
    assert.equal(result.action, 'attach');
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
