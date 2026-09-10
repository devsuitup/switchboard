// See .ai/contexts/session-cache.md ("Remote hosts — activity pip").

const PIP_DECAY_MS = 20000;
const remoteActivityDecayTimers = new Map();

function remoteActivityDotFor(sessionId) {
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  return item ? item.querySelector('.remote-activity-dot') : null;
}

function clearRemoteActivityTimer(sessionId) {
  const t = remoteActivityDecayTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    remoteActivityDecayTimers.delete(sessionId);
  }
}

function pruneRemoteActivityTimers() {
  for (const sessionId of remoteActivityDecayTimers.keys()) {
    if (!remoteActivityDotFor(sessionId)) clearRemoteActivityTimer(sessionId);
  }
}

function onRemoteActivityEvent(payload) {
  const sessionId = payload && payload.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return;
  const dot = remoteActivityDotFor(sessionId);
  if (dot) dot.classList.add('active');
  clearRemoteActivityTimer(sessionId);
  remoteActivityDecayTimers.set(sessionId, setTimeout(() => {
    remoteActivityDecayTimers.delete(sessionId);
    const el = remoteActivityDotFor(sessionId);
    if (el) el.classList.remove('active');
  }, PIP_DECAY_MS));
}

window.api.onRemoteActivity(onRemoteActivityEvent);
