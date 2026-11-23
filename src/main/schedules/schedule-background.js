'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { encodeProjectPath } = require('../../../encode-project-path');

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backgroundRefusal({ sandbox, remoteAlias, shell, wrapper }) {
  if (remoteAlias) return 'Background schedules are local only; using headless for this run.';
  if (sandbox || wrapper || /(?:^|[/\\])wsl(?:\.exe)?$/i.test(shell || '')) return 'Background sessions cannot run under this sandbox or wrapper; using headless for this run.';
  return null;
}

async function launchBackgroundSchedule({ argv, cwd, name, sessionId, prompt, timeoutMs }, deps) {
  const { runCommand, isJoined, track, now = Date.now, pollMs = 500,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    jobsDir = path.join(os.homedir(), '.claude', 'jobs'),
    projectsDir = path.join(os.homedir(), '.claude', 'projects'),
    seedPath = path.join(projectsDir, encodeProjectPath(cwd), `${sessionId}.jsonl`) } = deps;
  const startedAt = now();
  const limit = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const deadline = startedAt + limit;
  const command = ['--bg', '--name', name, ...argv.slice(4), '--', prompt];
  const launched = await runCommand(command, { cwd, timeout: Math.min(limit, 30000), maxOutputBytes: 65536 });
  const jobId = /backgrounded\s*·\s*([0-9a-f]{8})\s*·/i.exec((launched.stdout || '').replace(/\x1b\[[0-9;]*m/g, ''))?.[1]?.toLowerCase();
  if (!jobId) return { ok: false, error: launched.stderr || 'Background launcher did not identify its job.' };
  let actualId;
  const readState = () => {
    try { return JSON.parse(fs.readFileSync(path.join(jobsDir, jobId, 'state.json'), 'utf8')); }
    catch { return null; }
  };
  const cleanup = async () => {
    try {
      if (await isJoined(actualId, jobId)) return 'left running, joined';
      const stopped = await runCommand(['stop', jobId], { cwd, timeout: 15000 });
      if (stopped.code !== 0) return `stop failed: ${stopped.stderr || stopped.code}`;
      if (await isJoined(actualId, jobId)) return 'left running, joined';
      const removed = await runCommand(['rm', jobId], { cwd, timeout: 15000 });
      return removed.code === 0 ? 'stopped and removed' : `remove failed: ${removed.stderr || removed.code}`;
    } catch (error) { return `cleanup deferred: ${error.message}`; }
  };
  try {
    for (;;) {
      const state = readState();
      if (UUID.test(state?.sessionId || '') && state.sessionId.slice(0, 8).toLowerCase() === jobId) {
        actualId = state.sessionId;
        break;
      }
      if (now() >= deadline) throw Object.assign(new Error('Background schedule timed out waiting for its session identity.'), { outcome: 'timed-out' });
      await wait(Math.min(pollMs, deadline - now()));
    }
    if (launched.code !== 0) throw new Error(launched.stderr || 'Background launch failed.');
    const seed = fs.readFileSync(seedPath, 'utf8').trim().split('\n').map(line => {
      const row = JSON.parse(line);
      return { type: 'schedule-provenance', sessionId: actualId, cwd: row.cwd, slug: row.slug,
        scheduleSlug: row.scheduleSlug, timestamp: row.timestamp, prompt: row.message?.content };
    });
    const destination = path.join(projectsDir, encodeProjectPath(cwd), `${actualId}.jsonl`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.appendFileSync(destination, seed.map(row => JSON.stringify(row)).join('\n') + '\n');
    if (path.resolve(seedPath) !== path.resolve(destination)) fs.unlinkSync(seedPath);
  } catch (error) {
    return { ok: false, sessionId: actualId, jobId, outcome: error.outcome, error: error.message, cleanup: await cleanup() };
  }
  const lifetime = new EventEmitter();
  track(actualId, lifetime, cwd, name, { jobId });
  const completion = (async () => {
    let result;
    try {
      for (;;) {
        const state = readState();
        const terminalAt = Date.parse(state?.lastTerminalAt || state?.updatedAt);
        if (state?.sessionId === actualId && ['done', 'failed'].includes(state.state) && terminalAt > startedAt) {
          result = { outcome: 'exited', code: state.state === 'done' ? 0 : 1, stderr: state.state === 'failed' ? state.detail || 'Background job failed' : '' };
          break;
        }
        if (now() >= deadline) {
          result = { outcome: 'timed-out', code: null, error: `Background schedule timed out after ${limit} ms.` };
          break;
        }
        await wait(Math.min(pollMs, deadline - now()));
      }
    } catch (error) { result = { outcome: 'spawn-error', error: error.message }; }
    result.cleanup = await cleanup();
    lifetime.emit('exit', result.code);
    return result;
  })();
  return { ok: true, sessionId: actualId, jobId, completion };
}

module.exports = { launchBackgroundSchedule, backgroundRefusal, DEFAULT_TIMEOUT_MS };
