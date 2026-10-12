'use strict';

// see .ai/contexts/viewer-panel.md ("Unsaved edits on quit, reload and close")

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_PROBE_MS = 1500;
const DEFAULT_DIALOG_CEILING_MS = 5 * 60 * 1000;
const REASON_RANK = { reload: 0, close: 1, quit: 2 };
const LOGOFF_CANCEL_MS = 60000;

function createUnsavedGuard({ ipcMain, timeoutMs = DEFAULT_TIMEOUT_MS, probeMs = DEFAULT_PROBE_MS, dialogCeilingMs = DEFAULT_DIALOG_CEILING_MS, logoffCancelMs = LOGOFF_CANCEL_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, quit = () => {} }) {
  const pending = new Map();
  const probes = new Map();
  const dialogs = new WeakSet();
  const windows = new WeakMap();
  let nextId = 1;
  let quitApproved = false;
  let logoffApproved = false;
  let logoffTimer = null;
  let quitAsking = false;
  let inflight = null;
  let current = null;
  const approvedToQuit = () => quitApproved || logoffApproved;

  ipcMain.on('unsaved-pong', (event, token) => {
    const probed = probes.get(token);
    if (probed && event && event.sender === probed.wc) probed.answered();
  });

  // see .ai/contexts/window-frame.md ("A native dialog pauses the bounds")
  ipcMain.on('unsaved-dialog', (event, open) => {
    const wc = event && event.sender;
    if (!wc) return;
    if (open === true) dialogs.add(wc);
    else dialogs.delete(wc);
    if (current && current.wc === wc) current.arm();
  });

  ipcMain.on('unsaved-ready', (event) => {
    const entry = current;
    if (!entry || entry.acked || !event || event.sender !== entry.wc) return;
    try { entry.wc.send('unsaved-check', entry.id, entry.reason); } catch {}
  });

  ipcMain.on('unsaved-check-ack', (_event, id) => {
    const entry = pending.get(id);
    if (!entry || entry.acked) return;
    entry.acked = true;
    responsive(entry.win);
    entry.arm();
  });

  ipcMain.on('unsaved-check-result', (_event, id, proceed) => {
    const entry = pending.get(id);
    if (!entry) return;
    entry.finish(proceed === true);
  });

  const reasonWaits = new Map();
  ipcMain.on('unsaved-check-reason-done', (_event, _id, token) => {
    const release = reasonWaits.get(token);
    if (release) release();
  });

  function waitReasonDone(token, wc) {
    let release = null;
    const done = new Promise((resolve) => {
      const timer = setTimeoutFn(() => release(), timeoutMs);
      const onGone = () => release();
      release = () => {
        reasonWaits.delete(token);
        clearTimeoutFn(timer);
        wc.removeListener('render-process-gone', onGone);
        wc.removeListener('destroyed', onGone);
        resolve();
      };
      reasonWaits.set(token, release);
      wc.on('render-process-gone', onGone);
      wc.on('destroyed', onGone);
    });
    return { done, release };
  }

  function responsive(win) {
    const state = windows.get(win);
    if (state) state.unresponsive = false;
  }

  // see .ai/contexts/window-frame.md ("A window that stops answering")
  function askFull(win, reason) {
    if (inflight) {
      if (REASON_RANK[reason] > REASON_RANK[inflight.entry.reason]) {
        const joined = inflight;
        joined.held = true;
        const token = nextId++;
        const sent = joined.entry.upgrade(reason, token);
        const wait = waitReasonDone(token, win.webContents);
        if (!sent) wait.release();
        joined.asked = joined.asked.then((result) => {
          if (!result.proceed || result.ended) {
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
    if (win.isDestroyed() || !wc || wc.isDestroyed() || wc.isCrashed()) return Promise.resolve({ proceed: true, ended: null });
    let settled = false;
    const id = nextId++;
    const entry = { id, win, wc, reason, acked: false, overdue: false, probe: null, timer: null, finish: null, arm: null, upgrade: null };
    const asked = new Promise((resolve) => {
      const onGone = () => entry.finish(true);
      const stop = () => {
        if (entry.timer) clearTimeoutFn(entry.timer);
        entry.timer = null;
      };
      entry.arm = () => {
        stop();
        entry.overdue = false;
        if (entry.acked) return;
        if (entry.reason !== 'close') entry.timer = setTimeoutFn(() => entry.finish(true, 'unanswered'), dialogs.has(wc) ? dialogCeilingMs : timeoutMs);
        else if (!dialogs.has(wc)) entry.timer = setTimeoutFn(() => { entry.overdue = true; }, timeoutMs);
      };
      entry.upgrade = (to, token) => {
        entry.reason = to;
        let sent = true;
        try { wc.send('unsaved-check-reason', id, to, token); } catch { sent = false; }
        entry.arm();
        return sent;
      };
      entry.finish = (proceed, ended = null) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        stop();
        if (entry.probe) {
          clearTimeoutFn(entry.probe.timer);
          probes.delete(entry.probe.token);
        }
        wc.removeListener('render-process-gone', onGone);
        wc.removeListener('destroyed', onGone);
        settled = true;
        if (inflight && inflight.entry === entry && !inflight.held) inflight = null;
        if (current === entry) current = null;
        resolve({ proceed, ended });
      };
      pending.set(id, entry);
      current = entry;
      entry.arm();
      wc.on('render-process-gone', onGone);
      wc.on('destroyed', onGone);
      try {
        wc.send('unsaved-check', id, reason);
      } catch {
        entry.finish(true);
      }
    });
    if (!settled) inflight = { asked, entry };
    return asked;
  }

  function ask(win, reason) {
    return askFull(win, reason).then(({ proceed }) => proceed);
  }

  function probeOrForce(entry) {
    if (dialogs.has(entry.wc)) return;
    if (!entry.acked) {
      if (entry.overdue) entry.finish(true, 'hung');
      return;
    }
    if (entry.probe) {
      if (entry.probe.overdue) entry.finish(true, 'hung');
      return;
    }
    const token = nextId++;
    const probe = { token, overdue: false, timer: null };
    probe.timer = setTimeoutFn(() => { probe.overdue = true; }, probeMs);
    entry.probe = probe;
    probes.set(token, {
      wc: entry.wc,
      answered: () => {
        probes.delete(token);
        clearTimeoutFn(probe.timer);
        if (entry.probe === probe) entry.probe = null;
        responsive(entry.win);
      },
    });
    try {
      entry.wc.send('unsaved-ping', token);
    } catch {
      entry.finish(true, 'hung');
    }
  }

  function unresponsiveDuringCheck(win) {
    const entry = current;
    if (!entry || entry.win !== win || dialogs.has(entry.wc)) return;
    if (!entry.acked || entry.probe) entry.finish(true, 'hung');
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
    askFull(win, 'quit').then(({ proceed, ended }) => {
      quitAsking = false;
      if (!proceed) return;
      quitApproved = true;
      if (ended) markQuitUnanswered(win);
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
      else unresponsiveDuringCheck(win);
    });
    win.on('responsive', () => { state.unresponsive = false; });
    win.webContents.on('render-process-gone', () => dialogs.delete(win.webContents));
    win.webContents.on('did-navigate', () => dialogs.delete(win.webContents));

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
      if (closing) {
        if (current && current.win === win) probeOrForce(current);
        return;
      }
      closing = true;
      askFull(win, 'close').then(({ proceed, ended }) => {
        closing = false;
        if (!proceed) return;
        approved = true;
        if (ended === 'hung') force(win);
        if (win.isDestroyed()) return;
        if (ended === 'unanswered') markUnanswered(win);
        win.close();
        if (ended === 'unanswered') forceIfUnresponsive(win);
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
        if (check && check.entry.reason !== 'reload') return;
        if (!proceed || win.isDestroyed() || win.webContents.isDestroyed()) return;
        allowNextUnload = true;
        win.webContents.reload();
      });
    });
  }

  function confirmQuit(win) {
    return askFull(win, 'quit').then(({ proceed, ended }) => {
      if (!proceed) return false;
      quitApproved = true;
      if (ended) markQuitUnanswered(win);
      return true;
    });
  }

  function approveQuit() {
    quitApproved = true;
  }

  return { attach, beforeQuit, confirmQuit, approveQuit };
}

module.exports = { createUnsavedGuard, DEFAULT_TIMEOUT_MS, DEFAULT_PROBE_MS, DEFAULT_DIALOG_CEILING_MS, LOGOFF_CANCEL_MS };
