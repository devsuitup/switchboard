'use strict';

// see .ai/contexts/viewer-panel.md ("Unsaved edits on quit, reload and close")

const DEFAULT_TIMEOUT_MS = 2500;
const LOGOFF_CANCEL_MS = 60000;

function createUnsavedGuard({ ipcMain, timeoutMs = DEFAULT_TIMEOUT_MS, logoffCancelMs = LOGOFF_CANCEL_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, quit = () => {} }) {
  const pending = new Map();
  let nextId = 1;
  let quitApproved = false;
  let logoffApproved = false;
  let logoffTimer = null;
  let quitAsking = false;
  let inflight = null;
  const approvedToQuit = () => quitApproved || logoffApproved;
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

  const reasonWaits = new Map();
  ipcMain.on('unsaved-check-reason-done', (_event, id) => {
    const done = reasonWaits.get(id);
    if (done) done();
  });

  function waitReasonDone(id, wc) {
    let release = null;
    const done = new Promise((resolve) => {
      const timer = setTimeoutFn(() => release(), timeoutMs);
      const onGone = () => release();
      release = () => {
        reasonWaits.delete(id);
        clearTimeoutFn(timer);
        wc.removeListener('render-process-gone', onGone);
        wc.removeListener('destroyed', onGone);
        resolve();
      };
      reasonWaits.set(id, release);
      wc.on('render-process-gone', onGone);
      wc.on('destroyed', onGone);
    });
    return { done, release };
  }

  function askFull(win, reason) {
    if (inflight) {
      if (inflight.reason === 'reload') {
        const joined = inflight;
        joined.reason = reason;
        joined.held = true;
        const { id } = joined;
        const wait = waitReasonDone(id, win.webContents);
        try { win.webContents.send('unsaved-check-reason', id, reason); } catch { wait.release(); }
        joined.asked = joined.asked.then((result) => {
          if (!result.proceed || result.unanswered) {
            wait.release();
            return result;
          }
          return wait.done.then(() => result);
        }).then((result) => {
          if (inflight === joined) inflight = null;
          return result;
        });
      }
      return inflight.asked;
    }
    const wc = win.webContents;
    if (win.isDestroyed() || !wc || wc.isDestroyed() || wc.isCrashed()) return Promise.resolve({ proceed: true, unanswered: false });
    let settled = false;
    const id = nextId++;
    const asked = new Promise((resolve) => {
      const entry = { win, acked: false, timer: null, finish: null };
      const onGone = () => entry.finish(true);
      entry.finish = (proceed, unanswered = false) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeoutFn(entry.timer);
        wc.removeListener('render-process-gone', onGone);
        wc.removeListener('destroyed', onGone);
        settled = true;
        if (inflight && inflight.id === id && !inflight.held) inflight = null;
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
    if (!settled) inflight = { asked, id, reason };
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

  function markQuitUnanswered(win) {
    const state = windows.get(win);
    if (state) state.quitUnanswered = true;
  }

  function forceIfUnresponsive(win) {
    const state = windows.get(win);
    if (state && state.unresponsive) force(win);
  }

  function beforeQuit(event, win) {
    if (approvedToQuit() || !win || win.isDestroyed()) return false;
    event.preventDefault();
    if (quitAsking) return true;
    quitAsking = true;
    askFull(win, 'quit').then(({ proceed, unanswered }) => {
      quitAsking = false;
      if (!proceed) return;
      quitApproved = true;
      if (unanswered) markQuitUnanswered(win);
      quit();
    });
    return true;
  }

  function attach(win) {
    let approved = false;
    let closing = false;
    let reloading = false;
    let allowNextUnload = false;
    const state = { unanswered: false, quitUnanswered: false, unresponsive: false, closesSeen: 0 };
    windows.set(win, state);

    const endSession = (final) => {
      logoffApproved = true;
      if (logoffTimer) clearTimeoutFn(logoffTimer);
      logoffTimer = final ? null : setTimeoutFn(() => {
        logoffTimer = null;
        logoffApproved = false;
      }, logoffCancelMs);
      const wc = win.webContents;
      if (win.isDestroyed() || !wc || wc.isDestroyed()) return;
      try { wc.send('exit-flush'); } catch {}
    };
    win.on('query-session-end', () => endSession(false));
    win.on('session-end', () => endSession(true));
    win.on('unresponsive', () => {
      state.unresponsive = true;
      if (state.unanswered) force(win);
    });
    win.on('responsive', () => { state.unresponsive = false; });

    win.on('close', (event) => {
      if (approved || approvedToQuit()) {
        if (state.quitUnanswered && !state.unanswered) {
          state.unanswered = true;
          if (state.unresponsive) {
            event.preventDefault();
            force(win);
            return;
          }
        }
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
      if (approved || approvedToQuit() || allowNextUnload) {
        allowNextUnload = false;
        event.preventDefault();
        return;
      }
      if (reloading) return;
      reloading = true;
      const asked = ask(win, 'reload');
      const check = inflight;
      asked.then((proceed) => {
        reloading = false;
        if (check && check.reason !== 'reload') return;
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
      if (unanswered) markQuitUnanswered(win);
      return true;
    });
  }

  function approveQuit() {
    quitApproved = true;
  }

  return { attach, beforeQuit, confirmQuit, approveQuit };
}

module.exports = { createUnsavedGuard, DEFAULT_TIMEOUT_MS, LOGOFF_CANCEL_MS };
