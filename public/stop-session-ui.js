// Dual-mode helper — see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")

// session: the sessionMap entry for the row being stopped, or undefined.
function resolveSessionStop(session, { attach = false } = {}) {
  const alias = session && session.remoteAlias;
  if (alias) {
    const label = typeof remoteHostLabel === 'function' ? remoteHostLabel(alias) : alias;
    return { remote: true, alias, attach: false, confirmText: `Stop this session on ${label}?` };
  }
  if (attach) {
    return { remote: false, alias: null, attach: true, confirmText: 'Detach from this background session? It keeps running; the Agents view can stop it.' };
  }
  return { remote: false, alias: null, attach: false, confirmText: 'Stop this session?' };
}

async function planSessionStop(row, { attach = false } = {}) {
  const targets = [];
  const excluded = [];
  for (const id of new Set(rowSessionIds(row))) {
    const member = id === row.sessionId ? row : {
      ...row, sessionId: id,
      remoteDescriptorSeen: row.remoteMemberDescriptorSeen?.[id] ?? row.remoteDescriptorSeen,
    };
    const open = openSessions.get(id);
    const active = activePtyIds.has(id) || !!(open && !open.closed);
    const route = resolveSessionStop(member, { attach: !!(open?.attach && !open.closed) || (id === row.sessionId && attach) });
    if (route.remote) {
      const possiblyLive = member.remoteHostAt === null && !(typeof remoteSessionStates !== 'undefined'
        && remoteSessionStates.get(id)?.snapshot().liveness === 'dead');
      if (possiblyLive || isRemoteSessionAlive(member) || active) {
        targets.push({ sessionId: id, ...route, where: `on ${remoteHostLabel(route.alias)}`, possiblyLive });
      }
      continue;
    }
    if (route.attach) {
      targets.push({ sessionId: id, ...route, where: 'in this window', jobId: open?.attachJobId });
      continue;
    }
    let check;
    if (typeof window.api.bgAgentLiveJob === 'function') {
      try { check = await window.api.bgAgentLiveJob(id); } catch (error) {
        check = { known: false, reason: error?.message || 'unknown error' };
      }
    }
    if (check?.known === false) {
      excluded.push({ sessionId: id, reason: `cannot tell whether a background job is running this part (${check.reason || 'unknown'})` });
    } else if (check?.job) {
      excluded.push({ sessionId: id, reason: `background job ${check.job.id} keeps running; stop it from the Agents view` });
    } else if (active) {
      targets.push({ sessionId: id, ...route, where: 'in this window' });
    } else if (storedActivitySnapshot(id, row)?.liveness === 'alive') {
      excluded.push({ sessionId: id, reason: 'a process outside this window keeps running; stop it in its own terminal' });
    }
  }
  const stopping = targets.filter(target => !target.attach);
  const attachOnly = targets.length > 0 && !stopping.length;
  const lines = targets.map(target => target.attach
    ? `Part ${target.sessionId}: detach its tab in this window; background job ${target.jobId || target.sessionId} keeps running; stop it from the Agents view.`
    : `Part ${target.sessionId}${target.possiblyLive ? ' (possibly running)' : ''} ${target.where}.`);
  const confirmText = [attachOnly ? 'Detach from this background session? It keeps running; the Agents view can stop it.'
    : stopping.length ? `Stop ${stopping.length} part${stopping.length === 1 ? '' : 's'}?` : 'No parts can be stopped here.', ...lines,
    ...(stopping.length ? ["Each stopped part's process ends; the conversation is kept and can be resumed."] : []),
    ...excluded.map(part => `Part ${part.sessionId}: ${part.reason}.`)].join('\n');
  return { targets, excluded, attach: attachOnly, confirmText };
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
    if (!result || (result.ok === false && result.error !== 'not running')) {
      return { ok: false, error: result?.error || 'The stop backend is unavailable or returned no result' };
    }
    if (typeof activePtyIds !== 'undefined') activePtyIds.delete(id);
  }
  return { ok: true };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveSessionStop, planSessionStop, isRemoteSessionAlive, stopBeforeArchive };
}
