// see .ai/contexts/session-state.md
'use strict';

const { subagentParentFromParts } = require('./subagent-attribution');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_IPC_MIN_MS = 1000;
const FIRST_WRITE_MTIME_ALLOWANCE_MS = 2000;
const DIRTY_RECHECK_DELAY_MS = 25;
const DEFAULT_MAX_FILES = 4096;
const DEFAULT_BASELINE_TTL_MS = 5 * 60 * 1000;

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
  const firstWriteFloor = trackerCreatedAt - FIRST_WRITE_MTIME_ALLOWANCE_MS;
  const hasPty = typeof opts.hasPty === 'function' ? opts.hasPty : () => false;
  const files = opts.fs || fs.promises;
  const onActivity = opts.onActivity || (() => {});
  const schedule = opts.setTimeout || setTimeout;
  const cancel = opts.clearTimeout || clearTimeout;
  const maxFiles = Number.isSafeInteger(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_MAX_FILES;
  const baselineTtlMs = opts.baselineTtlMs > 0 ? opts.baselineTtlMs : DEFAULT_BASELINE_TTL_MS;

  const ipcAt = new Map();
  const baselines = new Map();
  const forgotten = new Map();
  const inFlight = new Map();
  const pending = new Map();
  const rechecks = new Map();
  let disposed = false;

  function cancelPending(file) {
    const baseline = baselines.get(file);
    const entry = baseline && pending.get(baseline.key);
    if (!entry || entry.file !== file) return;
    cancel(entry.timer);
    pending.delete(baseline.key);
  }

  function forgetFile(file) {
    const previous = baselines.get(file);
    if (previous) {
      forgotten.delete(file);
      forgotten.set(file, { mtimeMs: previous.mtimeMs, floor: now() - FIRST_WRITE_MTIME_ALLOWANCE_MS });
      while (forgotten.size > maxFiles) forgotten.delete(forgotten.keys().next().value);
    }
    cancelPending(file);
    if (rechecks.has(file)) cancel(rechecks.get(file));
    rechecks.delete(file);
    baselines.delete(file);
    if (previous && ipcAt.get(previous.key)?.file === file) ipcAt.delete(previous.key);
  }

  function prune() {
    const t = now();
    for (const [file, baseline] of baselines) {
      if (t - baseline.seenAt <= baselineTtlMs) break;
      forgetFile(file);
    }
  }

  function saveBaseline(file, baseline) {
    forgotten.delete(file);
    baselines.delete(file);
    baselines.set(file, baseline);
    while (baselines.size > maxFiles) forgetFile(baselines.keys().next().value);
  }

  function emit(key, payload, file, parts) {
    const t = now();
    const last = ipcAt.has(key) ? ipcAt.get(key).at : -Infinity;
    if (t - last < ipcMinMs) {
      const previous = pending.get(key);
      if (previous) cancel(previous.timer);
      const entry = { file, parts, payload };
      const deliver = async () => {
        await record(entry.parts);
        if (disposed || pending.get(key) !== entry) return;
        if (rechecks.has(file)) {
          entry.timer = schedule(deliver, DIRTY_RECHECK_DELAY_MS);
          return;
        }
        pending.delete(key);
        if (!baselines.has(file) || hasPty(payload.sessionId || payload.parentSessionId)) return;
        ipcAt.set(key, { at: now(), file });
        onActivity(entry.payload);
      };
      entry.timer = schedule(deliver, ipcMinMs - (t - last));
      pending.set(key, entry);
      return null;
    }
    const previous = pending.get(key);
    if (previous) cancel(previous.timer);
    pending.delete(key);
    ipcAt.set(key, { at: t, file });
    onActivity(payload);
    return payload;
  }

  function sameIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
  }

  async function verify(file, work) {
    const previous = baselines.get(file);
    const tombstone = forgotten.get(file);
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
      if (opts.onTranscript && work.sessionId) opts.onTranscript(file, work.sessionId, work.agentId);
      saveBaseline(file, { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs,
        size: stat.size, mtimeMs: stat.mtimeMs, key: work.key, seenAt: now() });
      if (!previous) return stat.size > 0 && stat.mtimeMs >= firstWriteFloor &&
        (!tombstone || (stat.mtimeMs > tombstone.mtimeMs && stat.mtimeMs >= tombstone.floor));
      if (!sameIdentity(previous, stat) || stat.size < previous.size || stat.mtimeMs < previous.mtimeMs) {
        cancelPending(file);
        return false;
      }
      return stat.size > 0 && (stat.size > previous.size || stat.mtimeMs > previous.mtimeMs);
    } catch {
      forgetFile(file);
      return false;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function verifiedRecord(parts, file, work) {
    if (!await verify(file, work) || disposed || !baselines.has(file)) return null;
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
    const key = JSON.stringify(['sub', parentSessionId, agentId]);
    const t = now();
    return emit(key, { parentSessionId, agentId, at: t, kind: 'subagent' }, file, parts);
  }

  function record(parts) {
    if (disposed || !opts.projectsDir || (!sessionIdFromWatchParts(parts) && !subagentParentFromParts(parts)) ||
        parts.some(part => typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/]/.test(part))) return Promise.resolve(null);
    const file = path.join(opts.projectsDir, ...parts);
    prune();
    const baseline = baselines.get(file);
    if (baseline) saveBaseline(file, { ...baseline, seenAt: now() });
    const running = inFlight.get(file);
    if (running) {
      running.dirty = true;
      return running.promise;
    }
    if (rechecks.has(file)) cancel(rechecks.get(file));
    rechecks.delete(file);
    const sessionId = sessionIdFromWatchParts(parts);
    const attribution = sessionId ? null : subagentParentFromParts(parts);
    const key = sessionId || JSON.stringify(['sub', attribution.parentSessionId, attribution.agentId]);
    const work = { dirty: false, key, sessionId: sessionId || attribution.parentSessionId, agentId: attribution?.agentId };
    work.promise = (async () => {
      let result = null;
      let attempts = 0;
      do {
        work.dirty = false;
        const activity = await verifiedRecord(parts, file, work);
        if (activity) result = activity;
        attempts++;
      } while (work.dirty && !disposed && attempts < 2);
      return result;
    })().finally(() => {
      inFlight.delete(file);
      if (work.dirty && !disposed && !rechecks.has(file)) {
        const timer = schedule(async () => {
          rechecks.delete(file);
          await record(parts);
        }, DIRTY_RECHECK_DELAY_MS);
        rechecks.set(file, timer);
      }
    });
    inFlight.set(file, work);
    return work.promise;
  }

  function stats() {
    prune();
    return { baselines: baselines.size, ipc: ipcAt.size, pending: pending.size, inFlight: inFlight.size };
  }

  function dispose() {
    disposed = true;
    for (const entry of pending.values()) cancel(entry.timer);
    for (const timer of rechecks.values()) cancel(timer);
    pending.clear();
    rechecks.clear();
    baselines.clear();
    forgotten.clear();
    ipcAt.clear();
  }

  return { record, dispose, stats };
}

module.exports = { createLocalTranscriptTracker, sessionIdFromWatchParts, SESSION_ID_RE };
