// See .ai/contexts/session-cache.md ("Remote hosts — activity pip").

const PIP_DECAY_MS = 20000;
const remoteActivityDecayTimers = new Map();

function clearRemoteActivityTimer(sessionId) {
  const t = remoteActivityDecayTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    remoteActivityDecayTimers.delete(sessionId);
  }
}

function pruneRemoteActivityTimers() {
  for (const sessionId of remoteActivityDecayTimers.keys()) {
    if (!sessionItemEl(sessionId)) clearRemoteActivityTimer(sessionId);
  }
}

function onRemoteActivityEvent(payload) {
  const sessionId = payload && payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;
  sessionBusyState.set(sessionId, true);
  applyActivityClasses(sessionId);
  clearRemoteActivityTimer(sessionId);
  remoteActivityDecayTimers.set(sessionId, setTimeout(() => {
    remoteActivityDecayTimers.delete(sessionId);
    sessionBusyState.set(sessionId, false);
    applyActivityClasses(sessionId);
  }, PIP_DECAY_MS));
}

window.api.onRemoteActivity(onRemoteActivityEvent);
