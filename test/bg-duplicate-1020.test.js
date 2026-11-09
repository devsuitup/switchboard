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
  const descriptors = [], descriptorListeners = new Set();
  const cliCalls = [];
  const cli = { readAllDescriptors: () => descriptors, onDescriptorsChanged: fn => { descriptorListeners.add(fn); return () => descriptorListeners.delete(fn); },
    liveElsewhereChecked: async () => ({ known: true, live: null }),
    refreshProcessTable: async () => {}, readWorkerProcessEvidence: () => ({ processTableFresh: true, tableEntry: () => undefined }) };
  bg.init({ jobsDir, homeDir: root, cliSessionState: cli, resolveTranscriptPath: id => path.join(root, id + '.jsonl'),
    runClaude: async args => { cliCalls.push(args); return { code: 0, stdout: '[]', stderr: '' }; } });
  t.after(() => { bg.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const fork = () => {
    fs.appendFileSync(file, line({ type: 'system', subtype: 'session_cron_carry', sessionId: SID }) + link(NEXT));
    fs.writeFileSync(path.join(root, NEXT + '.jsonl'), line({ type: 'user', sessionId: NEXT }));
    writeJob('bbbbbbbb', NEXT, 'working');
    descriptors.push({ kind: 'bg', sessionId: NEXT, jobId: 'bbbbbbbb', cwd: root });
  };
  const calls = [], checks = [], handlers = new Map(), delivery = { autoAttach: false, wait: null, result: { ok: true }, settled: 0 };
  init({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    bgAgents: { ...bg,
      conversationCheck: (...args) => {
        checks.push(args);
        if (delivery.checkReject) throw null;
        if (delivery.checkThrow) throw new Error('check failed');
        return bg.conversationCheck(...args);
      },
      runVerb: async (...args) => {
        calls.push(args);
        if (delivery.wait) await delivery.wait;
        if (delivery.autoAttach) descriptors.push({ kind: 'bg', pid: 1001, jobId: 'aaaaaaaa', sessionId: bg.findRestoreJob(SID, 'aaaaaaaa').job.sessionId });
        try {
          if (delivery.invoke) return await delivery.invoke(...args);
          if (delivery.throw) throw new Error('reconcile failed after CLI success');
          return delivery.result;
        } finally { delivery.settled++; }
      } },
    cliSessionState: cli, getMainWindow: () => null, log: { warn() {} }, activeSessions: new Map(),
    sessionHasPty: () => false, ptyPids: () => [], getSetting: () => ({ openWorkingSet: [{ sessionId: SID, bg: true, attachJobId: 'aaaaaaaa' }] }) });
  let workerPid = 2000;
  const publishWorker = (pid = ++workerPid) => {
    descriptors.push({ kind: 'bg', pid, jobId: 'aaaaaaaa', sessionId: SID });
    for (const fn of descriptorListeners) fn();
  };
  return { root, file, descriptors, fork, calls, checks, cliCalls, handlers, writeJob, cli, delivery, publishWorker };
}

function handoff(h, { exitAt = 600, forkAt = Infinity, uncertain = false, descriptor = true, prior = false, respawnResult } = {}) {
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
    respawnJob: async () => { h.calls.push(['respawn']); return respawnResult || { ok: true, attached: true }; },
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

for (const state of ['blocked']) {
  test('1020 dead ' + state + ' needs explicit Respawn', async t => {
    const h = fixture(t, state);
    const result = await h.handlers.get('restore-background-job')({}, SID);
    assert.deepEqual(h.calls, [], 'non-resumable or ambiguous states stay stopped');
    assert.equal(result.action, 'refuse');
    assert.equal(result.recovery, 'respawn');
  });
}

for (const state of ['working', 'running', 'done', 'failed']) {
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

for (const tail of ['{"type":"assistant","mess']) {
  test('1020fix torn final line permits manual recovery ' + tail, async t => {
    const h = fixture(t, 'done');
    fs.appendFileSync(h.file, tail);
    assert.deepEqual(await createContinuationReader(h.file, SID)(), [], 'an incomplete final record cannot invalidate sealed evidence');
    assert.equal((await h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa')).ok, true);
    assert.deepEqual(h.calls, [['respawn', 'aaaaaaaa']]);
  });
}

test('1020fix2 unresolved continued-in tail refuses recovery until completed', async t => {
  const h = fixture(t, 'done');
  const record = link(NEXT);
  fs.appendFileSync(h.file, record.slice(0, 40));
  const read = createContinuationReader(h.file, SID);
  assert.equal(await read(), null, 'a partial continued-in record is uncertain');
  for (const channel of ['check-bg-agent-verb', 'bg-agent-verb']) {
    assert.equal((await h.handlers.get(channel)({}, 'respawn', 'aaaaaaaa')).ok, false, 'uncertainty must refuse Respawn');
  }
  assert.deepEqual(h.calls, [], 'uncertainty must never respawn');
  fs.appendFileSync(h.file, record.slice(40));
  assert.deepEqual(await read(), [NEXT], 'the same reader must recognize the completed continuation');
});

test('1020fix3 every continued-in byte cut stays uncertain until completion', async t => {
  const h = fixture(t, 'done');
  const sealed = line({ type: 'user', sessionId: SID });
  const record = JSON.stringify({ type: 'continued-in', sessionId: SID,
    continuedInSessionId: NEXT, timestamp: '2026-11-08T00:00:00Z' });
  const { scanContinuationIndex } = require('../session-continuations');
  for (let cut = 1; cut <= Buffer.byteLength(record); cut++) {
    fs.writeFileSync(h.file, sealed + record.slice(0, cut));
    const read = createContinuationReader(h.file, SID);
    assert.deepEqual(await read(), cut === record.length ? [NEXT] : null, 'continuation uncertainty at byte ' + cut);
    if (cut < record.length) {
      assert.equal(JSON.parse(scanContinuationIndex(h.file, SID)).unresolved, true, 'index uncertainty at byte ' + cut);
      for (const channel of ['check-bg-agent-verb', 'bg-agent-verb']) {
        assert.equal((await h.handlers.get(channel)({}, 'respawn', 'aaaaaaaa')).ok, false, 'refuse recovery at byte ' + cut);
      }
    }
    fs.appendFileSync(h.file, record.slice(cut) + '\r\n');
    assert.deepEqual(await read(), [NEXT], 'recover completed CRLF record at byte ' + cut);
  }
  assert.deepEqual(h.calls, [], 'no torn continuation may respawn');
});

for (const consumer of ['handoff reader', 'session-cache traversal']) {
for (const role of ['assistant', 'user']) {
  for (const cutAt of ['first key', 'half', 'last byte']) {
    test(`1020fix4 real ${role} torn after ${cutAt} retains sealed evidence through ${consumer}`, async t => {
      const h = fixture(t, 'done');
      const record = JSON.stringify({ parentUuid: PRIOR, isSidechain: false, sessionId: SID,
        message: { ...(role === 'assistant' ? { model: 'claude' } : {}), role, content: 'hello from the CLI' },
        type: role, uuid: NEXT, timestamp: '2026-11-08T00:00:00Z' });
      const cut = cutAt === 'first key' ? '{"parentUuid":'.length
        : cutAt === 'half' ? Math.floor(record.length / 2) : record.length - 1;
      fs.writeFileSync(h.file, link(NEXT) + record.slice(0, cut));
      fs.writeFileSync(path.join(h.root, NEXT + '.jsonl'), line({ type: 'user', sessionId: NEXT }));
      const read = createContinuationReader(h.file, SID);
      const { scanContinuationIndex, resolveContinuations } = require('../session-continuations');
      const walk = () => resolveContinuations(SID, id => ({ index: JSON.parse(scanContinuationIndex(path.join(h.root, id + '.jsonl'), id)) }));
      if (consumer === 'handoff reader') assert.deepEqual(await read(), [NEXT], 'handoff reader must retain sealed evidence');
      assert.equal((await walk()).unresolved, false, 'session-cache traversal must retain sealed evidence');
      assert.deepEqual((await walk()).candidates.map(row => row.sessionId), [NEXT]);
      assert.deepEqual(await read(), [NEXT], 'handoff reader must retain sealed evidence');
      fs.appendFileSync(h.file, record.slice(cut) + '\r\n');
      assert.deepEqual(await read(), [NEXT], 'completed ordinary CRLF tail retains the link');
      assert.equal((await walk()).unresolved, false);
    });
  }
}
}

for (const tail of ['{"uuid":', '{"type":null,"parentUuid":', '{"type":null,"message":']) {
  test('1020fix4 ordinary key proves a non-continuation tail ' + tail, async t => {
    const h = fixture(t);
    fs.appendFileSync(h.file, tail);
    assert.deepEqual(await createContinuationReader(h.file, SID)(), []);
  });
}

test('1020fix4 tail inside the first key stays uncertain and recovers', async t => {
  const h = fixture(t, 'done');
  fs.writeFileSync(h.file, link(NEXT) + '{"par');
  const read = createContinuationReader(h.file, SID);
  const { scanContinuationIndex, resolveContinuations } = require('../session-continuations');
  assert.equal(await read(), null);
  const result = await resolveContinuations(SID, id => id === SID
    ? { index: JSON.parse(scanContinuationIndex(h.file, SID)) } : { index: { ids: [] } });
  assert.equal(result.unresolved, true);
  fs.appendFileSync(h.file, 'entUuid":');
  assert.deepEqual(await read(), [NEXT], 'a complete first key proves an ordinary record');
});

for (const prefix of ['{"parentUuid":null,"message":', '{"type":"assistant","message":', '{"type":null,"message":']) {
  for (const consumer of ['handoff reader', 'session-cache traversal']) {
    test('1020fix4 ordinary proof overrides a nested continuation tag through ' + consumer + ' ' + prefix, async t => {
      const h = fixture(t, 'done');
      fs.writeFileSync(h.file, link(NEXT) + prefix + '{"input":{"type":"continued-in"}}');
      fs.writeFileSync(path.join(h.root, NEXT + '.jsonl'), line({ type: 'user', sessionId: NEXT }));
      if (consumer === 'handoff reader') assert.deepEqual(await createContinuationReader(h.file, SID)(), [NEXT], 'an ordinary outer record cannot be a continuation');
      else {
        const { scanContinuationIndex, resolveContinuations } = require('../session-continuations');
        const result = await resolveContinuations(SID, id => ({ index: JSON.parse(scanContinuationIndex(path.join(h.root, id + '.jsonl'), id)) }));
        assert.equal(result.unresolved, false, 'a nested tag cannot override the ordinary record proof');
        assert.deepEqual(result.candidates.map(row => row.sessionId), [NEXT]);
      }
    });
  }
}

for (const publication of ['immediate', 'delayed']) {
for (const mode of ['clicks', 'click and restore', 'restore and click']) {
  test('1020fix5 concurrent ' + mode + ' with ' + publication + ' worker publication invoke one respawn per job', async t => {
    const h = fixture(t, 'done');
    h.delivery.autoAttach = publication === 'immediate';
    let release;
    h.delivery.wait = new Promise(resolve => { release = resolve; });
    const click = () => h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
    const restore = () => h.handlers.get('restore-background-job')({}, SID);
    const first = mode === 'restore and click' ? restore() : click();
    await new Promise(resolve => setImmediate(resolve));
    const second = mode === 'click and restore' ? restore() : click();
    await new Promise(resolve => setImmediate(resolve));
    const count = h.calls.length;
    release();
    await new Promise(resolve => setImmediate(resolve));
    const settledCount = h.calls.length;
    if (publication === 'delayed') h.publishWorker();
    const results = await Promise.all([first, second]);
    assert.equal(count, 1, 'concurrent requests must invoke ONE respawn');
    assert.equal(settledCount, 1, 'joiners must not respawn again before worker publication');
    assert.ok(results[0].ok || results[0].action === 'attach');
    if (mode === 'clicks') assert.equal(results[1].ok, true);
    else if (mode === 'click and restore') {
      assert.equal(results[1].action, 'attach', 'restore joins the successful manual flight');
    } else {
      assert.equal(results[1].ok, true, 'manual joiner shares the successful restore flight');
    }
    h.publishWorker();
    h.descriptors.length = 0;
    assert.equal((await click()).ok, true, 'a published worker clears the marker and allows later recovery');
    assert.equal(h.calls.length, 2);
  });
}
}

for (const timedOut of [false, true]) {
  test('1033 click two seconds after ' + (timedOut ? 'timed-out' : 'successful') + ' restore respawn shares its result', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture(t, 'done');
    if (timedOut) h.delivery.result = { ok: false, error: 'claude respawn timed out after 60000ms' };
    const restore = h.handlers.get('restore-background-job')({}, SID);
    while (!h.delivery.settled) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.delivery.settled, 1, 'the CLI verb has settled before the delayed click');
    t.mock.timers.tick(2000);
    const result = await h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
    assert.equal(h.calls.length, 1, 'a delayed click must not respawn again before publication');
    assert.equal(result.ok, !timedOut);
    if (timedOut) {
      assert.match(result.error, /unknown.*Agents view/i);
      assert.match((await restore).reason, /unknown.*Agents view/i);
    } else {
      h.publishWorker();
      assert.equal((await restore).action, 'attach');
    }
  });

  test('1033 unpublished ' + (timedOut ? 'uncertain' : 'successful') + ' respawn expires after fifteen seconds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture(t, 'done');
    if (timedOut) h.delivery.result = { ok: false, error: 'verb timeout' };
    const click = () => h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
    await click();
    t.mock.timers.tick(14999);
    await click();
    assert.equal(h.calls.length, 1, 'the marker must last the whole descriptor window');
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    await click();
    assert.equal(h.calls.length, 2, 'an unpublished worker can be retried after fifteen seconds');
  });

  for (const verb of ['stop', 'rm']) {
  test('1033 ' + verb + ' clears an unpublished ' + (timedOut ? 'uncertain' : 'successful') + ' respawn marker', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = fixture(t, 'done');
    if (timedOut) h.delivery.result = { ok: false, error: 'verb timeout' };
    const click = () => h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
    await click();
    await click();
    assert.equal(h.calls.length, 1, 'the unpublished respawn must be held before Stop');
    h.delivery.result = { ok: true };
    await h.handlers.get('bg-agent-verb')({}, verb, 'aaaaaaaa');
    await click();
    assert.deepEqual(h.calls.map(call => call[0]), ['respawn', verb, 'respawn'], verb + ' permits immediate explicit recovery');
  });
  }
}

for (const state of ['stopped', 'failed']) {
  for (const publication of ['old worker remains', 'new worker before state update']) {
    for (const uncertain of [false, true]) {
      test(`1033fix ${state}: ${publication}, ${uncertain ? 'uncertain' : 'successful'} result uses the pre-CLI pid snapshot`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const h = fixture(t, state);
        h.descriptors.push({ kind: 'bg', jobId: 'aaaaaaaa', sessionId: SID, pid: 4242 });
        h.cli.readWorkerProcessEvidence = () => ({ processTableFresh: true, tableEntry: pid => pid === 4242 ? { created: 'old-worker' } : undefined });
        h.delivery.autoAttach = publication === 'new worker before state update';
        if (uncertain) h.delivery.result = { ok: false, error: 'verb timed out' };
        const click = () => h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
        await click();
        h.delivery.autoAttach = false;
        if (publication === 'new worker before state update') {
          h.descriptors.length = 0;
          await click();
          assert.equal(h.calls.length, 2, 'a worker published during the CLI call releases the hold before state update');
          return;
        }
        t.mock.timers.tick(2000);
        await click();
        assert.equal(h.calls.length, 1, 'a descriptor present before the CLI call must not release the hold');
        h.publishWorker(4242);
        await click();
        assert.equal(h.calls.length, 1, 'republishing the old pid must keep the hold');
        h.publishWorker();
        h.descriptors.length = 0;
        await click();
        assert.equal(h.calls.length, 2, 'a different worker pid releases the hold even in a terminal state');
      });
    }
  }
}

for (const exit of ['unknown verb', 'invalid id', 'generation change', 'unknown worker', 'hosted job']) {
  test('1033fix real runVerb refusal is immediately rechecked: ' + exit, async t => {
    const h = fixture(t, 'done');
    let refused;
    h.delivery.invoke = async (verb, id) => {
      if (exit === 'generation change' || exit === 'unknown worker') h.writeJob(id, SID, 'running');
      if (exit === 'generation change') h.cli.refreshProcessTable = async () => bg.stop();
      if (exit === 'unknown worker') h.cli.readWorkerProcessEvidence = () => ({ processTableFresh: false });
      if (exit === 'hosted job') {
        h.writeJob(id, SID, 'working');
        h.descriptors.push({ kind: 'bg', jobId: id, sessionId: SID, pid: 4242 });
      }
      refused = await bg.runVerb(exit === 'unknown verb' ? 'bogus' : verb, exit === 'invalid id' ? 'invalid' : id);
      h.writeJob(id, SID, 'done');
      h.descriptors.length = 0;
      h.cli.refreshProcessTable = async () => {};
      h.cli.readWorkerProcessEvidence = () => ({ processTableFresh: true, tableEntry: () => undefined });
      h.delivery.invoke = (...args) => bg.runVerb(...args);
      return refused;
    };
    const click = () => h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
    await click();
    const checks = h.checks.length;
    const retry = await click();
    assert.ok(h.checks.length > checks, 'a certain refusal must permit a fresh check on immediate retry');
    assert.equal(refused.refused, true, 'the real runVerb marks its pre-CLI exit as refused');
    assert.equal(refused.error, {
      'unknown verb': 'unknown verb: bogus',
      'invalid id': 'invalid background session id',
      'generation change': 'background agent service changed while checking the worker; retry the action',
      'unknown worker': "cannot tell whether job aaaaaaaa's worker is running — not respawned",
      'hosted job': 'cannot respawn a working session; stop it first',
    }[exit]);
    assert.equal(retry.ok, true);
    assert.equal(h.cliCalls.filter(args => args[0] === 'respawn').length, 1);
  });
}

test('1033fix a runVerb throw is held for a joiner and the next click', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(t, 'done');
  h.delivery.invoke = async (...args) => {
    await bg.runVerb(...args);
    throw new Error('reconcile failed after CLI success');
  };
  const click = () => h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
  const results = await Promise.allSettled([click(), click()]);
  assert.ok(results.every(result => result.status === 'fulfilled'), 'post-CLI throws must return a held unknown result');
  const result = await click();
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown.*reconcile failed.*Agents view/i);
  assert.deepEqual(results.map(item => item.value), [result, result]);
  assert.equal(h.cliCalls.filter(args => args[0] === 'respawn').length, 1);
});

test('1033fix a thrown conversation check is refused without a hold', async t => {
  const h = fixture(t, 'done');
  h.delivery.checkThrow = true;
  const click = () => h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
  assert.equal((await click()).ok, false);
  h.delivery.checkThrow = false;
  assert.equal((await click()).ok, true, 'a check failure permits an immediate fresh check');
  assert.equal(h.checks.length, 2);
  assert.equal(h.calls.length, 1);
});

test('1033fix a rejection escaping checkVerb is not held', async t => {
  const h = fixture(t, 'done');
  h.delivery.checkReject = true;
  const click = () => h.handlers.get('bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
  await assert.rejects(click(), TypeError);
  assert.equal(h.calls.length, 0, 'a rejected check cannot reach the CLI');
  h.delivery.checkReject = false;
  assert.equal((await click()).ok, true, 'a rejected check permits an immediate retry');
  assert.equal(h.checks.length, 2);
  assert.equal(h.calls.length, 1);
});

test('1033fix handoff keeps unknown-result advice once with no double period', async t => {
  const h = fixture(t);
  const { result } = await handoff(h, { respawnResult: { ok: false,
    error: 'Respawn result is unknown (timeout). Check the Agents view before retrying.' } });
  assert.doesNotMatch(result.error, /\.\./, 'handoff must not duplicate the final period');
  assert.equal((result.error.match(/check the Agents view/ig) || []).length, 1, 'handoff must give the recovery advice only once');
});

test('1033fix2 refused handoff strips the final period of a real checkVerb error', async t => {
  const h = fixture(t, 'running');
  h.cli.readWorkerProcessEvidence = () => ({ processTableFresh: false });
  const refusal = await h.handlers.get('check-bg-agent-verb')({}, 'respawn', 'aaaaaaaa');
  assert.equal(refusal.ok, false);
  assert.match(refusal.error, /Check the Agents view, then retry\.$/);
  const { result } = await handoff(h, { respawnResult: { ...refusal, refused: true } });
  assert.equal(result.code, 'respawn-failed');
  assert.doesNotMatch(result.error, /\.\./, 'a real checkVerb refusal must not duplicate the final period');
  assert.ok(result.error.includes(refusal.error + ' Respawn it from the Agents view'));
});

for (const state of ['stopped', 'failed']) {
  test('1020fix2 ' + state + ' continuation permits Respawn while daemon runs', async t => {
    const h = fixture(t);
    h.fork(); h.descriptors.length = 0;
    h.writeJob('bbbbbbbb', NEXT, state);
    fs.writeFileSync(path.join(h.root, 'daemon', 'roster.json'), line({ proto: 1,
      updatedAt: new Date().toISOString(), supervisorPid: 4242, workers: {} }));
    h.cli.readWorkerProcessEvidence = () => ({ processTableFresh: true,
      tableEntry: pid => pid === 4242 ? { created: 'daemon' } : undefined });
    for (const channel of ['check-bg-agent-verb', 'bg-agent-verb']) {
      assert.equal((await h.handlers.get(channel)({}, 'respawn', 'aaaaaaaa')).ok, true, 'terminal continuations cannot host workers');
    }
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
