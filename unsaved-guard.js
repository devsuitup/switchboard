'use strict';

// see .ai/contexts/viewer-panel.md ("Unsaved edits on quit, reload and close")

const DEFAULT_TIMEOUT_MS = 2500;

function createUnsavedGuard({ ipcMain, timeoutMs = DEFAULT_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, quit = () => {} }) {
  const pending = new Map();
  let nextId = 1;
  let quitApproved = false;
  let quitAsking = false;
  let inflight = null;

  ipcMain.on('unsaved-check-ack', (_event, id) => {
    const entry = pending.get(id);
    if (!entry || entry.acked) return;
    entry.acked = true;
    clearTimeoutFn(entry.timer);
  });

  ipcMain.on('unsaved-check-result', (_event, id, proceed) => {
    const entry = pending.get(id);
    if (!entry) return;
    entry.finish(proceed === true);
  });

  function ask(win, reason) {
    if (inflight) return inflight;
    const wc = win.webContents;
    if (win.isDestroyed() || !wc || wc.isDestroyed() || wc.isCrashed()) return Promise.resolve(true);
    let settled = false;
    const asked = new Promise((resolve) => {
      const id = nextId++;
      const entry = { acked: false, timer: null, finish: null };
      const onGone = () => entry.finish(true);
      entry.finish = (proceed) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeoutFn(entry.timer);
        wc.removeListener('render-process-gone', onGone);
        wc.removeListener('destroyed', onGone);
        settled = true;
        inflight = null;
        resolve(proceed);
      };
      entry.timer = setTimeoutFn(() => entry.finish(true), timeoutMs);
      pending.set(id, entry);
      wc.on('render-process-gone', onGone);
      wc.on('destroyed', onGone);
      try {
        wc.send('unsaved-check', id, reason);
      } catch {
        entry.finish(true);
      }
    });
    if (!settled) inflight = asked;
    return asked;
  }

  function beforeQuit(event, win) {
    if (quitApproved || !win || win.isDestroyed()) return false;
    event.preventDefault();
    if (quitAsking) return true;
    quitAsking = true;
    ask(win, 'quit').then((proceed) => {
      quitAsking = false;
      if (!proceed) return;
      quitApproved = true;
      quit();
    });
    return true;
  }

  function attach(win) {
    let approved = false;
    let closing = false;
    let reloading = false;
    let allowNextUnload = false;

    win.on('query-session-end', approveQuit);
    win.on('session-end', approveQuit);

    win.on('close', (event) => {
      if (approved || quitApproved) return;
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
      if (approved || quitApproved || allowNextUnload) {
        allowNextUnload = false;
        event.preventDefault();
        return;
      }
      if (reloading) return;
      reloading = true;
      ask(win, 'reload').then((proceed) => {
        reloading = false;
        if (!proceed || win.isDestroyed() || win.webContents.isDestroyed()) return;
        allowNextUnload = true;
        win.webContents.reload();
      });
    });
  }

  function confirmQuit(win) {
    return ask(win, 'quit').then((proceed) => {
      if (proceed) quitApproved = true;
      return proceed;
    });
  }

  function approveQuit() {
    quitApproved = true;
  }

  return { attach, beforeQuit, confirmQuit, approveQuit };
}

module.exports = { createUnsavedGuard, DEFAULT_TIMEOUT_MS };
