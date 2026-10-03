// see .ai/contexts/session-cache.md ("Remote hosts — capability tiers")
'use strict';

const { parseTmuxField, isValidPid } = require('./remote-attach');

const ATTACH_BLOCK_AFTER_FAILURES = 3;
const TIERS = ['observe', 'liveness', 'inject', 'attach', 'launch'];
const LAUNCH_NEEDS_TMUX_REASON = 'needs tmux on the host';
const TMUX_MISSING_REASON = 'tmux is not installed on this host (command -v tmux found nothing)';

function hasPosixSocketPath(descriptor) {
  const p = descriptor && descriptor.messagingSocketPath;
  return typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && !p.includes('\\');
}

function namesTmuxPane(descriptor) {
  return !!(descriptor && parseTmuxField(descriptor.tmux) && isValidPid(descriptor.pid));
}

function toolFlag(value) {
  return value === true || value === false ? value : null;
}

function normalizeTools(tools) {
  const t = tools && typeof tools === 'object' ? tools : {};
  return { tmux: toolFlag(t.tmux), inotifywait: toolFlag(t.inotifywait) };
}

/**
 * Highest capability tier of a host, from what its last refresh cycle knew.
 * input: { at: epoch ms of the last successful cycle | null,
 *          error: last cycle's error message | null,
 *          descriptors: live session descriptors of that cycle,
 *          tools: { tmux, inotifywait } each true | false | null (unknown), from the probe }
 * -> { tier: 'none' | a TIERS name,
 *      blocked: why nothing could be read, or null,
 *      tools: the normalised probe result,
 *      tiers: [{ tier, available, reason }],
 *      missing: [{ tier, reason }] for every tier above `tier` }
 */
function computeHostProfile(input) {
  const { at, error } = input || {};
  const descriptors = Array.isArray(input && input.descriptors) ? input.descriptors.filter(d => d && typeof d === 'object') : [];
  const tools = normalizeTools(input && input.tools);

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
    if (tools.tmux === false) reasons.attach = TMUX_MISSING_REASON;
    else if (tools.tmux === true || descriptors.some(namesTmuxPane)) reasons.attach = null;
    else reasons.attach = 'no live session names a tmux pane in its descriptor (start it inside tmux)';
    if (tools.tmux === false) reasons.launch = LAUNCH_NEEDS_TMUX_REASON + ': ' + TMUX_MISSING_REASON;
    else if (tools.tmux === true || descriptors.some(namesTmuxPane)) reasons.launch = null;
    else reasons.launch = LAUNCH_NEEDS_TMUX_REASON + ' (not confirmed: no probe answer yet and no live session names a tmux pane)';
  }

  const tiers = TIERS.map(tier => ({ tier, available: reasons[tier] === null, reason: reasons[tier] }));
  let top = -1;
  tiers.forEach((t, i) => { if (t.available) top = i; });
  return {
    tier: top === -1 ? 'none' : TIERS[top],
    blocked,
    tools,
    tiers,
    missing: tiers.slice(top + 1).map(t => ({ tier: t.tier, reason: t.reason })),
  };
}

function tierReason(profile, tier) {
  const hit = profile && Array.isArray(profile.tiers) && profile.tiers.find(t => t.tier === tier);
  return hit && hit.reason ? hit.reason : null;
}

function attachBlockReason(profile, consecutiveFailures) {
  if (consecutiveFailures >= ATTACH_BLOCK_AFTER_FAILURES) return tierReason(profile, 'observe');
  if (profile && profile.tools && profile.tools.tmux === false) return TMUX_MISSING_REASON;
  return null;
}

function launchBlockReason(profile) {
  if (!profile) return 'not yet synced with this host';
  return tierReason(profile, 'launch');
}

function sendBlockReason(profile) {
  if (!profile || profile.blocked) return null;
  return tierReason(profile, 'inject');
}

module.exports = {
  computeHostProfile, attachBlockReason, sendBlockReason, launchBlockReason, ATTACH_BLOCK_AFTER_FAILURES, TIERS, TMUX_MISSING_REASON,
};
