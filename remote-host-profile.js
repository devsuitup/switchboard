// see .ai/contexts/session-cache.md ("Remote hosts — capability tiers")
'use strict';

const { parseTmuxField, isValidPid } = require('./remote-attach');

const TIERS = ['observe', 'liveness', 'inject', 'attach', 'launch'];

function hasPosixSocketPath(descriptor) {
  const p = descriptor && descriptor.messagingSocketPath;
  return typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && !p.includes('\\');
}

function namesTmuxPane(descriptor) {
  return !!(descriptor && parseTmuxField(descriptor.tmux) && isValidPid(descriptor.pid));
}

/**
 * Highest capability tier of a host, from what its last refresh cycle knew.
 * input: { at: epoch ms of the last successful cycle | null,
 *          error: last cycle's error message | null,
 *          descriptors: live session descriptors of that cycle }
 * -> { tier: 'none' | a TIERS name,
 *      tiers: [{ tier, available, reason }],
 *      missing: [{ tier, reason }] for every tier above `tier` }
 */
function computeHostProfile(input) {
  const { at, error } = input || {};
  const descriptors = Array.isArray(input && input.descriptors) ? input.descriptors.filter(d => d && typeof d === 'object') : [];

  let blocked = null;
  if (error) blocked = `last refresh of this host failed: ${error}`;
  else if (!Number.isFinite(at)) blocked = 'not yet synced with this host';

  const reasons = {};
  if (blocked) {
    for (const tier of TIERS) reasons[tier] = blocked;
  } else {
    reasons.observe = null;
    reasons.liveness = descriptors.length > 0 ? null
      : 'no live session descriptor under ~/.claude/sessions on this host (one appears while a session runs)';
    reasons.inject = descriptors.some(hasPosixSocketPath) ? null
      : 'no live session reports a messagingSocketPath on a POSIX path';
    reasons.attach = descriptors.some(namesTmuxPane) ? null
      : 'no live session names a tmux pane in its descriptor (start it inside tmux)';
    reasons.launch = 'new sessions cannot be started from here; they must be started on the host';
  }

  const tiers = TIERS.map(tier => ({ tier, available: reasons[tier] === null, reason: reasons[tier] }));
  let top = -1;
  tiers.forEach((t, i) => { if (t.available) top = i; });
  return {
    tier: top === -1 ? 'none' : TIERS[top],
    tiers,
    missing: tiers.slice(top + 1).map(t => ({ tier: t.tier, reason: t.reason })),
  };
}

function isTierAvailable(profile, tier) {
  const hit = profile && Array.isArray(profile.tiers) && profile.tiers.find(t => t.tier === tier);
  return !!(hit && hit.available);
}

function tierReason(profile, tier) {
  const hit = profile && Array.isArray(profile.tiers) && profile.tiers.find(t => t.tier === tier);
  return hit && hit.reason ? hit.reason : null;
}

module.exports = { computeHostProfile, isTierAvailable, tierReason, TIERS };
