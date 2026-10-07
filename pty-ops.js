// pty-ops.js — see .ai/contexts/ipc-bridge.md ("PTY operations race the exit")
'use strict';

const os = require('os');

let logger = null;

// see .ai/contexts/ipc-bridge.md ("PTY operations race the exit")
const killedPtys = new WeakSet();

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

function isKilled(session) {
  return !!(session && session.pty && killedPtys.has(session.pty));
}

function resizePty(session, cols, rows, sessionId, options) {
  if (isKilled(session)) return false;
  return withPty(session, 'resize', (pty) => pty.resize(cols, rows, options), sessionId);
}

function killPty(session, sessionId) {
  if (!session || !session.pty || killedPtys.has(session.pty)) return false;
  killedPtys.add(session.pty);
  return withPty(session, 'kill', (pty) => pty.kill(), sessionId);
}

function writePty(session, data, sessionId) {
  if (isKilled(session)) return false;
  return withPty(session, 'write', (pty) => pty.write(data), sessionId);
}

// see .ai/contexts/bg-agents.md
function detachPty(session, sessionId, { graceMs = 2000, schedule = setTimeout } = {}) {
  if (session.detaching) return true;
  session.detaching = true;
  const wrote = writePty(session, '\x1a', sessionId);
  if (!wrote) return killPty(session, sessionId);
  const timer = schedule(() => {
    if (!session.exited) killPty(session, sessionId);
  }, graceMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return true;
}

/** The name of the signal node-pty reports on exit (`SIGKILL`), or null when none killed it. */
function ptyExitSignalName(signal, signals = os.constants.signals) {
  if (!signal) return null;
  return Object.keys(signals).find((name) => signals[name] === signal) || `signal ${signal}`;
}

module.exports = { setPtyOpLogger, withPty, resizePty, killPty, writePty, detachPty, ptyExitSignalName };
