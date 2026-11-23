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
const MAX_JOB_SCAN = 200;
const MAX_RESUMED_RUNS = 64;
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
    now: Date.now, pollMs: 500, limitMs: BACKGROUND_RUN_LIMIT_MS, launchTimeoutMs: LAUNCH_TIMEOUT_MS,
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    jobsDir: path.join(homeDir, '.claude', 'jobs'),
    writeResult: () => {}, report: () => {}, track: () => {}, isJoined: () => false,
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

function samePath(a, b) {
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

function findLaunchedJob(d, { cwd, name, since }) {
  let names;
  try { names = fs.readdirSync(d.jobsDir).filter(id => JOB_ID_RE.test(id)).slice(0, MAX_JOB_SCAN); } catch { return null; }
  const found = names.filter(id => {
    const { job, raw } = readJob(d, id);
    if (!job || job.name !== name) return false;
    if (typeof raw.cwd === 'string' && !samePath(raw.cwd, cwd)) return false;
    let created = timeOf(raw.createdAt);
    if (!Number.isFinite(created)) {
      try { created = fs.statSync(path.join(d.jobsDir, id)).birthtimeMs; } catch { return false; }
    }
    return created >= since;
  });
  return found.length === 1 ? found[0] : null;
}

async function cleanupJob(run, d, mode = 'stop') {
  if (mode === 'none') return 'job already removed';
  try {
    if (await d.isJoined(run.actualId, run.jobId)) return 'left running, joined';
    if (mode === 'stop') {
      const stopped = await d.runCommand(['stop', run.jobId], { cwd: fs.existsSync(run.cwd) ? run.cwd : d.homeDir, timeout: VERB_TIMEOUT_MS });
      if (stopped.code !== 0) return `stop failed: ${stripShellNoise(stopped.stderr) || stopped.code}`;
      if (await d.isJoined(run.actualId, run.jobId)) return 'left running, joined';
    }
    const removed = await d.runCommand(['rm', run.jobId], { cwd: d.homeDir, timeout: VERB_TIMEOUT_MS });
    if (removed.code !== 0) return `remove failed: ${stripShellNoise(removed.stderr) || removed.code}`;
    return mode === 'stop' ? 'stopped and removed' : 'removed';
  } catch (error) { return `cleanup deferred: ${error.message}`; }
}

function recordPath(d, jobId) {
  return path.join(d.recordsDir, `${jobId}.json`);
}

function persistRun(run, d) {
  if (!d.recordsDir) return;
  try {
    fs.mkdirSync(d.recordsDir, { recursive: true });
    const tmp = recordPath(d, run.jobId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...run }) + '\n');
    fs.renameSync(tmp, recordPath(d, run.jobId));
  } catch (error) { d.log?.warn(`[schedule] ${run.runName}: cannot keep the monitor record of job ${run.jobId}:`, error.message); }
}

function forgetRun(run, d) {
  if (!d.recordsDir || !run.jobId) return;
  try { fs.unlinkSync(recordPath(d, run.jobId)); } catch {}
}

function finish(run, details, d) {
  const sessionId = run.actualId || run.sessionId;
  const { outcome, code = null, error = null, stderr = '', cleanup, warning } = details;
  try {
    d.writeResult({ sessionId, filePath: run.filePath, name: run.name, slug: run.slug, manual: !!run.manual,
      dueMs: run.dueMs ?? null, startedAtMs: run.startedAtMs, outcome, code, signal: null, error, stderr,
      ...(run.jobId ? { jobId: run.jobId } : {}), ...(cleanup ? { cleanup } : {}), ...(warning ? { warning } : {}) });
  } catch (failure) { d.log?.warn(`[schedule] ${run.runName}: cannot record the result:`, failure.message); }
  forgetRun(run, d);
  const line = `[schedule] ${run.runName}: ${outcome}${error ? ` — ${error}` : ''}${cleanup ? `; ${cleanup}` : ''}${warning ? `; ${warning}` : ''}`;
  if (outcome === 'exited' && code === 0) d.log?.info(line); else d.log?.error(line);
  try { d.report({ name: run.name, projectPath: run.cwd, sessionId, manual: !!run.manual, code, signal: null, outcome, error, stderr: stderr || error || '' }); }
  catch (failure) { d.log?.warn(`[schedule] ${run.runName}: cannot report the result:`, failure.message); }
}

async function watchJob(run, d) {
  let missing = 0;
  for (;;) {
    const { job, raw, missing: gone } = readJob(d, run.jobId);
    missing = gone ? missing + 1 : 0;
    if (missing >= 2) return { outcome: 'job-missing', error: `Background job ${run.jobId} disappeared before it finished.`, mode: 'none' };
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
  const lifetime = new EventEmitter();
  try { d.track(run.actualId, lifetime, run.cwd, run.runName, { jobId: run.jobId }); }
  catch (error) { d.log?.warn(`[schedule] ${run.runName}: cannot track job ${run.jobId}:`, error.message); }
  let details;
  try { details = await watchJob(run, d); }
  catch (error) { details = { outcome: 'spawn-error', error: error.message }; }
  const { mode = 'stop', ...result } = details;
  result.cleanup = await cleanupJob(run, d, mode);
  if (warning) result.warning = warning;
  finish(run, result, d);
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
  const fail = async (details, mode) => {
    if (mode) details.cleanup = await cleanupJob(run, d, mode);
    finish(run, details, d);
    return { ok: false, sessionId: run.actualId || run.sessionId, jobId: run.jobId, outcome: details.outcome, error: details.error, cleanup: details.cleanup };
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
    run.jobId = findLaunchedJob(d, { cwd: run.cwd, name: run.name, since: startedAtMs });
    const error = launched.code === 0 ? 'The background launcher did not identify its job.' : launchError;
    return fail({ outcome: 'spawn-error', error }, run.jobId ? 'stop' : null);
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

function validRun(run, file) {
  return run && run.v === 1 && typeof run.jobId === 'string' && JOB_ID_RE.test(run.jobId) && file === `${run.jobId}.json`
    && typeof run.actualId === 'string' && run.actualId.slice(0, 8).toLowerCase() === run.jobId
    && typeof run.cwd === 'string' && typeof run.name === 'string' && typeof run.filePath === 'string'
    && Number.isFinite(run.startedAtMs) && Number.isFinite(run.deadline);
}

async function resumeBackgroundRuns(deps, claim = () => () => {}) {
  const d = withDefaults(deps);
  let names;
  try { names = (await fs.promises.readdir(d.recordsDir)).filter(name => /^[0-9a-f]{8}\.json$/.test(name)).slice(0, MAX_RESUMED_RUNS); }
  catch { return []; }
  const runs = [];
  for (const file of names) {
    let run;
    try { run = JSON.parse(await fs.promises.readFile(path.join(d.recordsDir, file), 'utf8')); } catch {}
    if (!validRun(run, file)) { d.log?.warn(`[schedule] Ignoring an unreadable background run record: ${file}`); continue; }
    const { v: _v, ...saved } = run;
    saved.runName = saved.runName || saved.name;
    d.log?.info(`[schedule] ${saved.runName}: resuming the monitor of background job ${saved.jobId}`);
    const release = claim(saved);
    runs.push(superviseBackgroundRun(saved, d).finally(release));
  }
  return Promise.all(runs);
}

module.exports = { launchBackgroundSchedule, resumeBackgroundRuns, backgroundRefusal, BACKGROUND_RUN_LIMIT_MS, LAUNCH_TIMEOUT_MS };
