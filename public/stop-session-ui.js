// Dual-mode helper — see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")

// session: the sessionMap entry for the row being stopped, or undefined.
function resolveSessionStop(session) {
  const alias = session && session.remoteAlias;
  if (alias) {
    return { remote: true, alias, confirmText: `Stop this session on ${alias}?` };
  }
  return { remote: false, alias: null, confirmText: 'Stop this session?' };
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
