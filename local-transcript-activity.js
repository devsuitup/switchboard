// see .ai/contexts/session-state.md
'use strict';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_IPC_MIN_MS = 1000;

// top-level transcript only, a subagent leg is out of scope — see .ai/contexts/session-state.md
function sessionIdFromWatchParts(parts) {
  if (!Array.isArray(parts) || parts.length !== 2) return null;
  const basename = parts[1];
  if (typeof basename !== 'string' || !basename.endsWith('.jsonl')) return null;
  const sessionId = basename.slice(0, -'.jsonl'.length);
  return SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

// hasPty() gates out a row the OSC path already owns — see .ai/contexts/session-state.md
function createLocalTranscriptTracker(opts = {}) {
  const ipcMinMs = opts.ipcMinMs || DEFAULT_IPC_MIN_MS;
  const now = opts.now || Date.now;
  const hasPty = typeof opts.hasPty === 'function' ? opts.hasPty : () => false;

  const ipcAt = new Map();

  function record(parts) {
    const sessionId = sessionIdFromWatchParts(parts);
    if (!sessionId) return null;
    if (hasPty(sessionId)) return null;
    const t = now();
    const last = ipcAt.has(sessionId) ? ipcAt.get(sessionId) : -Infinity;
    if (t - last < ipcMinMs) return null;
    ipcAt.set(sessionId, t);
    return { sessionId, at: t };
  }

  return { record };
}

module.exports = { createLocalTranscriptTracker, sessionIdFromWatchParts, SESSION_ID_RE };
