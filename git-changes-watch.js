// git-changes-watch.js — file watches for the editable Changes panel — see .ai/contexts/changes-view.md

'use strict';

const DEFAULT_DEBOUNCE_MS = 300;

function keyOf(sessionId, relPath) {
  return JSON.stringify([sessionId, relPath]);
}

/**
 * deps: {watchFn(path, handler) -> {close()}, send(sessionId, relPath), debounceMs, scheduler}
 * The registry never sees an absolute path leave it: `send` carries the
 * repo-relative path the renderer already has.
 */
function createChangesWatchRegistry(deps) {
  const watchFn = deps.watchFn;
  const send = deps.send;
  const debounceMs = deps.debounceMs === undefined ? DEFAULT_DEBOUNCE_MS : deps.debounceMs;
  const schedule = (deps.scheduler && deps.scheduler.setTimeout) || setTimeout;
  const unschedule = (deps.scheduler && deps.scheduler.clearTimeout) || clearTimeout;

  const entries = new Map();

  function arm(entry) {
    try {
      entry.watcher = watchFn(entry.resolvedPath, (eventType) => onEvent(entry, eventType));
      entry.armed = true;
    } catch {
      entry.watcher = null;
      entry.armed = false;
    }
    return entry.armed;
  }

  function disarm(entry) {
    if (entry.watcher) {
      try { entry.watcher.close(); } catch {}
    }
    entry.watcher = null;
    entry.armed = false;
  }

  // A rename replaces the inode the watch is bound to, so the watch is re-armed
  // on the same path once the replacement has settled.
  function onEvent(entry, eventType) {
    if (eventType === 'rename') entry.needsRearm = true;
    if (entry.timer) unschedule(entry.timer);
    entry.timer = schedule(() => {
      entry.timer = null;
      if (entry.needsRearm && entries.get(entry.key) === entry) {
        entry.needsRearm = false;
        disarm(entry);
        arm(entry);
      }
      if (entries.get(entry.key) === entry) send(entry.sessionId, entry.relPath);
    }, debounceMs);
  }

  function watch(sessionId, relPath, resolvedPath) {
    const key = keyOf(sessionId, relPath);
    unwatch(sessionId, relPath);
    const entry = { key, sessionId, relPath, resolvedPath, watcher: null, timer: null, armed: false, needsRearm: false };
    entries.set(key, entry);
    if (!arm(entry)) {
      entries.delete(key);
      return { ok: false, error: 'could not watch this file' };
    }
    return { ok: true };
  }

  function unwatch(sessionId, relPath) {
    const key = keyOf(sessionId, relPath);
    const entry = entries.get(key);
    if (!entry) return { ok: true };
    entries.delete(key);
    if (entry.timer) unschedule(entry.timer);
    disarm(entry);
    return { ok: true };
  }

  function closeAll() {
    for (const key of Array.from(entries.keys())) {
      const entry = entries.get(key);
      entries.delete(key);
      if (entry.timer) unschedule(entry.timer);
      disarm(entry);
    }
  }

  return { watch, unwatch, closeAll, size: () => entries.size };
}

module.exports = { createChangesWatchRegistry, DEFAULT_DEBOUNCE_MS };
