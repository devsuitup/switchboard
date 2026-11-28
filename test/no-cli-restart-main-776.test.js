'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createComposerState, noteUserInput } = require('../src/main/terminals/composer-state');
const { createNoCliRestart } = require('../src/main/terminals/no-cli-restart');
const { handleTerminalInput } = require('../src/main/terminals/terminal-input');

function harness({ status, mcp = 'listening', live = { known: true, live: null }, now = 1000000 } = {}) {
  const written = [];
  const session = { kind: 'local-pty', exited: false, composerState: createComposerState(), pty: { pid: 101, write: data => written.push(data) } };
  const sessions = new Map([['a', session]]);
  const state = { status, mcp, live, scan: null, now };
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
  handleTerminalInput(h.sessions, 'a', 'x\r', h.state.now - NO_CLI_RESTART_QUIET_MS + 1);
  assert.deepEqual(await h.restart.restart('a'), { ok: false, reason: 'recent-input' });
  assert.deepEqual(h.stops, []);
});

test('GIVEN the last input is older than the quiet window WHEN the restart is asked THEN main stops the PTY', async () => {
  const { NO_CLI_RESTART_QUIET_MS } = require('../src/main/terminals/no-cli-restart');
  assert.equal(NO_CLI_RESTART_QUIET_MS, 10000);
  const h = harness();
  handleTerminalInput(h.sessions, 'a', 'x\r', h.state.now - NO_CLI_RESTART_QUIET_MS);
  assert.deepEqual(await h.restart.restart('a'), { ok: true });
  assert.deepEqual(h.stops, ['a']);
});
