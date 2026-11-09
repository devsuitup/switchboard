'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { renameWithRetry } = require('../shared/atomic-write');
const { scheduleStateKey } = require('./schedule-runner');

const RESULT_NAME = /^([0-9a-f]{16})-(\d+)-([0-9a-f-]{36})\.json$/;
const PUBLICATION_NAME = /^(?:([0-9a-f]{16})-\d+-[0-9a-f-]{36}\.json\.lock|\.([0-9a-f]{16})-\d+-[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp)$/;

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
  const staleBefore = Date.now() - 10 * 60 * 1000;
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

function writeScheduleRunResult(runsDir, input, log, { rename = fs.renameSync } = {}) {
  let tmp, lock, lockFd;
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
    fs.mkdirSync(runsDir, { recursive: true });
    const destination = path.join(runsDir, filename);
    lock = destination + '.lock';
    try { lockFd = fs.openSync(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      log.info(`[schedule] Result already claimed for ${sessionId}; keeping the first`);
      return;
    }
    if (fs.existsSync(destination)) {
      log.info(`[schedule] Result already recorded for ${sessionId}; keeping the first`);
      return;
    }
    tmp = path.join(runsDir, `.${filename}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { flag: 'wx' });
    renameWithRetry(tmp, destination, { rename });
    tmp = null;
    pruneScheduleRunResults(runsDir, key);
  } catch (error) {
    log.warn(`[schedule] Cannot record result for ${input.sessionId}:`, error.message);
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lock); } catch {}
    }
  }
}

function validRecord(record, match) {
  return record && record.v === 1 && record.sessionId === match[3]
    && typeof record.file === 'string' && scheduleStateKey({ filePath: record.file }) === match[1]
    && typeof record.name === 'string' && typeof record.slug === 'string' && typeof record.manual === 'boolean'
    && (record.dueMs === null || Number.isFinite(record.dueMs))
    && typeof record.startedAt === 'string' && Date.parse(record.startedAt) === Number(match[2])
    && typeof record.endedAt === 'string' && Number.isFinite(Date.parse(record.endedAt))
    && ['exited', 'signal', 'spawn-error', 'refused'].includes(record.outcome)
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

module.exports = { scheduleRunsDir, classifyRunExit, writeScheduleRunResult, pruneScheduleRunResults, readScheduleRunResults };
