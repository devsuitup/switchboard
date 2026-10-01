'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeHostProfile, attachBlockReason, ATTACH_BLOCK_AFTER_FAILURES, TIERS } = require('../remote-host-profile');

const AT = Date.parse('2026-10-01T10:00:00Z');
const tmuxDescriptor = { pid: 101, sessionId: 'a', tmux: 'main:@0.%0' };
const socketDescriptor = { pid: 102, sessionId: 'b', messagingSocketPath: '/run/user/1000/claude-102.sock' };

function reasonFor(profile, tier) {
  const hit = profile.missing.find(m => m.tier === tier);
  return hit ? hit.reason : undefined;
}

test('the tiers are ordered observe < liveness < inject < attach < launch', () => {
  assert.deepEqual(TIERS, ['observe', 'liveness', 'inject', 'attach', 'launch']);
});

test('a host never synced has no tier and every tier says it was not synced', () => {
  const profile = computeHostProfile({ at: null, error: null, descriptors: [] });
  assert.equal(profile.tier, 'none');
  assert.deepEqual(profile.missing.map(m => m.tier), TIERS);
  assert.match(reasonFor(profile, 'observe'), /not yet synced/);
});

test('a host whose last cycle failed has no tier and the ssh error is the reason of every tier', () => {
  const profile = computeHostProfile({ at: AT, error: 'connect timed out', descriptors: [tmuxDescriptor] });
  assert.equal(profile.tier, 'none');
  for (const tier of TIERS) assert.match(reasonFor(profile, tier), /connect timed out/);
});

test('a synced host with no live descriptor stops at observe and says why liveness is missing', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [] });
  assert.equal(profile.tier, 'observe');
  assert.deepEqual(profile.missing.map(m => m.tier), ['liveness', 'inject', 'attach', 'launch']);
  assert.match(reasonFor(profile, 'liveness'), /no live session descriptor/);
});

test('a live descriptor without socket or multiplexer reaches liveness only', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [{ pid: 7, sessionId: 'x' }] });
  assert.equal(profile.tier, 'liveness');
  assert.match(reasonFor(profile, 'inject'), /messagingSocketPath/);
  assert.match(reasonFor(profile, 'attach'), /tmux/);
});

test('a live descriptor naming a POSIX messagingSocketPath makes inject available', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [socketDescriptor] });
  assert.equal(profile.tier, 'inject');
  assert.deepEqual(profile.missing.map(m => m.tier), ['attach', 'launch']);
});

test('a messagingSocketPath that is not a POSIX absolute path does not count', () => {
  for (const bad of ['\\\\.\\pipe\\claude-1', 'relative/sock', '', 42, null]) {
    const profile = computeHostProfile({ at: AT, error: null, descriptors: [{ pid: 9, sessionId: 'x', messagingSocketPath: bad }] });
    assert.equal(profile.tier, 'liveness', JSON.stringify(bad));
  }
});

test('a descriptor naming a tmux pane makes attach available even without a socket', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [tmuxDescriptor] });
  assert.equal(profile.tier, 'attach');
  assert.deepEqual(profile.missing.map(m => m.tier), ['launch']);
});

test('the highest tier wins when several sessions bring different capabilities', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [socketDescriptor, tmuxDescriptor] });
  assert.equal(profile.tier, 'attach');
  assert.equal(profile.tiers.find(t => t.tier === 'inject').available, true);
});

test('a tmux descriptor with an invalid pid does not count', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [{ pid: 0, sessionId: 'x', tmux: 'main:@0.%0' }] });
  assert.equal(profile.tier, 'liveness');
});

test('launch is never available in this build and says to start the session on the host', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [tmuxDescriptor, socketDescriptor] });
  assert.match(reasonFor(profile, 'launch'), /started on the host/);
});

test('garbage input never throws and yields no tier', () => {
  assert.equal(computeHostProfile(undefined).tier, 'none');
  assert.equal(computeHostProfile({ at: AT, error: null, descriptors: 'nope' }).tier, 'observe');
  assert.equal(computeHostProfile({ at: AT, error: null, descriptors: [null, 3] }).tier, 'observe');
});

test('attach is blocked only from the third consecutive failure, with the last error as reason', () => {
  const profile = computeHostProfile({ at: AT, error: 'connect timed out', descriptors: [tmuxDescriptor] });
  assert.equal(ATTACH_BLOCK_AFTER_FAILURES, 3);
  assert.equal(attachBlockReason(profile, 1), null);
  assert.equal(attachBlockReason(profile, 2), null);
  assert.match(attachBlockReason(profile, 3), /connect timed out/);
  assert.match(attachBlockReason(profile, 9), /connect timed out/);
});

test('attach is never blocked on a host with no error, whatever the failure count', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [tmuxDescriptor] });
  assert.equal(attachBlockReason(profile, 5), null);
});
