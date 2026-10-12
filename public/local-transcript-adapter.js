// local-transcript adapter — see .ai/contexts/session-state.md

// shares the remote-ssh adapter's 20s decay window — see .ai/contexts/session-state.md
const LOCAL_TRANSCRIPT_DECAY_MS = 20000;
const localTranscriptDecayTimers = new Map();

// separate decay for subagent attribution (agentsBusy) — see .ai/contexts/subagent-observability.md
const localTranscriptAgentsDecayTimers = new Map();

// one persistent state per session id, same shape as remoteSessionStates — see .ai/contexts/session-state.md
const localTranscriptStates = new Map();
const localTranscriptDescriptorLosses = new Set();

function localTranscriptState(sessionId) {
  let state = localTranscriptStates.get(sessionId);
  if (!state) {
    state = createSessionState('local-transcript');
    localTranscriptStates.set(sessionId, state);
  }
  return state;
}

function projectLocalTranscriptState(sessionId) {
  applyStateClasses(sessionId, localTranscriptState(sessionId).snapshot());
}

function clearLocalTranscriptTimer(sessionId) {
  const t = localTranscriptDecayTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    localTranscriptDecayTimers.delete(sessionId);
  }
}

function clearLocalTranscriptAgentsTimer(sessionId) {
  const t = localTranscriptAgentsDecayTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    localTranscriptAgentsDecayTimers.delete(sessionId);
  }
}

// descriptorStatus/liveness from session.status — see .ai/contexts/session-state.md
function seedLocalTranscriptDescriptor(sessionId, session) {
  session = localSessionForStatus(sessionId, session);
  if (!session || session.status === undefined) {
    const state = localTranscriptStates.get(sessionId);
    if (state?.snapshot().liveness === 'alive') {
      localTranscriptDescriptorLosses.add(sessionId);
      clearLocalTranscriptTimer(sessionId);
      clearLocalTranscriptAgentsTimer(sessionId);
      localTranscriptStates.delete(sessionId);
    }
    return;
  }
  const state = localTranscriptState(sessionId);
  state.apply({ type: 'liveness', value: 'alive' });
  localTranscriptDescriptorLosses.delete(sessionId);
  state.apply({ type: 'descriptorStatus', status: session.status, at: session.statusUpdatedAt });
}

// silence means stopped writing, not response ready — see .ai/contexts/session-state.md
function decayLocalTranscriptBusy(sessionId) {
  if (!localTranscriptStates.has(sessionId)) return;
  clearLocalTranscriptTimer(sessionId);
  seedLocalTranscriptDescriptor(sessionId);
  const state = localTranscriptStates.get(sessionId);
  if (!state) return;
  if (localTranscriptDescriptorLosses.has(sessionId) && state.snapshot().liveness === 'unknown' && !localTranscriptAgentsDecayTimers.has(sessionId)) {
    clearLocalTranscriptTimer(sessionId);
    localTranscriptStates.delete(sessionId);
    applyStateClasses(sessionId, snapshotForLocal(sessionId));
    return;
  }
  state.apply({ type: 'busy', active: false, armReady: false });
  projectLocalTranscriptState(sessionId);
}

function armLocalTranscriptDecayTimer(sessionId) {
  clearLocalTranscriptTimer(sessionId);
  localTranscriptDecayTimers.set(sessionId, setTimeout(() => {
    localTranscriptDecayTimers.delete(sessionId);
    decayLocalTranscriptBusy(sessionId);
  }, LOCAL_TRANSCRIPT_DECAY_MS));
}

// silence means the subagent stopped, not finished — see .ai/contexts/subagent-observability.md
function decayLocalTranscriptAgentsBusy(sessionId) {
  if (!localTranscriptStates.has(sessionId)) return;
  clearLocalTranscriptAgentsTimer(sessionId);
  seedLocalTranscriptDescriptor(sessionId);
  const state = localTranscriptStates.get(sessionId);
  if (!state) return;
  if (localTranscriptDescriptorLosses.has(sessionId) && state.snapshot().liveness === 'unknown' && !localTranscriptDecayTimers.has(sessionId)) {
    localTranscriptStates.delete(sessionId);
    applyStateClasses(sessionId, snapshotForLocal(sessionId));
    return;
  }
  state.apply({ type: 'subagentCompleted', stillActive: false });
  projectLocalTranscriptState(sessionId);
}

function armLocalTranscriptAgentsDecayTimer(sessionId) {
  clearLocalTranscriptAgentsTimer(sessionId);
  localTranscriptAgentsDecayTimers.set(sessionId, setTimeout(() => {
    localTranscriptAgentsDecayTimers.delete(sessionId);
    decayLocalTranscriptAgentsBusy(sessionId);
  }, LOCAL_TRANSCRIPT_DECAY_MS));
}

// see .ai/contexts/session-state.md ("The local-transcript adapter (step 4)")
function onLocalTranscriptActivity(payload) {
  if (payload && payload.kind === 'subagent') {
    onLocalTranscriptSubagentActivity(payload);
    return;
  }
  const sessionId = payload && payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;
  if (activePtyIds.has(sessionId)) return;
  const state = localTranscriptState(sessionId);
  state.apply({ type: 'transcriptTouched', at: payload.at || Date.now(), source: 'local-transcript' });
  state.apply({ type: 'busy', active: true });
  seedLocalTranscriptDescriptor(sessionId);
  if (!localTranscriptStates.has(sessionId)) return;
  projectLocalTranscriptState(sessionId);
  armLocalTranscriptDecayTimer(sessionId);
}

// attributes a subagent write to its parent's own state — see .ai/contexts/subagent-observability.md
function onLocalTranscriptSubagentActivity(payload) {
  const parentSessionId = payload && payload.parentSessionId;
  if (typeof parentSessionId !== 'string' || !parentSessionId) return;
  if (activePtyIds.has(parentSessionId)) return;
  const state = localTranscriptState(parentSessionId);
  state.apply({ type: 'subagentSpawned' });
  seedLocalTranscriptDescriptor(parentSessionId);
  if (!localTranscriptStates.has(parentSessionId)) return;
  projectLocalTranscriptState(parentSessionId);
  armLocalTranscriptAgentsDecayTimer(parentSessionId);
  // per-(parent, agentId) running set for the child row's own dot — see .ai/contexts/subagent-observability.md
  const agentId = payload.agentId;
  if (typeof agentId === 'string' && agentId && typeof noteSubagentActivity === 'function') {
    noteSubagentActivity(parentSessionId, agentId, 'local-transcript');
  }
}

// called once a row gains a PTY; the local-pty path takes over from here — see .ai/contexts/session-state.md
function localTranscriptPtyTakeover(sessionId) {
  localTranscriptDescriptorLosses.delete(sessionId);
  if (!localTranscriptStates.has(sessionId)) return;
  clearLocalTranscriptTimer(sessionId);
  clearLocalTranscriptAgentsTimer(sessionId);
  localTranscriptStates.delete(sessionId);
}

function pruneLocalTranscriptTimers() {
  for (const sessionId of localTranscriptDescriptorLosses) {
    if (!sessionItemEl(sessionId)) localTranscriptDescriptorLosses.delete(sessionId);
  }
  for (const sessionId of localTranscriptDecayTimers.keys()) {
    if (!sessionItemEl(sessionId)) clearLocalTranscriptTimer(sessionId);
  }
  for (const sessionId of localTranscriptAgentsDecayTimers.keys()) {
    if (!sessionItemEl(sessionId)) clearLocalTranscriptAgentsTimer(sessionId);
  }
  for (const sessionId of localTranscriptStates.keys()) {
    if (!sessionItemEl(sessionId)) localTranscriptStates.delete(sessionId);
  }
}

// called by app.js once its state exists — see .ai/contexts/session-state.md
function initLocalTranscriptAdapter() {
  window.api.onSessionTranscriptActivity(onLocalTranscriptActivity);
}
