'use strict';

const nativeFs = require('fs');
const path = require('path');
const { extractVerifiedCwdFromJsonl, resolveWorktreePath } = require('../../../derive-project-path');
const { normalizeProjectPath } = require('../shared/normalize-project-path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILENAME_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNAVAILABLE = 'session action not implemented in this build';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);

function isVersioned(trigger) {
  return own(trigger, 'version') || own(trigger, 'action');
}

function validateTrigger(trigger, stem, evidence = {}) {
  if (!object(trigger)) return 'trigger must be an object';
  if (trigger.version !== 1) return 'unsupported version';
  if (trigger.action !== 'open' && trigger.action !== 'stop') return 'unsupported action';
  if (!FILENAME_UUID.test(stem)) return 'trigger filename must be a lowercase UUID';
  const hasId = own(trigger, 'sessionId');
  const hasNew = own(trigger, 'new');
  if (trigger.action === 'open' && hasId === hasNew) return 'open requires exactly one of sessionId or new';
  if (trigger.action === 'stop' && !hasId) return 'missing required field: sessionId';
  const newMode = trigger.action === 'open' && hasNew;
  const allowed = newMode ? ['version', 'action', 'new', 'prompt', 'timeout_ms']
    : trigger.action === 'open' ? ['version', 'action', 'sessionId', 'prompt', 'timeout_ms', 'expectedCwd']
      : ['version', 'action', 'sessionId', 'before', 'timeout_ms', 'expectedCwd'];
  const unsupported = Object.keys(trigger).filter(key => !allowed.includes(key));
  if (newMode && object(trigger.new)) {
    unsupported.push(...Object.keys(trigger.new).filter(key => !['project', 'name'].includes(key)).map(key => 'new.' + key));
  }
  if (unsupported.length) return 'unsupported field: ' + unsupported.sort()[0];
  if (hasId && (typeof trigger.sessionId !== 'string' || !UUID.test(trigger.sessionId))) return 'sessionId must be a UUID';
  if (newMode) {
    if (!object(trigger.new)) return 'new must be an object';
    const { project, name } = trigger.new;
    if (typeof project !== 'string' || !project || !path.isAbsolute(project)) return 'new.project must be an absolute path';
    if (typeof name !== 'string' || !name.trim()) return 'new.name must be a non-empty string';
    if (name.length > 256) return 'new.name too long (max 256 characters)';
    if (/[\x00-\x1f\x7f]/.test(name)) return 'new.name contains control characters';
  }
  const field = trigger.action === 'stop' ? 'before' : 'prompt';
  if (newMode || own(trigger, field)) {
    const text = trigger[field];
    if (typeof text !== 'string' || !text.trim()) return field + ' must be a non-empty string';
    if (text.length > 4096) return field + ' too long (max 4 KB)';
    if (/[\r\n\x00\x1b]/.test(text)) return field + ' contains forbidden control characters (\\r \\n \\0 \\x1b)';
    evidence.steps_total = 1;
  }
  if (own(trigger, 'timeout_ms') && (!Number.isInteger(trigger.timeout_ms) || trigger.timeout_ms < 1 || trigger.timeout_ms > 600000)) return 'invalid timeout_ms';
  if (own(trigger, 'expectedCwd') && (typeof trigger.expectedCwd !== 'string' || !trigger.expectedCwd.trim())) return 'expectedCwd must be a non-empty string when present';
  return null;
}

function refusal(trigger, reason, extra = {}) {
  const hasId = typeof trigger?.sessionId === 'string' && UUID.test(trigger.sessionId);
  const result = {
    version: own(trigger, 'version') ? trigger.version : null,
    action: own(trigger, 'action') ? trigger.action : null,
    ok: false, outcome: 'refused', reason,
    sessionId: hasId ? trigger.sessionId.toLowerCase() : null,
    submitted: 'no', wrote: false,
    steps_total: 0,
  };
  if (trigger?.action === 'open') {
    if (own(trigger, 'sessionId') && !own(trigger, 'new')) result.resumed = false;
    if (own(trigger, 'new') && !own(trigger, 'sessionId')) result.created = false;
  }
  return { ...result, ...extra };
}

function createNewSessionLimiter({ now = Date.now } = {}) {
  let tokens = 3;
  let updated = now();
  function refill() {
    const at = Math.max(updated, now());
    tokens = Math.min(3, tokens + (at - updated) / 20000);
    updated = at;
  }
  return {
    reserve() {
      refill();
      if (tokens < 1) return null;
      tokens -= 1;
      let settled = false;
      return {
        retain() { settled = true; },
        refund() {
          if (settled) return;
          settled = true;
          refill();
          tokens = Math.min(3, tokens + 1);
        },
      };
    },
  };
}

async function boundedRead(read, deps) {
  const now = deps.now || Date.now;
  const deadline = deps.deadline ?? now() + 300000;
  const timeoutError = () => Object.assign(new Error('session action timed out'), { code: 'TRIGGER_DEADLINE' });
  if (now() >= deadline) throw timeoutError();
  const value = read();
  if (!value || typeof value.then !== 'function') return value;
  let timer;
  try {
    return await Promise.race([value, new Promise((_, reject) => {
      timer = (deps.setTimeout || setTimeout)(() => reject(timeoutError()), Math.max(0, deadline - now()));
    })]);
  } finally { (deps.clearTimeout || clearTimeout)(timer); }
}

async function resolveProject(project, deps) {
  const fs = deps.fs || nativeFs;
  const normalize = deps.normalizeProjectPath || normalizeProjectPath;
  const fail = reason => ({ ok: false, outcome: 'refused', reason });
  let snapshot;
  try {
    snapshot = await boundedRead(() => deps.getProjectSnapshot(), deps);
    if (!object(snapshot) || !Array.isArray(snapshot.allProjects) || !Array.isArray(snapshot.hiddenProjects)
      || !object(snapshot.hiddenProjectKinds)) return fail('project lookup unavailable');
  } catch (error) { return { ...fail(error.code === 'TRIGGER_DEADLINE' ? 'session action timed out' : 'project lookup unavailable'), error: error.message }; }
  if (deps.now && deps.now() >= deps.deadline) return fail('session action timed out');
  const knownPath = key => snapshot.allProjects.some(entry => object(entry) && !entry.remoteAlias && !entry.host
    && typeof entry.projectPath === 'string' && normalize(entry.projectPath) === key);
  if (typeof deps.recordedCwd === 'string') {
    const cwdKey = normalize(deps.recordedCwd);
    if (knownPath(cwdKey) || snapshot.hiddenProjects.some(entry => typeof entry === 'string' && path.isAbsolute(entry) && normalize(entry) === cwdKey)) project = deps.recordedCwd;
  }
  const key = normalize(project);
  if (snapshot.hiddenProjects.some(entry => typeof entry === 'string' && path.isAbsolute(entry) && normalize(entry) === key)) return fail('project is archived');
  if (!knownPath(key)) return fail('unknown project');
  try {
    if (!fs.statSync(project).isDirectory()) return fail('project directory does not exist');
  } catch { return fail('project directory does not exist'); }
  return { ok: true, project };
}

async function resolveLocalTarget(sessionId, deps = {}) {
  const fs = deps.fs || nativeFs;
  const now = deps.now || Date.now;
  const deadline = deps.deadline ?? now() + 300000;
  const fail = (reason, outcome = 'refused') => ({ ok: false, outcome, reason });
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return fail('sessionId must be a UUID');
  sessionId = sessionId.toLowerCase();
  const expired = () => now() >= deadline;
  if (expired()) return fail('session action timed out');
  let row;
  let cachedFolder;
  try {
    row = await boundedRead(() => deps.getCachedSession?.(sessionId), { ...deps, now, deadline });
    cachedFolder = row?.folder || await boundedRead(() => deps.getCachedFolder?.(sessionId), { ...deps, now, deadline });
  } catch (error) { return { ...fail(error.code === 'TRIGGER_DEADLINE' ? 'session action timed out' : 'no readable transcript'), error: error.message }; }
  if (expired()) return fail('session action timed out');
  const remote = folder => typeof folder === 'string' && folder.includes('::');
  const remoteRow = !!row?.remoteAlias || !!row?.host || remote(cachedFolder);
  const childRow = !!row?.parentSessionId || !!row?.agentId;
  const candidates = [];
  try {
    if (!deps.projectsDir || !path.isAbsolute(deps.projectsDir)) return fail('no readable transcript');
    const folders = fs.readdirSync(deps.projectsDir, { withFileTypes: true });
    for (const folder of folders) {
      if (expired()) return fail('session action timed out');
      if (!folder.isDirectory() || remote(folder.name)) continue;
      const folderPath = path.join(deps.projectsDir, folder.name);
      for (const name of fs.readdirSync(folderPath)) {
        if (expired()) return fail('session action timed out');
        if (name.endsWith('.jsonl') && name.slice(0, -6).toLowerCase() === sessionId) candidates.push({ folder: folder.name, transcript: path.join(folderPath, name) });
      }
    }
  } catch (error) {
    return { ...fail('no readable transcript'), error: error.message };
  }
  if (candidates.length > 1) return fail('ambiguous session transcript');
  if (!candidates.length) {
    if (remoteRow) return fail('remote sessions are not supported');
    return row && !childRow || cachedFolder && !remoteRow && !childRow ? fail('no readable transcript') : fail('session not found', 'not-found');
  }
  if (childRow && candidates[0].folder === cachedFolder) return fail('session not found', 'not-found');
  const target = candidates[0];
  let fd;
  try {
    const stat = fs.lstatSync(target.transcript);
    if (!stat.isFile() || stat.size === 0) return fail('no readable transcript');
    fd = fs.openSync(target.transcript, 'r');
    const buffer = Buffer.alloc(Math.min(256 * 1024, stat.size));
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.toString('utf8', 0, size).split('\n');
    if (stat.size > size) lines.pop();
    const readable = lines.some(line => {
      try {
        const value = JSON.parse(line);
        return object(value) && (typeof value.type === 'string' || typeof value.cwd === 'string');
      } catch { return false; }
    });
    if (!readable) return fail('no readable transcript');
  } catch (error) { return { ...fail('no readable transcript'), error: error.message }; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  if (expired()) return fail('session action timed out');
  const extract = deps.extractVerifiedCwdFromJsonl || extractVerifiedCwdFromJsonl;
  let parsed;
  try { parsed = extract(target.transcript, target.folder); }
  catch (error) { return { ...fail('no readable transcript'), error: error.message }; }
  if (!parsed?.complete) return fail('no readable transcript');
  if (!parsed.cwd) return fail('session cwd unavailable');
  const cwd = parsed.cwd;
  const project = (deps.resolveWorktreePath || resolveWorktreePath)(cwd);
  const admitted = await resolveProject(project, { ...deps, now, deadline, recordedCwd: cwd });
  if (!admitted.ok) return admitted;
  try { if (!fs.statSync(cwd).isDirectory()) return fail('project directory does not exist'); }
  catch { return fail('project directory does not exist'); }
  if (expired()) return fail('session action timed out');
  return { ok: true, sessionId, cwd, project: admitted.project, ...target };
}

function createTriggerActions({ fs = nativeFs, renameWithRetry, log, now = Date.now } = {}) {
  const limiter = createNewSessionLimiter({ now });
  const error = (...args) => { try { log?.error(...args); } catch {} };
  function remove(file, retained) {
    try { fs.unlinkSync(file); return true; }
    catch (err) {
      if (err.code === 'ENOENT') return true;
      retained?.();
      error('[trigger-watcher] v1 cleanup failed:', file, err.message);
      return false;
    }
  }
  function readState(resultPath, markerPath) {
    function read(file) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) throw new Error('recovery state must be a regular file');
      if (stat.size > 64 * 1024) throw new Error('recovery state too large (max 64 KB)');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    try {
      const result = read(resultPath);
      if (object(result) && own(result, 'version')) return { result, committed: true };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      const marker = read(markerPath);
      if (!object(marker) || marker.version !== 1) throw new Error('invalid v1 action marker');
      const result = refusal(marker, 'interrupted by restart', { uncertain: true });
      if (marker.mode === 'new') { delete result.resumed; result.created = marker.created === true; }
      if (marker.mode === 'resume') result.resumed = marker.resumed === true;
      for (const key of ['wrote', 'text_written', 'enter_written', 'created', 'resumed']) if (marker[key] === true) result[key] = true;
      if (['no', 'assumed', 'activity', 'confirmed'].includes(marker.submitted)) result.submitted = marker.submitted;
      if (marker.steps_total === 0 || marker.steps_total === 1) result.steps_total = marker.steps_total;
      return { result, committed: false };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
  function publish({ result, resultPath, triggerPath, markerPath, retained, committed = false }) {
    try {
      if (!committed) {
        fs.writeFileSync(resultPath + '.tmp', JSON.stringify(result) + '\n', 'utf8');
        renameWithRetry(resultPath + '.tmp', resultPath);
      }
    } catch (err) {
      retained?.();
      error('[trigger-watcher] v1 result publication failed:', err.message);
      return false;
    }
    if (remove(triggerPath, retained)) remove(markerPath, retained);
    return true;
  }
  return { limiter, readState, publish, refusal,
    execute(trigger, stem) {
      const evidence = { steps_total: 0 };
      return refusal(trigger, validateTrigger(trigger, stem, evidence) || UNAVAILABLE, evidence);
    },
  };
}

module.exports = { createNewSessionLimiter, resolveLocalTarget, resolveProject, createTriggerActions, isVersioned, validateTrigger, refusal };
