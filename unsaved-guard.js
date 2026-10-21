'use strict';

// see .ai/contexts/viewer-panel.md ("Unsaved edits on quit, reload and close")

const { createExitAttempts } = require('./session-exit');

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_PROBE_MS = 1500;
const DEFAULT_DIALOG_CEILING_MS = 5 * 60 * 1000;
const REASON_RANK = { reload: 0, close: 1, quit: 2 };
const LOGOFF_CANCEL_MS = 60000;

function createUnsavedGuard({ ipcMain, timeoutMs = DEFAULT_TIMEOUT_MS, probeMs = DEFAULT_PROBE_MS, dialogCeilingMs = DEFAULT_DIALOG_CEILING_MS, logoffCancelMs = LOGOFF_CANCEL_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, quit = () => {}, inventory = () => ({ rows: [], counts: {}, remote: {} }), background = async () => [], externalFlush = () => {}, onAttemptReleased = () => {} }) {
  const pending = new Map();
  const probes = new Map();
  const dialogs = new WeakSet();
  const windows = new WeakMap();
  let nextId = 1;
  let logoffApproved = false;
  let logoffTimer = null;
  let quitAsking = false;
  let userQuitPromise = null;
  let actedQuitToken = null;
  let inflight = null;
  let current = null;
  let backgroundBatch = null;
  const backgroundBatches = new Set();
  const abortBackground = external => {
    for (const batch of external ? backgroundBatches : backgroundBatch ? [backgroundBatch] : []) {
      const { controller } = batch;
      if (external && controller.signal.aborted && !controller.signal.reason.external) {
        controller.signal.reason.external = true;
        controller.signal.dispatchEvent(new Event('abort'));
      } else controller.abort({ external });
    }
  };
  const attempts = createExitAttempts({ snapshot: inventory, check: askFull,
    cancelCheck: win => {
      if (current?.win === win) current.finish(false);
      for (const release of reasonWaits.values()) if (release.wc === win?.webContents) release(false);
    },
    invalidateRenderer: (win, attempt, wasCommitted = false) => {
      abortBackground(false);
      backgroundBatch = null;
      if (!wasCommitted) onAttemptReleased();
      windows.get(win)?.invalidate();
      try { win?.webContents.send('exit-attempt-invalidated', attempt); } catch {}
    },
  });
  let externalDrain = null;
  const closeApproved = win => attempts.token(win) != null;

  ipcMain.handle?.('exit-attempt-snapshot', (event, id, detail) => {
    const entry = pending.get(id);
    if (!entry || event?.sender !== entry.wc) return null;
    return attempts.refresh(entry.win, detail);
  });
  const backgroundAttempt = (event, checkId, detail) => {
    const entry = pending.get(checkId);
    const attempt = attempts.current();
    if (!entry || event?.sender !== entry.wc || attempt?.window !== entry.win || attempt.id !== detail?.attempt || attempt.version !== detail?.version || attempt.phase === 'committed' || attempt.external) return null;
    return attempt;
  };
  ipcMain.handle?.('exit-background', (event, checkId, detail, ids) => {
    const attempt = backgroundAttempt(event, checkId, detail);
    if (!attempt || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !attempt.snapshot.rows.some(row => row.id === id && row.type === 'session' && ['ready', 'busy'].includes(row.background)))) return null;
    if (backgroundBatch) return backgroundBatch.promise;
    const controller = new AbortController();
    const batch = { controller, promise: null };
    backgroundBatch = batch;
    backgroundBatches.add(batch);
    attempts.phase(detail, 'backgrounding');
    batch.promise = Promise.resolve(background(ids, {
      signal: controller.signal,
      progress: progress => {
        if (backgroundBatch !== batch || controller.signal.aborted && controller.signal.reason?.external) return;
        try { event.sender.send('exit-background-progress', attempt.id, progress); } catch {}
      },
    })).finally(() => backgroundBatches.delete(batch));
    return batch.promise;
  });
  ipcMain.on('exit-background-cancel', (event, checkId, detail) => {
    if (backgroundAttempt(event, checkId, detail)) abortBackground(false);
  });
  ipcMain.on('unsaved-check-phase', (event, id, detail, phase) => {
    const entry = pending.get(id);
    if (entry && event?.sender === entry.wc) attempts.phase(detail, phase);
  });

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
    try { entry.wc.send('unsaved-check', entry.id, entry.reason, entry.detail); } catch {}
  });

  ipcMain.on('unsaved-check-ack', (event, id) => {
    const entry = pending.get(id);
    if (!entry || entry.acked || event?.sender !== entry.wc) return;
    entry.acked = true;
    responsive(entry.win);
    entry.arm();
  });

  ipcMain.on('unsaved-check-result', (event, id, proceed, detail) => {
    const entry = pending.get(id);
    if (!entry || event?.sender !== entry.wc) return;
    if (entry.detail && (detail?.attempt !== entry.detail.attempt || detail?.version !== entry.detail.version)) {
      entry.acked = false;
      entry.arm();
      try { entry.wc.send('unsaved-check', entry.id, entry.reason, entry.detail); } catch { entry.finish(true, 'unanswered'); }
      return;
    }
    entry.finish(proceed === true);
  });

  const reasonWaits = new Map();
  ipcMain.on('unsaved-check-reason-done', (event, _id, token, proceed = true) => {
    const release = reasonWaits.get(token);
    if (release && release.wc === event?.sender) release(proceed);
  });

  function waitReasonDone(token, wc) {
    let release = null;
    const done = new Promise((resolve) => {
      const timer = setTimeoutFn(() => release(), timeoutMs);
      const onGone = () => release();
      release = (proceed = true) => {
        reasonWaits.delete(token);
        clearTimeoutFn(timer);
        wc.removeListener('render-process-gone', onGone);
        wc.removeListener('destroyed', onGone);
        resolve(proceed !== false);
      };
      release.wc = wc;
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
  function askFull(win, reason, detail = null) {
    if (inflight) {
      if (REASON_RANK[reason] > REASON_RANK[inflight.entry.reason] || (detail && detail.version !== inflight.entry.detail?.version)) {
        const joined = inflight;
        joined.held = true;
        joined.upgrades = (joined.upgrades || 0) + 1;
        const token = nextId++;
        const sent = joined.entry.upgrade(reason, token, detail);
        const wait = waitReasonDone(token, win.webContents);
        if (!sent) wait.release();
        joined.asked = joined.asked.then((result) => {
          if (!result.proceed || result.ended) {
            wait.release();
            return result;
          }
          return wait.done.then(proceed => ({ ...result, proceed: result.proceed && proceed }));
        }).then((result) => {
          joined.upgrades -= 1;
          if (joined.upgrades === 0 && inflight === joined) inflight = null;
          return result;
        });
      }
      return inflight.asked;
    }
    if (!win) return Promise.resolve({ proceed: true, ended: null });
    const wc = win.webContents;
    if (win.isDestroyed() || !wc || wc.isDestroyed() || wc.isCrashed()) return Promise.resolve({ proceed: true, ended: null });
    let settled = false;
    const id = nextId++;
    const entry = { id, win, wc, reason, detail, acked: false, overdue: false, probe: null, timer: null, finish: null, arm: null, upgrade: null };
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
      entry.upgrade = (to, token, nextDetail) => {
        entry.reason = to;
        entry.detail = nextDetail;
        let sent = true;
        try { wc.send('unsaved-check-reason', id, to, token, nextDetail); } catch { sent = false; }
        entry.arm();
        return sent;
      };
      entry.finish = (proceed, ended = null) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        if (proceed) abortBackground(true);
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
        wc.send('unsaved-check', id, reason, detail);
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

  function beforeQuit(event, win, token = null) {
    if (attempts.committed(token) || (token == null && logoffApproved) || !win || win.isDestroyed()) return false;
    if (attempts.token(win) != null) attempts.invalidate();
    abortBackground(true);
    event.preventDefault();
    if (quitAsking) return true;
    quitAsking = true;
    attempts.request(win, 'quit', true).then(({ proceed, ended, token: committed }) => {
      quitAsking = false;
      if (!proceed) return;
      if (ended) markQuitUnanswered(win);
      finishQuit(committed);
    });
    return true;
  }

  function requestQuit(win) {
    if (attempts.token(win) != null) return Promise.resolve();
    if (userQuitPromise) return userQuitPromise;
    userQuitPromise = attempts.request(win, 'quit').then(({ proceed, ended, token, action }) => {
      if (!proceed || action !== 'quit') return;
      if (ended) markQuitUnanswered(win);
      finishQuit(token);
    }).finally(() => { userQuitPromise = null; });
    return userQuitPromise;
  }

  function finishQuit(token) {
    if (actedQuitToken === token) return;
    actedQuitToken = token;
    quit(token);
  }

  function attach(win) {
    let closing = false;
    let reloading = false;
    let allowNextUnload = false;
    const state = { unanswered: false, quitUnanswered: false, unresponsive: false, closesSeen: 0 };
    state.invalidate = () => { allowNextUnload = false; state.unanswered = false; state.quitUnanswered = false; state.closesSeen = 0; };
    windows.set(win, state);

    const endSession = (final) => {
      abortBackground(true);
      attempts.invalidate();
      for (const release of reasonWaits.values()) release();
      if (!externalDrain) externalDrain = Promise.resolve().then(externalFlush);
      logoffApproved = true;
      if (logoffTimer) clearTimeoutFn(logoffTimer);
      logoffTimer = final ? null : setTimeoutFn(() => {
        logoffTimer = null;
        logoffApproved = false;
        externalDrain = null;
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
      if (closeApproved(win)) {
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
      attempts.request(win, 'close').then(({ proceed, ended, action }) => {
        closing = false;
        if (!proceed || action !== 'close') return;
        if (ended === 'hung') force(win);
        if (win.isDestroyed()) return;
        if (ended === 'unanswered') markUnanswered(win);
        win.close();
        if (ended === 'unanswered') forceIfUnresponsive(win);
      });
    });

    win.webContents.on('will-prevent-unload', (event) => {
      if (closeApproved(win) || allowNextUnload) {
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
    return attempts.request(win, 'update').then(({ proceed, ended, action }) => {
      if (proceed && ended) markQuitUnanswered(win);
      return proceed && action === 'update';
    });
  }

  function approveQuit(win = null) {
    return attempts.request(win, 'update');
  }

  return { attach, beforeQuit, requestQuit, confirmQuit, approveQuit,
    committedToken: attempts.token, launchAllowed: attempts.launchAllowed, invalidate: attempts.invalidate };
}

module.exports = { createUnsavedGuard, DEFAULT_TIMEOUT_MS, DEFAULT_PROBE_MS, DEFAULT_DIALOG_CEILING_MS, LOGOFF_CANCEL_MS };
