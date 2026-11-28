'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createComposerState, noteUserInput } = require('../src/main/terminals/composer-state');
const { createNoCliRestart } = require('../src/main/terminals/no-cli-restart');
const fs = require('node:fs');
const path = require('node:path');
const { handleTerminalInput } = require('../src/main/terminals/terminal-input');
const ptyOps = require('../src/main/terminals/pty-ops');
const { createLocalSessionHandle } = require('../src/main/triggers/trigger-context');
const { tryAcquireTabInput } = require('../src/main/terminals/tab-input-lock');

function harness({ status, mcp = 'listening', live = { known: true, live: null }, now = 1000000 } = {}) {
  const written = [];
  const session = { kind: 'local-pty', exited: false, composerState: createComposerState(), pty: { pid: 101, write: data => written.push(data) } };
  const sessions = new Map([['a', session]]);
  const state = { status, mcp, live, scan: null, now };
  if (typeof ptyOps.trackPtyWrites === 'function') ptyOps.trackPtyWrites(session, session.pty, () => state.now);
  const stops = [];
  const restart = createNoCliRestart({
    sessions,
    getStatus: () => state.status,
    getMcpState: () => state.mcp,
    liveElsewhereChecked: async (id) => { if (state.scan) await state.scan; return typeof state.live === 'function' ? state.live(id) : state.live; },
    stop: (s, id) => { stops.push(id); s.exited = true; },
    now: () => state.now,
  });
  return { session, sessions, state, stops, restart, written };
}

test('GIVEN a quiet PTY with no other process WHEN the restart is asked THEN main stops it and spends its restart', async () => {
  const h = harness();
  assert.deepEqual(await h.restart.restart('a'), { ok: true });
  assert.deepEqual(h.stops, ['a']);
  assert.equal(h.restart.spent('a'), true);
  assert.equal(h.restart.spent('A'), true);
});

test('GIVEN a restart already spent in this app run WHEN it is asked again THEN main refuses', async () => {
  const h = harness();
  await h.restart.restart('a');
  h.session.exited = false;
  assert.deepEqual(await h.restart.restart('a'), { ok: false, reason: 'spent' });
  assert.deepEqual(h.stops, ['a']);
});

for (const [name, arrange, reason] of [
  ['the prompt holds unsent text', h => noteUserInput(h.session.composerState, 'hi', 1), 'input-pending'],
  ['the descriptor says busy', h => { h.state.status = 'busy'; }, 'turn-open'],
  ['the descriptor says waiting', h => { h.state.status = 'waiting'; }, 'turn-open'],
  ['the CLI is connected', h => { h.state.mcp = 'connected'; }, 'connected'],
  ['another process runs the conversation', h => { h.state.live = { known: true, live: { pid: 999 } }; }, 'live-elsewhere'],
  ['the process scan cannot answer', h => { h.state.live = { known: false, reason: 'unreadable' }; }, 'live-unknown'],
  ['the process scan throws', h => { h.state.live = () => { throw new Error('boom'); }; }, 'live-unknown'],
  ['the PTY already exited', h => { h.session.exited = true; }, 'not-running'],
  ['the tab is an attach', h => { h.session.isAttach = true; }, 'not-eligible'],
]) {
  test(`GIVEN ${name} WHEN the restart is asked THEN main refuses without stopping and keeps the restart`, async () => {
    const h = harness();
    arrange(h);
    assert.deepEqual(await h.restart.restart('a'), { ok: false, reason });
    assert.deepEqual(h.stops, []);
    assert.equal(h.restart.spent('a'), false);
  });
}

for (const [name, interleave, reason] of [
  ['the user types', h => noteUserInput(h.session.composerState, 'x', 2), 'input-pending'],
  ['a turn starts', h => { h.state.status = 'busy'; }, 'turn-open'],
  ['the CLI connects', h => { h.state.mcp = 'connected'; }, 'connected'],
  ['the PTY is replaced', h => { h.sessions.set('a', { ...h.session }); }, 'changed'],
]) {
  test(`GIVEN ${name} while main scans for other processes WHEN the scan ends THEN main refuses without stopping`, async () => {
    const h = harness();
    let release;
    h.state.scan = new Promise(resolve => { release = resolve; });
    const pending = h.restart.restart('a');
    await new Promise(resolve => setImmediate(resolve));
    interleave(h);
    release();
    assert.deepEqual(await pending, { ok: false, reason });
    assert.deepEqual(h.stops, []);
  });
}

test('GIVEN a prompt typed and submitted while main scans WHEN the composer is empty again and busy is not reported yet THEN main refuses without stopping', async () => {
  const h = harness();
  let release;
  h.state.scan = new Promise(resolve => { release = resolve; });
  const pending = h.restart.restart('a');
  await new Promise(resolve => setImmediate(resolve));
  handleTerminalInput(h.sessions, 'a', 'fix the build', h.state.now + 1);
  handleTerminalInput(h.sessions, 'a', '\r', h.state.now + 2);
  assert.equal(h.session.composerState.pending, 0, 'the composer is empty again');
  assert.equal(h.state.status, undefined, 'busy has not reached the cache');
  release();
  assert.deepEqual(await pending, { ok: false, reason: 'input-during-attempt' });
  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.written, ['fix the build', '\r']);
});

test('GIVEN input reached the PTY within the quiet window before the attempt WHEN the restart is asked THEN main refuses', async () => {
  const { NO_CLI_RESTART_QUIET_MS } = require('../src/main/terminals/no-cli-restart');
  const h = harness();
  handleTerminalInput(h.sessions, 'a', 'x\r', h.state.now);
  h.state.now += NO_CLI_RESTART_QUIET_MS - 1;
  assert.deepEqual(await h.restart.restart('a'), { ok: false, reason: 'recent-input' });
  assert.deepEqual(h.stops, []);
});

test('GIVEN the last input is older than the quiet window WHEN the restart is asked THEN main stops the PTY', async () => {
  const { NO_CLI_RESTART_QUIET_MS } = require('../src/main/terminals/no-cli-restart');
  assert.equal(NO_CLI_RESTART_QUIET_MS, 10000);
  const h = harness();
  handleTerminalInput(h.sessions, 'a', 'x\r', h.state.now);
  h.state.now += NO_CLI_RESTART_QUIET_MS;
  assert.deepEqual(await h.restart.restart('a'), { ok: true });
  assert.deepEqual(h.stops, ['a']);
});

async function duringScan(h, act) {
  let release;
  h.state.scan = new Promise(resolve => { release = resolve; });
  const pending = h.restart.restart('a');
  await new Promise(resolve => setImmediate(resolve));
  act();
  release();
  return pending;
}

test('GIVEN a trigger injects and submits a prompt while main scans WHEN busy is not reported yet THEN main refuses without stopping', async () => {
  const h = harness();
  const reply = await duringScan(h, () => {
    h.state.now += 50;
    createLocalSessionHandle(h.session.pty).write('run the tests');
    createLocalSessionHandle(h.session.pty).write('\r');
  });
  assert.equal(h.session.composerState.pending, 0);
  assert.equal(reply.ok, false);
  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.written, ['run the tests', '\r']);
});

test('GIVEN a /bg-style write and submit while main scans WHEN the composer is empty again THEN main refuses without stopping', async () => {
  const h = harness();
  const reply = await duringScan(h, () => {
    h.state.now += 50;
    noteUserInput(h.session.composerState, '/bg', h.state.now);
    ptyOps.writePty(h.session, '/bg', 'a');
    noteUserInput(h.session.composerState, '\r', h.state.now);
    ptyOps.writePty(h.session, '\r', 'a');
  });
  assert.equal(h.session.composerState.pending, 0);
  assert.equal(reply.ok, false);
  assert.deepEqual(h.stops, []);
});

test('GIVEN a trigger injected a prompt just before the attempt WHEN the restart is asked THEN the quiet window refuses it', async () => {
  const h = harness();
  createLocalSessionHandle(h.session.pty).write('hello\r');
  h.state.now += 5000;
  assert.deepEqual(await h.restart.restart('a'), { ok: false, reason: 'recent-input' });
  assert.deepEqual(h.stops, []);
});

test('GIVEN a trigger or /bg holds the tab input lock WHEN the restart is asked THEN main refuses without stopping', async () => {
  const h = harness();
  const unlock = tryAcquireTabInput(h.session);
  try {
    assert.deepEqual(await h.restart.restart('a'), { ok: false, reason: 'input-locked' });
  } finally { unlock(); }
  assert.deepEqual(h.stops, []);
});

test('GIVEN a restart in progress WHEN a trigger or /bg tries to take the tab input lock during the scan THEN it cannot, and the lock is free after the stop', async () => {
  const h = harness();
  let during;
  const reply = await duringScan(h, () => { during = tryAcquireTabInput(h.session); });
  assert.equal(during, null);
  assert.deepEqual(reply, { ok: true });
  const after = tryAcquireTabInput(h.session);
  assert.equal(typeof after, 'function');
  after();
});

test('main wires the PTY write tracking where every session PTY is attached', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const wire = main.slice(main.indexOf('function wireSessionPty('), main.indexOf('function wireSessionPty(') + 600);
  assert.match(wire, /trackPtyWrites\(session, ptyProcess\);\s*session\.pty = ptyProcess;/);
  assert.match(main, /^const \{[^}]*\btrackPtyWrites\b[^}]*\} = require\('\.\/src\/main\/terminals\/pty-ops'\);/m);
});
