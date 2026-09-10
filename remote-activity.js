// see .ai/contexts/session-cache.md ("Remote hosts — activity pip")
'use strict';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_DECAY_MS = 20000;
const DEFAULT_IPC_MIN_MS = 1000;

function sessionIdFromRel(rel) {
  const base = (typeof rel === 'string' ? rel : '').split('/').pop() || '';
  const sessionId = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
  return SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

function createRemoteActivityTracker(opts = {}) {
  const decayMs = opts.decayMs || DEFAULT_DECAY_MS;
  const ipcMinMs = opts.ipcMinMs || DEFAULT_IPC_MIN_MS;
  const now = opts.now || Date.now;

  const seenAt = new Map();
  const ipcAt = new Map();

  function key(alias, sessionId) {
    return alias + ' ' + sessionId;
  }

  function prune(t) {
    for (const [k, at] of seenAt) {
      if (t - at > decayMs) seenAt.delete(k);
    }
  }

  function record(alias, rel) {
    const sessionId = sessionIdFromRel(rel);
    if (!sessionId) return null;
    const t = now();
    const k = key(alias, sessionId);
    seenAt.set(k, t);
    prune(t);
    const lastIpc = ipcAt.has(k) ? ipcAt.get(k) : -Infinity;
    if (t - lastIpc < ipcMinMs) return null;
    ipcAt.set(k, t);
    return { alias, sessionId, at: t };
  }

  function activeAt(alias, sessionId) {
    prune(now());
    const k = key(alias, sessionId);
    return seenAt.has(k) ? seenAt.get(k) : null;
  }

  return { record, activeAt };
}

module.exports = { createRemoteActivityTracker, sessionIdFromRel, SESSION_ID_RE };
