'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scheduleStateKey } = require('./schedule-runner');

const RESULT_NAME = /^([0-9a-f]{16})-(\d+)-([0-9a-f-]{36})\.json$/;
const PUBLICATION_NAME = /^(?:([0-9a-f]{16})-\d+-[0-9a-f-]{36}\.json\.lock|\.([0-9a-f]{16})-\d+-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp)$/;
const STALE_PUBLICATION_MS = 10 * 60 * 1000;

function scheduleRunsDir(dataDir) {
  return path.join(dataDir, 'schedule-runs');
}

function classifyRunExit({ code, sandbox, stderr }) {
  if (code === 0) return null;
  const sandboxPath = /^\s*claude-sandbox: claude not found in PATH(?:\s|$)/m.test(stderr || '');
  const sandboxFailure = sandbox && (/^\s*bwrap:/m.test(stderr || '') ||
    code === 125 && /^\s*claude-sandbox:(?! claude not found in PATH(?:\s|$))/m.test(stderr || ''));
  const missingClaude = !sandboxFailure && (sandboxPath || code === 127 || [
    /^\s*spawn\s+claude\s+ENOENT\b/im,
    /^\s*(?:(?:\/[^\s:]+\/)?(?:bash|sh|dash|ksh|zsh)(?::\s*(?:line\s+)?\d+)?:\s*)?claude:\s*(?:command not found|not found)\s*$/im,
    /^\s*zsh:\s*(?:\d+:\s*)?command not found: claude\s*$/im,
    /^\s*fish: Unknown command: claude\s*$/im,
    /^\s*(?:\/[^\s:]+\/)?env: (?:['"‘]claude['"’]|claude): No such file or directory\s*$/im,
    /^\s*['"]claude['"] is not recognized as an internal or external command\b/im,
    /^\s*claude\s*:\s*The term ['"]claude['"] is not recognized as (?:a|the) name of a cmdlet\b/im,
    /^\s*\+?\s*CategoryInfo\s*:\s*ObjectNotFound:\s*\(claude:String\)\s*\[\],\s*CommandNotFoundException\b/im,
  ].some(pattern => pattern.test(stderr || '')));
  return missingClaude ? 'claude-path' : sandboxFailure ? 'sandbox' : 'exit';
}

function pruneScheduleRunResults(runsDir, key, keep = 20) {
  let files;
  try { files = fs.readdirSync(runsDir); } catch { return; }
  const staleBefore = Date.now() - STALE_PUBLICATION_MS;
  for (const file of files) {
    const match = PUBLICATION_NAME.exec(file);
    if (!match || (match[1] || match[2]) !== key) continue;
    try {
      const filename = path.join(runsDir, file);
      if (fs.statSync(filename).mtimeMs < staleBefore) fs.unlinkSync(filename);
    } catch {}
  }
  const own = files.map(file => ({ file, match: RESULT_NAME.exec(file) }))
    .filter(({ match }) => match && match[1] === key)
    .sort((a, b) => Number(b.match[2]) - Number(a.match[2]) || b.file.localeCompare(a.file));
  for (const { file } of own.slice(keep)) {
    try { fs.unlinkSync(path.join(runsDir, file)); } catch {}
  }
}

const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EPERM', 'EISDIR', 'EXDEV', 'EINVAL', 'ENOSYS']);
const loggedFailures = new Map();
const failureListeners = new Set();
let latestFailure = null;

function setLatestFailure(failure) {
  if (latestFailure === failure) return;
  latestFailure = failure;
  for (const listener of failureListeners) { try { listener(failure); } catch {} }
}

function onResultFailureChange(listener) {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

function createExclusive(file, text) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(file); } catch {}
    throw error;
  }
  fs.closeSync(fd);
}

function createNew(file, text) {
  try { createExclusive(file, text); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

function publishNew(tmp, destination, text, link) {
  try { link(tmp, destination); return true; }
  catch (error) {
    if (error.code === 'EEXIST') return false;
    if (LINK_UNSUPPORTED.has(error.code)) return createNew(destination, text);
    throw error;
  }
}

function resultFailure(destination, error, log, sessionId) {
  const failure = { path: destination || null, code: error.code || null, message: error.message, at: Date.now() };
  setLatestFailure(failure);
  const key = destination || '';
  if (loggedFailures.get(key) !== failure.message) {
    loggedFailures.set(key, failure.message);
    log.warn(`[schedule] Cannot record result for ${sessionId}:`, failure.message);
  }
  return { ok: false, error: failure };
}

function publishScheduleRunResult(runsDir, input, log, { link = fs.linkSync } = {}) {
  let tmp, destination;
  try {
    const { sessionId, filePath, name, slug, manual = false, dueMs = null, startedAtMs,
      endedAtMs = Date.now(), outcome, code = null, signal = null, error = null } = input;
    const key = scheduleStateKey({ filePath });
    const filename = `${key}-${startedAtMs}-${sessionId}.json`;
    if (!RESULT_NAME.test(filename)) throw new Error('Invalid schedule run identity');
    const record = { v: 1, sessionId, file: filePath, name, slug, manual, dueMs,
      startedAt: new Date(startedAtMs).toISOString(), endedAt: new Date(endedAtMs).toISOString(), outcome,
      exitCode: Number.isInteger(code) ? code : null, signal: signal || null,
      failure: outcome === 'exited' || outcome === 'signal' ? classifyRunExit(input) : null, error };
    if (typeof input.jobId === 'string') record.jobId = input.jobId;
    if (typeof input.cleanup === 'string') record.cleanup = input.cleanup;
    if (typeof input.warning === 'string') record.warning = input.warning;
    const text = JSON.stringify(record) + '\n';
    fs.mkdirSync(runsDir, { recursive: true });
    destination = path.join(runsDir, filename);
    tmp = path.join(runsDir, `.${filename}.${crypto.randomUUID()}.tmp`);
    createExclusive(tmp, text);
    if (publishNew(tmp, destination, text, link)) pruneScheduleRunResults(runsDir, key);
    else {
      let valid = false;
      try { valid = validRecord(JSON.parse(fs.readFileSync(destination, 'utf8')), RESULT_NAME.exec(filename)); } catch {}
      if (!valid) {
        return resultFailure(destination, Object.assign(new Error(`The result file ${destination} is unreadable; remove or fix it`),
          { code: 'EBADRESULT' }), log, sessionId);
      }
      log.info(`[schedule] Result already recorded for ${sessionId}; keeping the first`);
    }
    loggedFailures.delete(destination);
    setLatestFailure(null);
    return { ok: true };
  } catch (error) {
    return resultFailure(destination, error, log, input.sessionId);
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

function writeScheduleRunResult(runsDir, input, log, options) {
  return publishScheduleRunResult(runsDir, input, log, options).ok;
}

function latestResultFailure() {
  return latestFailure;
}

function validRecord(record, match) {
  return record && record.v === 1 && record.sessionId === match[3]
    && typeof record.file === 'string' && scheduleStateKey({ filePath: record.file }) === match[1]
    && typeof record.name === 'string' && typeof record.slug === 'string' && typeof record.manual === 'boolean'
    && (record.dueMs === null || Number.isFinite(record.dueMs))
    && typeof record.startedAt === 'string' && Date.parse(record.startedAt) === Number(match[2])
    && typeof record.endedAt === 'string' && Number.isFinite(Date.parse(record.endedAt))
    && ['exited', 'signal', 'spawn-error', 'refused', 'timed-out', 'stopped', 'job-missing'].includes(record.outcome)
    && (record.outcome !== 'signal' || typeof record.signal === 'string' && record.signal.length > 0)
    && (!['refused', 'spawn-error'].includes(record.outcome) || typeof record.error === 'string')
    && (record.outcome !== 'exited' || Number.isInteger(record.exitCode))
    && (record.exitCode === null || Number.isInteger(record.exitCode))
    && (record.signal === null || typeof record.signal === 'string')
    && [null, 'exit', 'claude-path', 'sandbox'].includes(record.failure)
    && (record.error === null || typeof record.error === 'string');
}

function readScheduleRunResults(runsDir, sessionIds) {
  const results = new Map();
  if (!runsDir) return results;
  let files;
  try { files = fs.readdirSync(runsDir); }
  catch (error) { if (error.code === 'ENOENT') return results; throw error; }
  const requested = new Set(sessionIds);
  const selected = files.map(file => ({ file, match: RESULT_NAME.exec(file) }))
    .filter(({ match }) => match && requested.has(match[3]))
    .sort((a, b) => Number(b.match[2]) - Number(a.match[2]) || b.file.localeCompare(a.file));
  for (const { file, match } of selected) {
    if (results.has(match[3])) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'));
      if (!validRecord(record, match)) throw new Error('Invalid schedule run result');
      results.set(match[3], record);
    } catch { results.set(match[3], { unreadable: true }); }
  }
  return results;
}

module.exports = { scheduleRunsDir, classifyRunExit, writeScheduleRunResult, publishScheduleRunResult, latestResultFailure, onResultFailureChange,
  pruneScheduleRunResults, readScheduleRunResults };
