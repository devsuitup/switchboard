// viewer-file-watch.js — the file watch behind a ViewerPanel — see .ai/contexts/viewer-panel.md ("Watching the file")

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 300;

function realTarget(resolvedPath) {
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

/**
 * deps: {watchFn(dirPath, handler) -> {close()}, send(), debounceMs, scheduler}
 * Returns {close()}; throws when the directory cannot be watched.
 */
function watchFileForViewer(resolvedPath, deps) {
  const watchFn = deps.watchFn || ((dir, handler) => fs.watch(dir, handler));
  const send = deps.send;
  const debounceMs = deps.debounceMs === undefined ? DEFAULT_DEBOUNCE_MS : deps.debounceMs;
  const schedule = (deps.scheduler && deps.scheduler.setTimeout) || setTimeout;
  const unschedule = (deps.scheduler && deps.scheduler.clearTimeout) || clearTimeout;

  const target = realTarget(resolvedPath);
  const dir = path.dirname(target);
  const name = path.basename(target);

  let timer = null;
  let closed = false;

  const watcher = watchFn(dir, (_eventType, filename) => {
    if (closed) return;
    if (filename != null && String(filename) !== name) return;
    if (timer) unschedule(timer);
    timer = schedule(() => {
      timer = null;
      if (!closed) send();
    }, debounceMs);
  });
  if (watcher && typeof watcher.on === 'function') watcher.on('error', () => {});

  return {
    close() {
      closed = true;
      if (timer) unschedule(timer);
      timer = null;
      watcher.close();
    },
  };
}

module.exports = { watchFileForViewer, DEFAULT_DEBOUNCE_MS };
