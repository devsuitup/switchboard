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
    readProcStart: opts.readProcStart,
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
    assert.deepEqual(cliSessionState.getStatus('sess-1'), { status: 'busy', statusUpdatedAt: 1000 });

    writeState(dir, 4242, { status: 'idle', statusUpdatedAt: 2000 });
    await waitFor(() => cliSessionState.getStatus('sess-1').status === 'idle');
    assert.deepEqual(cliSessionState.getStatus('sess-1'), { status: 'idle', statusUpdatedAt: 2000 });
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
    assert.deepEqual(cliSessionState.getStatus('somebody-elses-session'), { status: 'busy', statusUpdatedAt: 42 });
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

test('getStatus returns undefined once the descriptor file is removed', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'idle', statusUpdatedAt: 1000 });
    boot(dir, oneSession());
    await waitFor(() => cliSessionState.getStatus('sess-1') !== undefined);

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
    pid: 1, sessionId: 'a', status: 'idle', statusUpdatedAt: 5, procStart: '7',
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
    assert.deepEqual(cliSessionState.getStatus('sess-1'), { status: 'busy', statusUpdatedAt: 1000 },
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
    assert.deepEqual(all[0], { pid: 10, sessionId: 'sess-1', kind: 'bg', jobId: 'bc3fd129', agent: 'fleet:em', name: 'em', cwd: dir, status: 'idle', startedAt: 5 });
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
