// delete-session-guard.js — see .ai/contexts/bg-agents.md ("Invariants")
'use strict';

async function deleteSessionRefusal(sessionId, { activeSessions, liveJobCheck, liveElsewhereChecked, describeLiveProcess = false }) {
  const id = String(sessionId || '');
  const key = id.toLowerCase();
  const same = (v) => typeof v === 'string' && v.toLowerCase() === key;
  for (const [sid, session] of activeSessions || []) {
    if (!session || session.exited) continue;
    if (same(sid) || same(session.realSessionId)) return 'session is still running in this window — use Stop on its row in the sidebar, then retry Delete';
  }
  const job = liveJobCheck(id);
  if (!job || !job.known) return `cannot tell whether a background job is still running this session (${(job && job.reason) || 'unknown'}) — not deleted`;
  if (job.job) return `background job ${job.job.id} is still running this session — open the Agents view and stop that job, then retry Delete`;
  const other = await liveElsewhereChecked(id);
  if (!other || !other.known) return `cannot tell whether this session is still running elsewhere (${(other && other.reason) || 'unknown'}) — not deleted`;
  if (other.live) return `session is still running outside this window${describeLiveProcess ? ` in pid ${other.live.pid}` : ''} — return to its own terminal and end it there, then retry Delete`;
  return null;
}

function makeDeleteSessionGuard({ activeSessions, bgAgents, cliSessionState, sessionHasPty, ptyPids, getMergedMemberIds = () => [] }) {
  return async (sessionId, partIds = [sessionId, ...getMergedMemberIds(sessionId)]) => {
    for (const id of partIds) {
      const refusal = await deleteSessionRefusal(id, {
        activeSessions,
        liveJobCheck: (sid) => bgAgents.liveJobCheck(sid),
        liveElsewhereChecked: (sid) => cliSessionState.liveElsewhereChecked(sid, sessionHasPty, ptyPids),
      });
      if (refusal) return refusal;
    }
    return null;
  };
}

module.exports = { deleteSessionRefusal, makeDeleteSessionGuard };
