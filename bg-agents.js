// see .ai/contexts/bg-agents.md
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseJobState, parseCliList, mergeRoster, dispatchArgs, parseDispatchOutput, stripShellNoise, JOB_ID_RE,
  dispatchRefusal, isLiveJobState,
} = require('./bg-agents-roster');
const { resolveProjectRoots, projectRootFromPattern, worktreeRootFromPattern } = require('./project-root');

const DEFAULT_JOBS_DIR = path.join(os.homedir(), '.claude', 'jobs');
const FLUSH_MS = 250;
const MAX_JOBS = 200;
const LIST_TIMEOUT_MS = 20000;
const VERB_TIMEOUT_MS = 60000;
const VERBS = new Set(['stop', 'respawn', 'rm']);
const ROOT_CACHE_MAX = 500;
const ROOT_CONCURRENCY = 4;

let jobsDir = DEFAULT_JOBS_DIR;
let homeDir = os.homedir();
let log = { info() {}, warn() {}, error() {}, debug() {} };
let runClaude = null;
let cliSessionState = null;
let makeIsOwnPid = () => () => false;
let isAttachedHere = () => false;
let resolveRoots = resolveProjectRoots;
let dispatchSettings = () => ({});
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

function init(ctx) {
  stop();
  jobsDir = ctx.jobsDir || DEFAULT_JOBS_DIR;
  homeDir = ctx.homeDir || os.homedir();
  log = ctx.log || log;
  runClaude = ctx.runClaude;
  cliSessionState = ctx.cliSessionState;
  makeIsOwnPid = ctx.makeIsOwnPid || (() => () => false);
  isAttachedHere = ctx.isAttachedHere || (() => false);
  resolveRoots = ctx.resolveProjectRoots || resolveProjectRoots;
  dispatchSettings = ctx.dispatchSettings || (() => ({}));
}

function onChange(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() {
  return { roster, daemonReachable };
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
  roster = mergeRoster({
    cli: daemonReachable ? cliList : null,
    jobs,
    descriptors,
    isOwnPid: makeIsOwnPid(),
    isAttachedHere,
  }).map(e => ({ ...e, ...rootsFor(e.cwd) }));
  if (onlyIfChanged && JSON.stringify(previous) === JSON.stringify(roster)) return;
  emit();
  resolveMissingRoots(roster);
}

function scheduleRebuild() {
  if (!started || flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; rebuild({ onlyIfChanged: true }); }, FLUSH_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function readJob(id) {
  let text;
  try { text = fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8'); } catch { return; }
  const job = parseJobState(text);
  if (job) jobs.set(id, job);
  else log.debug(`[bg-agents] ${id}/state.json unreadable, keeping the previous value`);
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
  if (unsubscribeDescriptors) { unsubscribeDescriptors(); unsubscribeDescriptors = null; }
  listeners.clear();
  cliList = null;
  daemonReachable = false;
  roster = [];
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
  const entry = roster.find(e => e.kind === 'background' && e.id === id);
  if (entry && entry.cwd && fs.existsSync(entry.cwd)) return entry.cwd;
  return homeDir;
}

async function runVerb(verb, id) {
  if (!VERBS.has(verb)) return { ok: false, error: `unknown verb: ${String(verb)}` };
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) return { ok: false, error: 'invalid background session id' };
  const live = roster.find(e => e.kind === 'background' && e.id === id);
  if (verb !== 'stop' && live && isLiveJobState(live.state)) {
    return { ok: false, error: `cannot ${verb} a ${live.state} session; stop it first` };
  }
  const result = await run([verb, id], { cwd: verb === 'rm' ? homeDir : cwdFor(id), timeout: VERB_TIMEOUT_MS });
  const ok = result.code === 0;
  const error = ok ? null : (stripShellNoise(result.stderr) || `claude ${verb} exited with ${result.code}`);
  await reconcile();
  return ok ? { ok: true } : { ok: false, error };
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

function liveJobCheck(sessionId) {
  const key = typeof sessionId === 'string' ? sessionId.toLowerCase() : '';
  if (!key) return { known: true, job: null };
  const sameSession = (sid) => typeof sid === 'string' && sid.toLowerCase() === key;
  const fromRoster = roster.find(e => e.kind === 'background' && isLiveJobState(e.state) && sameSession(e.sessionId));
  if (fromRoster) return { known: true, job: { id: fromRoster.id, state: fromRoster.state } };
  let names;
  try { names = fs.readdirSync(jobsDir); } catch (err) {
    if (err && err.code === 'ENOENT') return { known: true, job: null };
    return { known: false, reason: `cannot read ${jobsDir}: ${err && err.message}` };
  }
  let unknown = null;
  for (const id of names) {
    if (!JOB_ID_RE.test(id)) continue;
    let parsed;
    try { parsed = parseJobState(fs.readFileSync(path.join(jobsDir, id, 'state.json'), 'utf8')); } catch (err) {
      if (!(err && err.code === 'ENOENT')) unknown = unknown || `cannot read job ${id}`;
      continue;
    }
    if (!parsed) { unknown = unknown || `job ${id} has an unreadable state`; continue; }
    if (!isLiveJobState(parsed.state)) continue;
    const listed = roster.find(e => e.kind === 'background' && e.id === id);
    const sid = parsed.sessionId || (listed && listed.sessionId);
    if (!sid) { unknown = unknown || `live job ${id} does not name its session`; continue; }
    if (sameSession(sid)) return { known: true, job: { id, state: parsed.state } };
  }
  return unknown ? { known: false, reason: unknown } : { known: true, job: null };
}

module.exports = {
  init, start, stop, onChange, getSnapshot, reconcile, runVerb, dispatch, liveJobCheck,
  DEFAULT_JOBS_DIR, FLUSH_MS, MAX_JOBS, ROOT_CACHE_MAX, LIST_TIMEOUT_MS, VERB_TIMEOUT_MS,
};
