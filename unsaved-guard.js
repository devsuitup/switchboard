'use strict';

// see .ai/contexts/viewer-panel.md ("Unsaved edits on quit, reload and close")

const DEFAULT_TIMEOUT_MS = 2500;

function createUnsavedGuard({ ipcMain, timeoutMs = DEFAULT_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, quit = () => {} }) {
  const pending = new Map();
  let nextId = 1;
  let quitApproved = false;
  let quitAsking = false;
  let inflight = null;
  const windows = new WeakMap();

  ipcMain.on('unsaved-check-ack', (_event, id) => {
    const entry = pending.get(id);
    if (!entry || entry.acked) return;
    entry.acked = true;
    clearTimeoutFn(entry.timer);
    const state = windows.get(entry.win);
    if (state) state.unresponsive = false;
  });

  ipcMain.on('unsaved-check-result', (_event, id, proceed) => {
    const entry = pending.get(id);
    if (!entry) return;
    entry.finish(proceed === true);
  });

  function askFull(win, reason) {
    if (inflight) return inflight;
    const wc = win.webContents;
    if (win.isDestroyed() || !wc || wc.isDestroyed() || wc.isCrashed()) return Promise.resolve({ proceed: true, unanswered: false });
    let settled = false;
    const asked = new Promise((resolve) => {
      const id = nextId++;
      const entry = { win, acked: false, timer: null, finish: null };
      const onGone = () => entry.finish(true);
      entry.finish = (proceed, unanswered = false) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeoutFn(entry.timer);
        wc.removeListener('render-process-gone', onGone);
        wc.removeListener('destroyed', onGone);
        settled = true;
        inflight = null;
        resolve({ proceed, unanswered });
      };
      entry.timer = setTimeoutFn(() => entry.finish(true, true), timeoutMs);
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

  function ask(win, reason) {
    return askFull(win, reason).then(({ proceed }) => proceed);
  }

  function force(win) {
    if (!win.isDestroyed()) win.destroy();
  }

  function markUnanswered(win) {
    const state = windows.get(win);
    if (state) state.unanswered = true;
  }

  function forceIfUnresponsive(win) {
    const state = windows.get(win);
    if (state && state.unresponsive) force(win);
  }

  function beforeQuit(event, win) {
    if (quitApproved || !win || win.isDestroyed()) return false;
    event.preventDefault();
    if (quitAsking) return true;
    quitAsking = true;
    askFull(win, 'quit').then(({ proceed, unanswered }) => {
      quitAsking = false;
      if (!proceed) return;
      quitApproved = true;
      if (unanswered) markUnanswered(win);
      quit();
      if (unanswered) forceIfUnresponsive(win);
    });
    return true;
  }

  function attach(win) {
    let approved = false;
    let closing = false;
    let reloading = false;
    let allowNextUnload = false;
    const state = { unanswered: false, unresponsive: false, closesSeen: 0 };
    windows.set(win, state);

    win.on('query-session-end', approveQuit);
    win.on('session-end', approveQuit);
    win.on('unresponsive', () => {
      state.unresponsive = true;
      if (state.unanswered) force(win);
    });
    win.on('responsive', () => { state.unresponsive = false; });

    win.on('close', (event) => {
      if (approved || quitApproved) {
        if (state.unanswered && ++state.closesSeen > 1) {
          event.preventDefault();
          force(win);
        }
        return;
      }
      event.preventDefault();
      if (closing) return;
      closing = true;
      askFull(win, 'quit').then(({ proceed, unanswered }) => {
        closing = false;
        if (!proceed) return;
        approved = true;
        if (win.isDestroyed()) return;
        if (unanswered) markUnanswered(win);
        win.close();
        if (unanswered) forceIfUnresponsive(win);
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
    return askFull(win, 'quit').then(({ proceed, unanswered }) => {
      if (!proceed) return false;
      quitApproved = true;
      if (unanswered) markUnanswered(win);
      return true;
    });
  }

  function approveQuit() {
    quitApproved = true;
  }

  return { attach, beforeQuit, confirmQuit, approveQuit };
}

module.exports = { createUnsavedGuard, DEFAULT_TIMEOUT_MS };
