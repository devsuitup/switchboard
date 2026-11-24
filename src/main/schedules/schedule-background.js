// schedule-background.js — see .ai/contexts/schedule-runner.md ("Opt-in background runs")
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { parseJobState, parseDispatchOutput, stripShellNoise, dispatchRefusal, JOB_ID_RE } = require('../bg-agents/bg-agents-roster');

const BACKGROUND_RUN_LIMIT_MS = 60 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 30 * 1000;
const VERB_TIMEOUT_MS = 15 * 1000;
const MAX_RESUMED_RUNS = 64;
const MAX_RECORD_READS = 256;
const CLEANUP_ATTEMPTS_PER_START = 3;
const MAX_CLEANUP_ATTEMPTS = 9;
const RETRY_MS = 30 * 1000;
const MAX_RUN_SPAN_MS = 24 * 60 * 60 * 1000;
const EARLIEST_RUN_MS = Date.UTC(2024, 0, 1);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHASES = new Set(['running', 'cleanup', 'result']);
const CLEANUP_MODES = new Set(['stop', 'rm', 'none']);
const ANSI = /\x1b\[[0-9;]*m/g;

function backgroundRefusal({ sandbox, preLaunchCmd, shell, argv = [] }) {
  if (dispatchRefusal({ sandbox, preLaunchCmd }) || /(?:^|[/\\])wsl(?:\.exe)?$/i.test(shell || '')) {
    return 'Background sessions cannot run under this sandbox or wrapper; using headless for this run.';
  }
  if (argv.includes('--max-budget-usd')) return 'A max-budget-usd cap applies to headless runs only; using headless for this run.';
  return null;
}

function withDefaults(deps) {
  const homeDir = deps.homeDir || os.homedir();
  return {
    now: Date.now, pollMs: 500, retryMs: RETRY_MS, limitMs: BACKGROUND_RUN_LIMIT_MS, launchTimeoutMs: LAUNCH_TIMEOUT_MS,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    jobsDir: path.join(homeDir, '.claude', 'jobs'),
    writeResult: () => true, report: () => {}, track: () => {}, isJoined: () => false,
    ...deps, homeDir,
  };
}

function readJob(d, jobId) {
  try {
    const text = fs.readFileSync(path.join(d.jobsDir, jobId, 'state.json'), 'utf8');
    let raw = null;
    try { raw = JSON.parse(text); } catch {}
    return { job: parseJobState(text), raw };
  } catch (error) { return { missing: error.code === 'ENOENT' }; }
}

function timeOf(value) {
  return typeof value === 'number' ? value : Date.parse(value);
}

async function cleanupHold(run, d, stopped) {
  if (await d.isJoined(run.actualId, run.jobId)) return { done: true, message: 'left running, joined' };
  if (!run.actualId) return null;
  const { job, missing } = readJob(d, run.jobId);
  if (missing) return { done: true, message: stopped ? 'stopped; job already removed' : 'job already removed' };
  if (!job?.sessionId) return { done: false, message: `cleanup deferred: cannot confirm that job ${run.jobId} is still session ${run.actualId}` };
  if (job.sessionId !== run.actualId.toLowerCase()) {
    return { done: true, message: `unresolved: job ${run.jobId} now belongs to session ${job.sessionId}, not ${run.actualId}; ${stopped ? 'it was stopped but nothing was removed' : 'nothing was stopped or removed'}` };
  }
  return null;
}

async function cleanupOnce(run, d, mode) {
  if (mode === 'none') return { done: true, message: 'job already removed' };
  try {
    if (mode === 'stop') {
      const held = await cleanupHold(run, d, false);
      if (held) return held;
      const stopped = await d.runCommand(['stop', run.jobId], { cwd: fs.existsSync(run.cwd) ? run.cwd : d.homeDir, timeout: VERB_TIMEOUT_MS });
      if (stopped.code !== 0) return { done: false, message: `stop failed: ${stripShellNoise(stopped.stderr) || stopped.code}` };
      run.cleanupMode = 'rm';
    }
    const held = await cleanupHold(run, d, mode === 'stop');
    if (held) return held;
    const removed = await d.runCommand(['rm', run.jobId], { cwd: d.homeDir, timeout: VERB_TIMEOUT_MS });
    if (removed.code !== 0) return { done: false, message: `remove failed: ${stripShellNoise(removed.stderr) || removed.code}` };
    return { done: true, message: mode === 'stop' ? 'stopped and removed' : 'removed' };
  } catch (error) { return { done: false, message: `cleanup deferred: ${error.message}` }; }
}

async function cleanupJob(run, d) {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS_PER_START; attempt++) {
    const { done, message } = await cleanupOnce(run, d, run.cleanupMode || 'stop');
    run.cleanupAttempts = (run.cleanupAttempts || 0) + 1;
    run.cleanup = message;
    if (done) return true;
    if (run.cleanupAttempts >= MAX_CLEANUP_ATTEMPTS) {
      run.cleanup = `cleanup abandoned after ${run.cleanupAttempts} attempts: ${message}`;
      return true;
    }
    if (run.actualId) persistRun(run, d);
    d.log?.warn(`[schedule] ${run.runName}: cleanup of job ${run.jobId} failed (attempt ${run.cleanupAttempts} of ${MAX_CLEANUP_ATTEMPTS}): ${message}`);
    if (attempt < CLEANUP_ATTEMPTS_PER_START - 1) await d.wait(d.retryMs);
  }
  return false;
}

function recordPath(d, jobId) {
  return path.join(d.recordsDir, `${jobId}.json`);
}

function persistRun(run, d) {
  if (!d.recordsDir) return;
  try {
    fs.mkdirSync(d.recordsDir, { recursive: true });
    const tmp = recordPath(d, run.jobId) + '.tmp';
    const { seedPath: _seedPath, ...saved } = run;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...saved }) + '\n');
    fs.renameSync(tmp, recordPath(d, run.jobId));
    return true;
  } catch (error) {
    d.log?.warn(`[schedule] ${run.runName}: cannot keep the monitor record of job ${run.jobId}:`, error.message);
    return false;
  }
}

function forgetRun(run, d) {
  if (!d.recordsDir || !run.jobId) return;
  try { fs.unlinkSync(recordPath(d, run.jobId)); } catch {}
}

function publish(run, d) {
  const sessionId = run.actualId || run.sessionId;
  const { outcome, code = null, error = null, stderr = '' } = run.result;
  const { cleanup, warning } = run;
  let published = false;
  try {
    published = !!d.writeResult({ sessionId, filePath: run.filePath, name: run.name, slug: run.slug, manual: !!run.manual,
      dueMs: run.dueMs ?? null, startedAtMs: run.startedAtMs, outcome, code, signal: null, error, stderr,
      ...(run.jobId ? { jobId: run.jobId } : {}), ...(cleanup ? { cleanup } : {}), ...(warning ? { warning } : {}) });
  } catch (failure) { d.log?.warn(`[schedule] ${run.runName}: cannot record the result:`, failure.message); }
  if (published) forgetRun(run, d);
  else if (run.actualId && persistRun(run, d)) d.log?.warn(`[schedule] ${run.runName}: result not recorded; job ${run.jobId} keeps its record for the next start`);
  const line = `[schedule] ${run.runName}: ${outcome}${error ? ` — ${error}` : ''}${cleanup ? `; ${cleanup}` : ''}${warning ? `; ${warning}` : ''}`;
  if (outcome === 'exited' && code === 0) d.log?.info(line); else d.log?.error(line);
  try { d.report({ name: run.name, projectPath: run.cwd, sessionId, manual: !!run.manual, code, signal: null, outcome, error, stderr: stderr || error || '' }); }
  catch (failure) { d.log?.warn(`[schedule] ${run.runName}: cannot report the result:`, failure.message); }
  return published;
}

async function settle(run, d) {
  if (run.phase !== 'result') {
    run.phase = 'cleanup';
    if (run.actualId) persistRun(run, d);
    if (!await cleanupJob(run, d)) {
      d.log?.error(`[schedule] ${run.runName}: ${run.result.outcome}; ${run.cleanup}; job ${run.jobId} keeps its record and its cleanup is retried at the next start`);
      return { ...run.result, cleanup: run.cleanup, cleanupPending: true };
    }
    run.phase = 'result';
  }
  const published = publish(run, d);
  return { ...run.result, ...(run.cleanup ? { cleanup: run.cleanup } : {}), ...(run.warning ? { warning: run.warning } : {}),
    ...(published ? {} : { resultPending: true }) };
}

async function watchJob(run, d) {
  let missing = 0;
  for (;;) {
    const { job, raw, missing: gone } = readJob(d, run.jobId);
    missing = gone ? missing + 1 : 0;
    if (missing >= 2) return { outcome: 'job-missing', error: `Background job ${run.jobId} disappeared before it finished.`, mode: 'none' };
    if (job?.sessionId && job.sessionId !== run.actualId.toLowerCase()) {
      return { outcome: 'job-missing', error: `Background job ${run.jobId} now belongs to session ${job.sessionId}.`, mode: 'none' };
    }
    if (job && job.sessionId === run.actualId.toLowerCase()) {
      const terminalAt = timeOf(raw.lastTerminalAt ?? raw.updatedAt);
      const fresh = terminalAt > run.startedAtMs;
      if (fresh && (job.state === 'done' || job.state === 'failed')) {
        return job.state === 'done' ? { outcome: 'exited', code: 0 } : { outcome: 'exited', code: 1, stderr: job.detail || 'Background job failed' };
      }
      if (job.state === 'stopped' && (fresh || !Number.isFinite(terminalAt))) {
        return { outcome: 'stopped', error: `Background job ${run.jobId} was stopped before it finished.`, mode: 'rm' };
      }
    }
    if (d.now() >= run.deadline) {
      return { outcome: 'timed-out', error: `Background schedule timed out after ${Math.round((run.deadline - run.startedAtMs) / 60000)} minutes.` };
    }
    await d.wait(Math.max(0, Math.min(d.pollMs, run.deadline - d.now())));
  }
}

async function superviseBackgroundRun(run, deps, { warning } = {}) {
  const d = withDefaults(deps);
  if (warning) run.warning = warning;
  const lifetime = new EventEmitter();
  if (!run.phase || run.phase === 'running') {
    try { d.track(run.actualId, lifetime, run.cwd, run.runName, { jobId: run.jobId }); }
    catch (error) { d.log?.warn(`[schedule] ${run.runName}: cannot track job ${run.jobId}:`, error.message); }
    let details;
    try { details = await watchJob(run, d); }
    catch (error) { details = { outcome: 'spawn-error', error: error.message }; }
    const { mode = 'stop', ...result } = details;
    run.result = result;
    run.cleanupMode = mode;
  }
  const result = await settle(run, d);
  lifetime.emit('exit', result.code ?? null);
  return result;
}

function transferProvenance(run, seedRows, transcriptPath) {
  const rows = seedRows.map(row => ({ type: 'schedule-provenance', sessionId: run.actualId, cwd: row.cwd, slug: row.slug,
    scheduleSlug: row.scheduleSlug, timestamp: row.timestamp, prompt: row.message?.content }));
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.appendFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  if (path.resolve(run.seedPath) !== path.resolve(transcriptPath)) fs.unlinkSync(run.seedPath);
}

async function launchBackgroundSchedule(input, deps) {
  const d = withDefaults(deps);
  const startedAtMs = input.startedAtMs ?? d.now();
  const run = { jobId: null, actualId: null, sessionId: input.argv[input.argv.indexOf('--resume') + 1], cwd: input.cwd,
    name: input.name, runName: input.runName || input.name, filePath: input.filePath, slug: input.slug,
    manual: !!input.manual, dueMs: input.dueMs ?? null, seedPath: input.seedPath, startedAtMs, deadline: startedAtMs + d.limitMs };
  const fail = async ({ cleanup, ...result }, mode) => {
    run.result = result;
    if (mode) { run.cleanupMode = mode; run.phase = 'cleanup'; }
    else { run.phase = 'result'; run.cleanup = cleanup; }
    const settled = await settle(run, d);
    return { ok: false, sessionId: run.actualId || run.sessionId, jobId: run.jobId, outcome: settled.outcome, error: settled.error, cleanup: settled.cleanup };
  };
  let seedRows, prompt;
  try {
    seedRows = fs.readFileSync(run.seedPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    prompt = seedRows[0]?.message?.content;
  } catch (error) { return fail({ outcome: 'spawn-error', error: `Cannot read the schedule's first message: ${error.message}` }); }
  if (typeof prompt !== 'string' || !prompt.trim()) return fail({ outcome: 'spawn-error', error: 'The schedule\'s first message has no prompt.' });
  const command = ['--bg', '--name', run.name, ...input.argv.slice(4), '--', prompt];
  let launched;
  try { launched = await d.runCommand(command, { cwd: run.cwd, timeout: d.launchTimeoutMs, maxOutputBytes: 65536 }); }
  catch (error) { launched = { code: null, stdout: '', stderr: error.message }; }
  const launchError = stripShellNoise(launched.stderr) || `claude --bg exited with ${launched.code}`;
  run.jobId = parseDispatchOutput(String(launched.stdout || '').replace(ANSI, ''));
  if (!run.jobId) {
    const error = launched.code === 0 ? 'The background launcher did not identify its job.' : launchError;
    const cleanup = 'unresolved launch: no job id in the output of claude --bg; no job was stopped or removed';
    d.log?.warn(`[schedule] ${run.runName}: ${cleanup}`);
    return fail({ outcome: 'spawn-error', error, cleanup });
  }
  const identityDeadline = Math.min(run.deadline, d.now() + d.launchTimeoutMs);
  for (;;) {
    const { job } = readJob(d, run.jobId);
    if (job?.sessionId && job.sessionId.slice(0, 8) === run.jobId) { run.actualId = job.sessionId; break; }
    if (d.now() >= identityDeadline) return fail({ outcome: 'timed-out', error: 'Background schedule timed out waiting for its session identity.' }, 'stop');
    await d.wait(Math.max(0, Math.min(d.pollMs, identityDeadline - d.now())));
  }
  if (launched.code !== 0) return fail({ outcome: 'spawn-error', error: launchError }, 'stop');
  const { seedPath, ...persisted } = run;
  persisted.phase = 'running';
  persistRun(persisted, d);
  let warning;
  try {
    const listed = readJob(d, run.jobId).job?.transcriptPath;
    const own = listed && path.basename(listed).toLowerCase() === `${run.actualId}.jsonl` ? listed : null;
    transferProvenance(run, seedRows, own || path.join(path.dirname(seedPath), `${run.actualId}.jsonl`));
  } catch (error) {
    warning = `schedule provenance not recorded: ${error.message}`;
    d.log?.warn(`[schedule] ${run.runName}: ${warning}`);
  }
  return { ok: true, sessionId: run.actualId, jobId: run.jobId, completion: superviseBackgroundRun(persisted, d, { warning }) };
}

const nonEmpty = value => typeof value === 'string' && value.length > 0;

function validRun(run, file, nowMs) {
  if (!run || typeof run !== 'object' || Array.isArray(run) || run.v !== 1) return false;
  if (!nonEmpty(run.jobId) || !JOB_ID_RE.test(run.jobId) || file !== `${run.jobId}.json`) return false;
  if (!nonEmpty(run.actualId) || !UUID_RE.test(run.actualId.toLowerCase()) || run.actualId.slice(0, 8).toLowerCase() !== run.jobId) return false;
  if (!nonEmpty(run.cwd) || !nonEmpty(run.name) || !nonEmpty(run.filePath) || !nonEmpty(run.slug)) return false;
  if (!Number.isFinite(run.startedAtMs) || run.startedAtMs < EARLIEST_RUN_MS || run.startedAtMs > nowMs + MAX_RUN_SPAN_MS) return false;
  if (!Number.isFinite(run.deadline) || run.deadline <= run.startedAtMs || run.deadline - run.startedAtMs > MAX_RUN_SPAN_MS) return false;
  const phase = run.phase ?? 'running';
  if (!PHASES.has(phase)) return false;
  if (run.cleanupMode !== undefined && !CLEANUP_MODES.has(run.cleanupMode)) return false;
  if (run.cleanupAttempts !== undefined && !(Number.isInteger(run.cleanupAttempts) && run.cleanupAttempts >= 0)) return false;
  return phase === 'running' || (!!run.result && typeof run.result === 'object' && nonEmpty(run.result.outcome));
}

function setAside(d, file) {
  const from = path.join(d.recordsDir, file);
  try { fs.renameSync(from, `${from}.corrupt-${d.now()}`); }
  catch (error) { d.log?.warn(`[schedule] Cannot set aside the background run record ${file}:`, error.message); }
}

async function discoverBackgroundRuns(deps, claim = () => () => {}) {
  const d = withDefaults(deps);
  let names;
  try { names = (await fs.promises.readdir(d.recordsDir)).filter(name => /^[0-9a-f]{8}\.json$/.test(name)).sort().slice(0, MAX_RECORD_READS); }
  catch { return []; }
  const runs = [];
  for (const file of names) {
    if (runs.length >= MAX_RESUMED_RUNS) break;
    let text;
    try { text = await fs.promises.readFile(path.join(d.recordsDir, file), 'utf8'); }
    catch (error) { d.log?.warn(`[schedule] Cannot read the background run record ${file}:`, error.message); continue; }
    let run;
    try { run = JSON.parse(text); } catch {}
    if (!validRun(run, file, d.now())) {
      d.log?.warn(`[schedule] Ignoring an unreadable background run record: ${file}; it is set aside`);
      setAside(d, file);
      continue;
    }
    const { v: _v, ...saved } = run;
    saved.runName = saved.runName || saved.name;
    saved.phase = saved.phase || 'running';
    let release = () => {};
    try {
      const claimed = claim(saved);
      if (claimed === false) continue;
      release = claimed || release;
    } catch (error) { d.log?.warn(`[schedule] ${saved.runName}: cannot reserve its schedule:`, error.message); }
    d.log?.info(`[schedule] ${saved.runName}: resuming the monitor of background job ${saved.jobId} (${saved.phase})`);
    runs.push({ run: saved, release });
  }
  return runs;
}

function resumeBackgroundRuns(deps, claim) {
  const discovered = discoverBackgroundRuns(deps, claim);
  const lifetimes = discovered.then(runs => Promise.all(runs.map(({ run, release }) => superviseBackgroundRun(run, deps).finally(release))));
  lifetimes.discovered = discovered.then(runs => runs.length, () => 0);
  return lifetimes;
}

module.exports = { launchBackgroundSchedule, resumeBackgroundRuns, discoverBackgroundRuns, backgroundRefusal, BACKGROUND_RUN_LIMIT_MS, LAUNCH_TIMEOUT_MS };
