// Dual-mode helper — see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")

// session: the sessionMap entry for the row being stopped, or undefined.
function resolveSessionStop(session, { attach = false } = {}) {
  const alias = session && session.remoteAlias;
  if (alias) {
    return { remote: true, alias, attach: false, confirmText: `Stop this session on ${alias}?` };
  }
  if (attach) {
    return { remote: false, alias: null, attach: true, confirmText: 'Detach from this background session? It keeps running; the Agents view can stop it.' };
  }
  return { remote: false, alias: null, attach: false, confirmText: 'Stop this session?' };
}

// Is this remote session's process still running? See .ai/contexts/session-state.md ("stopBeforeArchive").
function isRemoteSessionAlive(session) {
  if (!session) return false;
  if (typeof remoteSessionStates !== 'undefined' && remoteSessionStates.has(session.sessionId)) {
    const liveness = remoteSessionStates.get(session.sessionId).snapshot().liveness;
    if (liveness === 'dead') return false;
    if (liveness === 'alive') return true;
  }
  return !!session.remoteDescriptorSeen;
}

// see .ai/contexts/bg-agents.md ("Invariants")
async function liveBackgroundJobRefusal(sessionId) {
  if (!window.api || typeof window.api.bgAgentLiveJob !== 'function') return null;
  let check;
  try { check = await window.api.bgAgentLiveJob(sessionId); } catch (err) {
    return `cannot tell whether a background job is running this session (${(err && err.message) || 'unknown error'})`;
  }
  if (check && check.known === false) return `cannot tell whether a background job is running this session (${check.reason || 'unknown'})`;
  if (check && check.job) return `background job ${check.job.id} is still running this session — stop it from the Agents view first`;
  return null;
}

// Stop-then-archive/delete verb shared by sidebar.js's archive/delete call sites — see .ai/contexts/session-state.md ("stopBeforeArchive").
async function stopBeforeArchive(session, { unreachable } = {}) {
  if (!session) return { ok: true };
  const ids = rowSessionIds(session);
  const alias = session.remoteAlias;
  if (alias) {
    const notStopped = [];
    for (const id of ids) {
      if (notStopped.length) continue;
      const member = id === session.sessionId ? session : {
        ...session,
        sessionId: id,
        remoteDescriptorSeen: session.remoteMemberDescriptorSeen?.[id] ?? session.remoteDescriptorSeen,
      };
      const hostUnsynced = member.remoteHostAt === null && !(typeof remoteSessionStates !== 'undefined'
        && remoteSessionStates.has(id) && remoteSessionStates.get(id).snapshot().liveness === 'dead');
      const open = typeof openSessions !== 'undefined' && openSessions.get(id);
      if (!hostUnsynced && !isRemoteSessionAlive(member) && !(open && !open.closed)
          && !(typeof activePtyIds !== 'undefined' && activePtyIds.has(id))) continue;
      if (unreachable && unreachable.has(alias)) {
        notStopped.push({ alias, error: unreachable.get(alias) });
        continue;
      }
      const result = await window.api.remoteStopSession(alias, id);
      if (result && result.hostUnreachable) {
        if (unreachable) unreachable.set(alias, result.error);
        notStopped.push({ alias, error: result.error });
        continue;
      }
      if (!result || (result.ok === false && result.error !== 'session not found on that host')) {
        return { ok: false, error: (result && result.error) || 'unknown error' };
      }
      if (typeof applyRemoteStopped === 'function') applyRemoteStopped(id);
    }
    return notStopped.length ? { ok: true, notStopped } : { ok: true };
  }
  for (const id of ids) {
    const refusal = await liveBackgroundJobRefusal(id);
    if (refusal) return { ok: false, error: refusal };
  }
  for (const id of ids) {
    const open = typeof openSessions !== 'undefined' && openSessions.get(id);
    if (!(typeof activePtyIds !== 'undefined' && activePtyIds.has(id)) && !(open && !open.closed)) continue;
    const result = await window.api.stopSession(id);
    if (result && result.ok === false && result.error !== 'not running') {
      return { ok: false, error: result.error || 'unknown error' };
    }
    if (typeof activePtyIds !== 'undefined') activePtyIds.delete(id);
  }
  return { ok: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveSessionStop, isRemoteSessionAlive, stopBeforeArchive };
}
