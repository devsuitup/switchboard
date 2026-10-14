// see .ai/contexts/session-state.md
'use strict';

const { subagentParentFromParts } = require('./subagent-attribution');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_IPC_MIN_MS = 1000;
const FIRST_WRITE_MTIME_ALLOWANCE_MS = 2000;

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
  const trackerCreatedAt = now();
  const hasPty = typeof opts.hasPty === 'function' ? opts.hasPty : () => false;
  const files = opts.fs || fs.promises;
  const onActivity = opts.onActivity || (() => {});
  const schedule = opts.setTimeout || setTimeout;
  const cancel = opts.clearTimeout || clearTimeout;

  const ipcAt = new Map();
  const baselines = new Map();
  const inFlight = new Map();
  const pending = new Map();
  let disposed = false;

  function cancelPending(file) {
    for (const [key, entry] of pending) {
      if (entry.file !== file) continue;
      cancel(entry.timer);
      pending.delete(key);
    }
  }

  function emit(key, payload, file, parts) {
    const t = now();
    const last = ipcAt.has(key) ? ipcAt.get(key) : -Infinity;
    if (t - last < ipcMinMs) {
      const previous = pending.get(key);
      if (previous) cancel(previous.timer);
      const entry = { file, parts, payload };
      entry.timer = schedule(async () => {
        await record(entry.parts);
        if (disposed || pending.get(key) !== entry) return;
        pending.delete(key);
        if (!baselines.has(file) || hasPty(payload.sessionId || payload.parentSessionId)) return;
        ipcAt.set(key, now());
        onActivity(entry.payload);
      }, ipcMinMs - (t - last));
      pending.set(key, entry);
      return null;
    }
    const previous = pending.get(key);
    if (previous) cancel(previous.timer);
    pending.delete(key);
    ipcAt.set(key, t);
    onActivity(payload);
    return payload;
  }

  function sameIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
  }

  async function verify(file, work) {
    const previous = baselines.get(file);
    let handle;
    try {
      handle = await files.open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a transcript file');
      const current = await files.stat(file);
      if (!sameIdentity(stat, current) || current.size < stat.size || current.mtimeMs < stat.mtimeMs) {
        throw new Error('transcript invalidated during verification');
      }
      if (disposed) return false;
      if (current.size > stat.size || current.mtimeMs > stat.mtimeMs) {
        work.dirty = true;
        return false;
      }
      baselines.set(file, { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, size: stat.size, mtimeMs: stat.mtimeMs });
      if (!previous) return stat.size > 0 && stat.mtimeMs >= trackerCreatedAt - FIRST_WRITE_MTIME_ALLOWANCE_MS;
      if (!sameIdentity(previous, stat) || stat.size < previous.size || stat.mtimeMs < previous.mtimeMs) {
        cancelPending(file);
        return false;
      }
      return stat.size > 0 && (stat.size > previous.size || stat.mtimeMs > previous.mtimeMs);
    } catch {
      baselines.delete(file);
      cancelPending(file);
      return false;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function verifiedRecord(parts, file, work) {
    if (!await verify(file, work) || disposed) return null;
    const sessionId = sessionIdFromWatchParts(parts);
    if (sessionId) {
      if (hasPty(sessionId)) return null;
      const t = now();
      return emit(sessionId, { sessionId, at: t }, file, parts);
    }

    // subagent leg fallback (issue #247) — see .ai/contexts/subagent-observability.md
    const attribution = subagentParentFromParts(parts);
    if (!attribution) return null;
    const { parentSessionId, agentId } = attribution;
    if (hasPty(parentSessionId)) return null;
    const key = 'sub:' + parentSessionId; // distinct namespace — see .ai/contexts/subagent-observability.md
    const t = now();
    return emit(key, { parentSessionId, agentId, at: t, kind: 'subagent' }, file, parts);
  }

  function record(parts) {
    if (disposed || !opts.projectsDir || (!sessionIdFromWatchParts(parts) && !subagentParentFromParts(parts)) ||
        parts.some(part => typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/]/.test(part))) return Promise.resolve(null);
    const file = path.join(opts.projectsDir, ...parts);
    const running = inFlight.get(file);
    if (running) {
      running.dirty = true;
      return running.promise;
    }
    const work = { dirty: false };
    work.promise = (async () => {
      let result = null;
      do {
        work.dirty = false;
        const activity = await verifiedRecord(parts, file, work);
        if (activity) result = activity;
      } while (work.dirty && !disposed);
      return result;
    })().finally(() => inFlight.delete(file));
    inFlight.set(file, work);
    return work.promise;
  }

  function dispose() {
    disposed = true;
    for (const entry of pending.values()) cancel(entry.timer);
    pending.clear();
    baselines.clear();
    ipcAt.clear();
  }

  return { record, dispose };
}

module.exports = { createLocalTranscriptTracker, sessionIdFromWatchParts, SESSION_ID_RE };
