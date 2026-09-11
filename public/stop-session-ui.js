// Dual-mode helper — see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")

// session: the sessionMap entry for the row being stopped, or undefined.
function resolveSessionStop(session) {
  const alias = session && session.remoteAlias;
  if (alias) {
    return { remote: true, alias, confirmText: `Stop this session on ${alias}?` };
  }
  return { remote: false, alias: null, confirmText: 'Stop this session?' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveSessionStop };
}
