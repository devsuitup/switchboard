'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sendToBackground, holdBackgroundExit, createContinuationReader } = require('../bg-handoff');
const { acquireTabInput, tryAcquireTabInput } = require('../src/main/terminals/tab-input-lock');
const { createComposerState, noteUserInput } = require('../src/main/terminals/composer-state');
const { trackWindowsPty, killPty } = require('../src/main/terminals/pty-ops');

function setup(options = {}) {
  let time = 0, output;
  const writes = [], exits = [], notices = [], scheduled = [], kills = [];
  const session = { kind: 'local-pty', composerState: createComposerState(), ...options.session };
  const bg = { sessionId: 'new', kind: 'bg', jobId: '1234abcd', cwd: '/project' };
  const deps = {
    getSession: () => session,
    getStatus: () => options.status === undefined ? 'idle' : options.status,
    write: (_, text) => { writes.push(text); return options.write !== false; },
    tapOutput: (_, fn) => { output = fn; return () => { output = null; }; },
    now: () => time,
    delay: async ms => { time += ms; },
    waitForChange: async ms => { time += ms; await options.tick?.({ session, bg, time, output, exits }); },
    readContinuationIds: () => time >= 400 ? options.ids || ['new'] : [],
    readDescriptors: () => time >= 500 ? options.descriptors || [bg] : [],
    notify: text => notices.push(text),
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
    kill: entry => { kills.push(entry); },
    timeoutMs: 1000, exitTimeoutMs: 300,
  };
  return { session, bg, deps, writes, exits, notices, scheduled, kills, outputAttached: () => !!output };
}

test('a confirmed background handoff releases its Windows job before the delayed PTY close', async () => {
  const events = [];
  const pty = { pid: 897, onExit() {}, kill() { events.push('pty'); } };
  await trackWindowsPty(pty, { platform: 'win32', jobs: { assign: async () => true,
    release: async () => { events.push('release'); return true; }, terminate: async () => { events.push('terminate'); } } });
  const h = setup({ session: { pty } });
  h.deps.onConfirmed = () => { assert.equal(h.session.backgrounded, true); events.push('confirmed'); };
  h.deps.kill = session => killPty(session, 'background', { platform: 'win32' });
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
  assert.deepEqual(events, ['release', 'confirmed']);
  h.scheduled.at(-1).fn();
  assert.deepEqual(events, ['release', 'confirmed', 'pty']);
});

test('T1: unsent composer text refuses before any write', async () => {
  const h = setup({ session: { composerState: { pending: 2 } } });
  assert.match((await sendToBackground('old', h.deps)).error, /have not sent/i);
  assert.deepEqual(h.writes, []);
});

test('T2: waiting, shell and unknown status refuse before any write', async () => {
  for (const status of ['waiting', 'shell', null]) {
    const h = setup({ status });
    assert.equal((await sendToBackground('old', h.deps)).code, 'refused');
    assert.deepEqual(h.writes, []);
  }
});

test('T3: unavailable and ineligible tabs refuse before any write', async () => {
  for (const session of [{ exited: true }, { sandbox: true }, { preLaunch: true }, { isAttach: true }, { kind: 'remote-attach' }, { isPlainTerminal: true }]) {
    const h = setup({ session });
    assert.equal((await sendToBackground('old', h.deps)).code, 'refused');
    assert.deepEqual(h.writes, []);
  }
  const h = setup();
  h.deps.getSession = () => null;
  assert.equal((await sendToBackground('old', h.deps)).code, 'refused');
});

test('T4: separate /bg and Enter after 300ms convert only on matched proof', async () => {
  const h = setup();
  const times = [];
  h.deps.write = (_, text) => { h.writes.push(text); times.push(h.deps.now()); return true; };
  assert.deepEqual(await sendToBackground('old', h.deps), { ok: true, oldSessionId: 'old', jobId: '1234abcd', sessionId: 'new', cwd: '/project' });
  assert.deepEqual(h.writes, ['/bg', '\r']);
  assert.deepEqual(times, [0, 300]);
  assert.equal(h.session.backgrounding, false);
  assert.equal(h.outputAttached(), false);
});

test('T5: unrelated bg descriptor and continuation without a live bg keep waiting to deadline', async () => {
  for (const descriptors of [[{ kind: 'bg', sessionId: 'other', jobId: '1234abcd' }], [{ kind: 'interactive', sessionId: 'new', jobId: '1234abcd' }], [{ kind: 'bg', sessionId: 'new', jobId: 'bad' }]]) {
    const h = setup({ descriptors });
    assert.equal((await sendToBackground('old', h.deps)).code, 'timeout');
    assert.deepEqual(h.exits, []);
    assert.equal(h.session.backgrounded, undefined);
  }
});

test('T6: split ANSI cancellation returns the CLI reason and releases the output listener', async () => {
  const h = setup({ tick: ({ time, output }) => output(time === 400 ? '\x1b[31mBackgrounding can' : 'celled — the turn was stopped\x1b[0m\r\n') });
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.code, 'cancelled');
  assert.match(result.error, /the turn was stopped/);
  assert.equal(h.outputAttached(), false);
});

test('T7: exit before proof is held; a bg descriptor without status succeeds and suppresses exit reporting', async () => {
  const h = setup({ tick: ({ session, time, exits }) => {
    if (time === 400) {
      session.exited = true;
      assert.equal(holdBackgroundExit(session, suppressed => exits.push(suppressed)), true);
      assert.deepEqual(exits, []);
    }
  } });
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
  assert.deepEqual(h.exits, [true]);
});

test('confirmed handoff rekeys before the held exit releases the source environment', async () => {
  const order = [];
  const h = setup({ tick: ({ session, time }) => {
    if (time === 400) {
      session.exited = true;
      holdBackgroundExit(session, () => order.push('exit'));
    }
  } });
  h.deps.onConfirmed = job => { assert.equal(job.sessionId, 'new'); order.push('rekey'); };
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
  assert.deepEqual(order, ['rekey', 'exit']);
});

test('T7b: exit without proof is released at its bounded deadline with an actionable failure', async () => {
  const h = setup({ descriptors: [], tick: ({ session, time, exits }) => {
    if (time === 400) {
      session.exited = true;
      holdBackgroundExit(session, suppressed => exits.push(suppressed));
    }
  } });
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.code, 'timeout');
  assert.match(result.error, /exited.*sidebar/i);
  assert.equal(h.deps.now(), 700);
  assert.deepEqual(h.exits, [false]);
});

test('T8: concurrent requests write one command and release the in-flight flag', async () => {
  const h = setup();
  const first = sendToBackground('old', h.deps);
  assert.equal((await sendToBackground('old', h.deps)).code, 'refused');
  await first;
  assert.deepEqual(h.writes, ['/bg', '\r']);
  assert.equal(h.session.backgrounding, false);
});

test('T9: failed text or Enter writes never convert', async () => {
  for (const failAt of [0, 1]) {
    const h = setup();
    h.deps.write = (_, text) => { h.writes.push(text); return h.writes.length - 1 !== failAt; };
    assert.equal((await sendToBackground('old', h.deps)).code, 'write-failed');
    assert.equal(h.session.backgrounded, undefined);
  }
});

test('T10: a dialog that stays open after submission asks for terminal confirmation without another Enter', async () => {
  const h = setup();
  h.deps.timeoutMs = 5000;
  h.deps.readDescriptors = () => h.deps.now() >= 2000 ? [h.bg] : [{ sessionId: 'old', kind: 'interactive', status: 'waiting' }];
  h.deps.getStatus = () => h.deps.now() >= 400 ? 'waiting' : 'idle';
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /confirm.*terminal/i);
  assert.deepEqual(h.writes, ['/bg', '\r']);
});

test('T11: a previously recorded continuation is not proof of this request', async () => {
  const h = setup();
  h.deps.readContinuationIds = () => ['new'];
  assert.equal((await sendToBackground('old', h.deps)).code, 'timeout');
});

test('T12: shared continuation reader follows appended records with case-insensitive source identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'old.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n');
  const read = createContinuationReader(file, 'old');
  assert.deepEqual(await read(), []);
  fs.appendFileSync(file, JSON.stringify({ type: 'continued-in', sessionId: 'OLD', continuedInSessionId: 'new' }) + '\n');
  assert.deepEqual(await read(), ['new']);
});

test('T13: a dialog or user input during the text-to-Enter gap withholds Enter', async () => {
  for (const change of ['dialog', 'input']) {
    const h = setup();
    h.deps.delay = async () => {
      if (change === 'dialog') h.deps.getStatus = () => 'waiting';
      else noteUserInput(h.session.composerState, 'x', 1);
    };
    assert.equal((await sendToBackground('old', h.deps)).ok, false);
    assert.deepEqual(h.writes, ['/bg']);
  }
});

test('T14: a trigger holding the tab lock refuses handoff with zero writes and releases normally', async () => {
  const h = setup();
  const release = await acquireTabInput(h.session, Date.now() + 1000);
  try {
    const result = await sendToBackground('old', h.deps);
    assert.equal(result.code, 'refused');
    assert.match(result.error, /automation trigger/);
    assert.deepEqual(h.writes, []);
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
});

test('T15: a re-key or replacement during the text-to-Enter gap withholds Enter', async () => {
  for (const change of ['re-key', 'replacement']) {
    const h = setup();
    h.deps.delay = async () => {
      if (change === 're-key') h.session.realSessionId = 'other';
      else h.deps.getSession = () => ({ kind: 'local-pty' });
    };
    assert.equal((await sendToBackground('old', h.deps)).ok, false);
    assert.deepEqual(h.writes, ['/bg']);
  }
});

test('T16: a withheld Enter leaves /bg in the composer model, so a retry refuses instead of typing /bg/bg', async () => {
  const h = setup();
  h.deps.delay = async () => { h.deps.getStatus = () => 'waiting'; };
  assert.equal((await sendToBackground('old', h.deps)).code, 'write-failed');
  h.deps.getStatus = () => 'idle';
  const retry = await sendToBackground('old', h.deps);
  assert.equal(retry.code, 'refused');
  assert.match(retry.error, /have not sent/);
  assert.deepEqual(h.writes, ['/bg']);
});

test('T17: input that settles back to an empty composer during the snapshot does not withhold Enter', async () => {
  const h = setup();
  const read = h.deps.readContinuationIds;
  let first = true;
  h.deps.readContinuationIds = async (...args) => {
    if (first) { first = false; noteUserInput(h.session.composerState, 'x\x7f', 7); }
    return read(...args);
  };
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
  assert.deepEqual(h.writes, ['/bg', '\r']);
});

test('T18: an unreadable pre-write snapshot refuses after one retry, with zero writes', async () => {
  const h = setup();
  let reads = 0;
  h.deps.readContinuationIds = () => { reads++; return null; };
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.code, 'refused');
  assert.match(result.error, /transcript/);
  assert.equal(reads, 2);
  assert.deepEqual(h.writes, []);
});

test('T18b: a snapshot that reads on the retry proceeds', async () => {
  const h = setup();
  const read = h.deps.readContinuationIds;
  let reads = 0;
  h.deps.readContinuationIds = (...args) => (++reads === 1 ? null : read(...args));
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
});

test('T19: a deleted descriptor with retained waiting status shows no confirmation notice before proof', async () => {
  const h = setup();
  h.deps.timeoutMs = 5000;
  h.deps.getStatus = () => h.deps.now() <= 300 ? 'idle' : 'waiting';
  h.deps.readDescriptors = () => h.deps.now() >= 2000 ? [h.bg]
    : h.deps.now() < 600 ? [{ sessionId: 'old', kind: 'interactive', status: 'waiting' }] : [];
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
  assert.equal(h.deps.now(), 2000);
  assert.deepEqual(h.notices, []);
});

test('T19b: an original waiting descriptor past the notice window shows one confirmation notice', async () => {
  const h = setup();
  h.deps.timeoutMs = 2000;
  h.deps.getStatus = () => h.deps.now() <= 300 ? 'idle' : 'waiting';
  h.deps.readDescriptors = () => [{ sessionId: 'OLD', kind: 'interactive', status: 'waiting' }];
  assert.equal((await sendToBackground('old', h.deps)).code, 'timeout');
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /confirm.*terminal/i);
  assert.deepEqual(h.writes, ['/bg', '\r']);
});

test('T20: a busy session is refused before any write', async () => {
  const h = setup({ status: 'busy' });
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.code, 'refused');
  assert.equal(result.error, 'Claude is working. Send to background once it is idle.');
  assert.deepEqual(h.writes, []);
});

test('T21: input that leaves the same /bg text during the gap still withholds Enter', async () => {
  const h = setup();
  h.deps.delay = async ms => { noteUserInput(h.session.composerState, 'x\x7f', ms); };
  assert.equal((await sendToBackground('old', h.deps)).code, 'write-failed');
  assert.deepEqual(h.writes, ['/bg']);
});

test('T22: two live jobs for the proven conversation are ambiguous and never confirm', async () => {
  const h = setup({ descriptors: [{ sessionId: 'new', kind: 'bg', jobId: '1234abcd' }, { sessionId: 'new', kind: 'bg', jobId: '5678abcd' }] });
  assert.equal((await sendToBackground('old', h.deps)).code, 'timeout');
  assert.equal(h.session.backgrounded, undefined);
});

test('T23: a dialog or composer text appearing during the snapshot refuses with zero writes', async () => {
  for (const change of ['dialog', 'input']) {
    const h = setup();
    h.deps.readContinuationIds = async () => {
      if (change === 'dialog') h.deps.getStatus = () => 'waiting';
      else noteUserInput(h.session.composerState, 'x', 1);
      return [];
    };
    assert.equal((await sendToBackground('old', h.deps)).code, 'refused');
    assert.deepEqual(h.writes, []);
  }
});

test('T24: a descriptor naming the proven conversation in upper case confirms it', async () => {
  const h = setup({ descriptors: [{ sessionId: 'NEW', kind: 'bg', jobId: '1234abcd', cwd: '/project' }] });
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.ok, true);
  assert.equal(result.jobId, '1234abcd');
});

test('T25: a throwing exit release still frees the tab input lock', async () => {
  const h = setup({ tick: ({ session, time }) => {
    if (time === 400) { session.exited = true; holdBackgroundExit(session, () => { throw new Error('release failed'); }); }
  } });
  await assert.rejects(sendToBackground('old', h.deps), /release failed/);
  const unlock = tryAcquireTabInput(h.session);
  assert.equal(typeof unlock, 'function');
  unlock();
});

test('T26: after success the old CLI is stopped if it has not exited within the hold window', async () => {
  for (const exitsInTime of [false, true]) {
    const h = setup();
    assert.equal((await sendToBackground('old', h.deps)).ok, true);
    assert.equal(h.scheduled.length, 1);
    assert.equal(h.scheduled[0].ms, 300);
    if (exitsInTime) h.session.exited = true;
    h.scheduled[0].fn();
    assert.deepEqual(h.kills, exitsInTime ? [] : [h.session]);
  }
});

for (const [name, input] of [['Esc', '\x1b'], ['Esc Esc', '\x1b\x1b'], ['Ctrl+U after hello', 'hello\x15']]) {
  test(`T27: an empty composer after ${name} submits /bg and confirms the handoff`, async () => {
    const h = setup();
    noteUserInput(h.session.composerState, input, 7);
    assert.equal(h.session.composerState.pending, 0);
    assert.equal((await sendToBackground('old', h.deps)).ok, true);
    assert.deepEqual(h.writes, ['/bg', '\r']);
    assert.equal(h.session.composerState.pending, 0);
  });
}

for (const failure of ['throw', 'false']) {
  test(`T28: a ${failure} text write restores the composer and allows a retry`, async () => {
    const h = setup();
    noteUserInput(h.session.composerState, '\x1b', 7);
    const composer = h.session.composerState;
    const before = { ...composer };
    h.deps.write = () => {
      if (failure === 'throw') throw new Error('PTY write failed');
      return false;
    };
    const result = await sendToBackground('old', h.deps);
    assert.equal(result.code, failure === 'throw' ? 'failed' : 'write-failed');
    assert.equal(h.session.composerState, composer);
    assert.deepEqual(composer, before);
    assert.equal(h.session.backgrounding, false);
    assert.equal(h.outputAttached(), false);
    h.deps.write = (_, text) => { h.writes.push(text); return true; };
    assert.equal((await sendToBackground('old', h.deps)).ok, true);
    assert.deepEqual(h.writes, ['/bg', '\r']);
  });
}

const S2_SID = '11111111-1111-4111-8111-111111111111';
function respawnSetup(respawnResult) {
  const h = setup();
  h.deps.decideRoute = async () => ({ route: 'respawn', jobId: 'aaaaaaaa', job: { id: 'aaaaaaaa', sessionId: 'old' } });
  h.deps.write = (_, text) => { h.writes.push(text); if (text === '\r') h.session.exited = true; return true; };
  h.deps.respawnJob = async () => respawnResult;
  return h;
}

test('S2-T5b a refused respawn and a failed respawn after /exit read differently', async () => {
  const refused = await sendToBackground('old', respawnSetup({ ok: false, refused: true, error: 'r' }).deps);
  assert.equal(refused.code, 'respawn-failed');
  assert.match(refused.error, /was not relaunched: r\./);
  const failed = await sendToBackground('old', respawnSetup({ ok: false, error: 't' }).deps);
  assert.equal(failed.code, 'respawn-failed');
  assert.match(failed.error, /failed or timed out: t\./);
});

test('S2-T7 (owned rows) respawnRoute refuses an unknown or held owner and respawns otherwise', () => {
  const { respawnRoute } = require('../bg-handoff');
  const base = { oldId: S2_SID, lookup: { known: true, job: { id: 'aaaaaaaa', resumeTarget: S2_SID } },
    check: { known: true, state: 'stopped', workerLiveness: 'dead', sessionIds: [S2_SID] }, elsewhere: [{ known: true, live: null }] };
  assert.equal(respawnRoute({ ...base, owned: { known: true, job: null } }).route, 'respawn');
  const unknown = respawnRoute({ ...base, owned: { known: false, reason: 'job cccccccc has an unreadable state' } });
  assert.equal(unknown.route, 'refuse');
  assert.match(unknown.error, /unreadable state/);
  const held = respawnRoute({ ...base, owned: { known: true, job: { id: 'bbbbbbbb', state: 'working' } } });
  assert.equal(held.route, 'refuse');
  assert.match(held.error, /bbbbbbbb/);
});


test('S2-T1 respawn waits for source exit and preserves the conversation without a kill', async () => {
  const h = respawnSetup({ ok: true });
  const calls = [];
  h.deps.write = (_, text) => { h.writes.push(text); return true; };
  const wait = h.deps.waitForChange;
  h.deps.waitForChange = async ms => {
    await wait(ms);
    h.session.exited = true;
    holdBackgroundExit(h.session, suppress => h.exits.push(suppress));
  };
  h.deps.respawnJob = async job => { calls.push({ job, exited: h.session.exited === true }); return { ok: true, attached: false }; };
  h.deps.onConfirmed = () => assert.fail('respawn has no new continuation');
  const result = await sendToBackground('old', h.deps);
  assert.deepEqual(h.writes, ['/exit', '\r']);
  assert.deepEqual(calls, [{ job: { id: 'aaaaaaaa', sessionId: 'old' }, exited: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.respawned, true);
  assert.equal(result.sessionId, 'old');
  assert.equal(result.jobId, 'aaaaaaaa');
  assert.equal(result.attached, false);
  assert.deepEqual(h.exits, [true]);
  assert.deepEqual(h.scheduled, []);
  assert.deepEqual(h.kills, []);
});

test('S2-T2 GUARD explicit bg route keeps existing confirmation', async () => {
  const h = setup();
  h.deps.decideRoute = async () => ({ route: 'bg' });
  assert.equal((await sendToBackground('old', h.deps)).ok, true);
  assert.deepEqual(h.writes, ['/bg', '\r']);
});

test('S2-T3 refused route preserves reason and writes nothing', async () => {
  const h = setup();
  h.deps.decideRoute = async () => ({ route: 'refuse', error: 'Job aaaaaaaa is unreadable. Check the Agents view, then try again.' });
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.code, 'refused');
  assert.match(result.error, /Job aaaaaaaa is unreadable/);
  assert.deepEqual(h.writes, []);
});

test('S2-T4 source that never exits times out without respawn or kill', async () => {
  const h = setup();
  h.deps.decideRoute = async () => ({ route: 'respawn', job: { id: 'aaaaaaaa' } });
  const calls = [];
  h.deps.respawnJob = async job => { calls.push(job); return { ok: true }; };
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.code, 'exit-timeout');
  assert.equal(h.deps.now(), 600);
  assert.deepEqual(h.writes, ['/exit', '\r']);
  assert.deepEqual(calls, []);
  assert.deepEqual(h.kills, []);
});

test('S2-T5 failure after exit releases held exit without suppression', async () => {
  const h = respawnSetup({ ok: false, error: 'boom' });
  const write = h.deps.write;
  h.deps.write = (...args) => {
    const result = write(...args);
    if (h.session.exited) holdBackgroundExit(h.session, suppress => h.exits.push(suppress));
    return result;
  };
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.code, 'respawn-failed');
  assert.match(result.error, /aaaaaaaa.*boom/);
  assert.deepEqual(h.exits, [false]);
  assert.notEqual(h.session.backgrounded, true);
});

test('S2-T6 changed composer during exit gap withholds Enter and respawn', async () => {
  const h = respawnSetup({ ok: true });
  const calls = [];
  h.deps.delay = async () => noteUserInput(h.session.composerState, 'x', 1);
  h.deps.respawnJob = async job => { calls.push(job); return { ok: true }; };
  const result = await sendToBackground('old', h.deps);
  assert.equal(result.code, 'write-failed');
  assert.deepEqual(h.writes, ['/exit']);
  assert.deepEqual(calls, []);
});

const routeBase = () => ({ oldId: S2_SID,
  lookup: { known: true, job: { id: 'aaaaaaaa', resumeTarget: S2_SID } },
  check: { known: true, state: 'stopped', workerLiveness: 'dead' },
  owned: { known: true, job: null }, elsewhere: [{ known: true, live: null }] });

for (const [label, overrides, expected, reason] of [
  ['missing', { lookup: { known: false, missing: true } }, 'bg'],
  ['ambiguous', { lookup: { known: false, reason: 'multiple records' } }, 'refuse', /multiple records/],
  ['unreadable matching record', { lookup: { known: false, reason: 'unreadable matching record' } }, 'refuse', /unreadable matching record/],
  ['resume mismatch', { lookup: { known: true, job: { id: 'aaaaaaaa', resumeTarget: 'other' } } }, 'refuse', /would resume.*other/],
  ['unknown resume target', { lookup: { known: true, job: { id: 'aaaaaaaa', resumeTarget: null } } }, 'refuse', /unknown/],
  ['unknown conversation', { check: { known: false, reason: 'unreadable conversation' } }, 'refuse', /unreadable conversation/],
  ['done live', { check: { known: true, state: 'done', workerLiveness: 'live' } }, 'refuse', /worker is running/],
  ...['running', 'working', 'blocked'].map(state => [state + ' unknown', { check: { known: true, state, workerLiveness: 'unknown' } }, 'refuse', /may still be running/]),
  ...['stopped', 'failed', 'done'].map(state => [state + ' unknown', { check: { known: true, state, workerLiveness: 'unknown' } }, 'respawn']),
  ...['running', 'working', 'blocked'].map(state => [state + ' dead', { check: { known: true, state, workerLiveness: 'dead' } }, 'respawn']),
  ['outside unknown', { elsewhere: [{ known: false, reason: 'process table unreadable' }] }, 'refuse', /process table unreadable/],
  ['outside live', { elsewhere: [{ known: true, live: { pid: 777 } }] }, 'refuse', /pid 777/],
]) {
  test('S2-T7 route row: ' + label, () => {
    const { respawnRoute } = require('../bg-handoff');
    const result = respawnRoute({ ...routeBase(), ...overrides });
    assert.equal(result.route, expected);
    if (reason) {
      assert.match(result.error, reason);
      assert.match(result.error, /^[A-Z].*\.$/);
    }
    if (expected === 'respawn') assert.equal(result.jobId, 'aaaaaaaa');
  });
}

test('S2b composer input during decideRoute refuses before writing', async () => {
  const h = setup();
  h.deps.decideRoute = async () => {
    await Promise.resolve();
    noteUserInput(h.session.composerState, 'x', 1);
    return { route: 'bg' };
  };
  assert.equal((await sendToBackground('old', h.deps)).code, 'refused');
  assert.deepEqual(h.writes, []);
});

test('S2b a replaced tab during decideRoute refuses before writing', async () => {
  const h = setup();
  h.deps.decideRoute = async () => {
    await Promise.resolve();
    h.deps.getSession = () => ({ kind: 'local-pty' });
    return { route: 'bg' };
  };
  assert.equal((await sendToBackground('old', h.deps)).code, 'refused');
  assert.deepEqual(h.writes, []);
});
