// see .ai/contexts/session-cache.md ("Remote hosts — watch channel")
'use strict';

const { REMOTE_PROJECTS_REL, REMOTE_SESSIONS_REL } = require('./remote-transport');
const { isSafeRelPath } = require('./remote-hosts');
const { backoffDelayMs } = require('./remote-index');

const NOOP_LOG = { info() {}, warn() {}, error() {} };
const NO_INOTIFYWAIT_MARKER = 'SWITCHBOARD-NO-INOTIFYWAIT';
const NO_INOTIFYWAIT_EXIT_CODE = 44;
const SESSION_FILE_RE = /^[0-9]+\.json$/;
const PROJECTS_EVENTS = 'modify,close_write,create,moved_to';
const SESSIONS_EVENTS = 'close_write,create,delete,moved_to';
const COALESCE_MS = 15000;
const RESTART_BASE_MS = 5000;
const HEALTHY_MS = 30000;

function buildWatchCommand() {
  return `if ! command -v inotifywait >/dev/null 2>&1; then echo ${NO_INOTIFYWAIT_MARKER}; exit ${NO_INOTIFYWAIT_EXIT_CODE}; fi; ` +
    `mkdir -p '${REMOTE_PROJECTS_REL}' '${REMOTE_SESSIONS_REL}'; ` +
    `inotifywait -m -r -e ${PROJECTS_EVENTS} --format 'P|%w%f' '${REMOTE_PROJECTS_REL}' & p=$!; ` +
    `inotifywait -m -e ${SESSIONS_EVENTS} --format 'S|%w%f' '${REMOTE_SESSIONS_REL}' & s=$!; ` +
    `wait $p $s`;
}

function buildSshArgs(alias) {
  return ['-tt', '-o', 'BatchMode=yes', alias, buildWatchCommand()];
}

function parseWatchLine(line) {
  if (typeof line !== 'string' || line.length < 3 || line[1] !== '|') return null;
  const kind = line[0];
  const raw = line.slice(2);
  if (kind === 'P') {
    const prefix = REMOTE_PROJECTS_REL + '/';
    if (!raw.startsWith(prefix)) return null;
    const rel = raw.slice(prefix.length);
    return isSafeRelPath(rel) ? { kind: 'project', rel } : null;
  }
  if (kind === 'S') {
    const prefix = REMOTE_SESSIONS_REL + '/';
    if (!raw.startsWith(prefix)) return null;
    const rel = raw.slice(prefix.length);
    return SESSION_FILE_RE.test(rel) ? { kind: 'session', rel } : null;
  }
  return null;
}

function createRemoteWatcher(opts = {}) {
  const spawnFn = opts.spawn || require('child_process').spawn;
  const log = opts.log || NOOP_LOG;
  const setT = (opts.timers && opts.timers.setTimeout) || setTimeout;
  const clearT = (opts.timers && opts.timers.clearTimeout) || clearTimeout;

  const states = new Map();

  function killChild(s) {
    if (s.restartTimer) { clearT(s.restartTimer); s.restartTimer = null; }
    if (s.child) {
      const child = s.child;
      s.child = null;
      try { child.kill(); } catch {}
    }
  }

  function emitCoalesced(s, kind) {
    if (s.cooldown[kind]) { s.pending[kind] = true; return; }
    s.onEvent(s.alias, kind);
    s.cooldown[kind] = true;
    const t = setT(() => {
      s.cooldown[kind] = false;
      if (s.pending[kind]) { s.pending[kind] = false; emitCoalesced(s, kind); }
    }, COALESCE_MS);
    if (t && t.unref) t.unref();
  }

  function handleLine(s, rawLine) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) return;
    if (line.includes(NO_INOTIFYWAIT_MARKER)) {
      s.unwatchable = true;
      log.warn(`[remote-watch:${s.alias}] inotifywait is not installed on this host — ` +
        'watch channel disabled, periodic refresh still covers it');
      killChild(s);
      return;
    }
    const parsed = parseWatchLine(line);
    if (!parsed) return;
    if (parsed.kind === 'project' && s.onActivity) s.onActivity(s.alias, parsed.rel);
    emitCoalesced(s, parsed.kind);
  }

  function onData(s, chunk) {
    s.buf += chunk;
    let idx;
    while ((idx = s.buf.indexOf('\n')) !== -1) {
      const line = s.buf.slice(0, idx);
      s.buf = s.buf.slice(idx + 1);
      handleLine(s, line);
    }
  }

  function scheduleRestart(s) {
    const delay = backoffDelayMs(s.failures, RESTART_BASE_MS);
    s.restartTimer = setT(() => { s.restartTimer = null; spawnChild(s); }, delay);
    if (s.restartTimer && s.restartTimer.unref) s.restartTimer.unref();
  }

  function onExit(s) {
    s.child = null;
    if (s.stopped || s.unwatchable) return;
    s.failures = (Date.now() - s.spawnedAt) < HEALTHY_MS ? s.failures + 1 : 0;
    scheduleRestart(s);
  }

  function spawnChild(s) {
    if (s.stopped || s.unwatchable) return;
    let child;
    try {
      child = spawnFn('ssh', buildSshArgs(s.alias), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log.warn(`[remote-watch:${s.alias}] spawn failed: ${err.message}`);
      s.failures += 1;
      scheduleRestart(s);
      return;
    }
    s.child = child;
    s.buf = '';
    s.spawnedAt = Date.now();
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => onData(s, chunk));
    }
    if (child.stderr) child.stderr.on('data', () => {});
    child.on('error', () => {});
    child.on('close', () => onExit(s));
  }

  function getState(alias) {
    let s = states.get(alias);
    if (!s) {
      s = {
        alias, child: null, buf: '', stopped: true, unwatchable: false,
        failures: 0, spawnedAt: 0, restartTimer: null, onEvent: null, onActivity: null,
        cooldown: { project: false, session: false },
        pending: { project: false, session: false },
      };
      states.set(alias, s);
    }
    return s;
  }

  function start(alias, onEvent, onActivity) {
    if (typeof alias !== 'string' || !alias || typeof onEvent !== 'function') return;
    const s = getState(alias);
    if (!s.stopped && !s.unwatchable) return;
    s.stopped = false;
    s.unwatchable = false;
    s.failures = 0;
    s.onEvent = onEvent;
    s.onActivity = typeof onActivity === 'function' ? onActivity : null;
    spawnChild(s);
  }

  function stop(alias) {
    const s = states.get(alias);
    if (!s) return;
    s.stopped = true;
    killChild(s);
  }

  function stopAll() {
    for (const alias of [...states.keys()]) stop(alias);
  }

  function isRunning(alias) {
    const s = states.get(alias);
    return !!(s && !s.stopped && !s.unwatchable);
  }

  return { start, stop, stopAll, isRunning };
}

module.exports = {
  createRemoteWatcher,
  parseWatchLine,
  buildWatchCommand,
  buildSshArgs,
  NO_INOTIFYWAIT_MARKER,
  NO_INOTIFYWAIT_EXIT_CODE,
};
