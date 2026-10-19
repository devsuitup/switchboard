// Dual-mode helper — see .ai/contexts/cli-session-state.md ("Live elsewhere")

function liveElsewhereQuestion(live, name = 'Untitled conversation', formatTime = t => new Date(t).toLocaleString()) {
  const where = live.kind === 'schedule'
    ? `in a scheduled run${live.scheduleName ? ` of "${live.scheduleName}"` : ''}` : 'in another process';
  const details = [live.pid && `pid ${live.pid}`, live.cwd && `in ${live.cwd}`,
    Number.isFinite(live.startedAt) && `started ${formatTime(live.startedAt)}`].filter(Boolean);
  return {
    title: 'Session running elsewhere', confirmLabel: 'Resume anyway', danger: true,
    message: [`"${name || 'Untitled conversation'}" is already running ${where}${details.length ? ': ' + details.join(', ') : ''}.`,
      'Resuming it here starts a second Claude on the same conversation, and both write to its transcript.'],
  };
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

async function guardResume(session, { automatic = false, api, confirm, name, notify = typeof showAppNotice === 'function' ? showAppNotice : undefined, live, allowBgAttach = false, onBlocked } = {}) {
  if (!session || session.type === 'terminal') return true;
  const sessionIds = [...new Set([session.sessionId, session.headSessionId, ...(session.mergedMemberIds || [])]
    .filter(id => typeof id === 'string' && id))];
  if (sessionIds.length > 1) {
    const liveById = await liveElsewhereMany(sessionIds.filter(id => live === undefined || id !== session.sessionId), { api });
    if (live) liveById[session.sessionId] = live;
    let verdict = true;
    for (const id of sessionIds) {
      if (!liveById[id]) continue;
      const partVerdict = await guardResume({ sessionId: id }, {
        automatic, api, confirm, name, notify, live: liveById[id], allowBgAttach: allowBgAttach && id === session.sessionId,
      });
      if (partVerdict === false) {
        onBlocked?.({ sessionId: id, live: liveById[id] });
        return false;
      }
      if (typeof partVerdict === 'object') verdict = partVerdict;
    }
    return verdict;
  }
  if (live === undefined) {
    try {
      live = await api.getSessionLiveElsewhere(session.sessionId);
    } catch {
      live = null;
    }
  }
  if (!live) return true;
  if (automatic && !(allowBgAttach && live.kind === 'bg')) {
    onBlocked?.({ sessionId: session.sessionId, live });
    return false;
  }
  // see .ai/contexts/bg-agents.md
  if (live.kind === 'bg') {
    if (typeof live.jobId === 'string' && live.jobId) return { attach: live.jobId, cwd: live.cwd || null };
    if (automatic) {
      onBlocked?.({ sessionId: session.sessionId, live });
      return false;
    }
    if (typeof notify !== 'function') throw new TypeError('guardResume requires a notify adapter for a background refusal');
    notify({ id: `resume-background:${session.sessionId}`, kind: 'error',
      message: `Cannot open "${name || 'Untitled conversation'}" here: it runs as a background session whose job Switchboard cannot identify, so it cannot be attached. Find it in the Agents view.` });
    return false;
  }
  return !!(await confirm(liveElsewhereQuestion(live, name)));
}

// see .ai/contexts/cli-session-state.md ("Conversation continuations")
const continuationLocations = {
  here: 'running here', interactive: 'running elsewhere', schedule: 'running in a scheduled run',
  bg: 'running in the background', blockedBg: 'running in the background, cannot be attached',
};

async function resolveResumeSession(session, { automatic = false, api, confirm, choose, describe = () => ({}),
  formatDate = t => new Date(t).toLocaleString(), resolutions, onHold, onLive } = {}) {
  if (!session || session.type === 'terminal' || session.remoteAlias) return session;
  const partInfo = candidate => ({ ...candidate, ...describe(candidate.sessionId), sessionId: candidate.sessionId });
  const label = part => (part.name || part.aiTitle || part.summary || part.title || '').trim() || 'Untitled conversation';
  const conversationName = () => label(partInfo(session));
  const openAsWas = async message => await confirm({ title: 'Open this conversation?', message,
    confirmLabel: 'Open as it was' }) ? session : null;
  let result;
  try {
    if (automatic && resolutions) {
      if (!resolutions.has(session.sessionId)) resolutions.set(session.sessionId, api.getSessionContinuations(session.sessionId));
      result = await resolutions.get(session.sessionId);
    } else result = await api.getSessionContinuations(session.sessionId);
  } catch {
    if (automatic) return null;
    return openAsWas(['Switchboard could not check whether "' + conversationName() + '" continued in another part.', 'Open it as it was?']);
  }
  const rowIds = new Set([session.sessionId, ...(session.mergedMemberIds || [])]);
  const candidates = (result?.candidates || []).filter(candidate => !rowIds.has(candidate.sessionId));
  if (automatic) {
    if (!result || result.unresolved) { onHold?.({ waitingForIndex: !!result?.waitingForIndex }); return null; }
    return candidates.length === 1 ? { ...session, sessionId: candidates[0].sessionId } : candidates.length ? null : session;
  }
  if (!candidates.length) {
    if (result && !result.unresolved) return session;
    const reason = result?.waitingForIndex ? 'a part it continued in is still being indexed.'
      : 'its continuation records are damaged, or a part it continued in could not be checked.';
    return openAsWas(['Switchboard could not tell where "' + conversationName() + '" continued: ' + reason,
      'Open the part you clicked as it was, or cancel and try again later.']);
  }
  const clicked = partInfo(session), name = label(clicked);
  const parts = [...candidates.map(partInfo), clicked];
  const activity = part => part.modified ? Date.parse(part.modified) : NaN;
  parts.sort((a, b) => (Number.isFinite(activity(b)) ? activity(b) : -Infinity) - (Number.isFinite(activity(a)) ? activity(a) : -Infinity));
  let liveById, liveFailed = false;
  try {
    liveById = await api.getSessionsLiveElsewhere(parts.map(part => part.sessionId));
    if (!liveById || typeof liveById !== 'object' || Array.isArray(liveById)) throw new TypeError('Invalid liveness batch');
  } catch { liveFailed = true; }
  const options = parts.map(part => {
    const live = liveById?.[part.sessionId];
    const blocked = live?.kind === 'bg' && !(typeof live.jobId === 'string' && live.jobId);
    const location = part.runningHere ? 'here' : blocked ? 'blockedBg' : live?.kind;
    const detail = [Number.isFinite(activity(part)) ? 'last active ' + formatDate(activity(part)) : 'last active unknown',
      Number.isFinite(part.messageCount) && part.messageCount >= 0 ? part.messageCount + (part.messageCount === 1 ? ' message' : ' messages') : null,
      part.sessionId === session.sessionId && 'the part you clicked', continuationLocations[location]].filter(Boolean).join(' · ');
    return { id: part.sessionId, label: label(part), detail, disabled: !!blocked };
  });
  const message = ['"' + name + '" continues in ' + (candidates.length === 1 ? 'another part' : candidates.length + ' other parts') + '. Choose the one to open.'];
  if (!result || result.unresolved) message.push('Some continuation records could not be read, so this list may be incomplete. This choice is not remembered.');
  if (liveFailed) message.push('Switchboard could not check which parts are running.');
  const selectedId = options.find(option => !option.disabled)?.id;
  const answer = await choose({ title: 'Open which part?', message, options, selectedId, confirmLabel: 'Open' });
  const selected = options.find(option => option.id === answer?.choice && !option.disabled);
  if (!selected) return null;
  if (!liveFailed) onLive?.(liveById[selected.id] || null);
  const chosenPart = parts.find(part => part.sessionId === selected.id);
  return selected.id === session.sessionId ? session
    : { ...session, sessionId: selected.id, headSessionId: selected.id, mergedMemberIds: chosenPart.mergedMemberIds || [] };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { guardResume, liveElsewhereMany, liveElsewhereQuestion, resolveResumeSession };
}
