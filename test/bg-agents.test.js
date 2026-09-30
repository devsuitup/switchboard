// see .ai/contexts/bg-agents.md
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bgAgents = require('../bg-agents');

function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-bg-agents-')));
}
const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (ms) => new Promise(r => setTimeout(r, ms));
function waitFor(fn, maxMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (fn()) return resolve();
      if (Date.now() - start > maxMs) return reject(new Error('timed out'));
      setTimeout(poll, 20);
    })();
  });
}

function writeJob(dir, id, state) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'state.json'), JSON.stringify(state), 'utf8');
}

const CLI_LIST = [
  { id: 'aaaaaaaa', sessionId: 's-a', name: 'a', cwd: '/a', kind: 'background', startedAt: 1, state: 'working', status: 'idle', pid: 10 },
  { id: 'bbbbbbbb', sessionId: 's-b', name: 'b', cwd: '/b', kind: 'background', startedAt: 2, state: 'done' },
];

function fakeCli(overrides = {}) {
  const calls = [];
  const runClaude = async (argv, opts) => {
    calls.push({ argv, opts });
    if (overrides.fail) return { code: 1, stdout: '', stderr: 'boom' };
    if (argv[0] === 'agents') return { code: 0, stdout: JSON.stringify(overrides.list || CLI_LIST), stderr: '' };
    if (argv[0] === '--bg') return { code: 0, stdout: 'Started background session cccccccc\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, runClaude };
}

function fakeSessionState(descriptors = []) {
  const listeners = new Set();
  return {
    listeners,
    onDescriptorsChanged: (l) => { listeners.add(l); return () => listeners.delete(l); },
    readAllDescriptors: () => descriptors,
    ensureWatching: () => true,
    fire() { for (const l of listeners) l(); },
  };
}

function boot(dir, { cli = fakeCli(), sessionState = fakeSessionState(), attached = () => false } = {}) {
  bgAgents.init({
    jobsDir: dir, log: silentLog, runClaude: cli.runClaude, cliSessionState: sessionState,
    makeIsOwnPid: () => () => false, isAttachedHere: attached,
  });
  return { cli, sessionState };
}

test.afterEach(() => bgAgents.stop());

test('reconcile runs `claude agents --json --all`, merges the job files, and reports the daemon reachable', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working', detail: 'reading rules', tokens: 42 });
    const { cli } = boot(dir);
    assert.equal(bgAgents.start(), true);
    const snap = await bgAgents.reconcile();
    assert.deepEqual(cli.calls[0].argv, ['agents', '--json', '--all']);
    assert.equal(cli.calls[0].opts.timeout, bgAgents.LIST_TIMEOUT_MS);
    assert.equal(snap.daemonReachable, true);
    assert.deepEqual(snap.roster.map(e => e.id), ['aaaaaaaa', 'bbbbbbbb']);
    assert.equal(snap.roster[0].detail, 'reading rules');
    assert.equal(snap.roster[0].tokens, 42);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a state.json rewrite reaches listeners once, coalesced, without another CLI call', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working', detail: 'one' });
    const { cli } = boot(dir);
    bgAgents.start();
    await bgAgents.reconcile();
    const seen = [];
    bgAgents.onChange((snap) => seen.push(snap.roster.find(e => e.id === 'aaaaaaaa').detail));
    const callsBefore = cli.calls.length;
    writeJob(dir, 'aaaaaaaa', { state: 'working', detail: 'two' });
    await waitFor(() => seen.includes('two'));
    await delay(bgAgents.FLUSH_MS * 2);
    assert.deepEqual(seen, ['two']);
    assert.equal(cli.calls.length, callsBefore, 'a file change never spawns the CLI');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a job directory that appears after start is watched too', async () => {
  const dir = mkTmp();
  try {
    boot(dir);
    bgAgents.start();
    await bgAgents.reconcile();
    const seen = [];
    bgAgents.onChange((snap) => seen.push((snap.roster.find(e => e.id === 'bbbbbbbb') || {}).detail));
    writeJob(dir, 'bbbbbbbb', { state: 'done', detail: 'late' });
    await waitFor(() => seen.includes('late'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an empty state.json (mid-rewrite) keeps the previous value', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working', detail: 'kept' });
    boot(dir);
    bgAgents.start();
    await bgAgents.reconcile();
    fs.writeFileSync(path.join(dir, 'aaaaaaaa', 'state.json'), '', 'utf8');
    await delay(bgAgents.FLUSH_MS * 3);
    assert.equal(bgAgents.getSnapshot().roster[0].detail, 'kept');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a descriptor change rebuilds the roster from readAllDescriptors', async () => {
  const dir = mkTmp();
  try {
    const descriptors = [];
    const sessionState = fakeSessionState(descriptors);
    boot(dir, { sessionState });
    bgAgents.start();
    await bgAgents.reconcile();
    const seen = [];
    bgAgents.onChange((snap) => seen.push(snap.roster.map(e => e.sessionId).join(',')));
    descriptors.push({ pid: 30, sessionId: 's-ext', kind: 'interactive', jobId: null, agent: null, name: 'ext', cwd: '/e', status: 'busy', startedAt: 3 });
    sessionState.fire();
    await waitFor(() => seen.some(s => s.includes('s-ext')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('when the CLI fails the roster comes from the files and the daemon is reported unreachable', async () => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'cccccccc', { state: 'stopped', detail: 'from disk' });
    boot(dir, { cli: fakeCli({ fail: true }) });
    bgAgents.start();
    const snap = await bgAgents.reconcile();
    assert.equal(snap.daemonReachable, false);
    assert.deepEqual(snap.roster.map(e => e.id), ['cccccccc']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerb spawns `claude <verb> <id>` in the session cwd when it exists, then reconciles', async () => {
  const dir = mkTmp();
  try {
    const list = [{ ...CLI_LIST[0], cwd: dir }];
    const { cli } = boot(dir, { cli: fakeCli({ list }) });
    bgAgents.start();
    await bgAgents.reconcile();
    const r = await bgAgents.runVerb('stop', 'aaaaaaaa');
    assert.deepEqual(r, { ok: true });
    const verbCall = cli.calls.find(c => c.argv[0] === 'stop');
    assert.deepEqual(verbCall.argv, ['stop', 'aaaaaaaa']);
    assert.equal(verbCall.opts.cwd, dir);
    assert.equal(verbCall.opts.timeout, bgAgents.VERB_TIMEOUT_MS);
    assert.equal(cli.calls[cli.calls.length - 1].argv[0], 'agents', 'a verb is followed by a reconcile');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerb refuses an unknown verb or a malformed id before spawning anything', async () => {
  const dir = mkTmp();
  try {
    const { cli } = boot(dir);
    bgAgents.start();
    assert.equal((await bgAgents.runVerb('kill', 'aaaaaaaa')).ok, false);
    assert.equal((await bgAgents.runVerb('stop', '--all')).ok, false);
    assert.equal((await bgAgents.runVerb('rm', 'AAAAAAAA')).ok, false);
    assert.equal(cli.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerb reports the CLI stderr when it fails', async () => {
  const dir = mkTmp();
  try {
    boot(dir, { cli: fakeCli({ fail: true }) });
    bgAgents.start();
    const r = await bgAgents.runVerb('rm', 'aaaaaaaa');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'boom');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerb strips the login-shell job-control noise from the CLI stderr it reports', async () => {
  const dir = mkTmp();
  try {
    const stderr = 'bash: cannot set terminal process group (-1): Inappropriate ioctl for device\nbash: no job control in this shell\nError: no such session\n';
    const runClaude = async (argv) => (argv[0] === 'agents'
      ? { code: 0, stdout: JSON.stringify(CLI_LIST), stderr: '' }
      : { code: 1, stdout: '', stderr });
    boot(dir, { cli: { calls: [], runClaude } });
    bgAgents.start();
    const r = await bgAgents.runVerb('rm', 'bbbbbbbb');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Error: no such session');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a reconcile tolerates login-shell noise printed before the JSON list', async () => {
  const dir = mkTmp();
  try {
    const runClaude = async () => ({ code: 0, stdout: 'Now using node v22\n' + JSON.stringify(CLI_LIST), stderr: '' });
    boot(dir, { cli: { calls: [], runClaude } });
    bgAgents.start();
    const snap = await bgAgents.reconcile();
    assert.equal(snap.daemonReachable, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dispatch runs `claude --bg …` in the project directory and returns the printed id', async () => {
  const dir = mkTmp();
  try {
    const { cli } = boot(dir);
    bgAgents.start();
    const r = await bgAgents.dispatch({ prompt: 'hello', name: 'n', cwd: dir });
    assert.deepEqual(r, { ok: true, id: 'cccccccc' });
    const call = cli.calls.find(c => c.argv[0] === '--bg');
    assert.deepEqual(call.argv, ['--bg', '--name', 'n', 'hello']);
    assert.equal(call.opts.cwd, dir);
    const missing = await bgAgents.dispatch({ prompt: 'hello', cwd: path.join(dir, 'nope') });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no longer exists/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function trackWatchers(t) {
  const open = new Set();
  const real = fs.watch;
  t.mock.method(fs, 'watch', (...args) => {
    const w = real.apply(fs, args);
    open.add(w);
    const close = w.close.bind(w);
    w.close = () => { open.delete(w); close(); };
    return w;
  });
  return open;
}

test('stop closes every watcher it opened', async (t) => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working' });
    writeJob(dir, 'bbbbbbbb', { state: 'done' });
    const open = trackWatchers(t);
    boot(dir);
    bgAgents.start();
    assert.equal(open.size, 3);
    bgAgents.stop();
    assert.equal(open.size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a reconcile still running when stop() is called arms nothing and restores nothing', async (t) => {
  const dir = mkTmp();
  try {
    writeJob(dir, 'aaaaaaaa', { state: 'working' });
    writeJob(dir, 'bbbbbbbb', { state: 'done' });
    const open = trackWatchers(t);
    let release;
    const gate = new Promise(r => { release = r; });
    const runClaude = async () => { await gate; return { code: 0, stdout: JSON.stringify(CLI_LIST), stderr: '' }; };
    boot(dir, { cli: { runClaude, calls: [] } });
    bgAgents.start();
    const pending = bgAgents.reconcile();
    bgAgents.stop();
    assert.equal(open.size, 0);
    release();
    const snap = await pending;
    assert.equal(open.size, 0, 'no watcher armed after stop');
    assert.equal(snap.daemonReachable, false);
    assert.equal(bgAgents.getSnapshot().daemonReachable, false);
    assert.deepEqual(bgAgents.getSnapshot().roster, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const liveState of ['working', 'blocked']) {
  test(`runVerb refuses rm and respawn on a ${liveState} session but allows stop`, async () => {
    const dir = mkTmp();
    try {
      const list = [{ ...CLI_LIST[0], state: liveState, cwd: dir }];
      const { cli } = boot(dir, { cli: fakeCli({ list }) });
      bgAgents.start();
      await bgAgents.reconcile();
      const before = cli.calls.length;
      assert.equal((await bgAgents.runVerb('rm', 'aaaaaaaa')).ok, false);
      assert.equal((await bgAgents.runVerb('respawn', 'aaaaaaaa')).ok, false);
      assert.equal(cli.calls.length, before);
      assert.equal((await bgAgents.runVerb('stop', 'aaaaaaaa')).ok, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
