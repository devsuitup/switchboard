'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bg = require('../src/main/bg-agents/bg-agents');
const { init } = require('../src/main/bg-agents/bg-agents-ipc');
const { sendToBackground, createContinuationReader } = require('../src/main/bg-agents/bg-handoff');
const { createComposerState } = require('../src/main/terminals/composer-state');

const SID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const PRIOR = '33333333-3333-4333-8333-333333333333';
const line = value => JSON.stringify(value) + '\n';
const link = id => line({ type: 'continued-in', sessionId: SID, continuedInSessionId: id });

function fixture(t, state = 'stopped') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-1020-'));
  const file = path.join(root, SID + '.jsonl');
  fs.writeFileSync(file, line({ type: 'user', sessionId: SID, message: { role: 'user', content: 'hello' } }));
  const jobsDir = path.join(root, 'jobs');
  fs.mkdirSync(jobsDir);
  fs.mkdirSync(path.join(root, 'daemon'));
  fs.writeFileSync(path.join(root, 'daemon', 'roster.json'), line({ proto: 1, updatedAt: '2000-01-01T00:00:00Z', workers: {} }));
  const writeJob = (id, sessionId, jobState) => {
    fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, id, 'state.json'), line({ state: jobState, sessionId, resumeSessionId: sessionId, linkScanPath: path.join(root, sessionId + '.jsonl') }));
  };
  writeJob('aaaaaaaa', SID, state);
  const descriptors = [];
  const cli = { readAllDescriptors: () => descriptors, onDescriptorsChanged: () => () => {},
    liveElsewhereChecked: async () => ({ known: true, live: null }),
    refreshProcessTable: async () => {}, readWorkerProcessEvidence: () => ({ processTableFresh: true, tableEntry: () => undefined }) };
  bg.init({ jobsDir, homeDir: root, cliSessionState: cli, resolveTranscriptPath: id => path.join(root, id + '.jsonl') });
  t.after(() => { bg.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const fork = () => {
    fs.appendFileSync(file, line({ type: 'system', subtype: 'session_cron_carry', sessionId: SID }) + link(NEXT));
    fs.writeFileSync(path.join(root, NEXT + '.jsonl'), line({ type: 'user', sessionId: NEXT }));
    writeJob('bbbbbbbb', NEXT, 'working');
    descriptors.push({ kind: 'bg', sessionId: NEXT, jobId: 'bbbbbbbb', cwd: root });
  };
  const calls = [], handlers = new Map(), delivery = { autoAttach: false };
  init({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    bgAgents: { ...bg, runVerb: async (...args) => { calls.push(args); if (delivery.autoAttach) descriptors.push({ kind: 'bg', jobId: 'aaaaaaaa', sessionId: bg.findRestoreJob(SID, 'aaaaaaaa').job.sessionId }); return { ok: true }; } },
    cliSessionState: cli, getMainWindow: () => null, log: { warn() {} }, activeSessions: new Map(),
    sessionHasPty: () => false, ptyPids: () => [], getSetting: () => ({ openWorkingSet: [{ sessionId: SID, bg: true, attachJobId: 'aaaaaaaa' }] }) });
  return { root, file, descriptors, fork, calls, handlers, writeJob, cli, delivery };
}

function handoff(h, { exitAt = 600, forkAt = Infinity, uncertain = false, descriptor = true, prior = false } = {}) {
  let now = 0, forked = false;
  const session = { kind: 'local-pty', realSessionId: SID, cwd: h.root, composerState: createComposerState() };
  if (prior) fs.appendFileSync(h.file, link(PRIOR));
  const read = createContinuationReader(h.file, SID);
  const advance = async ms => {
    now += ms;
    if (!forked && now >= forkAt) { h.fork(); forked = true; if (!descriptor) h.descriptors.length = 0; }
    if (now >= exitAt) session.exited = true;
  };
  return sendToBackground(SID, {
    getSession: () => session, getStatus: () => 'idle', write: () => true, tapOutput: () => () => {},
    readContinuationIds: () => uncertain && session.exited ? null : read(), readDescriptors: () => h.descriptors,
    now: () => now, delay: advance, waitForChange: advance,
    decideRoute: async () => ({ route: 'respawn', job: { id: 'aaaaaaaa' } }),
    respawnJob: async () => { h.calls.push(['respawn']); return { ok: true, attached: true }; },
  }).then(result => ({ result, now }));
}

for (const [label, exitAt, forkAt] of [['before exit detection', 6500, 5800], ['just after exit', 600, 5800]]) {
  test('1020 handoff adopts fork ' + label, async t => {
    const h = fixture(t);
    const { result } = await handoff(h, { exitAt, forkAt, prior: true });
    assert.deepEqual(h.calls, [], 'a CLI continuation must prevent a second writer');
    assert.equal(result.ok, true);
    assert.equal(result.jobId, 'bbbbbbbb');
    assert.equal(result.sessionId, NEXT);
    assert.notEqual(result.respawned, true);
  });
}

for (const options of [{ uncertain: true }, { forkAt: 5800, descriptor: false }]) {
  test('1020 handoff refuses uncertain exit ' + JSON.stringify(options), async t => {
    const h = fixture(t);
    const { result } = await handoff(h, options);
    assert.deepEqual(h.calls, [], 'uncertainty must never create a writer');
    assert.equal(result.ok, false);
    assert.match(result.error, /not.*respawn|nothing.*relaunch|not.*relaunch/i);
  });
}

test('1020 handoff waits a bounded grace then respawns with a readable unchanged transcript', async t => {
  const h = fixture(t);
  const { result, now } = await handoff(h, { prior: true });
  assert.ok(now >= 10600 && now <= 15600, 'allow the measured 5.5 second fork plus margin');
  assert.equal(result.respawned, true);
  assert.deepEqual(h.calls, [['respawn']]);
});

for (const channel of ['check-bg-agent-verb', 'bg-agent-verb']) {
  test('1020 ' + channel + ' refuses a live continuation', async t => {
    const h = fixture(t);
    h.fork();
    const result = await h.handlers.get(channel)({}, 'respawn', 'aaaaaaaa');
    assert.equal(result.ok, false, 'the old id cannot respawn while its continuation runs');
    assert.match(result.error, /bbbbbbbb|continuation/i);
    assert.deepEqual(h.calls, []);
  });
}

test('1020 manual respawn also checks the raw resume target when the job transcript differs', async t => {
  const h = fixture(t);
  h.fork();
  fs.writeFileSync(h.file, line({ type: 'user', sessionId: SID }));
  fs.writeFileSync(path.join(h.root, PRIOR + '.jsonl'), line({ type: 'continued-in', sessionId: PRIOR, continuedInSessionId: NEXT }));
  fs.writeFileSync(path.join(h.root, 'jobs', 'aaaaaaaa', 'state.json'), line({ state: 'stopped', sessionId: SID, resumeSessionId: PRIOR, linkScanPath: h.file }));
  const result = await h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
  assert.deepEqual(h.calls, [], 'the resume target continuation must prevent a second writer');
  assert.equal(result.ok, false);
});

test('1020 restore refuses a live continuation of a dead working job', async t => {
  const h = fixture(t, 'working');
  h.fork();
  const result = await h.handlers.get('restore-background-job')({}, SID);
  assert.deepEqual(h.calls, [], 'restore cannot create a second writer');
  assert.equal(result.action, 'refuse');
});

for (const state of ['blocked', 'failed']) {
  test('1020 dead ' + state + ' needs explicit Respawn', async t => {
    const h = fixture(t, state);
    const result = await h.handlers.get('restore-background-job')({}, SID);
    assert.deepEqual(h.calls, [], 'non-resumable or ambiguous states stay stopped');
    assert.equal(result.action, 'refuse');
    assert.equal(result.recovery, 'respawn');
  });
}

for (const state of ['working', 'running', 'done']) {
  test('1020fix restore respawns and attaches dead ' + state, async t => {
    const h = fixture(t, state);
    h.delivery.autoAttach = true;
    const result = await h.handlers.get('restore-background-job')({}, SID);
    assert.equal(result.action, 'attach', 'restore must retain #796 recovery');
    assert.deepEqual(h.calls, [['respawn', 'aaaaaaaa']]);
  });
}

for (const state of ['blocked', 'working', 'running', 'done', 'failed', 'stopped']) {
  test('1020fix dead ' + state + ' can use manual Respawn after restore', async t => {
    const h = fixture(t, state);
    if (state === 'blocked') {
      const notice = await h.handlers.get('restore-background-job')({}, SID);
      assert.equal(notice.recovery, 'respawn');
      assert.deepEqual(h.calls, []);
    }
    assert.equal((await h.handlers.get('check-bg-agent-verb')({}, 'respawn', 'aaaaaaaa')).ok, true, 'Respawn preview must accept dead workers');
    assert.equal((await h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa')).ok, true, 'the notice recovery must reach respawn');
    assert.deepEqual(h.calls, [['respawn', 'aaaaaaaa']]);
  });
}

for (const tail of ['{"type":"assistant","mess', '{"type":"continued-in","sessionId":"' + SID + '","continuedInSessionId":"']) {
  test('1020fix torn final line permits manual recovery ' + tail, async t => {
    const h = fixture(t, 'done');
    fs.appendFileSync(h.file, tail);
    assert.deepEqual(await createContinuationReader(h.file, SID)(), [], 'an incomplete final record cannot invalidate sealed evidence');
    assert.equal((await h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa')).ok, true);
    assert.deepEqual(h.calls, [['respawn', 'aaaaaaaa']]);
  });
}

for (const missing of ['resolved-path', 'dangling-link']) {
  test('1020fix deleted continuation permits recovery ' + missing, async t => {
    const h = fixture(t);
    fs.appendFileSync(h.file, link(NEXT));
    if (missing === 'dangling-link') bg.init({ jobsDir: path.join(h.root, 'jobs'), homeDir: h.root, cliSessionState: h.cli,
      resolveTranscriptPath: id => id === NEXT ? null : h.file });
    assert.equal((await h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa')).ok, true, 'missing unowned continuation must permit recovery');
    assert.deepEqual(h.calls, [['respawn', 'aaaaaaaa']]);
  });
}

for (const state of ['working', 'blocked']) {
  test('1020fix dead ' + state + ' fork does not block manual Respawn', async t => {
    const h = fixture(t);
    h.fork(); h.descriptors.length = 0;
    h.writeJob('bbbbbbbb', NEXT, state);
    assert.equal((await h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa')).ok, true, 'dead forks are not running');
    assert.deepEqual(h.calls, [['respawn', 'aaaaaaaa']]);
  });
}

test('1020fix dead fork does not refuse its own resume ancestry', async t => {
  const h = fixture(t, 'working');
  fs.appendFileSync(h.file, link(NEXT));
  fs.writeFileSync(path.join(h.root, NEXT + '.jsonl'), line({ type: 'user', sessionId: NEXT }));
  fs.writeFileSync(path.join(h.root, 'jobs', 'aaaaaaaa', 'state.json'), line({ state: 'working', sessionId: NEXT, resumeSessionId: SID,
    linkScanPath: path.join(h.root, NEXT + '.jsonl') }));
  h.delivery.autoAttach = true;
  const result = await h.handlers.get('restore-background-job')({}, SID);
  assert.equal(result.action, 'attach', 'a dead job must not block itself through A -> B');
  assert.deepEqual(h.calls, [['respawn', 'aaaaaaaa']]);
});

test('1020fix blocked restore notice Respawn click reaches the verb and attaches', async t => {
  const h = fixture(t, 'blocked');
  h.delivery.autoAttach = true;
  let notice;
  const opened = [];
  const ctx = require('node:vm').createContext({
    window: { api: {
      restoreBackgroundJob: (sid, options) => h.handlers.get('restore-background-job')({}, sid, options),
      bgAgentVerb: (verb, id) => h.handlers.get('bg-agent-verb')({}, verb, id),
      getSessionLiveElsewhere: async () => h.descriptors[0],
    } },
    sessionActionNoticeId: () => 'restore', sessionActionDescription: () => 'fixture',
    showAppNotice: value => { notice = value; }, openSession: async (...args) => opened.push(args),
  });
  const { prepareBackgroundRestore } = require('./app-source').loadAppFunctions(ctx, { functions: ['prepareBackgroundRestore'] });
  await prepareBackgroundRestore({ sessionId: SID }, { sessionId: SID });
  assert.equal(notice.actionLabel, 'Respawn');
  await notice.onAction();
  assert.deepEqual(h.calls, [['respawn', 'aaaaaaaa']], 'clicking the notice must invoke respawn');
  assert.equal(opened.length, 1, 'recovery attaches the resulting live fork');
  assert.equal(opened[0][2].backgroundRestoreJobId, 'aaaaaaaa');
});
