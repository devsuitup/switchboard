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
  return (id, fields = {}) => {
    fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, id, 'state.json'), JSON.stringify({ state: 'working', sessionId: SID, ...fields }));
  };
}

test('B lookup reads saved attachJobId directly and refuses a different conversation', t => {
  const write = fixture(t);
  write('aaaaaaaa'); write('bbbbbbbb');
  assert.equal(typeof bg.findRestoreJob, 'function', 'fresh restore lookup exists');
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa').job.id, 'aaaaaaaa');
  write('aaaaaaaa', { sessionId: OTHER });
  assert.equal(bg.findRestoreJob(SID, 'aaaaaaaa').known, false);
  assert.equal(bg.findRestoreJob(SID, '../bbbbbbbb').known, false);
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
  write('cccccccc', { state: 'future-state', sessionId: null });
  assert.equal(bg.findRestoreJob(SID).known, false, 'unknown records cannot hide another matching job');
});

for (const state of ['done', 'failed', 'stopped']) {
  test(`B restore requests S1a worker classification for ${state} as well`, async t => {
    const write = fixture(t);
    write('aaaaaaaa', { state });
    const result = await bg.conversationCheck('aaaaaaaa', { workerLiveness: 'all' });
    assert.equal(result.workerLiveness, 'dead');
  });
}
