// Dual-mode helper — see .ai/contexts/cli-session-state.md ("Live elsewhere")

function liveElsewhereMessage(live) {
  const where = live.cwd ? ` in ${live.cwd}` : '';
  return `This session is already running in another process (pid ${live.pid}${where}).\n\n`
    + 'Resuming it here starts a second claude CLI on the same session, and both will write to its transcript.\n\n'
    + 'Resume it anyway?';
}

async function liveElsewhereMany(sessionIds, { api } = {}) {
  if (!sessionIds.length) return {};
  try {
    const found = await api.getSessionsLiveElsewhere(sessionIds);
    return found && typeof found === 'object' ? found : {};
  } catch {
    return {};
  }
}

async function guardResume(session, { automatic = false, api, confirm, live } = {}) {
  if (!session || session.type === 'terminal') return true;
  if (live === undefined) {
    try {
      live = await api.getSessionLiveElsewhere(session.sessionId);
    } catch {
      live = null;
    }
  }
  if (!live) return true;
  if (automatic) return false;
  if (live.kind === 'schedule') {
    const where = live.cwd ? ` in ${live.cwd}` : '';
    confirm(`This session's scheduled task is already running (pid ${live.pid}${where}).\n\n`
      + 'Wait for the scheduled run to finish before opening it here.');
    return false;
  }
  // see .ai/contexts/bg-agents.md
  if (live.kind === 'bg') {
    if (typeof live.jobId === 'string' && live.jobId) return { attach: live.jobId, cwd: live.cwd || null };
    return false;
  }
  return !!confirm(liveElsewhereMessage(live));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { guardResume, liveElsewhereMany, liveElsewhereMessage };
}
