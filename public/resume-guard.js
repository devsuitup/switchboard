// Dual-mode helper — see .ai/contexts/cli-session-state.md ("Live elsewhere")

function liveElsewhereMessage(live) {
  const where = live.cwd ? ` in ${live.cwd}` : '';
  return `This session is already running in another process (pid ${live.pid}${where}).\n\n`
    + 'Resuming it here starts a second claude CLI on the same session, and both will write to its transcript.\n\n'
    + 'Resume it anyway?';
}

async function guardResume(session, { automatic = false, api, confirm } = {}) {
  if (!session || session.type === 'terminal') return true;
  let live = null;
  try {
    live = await api.getSessionLiveElsewhere(session.sessionId);
  } catch {
    live = null;
  }
  if (!live) return true;
  if (automatic) return false;
  return !!confirm(liveElsewhereMessage(live));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { guardResume, liveElsewhereMessage };
}
