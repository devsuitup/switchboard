// see .ai/contexts/bg-agents.md
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseJobState, parseCliList, mergeRoster, dispatchArgs, parseDispatchOutput, stripShellNoise, JOB_ID_RE,
  dispatchRefusal, isHostedJob, SESSION_ID_RE, sessionIdFromLinkScanPath,
} = require('./bg-agents-roster');
const { resolveProjectRoots, projectRootFromPattern, worktreeRootFromPattern } = require('./project-root');
const { classifyWorkerLiveness, workerTimestamp } = require('./bg-worker-liveness');

const DEFAULT_JOBS_DIR = path.join(os.homedir(), '.claude', 'jobs');
const FLUSH_MS = 250;
const MAX_JOBS = 200;
const LIST_TIMEOUT_MS = 20000;
const VERB_TIMEOUT_MS = 60000;
const VERBS = new Set(['stop', 'respawn', 'rm', 'transcript']);
const ROOT_CACHE_MAX = 500;
const ROOT_CONCURRENCY = 4;

let jobsDir = DEFAULT_JOBS_DIR;
let homeDir = os.homedir();
let daemonRosterPath = path.join(path.dirname(DEFAULT_JOBS_DIR), 'daemon', 'roster.json');
let log = { info() {}, warn() {}, error() {}, debug() {} };
let runClaude = null;
let cliSessionState = null;
let makeIsOwnPid = () => () => false;
let isAttachedHere = () => false;
let resolveRoots = resolveProjectRoots;
let dispatchSettings = () => ({});
let resolveTranscriptPath = null;
const transcriptMemo = new Map();
const rootCache = new Map();
const rootPending = new Set();
const rootQueue = [];
let rootActive = 0;

let started = false;
let generation = 0;
let dirWatcher = null;
const jobWatchers = new Map();
const jobs = new Map();
let cliList = null;
let daemonReachable = false;
let roster = [];
let flushTimer = null;
let unsubscribeDescriptors = null;
const listeners = new Set();
const jobsListeners = new Set();
let jobsFlushTimer = null;
let jobsProjection = new Map();

function init(ctx) {
  stop();
  jobsDir = ctx.jobsDir || DEFAULT_JOBS_DIR;
  homeDir = ctx.homeDir || os.homedir();
  daemonRosterPath = ctx.daemonRosterPath || path.join(path.dirname(jobsDir), 'daemon', 'roster.json');
  log = ctx.log || log;
  runClaude = ctx.runClaude;
  cliSessionState = ctx.cliSessionState;
  makeIsOwnPid = ctx.makeIsOwnPid || (() => () => false);
  isAttachedHere = ctx.isAttachedHere || (() => false);
  resolveRoots = ctx.resolveProjectRoots || resolveProjectRoots;
  dispatchSettings = ctx.dispatchSettings || (() => ({}));
  resolveTranscriptPath = ctx.resolveTranscriptPath || null;
}

function onChange(listener) {
  listeners.add(listener);
  scheduleRebuild();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  };
}

function onJobsChanged(listener) {
  jobsListeners.add(listener);
  return () => { jobsListeners.delete(listener); };
}

function scheduleJobsChanged() {
  if (!started || !jobsListeners.size || jobsFlushTimer) return;
  jobsFlushTimer = setTimeout(() => {
    jobsFlushTimer = null;
    const next = new Map([...jobs].map(([id, job]) => [id, { state: job.state, name: job.name, nameSource: job.nameSource, sessionId: job.sessionId, transcriptPath: job.transcriptPath }]));
    const changed = next.size !== jobsProjection.size || [...next].some(([id, job]) => {
      const previous = jobsProjection.get(id);
      return !previous || ['state', 'name', 'nameSource', 'sessionId', 'transcriptPath'].some(field => previous[field] !== job[field]);
    });
    jobsProjection = next;
    if (!changed) return;
    for (const listener of jobsListeners) {
      try { listener(); } catch (err) { log.warn(`[bg-agents] jobs listener failed: ${err.message}`); }
    }
  }, FLUSH_MS);
  if (typeof jobsFlushTimer.unref === 'function') jobsFlushTimer.unref();
}

function getSnapshot() {
  return { roster, daemonReachable, cliAvailable: Array.isArray(cliList), cliEntryCount: cliList?.length || 0 };
}

function getCachedJobs() {
  return new Map(jobs);
}

function liveDescriptors() {
  return cliSessionState ? cliSessionState.readAllDescriptors() : [];
}

function emit() {
  const snapshot = getSnapshot();
  for (const listener of listeners) {
    try { listener(snapshot); } catch (err) { log.warn(`[bg-agents] listener failed: ${err.message}`); }
  }
}

function provisionalRoots(cwd) {
  return { projectRoot: projectRootFromPattern(cwd) || cwd, worktreeRoot: worktreeRootFromPattern(cwd) || cwd };
}

function rootsFor(cwd) {
  if (!cwd) return { projectRoot: null, worktreeRoot: null };
  return rootCache.get(cwd) || provisionalRoots(cwd);
}

function pumpRoots() {
  while (rootActive < ROOT_CONCURRENCY && rootQueue.length) {
    const cwd = rootQueue.shift();
    const gen = generation;
    rootActive++;
    Promise.resolve()
      .then(() => resolveRoots(cwd))
      .catch(() => null)
      .then((roots) => {
        if (gen !== generation) return;
        rootActive--;
        rootPending.delete(cwd);
        const value = roots && roots.projectRoot
          ? { projectRoot: roots.projectRoot, worktreeRoot: roots.worktreeRoot || roots.projectRoot }
          : { projectRoot: cwd, worktreeRoot: cwd };
        rootCache.set(cwd, value);
        while (rootCache.size > ROOT_CACHE_MAX) rootCache.delete(rootCache.keys().next().value);
        const shown = provisionalRoots(cwd);
        if (value.projectRoot !== shown.projectRoot || value.worktreeRoot !== shown.worktreeRoot) scheduleRebuild();
        pumpRoots();
      });
  }
}

function resolveMissingRoots(entries) {
  for (const e of entries) {
    if (!e.cwd || rootCache.has(e.cwd) || rootPending.has(e.cwd)) continue;
    rootPending.add(e.cwd);
    rootQueue.push(e.cwd);
  }
  pumpRoots();
}

function rebuild({ onlyIfChanged = false } = {}) {
  const previous = roster;
  let descriptors = [];
  try { descriptors = cliSessionState ? cliSessionState.readAllDescriptors() : []; } catch {}
  const transcriptKeys = new Set();
  roster = mergeRoster({
    cli: daemonReachable ? cliList : null,
    jobs,
    descriptors,
    isOwnPid: makeIsOwnPid(),
    isAttachedHere,
  }).map(e => {
    const key = JSON.stringify([e.sessionId, e.transcriptPath]);
    transcriptKeys.add(key);
    if (!transcriptMemo.has(key)) transcriptMemo.set(key, { sessionId: e.sessionId?.toLowerCase(), available: transcriptAvailable(e) });
    return { ...e, ...rootsFor(e.cwd), transcriptAvailable: transcriptMemo.get(key).available };
  });
  for (const key of transcriptMemo.keys()) if (!transcriptKeys.has(key)) transcriptMemo.delete(key);
  if (onlyIfChanged && JSON.stringify(previous) === JSON.stringify(roster)) return;
  emit();
  resolveMissingRoots(roster);
}

function scheduleRebuild() {
  if (!started || !listeners.size || flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; rebuild({ onlyIfChanged: true }); }, FLUSH_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function invalidateTranscripts(sessionIds, { upsertOnly = false } = {}) {
  const ids = sessionIds && new Set(sessionIds.filter(id => typeof id === 'string').map(id => id.toLowerCase()));
  let changed = false;
  for (const [key, entry] of transcriptMemo) {
    if (ids && !ids.has(entry.sessionId)) continue;
    if (ids && upsertOnly && entry.available) continue;
    transcriptMemo.delete(key);
    changed = true;
  }
  if (changed) scheduleRebuild();
}

function readJob(id) {
  let text;
  try { text = fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8'); } catch {}
  const job = parseJobState(text);
  if (job) { jobs.set(id, job); scheduleJobsChanged(); }
  else {
    const previous = jobs.get(id);
    if (previous) jobs.set(id, { ...previous, taskEvidence: { valid: false, at: null, tasks: [], inFlight: null, terminal: false } });
    log.debug(`[bg-agents] ${id}/state.json unreadable, retaining lifecycle with degraded activity`);
  }
}

function watchJob(id) {
  if (!started || jobWatchers.has(id)) return;
  readJob(id);
  try {
    const watcher = fs.watch(path.join(jobsDir, id), (_eventType, filename) => {
      if (filename && filename !== 'state.json') return;
      readJob(id);
      scheduleRebuild();
    });
    watcher.on('error', () => { try { watcher.close(); } catch {} jobWatchers.delete(id); });
    jobWatchers.set(id, watcher);
  } catch (err) {
    log.debug(`[bg-agents] cannot watch ${id}: ${err.message}`);
  }
}

function syncJobWatchers() {
  if (!started) return;
  let names;
  try { names = fs.readdirSync(jobsDir); } catch { names = []; }
  const ids = names.filter(n => JOB_ID_RE.test(n)).sort().slice(0, MAX_JOBS);
  const wanted = new Set(ids);
  for (const [id, watcher] of jobWatchers) {
    if (wanted.has(id)) continue;
    try { watcher.close(); } catch {}
    jobWatchers.delete(id);
    jobs.delete(id);
  }
  for (const id of ids) watchJob(id);
  scheduleJobsChanged();
  scheduleRebuild();
}

function start() {
  if (started) return true;
  started = true;
  try {
    dirWatcher = fs.watch(jobsDir, (eventType) => { if (eventType !== 'change') syncJobWatchers(); });
    dirWatcher.on('error', (err) => { log.warn(`[bg-agents] jobs watcher error: ${err.message}`); });
  } catch (err) {
    dirWatcher = null;
    log.debug(`[bg-agents] cannot watch ${jobsDir}: ${err.message}`);
  }
  syncJobWatchers();
  if (cliSessionState) {
    unsubscribeDescriptors = cliSessionState.onDescriptorsChanged(scheduleRebuild);
    try { cliSessionState.ensureWatching(); } catch {}
  }
  return true;
}

function stop() {
  started = false;
  generation++;
  if (dirWatcher) { try { dirWatcher.close(); } catch {} dirWatcher = null; }
  for (const watcher of jobWatchers.values()) { try { watcher.close(); } catch {} }
  jobWatchers.clear();
  jobs.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (jobsFlushTimer) { clearTimeout(jobsFlushTimer); jobsFlushTimer = null; }
  if (unsubscribeDescriptors) { unsubscribeDescriptors(); unsubscribeDescriptors = null; }
  listeners.clear();
  jobsListeners.clear();
  jobsProjection.clear();
  cliList = null;
  daemonReachable = false;
  roster = [];
  transcriptMemo.clear();
  rootCache.clear();
  rootPending.clear();
  rootQueue.length = 0;
  rootActive = 0;
}

async function run(argv, opts) {
  if (typeof runClaude !== 'function') return { code: null, stdout: '', stderr: 'claude runner not configured' };
  try {
    return await runClaude(argv, opts);
  } catch (err) {
    return { code: null, stdout: '', stderr: err && err.message ? err.message : String(err) };
  }
}

async function reconcile() {
  const gen = generation;
  const result = await run(['agents', '--json', '--all'], { cwd: homeDir, timeout: LIST_TIMEOUT_MS });
  if (gen !== generation || !started) return getSnapshot();
  const list = result.code === 0 ? parseCliList(result.stdout) : null;
  transcriptMemo.clear();
  if (list) {
    cliList = list;
    daemonReachable = true;
    syncJobWatchers();
  } else {
    cliList = null;
    daemonReachable = false;
    log.debug(`[bg-agents] claude agents --json failed: code=${result.code} ${String(result.stderr).trim().slice(0, 200)}`);
  }
  rebuild();
  return getSnapshot();
}

function cwdFor(id) {
  const entry = roster.find(e => e.id === id);
  if (entry && entry.cwd && fs.existsSync(entry.cwd)) return entry.cwd;
  return homeDir;
}

function transcriptAvailable(entry) {
  try {
    if (!entry || !entry.sessionId) return false;
    if (resolveTranscriptPath) {
      const file = resolveTranscriptPath(entry.sessionId);
      return !!file && !!fs.statSync(file, { throwIfNoEntry: false })?.isFile();
    }
    return !!entry.transcriptPath && !!fs.statSync(entry.transcriptPath, { throwIfNoEntry: false })?.isFile();
  } catch { return false; }
}

async function workerSample(force = false) {
  const sessionState = cliSessionState;
  const rosterFile = daemonRosterPath;
  try { await sessionState?.refreshProcessTable?.({ force }); } catch {}
  const processEvidence = sessionState?.readWorkerProcessEvidence?.() || {};
  let daemonRoster = null;
  try {
    const raw = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    daemonRoster = { proto: raw.proto, updatedAt: raw.updatedAt, supervisorPid: raw.supervisorPid,
      workers: Object.fromEntries(Object.entries(raw.workers || {}).map(([key, worker]) => [key, { pid: worker?.pid, procStart: worker?.procStart }])) };
  } catch {}
  return { ...processEvidence, roster: daemonRoster, descriptors: sessionState?.readAllDescriptors() || [],
    bootTime: Date.now() - os.uptime() * 1000, sampledAt: Date.now() };
}

function unchangedWorkerJob(job) {
  let latest;
  try { latest = parseJobState(fs.readFileSync(path.join(jobsDir, job.id, 'state.json'), 'utf8')); } catch {}
  return !!latest && ['state', 'daemonShort', 'updatedAt'].every(field => latest[field] === job[field])
    && (!latest.sessionId || latest.sessionId === job.sessionId);
}

async function workerEvidence(job, allStates = false) {
  if (!allStates && !['running', 'working', 'blocked'].includes(job.state)) return undefined;
  const gen = generation;
  const first = await workerSample();
  if (gen !== generation) return 'unknown';
  const evidence = classifyWorkerLiveness(job, first);
  if (evidence === 'dead') return unchangedWorkerJob(job) ? 'dead' : 'unknown';
  if (evidence !== 'unknown' || !first.processTableFresh || !first.roster
    || !Number.isInteger(first.roster.supervisorPid) || first.roster.supervisorPid <= 0
    || typeof first.tableEntry !== 'function' || first.tableEntry(first.roster.supervisorPid)
    || !(workerTimestamp(first.roster.updatedAt) >= workerTimestamp(job.updatedAt))) return evidence;
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (gen !== generation) return 'unknown';
  const confirmed = classifyWorkerLiveness(job, first, await workerSample(true));
  return gen !== generation || confirmed === 'dead' && !unchangedWorkerJob(job) ? 'unknown' : confirmed;
}

async function conversationCheck(id, { workerLiveness = true } = {}) {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) return { known: false, reason: 'invalid background session id' };
  const gen = generation;
  let job;
  try { job = parseJobState(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8')); } catch (err) {
    return { known: false, reason: `cannot read job ${id}: ${err.message}` };
  }
  if (!job || !job.state) return { known: false, reason: `job ${id} has an unknown or unreadable state` };
  const entry = roster.find(e => e.id === id);
  const sessionIds = [...new Set([job.sessionId, job.bridgeSessionId, entry && entry.sessionId]
    .filter(Boolean))];
  if (!sessionIds.length) return { known: false, reason: `job ${id} does not name its conversation` };
  const identified = { ...job, id, sessionId: job.sessionId || entry?.sessionId };
  const evidence = workerLiveness ? await workerEvidence(identified, workerLiveness === 'all') : undefined;
  if (gen !== generation) return { known: false, reason: 'background agent service changed while checking the worker' };
  return { known: true, sessionIds, state: job.state, workerLiveness: evidence,
    hosted: isHostedJob(identified, liveDescriptors(), evidence) };
}

function findRestoreJob(sessionId, attachJobId, { ignoreUnrelatedInvalid = false } = {}) {
  const same = value => typeof value === 'string' && value.toLowerCase() === sessionId.toLowerCase();
  const listed = id => roster.find(e => e.kind === 'background' && e.id === id) || null;
  const identity = (raw, id) => [raw?.sessionId, raw?.resumeSessionId,
    sessionIdFromLinkScanPath(raw?.linkScanPath), listed(id)?.sessionId].filter(value => typeof value === 'string' && value);
  const read = id => {
    const text = fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8');
    const raw = JSON.parse(text);
    const job = parseJobState(text);
    if (ignoreUnrelatedInvalid && !identity(raw, id).length) throw new Error(`job ${id} does not name its conversation; Switchboard uses the session id the Agents view last listed for that job; if Switchboard has no such list yet, a record that does not name its conversation refuses — open the Agents view, then retry`);
    if (!job?.state || (raw.id && raw.id !== id)) throw new Error(`job ${id} has an unknown or unreadable state`);
    const rawTarget = raw.resumeSessionId ?? raw.sessionId;
    const resumeTarget = typeof rawTarget === 'string' && SESSION_ID_RE.test(rawTarget) ? rawTarget.toLowerCase() : null;
    return { job: { ...job, id, resumeTarget }, matches: ignoreUnrelatedInvalid ? identity(raw, id).some(same) : same(raw.sessionId) || same(raw.resumeSessionId) || same(job.sessionId) };
  };
  try {
    if (typeof attachJobId === 'string' && JOB_ID_RE.test(attachJobId)) {
      try {
        if (!fs.statSync(jobsDir).isDirectory()) throw new Error('background jobs path is not a directory');
        fs.statSync(path.join(jobsDir, attachJobId));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return { known: false, missing: true, reason: `no background job record for ${sessionId}` };
      }
      const record = read(attachJobId);
      return record.matches ? { known: true, job: record.job }
        : { known: false, reason: `job ${attachJobId} does not match saved session ${sessionId}` };
    }
    const matches = [];
    let unreadable = false;
    let names;
    try { names = fs.readdirSync(jobsDir); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      names = [];
    }
    for (const id of names.filter(id => JOB_ID_RE.test(id)).sort()) {
      try {
        const record = read(id);
        if (record.matches) matches.push(record.job);
      } catch (err) {
        let raw, parsed = false;
        try { raw = JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8')); parsed = true; } catch {}
        if (ignoreUnrelatedInvalid) {
          if (parsed) {
            const ids = identity(raw, id);
            if (!ids.length || ids.some(same)) throw err;
            continue;
          }
        } else if (same(raw?.sessionId) || same(raw?.resumeSessionId)) throw err;
        unreadable = true;
      }
    }
    if (!matches.length && unreadable) return { known: false, reason: ignoreUnrelatedInvalid ? 'a background job record could not be read' : `cannot identify background job for ${sessionId}: unreadable job records` };
    if (matches.length !== 1) return { known: false, reason: matches.length
      ? `multiple background job records for ${sessionId}: ${matches.map(job => job.id).join(', ')}`
      : `no background job record for ${sessionId}`, ...(!matches.length ? { missing: true } : {}) };
    return { known: true, job: matches[0] };
  } catch (err) {
    return { known: false, reason: `cannot identify background job for ${sessionId}: ${err.message}` };
  }
}

async function runVerb(verb, id) {
  if (!VERBS.has(verb)) return { ok: false, error: `unknown verb: ${String(verb)}` };
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) return { ok: false, error: 'invalid background session id' };
  const gen = generation;
  if (verb === 'transcript') {
    readJob(id);
    const entry = roster.find(e => e.id === id) || backgroundTranscriptEntry(id);
    return transcriptAvailable(entry) ? { ok: true, sessionId: entry.sessionId }
      : { ok: false, error: 'transcript does not exist or is not available yet' };
  }
  const live = roster.find(e => e.kind === 'background' && e.id === id);
  let fresh;
  try { fresh = parseJobState(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8')); } catch {}
  const job = { ...live, ...fresh, id, state: fresh?.state || live?.state,
    sessionId: fresh?.sessionId || live?.sessionId };
  const evidence = verb === 'stop' ? undefined : await workerEvidence(job);
  if (gen !== generation) return { ok: false, error: 'background agent service changed while checking the worker; retry the action' };
  if (verb !== 'stop' && job.state === 'running' && evidence === 'unknown') {
    return { ok: false, error: `cannot tell whether job ${id}'s worker is running — not ${verb === 'rm' ? 'deleted' : 'respawned'}` };
  }
  if (verb !== 'stop' && isHostedJob(job, liveDescriptors(), evidence)) {
    return { ok: false, error: `cannot ${verb === 'rm' ? 'delete' : verb} a ${fresh?.state || live?.state || 'hosted'} session; stop it first` };
  }
  const result = await run([verb, id], { cwd: verb === 'rm' ? homeDir : cwdFor(id), timeout: VERB_TIMEOUT_MS });
  const ok = result.code === 0;
  const error = ok ? null : (stripShellNoise(result.stderr) || `claude ${verb} exited with ${result.code}`);
  await reconcile();
  return ok ? { ok: true } : { ok: false, error };
}

function backgroundTranscriptEntry(id) {
  const job = jobs.get(id);
  return job ? { sessionId: job.sessionId, transcriptPath: job.transcriptPath } : null;
}

async function dispatch(fields) {
  const built = dispatchArgs(fields);
  if (!built.ok) return { ok: false, error: built.error };
  if (!fs.existsSync(built.cwd)) return { ok: false, error: `project directory no longer exists: ${built.cwd}` };
  const refusal = dispatchRefusal(dispatchSettings(built.cwd) || {});
  if (refusal) return { ok: false, error: refusal };
  const result = await run(built.args, { cwd: built.cwd, timeout: VERB_TIMEOUT_MS });
  if (result.code !== 0) {
    return { ok: false, error: String(result.stderr).trim() || `claude --bg exited with ${result.code}` };
  }
  const id = parseDispatchOutput(result.stdout);
  await reconcile();
  return { ok: true, id };
}

function liveJobCheck(sessionId, { workerLiveness = new Map() } = {}) {
  const key = typeof sessionId === 'string' ? sessionId.toLowerCase() : '';
  if (!key) return { known: true, job: null };
  const sameSession = (sid) => typeof sid === 'string' && sid.toLowerCase() === key;
  const listed = (id) => roster.find(e => e.kind === 'background' && e.id === id) || null;
  const descriptors = liveDescriptors();
  let names;
  try { names = fs.readdirSync(jobsDir); } catch (err) {
    if (!(err && err.code === 'ENOENT')) return { known: false, reason: `cannot read ${jobsDir}: ${err && err.message}` };
    const cached = roster.find(e => isHostedJob(e, descriptors, workerLiveness.get(e.id)) && sameSession(e.sessionId));
    return { known: true, job: cached ? { id: cached.id, state: cached.state } : null };
  }
  let unknown = null;
  const read = new Set();
  for (const id of names) {
    if (!JOB_ID_RE.test(id)) continue;
    let parsed;
    try { parsed = parseJobState(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8')); } catch (err) {
      if (!(err && err.code === 'ENOENT')) unknown = unknown || `cannot read job ${id}`;
      continue;
    }
    read.add(id);
    if (!parsed) { unknown = unknown || `job ${id} has an unreadable state`; continue; }
    if (!parsed.state) { unknown = unknown || `job ${id} is in a state this version does not know`; continue; }
    const sid = parsed.sessionId || (listed(id) && listed(id).sessionId);
    if (!isHostedJob({ ...parsed, id, sessionId: sid }, descriptors, workerLiveness.get(id))) continue;
    if (!sid) { unknown = unknown || `live job ${id} does not name its session`; continue; }
    if (sameSession(sid)) return { known: true, job: { id, state: parsed.state } };
  }
  const cached = roster.find(e => !read.has(e.id) && isHostedJob(e, descriptors, workerLiveness.get(e.id)) && sameSession(e.sessionId));
  if (cached) return { known: true, job: { id: cached.id, state: cached.state } };
  return unknown ? { known: false, reason: unknown } : { known: true, job: null };
}

module.exports = {
  invalidateTranscripts,
  init, start, stop, onChange, onJobsChanged, getSnapshot, getCachedJobs, reconcile, runVerb, dispatch, liveJobCheck, conversationCheck, findRestoreJob,
  DEFAULT_JOBS_DIR, FLUSH_MS, MAX_JOBS, ROOT_CACHE_MAX, LIST_TIMEOUT_MS, VERB_TIMEOUT_MS,
};
