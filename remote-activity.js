// see .ai/contexts/session-cache.md ("Remote hosts — busy spinner (issue #242)")
'use strict';

const { subagentParentFromParts } = require('./subagent-attribution');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_DECAY_MS = 20000;
const DEFAULT_IPC_MIN_MS = 1000;
const DEFAULT_MAX_ENTRIES = 4096;

function sessionIdFromRel(rel) {
  const base = (typeof rel === 'string' ? rel : '').split('/').pop() || '';
  const sessionId = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
  return SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

function createRemoteActivityTracker(opts = {}) {
  const decayMs = opts.decayMs || DEFAULT_DECAY_MS;
  const ipcMinMs = opts.ipcMinMs || DEFAULT_IPC_MIN_MS;
  const now = opts.now || Date.now;
  const maxEntries = Number.isSafeInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
  const onActivity = typeof opts.onActivity === 'function' ? opts.onActivity : null;
  const schedule = opts.setTimeout || setTimeout;
  const cancel = opts.clearTimeout || clearTimeout;

  const seenAt = new Map();
  const ipcAt = new Map();
  const observedAt = new Map();
  const pending = new Map();
  let disposed = false;

  function key(alias, sessionId) {
    return JSON.stringify([alias, sessionId]);
  }

  function forget(k) {
    observedAt.delete(k);
    seenAt.delete(k);
    ipcAt.delete(k);
    const entry = pending.get(k);
    if (entry) cancel(entry.timer);
    pending.delete(k);
  }

  function prune(t) {
    for (const [k, at] of seenAt) {
      if (t - at > decayMs) seenAt.delete(k);
    }
    for (const [k, at] of observedAt) {
      if (t - at > decayMs && !pending.has(k)) forget(k);
    }
  }

  function emit(k, payload) {
    const t = now();
    prune(t);
    observedAt.delete(k);
    observedAt.set(k, t);
    while (observedAt.size > maxEntries) forget(observedAt.keys().next().value);
    const last = ipcAt.has(k) ? ipcAt.get(k) : -Infinity;
    if (t - last < ipcMinMs) {
      if (onActivity) {
        const previous = pending.get(k);
        if (previous) previous.payload = payload;
        else {
          const entry = { payload };
          entry.timer = schedule(() => {
            if (disposed || pending.get(k) !== entry) return;
            pending.delete(k);
            ipcAt.set(k, now());
            onActivity(entry.payload);
          }, ipcMinMs - (t - last));
          pending.set(k, entry);
        }
      }
      return null;
    }
    const previous = pending.get(k);
    if (previous) cancel(previous.timer);
    pending.delete(k);
    ipcAt.set(k, t);
    if (onActivity) onActivity(payload);
    return payload;
  }

  function record(alias, rel) {
    if (disposed) return null;
    const sessionId = sessionIdFromRel(rel);
    if (sessionId) {
      const t = now();
      const k = key(alias, sessionId);
      const result = emit(k, { alias, sessionId, at: t });
      seenAt.set(k, t);
      return result;
    }

    // subagent leg fallback (issue #247) — see .ai/contexts/subagent-observability.md
    const parts = (typeof rel === 'string' ? rel : '').split('/');
    const attribution = subagentParentFromParts(parts);
    if (!attribution) return null;
    const { parentSessionId, agentId } = attribution;
    const t = now();
    const k = JSON.stringify([alias, 'sub', parentSessionId, agentId]);
    return emit(k, { alias, parentSessionId, agentId, at: t, kind: 'subagent' });
  }

  function activeAt(alias, sessionId) {
    prune(now());
    const k = key(alias, sessionId);
    return seenAt.has(k) ? seenAt.get(k) : null;
  }

  function stats() {
    prune(now());
    return { seen: seenAt.size, ipc: ipcAt.size };
  }

  function dispose() {
    disposed = true;
    for (const entry of pending.values()) cancel(entry.timer);
    pending.clear();
    seenAt.clear();
    ipcAt.clear();
    observedAt.clear();
  }

  return { record, activeAt, stats, dispose };
}

module.exports = { createRemoteActivityTracker, sessionIdFromRel, SESSION_ID_RE };
