// See .ai/contexts/session-cache.md ("Remote hosts — busy spinner (issue #242)").

const PIP_DECAY_MS = 20000;
const remoteActivityDecayTimers = new Map();

function clearRemoteActivityTimer(sessionId) {
  const t = remoteActivityDecayTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    remoteActivityDecayTimers.delete(sessionId);
  }
}

function armRemoteDecayTimer(sessionId, ms) {
  remoteActivityDecayTimers.set(sessionId, setTimeout(() => {
    remoteActivityDecayTimers.delete(sessionId);
    // silence is "stopped writing", not "response ready" — see .ai/contexts/session-cache.md ("Remote hosts — busy spinner")
    setActivity(sessionId, false, 'remote-decay', { armReady: false });
  }, ms));
}

function pruneRemoteActivityTimers() {
  for (const sessionId of remoteActivityDecayTimers.keys()) {
    if (!sessionItemEl(sessionId)) clearRemoteActivityTimer(sessionId);
  }
}

function onRemoteActivityEvent(payload) {
  const sessionId = payload && payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;
  setActivity(sessionId, true, 'remote-watch');
  clearRemoteActivityTimer(sessionId);
  armRemoteDecayTimer(sessionId, PIP_DECAY_MS);
}

function seedRemoteActivity(session) {
  if (!session || !session.remoteAlias) return;
  if (!Number.isFinite(session.remoteActiveAt)) return;
  const sessionId = session.sessionId;
  const remaining = session.remoteActiveAt + PIP_DECAY_MS - Date.now();
  if (remaining <= 0) return;
  setActivity(sessionId, true, 'remote-seed');
  if (remoteActivityDecayTimers.has(sessionId)) return;
  armRemoteDecayTimer(sessionId, remaining);
}

window.api.onRemoteActivity(onRemoteActivityEvent);
