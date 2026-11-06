// test/cli-session-state.test.js — node:test suite for cli-session-state.js
//
// Strategy: real fs.watch in a mkdtemp sandbox, ctx injects the session map,
// the rescan callback and the liveness probe. See
// .ai/contexts/cli-session-state.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cliSessionState = require('../cli-session-state');

// Same Windows pitfall as trigger-watcher.test.js: os.tmpdir() can be an 8.3
// short name and fs.watch on one trips a libuv assertion.
function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cli-state-')));
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Long enough for a watch event plus FLUSH_MS to have gone through. */
const SETTLE_MS = 500;

function writeState(dir, pid, fields) {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: 'sess-1',
    cwd: dir,
    procStart: '111',
    version: '2.1.241',
    updatedAt: Date.now(),
    statusUpdatedAt: Date.now(),
    ...fields,
  }), 'utf8');
}

function waitFor(fn, maxMs = 4000, pollMs = 20) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (fn()) return resolve();
      if (Date.now() - start > maxMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, pollMs);
    })();
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/** Boot the watcher over `dir` with a spy rescan callback. */
function boot(dir, activeSessions, opts = {}) {
  const rescans = [];
  cliSessionState.init({
    dir,
    activeSessions,
    log: silentLog,
    isProcessAlive: opts.isProcessAlive || (() => true),
    now: opts.now,
    readProcStart: opts.readProcStart || (() => '111'),
    readParentPid: opts.readParentPid,
    ownPid: opts.ownPid,
    platform: opts.platform,
    onIdle: (sessionId, session) => rescans.push({ sessionId, session }),
  });
  const attached = cliSessionState.ensureWatching();
  return { rescans, attached };
}

function oneSession(fields = {}) {
  return new Map([['sess-1', { projectFolder: 'folder', ...fields }]]);
}

test.afterEach(() => cliSessionState.stop());

test('B-F3 worker evidence carries the table probe start time through an in-flight force read', async () => {
  const dir = mkTmp();
  let finish;
  try {
    let clock = 1000;
    let probes = 0;
    cliSessionState.init({ dir, platform: 'win32', log: silentLog, activeSessions: new Map(),
      now: () => clock, readProcessTable: async () => {
        if (++probes === 2) await new Promise(resolve => { finish = resolve; });
        return new Map([[99, { ppid: 1, created: 1n }]]);
      } });
    await cliSessionState.refreshProcessTable();
    const first = cliSessionState.readWorkerProcessEvidence();
    clock = 1100;
    const pending = cliSessionState.refreshProcessTable({ force: true });
    clock = 1200;
    await cliSessionState.refreshProcessTable();
    const cached = cliSessionState.readWorkerProcessEvidence();
    clock = 2200;
    const confirmation = cliSessionState.refreshProcessTable({ force: true });
    finish();
    await Promise.all([pending, confirmation]);
    const second = cliSessionState.readWorkerProcessEvidence();
    assert.equal(first.observedAt, 1000);
    assert.equal(cached.observedAt, 1000);
    assert.equal(second.observedAt, 1100);
    assert.equal(probes, 2);
  } finally {
    finish?.();
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseState carries a non-empty waitingFor string and normalizes other values to null', () => {
  for (const waitingFor of ['permission prompt', 'question', '', null, undefined, 42, {}, []]) {
    const state = cliSessionState.parseState(JSON.stringify({ pid: 4242, sessionId: 'sess-1',
      status: 'waiting', waitingFor }));
    assert.equal(state.waitingFor, typeof waitingFor === 'string' && waitingFor ? waitingFor : null);
  }
});

test('getStatus preserves the seeded waiting reason and clears it on a later descriptor write', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'waiting', statusUpdatedAt: 1000, waitingFor: 'permission prompt' });
    boot(dir, oneSession());
    assert.deepEqual(cliSessionState.getStatus('sess-1'),
      { status: 'waiting', statusUpdatedAt: 1000, waitingFor: 'permission prompt' });
    writeState(dir, 4242, { status: 'waiting', statusUpdatedAt: 1000, waitingFor: 42 });
    await waitFor(() => cliSessionState.getStatus('sess-1')?.waitingFor === null);
    assert.deepEqual(cliSessionState.getStatus('sess-1'),
      { status: 'waiting', statusUpdatedAt: 1000, waitingFor: null });
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a waiting reason-only change notifies sidebar status subscribers without an idle rescan', async () => {
  const dir = mkTmp();
  let off = () => {};
  try {
    writeState(dir, 4242, { status: 'waiting', statusUpdatedAt: 1000, waitingFor: 'permission prompt' });
    const { rescans } = boot(dir, oneSession());
    const changes = [];
    off = cliSessionState.onStatusesChanged(() => changes.push(cliSessionState.getStatus('sess-1')));
    writeState(dir, 4242, { status: 'waiting', statusUpdatedAt: 1000, waitingFor: 'question' });
    await waitFor(() => changes.length > 0);
    assert.deepEqual(changes.at(-1), { status: 'waiting', statusUpdatedAt: 1000, waitingFor: 'question' });
    assert.equal(rescans.length, 0);
  } finally {
    off();
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy → idle transition rescans the matching session immediately', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans, attached } = boot(dir, oneSession());
    assert.equal(attached, true, 'the watcher must attach to an existing directory');

    writeState(dir, 4242, { status: 'idle' });
    await waitFor(() => rescans.length === 1);
    assert.equal(rescans[0].sessionId, 'sess-1');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a descriptor whose id differs only in case still rescans the app session, under the app id', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy', sessionId: 'SESS-1' });
    const { rescans } = boot(dir, oneSession());
    writeState(dir, 4242, { status: 'idle', sessionId: 'SESS-1' });
    await waitFor(() => rescans.length === 1);
    assert.equal(rescans[0].sessionId, 'sess-1');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an uppercase descriptor is found under the lowercase id, and forgotten when its file goes and PID exits', async () => {
  const dir = mkTmp();
  let alive = true;
  try {
    writeState(dir, 4242, { status: 'busy', sessionId: 'SESS-1' });
    boot(dir, oneSession(), { isProcessAlive: () => alive });
    writeState(dir, 4242, { status: 'idle', sessionId: 'SESS-1' });
    await waitFor(() => cliSessionState.getStatus('sess-1')?.status === 'idle');
    alive = false;
    fs.rmSync(path.join(dir, '4242.json'));
    await waitFor(() => cliSessionState.getStatus('sess-1') === undefined);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waiting and shell never rescan — only idle does', async () => {
  // The CLI reports four statuses. Only idle means "the turn is over"; waiting
  // is a permission prompt and shell is a suspended session, both of which can
  // still have live subagents behind them.
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession());

    writeState(dir, 4242, { status: 'waiting' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'waiting must not rescan');

    writeState(dir, 4242, { status: 'shell' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'shell must not rescan');

    // Positive control: the harness is wired, the two silences above were real.
    writeState(dir, 4242, { status: 'idle' });
    await waitFor(() => rescans.length === 1);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead pid never rescans', async () => {
  // status is written on change, not on a heartbeat: a killed CLI leaves its
  // last status engraved. Nothing stale may drive a rescan.
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession(), { isProcessAlive: () => false });

    writeState(dir, 4242, { status: 'idle' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'a state file whose process is gone must be inert');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reused pid is treated as a new process, not as a transition', async () => {
  // <pid>.json is keyed by pid alone. A second CLI landing on the same pid
  // would otherwise read as "the previous process just went idle".
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy', procStart: 'A' });
    const { rescans } = boot(dir, oneSession());

    writeState(dir, 4242, { status: 'idle', procStart: 'B' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'a different procStart is a different process');

    // The new process gets its own baseline, and its own transitions work.
    writeState(dir, 4242, { status: 'busy', procStart: 'B' });
    await delay(SETTLE_MS);
    writeState(dir, 4242, { status: 'idle', procStart: 'B' });
    await waitFor(() => rescans.length === 1);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated or malformed file is ignored without throwing', async () => {
  // The CLI does not write this file atomically, so a read can land mid-write.
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession());

    fs.writeFileSync(path.join(dir, '4242.json'), '{"pid":4242,"status":"id', 'utf8');
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'a half-written file must not rescan');

    fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({ status: 'idle' }), 'utf8');
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'a file missing pid/sessionId must not rescan');

    writeState(dir, 4242, { status: 'idle' });
    await waitFor(() => rescans.length === 1, 4000);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown status is ignored and does not break the following transition', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession());

    writeState(dir, 4242, { status: 'hibernating' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'an unknown status must not rescan');

    writeState(dir, 4242, { status: 'idle' });
    await waitFor(() => rescans.length === 1);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a state file with no matching Switchboard session rescans nothing', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy', sessionId: 'somebody-elses-session' });
    const { rescans } = boot(dir, oneSession());

    writeState(dir, 4242, { status: 'idle', sessionId: 'somebody-elses-session' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'an unrelated CLI must not drive our sessions');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a forked session matches on realSessionId, not on its map key', async () => {
  // After a fork the CLI writes the new id while activeSessions is still keyed
  // by the old one — matching on the key alone would silently stop working for
  // every forked or resumed session.
  const dir = mkTmp();
  const activeSessions = new Map([
    ['old-id', { projectFolder: 'folder', realSessionId: 'new-id' }],
  ]);
  try {
    writeState(dir, 4242, { status: 'busy', sessionId: 'new-id' });
    const { rescans } = boot(dir, activeSessions);

    writeState(dir, 4242, { status: 'idle', sessionId: 'new-id' });
    await waitFor(() => rescans.length === 1);
    assert.equal(rescans[0].sessionId, 'new-id',
      'the rescan must target the id the subagent directory is named after');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exited and plain-terminal sessions are never rescanned', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession({ exited: true }));

    writeState(dir, 4242, { status: 'idle' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'an exited session has nothing left to scan');

    cliSessionState.stop();
    const second = boot(dir, oneSession({ isPlainTerminal: true }));
    writeState(dir, 4242, { status: 'busy' });
    await delay(SETTLE_MS);
    writeState(dir, 4242, { status: 'idle' });
    await delay(SETTLE_MS);
    assert.equal(second.rescans.length, 0, 'a plain terminal has no subagents');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing directory attaches nothing and costs nothing', () => {
  const dir = path.join(mkTmp(), 'does-not-exist');
  const { attached } = boot(dir, oneSession());
  assert.equal(attached, false, 'no directory, no watcher, no polling fallback');
  cliSessionState.stop();
});

test('getStatus returns the last parsed status/statusUpdatedAt for a sessionId', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy', statusUpdatedAt: 1000 });
    boot(dir, oneSession());
    await waitFor(() => cliSessionState.getStatus('sess-1') !== undefined);
    assert.deepEqual(cliSessionState.getStatus('sess-1'), { status: 'busy', statusUpdatedAt: 1000, waitingFor: null });

    writeState(dir, 4242, { status: 'idle', statusUpdatedAt: 2000 });
    await waitFor(() => cliSessionState.getStatus('sess-1').status === 'idle');
    assert.deepEqual(cliSessionState.getStatus('sess-1'), { status: 'idle', statusUpdatedAt: 2000, waitingFor: null });
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus finds a descriptor whatever the case of the id it is asked with', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy', statusUpdatedAt: 1000 });
    boot(dir, oneSession());
    await waitFor(() => cliSessionState.getStatus('sess-1') !== undefined);
    assert.deepEqual(cliSessionState.getStatus('SESS-1'), { status: 'busy', statusUpdatedAt: 1000, waitingFor: null });
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus works for a CLI descriptor with no matching Switchboard session (started outside Switchboard)', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy', sessionId: 'somebody-elses-session', statusUpdatedAt: 42 });
    // No Switchboard session at all — findSession() would never match this,
    // but getStatus() is a pure sessionId lookup, independent of activeSessions.
    boot(dir, new Map());
    await waitFor(() => cliSessionState.getStatus('somebody-elses-session') !== undefined);
    assert.deepEqual(cliSessionState.getStatus('somebody-elses-session'), { status: 'busy', statusUpdatedAt: 42, waitingFor: null });
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus never surfaces a descriptor left behind by a crashed process (seeded at startup)', async () => {
  // The CLI deletes its state file on a clean exit only. A crash or a reboot
  // can leave one behind indefinitely, and it must never read as a live status.
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'idle', statusUpdatedAt: 1000 });
    boot(dir, oneSession(), { isProcessAlive: () => false });
    await delay(SETTLE_MS);
    assert.equal(cliSessionState.getStatus('sess-1'), undefined,
      'a dead pid must never surface a status, even when seeded at startup');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus never surfaces a descriptor left behind by a crashed process (written after the watcher started)', async () => {
  const dir = mkTmp();
  try {
    const { rescans } = boot(dir, oneSession(), { isProcessAlive: () => false });
    writeState(dir, 4242, { status: 'idle', statusUpdatedAt: 1000 });
    await delay(SETTLE_MS);
    assert.equal(cliSessionState.getStatus('sess-1'), undefined,
      'a dead pid written after the watcher started must never surface a status');
    assert.equal(rescans.length, 0, 'a dead pid must still never rescan either (unchanged behavior)');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus clears once a previously-live descriptor is next observed with a dead pid', async () => {
  const dir = mkTmp();
  let alive = true;
  try {
    writeState(dir, 4242, { status: 'busy', statusUpdatedAt: 1000 });
    boot(dir, oneSession(), { isProcessAlive: () => alive });
    await waitFor(() => cliSessionState.getStatus('sess-1') !== undefined);

    alive = false;
    writeState(dir, 4242, { status: 'idle', statusUpdatedAt: 2000 });
    await waitFor(() => cliSessionState.getStatus('sess-1') === undefined);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus returns undefined once the descriptor file is removed and its PID exits', async () => {
  const dir = mkTmp();
  let alive = true;
  try {
    writeState(dir, 4242, { status: 'idle', statusUpdatedAt: 1000 });
    boot(dir, oneSession(), { isProcessAlive: () => alive });
    await waitFor(() => cliSessionState.getStatus('sess-1') !== undefined);

    alive = false;
    fs.unlinkSync(path.join(dir, '4242.json'));
    await waitFor(() => cliSessionState.getStatus('sess-1') === undefined);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus returns undefined for an sessionId never seen and stop() clears it', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'idle', statusUpdatedAt: 1000 });
    boot(dir, oneSession());
    await waitFor(() => cliSessionState.getStatus('sess-1') !== undefined);
    assert.equal(cliSessionState.getStatus('unknown-session'), undefined);

    cliSessionState.stop();
    assert.equal(cliSessionState.getStatus('sess-1'), undefined, 'stop() must clear the cache');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseState rejects everything that is not a usable state file', () => {
  const { parseState } = cliSessionState;
  assert.equal(parseState('not json'), null);
  assert.equal(parseState('null'), null);
  assert.equal(parseState('[]'), null, 'an array carries none of the fields');
  assert.equal(parseState(JSON.stringify({ sessionId: 'a', status: 'idle' })), null, 'no pid');
  assert.equal(parseState(JSON.stringify({ pid: 1, status: 'idle' })), null, 'no sessionId');
  assert.equal(parseState(JSON.stringify({ pid: 1, sessionId: 'a', status: 'nope' })), null);
  const ok = parseState(JSON.stringify({
    pid: 1, sessionId: 'a', status: 'idle', statusUpdatedAt: 5, procStart: 7,
  }));
  assert.deepEqual(ok, {
    pid: 1, sessionId: 'a', status: 'idle', statusUpdatedAt: 5, waitingFor: null, procStart: '7',
  });
});

// F2 (audit-fable-2026-09-11): a CLI killed without a clean exit never fires
// a file event, so getStatus() must re-probe liveness itself, throttled.
test('getStatus re-probes liveness lazily and drops a pid that died between two calls, more than 5s apart', async () => {
  const dir = mkTmp();
  let alive = true;
  let clock = 1_000_000;
  try {
    writeState(dir, 4242, { status: 'busy', statusUpdatedAt: 1000 });
    boot(dir, oneSession(), { isProcessAlive: () => alive, now: () => clock });
    await waitFor(() => cliSessionState.getStatus('sess-1') !== undefined);

    alive = false;
    clock += 5000; // exactly at the throttle boundary — re-probe fires
    assert.equal(cliSessionState.getStatus('sess-1'), undefined,
      'a pid that died since the last probe must be dropped on the next getStatus() past the throttle');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus keeps returning the cached status within the 5s probe throttle even after the pid dies', async () => {
  const dir = mkTmp();
  let alive = true;
  let clock = 1_000_000;
  try {
    writeState(dir, 4242, { status: 'busy', statusUpdatedAt: 1000 });
    boot(dir, oneSession(), { isProcessAlive: () => alive, now: () => clock });
    await waitFor(() => cliSessionState.getStatus('sess-1') !== undefined);

    alive = false;
    clock += 4999; // still inside the throttle window — no re-probe
    assert.deepEqual(cliSessionState.getStatus('sess-1'), { status: 'busy', statusUpdatedAt: 1000, waitingFor: null },
      'within the throttle window the cached status must be served without probing');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Descriptor hooks for the agents view (see .ai/contexts/bg-agents.md) ---

test('onDescriptorsChanged fires once per flushed batch, and the unsubscribe stops it', async () => {
  const dir = mkTmp();
  try {
    boot(dir, oneSession());
    let fired = 0;
    const off = cliSessionState.onDescriptorsChanged(() => { fired++; });
    writeState(dir, 4242, { status: 'busy', kind: 'bg', jobId: 'aaaaaaaa' });
    writeState(dir, 4243, { status: 'idle', sessionId: 'sess-2' });
    await waitFor(() => fired >= 1);
    await delay(SETTLE_MS);
    assert.equal(fired, 1, 'two writes inside one FLUSH_MS window are one notification');
    off();
    writeState(dir, 4242, { status: 'idle', kind: 'bg', jobId: 'aaaaaaaa' });
    await delay(SETTLE_MS);
    assert.equal(fired, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readAllDescriptors returns the live descriptors with their kind, jobId and agent', () => {
  const dir = mkTmp();
  try {
    writeState(dir, 10, { status: 'idle', kind: 'bg', jobId: 'bc3fd129', agent: 'fleet:em', name: 'em', startedAt: 5 });
    writeState(dir, 11, { status: 'busy', kind: 'interactive', sessionId: 'sess-2' });
    writeState(dir, 12, { status: 'busy', kind: 'interactive', sessionId: 'sess-dead' });
    fs.writeFileSync(path.join(dir, '13.json'), '{not json', 'utf8');
    boot(dir, oneSession(), { isProcessAlive: (pid) => pid !== 12 });
    const all = cliSessionState.readAllDescriptors().sort((a, b) => a.pid - b.pid);
    assert.deepEqual(all.map(d => d.pid), [10, 11]);
    assert.deepEqual(all[0], { pid: 10, sessionId: 'sess-1', bridgeSessionId: null, kind: 'bg', jobId: 'bc3fd129', agent: 'fleet:em', name: 'em', cwd: dir, status: 'idle', startedAt: 5 });
    assert.equal(all[1].kind, 'interactive');
    assert.equal(all[1].jobId, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('liveElsewhere reports the descriptor kind and jobId, so a bg session can be attached instead of resumed', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'idle', kind: 'bg', jobId: 'bc3fd129' });
    boot(dir, new Map(), { readProcStart: () => '111', readParentPid: () => 1, ownPid: 99999, platform: 'linux' });
    const live = await cliSessionState.liveElsewhere('sess-1', () => false, () => []);
    assert.equal(live.pid, 4242);
    assert.equal(live.kind, 'bg');
    assert.equal(live.jobId, 'bc3fd129');
    writeState(dir, 4242, { status: 'idle' });
    const plain = await cliSessionState.liveElsewhere('sess-1', () => false, () => []);
    assert.equal(plain.kind, null);
    assert.equal(plain.jobId, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ownProcessFilter is exported and claims our own PTY pids', () => {
  const dir = mkTmp();
  try {
    boot(dir, new Map());
    const isOwn = cliSessionState.ownProcessFilter(() => [77]);
    assert.equal(isOwn(77), true);
    assert.equal(isOwn(78), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// see .ai/contexts/cli-session-state.md ("Owner of a /clear transcript")
test('clearOwner: walks the state file pid up to the PTY pid', () => {
  const dir = mkTmp();
  try {
    const parents = { 300: 200, 200: 100, 100: 1, 400: 1 };
    cliSessionState.init({
      dir, activeSessions: new Map(), log: silentLog,
      isProcessAlive: (pid) => pid !== 500,
      readProcStart: () => '111',
      readParentPid: (pid) => parents[pid] ?? null,
    });
    writeState(dir, 300, { sessionId: 'cleared', status: 'idle' });
    writeState(dir, 400, { sessionId: 'elsewhere', status: 'idle' });
    writeState(dir, 500, { sessionId: 'dead', status: 'idle' });
    writeState(dir, 600, { sessionId: 'no-proc', status: 'idle' });

    assert.equal(cliSessionState.clearOwner('cleared', 100), 'mine');
    assert.equal(cliSessionState.clearOwner('CLEARED', 100), 'mine', 'ids compare in any letter case, as elsewhere since #487');
    assert.equal(cliSessionState.clearOwner('cleared', 300), 'mine', 'the PTY runs claude itself');
    assert.equal(cliSessionState.clearOwner('elsewhere', 100), 'other');
    assert.equal(cliSessionState.clearOwner('dead', 100), 'pending', 'a dead pid is no owner');
    assert.equal(cliSessionState.clearOwner('absent', 100), 'pending');
    assert.equal(cliSessionState.clearOwner('no-proc', 100), 'unknown', 'parent unreadable');
    assert.equal(cliSessionState.clearOwner('cleared', undefined), 'pending', 'no PTY pid');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clearOwner: uses the Windows process table to identify the PTY owner', async () => {
  const dir = mkTmp();
  try {
    const created = n => String(134360000000000000n + BigInt(n) * 1000n);
    let reads = 0;
    cliSessionState.init({
      dir, activeSessions: new Map(), log: silentLog, platform: 'win32',
      isProcessAlive: pid => pid !== 500,
      readProcessTable: async () => {
        reads++;
        return new Map([
          [100, { ppid: 1, created: created(10) }],
          [200, { ppid: 100, created: created(20) }],
          [300, { ppid: 200, created: created(30) }],
          [400, { ppid: 1, created: created(40) }],
        ]);
      },
    });
    writeState(dir, 300, { sessionId: 'cleared', status: 'idle', pidDomain: 'win32:anchor', procStart: created(30) });
    writeState(dir, 400, { sessionId: 'elsewhere', status: 'idle', pidDomain: 'win32:anchor', procStart: created(40) });
    writeState(dir, 500, { sessionId: 'dead', status: 'idle' });
    writeState(dir, 600, { sessionId: 'no-proc', status: 'idle' });

    assert.equal(cliSessionState.clearOwner('cleared', 100), 'pending', 'the table has not arrived yet');
    await cliSessionState.refreshProcessTable();
    assert.equal(reads, 1);
    assert.equal(cliSessionState.clearOwner('cleared', 100), 'mine');
    assert.equal(cliSessionState.clearOwner('CLEARED', 100), 'mine');
    assert.equal(cliSessionState.clearOwner('cleared', 300), 'mine', 'the PTY runs the descriptor writer');
    assert.equal(cliSessionState.clearOwner('elsewhere', 100), 'other');
    assert.equal(cliSessionState.clearOwner('dead', 100), 'pending');
    assert.equal(cliSessionState.clearOwner('absent', 100), 'pending');
    assert.equal(cliSessionState.clearOwner('no-proc', 100), 'pending', 'the pid is absent from the table');
    assert.equal(cliSessionState.clearOwner('cleared', undefined), 'pending');
    writeState(dir, 300, { sessionId: 'cleared', status: 'idle', pidDomain: 'win32:anchor', procStart: created(100000) });
    assert.equal(cliSessionState.clearOwner('cleared', 100), 'other', 'a reused pid is not the descriptor writer');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Versioned session actions: raw descriptor liveness and sandbox writer observation ──
const { makeProc, HOST_NS } = require('./helpers/fake-proc');

const NS_BOX = 'pid:[4026532001]';
const SID = '01234567-89ab-cdef-0123-456789abcdef';

function v1Fixture(t, platform = 'linux') {
  const root = mkTmp();
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir);
  const proc = makeProc(path.join(root, 'proc'));
  cliSessionState.init({ dir, activeSessions: new Map(), log: silentLog, platform, isProcessAlive: () => false });
  t.after(() => { cliSessionState.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const f = { root, dir, proc, edges: { procRoot: proc.root } };
  f.descriptor = (inner, fields = {}) => fs.writeFileSync(path.join(dir, `${inner}.json`), JSON.stringify({
    pid: inner, sessionId: SID, kind: 'interactive', status: 'idle', statusUpdatedAt: 1000, procStart: '777', cwd: '/work', startedAt: 5, ...fields,
  }));
  // PTY 8000 -> bwrap 8100 -> host writer 9000 (inner pid 42 inside its own namespace)
  f.sandbox = () => {
    proc.add(8000, { start: '500', ppid: 1 });
    proc.add(8100, { start: '600', ppid: 8000 });
    proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 8100, ns: NS_BOX });
    f.descriptor(42);
  };
  return f;
}

test('v1 liveness: a namespace writer is live elsewhere although its raw PID is absent on the host', async (t) => {
  const f = v1Fixture(t);
  f.sandbox();
  f.proc.remove(8000).remove(8100);
  const verdict = await cliSessionState.liveElsewhereV1Checked(SID, f.edges);
  assert.equal(verdict.known, true);
  assert.equal(verdict.live.pid, 9000);
  assert.equal(verdict.live.rawPid, 42);
  assert.equal(verdict.live.kind, 'interactive');
});

test('v1 liveness: an unrelated host process at the raw PID with another start does not hide the writer', async (t) => {
  const f = v1Fixture(t);
  f.sandbox();
  f.proc.add(42, { start: '999' });
  const verdict = await cliSessionState.liveElsewhereV1Checked(SID, f.edges);
  assert.equal(verdict.known, true);
  assert.equal(verdict.live.pid, 9000);
});

test('v1 liveness: an unrelated local tab does not exclude the writer; the conversation own PTY does', async (t) => {
  const f = v1Fixture(t);
  f.sandbox();
  const other = await cliSessionState.liveElsewhereV1Checked(SID, { ...f.edges, ptyPids: () => [31337] });
  assert.equal(other.live.pid, 9000);
  const own = await cliSessionState.liveElsewhereV1Checked(SID, { ...f.edges, ptyPids: () => [8000] });
  assert.deepEqual(own, { known: true, live: null });
});

test('v1 liveness: an unresolved raw descriptor is never known absence', async (t) => {
  const cases = [
    ['inner pid mismatch', f => f.proc.add(9000, { nspid: [9000, 43], start: '777', ppid: 8100, ns: NS_BOX })],
    ['start mismatch', f => f.proc.add(9000, { nspid: [9000, 42], start: '778', ppid: 8100, ns: NS_BOX })],
    ['no host process', f => f.proc.remove(9000)],
    ['two matches', f => f.proc.add(9001, { nspid: [9001, 42], start: '777', ppid: 8100, ns: NS_BOX })],
    ['namespace unreadable', f => f.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 8100, ns: null })],
    ['procfs unreadable', f => { f.proc.add(7000, { start: '1' }); f.proc.unreadable(7000); }],
  ];
  for (const [name, arrange] of cases) {
    const f = v1Fixture(t);
    f.sandbox();
    arrange(f);
    const verdict = await cliSessionState.liveElsewhereV1Checked(SID, f.edges);
    assert.equal(verdict.known, false, name);
    assert.equal(typeof verdict.reason, 'string', name);
  }
});

test('v1 liveness: a descriptor that changes during revalidation and a scan past its deadline are unknown', async (t) => {
  const f = v1Fixture(t);
  f.sandbox();
  let reads = 0;
  const flipping = { ...fs, readFileSync: (file, enc) => {
    const text = fs.readFileSync(file, enc);
    if (String(file).endsWith('42.json') && ++reads > 1) return text.replace('"idle"', '"busy"');
    return text;
  } };
  const changed = await cliSessionState.liveElsewhereV1Checked(SID, { ...f.edges, fs: flipping });
  assert.equal(changed.known, false);
  let tickNow = 0;
  const late = await cliSessionState.liveElsewhereV1Checked(SID, { ...f.edges, now: () => (tickNow += 500), deadline: 800 });
  assert.equal(late.known, false);
});

test('v1 liveness: known absence needs a complete scan; other conversations and an empty directory are absence', async (t) => {
  const f = v1Fixture(t);
  assert.deepEqual(await cliSessionState.liveElsewhereV1Checked(SID, f.edges), { known: true, live: null });
  f.sandbox();
  f.descriptor(55, { sessionId: 'fedcba98-7654-3210-fedc-ba9876543210' });
  const other = await cliSessionState.liveElsewhereV1Checked('fedcba98-7654-3210-fedc-ba9876543211', f.edges);
  assert.deepEqual(other, { known: true, live: null });
  fs.writeFileSync(path.join(f.dir, '77.json'), '{not json');
  assert.equal((await cliSessionState.liveElsewhereV1Checked('fedcba98-7654-3210-fedc-ba9876543211', f.edges)).known, false);
});

test('v1 liveness: a background descriptor and a tracked schedule keep their kind', async (t) => {
  const f = v1Fixture(t);
  f.sandbox();
  f.descriptor(42, { kind: 'bg', jobId: 'job-1' });
  const verdict = await cliSessionState.liveElsewhereV1Checked(SID, f.edges);
  assert.equal(verdict.live.kind, 'bg');
  const g = v1Fixture(t);
  cliSessionState.trackScheduleRun(SID, Object.assign(new (require('node:events'))(), { pid: 12 }), '/work', 'nightly');
  const scheduled = await cliSessionState.liveElsewhereV1Checked(SID, g.edges);
  assert.equal(scheduled.live.kind, 'schedule');
});

test('v1 sandbox observation translates the namespace writer through verified host ancestry, with host N absent or occupied', async (t) => {
  for (const occupy of [false, true]) {
    const f = v1Fixture(t);
    f.sandbox();
    if (occupy) f.proc.add(42, { start: '999' });
    f.descriptor(42, { status: 'busy', statusUpdatedAt: 2222, waitingFor: 'x' });
    const seen = cliSessionState.observeSandboxWriterV1(8000, { sessionId: SID, ptyStart: '500', ...f.edges });
    assert.equal(seen.supported, true);
    assert.equal(seen.uncertain, false);
    assert.equal(seen.writer.sessionId, SID);
    assert.equal(seen.writer.hostPid, 9000);
    assert.equal(seen.writer.pid, 42, 'the raw namespace pid is kept apart from the host pid');
    assert.equal(seen.writer.status, 'busy');
    assert.equal(seen.writer.statusUpdatedAt, 2222);
    assert.equal(seen.writer.waitingFor, 'x');
    assert.match(seen.identity, /^8000:500:/);
  }
});

test('v1 sandbox observation proves nothing when ancestry, namespace, start or uniqueness evidence is missing', async (t) => {
  const cases = [
    ['pty start differs', f => ({ ptyStart: '501' })],
    ['writer outside the pty tree', f => { f.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 1, ns: NS_BOX }); return {}; }],
    ['writer in the host namespace', f => { f.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 8100, ns: HOST_NS }); f.proc.add(8000, { start: '500', ppid: 1, ns: HOST_NS }); return {}; }],
    ['second eligible writer', f => { f.proc.add(9100, { nspid: [9100, 43], start: '888', ppid: 8100, ns: NS_BOX }); f.descriptor(43, { procStart: '888' }); return {}; }],
    ['start mismatch', f => { f.proc.add(9000, { nspid: [9000, 42], start: '778', ppid: 8100, ns: NS_BOX }); return {}; }],
    ['child older than parent', f => { f.proc.add(8100, { start: '900', ppid: 8000 }); return {}; }],
    ['namespace unreadable', f => { f.proc.add(9000, { nspid: [9000, 42], start: '777', ppid: 8100, ns: null }); return {}; }],
  ];
  for (const [name, arrange] of cases) {
    const f = v1Fixture(t);
    f.sandbox();
    const extra = arrange(f) || {};
    const seen = cliSessionState.observeSandboxWriterV1(8000, { sessionId: SID, ptyStart: '500', ...extra, ...f.edges });
    assert.equal(seen.writer, undefined, name);
    if (name !== 'writer outside the pty tree') assert.equal(seen.uncertain, true, name);
  }
});

test('v1 sandbox observation ignores a descriptor of another sandbox with the same inner pid and a different start', async (t) => {
  const f = v1Fixture(t);
  f.sandbox();
  f.proc.add(9500, { nspid: [9500, 42], start: '1234', ppid: 1, ns: 'pid:[4026532999]' });
  const seen = cliSessionState.observeSandboxWriterV1(8000, { sessionId: SID, ptyStart: '500', ...f.edges });
  assert.equal(seen.writer.hostPid, 9000);
});

test('v1 readers leave the global status cache and legacy readers untouched', async (t) => {
  const f = v1Fixture(t);
  f.sandbox();
  assert.equal(cliSessionState.getStatus(SID), undefined);
  assert.deepEqual(cliSessionState.readAllDescriptors(), []);
});
