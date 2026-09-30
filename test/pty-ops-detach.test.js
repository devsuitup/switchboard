// see .ai/contexts/bg-agents.md
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detachPty } = require('../pty-ops');

function fakeSession() {
  const calls = { writes: [], kills: 0 };
  const session = { exited: false, pty: { write: (d) => calls.writes.push(d), kill: () => { calls.kills++; } } };
  return { session, calls };
}

test('detach writes Ctrl+Z and, when the client exits in time, never kills', () => {
  const { session, calls } = fakeSession();
  const timers = [];
  const ok = detachPty(session, 's1', { graceMs: 2000, schedule: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; } });
  assert.equal(ok, true);
  assert.deepEqual(calls.writes, ['\x1a']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  session.exited = true;
  timers[0].fn();
  assert.equal(calls.kills, 0);
});

test('detach kills once the grace period passes with the client still attached', () => {
  const { session, calls } = fakeSession();
  const timers = [];
  detachPty(session, 's1', { schedule: (fn) => { timers.push(fn); return {}; } });
  timers[0]();
  assert.equal(calls.kills, 1);
});

test('detach on a pty that refuses the write falls back to a kill', () => {
  const calls = { kills: 0 };
  const session = { exited: false, pty: { write: () => { throw new Error('closed'); }, kill: () => { calls.kills++; } } };
  const ok = detachPty(session, 's1', { schedule: () => { throw new Error('must not schedule'); } });
  assert.equal(ok, true);
  assert.equal(calls.kills, 1);
});
