'use strict';

// see .ai/contexts/viewer-panel.md ("Unsaved edits on quit, reload and close")

const DEFAULT_TIMEOUT_MS = 2500;

function createUnsavedGuard({ ipcMain, timeoutMs = DEFAULT_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  const pending = new Map();
  let nextId = 1;

  ipcMain.on('unsaved-check-result', (_event, id, proceed) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeoutFn(entry.timer);
    entry.resolve(proceed === true);
  });

  function ask(win, reason) {
    const wc = win.webContents;
    if (win.isDestroyed() || !wc || wc.isDestroyed() || wc.isCrashed()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeoutFn(() => {
        pending.delete(id);
        resolve(true);
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        wc.send('unsaved-check', id, reason);
      } catch {
        pending.delete(id);
        clearTimeoutFn(timer);
        resolve(true);
      }
    });
  }

  function attach(win) {
    let approved = false;
    let closing = false;
    let reloading = false;

    win.on('close', (event) => {
      if (approved) return;
      event.preventDefault();
      if (closing) return;
      closing = true;
      ask(win, 'quit').then((proceed) => {
        closing = false;
        if (!proceed) return;
        approved = true;
        if (!win.isDestroyed()) win.close();
      });
    });

    win.webContents.on('will-prevent-unload', (event) => {
      if (approved) {
        event.preventDefault();
        return;
      }
      if (reloading) return;
      reloading = true;
      ask(win, 'reload').then((proceed) => {
        reloading = false;
        if (proceed && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.reload();
      });
    });
  }

  return { attach };
}

module.exports = { createUnsavedGuard, DEFAULT_TIMEOUT_MS };
