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

async function guardResume(session, { automatic = false, api, confirm, name, notify = typeof showAppNotice === 'function' ? showAppNotice : undefined, live, freshLive = false, allowBgAttach = false, onBlocked } = {}) {
  if (!session || session.type === 'terminal') return true;
  const sessionIds = [...new Set([session.sessionId, session.headSessionId, ...(session.mergedMemberIds || [])]
    .filter(id => typeof id === 'string' && id))];
  if (sessionIds.length > 1) {
    const liveById = await liveElsewhereMany(sessionIds.filter(id => !freshLive || live === undefined || id !== session.sessionId), { api });
    if (freshLive && live) liveById[session.sessionId] = live;
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

function continuationChoiceRecord(value) {
  return value && (value.chosen === null || typeof value.chosen === 'string' && value.chosen.length > 0)
    && Array.isArray(value.candidates) && value.candidates.every(id => typeof id === 'string' && id.length > 0)
    && (value.chosen === null || value.candidates.includes(value.chosen)) ? value : null;
}

async function resolveResumeSession(session, { automatic = false, api, confirm, choose, describe = () => ({}),
  formatDate = t => new Date(t).toLocaleString(), resolutions, onHold, onLive, notify,
  choices, rowKey = session?.sessionId, chooseAgain = false, memoryNotify = notify,
  resolveRow = candidate => ({ ...session, sessionId: candidate.sessionId, headSessionId: candidate.sessionId, mergedMemberIds: [] }) } = {}) {
  if (!session || session.type === 'terminal' || session.remoteAlias) return session;
  const key = 'continuationChoice:' + rowKey;
  const remember = value => {
    if (!choices) return;
    if (value) choices.set(key, value);
    else choices.delete(key);
    (async () => {
      if (value) await api.setSetting(key, value);
      else await api.deleteSetting(key);
    })().catch(error => {
      if (value && choices.get(key) === value) choices.delete(key);
      memoryNotify?.({ id: `continuation-memory:${rowKey}`, kind: 'error',
        message: value
          ? `Switchboard could not remember this choice: ${error.message || String(error)}. It will ask again next time.`
          : `Switchboard could not forget the earlier choice: ${error.message || String(error)}. It is still saved for the next restart.` });
    });
  };
  const partInfo = (candidate, id = candidate.sessionId) => {
    const { name, aiTitle, summary, title, runningHere } = describe(id);
    return { ...candidate, name: name || candidate.name, aiTitle: aiTitle || candidate.aiTitle,
      summary: summary || candidate.summary, title: title || candidate.title, runningHere };
  };
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
    if (automatic) { onHold?.({ lookupFailed: true }); return null; }
    return openAsWas(['Switchboard could not check whether "' + conversationName() + '" continued in another part.', 'Open it as it was?']);
  }
  const rowIds = new Set([session.sessionId, ...(session.mergedMemberIds || [])]);
  const candidates = (result?.candidates || []).filter(candidate => !rowIds.has(candidate.sessionId));
  const record = result && !result.unresolved ? continuationChoiceRecord(choices?.get(key)) : null;
  const candidateIds = [...new Set(candidates.map(candidate => candidate.sessionId))].sort();
  const missing = result?.missing || (result?.missingAt?.length && result.missingAt.every(id => rowIds.has(id)));
  if ((result && !result.unresolved || missing) && !candidates.length && choices?.has(key)) remember(null);
  if (missing && !candidates.length) {
    notify?.({ id: `continuation-missing:${session.sessionId}`,
      message: '"' + conversationName() + '" continued in a part that no longer exists on disk, so it was opened as it was.' });
    const head = session.headSessionId || session.sessionId;
    return head === session.sessionId ? session
      : { ...session, sessionId: head, mergedMemberIds: [...rowIds].filter(id => id !== head) };
  }
  if (result && !result.unresolved && candidates.length && record && !chooseAgain) {
    let chosen = record.chosen;
    let allowed = record.candidates;
    if (chosen !== null && !candidateIds.includes(chosen)) {
      let followed;
      try { followed = await api.getSessionContinuations(chosen); } catch { followed = null; }
      if (followed && !followed.unresolved && followed.candidates?.length === 1) {
        const next = followed.candidates[0].sessionId;
        if (candidateIds.includes(next)) {
          allowed = [...record.candidates.filter(id => id !== chosen), next];
          chosen = next;
        }
      }
    }
    if ((chosen === null || candidateIds.includes(chosen)) && candidateIds.every(id => allowed.includes(id))) {
      if (chosen !== record.chosen || JSON.stringify(candidateIds) !== JSON.stringify(record.candidates)) remember({ chosen, candidates: candidateIds });
      return chosen === null ? session : resolveRow(candidates.find(candidate => candidate.sessionId === chosen));
    }
  }
  if (automatic) {
    if (!result || result.unresolved) { onHold?.({ waitingForIndex: !!result?.waitingForIndex }); return null; }
    return candidates.length === 1 ? resolveRow(candidates[0]) : candidates.length ? null : session;
  }
  const seenRows = new Set([session.sessionId]);
  const candidateParts = candidates.map(candidate => {
    const target = resolveRow(candidate);
    const part = target.sessionId === candidate.sessionId ? candidate
      : target.conversationParts?.find(part => part.sessionId === target.sessionId) || target;
    return { ...partInfo({ ...part, sessionId: candidate.sessionId }, target.sessionId), target };
  })
    .filter(part => {
      if (seenRows.has(part.target.sessionId)) return false;
      seenRows.add(part.target.sessionId);
      return true;
    });
  if (!candidateParts.length) {
    if (result && !result.unresolved) return session;
    const reason = result?.waitingForIndex ? 'a part it continued in is still being indexed.'
      : 'its continuation records are damaged, or a part it continued in could not be checked.';
    return openAsWas(['Switchboard could not tell where "' + conversationName() + '" continued: ' + reason,
      'Open the part you clicked as it was, or cancel and try again later.']);
  }
  const clicked = partInfo(session), name = label(clicked);
  const parts = [...candidateParts, { ...clicked, target: session }];
  const activity = part => part.modified ? Date.parse(part.modified) : NaN;
  parts.sort((a, b) => (Number.isFinite(activity(b)) ? activity(b) : -Infinity) - (Number.isFinite(activity(a)) ? activity(a) : -Infinity));
  let liveById, liveFailed = false;
  try {
    liveById = await api.getSessionsLiveElsewhere(parts.map(part => part.target.sessionId));
    if (!liveById || typeof liveById !== 'object' || Array.isArray(liveById)) throw new TypeError('Invalid liveness batch');
  } catch { liveFailed = true; }
  const options = parts.map(part => {
    const live = liveById?.[part.target.sessionId];
    const blocked = live?.kind === 'bg' && !(typeof live.jobId === 'string' && live.jobId);
    const location = part.runningHere ? 'here' : blocked ? 'blockedBg' : live?.kind;
    const detail = [Number.isFinite(activity(part)) ? 'last active ' + formatDate(activity(part)) : 'last active unknown',
      Number.isFinite(part.messageCount) && part.messageCount >= 0 ? part.messageCount + (part.messageCount === 1 ? ' message' : ' messages') : null,
      part.sessionId === session.sessionId && 'the part you clicked', continuationLocations[location]].filter(Boolean).join(' · ');
    return { id: part.sessionId, label: label(part), detail, disabled: !!blocked };
  });
  const message = ['"' + name + '" continues in ' + (candidateParts.length === 1 ? 'another part' : candidateParts.length + ' other parts') + '. Choose the one to open.'];
  if (!result || result.unresolved) message.push('Some continuation records could not be read, so this list may be incomplete. This choice is not remembered.');
  else message.push('Switchboard opens your choice directly next time, as long as it is still there and no new part appears. To choose again, use Choose part to open in the row\'s menu.');
  if (liveFailed) message.push('Switchboard could not check which parts are running.');
  const rememberedId = record?.chosen === null ? session.sessionId : record?.chosen;
  const selectedId = options.find(option => option.id === rememberedId && !option.disabled)?.id || options.find(option => !option.disabled)?.id;
  const answer = await choose({ title: 'Open which part?', message, options, selectedId, confirmLabel: 'Open' });
  const selected = options.find(option => option.id === answer?.choice && !option.disabled);
  if (!selected) return null;
  if (result && !result.unresolved) remember({ chosen: selected.id === session.sessionId ? null : selected.id, candidates: candidateIds });
  const chosenPart = parts.find(part => part.sessionId === selected.id);
  if (!liveFailed) onLive?.(liveById[chosenPart.target.sessionId] || null);
  return chosenPart.target;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { guardResume, liveElsewhereMany, liveElsewhereQuestion, resolveResumeSession };
}
