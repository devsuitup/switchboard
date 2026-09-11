// see .ai/contexts/session-cache.md ("Remote hosts — busy spinner (issue #242)")
'use strict';

const { subagentParentFromParts } = require('./subagent-attribution');

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
    for (const [k, at] of ipcAt) {
      if (t - at > decayMs) ipcAt.delete(k);
    }
  }

  function record(alias, rel) {
    const sessionId = sessionIdFromRel(rel);
    if (sessionId) {
      const t = now();
      const k = key(alias, sessionId);
      seenAt.set(k, t);
      prune(t);
      const lastIpc = ipcAt.has(k) ? ipcAt.get(k) : -Infinity;
      if (t - lastIpc < ipcMinMs) return null;
      ipcAt.set(k, t);
      return { alias, sessionId, at: t };
    }

    // subagent leg fallback (issue #247) — see .ai/contexts/subagent-observability.md
    const parts = (typeof rel === 'string' ? rel : '').split('/');
    const attribution = subagentParentFromParts(parts);
    if (!attribution) return null;
    const { parentSessionId, agentId } = attribution;
    const t = now();
    const k = key(alias, 'sub:' + parentSessionId); // distinct namespace: never collides with a UUID sessionId key
    prune(t);
    const lastIpc = ipcAt.has(k) ? ipcAt.get(k) : -Infinity;
    if (t - lastIpc < ipcMinMs) return null;
    ipcAt.set(k, t);
    return { alias, parentSessionId, agentId, at: t, kind: 'subagent' };
  }

  function activeAt(alias, sessionId) {
    prune(now());
    const k = key(alias, sessionId);
    return seenAt.has(k) ? seenAt.get(k) : null;
  }

  function stats() {
    return { seen: seenAt.size, ipc: ipcAt.size };
  }

  return { record, activeAt, stats };
}

module.exports = { createRemoteActivityTracker, sessionIdFromRel, SESSION_ID_RE };
