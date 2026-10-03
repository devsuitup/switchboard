'use strict';

const { resizePty } = require('./pty-ops');
const { MAX_COLS, MAX_ROWS } = require('./pty-size');

const PTY_REFRESH_DELAY_MS = 50;
const PTY_REFRESH_RESTORE_ATTEMPTS = 2;

function createTerminalResizeHandler(activeSessions, timers = { setTimeout, clearTimeout }) {
  const pending = new WeakMap();
  return (sessionId, cols, rows, refresh = false) => {
    const session = activeSessions.get(sessionId);
    if (!session || session.exited || !Number.isInteger(cols) || cols < 1 || cols > MAX_COLS || !Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) return;
    refresh = refresh === true;
    const previous = pending.get(session);
    if (previous) {
      timers.clearTimeout(previous.timer);
      pending.delete(session);
    }
    const forced = refresh === true || !!previous?.forced;
    const options = forced ? { refresh: true } : undefined;
    const retryFit = refresh === true || !!previous;
    if (!resizePty(session, cols, rows, sessionId, options) && !(retryFit && resizePty(session, cols, rows, sessionId, options))) return;
    const firstNudge = session.firstResize && !session.isPlainTerminal;
    session.firstResize = false;
    if (!refresh && !firstNudge) return;
    const current = () => activeSessions.get(sessionId) === session && !session.exited;
    const restore = () => {
      pending.delete(session);
      if (!current()) return;
      for (let i = 0; i < PTY_REFRESH_RESTORE_ATTEMPTS; i++) {
        if (resizePty(session, cols, rows, sessionId, options)) break;
      }
    };
    const nudge = () => {
      if (!current()) { pending.delete(session); return; }
      resizePty(session, (refresh || cols === MAX_COLS) && cols > 1 ? cols - 1 : cols + 1, rows, sessionId, options);
      pending.set(session, { forced, timer: timers.setTimeout(restore, PTY_REFRESH_DELAY_MS) });
    };
    if (refresh) nudge();
    else pending.set(session, { forced, timer: timers.setTimeout(nudge, PTY_REFRESH_DELAY_MS) });
  };
}

module.exports = { createTerminalResizeHandler };
