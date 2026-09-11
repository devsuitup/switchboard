// See .ai/contexts/session-cache.md ("Remote hosts — busy spinner (issue #242)")
// and .ai/contexts/session-state.md (migration step 3: the remote-ssh adapter).

const PIP_DECAY_MS = 20000;
const remoteActivityDecayTimers = new Map();

// separate decay for subagent attribution (agentsBusy) — see .ai/contexts/subagent-observability.md
const remoteAgentsDecayTimers = new Map();

// remote-ssh adapter: one persistent state per remote session id — see .ai/contexts/session-state.md
const remoteSessionStates = new Map();

function remoteState(sessionId) {
  let state = remoteSessionStates.get(sessionId);
  if (!state) {
    state = createSessionState('remote-ssh');
    remoteSessionStates.set(sessionId, state);
  }
  return state;
}

function projectRemoteState(sessionId) {
  applyStateClasses(sessionId, remoteState(sessionId).snapshot());
}

function clearRemoteActivityTimer(sessionId) {
  const t = remoteActivityDecayTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    remoteActivityDecayTimers.delete(sessionId);
  }
}

function clearRemoteAgentsTimer(sessionId) {
  const t = remoteAgentsDecayTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    remoteAgentsDecayTimers.delete(sessionId);
  }
}

// Maps still fed in parallel for sidebar initial paint and grid dot — see session-state.md "migration status"
function markRemoteBusy(sessionId, via, at) {
  const state = remoteState(sessionId);
  state.apply({ type: 'transcriptTouched', at: at || Date.now(), source: via });
  state.apply({ type: 'busy', active: true });
  setActivity(sessionId, true, via);
  projectRemoteState(sessionId);
}

// silence is "stopped writing", not "response ready" — see .ai/contexts/session-cache.md ("Remote hosts — busy spinner")
function decayRemoteBusy(sessionId) {
  const state = remoteState(sessionId);
  state.apply({ type: 'busy', active: false, armReady: false });
  setActivity(sessionId, false, 'remote-decay', { armReady: false });
  projectRemoteState(sessionId);
}

function armRemoteDecayTimer(sessionId, ms) {
  remoteActivityDecayTimers.set(sessionId, setTimeout(() => {
    remoteActivityDecayTimers.delete(sessionId);
    decayRemoteBusy(sessionId);
  }, ms));
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
}

function onRemoteActivityEvent(payload) {
  if (payload && payload.kind === 'subagent') {
    const parentSessionId = payload.parentSessionId;
    if (typeof parentSessionId !== 'string' || !parentSessionId) return;
    markRemoteSubagentBusy(parentSessionId);
    return;
  }
  const sessionId = payload && payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;
  markRemoteBusy(sessionId, 'remote-watch', payload.at);
  clearRemoteActivityTimer(sessionId);
  armRemoteDecayTimer(sessionId, PIP_DECAY_MS);
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
function setRemoteAttached(sessionId, attached) {
  if (!attached && !remoteSessionStates.has(sessionId)) return; // nothing recorded yet, nothing to clear
  const state = remoteState(sessionId);
  state.apply({ type: 'attached', value: attached });
  projectRemoteState(sessionId);
}

// see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
function applyRemoteStopped(sessionId) {
  clearRemoteActivityTimer(sessionId);
  clearRemoteAgentsTimer(sessionId);
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
  const remaining = session.remoteActiveAt + PIP_DECAY_MS - Date.now();
  if (remaining <= 0) return;
  markRemoteBusy(sessionId, 'remote-seed', session.remoteActiveAt);
  if (remoteActivityDecayTimers.has(sessionId)) return;
  armRemoteDecayTimer(sessionId, remaining);
}

window.api.onRemoteActivity(onRemoteActivityEvent);
