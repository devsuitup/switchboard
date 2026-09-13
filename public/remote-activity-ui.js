// See .ai/contexts/session-cache.md ("Remote hosts — busy spinner (issue #242)")
// and .ai/contexts/session-state.md (migration step 3: the remote-ssh adapter).

const PIP_DECAY_MS = 20000;
// value: { handle, fireAt } — see .ai/contexts/session-state.md (issue #284)
const remoteActivityDecayTimers = new Map();

// separate decay for subagent attribution (agentsBusy) — see .ai/contexts/subagent-observability.md
const remoteAgentsDecayTimers = new Map();

// short busy decay while a subagent is running — see .ai/contexts/session-state.md (issue #284)
const SUBAGENT_PARENT_DECAY_MS = 3000;

// remote-ssh adapter: one persistent state per remote session id — see .ai/contexts/session-state.md
const remoteSessionStates = new Map();

// seed staleness floor per session, set at the attached handoff (#273) — see .ai/contexts/session-state.md
const remoteSeedFloors = new Map();

function remoteState(sessionId) {
  let state = remoteSessionStates.get(sessionId);
  if (!state) {
    state = createSessionState('remote-ssh');
    remoteSessionStates.set(sessionId, state);
  }
  return state;
}

// see .ai/contexts/session-state.md ("Row ownership: attached vs unattached")
function isRemoteRowOwned(sessionId) {
  const state = remoteSessionStates.get(sessionId);
  return !!state && !state.snapshot().attached;
}

// An attached row is owned by the local-pty path (#273) — see .ai/contexts/session-state.md
function projectRemoteState(sessionId) {
  const snapshot = remoteState(sessionId).snapshot();
  if (snapshot.attached) return;
  applyStateClasses(sessionId, snapshot);
}

function clearRemoteActivityTimer(sessionId) {
  const entry = remoteActivityDecayTimers.get(sessionId);
  if (entry) {
    clearTimeout(entry.handle);
    remoteActivityDecayTimers.delete(sessionId);
  }
}

function remoteActivityDecayRemaining(sessionId) {
  const entry = remoteActivityDecayTimers.get(sessionId);
  return entry ? entry.fireAt - Date.now() : null;
}

function clearRemoteAgentsTimer(sessionId) {
  const t = remoteAgentsDecayTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    remoteAgentsDecayTimers.delete(sessionId);
  }
}

// see .ai/contexts/session-state.md (issue #284)
function remoteBusyDecayMs(sessionId) {
  return remoteState(sessionId).snapshot().agentsBusy ? SUBAGENT_PARENT_DECAY_MS : PIP_DECAY_MS;
}

// Maps still fed in parallel for sidebar initial paint and grid dot — see session-state.md "migration status"
// An attached row is owned by the local-pty path (#273): a no-op here.
function markRemoteBusy(sessionId, via, at) {
  const state = remoteState(sessionId);
  if (state.snapshot().attached) return;
  const t = at || Date.now();
  state.apply({ type: 'transcriptTouched', at: t, source: via });
  state.apply({ type: 'busy', active: true });
  setActivity(sessionId, true, via);
  projectRemoteState(sessionId);
}

// silence is "stopped writing", not "response ready" — see .ai/contexts/session-cache.md ("Remote hosts — busy spinner")
// An attached row is owned by the local-pty path (#273): a no-op here.
function decayRemoteBusy(sessionId) {
  const state = remoteState(sessionId);
  if (state.snapshot().attached) return;
  state.apply({ type: 'busy', active: false, armReady: false });
  setActivity(sessionId, false, 'remote-decay', { armReady: false });
  projectRemoteState(sessionId);
}

function armRemoteDecayTimer(sessionId, ms) {
  const handle = setTimeout(() => {
    remoteActivityDecayTimers.delete(sessionId);
    decayRemoteBusy(sessionId);
  }, ms);
  remoteActivityDecayTimers.set(sessionId, { handle, fireAt: Date.now() + ms });
}

// silence means the subagent stopped, not finished — see .ai/contexts/subagent-observability.md
function decayRemoteAgentsBusy(sessionId) {
  const state = remoteState(sessionId);
  state.apply({ type: 'subagentCompleted', stillActive: false });
  projectRemoteState(sessionId);
}

function armRemoteAgentsDecayTimer(sessionId) {
  clearRemoteAgentsTimer(sessionId);
  remoteAgentsDecayTimers.set(sessionId, setTimeout(() => {
    remoteAgentsDecayTimers.delete(sessionId);
    decayRemoteAgentsBusy(sessionId);
  }, PIP_DECAY_MS));
}

// attributes a subagent write to its parent's own state — see .ai/contexts/subagent-observability.md
function markRemoteSubagentBusy(sessionId) {
  const state = remoteState(sessionId);
  state.apply({ type: 'subagentSpawned' });
  // see .ai/contexts/session-state.md (issue #284)
  const remaining = remoteActivityDecayRemaining(sessionId);
  if (remaining !== null && remaining > SUBAGENT_PARENT_DECAY_MS) {
    clearRemoteActivityTimer(sessionId);
    armRemoteDecayTimer(sessionId, SUBAGENT_PARENT_DECAY_MS);
  }
  projectRemoteState(sessionId);
  armRemoteAgentsDecayTimer(sessionId);
}

function pruneRemoteActivityTimers() {
  for (const sessionId of remoteActivityDecayTimers.keys()) {
    if (!sessionItemEl(sessionId)) clearRemoteActivityTimer(sessionId);
  }
  for (const sessionId of remoteAgentsDecayTimers.keys()) {
    if (!sessionItemEl(sessionId)) clearRemoteAgentsTimer(sessionId);
  }
  for (const sessionId of remoteSessionStates.keys()) {
    if (!sessionItemEl(sessionId)) remoteSessionStates.delete(sessionId);
  }
  for (const sessionId of remoteSeedFloors.keys()) {
    if (!sessionItemEl(sessionId)) remoteSeedFloors.delete(sessionId);
  }
}

function onRemoteActivityEvent(payload) {
  if (payload && payload.kind === 'subagent') {
    const parentSessionId = payload.parentSessionId;
    if (typeof parentSessionId !== 'string' || !parentSessionId) return;
    markRemoteSubagentBusy(parentSessionId);
    // per-(parent, agentId) running set for the child row's own dot — see .ai/contexts/subagent-observability.md
    const agentId = payload.agentId;
    if (typeof agentId === 'string' && agentId && typeof noteSubagentActivity === 'function') {
      noteSubagentActivity(parentSessionId, agentId);
    }
    return;
  }
  const sessionId = payload && payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;
  markRemoteBusy(sessionId, 'remote-watch', payload.at);
  clearRemoteActivityTimer(sessionId);
  armRemoteDecayTimer(sessionId, remoteBusyDecayMs(sessionId));
}

// descriptor ports; absence stays 'unknown', never 'dead' — see session-state.md ports table
function applyRemoteDescriptor(session) {
  if (!session || !session.remoteAlias) return;
  const state = remoteState(session.sessionId);
  if (session.remoteDescriptorSeen) state.apply({ type: 'liveness', value: 'alive' });
  if (session.status !== undefined) {
    state.apply({ type: 'descriptorStatus', status: session.status, at: session.statusUpdatedAt });
  }
  projectRemoteState(session.sessionId);
}

// attached = a PTY/ssh attach exists for this row (activePtyIds signal from app.js)
// true->false handoff clears busy at once and floors stale reseeds (#273) — see .ai/contexts/session-state.md
function setRemoteAttached(sessionId, attached) {
  if (!attached && !remoteSessionStates.has(sessionId)) return; // nothing recorded yet, nothing to clear
  const state = remoteState(sessionId);
  const wasAttached = state.snapshot().attached;
  state.apply({ type: 'attached', value: attached });
  if (wasAttached && !attached) {
    clearRemoteActivityTimer(sessionId);
    remoteSeedFloors.set(sessionId, Date.now());
    state.apply({ type: 'busy', active: false, armReady: false });
    setActivity(sessionId, false, 'remote-attach-handoff', { armReady: false });
    // Drops the shadow local-pty entry setActivity() just touched above — see .ai/contexts/session-state.md ("The local-pty adapter")
    purgeActivityFor(sessionId, 'remote-detach');
  }
  projectRemoteState(sessionId);
}

// see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
function applyRemoteStopped(sessionId) {
  clearRemoteActivityTimer(sessionId);
  clearRemoteAgentsTimer(sessionId);
  if (typeof clearActiveSubagentsFor === 'function') clearActiveSubagentsFor(sessionId);
  const state = remoteState(sessionId);
  state.apply({ type: 'busy', active: false, armReady: false });
  state.apply({ type: 'attention', active: false });
  state.apply({ type: 'subagentCompleted', stillActive: false });
  state.apply({ type: 'liveness', value: 'dead' });
  state.apply({ type: 'attached', value: false });
  projectRemoteState(sessionId);
  purgeActivityFor(sessionId, 'remote-stop');
}

function seedRemoteActivity(session) {
  if (!session || !session.remoteAlias) return;
  applyRemoteDescriptor(session);

  if (!Number.isFinite(session.remoteActiveAt)) return;
  const sessionId = session.sessionId;
  const floor = remoteSeedFloors.get(sessionId);
  if (floor !== undefined && session.remoteActiveAt <= floor) return; // stale — see setRemoteAttached, #273
  const remaining = session.remoteActiveAt + PIP_DECAY_MS - Date.now();
  if (remaining <= 0) return;
  markRemoteBusy(sessionId, 'remote-seed', session.remoteActiveAt);
  if (remoteActivityDecayTimers.has(sessionId)) return;
  armRemoteDecayTimer(sessionId, remaining);
}

window.api.onRemoteActivity(onRemoteActivityEvent);
