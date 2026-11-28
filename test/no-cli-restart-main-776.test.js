'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createComposerState, noteUserInput } = require('../src/main/terminals/composer-state');
const { createNoCliRestart } = require('../src/main/terminals/no-cli-restart');

function harness({ status, mcp = 'listening', live = { known: true, live: null } } = {}) {
  const session = { kind: 'local-pty', exited: false, composerState: createComposerState(), pty: { pid: 101 } };
  const sessions = new Map([['a', session]]);
  const state = { status, mcp, live, scan: null };
  const stops = [];
  const restart = createNoCliRestart({
    sessions,
    getStatus: () => state.status,
    getMcpState: () => state.mcp,
    liveElsewhereChecked: async (id) => { if (state.scan) await state.scan; return typeof state.live === 'function' ? state.live(id) : state.live; },
    stop: (s, id) => { stops.push(id); s.exited = true; },
  });
  return { session, sessions, state, stops, restart };
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
