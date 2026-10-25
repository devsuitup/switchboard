// see .ai/contexts/cli-session-state.md
'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const { bridgeSessionKey } = require('./bridge-session-id');

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
let onOwnerExit = null;
let log = null;
let isProcessAlive = defaultIsProcessAlive;
let readProcStart = defaultReadProcStart;
let readProcStartMany = defaultReadProcStartMany;
let readParentPid = defaultReadParentPid;
let readCliProcess = defaultReadCliProcess;
let readRealpath = fs.realpathSync;
let readProcessTable = defaultReadProcessTable;
let processTableEnabled = false;
let processTableEpoch = 0;
let processTable = null;
let processTableInFlight = null;
let ownPid = process.pid;
let now = Date.now;
let platform = process.platform;
let deliveryInitialized = false;

let watcher = null;
let flushTimer = null;
let livenessTimer = null;
const pending = new Set();
const known = new Map();
const lastRescanAt = new Map();
// sessionId -> { status, statusUpdatedAt, pid } for live pids only -- see .ai/contexts/cli-session-state.md
const statusBySession = new Map();
let staleSidebarIdentity = '[]';
const lastProbeAt = new Map();
const statusKey = (sessionId) => String(sessionId).toLowerCase();
const MAX_DESCRIPTOR_SCAN = 1000;
// Listeners told "the directory changed" after each flushed batch -- see .ai/contexts/bg-agents.md
const descriptorListeners = new Set();
const statusListeners = new Set();
const pendingOwnerDeaths = new Map();
const scheduledRuns = new Map();

function trackScheduleRun(sessionId, child, cwd, scheduleName) {
  const key = sessionId.toLowerCase();
  const live = { kind: 'schedule', pid: child.pid, cwd, startedAt: Date.now(), scheduleName };
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

const TABLE_LINE_RE = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*(?:\t(.*))?$/;
const TABLE_LSTART_RE = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/;

function parseProcessTable(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    let m = TABLE_LINE_RE.exec(line);
    if (m) { out.set(Number(m[1]), { ppid: Number(m[2]), created: toCreated(m[3]), ...(m[4] === undefined ? {} : { commandLine: m[4] }) }); continue; }
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
      const script = 'Get-CimInstance -ClassName Win32_Process | ForEach-Object { $t = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { "" }; "$($_.ProcessId) $($_.ParentProcessId) $t`t$($_.CommandLine)" }';
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

function deliveryProcessTableFresh() {
  return !processTableEnabled || (processTableFresh() && !!processTable.map);
}

function normaliseProcessTable(read) {
  if (!(read instanceof Map) || read.size === 0) return null;
  const out = new Map();
  for (const [pid, value] of read) {
    if (typeof value === 'number') out.set(pid, { ppid: value, created: null });
    else if (value && typeof value === 'object') out.set(pid, { ppid: value.ppid, created: toCreated(value.created), ...(value.commandLine === undefined ? {} : { commandLine: value.commandLine }) });
  }
  return out.size > 0 ? out : null;
}

function refreshProcessTable() {
  if (!processTableEnabled) return Promise.resolve(null);
  if (processTableFresh()) return Promise.resolve(processTable.map);
  if (processTableInFlight) return processTableInFlight;
  const epoch = processTableEpoch;
  const observedAt = now();
  const inFlight = (async () => {
    let map = null;
    try {
      map = normaliseProcessTable(await readProcessTable());
    } catch (err) {
      log.debug(`[cli-state] process table unreadable: ${err && err.message}`);
    }
    if (epoch === processTableEpoch) {
      processTable = { at: now(), observedAt, map };
      processTableInFlight = null;
      if (map) {
        const stale = JSON.stringify([...statusBySession].filter(([id, entry]) => sidebarDescriptorIsStale(id, entry))
          .map(([id, entry]) => [id, entry.pid]).sort());
        const sidebarChanged = stale !== staleSidebarIdentity;
        staleSidebarIdentity = stale;
        if (sidebarChanged) notifyStatusesChanged();
        notifyDescriptorsChanged();
      }
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

// see .ai/contexts/trigger-watcher.md
function defaultReadCliProcess(pid) {
  let args;
  if (processTableEnabled) {
    const commandLine = processTableFresh() ? tableEntry(pid)?.commandLine : null;
    if (!commandLine) return null;
    const executable = /^"([^"]*)"|^((?:[A-Za-z]:[\\/]|\\\\)[^"\r\n]*?\.exe)(?=\s|$)|^(\S+)/i.exec(commandLine.trim());
    if (!executable) return null;
    args = [executable[1] ?? executable[2] ?? executable[3]];
    const rest = commandLine.trim().slice(executable[0].length);
    const tokens = /"([^"]*)"|((?:[A-Za-z]:[\\/]|\\\\)[^"\r\n]*?\.(?:[cm]?js))(?=\s|$)|(\S+)/gi;
    args.push(...[...rest.matchAll(tokens)].map(match => match[1] ?? match[2] ?? match[3]));
  } else {
    if (platform !== 'linux') return null;
    try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; }
  }
  if (!args.length) return null;
  const name = value => value.replaceAll('\\', '/').split('/').pop().toLowerCase();
  if (/^claude(?:\.exe)?$/.test(name(args[0]))) return true;
  const script = args.slice(1).find(arg => !arg.startsWith('-'));
  if (!/^node(?:\.exe)?$/.test(name(args[0])) || typeof script !== 'string') return false;
  const cliScript = /(?:^|[\\/])@anthropic-ai[\\/]claude-code[\\/]cli\.js$/i;
  if (cliScript.test(script)) return true;
  try { return cliScript.test(readRealpath(script)); } catch { return false; }
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
  deliveryInitialized = true;
  dir = ctx.dir || DEFAULT_DIR;
  activeSessions = ctx.activeSessions;
  onIdle = ctx.onIdle;
  onOwnerExit = ctx.onOwnerExit || null;
  log = ctx.log || { info() {}, debug() {}, warn() {}, error() {} };
  isProcessAlive = ctx.isProcessAlive || defaultIsProcessAlive;
  readProcStart = ctx.readProcStart || defaultReadProcStart;
  readProcStartMany = ctx.readProcStartMany
    || (ctx.readProcStart
      ? async (pids) => new Map(pids.map((pid) => [pid, ctx.readProcStart(pid)]))
      : defaultReadProcStartMany);
  now = ctx.now || Date.now;
  platform = ctx.platform || process.platform;
  readParentPid = ctx.readParentPid || defaultReadParentPid;
  readCliProcess = ctx.readCliProcess || defaultReadCliProcess;
  readRealpath = ctx.readRealpath || fs.realpathSync;
  ownPid = ctx.ownPid || process.pid;
  processTableEnabled = !ctx.readParentPid && (platform === 'win32' || platform === 'darwin');
  readProcessTable = ctx.readProcessTable || defaultReadProcessTable;
  processTableEpoch++;
  processTable = null;
  staleSidebarIdentity = '[]';
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
    waitingFor: typeof raw.waitingFor === 'string' && raw.waitingFor ? raw.waitingFor : null,
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
    bridgeSessionId: s(raw.bridgeSessionId),
    jobId: s(raw.jobId),
    agent: s(raw.agent),
    name: s(raw.name),
    ...(s(raw.nameSource) ? { nameSource: s(raw.nameSource) } : {}),
    cwd: s(raw.cwd),
    status: KNOWN_STATUSES.has(raw.status) ? raw.status : null,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
  };
}

function readAllDescriptors() {
  startProcessTableRefresh();
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
    if (!d || !isProcessAlive(d.pid)) continue;
    let raw;
    try {
      raw = JSON.parse(text);
      raw.descriptorMtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch { continue; }
    if (deliveryProcessIdentity(raw) !== 'stale') out.push(d);
  }
  return out;
}

// see .ai/contexts/session-state.md ("Proven continuation re-key")
function getDescriptorIdentity(snapshot = {}) {
  Object.assign(snapshot, readWriterDescriptors());
  if (!snapshot.descriptors) return null;
  return JSON.stringify([...new Set([...snapshot.descriptors.values()].map(d => JSON.stringify([d.sessionId, d.pid])))].sort());
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

function onStatusesChanged(listener) {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

function notifyStatusesChanged() {
  for (const listener of statusListeners) {
    try { listener(); } catch (err) { log.warn('[cli-state] status listener failed: ' + err.message); }
  }
}

function notifyOwnerExit(sessionId, pid) {
  if (!onOwnerExit) return;
  const key = statusKey(sessionId);
  if (pendingOwnerDeaths.has(key)) return;
  const callback = onOwnerExit;
  pendingOwnerDeaths.set(key, pid);
  queueMicrotask(() => {
    if (!pendingOwnerDeaths.has(key)) return;
    pendingOwnerDeaths.delete(key);
    const current = statusBySession.get(key);
    if (current && isProcessAlive(current.pid)) return;
    if ([...known.values()].some(entry => statusKey(entry.sessionId) === key && isProcessAlive(entry.pid))) return;
    try { callback(key); } catch (err) { log.warn(`[cli-state] owner-exit callback failed: ${err.message}`); }
  });
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

function retainAfterMiss(name, deleted) {
  const stale = known.get(name);
  if (!stale) return;
  if (deleted && !isProcessAlive(stale.pid)) {
    notifyOwnerExit(stale.sessionId, stale.pid);
    forgetSession(stale.sessionId);
    known.delete(name);
    return;
  }
  stale.missedProbes ??= 0;
}

function handleFile(name) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch (err) {
    retainAfterMiss(name, err.code === 'ENOENT');
    return;
  }

  const state = parseState(text);
  if (!state) {
    retainAfterMiss(name, false);
    return;
  }

  const prev = known.get(name);
  if (prev && prev.sessionId && statusKey(prev.sessionId) !== statusKey(state.sessionId)) forgetSession(prev.sessionId);
  const identity = { ...state, pidDomain: JSON.parse(text).pidDomain };
  try { identity.descriptorMtimeMs = fs.statSync(path.join(dir, name)).mtimeMs; } catch {}
  known.set(name, identity);
  if (isProcessAlive(state.pid)) {
    statusBySession.set(statusKey(state.sessionId), { ...parseDescriptor(text), status: state.status,
      statusUpdatedAt: state.statusUpdatedAt, waitingFor: state.waitingFor, pid: state.pid });
  } else {
    notifyOwnerExit(state.sessionId, state.pid);
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
  const previous = new Map(statusBySession);
  for (const name of batch) handleFile(name);
  armLivenessProbe();
  if (previous.size !== statusBySession.size || [...statusBySession].some(([id, entry]) => {
    const prev = previous.get(id);
    return sidebarStateChanged(prev, entry);
  })) notifyStatusesChanged();
  if (batch.length > 0) notifyDescriptorsChanged();
}

function armLivenessProbe() {
  if (livenessTimer || !watcher || statusBySession.size === 0) return;
  livenessTimer = setTimeout(() => {
    livenessTimer = null;
    const previous = new Map(statusBySession);
    for (const [name, stale] of known) {
      if (stale.missedProbes == null || !statusBySession.has(statusKey(stale.sessionId))) continue;
      handleFile(name);
      const retained = known.get(name);
      if (retained && retained.missedProbes != null && ++retained.missedProbes >= 2) {
        forgetSession(retained.sessionId);
        known.delete(name);
      }
    }
    for (const [id, entry] of statusBySession) {
      if (!isProcessAlive(entry.pid)) {
        notifyOwnerExit(id, entry.pid);
        forgetSession(id);
      }
    }
    if (previous.size !== statusBySession.size || [...statusBySession].some(([id, entry]) => {
      const prev = previous.get(id);
      return sidebarStateChanged(prev, entry);
    })) {
      notifyDescriptorsChanged();
      notifyStatusesChanged();
    }
    armLivenessProbe();
  }, GET_STATUS_PROBE_THROTTLE_MS);
  if (typeof livenessTimer.unref === 'function') livenessTimer.unref();
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
      const identity = { ...state, pidDomain: JSON.parse(text).pidDomain };
      try { identity.descriptorMtimeMs = fs.statSync(path.join(dir, name)).mtimeMs; } catch {}
      known.set(name, identity);
      if (isProcessAlive(state.pid)) {
        statusBySession.set(statusKey(state.sessionId), { ...parseDescriptor(text), status: state.status,
          statusUpdatedAt: state.statusUpdatedAt, waitingFor: state.waitingFor, pid: state.pid });
      } else {
        notifyOwnerExit(state.sessionId, state.pid);
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
  armLivenessProbe();
  log.info(`[cli-state] watching ${dir}`);
  return true;
}

function stop() {
  pendingOwnerDeaths.clear();
  const hadStatus = statusBySession.size > 0;
  if (watcher) {
    try { watcher.close(); } catch {}
    watcher = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (livenessTimer) {
    clearTimeout(livenessTimer);
    livenessTimer = null;
  }
  pending.clear();
  known.clear();
  statusBySession.clear();
  staleSidebarIdentity = '[]';
  lastRescanAt.clear();
  lastProbeAt.clear();
  if (hadStatus) {
    notifyDescriptorsChanged();
    notifyStatusesChanged();
  }
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
      notifyOwnerExit(sessionId, entry.pid);
      forgetSession(sessionId);
      notifyDescriptorsChanged();
      notifyStatusesChanged();
      return undefined;
    }
  }
  return { status: entry.status, statusUpdatedAt: entry.statusUpdatedAt, waitingFor: entry.waitingFor };
}

function sidebarStateChanged(previous, entry) {
  return !previous || ['status', 'waitingFor', 'pid', 'kind', 'jobId', 'name', 'nameSource', 'cwd'].some(field => previous[field] !== entry[field]);
}

function getSidebarDescriptors() {
  startProcessTableRefresh();
  const descriptors = [];
  for (const [id, entry] of statusBySession) {
    if (getStatus(id) && !sidebarDescriptorIsStale(id, entry)) descriptors.push({ ...entry });
  }
  return descriptors;
}

function sidebarDescriptorIsStale(id, entry) {
  if (processTableEnabled && (!processTableFresh() || !processTable.map)) {
    return JSON.parse(staleSidebarIdentity).some(([sessionId, pid]) => sessionId === id && pid === entry.pid);
  }
  const writer = [...known.values()].find(s => s.pid === entry.pid && statusKey(s.sessionId) === id);
  return !!writer && deliveryProcessIdentity(writer) === 'stale';
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
    if (!raw || typeof raw !== 'object' || typeof raw.sessionId !== 'string') continue;
    const keys = [...sessionIds].filter(key => raw.sessionId.toLowerCase() === key
      || (bridgeSessionKey(key) !== null && bridgeSessionKey(key) === bridgeSessionKey(raw.bridgeSessionId)));
    if (!keys.length) continue;
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) continue;
    if (!isProcessAlive(raw.pid)) continue;
    alive.push({ ...raw, keys });
  }
  if (typeof exclude.needsProcessTable === 'function' && alive.some((raw) => raw.keys.some((key) => exclude.needsProcessTable(key)))) await refreshProcessTable();
  const candidates = alive.filter((raw) => !raw.keys.every((key) => exclude(raw.pid, raw, key)));

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
    if (canCompareProcStart(raw) && toProbe.includes(raw.pid)) {
      const actual = actualByPid.get(raw.pid);
      if (actual != null && String(actual) !== String(raw.procStart)) continue;
    }
    const live = {
      pid: raw.pid,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
      startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : null,
      jobId: typeof raw.jobId === 'string' && raw.jobId ? raw.jobId : null,
    };
    for (const key of raw.keys) if (!found.has(key)) found.set(key, live);
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

// see .ai/contexts/cli-session-state.md ("Owner of a /clear transcript")
function clearOwner(sessionId, ptyPid, { closestWriter = false, descriptorSnapshot } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || !Number.isInteger(ptyPid)) return 'pending';
  if (closestWriter) return closestWriterOwner(sessionId, ptyPid,
    descriptorSnapshot && descriptorSnapshot.descriptors ? descriptorSnapshot : readWriterDescriptors());
  let names;
  try { names = fs.readdirSync(dir); } catch { return 'pending'; }
  const key = sessionId.toLowerCase();
  let pid = null;
  let found = null;
  for (const name of names) {
    if (!STATE_FILE_RE.test(name)) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!raw || typeof raw.sessionId !== 'string' || raw.sessionId.toLowerCase() !== key) continue;
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) continue;
    if (!isProcessAlive(raw.pid)) continue;
    pid = raw.pid;
    found = raw;
    break;
  }
  if (pid == null) return 'pending';
  if (processTableEnabled) {
    startProcessTableRefresh();
    if (!tableEntry(pid)) return 'pending';
    return conversationOwns(found, new Set([ptyPid])) ? 'mine' : 'other';
  }
  let current = pid;
  for (let depth = 0; depth < 64 && current && current > 1; depth++) {
    if (current === ptyPid) return 'mine';
    const parent = readParentPid(current);
    if (parent == null) return depth === 0 ? 'unknown' : 'other';
    current = parent;
  }
  return 'other';
}

// see .ai/contexts/session-state.md ("Proven continuation re-key")
function readWriterDescriptors() {
  let names;
  try { names = fs.readdirSync(dir); } catch { return {}; }
  const descriptors = new Map(), unreadable = new Set();
  for (const name of names) {
    if (!STATE_FILE_RE.test(name)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!parseDescriptor(JSON.stringify(raw))) { unreadable.add(Number(path.basename(name, '.json'))); continue; }
      if (isProcessAlive(raw.pid)) {
        raw.descriptorMtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
        descriptors.set(raw.pid, raw);
      }
    } catch { unreadable.add(Number(path.basename(name, '.json'))); }
  }
  return { descriptors, unreadable };
}

// see docs/decisions/0003-trigger-delivery-per-tab.md
function deliveryProcessIdentity(raw) {
  if (processTableEnabled) {
    if (!processTableFresh() || !processTable.map) return 'unknown';
    const leaf = tableEntry(raw.pid);
    if (!leaf || leaf.created == null || raw.pidDomain !== 'win32:anchor'
      || typeof raw.procStart !== 'string' || !WINDOWS_FILETIME_RE.test(raw.procStart)) return 'unknown';
    if (leafIsTheDescriptorWriter(raw)) return 'valid';
    return processTable.observedAt >= raw.descriptorMtimeMs ? 'stale' : 'unknown';
  }
  if (platform !== 'linux' || !canCompareProcStart(raw)) return 'unknown';
  try {
    const actual = readProcStart(raw.pid);
    return actual == null ? 'unknown' : String(actual) === String(raw.procStart) ? 'valid' : 'stale';
  } catch { return 'unknown'; }
}

function deliveryAncestry(raw, ptyPid, snapshot) {
  const identity = deliveryProcessIdentity(raw);
  if (identity === 'stale') return { state: 'stale' };
  let current = raw.pid;
  const visited = new Set();
  let uncertain = identity !== 'valid';
  let uncertainTree = processTableEnabled && !processTableFresh();
  for (let depth = 0; depth < 64 && current > 1; depth++) {
    if (current === ptyPid) return { state: uncertain ? 'unknown' : 'mine', depth };
    if (visited.has(current) || snapshot.unreadable?.has(current)) return { state: 'unknown' };
    visited.add(current);
    const ancestor = current === raw.pid ? null : snapshot.descriptors.get(current);
    if (current !== raw.pid && !ancestor) {
      let cli;
      try { cli = readCliProcess(current); } catch { return { state: 'unknown' }; }
      if (cli === true) return { state: 'nested' };
      if (cli !== false) uncertain = true;
    }
    if (ancestor) {
      const proof = deliveryProcessIdentity(ancestor);
      if (proof === 'unknown') uncertain = true;
      if (proof === 'valid' && !['interactive', 'bg', 'headless'].includes(ancestor.kind)) uncertain = true;
      if (proof === 'valid' && ancestor.kind === 'interactive') return { state: 'nested' };
      if (proof === 'valid' && ['bg', 'headless'].includes(ancestor.kind)) return { state: 'nested' };
    }
    let parent;
    try { parent = readParentPid(current); } catch { return { state: 'unknown' }; }
    if (!Number.isInteger(parent)) return { state: 'unknown' };
    if (parent <= 1) return { state: uncertain || uncertainTree ? 'unknown' : 'outside' };
    if (processTableEnabled) {
      const child = tableEntry(current), above = tableEntry(parent);
      if (processTableFresh() && child?.created != null && !above) return { state: uncertain || uncertainTree || parent === ptyPid ? 'unknown' : 'outside' };
      if (!processTableFresh() || !child || !above || child.created == null || above.created == null) { uncertain = true; uncertainTree = true; }
      else if (child.created < above.created) return { state: 'unknown' };
    } else {
      try {
        const child = readProcStart(current), above = readProcStart(parent);
        if (child == null || above == null) { uncertain = true; uncertainTree = true; }
        else if (/^\d+$/.test(String(child)) && /^\d+$/.test(String(above)) && BigInt(child) < BigInt(above)) return { state: 'unknown' };
      } catch { uncertain = true; uncertainTree = true; }
    }
    current = parent;
  }
  return { state: 'unknown' };
}

function observeTabWriter(ptyPid, snapshot) {
  if (!deliveryInitialized || platform === 'darwin' || !Number.isInteger(ptyPid)) return { supported: false };
  startProcessTableRefresh();
  snapshot ||= readWriterDescriptors();
  if (!snapshot.descriptors) return { supported: true };
  const candidates = [];
  let uncertain = false;
  for (const raw of snapshot.descriptors.values()) {
    if (raw.kind !== 'interactive') continue;
    const ancestry = deliveryAncestry(raw, ptyPid, snapshot);
    if (ancestry.state === 'unknown') uncertain = true;
    if (ancestry.state === 'mine') candidates.push({ raw, depth: ancestry.depth });
  }
  candidates.sort((a, b) => a.depth - b.depth);
  if (candidates.length !== 1) return { supported: true, uncertain };
  const writer = candidates[0].raw;
  const hasBackground = [...snapshot.descriptors.values()].some(raw => raw.kind === 'bg');
  return { supported: true, writer, identity: `${writer.pid}:${writer.procStart}`, hasBackground, uncertain };
}

function deliveryPtyStart(pid) {
  if (!deliveryInitialized) return null;
  if (processTableEnabled) return processTableFresh() ? tableEntry(pid)?.created?.toString() ?? null : null;
  if (platform !== 'linux') return null;
  try { const start = readProcStart(pid); return start == null ? null : String(start); } catch { return null; }
}

function findDeliveryTab(sessionId, tabs, hint) {
  if (!deliveryInitialized) return {};
  const key = sessionId.toLowerCase();
  const snapshot = readWriterDescriptors();
  const matches = [...(snapshot.descriptors?.values() || [])].filter(raw => raw.sessionId.toLowerCase() === key);
  const bg = [...(snapshot.descriptors?.values() || [])].find(raw => raw.kind === 'bg'
    && (raw.sessionId.toLowerCase() === key || (typeof raw.bridgeSessionId === 'string'
      && (raw.bridgeSessionId.toLowerCase() === key || (bridgeSessionKey(key) !== null
        && bridgeSessionKey(key) === bridgeSessionKey(raw.bridgeSessionId.toLowerCase())))))
    && deliveryProcessIdentity(raw) !== 'stale');
  if (bg) return { background: bg };
  if (platform === 'darwin') return {};
  const candidates = [];
  for (const tab of tabs) {
    const observed = observeTabWriter(tab.pty?.pid, snapshot);
    if (observed.writer?.sessionId.toLowerCase() === key) candidates.push({ tab, observed });
  }
  if (candidates.length === 1) return { tab: candidates[0].tab, hint: candidates[0].observed.writer };
  if (candidates.length > 1) return { ambiguous: true };
  for (const raw of [...matches, ...(hint ? [hint] : [])]) {
    if (raw.kind !== 'interactive' || !isProcessAlive(raw.pid)) continue;
    if (platform === 'linux' && (raw.procStart == null || tabs.every(tab => deliveryPtyStart(tab.pty?.pid) == null))) continue;
    if (platform === 'win32' && raw.pidDomain !== 'win32:anchor') continue;
    const states = tabs.map(tab => deliveryAncestry(raw, tab.pty?.pid, snapshot).state);
    if (states.includes('unknown')) return { pending: true, hint: raw };
  }
  return {};
}

// see .ai/contexts/session-state.md ("Proven continuation re-key")
function closestWriterOwner(sessionId, ptyPid, { descriptors, unreadable }) {
  if (!descriptors) return 'pending';
  const matches = [...descriptors.values()].filter(raw => raw.sessionId.toLowerCase() === sessionId.toLowerCase());
  if (matches.length === 0) return 'absent';
  if (platform === 'darwin') return 'unsupported';
  if (processTableEnabled) startProcessTableRefresh();
  let verdict = 'pending', uncertain = false;
  for (const raw of matches) {
    let owner = descriptorWriterOwner(raw, ptyPid, descriptors, unreadable);
    if (owner === 'other' && processTableEnabled
      && processTable.observedAt < raw.descriptorMtimeMs) owner = 'pending';
    if (owner === 'mine') return 'mine';
    if (owner === 'pending') uncertain = true;
    else verdict = owner;
  }
  return uncertain ? 'pending' : verdict;
}

// see .ai/contexts/session-state.md ("Proven continuation re-key")
function descriptorWriterOwner(raw, ptyPid, descriptors, unreadable) {
  if (processTableEnabled) {
    const leaf = tableEntry(raw.pid);
    if (!leaf || leaf.created == null || raw.pidDomain !== 'win32:anchor'
      || typeof raw.procStart !== 'string' || !WINDOWS_FILETIME_RE.test(raw.procStart)) return 'pending';
    if (!leafIsTheDescriptorWriter(raw)) return 'other';
  }
  let current = raw.pid;
  const visited = new Set();
  for (let depth = 0; depth < 64 && current > 1; depth++) {
    const descriptor = descriptors.get(current);
    if (descriptor && !processTableEnabled) {
      let actual;
      try { actual = readProcStart(current); } catch { return 'pending'; }
      if (!canCompareProcStart(descriptor) || actual == null
        || String(actual) !== String(descriptor.procStart)) return 'pending';
    }
    if (current !== raw.pid && descriptor) {
      if (processTableEnabled && !leafIsTheDescriptorWriter(descriptor)) return 'pending';
      return 'other';
    }
    if (current === ptyPid) return 'mine';
    if (visited.has(current)) return 'pending';
    visited.add(current);
    const parent = readParentPid(current);
    if (parent == null || unreadable.has(parent)) return 'pending';
    if (parent <= 1) return 'other';
    if (processTableEnabled) {
      const child = tableEntry(current), above = tableEntry(parent);
      if (!child || !above || child.created == null || above.created == null) return 'pending';
      if (child.created < above.created) return 'other';
    }
    current = parent;
  }
  return current <= 1 ? 'other' : 'pending';
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
  const key = bridgeSessionKey(sessionId) !== null ? sessionId : sessionId.toLowerCase();
  const scheduled = scheduledRuns.get(sessionId.toLowerCase());
  if (scheduled) return { known: true, live: scheduled };
  const { found, unreadable } = await scanLiveProcessesChecked(new Set([key]), includeOwnProcesses ? () => false : conversationExclusion(ptyPids));
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
  clearOwner,
  observeTabWriter,
  findDeliveryTab,
  deliveryPtyStart,
  deliveryProcessTableFresh,
  MAX_LIVE_QUERY_IDS,
  MAX_PROBE_PIDS,
  probeProcStartWindows,
  ensureWatching,
  stop,
  parseState,
  onDescriptorsChanged,
  onStatusesChanged,
  readAllDescriptors,
  getDescriptorIdentity,
  parseDescriptor,
  ownProcessFilter,
  makePtyPids,
  refreshProcessTable,
  parseProcessTable,
  probeProcessTable,
  PROCESS_TABLE_TTL_MS,
  getStatus,
  getSidebarDescriptors,
  KNOWN_STATUSES,
  DEFAULT_DIR,
  FLUSH_MS,
  MIN_RESCAN_INTERVAL_MS,
};
