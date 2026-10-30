// Dual-mode helper — see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")

// session: the sessionMap entry for the row being stopped, or undefined.
function resolveSessionStop(session, { attach = false } = {}) {
  const alias = session && session.remoteAlias;
  if (alias) {
    const label = typeof remoteHostLabel === 'function' ? remoteHostLabel(alias) : alias;
    return { remote: true, alias, attach: false, confirmText: `Stop this session on ${label}?` };
  }
  if (attach) {
    return { remote: false, alias: null, attach: true, confirmText: 'Detach from this background session. It keeps running.' };
  }
  return { remote: false, alias: null, attach: false, confirmText: 'Stop this session?' };
}

async function planSessionStop(row, { attach = false, retryTargets, backgroundJobs, jobStop = false, ignoreUnknownIdleJobs = false } = {}) {
  const targets = [];
  const excluded = [];
  for (const id of new Set(retryTargets ? retryTargets.map(target => target.sessionId) : rowSessionIds(row))) {
    let member = id === row.sessionId ? row : {
      ...row, sessionId: id,
      remoteDescriptorSeen: row.remoteMemberDescriptorSeen?.[id] ?? row.remoteDescriptorSeen,
    };
    const open = openSessions.get(id);
    const active = activePtyIds.has(id) || !!(open && !open.closed);
    if (jobStop) member = open?.session || member;
    const route = resolveSessionStop(member, { attach: !!(open?.attach && !open.closed) || (id === row.sessionId && attach) });
    if (route.remote) {
      const possiblyLive = member.remoteHostAt === null && !(typeof remoteSessionStates !== 'undefined'
        && remoteSessionStates.get(id)?.snapshot().liveness === 'dead');
      if (possiblyLive || isRemoteSessionAlive(member) || active) {
        targets.push({ sessionId: id, ...route, where: `on ${remoteHostLabel(route.alias)}`, possiblyLive });
      }
      continue;
    }
    const retryTarget = retryTargets?.find(target => target.sessionId === id);
    if (retryTargets && !active && !(jobStop && retryTarget?.job && !retryTarget.jobStopped)) continue;
    if (retryTarget?.jobStopped) {
      targets.push({ ...retryTarget, job: false, attach: true, where: 'in this window' });
      continue;
    }
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
        if (check.job && String(check.job.id).toLowerCase() !== jobId.toLowerCase()) {
          excluded.push({ sessionId: id, reason: `background job ${jobId} is no longer the running job (${check.job.id}); stop it from the Agents view` });
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
      if (ignoreUnknownIdleJobs && storedActivitySnapshot(id, row)?.liveness !== 'alive') continue;
      excluded.push({ sessionId: id, reason: `cannot tell whether a background job is running this part (${check?.reason || 'unknown'})` });
    } else if (check?.job) {
      if (jobStop) {
        if (typeof check.job.id !== 'string' || !/^[0-9a-f]{8}$/.test(check.job.id)) {
          excluded.push({ sessionId: id, reason: 'cannot tell which background job runs this part; stop it from the Agents view' });
        } else {
          targets.push({ sessionId: id, job: true, jobId: check.job.id, attachedHere: false, where: 'in the background' });
        }
      } else {
        const recovery = typeof check.job.id === 'string' && /^[0-9a-f]{8}$/.test(check.job.id)
          ? 'use Stop session on its sidebar row' : 'stop it from the Agents view';
        excluded.push({ sessionId: id, reason: `background job ${check.job.id} keeps running; ${recovery}` });
      }
    } else if (storedActivitySnapshot(id, row)?.liveness === 'alive') {
      excluded.push({ sessionId: id, reason: 'a process outside this window keeps running; stop it in its own terminal' });
    }
  }
  return describeSessionStopPlan(row, targets, excluded);
}

function describeSessionStopPlan(row, targets, excluded) {
  const stopping = targets.filter(target => !target.attach && !target.notHosted);
  const attachOnly = targets.length > 0 && !stopping.length;
  const single = rowSessionIds(row).length === 1;
  const name = cleanDisplayName(row.name || row.aiTitle || row.summary) || 'Untitled conversation';
  const label = id => single ? `This session "${name}"` : `Part ${id}`;
  const lines = targets.map(target => target.jobStopped
    ? `${label(target.sessionId)}: background job ${target.jobId} has stopped; its tab detaches.`
    : target.notHosted
    ? `${label(target.sessionId)}: background job ${target.jobId} is not running in the daemon; its tab detaches.`
    : target.job ? `${label(target.sessionId)}: background job ${target.jobId}; its process ends.`
    : target.attach
    ? `${label(target.sessionId)}: detach its tab in this window; background job ${target.jobId || (single ? 'for this session' : target.sessionId)} keeps running.`
    : `${label(target.sessionId)}${target.possiblyLive ? ' (possibly running)' : ''} ${target.where}.`);
  const confirmText = [attachOnly ? targets.some(target => target.notHosted || target.jobStopped)
    ? single ? 'Detach this tab?' : `Detach ${targets.length} tabs?`
    : 'Detach from this background session. It keeps running.'
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
      return activePtyIds.has(id) && entry && !entry.closed && (entry.attach || entry.session?.remoteAlias)
        ? [{ sessionId: id, attach: !entry.session?.remoteAlias, remote: !!entry.session?.remoteAlias,
          alias: entry.session?.remoteAlias, jobId: entry.attachJobId, where: 'in this window' }] : [];
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

async function liveBackgroundJobRefusal(sessionId, backgroundJobs = new Map()) {
  const check = await checkBackgroundJob(sessionId, backgroundJobs);
  if (check && check.known === false) return `cannot tell whether a background job is running this session (${check.reason || 'unknown'})`;
  if (check && check.job) {
    const plan = await planSessionStop({ sessionId }, { backgroundJobs, jobStop: true });
    const recovery = plan.targets.some(target => target.job && !target.notHosted)
      ? 'use Stop session on its sidebar row, or stop it from the Agents view, first' : 'stop it from the Agents view first';
    return `background job ${check.job.id} is still running this session — ${recovery}`;
  }
  return null;
}

async function runAttachedJobVerb(verb, jobId, sessionId) {
  const entry = openSessions.get(sessionId);
  const pending = entry?.attach && !entry.closed && !entry.session?.remoteAlias
    ? { previousEnding: entry.jobEnding, exit: null } : null;
  if (pending) {
    if (entry.jobVerbPending) throw new Error('A background job action is already in progress');
    entry.jobVerbPending = pending;
    entry.jobEnding = verb;
  }
  try {
    const result = await window.api.bgAgentVerb(verb, jobId);
    if (!result?.ok) throw new Error(result?.error || (verb === 'rm' ? 'unknown error' : 'The background stop backend is unavailable'));
    return result;
  } catch (error) {
    if (pending) {
      entry.jobEnding = pending.previousEnding;
      if (pending.exit && openSessions.get(sessionId) === entry) {
        const exit = pending.exit;
        noteSessionExit(sessionId, exit.exitCode, exit.signal, exit.stopped, exit.detached);
        writeSessionExitBanner(entry, lastSessionExit(sessionId), { correction: true });
        if (typeof updateRunningIndicators === 'function') updateRunningIndicators();
        if (typeof updateTerminalHeader === 'function') updateTerminalHeader();
      }
    }
    throw error;
  } finally {
    if (pending) delete entry.jobVerbPending;
  }
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

async function validateSessionStopPlan(session, planned) {
  const targets = [];
  const excluded = [...planned.excluded];
  for (const target of planned.targets) {
    if (target.job && !target.notHosted) {
      try {
        const check = await window.api.checkBgAgentVerb('stop', target.jobId);
        if (!check?.ok) throw new Error(check?.error || 'The background job check is unavailable');
      } catch (error) {
        excluded.push({ sessionId: target.sessionId, reason: error?.message || 'The background job check is unavailable' });
        continue;
      }
    }
    targets.push(target);
  }
  return describeSessionStopPlan(session, targets, excluded);
}

async function executeSessionStopTargets(targets, unreachable = new Map()) {
  const failures = [];
  const failedTargets = [];
  let stopped = 0;
  for (const target of targets) {
    const id = target.sessionId;
    const entry = openSessions.get(id);
    const previousDetachRequested = entry?.detachRequested;
    try {
      if (target.job && !target.notHosted) {
        const result = target.attachedHere ? await runAttachedJobVerb('stop', target.jobId, id)
          : await window.api.bgAgentVerb('stop', target.jobId);
        if (!result?.ok) throw new Error(result?.error || 'The background stop backend is unavailable');
        target.jobStopped = true;
      }
      if (!target.job || target.attachedHere) {
        if (target.remote && unreachable.has(target.alias)) throw new Error(unreachable.get(target.alias));
        const backend = target.remote ? window.api.remoteStopSession : window.api.stopSession;
        if (typeof backend !== 'function') throw new Error('The stop backend is unavailable');
        if (target.remote) {
          if (entry) delete entry.detachRequested;
        }
        const result = target.remote ? await backend(target.alias, id) : await backend(id);
        if (target.remote && result?.hostUnreachable) {
          const reason = result.error || 'The host is unreachable';
          unreachable.set(target.alias, reason);
          throw new Error(reason);
        }
        if (!result || (result.ok === false && result.error !== (target.remote ? 'session not found on that host' : 'not running'))) {
          throw new Error(result?.error || 'The stop backend is unavailable or returned no result');
        }
      }
      if (target.job && !target.notHosted && typeof refreshAgentsRoster === 'function') refreshAgentsRoster();
    } catch (error) {
      if (target.remote && entry) entry.detachRequested = previousDetachRequested;
      failures.push(`Part ${id} ${target.where}: ${error?.message || error || 'unknown error'}`);
      failedTargets.push(target);
      continue;
    }
    if (target.remote && typeof applyRemoteStopped === 'function') applyRemoteStopped(id);
    activePtyIds.delete(id);
    if (!gridViewActive && activeSessionId === id) {
      setActiveSession(null);
      terminalHeader.style.display = 'none';
      placeholder.style.display = '';
    }
    stopped++;
  }
  return { failures, failedTargets, stopped };
}

async function confirmAndStopProjectFolder(project, retryRows) {
  const operation = 'Stop all';
  const noticeId = sessionActionNoticeId(operation, project);
  try {
    const alias = project.remoteAlias || null;
    const groups = cachedAllProjects.filter(p => (p.remoteAlias || null) === alias
      && (p.projectPath === project.projectPath || worktreeParentPath(p.projectPath) === project.projectPath));
    if (!groups.some(p => p.projectPath === project.projectPath)) throw new Error('The folder is no longer in the index');
    const rows = groups.flatMap(p => p.sessions.filter(row => !row.parentSessionId));
    const backgroundJobs = new Map();
    const entries = [];
    for (const row of rows) {
      const retry = retryRows?.find(entry => entry.row.sessionId === row.sessionId);
      if (retryRows && !retry) continue;
      const planned = await planSessionStop(row, { jobStop: true, backgroundJobs, retryTargets: retry?.targets, ignoreUnknownIdleJobs: true });
      const plan = await validateSessionStopPlan(row, planned);
      const name = cleanDisplayName(row.name || row.aiTitle || row.summary) || row.sessionId;
      const snapshot = mergedRowSnapshot(rowSessionIds(row), rowHeadId(row), storedActivitySnapshot(rowHeadId(row), row), row);
      const background = planned.targets.some(target => target.job && !target.notHosted);
      entries.push({ row, plan, name, background, midTurn: !!snapshot?.busy });
    }
    const candidates = entries.filter(entry => entry.plan.targets.length);
    const refused = entries.flatMap(entry => entry.plan.excluded.map(part => `${entry.name} (part ${part.sessionId}): ${part.reason}.`));
    if (!candidates.length) {
      if (refused.length) throw new Error(refused.join('\n'));
      showAppNotice({ id: noticeId, message: 'Nothing is running to stop.' });
      return;
    }
    const hasBackground = entries.some(entry => entry.background);
    const message = [
      'Stop the conversations in this folder, including its nested worktrees? Their processes end; the conversations are kept and can be resumed.',
      ...candidates.map(entry => `${entry.name}${entry.midTurn ? ' (mid-turn)' : ''}: ${entry.plan.targets.map(target => target.where).join(', ')}${entry.background ? '; runs in the background and is refused unless you explicitly include background jobs' : ''}.`),
      ...refused,
    ];
    let force = false;
    if (hasBackground) {
      const answer = await showChoiceDialog({ title: 'Stop all?', message, danger: true, initialFocus: 'cancel',
        confirmLabel: 'Stop', selectedId: retryRows?.some(entry => entry.targets.some(target => target.job && !target.notHosted && !target.jobStopped)) ? 'force' : 'others', options: [
          { id: 'force', label: 'Stop all including background jobs' },
          { id: 'others', label: 'Stop the others only' },
        ] });
      if (!answer) return;
      force = answer.choice === 'force';
    } else if (!await appConfirm({ title: 'Stop all?', message, confirmLabel: 'Stop', danger: true })) return;
    const failures = [];
    const failedRows = [];
    const unreachable = new Map();
    let stopped = 0;
    for (const entry of candidates) {
      if (entry.background && !force) continue;
      const result = await executeSessionStopTargets(entry.plan.targets, unreachable);
      stopped += result.stopped;
      failures.push(...result.failures.map(error => `${entry.name}: ${error}`));
      if (result.failedTargets.length) failedRows.push({ row: entry.row, targets: result.failedTargets });
    }
    if (failures.length) {
      showSessionActionFailure(operation, project, failures.join('\n'),
        'Check the connection or the session in its own terminal (the Agents view for a background session), then retry Stop all.',
        () => confirmAndStopProjectFolder(project, failedRows));
    } else if (!force && candidates.every(entry => entry.background)) {
      showAppNotice({ id: noticeId, message: `Kept ${candidates.length} conversation${candidates.length === 1 ? '' : 's'} with background jobs; nothing else was running.` });
    } else clearAppNotice(noticeId);
    if (stopped) refreshSidebar();
  } catch (error) {
    showSessionActionFailure(operation, project, error, 'Check the folder and its sessions, then retry Stop all.',
      () => confirmAndStopProjectFolder(project, retryRows));
  }
}
