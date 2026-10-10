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
const PROCESS_TABLE_TTL_MS = 3000;
const PROCESS_TABLE_MAX_BUFFER = 4 << 20;
const PROC_START_TOLERANCE = 100n;
const abs = (n) => (n < 0n ? -n : n);

let dir = DEFAULT_DIR;
let activeSessions = null;
let onIdle = null;
let log = null;
let isProcessAlive = defaultIsProcessAlive;
let readProcStartMany = defaultReadProcStartMany;
let readParentPid = defaultReadParentPid;
let readProcessTable = defaultReadProcessTable;
let processTableEnabled = false;
let processTableEpoch = 0;
let processTable = null;
let processTableInFlight = null;
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
const statusKey = (sessionId) => String(sessionId).toLowerCase();
const MAX_DESCRIPTOR_SCAN = 1000;
// Listeners told "the directory changed" after each flushed batch -- see .ai/contexts/bg-agents.md
const descriptorListeners = new Set();
const scheduledRuns = new Map();

function trackScheduleRun(sessionId, child, cwd) {
  const key = sessionId.toLowerCase();
  const live = { kind: 'schedule', pid: child.pid, cwd, startedAt: Date.now() };
  scheduledRuns.set(key, live);
  const release = () => {
    if (scheduledRuns.get(key) === live) scheduledRuns.delete(key);
  };
  child.once('exit', release);
  child.once('error', release);
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function defaultReadParentPid(pid) {
  if (processTableEnabled) return tableEntry(pid) ? (tableEntry(pid).ppid ?? null) : null;
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

// see .ai/contexts/cli-session-state.md ("Own descendants outside Linux")
function toCreated(value) {
  if (value == null || value === '') return null;
  try { return BigInt(value); } catch { return null; }
}

const TABLE_LINE_RE = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/;
const TABLE_LSTART_RE = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/;

function parseProcessTable(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    let m = TABLE_LINE_RE.exec(line);
    if (m) { out.set(Number(m[1]), { ppid: Number(m[2]), created: toCreated(m[3]) }); continue; }
    m = TABLE_LSTART_RE.exec(line);
    if (m) {
      const ms = Date.parse(m[3]);
      out.set(Number(m[1]), { ppid: Number(m[2]), created: Number.isFinite(ms) ? BigInt(ms) : null });
    }
  }
  return out;
}

function probeProcessTable(plat = process.platform, timeoutMs = PROBE_TIMEOUT_MS, exec = execFile) {
  return new Promise((resolve, reject) => {
    const opts = { timeout: timeoutMs, windowsHide: true, maxBuffer: PROCESS_TABLE_MAX_BUFFER };
    const done = (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(parseProcessTable(stdout));
    };
    if (plat === 'win32') {
      const script = 'Get-CimInstance -ClassName Win32_Process | ForEach-Object { $t = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { "" }; "$($_.ProcessId) $($_.ParentProcessId) $t" }';
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      exec(exe, ['-NoProfile', '-NonInteractive', '-Command', script], opts, done);
    } else if (plat === 'darwin') {
      exec('/bin/ps', ['-A', '-o', 'pid=,ppid=,lstart='], opts, done);
    } else {
      resolve(new Map());
    }
  });
}

function defaultReadProcessTable() {
  return probeProcessTable(process.platform);
}

function processTableFresh() {
  return !!processTable && now() - processTable.at < PROCESS_TABLE_TTL_MS;
}

function normaliseProcessTable(read) {
  if (!(read instanceof Map) || read.size === 0) return null;
  const out = new Map();
  for (const [pid, value] of read) {
    if (typeof value === 'number') out.set(pid, { ppid: value, created: null });
    else if (value && typeof value === 'object') out.set(pid, { ppid: value.ppid, created: toCreated(value.created) });
  }
  return out.size > 0 ? out : null;
}

function refreshProcessTable() {
  if (!processTableEnabled) return Promise.resolve(null);
  if (processTableFresh()) return Promise.resolve(processTable.map);
  if (processTableInFlight) return processTableInFlight;
  const epoch = processTableEpoch;
  const inFlight = (async () => {
    let map = null;
    try {
      map = normaliseProcessTable(await readProcessTable());
    } catch (err) {
      log.debug(`[cli-state] process table unreadable: ${err && err.message}`);
    }
    if (epoch === processTableEpoch) {
      processTable = { at: now(), map };
      processTableInFlight = null;
      if (map) notifyDescriptorsChanged();
    }
    return map;
  })();
  processTableInFlight = inFlight;
  return inFlight;
}

function startProcessTableRefresh() {
  if (!processTableEnabled || processTableFresh() || processTableInFlight) return;
  refreshProcessTable().catch(() => {});
}

function tableEntry(pid) {
  return processTable && processTable.map ? processTable.map.get(pid) : undefined;
}

// Walks pid's parents until isAnchor holds. With a table, a child older than its parent breaks the chain (a reused pid); strict also needs every creation time known.
function chainReaches(pid, isAnchor, strict) {
  let current = pid;
  for (let depth = 0; depth < 64 && current && current > 1; depth++) {
    if (isAnchor(current)) return true;
    const parent = readParentPid(current);
    if (!parent) return false;
    if (processTableEnabled) {
      const child = tableEntry(current);
      const above = tableEntry(parent);
      const known = !!child && !!above && child.created != null && above.created != null;
      if (strict && !known) return false;
      if (known && child.created < above.created) return false;
    }
    current = parent;
  }
  return false;
}

// see .ai/contexts/cli-session-state.md ("Live elsewhere")
function descendsFromThisProcess(pid, own = null) {
  return chainReaches(pid, (current) => current === ownPid || (own !== null && own.has(current)), false);
}

function leafIsTheDescriptorWriter(raw) {
  const leaf = tableEntry(raw.pid);
  if (!leaf || leaf.created == null) return false;
  return raw.pidDomain === 'win32:anchor'
    && typeof raw.procStart === 'string'
    && WINDOWS_FILETIME_RE.test(raw.procStart)
    && abs(leaf.created - BigInt(raw.procStart)) <= PROC_START_TOLERANCE;
}

// The descriptor's writer is this conversation's own CLI only when it descends from a PTY registered for that conversation.
function conversationOwns(raw, own) {
  if (own.size === 0) return false;
  if (!processTableEnabled) return own.has(raw.pid) || chainReaches(raw.pid, (current) => own.has(current), false);
  return leafIsTheDescriptorWriter(raw) && chainReaches(raw.pid, (current) => own.has(current), true);
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
  now = ctx.now || Date.now;
  platform = ctx.platform || process.platform;
  readParentPid = ctx.readParentPid || defaultReadParentPid;
  ownPid = ctx.ownPid || process.pid;
  processTableEnabled = !ctx.readParentPid && (platform === 'win32' || platform === 'darwin');
  readProcessTable = ctx.readProcessTable || defaultReadProcessTable;
  processTableEpoch++;
  processTable = null;
  processTableInFlight = null;
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
    if (statusKey(effectiveId) === statusKey(sessionId)) return { sessionId: effectiveId, session };
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
  if (prev && prev.sessionId && statusKey(prev.sessionId) !== statusKey(state.sessionId)) forgetSession(prev.sessionId);
  known.set(name, { procStart: state.procStart, status: state.status, sessionId: state.sessionId });
  if (isProcessAlive(state.pid)) {
    statusBySession.set(statusKey(state.sessionId), { status: state.status, statusUpdatedAt: state.statusUpdatedAt, pid: state.pid });
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
  const last = lastRescanAt.get(statusKey(match.sessionId)) || 0;
  if (now - last < MIN_RESCAN_INTERVAL_MS) return;
  lastRescanAt.set(statusKey(match.sessionId), now);

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
        statusBySession.set(statusKey(state.sessionId), { status: state.status, statusUpdatedAt: state.statusUpdatedAt, pid: state.pid });
      }
    }
  }
}

function forgetSession(sessionId) {
  statusBySession.delete(statusKey(sessionId));
  lastProbeAt.delete(statusKey(sessionId));
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
  const key = statusKey(sessionId);
  const entry = statusBySession.get(key);
  if (!entry) return undefined;

  const t = now();
  const last = lastProbeAt.get(key) || 0;
  if (t - last >= GET_STATUS_PROBE_THROTTLE_MS) {
    lastProbeAt.set(key, t);
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
async function scanLiveProcessesChecked(sessionIds, exclude) {
  const found = new Map();
  if (sessionIds.size === 0) return { found, unreadable: null };
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch (err) {
    return { found, unreadable: err && err.code === 'ENOENT' ? null : `cannot read ${dir}: ${err && err.message}` };
  }
  let unreadable = null;
  const alive = [];
  for (const name of names) {
    if (!STATE_FILE_RE.test(name)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (err) {
      if (!(err && err.code === 'ENOENT')) unreadable = unreadable || `cannot read ${path.join(dir, name)}`;
      continue;
    }
    if (!raw || typeof raw !== 'object' || typeof raw.sessionId !== 'string' || !sessionIds.has(raw.sessionId.toLowerCase())) continue;
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) continue;
    if (!isProcessAlive(raw.pid)) continue;
    alive.push(raw);
  }
  if (typeof exclude.needsProcessTable === 'function' && alive.some((raw) => exclude.needsProcessTable(raw.sessionId.toLowerCase()))) await refreshProcessTable();
  const candidates = alive.filter((raw) => !exclude(raw.pid, raw, raw.sessionId.toLowerCase()));

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
    const key = raw.sessionId.toLowerCase();
    if (found.has(key)) continue;
    if (canCompareProcStart(raw) && toProbe.includes(raw.pid)) {
      const actual = actualByPid.get(raw.pid);
      if (actual != null && String(actual) !== String(raw.procStart)) continue;
    }
    found.set(key, {
      pid: raw.pid,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : null,
      jobId: typeof raw.jobId === 'string' && raw.jobId ? raw.jobId : null,
    });
  }
  return { found, unreadable };
}

async function scanLiveProcesses(sessionIds, exclude) {
  return (await scanLiveProcessesChecked(sessionIds, exclude)).found;
}

async function findLiveProcess(sessionId, { exclude = () => false } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const key = sessionId.toLowerCase();
  return (await scanLiveProcesses(new Set([key]), exclude)).get(key) || null;
}

function ownPidTest(ptyPids) {
  const own = new Set(ptyPids());
  return (pid) => own.has(pid) || descendsFromThisProcess(pid, own);
}

function conversationExclusion(ptyPids) {
  const exclude = (_pid, raw, key) => conversationOwns(raw, new Set(ptyPids(key)));
  exclude.needsProcessTable = (key) => ptyPids(key).length > 0;
  return exclude;
}

function ownProcessFilter(ptyPids) {
  startProcessTableRefresh();
  return ownPidTest(ptyPids);
}

function makePtyPids(activeSessions) {
  return (sessionId) => {
    const want = typeof sessionId === 'string' ? sessionId.toLowerCase() : null;
    const pids = [];
    for (const [key, session] of activeSessions) {
      if (!session || session.exited || !session.pty || !Number.isInteger(session.pty.pid)) continue;
      if (want !== null && String(session.realSessionId || key).toLowerCase() !== want) continue;
      pids.push(session.pty.pid);
    }
    return pids;
  };
}

async function liveElsewhere(sessionId, hasPty, ptyPids = () => []) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (hasPty(sessionId)) return null;
  const scheduled = scheduledRuns.get(sessionId.toLowerCase());
  if (scheduled) return scheduled;
  return findLiveProcess(sessionId, { exclude: conversationExclusion(ptyPids) });
}

async function liveElsewhereChecked(sessionId, hasPty, ptyPids = () => [], { includeOwnProcesses = false } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return { known: true, live: null };
  if (!includeOwnProcesses && hasPty(sessionId)) return { known: true, live: null };
  const key = sessionId.toLowerCase();
  const scheduled = scheduledRuns.get(key);
  if (scheduled) return { known: true, live: scheduled };
  const exclude = includeOwnProcesses ? () => false : conversationExclusion(ptyPids);
  const { found, unreadable } = await scanLiveProcessesChecked(new Set([key]), exclude);
  const live = found.get(key) || null;
  if (live) return { known: true, live };
  return unreadable ? { known: false, reason: unreadable } : { known: true, live: null };
}

async function liveElsewhereMany(sessionIds, hasPty, ptyPids = () => []) {
  const result = {};
  if (!Array.isArray(sessionIds)) return result;
  const wanted = new Map();
  for (const id of sessionIds) {
    if (wanted.size >= MAX_LIVE_QUERY_IDS) break;
    if (typeof id === 'string' && id && !hasPty(id)) wanted.set(id, id.toLowerCase());
  }
  const found = await scanLiveProcesses(new Set(wanted.values()), conversationExclusion(ptyPids));
  for (const [id, key] of wanted) {
    const live = scheduledRuns.get(key) || found.get(key);
    if (live) result[id] = live;
  }
  return result;
}

module.exports = {
  init,
  trackScheduleRun,
  findLiveProcess,
  liveElsewhere,
  liveElsewhereMany,
  liveElsewhereChecked,
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
  makePtyPids,
  refreshProcessTable,
  parseProcessTable,
  probeProcessTable,
  PROCESS_TABLE_TTL_MS,
  getStatus,
  KNOWN_STATUSES,
  DEFAULT_DIR,
  FLUSH_MS,
  MIN_RESCAN_INTERVAL_MS,
};
