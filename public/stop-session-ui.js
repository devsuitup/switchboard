// Dual-mode helper — see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")

// session: the sessionMap entry for the row being stopped, or undefined.
function resolveSessionStop(session, { attach = false } = {}) {
  const alias = session && session.remoteAlias;
  if (alias) {
    const label = typeof remoteHostLabel === 'function' ? remoteHostLabel(alias) : alias;
    return { remote: true, alias, attach: false, confirmText: `Stop this session on ${label}?` };
  }
  if (attach) {
    return { remote: false, alias: null, attach: true, confirmText: 'Detach from this background session. It keeps running; the Agents view can stop it.' };
  }
  return { remote: false, alias: null, attach: false, confirmText: 'Stop this session?' };
}

async function planSessionStop(row, { attach = false, retryTargets, backgroundJobs, jobStop = false } = {}) {
  const targets = [];
  const excluded = [];
  for (const id of new Set(retryTargets ? retryTargets.map(target => target.sessionId) : rowSessionIds(row))) {
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
    if (retryTargets && !active && !(jobStop && retryTargets.some(target => target.sessionId === id && target.job))) continue;
    if (route.attach) {
      if (jobStop) {
        const jobId = open?.attachJobId;
        if (typeof jobId !== 'string' || !/^[0-9a-f]{8}$/.test(jobId)) {
          excluded.push({ sessionId: id, reason: 'cannot tell which background job runs this part; stop it from the Agents view' });
          continue;
        }
        const check = await checkBackgroundJob(id, backgroundJobs);
        if (check?.known !== true) {
          excluded.push({ sessionId: id, reason: `cannot tell whether a background job is running this part (${check?.reason || 'unknown'})` });
          continue;
        }
        targets.push({ sessionId: id, job: true, jobId, attachedHere: true, notHosted: !check.job, where: 'in the background' });
      } else {
        targets.push({ sessionId: id, ...route, where: 'in this window', jobId: open?.attachJobId });
      }
      continue;
    }
    if (active) {
      targets.push({ sessionId: id, ...route, where: 'in this window' });
      continue;
    }
    const check = await checkBackgroundJob(id, backgroundJobs);
    if (check?.known === false || (jobStop && check?.known !== true)) {
      excluded.push({ sessionId: id, reason: `cannot tell whether a background job is running this part (${check?.reason || 'unknown'})` });
    } else if (check?.job) {
      if (jobStop) {
        if (typeof check.job.id !== 'string' || !/^[0-9a-f]{8}$/.test(check.job.id)) {
          excluded.push({ sessionId: id, reason: 'cannot tell which background job runs this part; stop it from the Agents view' });
        } else {
          targets.push({ sessionId: id, job: true, jobId: check.job.id, attachedHere: false, where: 'in the background' });
        }
      } else {
        excluded.push({ sessionId: id, reason: `background job ${check.job.id} keeps running; stop it from the Agents view` });
      }
    } else if (storedActivitySnapshot(id, row)?.liveness === 'alive') {
      excluded.push({ sessionId: id, reason: 'a process outside this window keeps running; stop it in its own terminal' });
    }
  }
  return describeSessionStopPlan(row, targets, excluded);
}

function describeSessionStopPlan(row, targets, excluded) {
  const stopping = targets.filter(target => !target.attach);
  const attachOnly = targets.length > 0 && !stopping.length;
  const single = rowSessionIds(row).length === 1;
  const name = cleanDisplayName(row.name || row.aiTitle || row.summary) || 'Untitled conversation';
  const label = id => single ? `This session "${name}"` : `Part ${id}`;
  const lines = targets.map(target => target.notHosted
    ? `${label(target.sessionId)}: background job ${target.jobId} is not running in the daemon; its tab detaches.`
    : target.job ? `${label(target.sessionId)}: background job ${target.jobId}; its process ends.`
    : target.attach
    ? `${label(target.sessionId)}: detach its tab in this window; background job ${target.jobId || (single ? 'for this session' : target.sessionId)} keeps running; stop it from the Agents view.`
    : `${label(target.sessionId)}${target.possiblyLive ? ' (possibly running)' : ''} ${target.where}.`);
  const confirmText = [attachOnly ? 'Detach from this background session. It keeps running; the Agents view can stop it.'
    : stopping.length ? single ? 'Stop this session?' : `Stop ${stopping.length} part${stopping.length === 1 ? '' : 's'}?`
      : single ? 'This session cannot be stopped here.' : 'No parts can be stopped here.', ...lines,
    ...(stopping.length ? [single ? 'Its process ends; the conversation is kept and can be resumed.'
      : "Each stopped part's process ends; the conversation is kept and can be resumed."] : []),
    ...excluded.map(part => `${label(part.sessionId)}: ${part.reason}.`)].join('\n');
  return { targets, excluded, attach: attachOnly, confirmText };
}

function planSessionDetach(row, { tabOnly = false, retryTargets } = {}) {
  const ids = tabOnly ? [row.sessionId] : rowSessionIds(row);
  return { targets: [...new Set(ids)].filter(id => !retryTargets || retryTargets.some(target => target.sessionId === id))
    .flatMap(id => {
      const entry = openSessions.get(id);
      return activePtyIds.has(id) && entry?.attach && !entry.closed && !entry.session?.remoteAlias
        ? [{ sessionId: id, attach: true, jobId: entry.attachJobId, where: 'in this window' }] : [];
    }) };
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
async function checkBackgroundJob(sessionId, backgroundJobs) {
  if (backgroundJobs?.has(sessionId)) return backgroundJobs.get(sessionId);
  if (!window.api || typeof window.api.bgAgentLiveJob !== 'function') return null;
  let check;
  try { check = await window.api.bgAgentLiveJob(sessionId); } catch (err) {
    check = { known: false, reason: err?.message || 'unknown error' };
  }
  backgroundJobs?.set(sessionId, check);
  return check;
}

async function liveBackgroundJobRefusal(sessionId, backgroundJobs) {
  const check = await checkBackgroundJob(sessionId, backgroundJobs);
  if (check && check.known === false) return `cannot tell whether a background job is running this session (${check.reason || 'unknown'})`;
  if (check && check.job) return `background job ${check.job.id} is still running this session — stop it from the Agents view first`;
  return null;
}

async function archiveBackgroundJobRefusal(session, backgroundJobs) {
  if (session.remoteAlias) return null;
  for (const id of rowSessionIds(session)) {
    const refusal = await liveBackgroundJobRefusal(id, backgroundJobs);
    if (refusal) return refusal;
  }
  return null;
}

async function planSessionArchive(rows) {
  const backgroundJobs = new Map();
  for (const session of rows) {
    const error = await archiveBackgroundJobRefusal(session, backgroundJobs);
    if (error) return { ok: false, session, error };
  }
  const plans = [];
  for (const session of rows) plans.push({ session, plan: await planSessionStop(session, { backgroundJobs }) });
  return { ok: true, plans };
}

// Stop-then-archive/delete verb shared by sidebar.js's archive/delete call sites — see .ai/contexts/session-state.md ("stopBeforeArchive").
async function stopBeforeArchive(session, { unreachable, plan } = {}) {
  if (!session) return { ok: true };
  const refusal = !plan && await archiveBackgroundJobRefusal(session);
  if (refusal) return { ok: false, error: refusal };
  const ids = rowSessionIds(session);
  let didStop = false;
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
      if (plan && !plan.targets.some(target => target.sessionId === id)) {
        return { ok: false, error: `Part ${id} started running; retry Archive to confirm stopping it.`, didStop };
      }
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
        return { ok: false, error: (result && result.error) || 'unknown error', didStop };
      }
      didStop ||= result.ok !== false;
      if (typeof applyRemoteStopped === 'function') applyRemoteStopped(id);
    }
    return notStopped.length ? { ok: true, notStopped, didStop } : { ok: true, didStop };
  }
  for (const id of ids) {
    const open = typeof openSessions !== 'undefined' && openSessions.get(id);
    if (!(typeof activePtyIds !== 'undefined' && activePtyIds.has(id)) && !(open && !open.closed)) continue;
    if (plan && !plan.targets.some(target => target.sessionId === id)) {
      return { ok: false, error: `Part ${id} started running; retry Archive to confirm stopping it.`, didStop };
    }
    const result = await window.api.stopSession(id);
    if (!result || (result.ok === false && result.error !== 'not running')) {
      return { ok: false, error: result?.error || 'The stop backend is unavailable or returned no result', didStop };
    }
    didStop ||= result.ok !== false && !result.detached;
    if (typeof activePtyIds !== 'undefined') activePtyIds.delete(id);
  }
  return { ok: true, didStop };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveSessionStop, planSessionStop, planSessionDetach, planSessionArchive, isRemoteSessionAlive, stopBeforeArchive };
}
