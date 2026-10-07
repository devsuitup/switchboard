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
async function stopBeforeArchive(session) {
  if (!session) return { ok: true };
  const alias = session.remoteAlias;
  if (alias) {
    if (!isRemoteSessionAlive(session)) return { ok: true };
    const result = await window.api.remoteStopSession(alias, session.sessionId);
    if (!result || result.ok === false) {
      return { ok: false, error: (result && result.error) || 'unknown error' };
    }
    if (typeof applyRemoteStopped === 'function') applyRemoteStopped(session.sessionId);
    return { ok: true };
  }
  const refusal = await liveBackgroundJobRefusal(session.sessionId);
  if (refusal) return { ok: false, error: refusal };
  if (typeof activePtyIds === 'undefined' || !activePtyIds.has(session.sessionId)) return { ok: true };
  const result = await window.api.stopSession(session.sessionId);
  if (result && result.ok === false) {
    return { ok: false, error: result.error || 'unknown error' };
  }
  activePtyIds.delete(session.sessionId);
  return { ok: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveSessionStop, isRemoteSessionAlive, stopBeforeArchive };
}
