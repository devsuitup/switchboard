// viewer-file-watch.js — the file watch behind a ViewerPanel — see .ai/contexts/viewer-panel.md ("Watching the file")

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 300;

function sameFileName(a, b, platform = process.platform) {
  if (platform === 'win32' || platform === 'darwin') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function realTarget(resolvedPath, deps) {
  const realpath = deps.realpath || fs.realpathSync.native || fs.realpathSync;
  try {
    return realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isSymlink(resolvedPath, deps) {
  const lstat = deps.lstat || fs.lstatSync;
  try {
    return lstat(resolvedPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The directory entries to watch for `resolvedPath`: its real target, and the
 * link itself when the path is a symlink.
 */
function watchTargets(resolvedPath, deps = {}) {
  const target = realTarget(resolvedPath, deps);
  const targets = [{ dir: path.dirname(target), name: path.basename(target) }];
  if (isSymlink(resolvedPath, deps)) {
    const link = { dir: path.dirname(resolvedPath), name: path.basename(resolvedPath) };
    if (link.dir !== targets[0].dir || link.name !== targets[0].name) targets.push(link);
  }
  return targets;
}

/**
 * deps: {watchFn(dirPath, handler) -> {close()}, send(), debounceMs, scheduler, platform, realpath, lstat}
 * Returns {close()}; throws when no directory can be watched.
 */
function watchFileForViewer(resolvedPath, deps) {
  const watchFn = deps.watchFn || ((dir, handler) => fs.watch(dir, handler));
  const send = deps.send;
  const debounceMs = deps.debounceMs === undefined ? DEFAULT_DEBOUNCE_MS : deps.debounceMs;
  const schedule = (deps.scheduler && deps.scheduler.setTimeout) || setTimeout;
  const unschedule = (deps.scheduler && deps.scheduler.clearTimeout) || clearTimeout;
  const platform = deps.platform || process.platform;

  let timer = null;
  let closed = false;
  const watchers = [];

  const onEvent = (name) => (_eventType, filename) => {
    if (closed) return;
    if (filename != null && !sameFileName(String(filename), name, platform)) return;
    if (timer) unschedule(timer);
    timer = schedule(() => {
      timer = null;
      if (!closed) send();
    }, debounceMs);
  };

  let lastError = null;
  for (const { dir, name } of watchTargets(resolvedPath, deps)) {
    try {
      const watcher = watchFn(dir, onEvent(name));
      if (watcher && typeof watcher.on === 'function') watcher.on('error', () => {});
      watchers.push(watcher);
    } catch (err) {
      lastError = err;
    }
  }
  if (!watchers.length) throw lastError || new Error('could not watch this file');

  return {
    close() {
      closed = true;
      if (timer) unschedule(timer);
      timer = null;
      for (const watcher of watchers) {
        try { watcher.close(); } catch {}
      }
    },
  };
}

/**
 * One watch per path, shared by every panel showing it and closed with the last.
 * deps: as watchFileForViewer, with send(resolvedPath).
 */
function createViewerWatchRegistry(deps) {
  const entries = new Map();

  function watch(resolvedPath) {
    const entry = entries.get(resolvedPath);
    if (entry) {
      entry.refs += 1;
      return { ok: true };
    }
    try {
      const handle = watchFileForViewer(resolvedPath, { ...deps, send: () => deps.send(resolvedPath) });
      entries.set(resolvedPath, { handle, refs: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function unwatch(resolvedPath) {
    const entry = entries.get(resolvedPath);
    if (!entry) return { ok: true };
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entries.delete(resolvedPath);
      try { entry.handle.close(); } catch {}
    }
    return { ok: true };
  }

  function closeAll() {
    for (const [key, entry] of Array.from(entries)) {
      entries.delete(key);
      try { entry.handle.close(); } catch {}
    }
  }

  return { watch, unwatch, closeAll, size: () => entries.size, refs: (p) => (entries.get(p) || { refs: 0 }).refs };
}

module.exports = { watchFileForViewer, createViewerWatchRegistry, sameFileName, watchTargets, DEFAULT_DEBOUNCE_MS };
