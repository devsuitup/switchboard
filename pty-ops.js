// pty-ops.js — see .ai/contexts/ipc-bridge.md ("PTY operations race the exit")
'use strict';

const os = require('os');

let logger = null;

/** Install the sink used to report swallowed PTY errors. `null` disables it. */
function setPtyOpLogger(next) {
  logger = next && typeof next.debug === 'function' ? next : null;
}

/**
 * Run `fn` against `session.pty`, absorbing the throw of an already-exited PTY.
 *
 * @param {object|undefined|null} session   an entry of `activeSessions`
 * @param {string} label                    operation name, for the debug log
 * @param {function} fn                     (pty) => void
 * @param {string} [sessionId]              reported in the debug log
 * @returns {boolean} true when `fn` ran without throwing
 */
function withPty(session, label, fn, sessionId) {
  const pty = session && session.pty;
  if (!pty) return false;
  try {
    fn(pty);
    return true;
  } catch (err) {
    if (logger) {
      const reason = (err && err.message) || String(err);
      logger.debug(`[pty] ${label} skipped session=${sessionId || '?'} reason=${reason}`);
    }
    return false;
  }
}

function resizePty(session, cols, rows, sessionId) {
  return withPty(session, 'resize', (pty) => pty.resize(cols, rows), sessionId);
}

function killPty(session, sessionId) {
  return withPty(session, 'kill', (pty) => pty.kill(), sessionId);
}

function writePty(session, data, sessionId) {
  return withPty(session, 'write', (pty) => pty.write(data), sessionId);
}

/** The name of the signal node-pty reports on exit (`SIGKILL`), or null when none killed it. */
function ptyExitSignalName(signal, signals = os.constants.signals) {
  if (!signal) return null;
  return Object.keys(signals).find((name) => signals[name] === signal) || `signal ${signal}`;
}

module.exports = { setPtyOpLogger, withPty, resizePty, killPty, writePty, ptyExitSignalName };
