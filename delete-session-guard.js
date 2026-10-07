// delete-session-guard.js — see .ai/contexts/bg-agents.md ("Invariants")
'use strict';

async function deleteSessionRefusal(sessionId, { activeSessions, liveJobCheck, liveElsewhereChecked }) {
  const id = String(sessionId || '');
  const key = id.toLowerCase();
  const same = (v) => typeof v === 'string' && v.toLowerCase() === key;
  for (const [sid, session] of activeSessions || []) {
    if (!session || session.exited) continue;
    if (same(sid) || same(session.realSessionId)) return 'session is still running — close it first';
  }
  const job = liveJobCheck(id);
  if (!job || !job.known) return `cannot tell whether a background job is still running this session (${(job && job.reason) || 'unknown'}) — not deleted`;
  if (job.job) return `background job ${job.job.id} is still running this session — stop it first`;
  const other = await liveElsewhereChecked(id);
  if (!other || !other.known) return `cannot tell whether this session is still running elsewhere (${(other && other.reason) || 'unknown'}) — not deleted`;
  if (other.live) return 'session is still running outside this window — stop it first';
  return null;
}

module.exports = { deleteSessionRefusal };
