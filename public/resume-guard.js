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

async function guardResume(session, { automatic = false, api, confirm, live, allowBgAttach = false } = {}) {
  if (!session || session.type === 'terminal') return true;
  if (live === undefined) {
    try {
      live = await api.getSessionLiveElsewhere(session.sessionId);
    } catch {
      live = null;
    }
  }
  if (!live) return true;
  if (automatic && !(allowBgAttach && live.kind === 'bg')) return false;
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

// see .ai/contexts/cli-session-state.md ("Conversation continuations")
async function resolveResumeSession(session, { automatic = false, api, confirm, resolutions } = {}) {
  if (!session || session.type === 'terminal' || session.remoteAlias) return session;
  let result;
  try {
    if (automatic && resolutions) {
      if (!resolutions.has(session.sessionId)) resolutions.set(session.sessionId, api.getSessionContinuations(session.sessionId));
      result = await resolutions.get(session.sessionId);
    } else result = await api.getSessionContinuations(session.sessionId);
  } catch {
    if (automatic) return null;
    return confirm('Could not check this conversation for continuations.\n\nOpen the original session ' + session.sessionId + '?') ? session : null;
  }
  const candidates = result?.candidates || [];
  const listing = candidates.map(c => c.sessionId + ' (last activity: ' + (c.modified || 'unknown') + ')').join('\n');
  if (!result || result.unresolved) {
    if (automatic) return null;
    return confirm('This conversation has an unresolved continuation (cycle, missing transcript or malformed continuation record).\n'
      + listing + '\nYou can retry after indexing or open a candidate from the sidebar.\n\nOpen the original session ' + session.sessionId + '?') ? session : null;
  }
  if (!candidates.length) return session;
  if (automatic) return candidates.length === 1 ? { ...session, sessionId: candidates[0].sessionId } : null;
  for (const candidate of candidates) {
    if (confirm('This conversation continued under another id:\n' + listing + '\n\nOpen ' + candidate.sessionId + '?')) {
      return { ...session, sessionId: candidate.sessionId };
    }
  }
  return confirm('No continuation selected.\n\nOpen the original session ' + session.sessionId + '?') ? session : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { guardResume, liveElsewhereMany, liveElsewhereMessage, resolveResumeSession };
}
