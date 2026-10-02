// see .ai/contexts/cli-session-state.md
'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = path.join(os.homedir(), '.claude', 'sessions');
const STATE_FILE_RE = /^\d+\.json$/;
const KNOWN_STATUSES = new Set(['busy', 'idle', 'waiting', 'shell']);
const RESCAN_STATUS = 'idle';
const FLUSH_MS = 150;
const MIN_RESCAN_INTERVAL_MS = 1000;
const MAX_SEEDED_FILES = 200;
const MAX_LIVE_QUERY_IDS = 200;
const GET_STATUS_PROBE_THROTTLE_MS = 5000;
const MAX_PROBE_PIDS = 64;
const PROBE_TIMEOUT_MS = 5000;
const WINDOWS_FILETIME_RE = /^\d{17,19}$/;

let dir = DEFAULT_DIR;
let activeSessions = null;
let onIdle = null;
let log = null;
let isProcessAlive = defaultIsProcessAlive;
let readProcStartMany = defaultReadProcStartMany;
let readParentPid = defaultReadParentPid;
let ownPid = process.pid;
let now = Date.now;
let platform = process.platform;

let watcher = null;
let flushTimer = null;
const pending = new Set();
const known = new Map();
const lastRescanAt = new Map();
// sessionId -> { status, statusUpdatedAt, pid } for live pids only -- see .ai/contexts/cli-session-state.md
const statusBySession = new Map();
const lastProbeAt = new Map();
const MAX_DESCRIPTOR_SCAN = 1000;
// Listeners told "the directory changed" after each flushed batch -- see .ai/contexts/bg-agents.md
const descriptorListeners = new Set();

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function defaultReadParentPid(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

// see .ai/contexts/cli-session-state.md ("Live elsewhere")
function descendsFromThisProcess(pid) {
  let current = pid;
  for (let depth = 0; depth < 64 && current && current > 1; depth++) {
    if (current === ownPid) return true;
    current = readParentPid(current);
  }
  return false;
}

function defaultReadProcStart(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] || null;
  } catch {
    return null;
  }
}

// see .ai/contexts/cli-session-state.md
function probeProcStartWindows(pids, timeoutMs = PROBE_TIMEOUT_MS, exec = execFile) {
  const ids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (ids.length === 0) return Promise.resolve(new Map());
  const script = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" } catch {} }; exit 0`;
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    exec(exe, ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err && (err.killed || typeof err.code !== 'number')) { reject(err); return; }
        const out = new Map();
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^(\d+) (\d+)$/.exec(line.trim());
          if (m) out.set(Number(m[1]), m[2]);
        }
        resolve(out);
      });
  });
}

async function defaultReadProcStartMany(pids) {
  if (process.platform === 'win32') return probeProcStartWindows(pids);
  const out = new Map();
  if (process.platform !== 'linux') return out;
  for (const pid of pids) {
    const start = defaultReadProcStart(pid);
    if (start != null) out.set(pid, start);
  }
  return out;
}

function init(ctx) {
  dir = ctx.dir || DEFAULT_DIR;
  activeSessions = ctx.activeSessions;
  onIdle = ctx.onIdle;
  log = ctx.log || { info() {}, debug() {}, warn() {}, error() {} };
  isProcessAlive = ctx.isProcessAlive || defaultIsProcessAlive;
  readProcStartMany = ctx.readProcStartMany
    || (ctx.readProcStart
      ? async (pids) => new Map(pids.map((pid) => [pid, ctx.readProcStart(pid)]))
      : defaultReadProcStartMany);
  readParentPid = ctx.readParentPid || defaultReadParentPid;
  ownPid = ctx.ownPid || process.pid;
  now = ctx.now || Date.now;
  platform = ctx.platform || process.platform;
  stop();
}

function parseState(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  if (typeof raw.status !== 'string' || !KNOWN_STATUSES.has(raw.status)) return null;
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    status: raw.status,
    statusUpdatedAt: Number.isInteger(raw.statusUpdatedAt) ? raw.statusUpdatedAt : null,
    procStart: raw.procStart == null ? null : String(raw.procStart),
  };
}

// The descriptor subset the agents view reads -- see .ai/contexts/bg-agents.md
function parseDescriptor(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  const s = (v) => (typeof v === 'string' && v ? v : null);
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    kind: s(raw.kind),
    jobId: s(raw.jobId),
    agent: s(raw.agent),
    name: s(raw.name),
    cwd: s(raw.cwd),
    status: KNOWN_STATUSES.has(raw.status) ? raw.status : null,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
  };
}

function readAllDescriptors() {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  let seen = 0;
  for (const name of names) {
    if (!STATE_FILE_RE.test(name)) continue;
    if (++seen > MAX_DESCRIPTOR_SCAN) break;
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const d = parseDescriptor(text);
    if (d && isProcessAlive(d.pid)) out.push(d);
  }
  return out;
}

function onDescriptorsChanged(listener) {
  descriptorListeners.add(listener);
  return () => { descriptorListeners.delete(listener); };
}

function notifyDescriptorsChanged() {
  for (const listener of descriptorListeners) {
    try { listener(); } catch (err) { log.warn(`[cli-state] descriptor listener failed: ${err.message}`); }
  }
}

function findSession(sessionId) {
  if (!activeSessions) return null;
  for (const [key, session] of activeSessions) {
    if (!session || session.exited || session.isPlainTerminal || !session.projectFolder) continue;
    const effectiveId = session.realSessionId || key;
    if (effectiveId === sessionId) return { sessionId: effectiveId, session };
  }
  return null;
}

function handleFile(name) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    const stale = known.get(name);
    if (stale && stale.sessionId) forgetSession(stale.sessionId);
    known.delete(name);
    return;
  }

  const state = parseState(text);
  if (!state) return;

  const prev = known.get(name);
  if (prev && prev.sessionId && prev.sessionId !== state.sessionId) forgetSession(prev.sessionId);
  known.set(name, { procStart: state.procStart, status: state.status, sessionId: state.sessionId });
  if (isProcessAlive(state.pid)) {
    statusBySession.set(state.sessionId, { status: state.status, statusUpdatedAt: state.statusUpdatedAt, pid: state.pid });
  } else {
    forgetSession(state.sessionId);
  }

  const reused = !!prev && prev.procStart !== state.procStart;
  if (!prev || reused) return;
  if (prev.status === state.status) return;
  if (state.status !== RESCAN_STATUS) return;
  if (!isProcessAlive(state.pid)) return;

  const match = findSession(state.sessionId);
  if (!match) {
    log.debug(`[cli-state] no active session for ${state.sessionId} (pid ${state.pid})`);
    return;
  }

  const now = Date.now();
  const last = lastRescanAt.get(match.sessionId) || 0;
  if (now - last < MIN_RESCAN_INTERVAL_MS) return;
  lastRescanAt.set(match.sessionId, now);

  try {
    onIdle(match.sessionId, match.session);
  } catch (err) {
    log.warn(`[cli-state] rescan failed for ${match.sessionId}: ${err.message}`);
  }
}

function flush() {
  flushTimer = null;
  const batch = [...pending];
  pending.clear();
  for (const name of batch) handleFile(name);
  if (batch.length > 0) notifyDescriptorsChanged();
}

function seed() {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const files = names.filter(n => STATE_FILE_RE.test(n));
  if (files.length > MAX_SEEDED_FILES) return;
  for (const name of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const state = parseState(text);
    if (state) {
      known.set(name, { procStart: state.procStart, status: state.status, sessionId: state.sessionId });
      if (isProcessAlive(state.pid)) {
        statusBySession.set(state.sessionId, { status: state.status, statusUpdatedAt: state.statusUpdatedAt, pid: state.pid });
      }
    }
  }
}

function forgetSession(sessionId) {
  statusBySession.delete(sessionId);
  lastProbeAt.delete(sessionId);
}

function ensureWatching() {
  if (watcher) return true;
  if (!onIdle || !activeSessions) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  seed();
  try {
    watcher = fs.watch(dir, (_eventType, filename) => {
      if (!filename || !STATE_FILE_RE.test(filename)) return;
      pending.add(filename);
      if (flushTimer) return;
      flushTimer = setTimeout(flush, FLUSH_MS);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    });
    watcher.on('error', (err) => {
      log.warn(`[cli-state] watcher error: ${err.message}`);
      stop();
    });
  } catch (err) {
    watcher = null;
    log.warn(`[cli-state] cannot watch ${dir}: ${err.message}`);
    return false;
  }
  log.info(`[cli-state] watching ${dir}`);
  return true;
}

function stop() {
  if (watcher) {
    try { watcher.close(); } catch {}
    watcher = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending.clear();
  known.clear();
  statusBySession.clear();
  lastRescanAt.clear();
  lastProbeAt.clear();
}

// Lookup + throttled lazy liveness re-probe -- see .ai/contexts/cli-session-state.md ("the one invariant" still holds: never arms onIdle).
function getStatus(sessionId) {
  const entry = statusBySession.get(sessionId);
  if (!entry) return undefined;

  const t = now();
  const last = lastProbeAt.get(sessionId) || 0;
  if (t - last >= GET_STATUS_PROBE_THROTTLE_MS) {
    lastProbeAt.set(sessionId, t);
    if (!isProcessAlive(entry.pid)) {
      forgetSession(sessionId);
      return undefined;
    }
  }
  return { status: entry.status, statusUpdatedAt: entry.statusUpdatedAt };
}

function canCompareProcStart(raw) {
  if (raw.procStart == null) return false;
  const windowsDescriptor = typeof raw.pidDomain === 'string' && raw.pidDomain.startsWith('win32:');
  if (platform === 'win32' || windowsDescriptor) {
    return raw.pidDomain === 'win32:anchor'
      && typeof raw.procStart === 'string'
      && WINDOWS_FILETIME_RE.test(raw.procStart);
  }
  return true;
}

// On-demand scan, independent of the watcher -- see .ai/contexts/cli-session-state.md ("Live elsewhere")
async function scanLiveProcesses(sessionIds, exclude) {
  const found = new Map();
  if (sessionIds.size === 0) return found;
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return found; }
  const candidates = [];
  for (const name of names) {
    if (!STATE_FILE_RE.test(name)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!raw || typeof raw !== 'object' || !sessionIds.has(raw.sessionId)) continue;
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) continue;
    if (!isProcessAlive(raw.pid)) continue;
    if (exclude(raw.pid)) continue;
    candidates.push(raw);
  }

  const comparable = [...new Set(candidates.filter(canCompareProcStart).map((raw) => raw.pid))];
  const toProbe = platform === 'win32' ? comparable.slice(0, MAX_PROBE_PIDS) : comparable;
  let actualByPid = new Map();
  if (toProbe.length > 0) {
    try {
      const probed = await readProcStartMany(toProbe);
      if (probed instanceof Map) actualByPid = probed;
    } catch {}
  }

  for (const raw of candidates) {
    if (found.has(raw.sessionId)) continue;
    if (canCompareProcStart(raw) && toProbe.includes(raw.pid)) {
      const actual = actualByPid.get(raw.pid);
      if (actual != null && String(actual) !== String(raw.procStart)) continue;
    }
    found.set(raw.sessionId, {
      pid: raw.pid,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : null,
      jobId: typeof raw.jobId === 'string' && raw.jobId ? raw.jobId : null,
    });
  }
  return found;
}

async function findLiveProcess(sessionId, { exclude = () => false } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return (await scanLiveProcesses(new Set([sessionId]), exclude)).get(sessionId) || null;
}

function ownProcessFilter(ptyPids) {
  const own = new Set(ptyPids());
  return (pid) => own.has(pid) || descendsFromThisProcess(pid);
}

async function liveElsewhere(sessionId, hasPty, ptyPids = () => []) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (hasPty(sessionId)) return null;
  return findLiveProcess(sessionId, { exclude: ownProcessFilter(ptyPids) });
}

async function liveElsewhereMany(sessionIds, hasPty, ptyPids = () => []) {
  const result = {};
  if (!Array.isArray(sessionIds)) return result;
  const wanted = new Set();
  for (const id of sessionIds) {
    if (wanted.size >= MAX_LIVE_QUERY_IDS) break;
    if (typeof id === 'string' && id && !hasPty(id)) wanted.add(id);
  }
  for (const [id, live] of await scanLiveProcesses(wanted, ownProcessFilter(ptyPids))) result[id] = live;
  return result;
}

module.exports = {
  init,
  findLiveProcess,
  liveElsewhere,
  liveElsewhereMany,
  MAX_LIVE_QUERY_IDS,
  MAX_PROBE_PIDS,
  probeProcStartWindows,
  ensureWatching,
  stop,
  parseState,
  onDescriptorsChanged,
  readAllDescriptors,
  parseDescriptor,
  ownProcessFilter,
  getStatus,
  KNOWN_STATUSES,
  DEFAULT_DIR,
  FLUSH_MS,
  MIN_RESCAN_INTERVAL_MS,
};
