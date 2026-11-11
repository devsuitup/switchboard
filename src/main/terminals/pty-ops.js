// pty-ops.js — see .ai/contexts/ipc-bridge.md ("PTY operations race the exit")
'use strict';

const os = require('os');
const { closeWindowsPty } = require('./close-windows-pty');
const { windowsJobHelper } = require('./windows-job-helper');

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
    if (record.assigned && !record.closing && !record.released && typeof jobs.observe === 'function') {
      pty.statusTreeExit = Promise.resolve().then(() => jobs.observe(record.id))
        .catch(() => null).then(proof => { void releaseWindowsPty(pty); return proof; });
    } else if (!record.closing) void releaseWindowsPty(pty);
  });
  const current = () => !record.exited && !record.released && pty._agent?.exitCode === undefined;
  const assign = at => record.assignment = jobs.assign(record.id, pty.pid, at, current)
    .then(assigned => { record.assigned = assigned; return assigned; });
  if (pty.pid > 0) return assign(spawnTime);
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
      resolve(assign(Date.now()));
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
  const kill = () => {
    const issued = withPty({ pty }, 'kill', target => target.kill(), sessionId);
    if (!issued) killedPtys.delete(pty);
    return issued;
  };
  if (platform === 'win32' && session.kind === 'local-pty' && !session.exited && pty._agent?.exitCode === undefined
    && !session.isAttach && !session.detaching && !session.backgrounding && !session.backgrounded && !session.host) {
    const record = jobsByPty.get(pty);
    if (record && !record.released) {
      record.closing = true;
      closeWindowsPty(pty, kill,
        () => record.jobs.terminate(record.id), closeOptions);
      return killedPtys.has(pty);
    }
  }
  void releaseWindowsPty(pty);
  return kill();
}

function writePty(session, data, sessionId) {
  if (isKilled(session)) return false;
  return withPty(session, 'write', (pty) => pty.write(data), sessionId);
}

function stopPtyWithEvidence(session, sessionId, { platform = process.platform, generation = session?.generation,
  deadline = Date.now() + 5000 } = {}) {
  const pty = session?.pty, record = pty && jobsByPty.get(pty);
  const unknown = code => Promise.resolve({ ended: false, code, generation });
  if (!pty || generation == null || session.generation !== generation || !Number.isFinite(deadline) || deadline <= Date.now()) return unknown('IDENTITY');
  if (session.kind !== 'local-pty' || session.isAttach || session.detaching || session.backgrounding || session.backgrounded || session.host) return unknown('UNSUPPORTED');
  if (platform !== 'win32' || !record || record.released || typeof record.jobs.terminateWithEvidence !== 'function') return unknown('UNSUPPORTED');
  if (record.stopEvidence) return record.stopGeneration === generation ? record.stopEvidence : unknown('IDENTITY');
  if (record.closing || killedPtys.has(pty)) return unknown('UNKNOWN');
  const pid = pty.pid;
  const current = () => session.pty === pty && session.generation === generation && pty.pid === pid;
  record.closing = true;
  record.stopGeneration = generation;
  record.stopEvidence = (async () => {
    let timer, helperOwnsRelease = false;
    try {
      const assigned = await Promise.race([record.assignment, new Promise(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(0, Math.min(15000, deadline - Date.now())));
      })]);
      clearTimeout(timer);
      if (!assigned || !current() || deadline <= Date.now()) return { ended: false, code: 'IDENTITY', generation, pid };
      killedPtys.add(pty);
      const proof = await closeWindowsPty(pty,
        () => withPty({ pty }, 'kill', target => target.kill(), sessionId),
        () => { helperOwnsRelease = true; return record.jobs.terminateWithEvidence(record.id, { deadline }); }, { evidence: true, deadline });
      return { ...proof, ended: proof.ended === true && current(), generation, pid };
    } finally {
      clearTimeout(timer);
      record.closing = false;
      if (helperOwnsRelease) record.released = true;
      const releasing = releaseWindowsPty(pty).catch(() => false);
      if (Date.now() < deadline) {
        try {
          await Promise.race([releasing, new Promise(resolve => { timer = setTimeout(resolve, deadline - Date.now()); })]);
        } finally { clearTimeout(timer); }
      }
    }
  })();
  pty.stopEvidence = record.stopEvidence;
  return record.stopEvidence;
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

module.exports = { setPtyOpLogger, guardPtyInputErrors, trackWindowsPty, releaseWindowsPty, withPty, isKilled, resizePty, killPty, stopPtyWithEvidence, writePty, detachPty, ptyExitSignalName };
