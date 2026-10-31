// pty-ops.js — see .ai/contexts/ipc-bridge.md ("PTY operations race the exit")
'use strict';

const os = require('os');
const { closeWindowsPty } = require('./src/main/terminals/close-windows-pty');
const { windowsJobHelper } = require('./src/main/terminals/windows-job-helper');

let logger = null;
const jobsByPty = new WeakMap();
let nextJobId = 0;

function trackWindowsPty(pty, { platform = process.platform, spawnTime = Date.now(), jobs } = {}) {
  if (platform !== 'win32' || !pty || jobsByPty.has(pty)) return Promise.resolve(false);
  jobs ??= windowsJobHelper();
  const record = { jobs, id: `pty-${++nextJobId}`, closing: false, exited: false, released: false };
  jobsByPty.set(pty, record);
  pty.onExit(() => {
    record.exited = true;
    if (!record.closing) void releaseWindowsPty(pty);
  });
  const current = () => !record.exited && !record.released && pty._agent?.exitCode === undefined;
  if (pty.pid > 0) return jobs.assign(record.id, pty.pid, spawnTime, current);
  return new Promise(resolve => {
    const socket = pty._agent?.outSocket;
    const finish = () => {
      clearTimeout(timer);
      socket?.removeListener('ready_datapipe', connected);
      resolve(false);
    };
    const connected = () => {
      clearTimeout(timer);
      if (!current() || record.closing) return finish();
      resolve(jobs.assign(record.id, pty.pid, Date.now(), current));
    };
    const timer = setTimeout(finish, 5500);
    timer.unref?.();
    socket?.once('ready_datapipe', connected);
  });
}

function releaseWindowsPty(pty) {
  const record = jobsByPty.get(pty);
  if (!record || record.released || record.closing) return Promise.resolve(true);
  record.released = true;
  return record.jobs.release(record.id);
}

// see .ai/contexts/ipc-bridge.md ("PTY operations race the exit")
const killedPtys = new WeakSet();

/** Install the sink used to report swallowed PTY errors. `null` disables it. */
function setPtyOpLogger(next) {
  logger = next && typeof next.debug === 'function' ? next : null;
}

function guardPtyInputErrors(pty) {
  try {
    const inputSocket = pty?._agent?.inSocket;
    if (inputSocket && typeof inputSocket.on === 'function') {
      inputSocket.on('error', (err) => {
        try {
          if (logger) {
            const reason = (err && err.message) || String(err);
            const line = `[pty] input error pid=${pty.pid || '?'} reason=${reason}`;
            if (typeof logger.warn === 'function') logger.warn(line);
            else logger.debug(line);
          }
        } catch {}
      });
    }
  } catch {}
  return pty;
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

function killPty(session, sessionId, { platform = process.platform, ...closeOptions } = {}) {
  if (!session || !session.pty || killedPtys.has(session.pty)) return false;
  const pty = session.pty;
  killedPtys.add(pty);
  if (platform === 'win32' && session.kind === 'local-pty' && !session.exited && pty._agent?.exitCode === undefined
    && !session.isAttach && !session.detaching && !session.backgrounding && !session.backgrounded && !session.host) {
    const record = jobsByPty.get(pty);
    if (record && !record.released) {
      record.closing = true;
      closeWindowsPty(pty, () => withPty({ pty }, 'kill', target => target.kill(), sessionId),
        () => record.jobs.terminate(record.id), closeOptions);
      return true;
    }
  }
  void releaseWindowsPty(pty);
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
  void releaseWindowsPty(session.pty);
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

module.exports = { setPtyOpLogger, guardPtyInputErrors, trackWindowsPty, releaseWindowsPty, withPty, resizePty, killPty, writePty, detachPty, ptyExitSignalName };
