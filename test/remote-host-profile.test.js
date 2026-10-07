'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeHostProfile, attachBlockReason, sendBlockReason, launchBlockReason, ATTACH_BLOCK_AFTER_FAILURES, TIERS } = require('../remote-host-profile');

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

test('a host whose last cycle failed reads nothing and the ssh error is the reason of every tier but launch', () => {
  const profile = computeHostProfile({ at: AT, error: 'connect timed out', descriptors: [tmuxDescriptor] });
  assert.equal(profile.tier, 'launch');
  for (const tier of TIERS.filter(t => t !== 'launch')) assert.match(profile.tiers.find(x => x.tier === tier).reason, /connect timed out/);
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

test('a descriptor naming a tmux pane makes attach and launch available even without a socket', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [tmuxDescriptor] });
  assert.equal(profile.tier, 'launch');
  assert.deepEqual(profile.missing, []);
});

test('the highest tier wins when several sessions bring different capabilities', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [socketDescriptor, tmuxDescriptor] });
  assert.equal(profile.tier, 'launch');
  assert.equal(profile.tiers.find(t => t.tier === 'inject').available, true);
});

test('a tmux descriptor with an invalid pid does not count', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [{ pid: 0, sessionId: 'x', tmux: 'main:@0.%0' }] });
  assert.equal(profile.tier, 'liveness');
});

test('launch is available when the probe found tmux, with no live session at all', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [], tools: { tmux: true, inotifywait: false } });
  assert.equal(profile.tiers.find(t => t.tier === 'launch').available, true);
  assert.equal(profile.tier, 'launch');
});

test('launch is unavailable without tmux and says the host needs it', () => {
  const missing = computeHostProfile({ at: AT, error: null, descriptors: [tmuxDescriptor], tools: { tmux: false, inotifywait: true } });
  assert.equal(missing.tiers.find(t => t.tier === 'launch').available, false);
  assert.match(reasonFor(missing, 'launch'), /needs tmux on the host.*not installed/);
  const unknown = computeHostProfile({ at: AT, error: null, descriptors: [socketDescriptor] });
  assert.equal(unknown.tiers.find(t => t.tier === 'launch').available, false);
  assert.match(reasonFor(unknown, 'launch'), /needs tmux on the host/);
});

test('launchBlockReason refuses a host with no profile, a blocked one and one without tmux', () => {
  assert.match(launchBlockReason(null), /not yet synced/);
  assert.match(launchBlockReason(computeHostProfile({ at: null, error: null, descriptors: [] })), /not yet synced/);
  assert.match(launchBlockReason(computeHostProfile({ at: AT, error: null, descriptors: [], tools: { tmux: false } })), /needs tmux/);
  assert.equal(launchBlockReason(computeHostProfile({ at: AT, error: null, descriptors: [], tools: { tmux: true } })), null);
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

test('the tools default to unknown and a host without a probe keeps the descriptor-only profile', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [] });
  assert.deepEqual(profile.tools, { tmux: null, inotifywait: null });
  assert.equal(profile.tier, 'observe');
});

test('an idle synced host with tmux installed offers attach and no longer lists it as missing', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [], tools: { tmux: true, inotifywait: true } });
  assert.equal(profile.tiers.find(t => t.tier === 'attach').available, true);
  assert.equal(reasonFor(profile, 'attach'), undefined);
  assert.equal(profile.tier, 'launch');
});

test('an idle host with tmux installed still says liveness needs a live descriptor', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [], tools: { tmux: true, inotifywait: false } });
  assert.match(profile.tiers.find(t => t.tier === 'liveness').reason, /no live session descriptor/);
});

test('a host where tmux is not installed says so as the attach reason, even when a descriptor names a pane', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [tmuxDescriptor], tools: { tmux: false, inotifywait: true } });
  assert.equal(profile.tiers.find(t => t.tier === 'attach').available, false);
  assert.match(reasonFor(profile, 'attach'), /tmux is not installed/);
  assert.equal(profile.tier, 'liveness');
});

test('an unknown tool value is treated as unknown, never as installed or missing', () => {
  for (const bad of ['yes', 1, undefined, null, {}]) {
    const profile = computeHostProfile({ at: AT, error: null, descriptors: [], tools: { tmux: bad, inotifywait: bad } });
    assert.deepEqual(profile.tools, { tmux: null, inotifywait: null }, JSON.stringify(bad));
  }
  assert.deepEqual(computeHostProfile({ at: AT, error: null, descriptors: [], tools: 'nope' }).tools, { tmux: null, inotifywait: null });
});

test('a failed or unsynced host reports blocked and keeps the probe result for the gates', () => {
  const failed = computeHostProfile({ at: AT, error: 'connect timed out', descriptors: [], tools: { tmux: false, inotifywait: false } });
  assert.match(failed.blocked, /connect timed out/);
  assert.deepEqual(failed.tools, { tmux: false, inotifywait: false });
  assert.equal(computeHostProfile({ at: AT, error: null, descriptors: [] }).blocked, null);
  assert.match(computeHostProfile({ at: null, error: null, descriptors: [] }).blocked, /not yet synced/);
});

test('attach is withheld while tmux is known missing, from the first failure on, and the tmux reason wins below three failures', () => {
  const profile = computeHostProfile({ at: AT, error: 'connect timed out', descriptors: [tmuxDescriptor], tools: { tmux: false, inotifywait: null } });
  assert.match(attachBlockReason(profile, 0), /tmux is not installed/);
  assert.match(attachBlockReason(profile, 1), /tmux is not installed/);
  assert.match(attachBlockReason(profile, 3), /connect timed out/);
});

test('attach is not withheld when tmux is installed or unknown', () => {
  for (const tmux of [true, null]) {
    const profile = computeHostProfile({ at: AT, error: null, descriptors: [tmuxDescriptor], tools: { tmux, inotifywait: null } });
    assert.equal(attachBlockReason(profile, 0), null, String(tmux));
  }
});

test('send is withheld with the inject reason when a synced host has no messaging socket', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [tmuxDescriptor] });
  assert.match(sendBlockReason(profile), /messagingSocketPath/);
});

test('send is offered when the inject tier is available', () => {
  const profile = computeHostProfile({ at: AT, error: null, descriptors: [socketDescriptor] });
  assert.equal(sendBlockReason(profile), null);
});

test('send is never withheld by a failed or unsynced host: it runs its own ssh', () => {
  assert.equal(sendBlockReason(computeHostProfile({ at: AT, error: 'down', descriptors: [] })), null);
  assert.equal(sendBlockReason(computeHostProfile({ at: null, error: null, descriptors: [] })), null);
  assert.equal(sendBlockReason(undefined), null);
});

test('a failed last refresh does not disable launch: it runs its own ssh, like send', () => {
  const failed = { at: AT, error: 'connect timed out', descriptors: [] };
  const withTmux = computeHostProfile({ ...failed, tools: { tmux: true, inotifywait: true } });
  assert.equal(withTmux.tiers.find(t => t.tier === 'launch').available, true);
  assert.equal(launchBlockReason(withTmux), null);
  assert.match(withTmux.tiers.find(t => t.tier === 'observe').reason, /connect timed out/);
  assert.equal(computeHostProfile({ ...failed, descriptors: [tmuxDescriptor] }).tiers.find(t => t.tier === 'launch').available, true);
  assert.match(launchBlockReason(computeHostProfile({ ...failed, tools: { tmux: false } })), /needs tmux/);
  assert.match(launchBlockReason(computeHostProfile(failed)), /needs tmux/);
});

test('a host never synced still refuses launch with the not-synced reason', () => {
  const profile = computeHostProfile({ at: null, error: null, descriptors: [], tools: { tmux: true } });
  assert.match(launchBlockReason(profile), /not yet synced/);
});
