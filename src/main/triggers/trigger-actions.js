'use strict';

const nativeFs = require('fs');
const path = require('path');
const { extractVerifiedCwdFromJsonl, resolveWorktreePath } = require('../../../derive-project-path');
const { normalizeProjectPath } = require('../shared/normalize-project-path');
const { projectHiddenMatcher } = require('../../../public/worktree-nesting');

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
  const hidden = projectHiddenMatcher(snapshot.hiddenProjects.filter(entry => typeof entry === 'string' && path.isAbsolute(entry)),
    snapshot.hiddenProjectScopes, normalize, value => value);
  const knownPath = key => snapshot.allProjects.find(entry => object(entry) && !entry.remoteAlias && !entry.host
    && typeof entry.projectPath === 'string' && normalize(entry.projectPath) === key);
  if (typeof deps.recordedCwd === 'string') {
    const cwdKey = normalize(deps.recordedCwd);
    if (knownPath(cwdKey) || hidden(null, cwdKey)) project = deps.recordedCwd;
  }
  const key = normalize(project);
  if (hidden(null, key)) return fail('project is archived');
  const known = knownPath(key);
  if (!known) return fail('unknown project');
  try {
    if (!fs.statSync(project).isDirectory()) return fail('project directory does not exist');
  } catch { return fail('project directory does not exist'); }
  return { ok: true, project: known.projectPath };
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
  let identity;
  try { const stat = fs.lstatSync(target.transcript); identity = [stat.dev, stat.ino, stat.birthtimeMs].join(':'); }
  catch (error) { return { ...fail('no readable transcript'), error: error.message }; }
  return { ok: true, sessionId, cwd, project: admitted.project, ...target, transcriptIdentity: identity };
}

function createTriggerActions({ fs = nativeFs, log, now = Date.now } = {}) {
  const limiter = createNewSessionLimiter({ now });
  const error = (...args) => { try { log?.error(...args); } catch {} };
  function readState(resultPath, markerPath) {
    function read(file) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) throw new Error('recovery state must be a regular file');
      if (stat.size > 64 * 1024) throw new Error('recovery state too large (max 64 KB)');
      let fd;
      try {
        const flags = process.platform === 'win32' ? fs.constants.O_RDONLY
          : fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
        fd = fs.openSync(file, flags);
        const opened = fs.fstatSync(fd);
        if (!opened.isFile()) throw new Error('recovery state must be a regular file');
        if (opened.size > 64 * 1024) throw new Error('recovery state too large (max 64 KB)');
        const buffer = Buffer.alloc(64 * 1024 + 1);
        let size = 0;
        while (size < buffer.length) {
          const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
          if (count === 0) break;
          size += count;
        }
        if (size > 64 * 1024) throw new Error('recovery state too large (max 64 KB)');
        return JSON.parse(buffer.toString('utf8', 0, size));
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    try {
      const result = read(resultPath);
      if (object(result) && result.version === 1 && ['open', 'stop'].includes(result.action) && !own(result, 'type')) return { result, committed: true };
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
      if (marker.action === 'stop') {
        if (marker.phase === 'stop-requested' || marker.stop_requested === true) result.stop_requested = true;
        if (object(marker.delivery)) result.delivery = marker.delivery;
      }
      return { result, committed: false };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
  async function publish({ result, namespace, retained, finalize }) {
    try {
      if (!namespace?.publish) throw new Error('request namespace decision is required');
      await namespace.publish(result, finalize);
    } catch (err) {
      retained?.();
      error('[trigger-watcher] v1 result publication failed:', err.message);
      return false;
    }
    return true;
  }
  return { limiter, readState, publish, refusal,
    execute(trigger, stem, execution) {
      const evidence = { steps_total: 0 };
      const invalid = validateTrigger(trigger, stem, evidence);
      if (!invalid && trigger.action === 'open' && execution?.ctx.lifecycle) {
        return executeOpen(trigger, { ...execution, limiter, now, evidence, requestId: stem });
      }
      if (!invalid && trigger.action === 'stop' && execution?.ctx.lifecycle) {
        return executeStop(trigger, { ...execution, now, evidence, requestId: stem });
      }
      return refusal(trigger, invalid || UNAVAILABLE, evidence);
    },
  };
}

async function executeStop(trigger, execution) {
  const { ctx, deadline, now, evidence } = execution;
  const deps = ctx.lifecycle;
  const id = trigger.sessionId.toLowerCase();
  const before = own(trigger, 'before');
  let effects = { ...evidence }, pinned, entry, session, pty, generation, tabKey, ready;
  let releaseSession, releaseTab, stopRequested = false, noteFinished = false;
  const noteEntry = {};
  const fail = (reason, extra = {}) => refusal(trigger, reason, { ...effects, ...extra });
  const bound = read => boundedRead(read, { now, deadline });
  const pause = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, deadline - now()))));
  const reject = (reason, extra) => { throw Object.assign(new Error(reason), { stopRefusal: true, extra }); };
  const authority = deps.captureAuthority?.();
  const allowed = () => deps.launchAllowed() && authority?.valid() !== false;
  const check = (timeout = 'session action timed out') => {
    if (!allowed()) reject('Switchboard is closing.');
    if (now() >= deadline) reject(timeout, stopRequested ? { uncertain: true } : undefined);
    const state = ready?.validate();
    if (state && !state.ok) reject(state.reason);
  };
  const eligibility = target => target.host != null ? 'remote sessions are not supported'
    : target.isPlainTerminal ? 'plain terminal sessions are not supported'
      : target.isAttach || target.backgrounding || target.backgrounded ? 'background session is not supported' : null;
  async function lock(acquire, key) {
    const pending = Promise.resolve(acquire(key, deadline));
    let obtained = false;
    try { const release = await bound(() => pending); obtained = true; return release; }
    finally { if (!obtained) void pending.then(release => release?.()).catch(() => {}); }
  }
  function target(allowExited = false) {
    if (session.generation !== generation || session.pty !== pty) reject('session target changed');
    if (allowExited && session.exited) return;
    const matches = [...deps.activeSessions].filter(([, value]) => value === session);
    if (session.exited || matches.length !== 1) reject('session target changed');
    tabKey = matches[0][0];
    const reason = eligibility(session); if (reason) reject(reason);
  }
  function sample(completion) {
    target();
    const available = !session.sandbox || pinned.ctx.getCliStatus?.(id);
    if (pinned.binding.revoked) reject('session target changed');
    if (!available) reject('session state unavailable');
    pinned.binding.checkStop();
    const status = pinned.ctx.getCliStatus?.(id);
    if (pinned.binding.revoked) reject('session target changed');
    if (status?.kind === 'schedule') reject('scheduled session is not supported');
    if (status?.kind === 'bg') reject('background session is not supported');
    let staleBusy = completion?.source === 'transcript' && status
      && status.statusUpdatedAt === completion.statusUpdatedAt && status.status === completion.status;
    if (staleBusy) {
      const turn = pinned.ctx.getTranscriptTurn?.(id);
      const original = completion.transcriptIdentity;
      const current = turn?.compactionCursor;
      if (!turn?.closed || turn.closedAt !== completion.closedAt || turn.lastEntryAt !== completion.lastEntryAt
        || !original || !current || original.dev !== String(current.dev) || original.ino !== String(current.ino) || original.filePath !== current.filePath
        || !completion.busy && pinned.ctx.isSessionBusy(id)) reject('session busy');
    }
    let awaitingDescriptor = false;
    if (completion?.source === 'busy_flag') {
      if (pinned.ctx.isSessionBusy(id)) reject('session busy');
      if (status && ['busy', 'shell'].includes(status.status)
        && Number.isFinite(status.statusUpdatedAt) && status.statusUpdatedAt <= completion.completedAt) {
        staleBusy = true;
        const { transcriptOwnEntryAt, transcriptShowsTurnOver } = require('./trigger-watcher');
        const ownAt = transcriptOwnEntryAt(pinned.ctx, id, completion.enterAt, trigger.before, noteEntry);
        awaitingDescriptor = ownAt === null || !transcriptShowsTurnOver(pinned.ctx, id, status, ownAt, now(), false);
      }
    }
    if (!staleBusy && (pinned.ctx.isSessionBusy(id) || status?.status === 'busy')) reject('session busy');
    if (!staleBusy && status?.status === 'waiting') reject('session waiting on a dialog');
    if (!staleBusy && status?.status === 'shell') reject('session running a shell command');
    if (!status || !['idle', 'busy', 'shell'].includes(status.status)) reject('session state unavailable');
    const composer = pinned.ctx.getComposerState?.(id);
    const { describeBusyComposer, getQuietMs } = require('./trigger-watcher');
    const quietMs = getQuietMs();
    if (!composer || !Number.isFinite(composer.pending) || composer.pending < 0) {
      reject('session composer unavailable', { detail: describeBusyComposer(null, quietMs, now()) });
    }
    if (composer.pending > 0) reject('session has unsubmitted input', { detail: describeBusyComposer(composer, quietMs, now()) });
    return { remaining: Math.max(awaitingDescriptor ? 25 : 0, (composer.lastInputAt || 0) + quietMs - now()), composer };
  }
  function marker(phase) {
    try {
      const saved = { version: 1, action: 'stop', mode: 'stop', phase, requestId: execution.requestId,
        requestedSessionId: id, sessionId: id, tabKey, generation, deadline, ...effects };
      if (saved.delivery) { saved.delivery = { ...saved.delivery }; delete saved.delivery.command; }
      delete saved.command;
      execution.saveMarker(saved);
    } catch (error) { reject('action state could not be saved', { error: error.message, ...(stopRequested ? { uncertain: true } : {}) }); }
  }
  async function run() {
    check();
    releaseSession = await lock(execution.acquireSessionLock, id);
    if (!releaseSession) reject('session action timed out');
    check();
    const stale = execution.checkStale?.(); if (stale) reject(stale.reason, { error: stale.error });
    entry = ctx.getPtyForSession(id);
    if (entry?.ambiguous) reject('ambiguous normalized local tab id; nothing was written');
    if (!entry && ctx.lookupDeliveryFallback) {
      const found = await bound(() => ctx.lookupDeliveryFallback(id, deadline, { v1: true }));
      if (found.background) reject('background session is not supported');
      if (found.ambiguous) reject('ambiguous descriptor-to-tab ownership; nothing was written');
      entry = found.entry;
    }
    if (!entry) {
      if (await bound(() => deps.remoteTarget(id))) reject('remote sessions are not supported');
      let live;
      try { live = await bound(() => deps.liveElsewhere(id, deadline)); }
      catch (error) { reject(error.code === 'TRIGGER_DEADLINE' ? 'session action timed out' : 'session liveness unavailable', { error: error.message }); }
      if (!live?.known) reject('session liveness unavailable');
      if (live.live) reject(live.live.kind === 'schedule' ? 'scheduled session is not supported'
        : live.live.kind === 'bg' ? 'background session is not supported' : 'session live elsewhere');
      const row = await bound(() => deps.getCachedSession(id));
      const folder = await bound(() => deps.getCachedFolder(id));
      if (row?.remoteAlias || row?.host || typeof folder === 'string' && folder.includes('::')) reject('remote sessions are not supported');
      let known = !!row || !!folder;
      if (!known && deps.projectsDir) {
        const fs = deps.fs || nativeFs;
        let folders;
        try { folders = fs.readdirSync(deps.projectsDir, { withFileTypes: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; folders = []; }
        for (const folder of folders) {
          check();
          if (!folder.isDirectory() || folder.name.includes('::')) continue;
          if (fs.readdirSync(path.join(deps.projectsDir, folder.name)).some(name => name.endsWith('.jsonl') && name.slice(0, -6).toLowerCase() === id)) { known = true; break; }
        }
      }
      return fail(known ? 'session not open here' : 'session not found', { outcome: 'not-found' });
    }
    session = entry.session; pty = entry.ptyProcess; generation = session.generation;
    target();
    pinned = ctx.pinDelivery(id, entry, false, { v1: true, deadline });
    pinned.binding.expectedCwd = trigger.expectedCwd;
    releaseTab = await lock(execution.acquireTabLock, session);
    if (!releaseTab) reject('session action timed out');
    check(); target();
    ready = await deps.broker.waitForReady(deadline);
    if (!ready?.ok) reject(before && now() >= deadline ? 'note step not finished' : ready?.reason || 'renderer not ready');
    pinned.binding.validateAction = () => {
      const state = allowed() ? ready.validate() : { ok: false, reason: 'Switchboard is closing.' };
      if (!state.ok) throw Object.assign(new Error(state.reason), { deliveryRefusal: true });
    };
    check(); target();
    if (own(trigger, 'expectedCwd')) {
      const { normalizeCwd } = require('./trigger-watcher');
      const cwd = normalizeCwd(session.cwd);
      if (cwd === null) reject("this session's cwd could not be determined; refusing rather than risk targeting the wrong session");
      if (cwd !== normalizeCwd(trigger.expectedCwd)) reject("expectedCwd does not match this session's actual cwd");
    }
    if (before) {
      marker('claimed');
      let delivered;
      try {
        pinned.binding.checkStop();
        marker('prompt-attempted');
        delivered = await execution.deliver({ sessionId: id, command: trigger.before, wait: 'idle', expectedCwd: trigger.expectedCwd,
          entry, pinned, deadline, waitForFinalTurn: true });
      } catch (error) {
        const step = pinned.binding.step;
        delivered = { ok: false, reason: error.message, error: error.message,
          wrote: !!step?.text_written, text_written: !!step?.text_written, enter_written: !!step?.enter_written,
          submitted: step?.enter_written ? 'assumed' : 'no' };
      }
      effects = { ...effects, ...delivered, delivery: delivered };
      delete effects.ok; delete effects.reason; delete effects.error;
      marker('note-delivered');
      if (!allowed()) reject('Switchboard is closing.');
      if (!delivered.ok || delivered.timedOut || now() >= deadline || !delivered.final_turn
        || delivered.final_turn.timedOut || delivered.final_turn.sessionExited
        || !['descriptor', 'transcript', 'busy_flag'].includes(delivered.final_turn.source)) {
        reject('note step not finished', delivered.enter_written ? { uncertain: true } : undefined);
      }
      noteFinished = true;
      check(); target(true);
      if (session.exited) return { ...fail(null), ok: true, outcome: 'closed', reason: null };
    }
    while (true) {
      check(before ? 'note step not finished' : 'session input not quiet');
      target(true);
      if (session.exited) return { ...fail(null), ok: true, outcome: 'closed', reason: null };
      const state = sample(effects.delivery?.final_turn);
      if (state.remaining > 0) { await pause(Math.min(25, state.remaining)); continue; }
      check(before ? 'note step not finished' : 'session input not quiet');
      marker(noteFinished ? 'note-finished' : 'claimed');
      const final = sample(effects.delivery?.final_turn);
      if (final.remaining > 0) continue;
      check(before ? 'note step not finished' : 'session input not quiet');
      let stopped;
      try { stopped = deps.stop(session, tabKey); }
      catch (error) { reject('session stop failed', { error: error.message }); }
      if (!stopped?.ok || stopped.detached) reject('session stop failed', { ...(stopped?.error ? { error: stopped.error } : {}) });
      stopRequested = true; effects.stop_requested = true;
      marker('stop-requested');
      break;
    }
    while (true) {
      check('session stop not confirmed'); target(true);
      if (session.exited) return { ...fail(null), ok: true, outcome: 'closed', reason: null };
      await pause(25);
    }
  }
  let result;
  try {
    try { result = await run(); }
    catch (error) {
      result = fail(error.stopRefusal ? error.message : error.code === 'TRIGGER_DEADLINE' ? 'session action timed out'
        : error.deliveryRefusal ? error.message : 'session stop failed',
      { ...(!error.stopRefusal ? { error: error.message } : {}),
        ...(stopRequested || before && effects.enter_written && !noteFinished ? { uncertain: true } : {}), ...error.extra });
    }
    const finalize = pending => {
      result = !allowed() && pending.reason !== 'Switchboard is closing.'
        ? { ...pending, ok: false, outcome: 'refused', reason: 'Switchboard is closing.', error: 'Switchboard is closing.' } : pending;
      return result;
    };
    await execution.publish(finalize(result), finalize);
    return result;
  } finally {
    try { pinned?.ctx.forgetTranscriptTurn?.(id); } catch {}
    releaseTab?.(); releaseSession?.();
  }
}

async function executeOpen(trigger, execution) {
  const { ctx, deadline, now, limiter, evidence } = execution;
  const deps = ctx.lifecycle;
  const isNew = own(trigger, 'new');
  let id = isNew ? null : trigger.sessionId.toLowerCase();
  let effects = { ...evidence };
  let releaseSession, releaseTab, reservation, pinned;
  let acceptedCheck = null;
  const fail = (reason, extra = {}) => refusal(trigger, reason, { ...effects, sessionId: id, ok: false, outcome: 'refused', reason, ...extra });
  const authority = deps.captureAuthority?.();
  const allowed = () => deps.launchAllowed() && authority?.valid() !== false;
  const expired = () => now() >= deadline;
  const admitted = () => !expired() && allowed();
  const check = () => {
    if (!allowed()) throw Object.assign(new Error('Switchboard is closing.'), { refusal: true });
    if (expired()) throw Object.assign(new Error('session action timed out'), { refusal: true });
  };
  const bound = read => boundedRead(read, { now, deadline });
  async function lock(acquire, key) {
    const pending = Promise.resolve(acquire(key, deadline));
    let obtained = false;
    try { const release = await bound(() => pending); obtained = true; return release; }
    finally { if (!obtained) void pending.then(release => release?.()).catch(() => {}); }
  }
  async function liveness() {
    let checked;
    try { checked = await bound(() => deps.liveElsewhere(id, deadline)); }
    catch (error) { return fail(error.code === 'TRIGGER_DEADLINE' ? 'session action timed out' : 'session liveness unavailable', { error: error.message }); }
    if (!checked?.known) return fail('session liveness unavailable');
    if (checked.live) return fail(checked.live.kind === 'schedule' ? 'scheduled session is not supported'
      : checked.live.kind === 'bg' ? 'background session is not supported' : 'session live elsewhere');
    return null;
  }
  function eligibility(session) {
    return session.host != null ? 'remote sessions are not supported'
      : session.isPlainTerminal ? 'plain terminal sessions are not supported'
        : session.isAttach || session.backgrounding || session.backgrounded ? 'background session is not supported' : null;
  }
  function sessionChanged(session, pty, generation) {
    const keys = [...deps.activeSessions];
    if (!keys.some(([, value]) => value === session) || session.exited || session.pty !== pty || session.generation !== generation
      || keys.some(([key, value]) => String(key).toLowerCase() === id && value !== session)) return fail('session target changed');
    const reason = eligibility(session);
    return reason ? fail(reason) : null;
  }
  function cwdFailure(cwd) {
    if (!own(trigger, 'expectedCwd')) return null;
    const normalize = require('./trigger-watcher').normalizeCwd;
    const actual = normalize(cwd);
    return actual === null ? fail("this session's cwd could not be determined; refusing rather than risk targeting the wrong session")
      : normalize(trigger.expectedCwd) !== actual ? fail("expectedCwd does not match this session's actual cwd") : null;
  }
  async function pin(entry) {
    pinned = ctx.pinDelivery(id, entry, false, { v1: true, deadline });
    releaseTab = await lock(execution.acquireTabLock, entry.session);
    if (!releaseTab) return fail('session action timed out');
    pinned.binding.deadline = deadline;
    pinned.binding.expectedCwd = trigger.expectedCwd;
    pinned.binding.validateAction = () => {
      if (!allowed()) throw Object.assign(new Error('Switchboard is closing.'), { deliveryRefusal: true });
    };
    return null;
  }
  async function run() {
    check();
    let target;
    if (isNew) {
      target = await resolveProject(trigger.new.project, { ...deps, now, deadline });
      if (!target.ok) return fail(target.reason, target.error ? { error: target.error } : {});
      reservation = limiter.reserve();
      if (!reservation) return fail('new session rate limit exceeded');
      id = (deps.randomUUID || require('node:crypto').randomUUID)().toLowerCase();
      effects.created = false;
    }
    releaseSession = await lock(execution.acquireSessionLock, id);
    if (!releaseSession) return fail('session action timed out');
    check();
    const stale = execution.checkStale?.();
    if (stale) return fail(stale.reason, { error: stale.error });
    let entry = isNew ? null : ctx.getPtyForSession(id);
    if (entry?.ambiguous) return fail('ambiguous normalized local tab id; nothing was written');
    if (!isNew && !entry && ctx.lookupDeliveryFallback) {
      const found = await bound(() => ctx.lookupDeliveryFallback(id, deadline, { v1: true }));
      if (found.background) return fail('background session is not supported');
      if (found.ambiguous) return fail('ambiguous descriptor-to-tab ownership; nothing was written');
      entry = found.entry;
    }
    const firstTarget = entry ? { pty: entry.session.pty, generation: entry.session.generation } : null;
    let tabKey = id;
    let mode = isNew ? 'new' : 'resume';
    if (entry) {
      const reason = eligibility(entry.session);
      if (reason) return fail(reason);
      const matches = [...deps.activeSessions].filter(([, session]) => session === entry.session);
      if (matches.length !== 1) return fail('session target changed');
      tabKey = matches[0][0]; mode = 'reattach';
      const cwd = cwdFailure(entry.cwd); if (cwd) return cwd;
      const failure = await pin(entry); if (failure) return failure;
      const moved = sessionChanged(entry.session, firstTarget.pty, firstTarget.generation); if (moved) return moved;
    } else if (!isNew) {
      if (await bound(() => deps.remoteTarget(id))) return fail('remote sessions are not supported');
      const live = await liveness(); if (live) return live;
      target = await (deps.resolveTarget || resolveLocalTarget)(id, { ...deps, now, deadline });
      if (!target.ok) return fail(target.reason, { outcome: target.outcome || 'refused', ...(target.error ? { error: target.error } : {}) });
      const cwd = cwdFailure(target.cwd); if (cwd) return cwd;
      const again = await liveness(); if (again) return again;
    }
    check();
    const operation = { mode, requestedSessionId: isNew ? null : id, tabKey,
      generation: firstTarget?.generation ?? null, entry: entry?.session,
      project: mode === 'reattach' ? entry.session.projectPath : target.project,
      session: { sessionId: tabKey, headSessionId: tabKey, mergedMemberIds: [], projectPath: mode === 'reattach' ? entry.session.projectPath : target.project },
      target, name: isNew ? trigger.new.name.trim() : undefined, deadline };
    const marker = () => {
      const saved = { version: 1, action: 'open', requestId: execution.requestId,
        requestedSessionId: isNew ? null : id, sessionId: id, tabKey, deadline,
        mode: isNew ? 'new' : 'resume', phase: effects.enter_written ? 'submitted' : effects.created || effects.resumed ? 'spawned' : 'claimed' };
      for (const key of ['created', 'resumed', 'wrote', 'text_written', 'enter_written', 'submitted', 'steps_total']) {
        if (effects[key] !== undefined) saved[key] = effects[key];
      }
      execution.saveMarker(saved);
    };
    operation.onOpened = () => {
      effects[isNew ? 'created' : 'resumed'] = true;
      reservation?.retain();
      marker();
    };
    if (mode === 'resume') operation.verifyJoined = async session => {
      check();
      if (eligibility(session)) return fail(eligibility(session));
      if (session.launchMode !== 'resume' || String(session.launchSourceId).toLowerCase() !== id || session.forkFrom
        || session.cwd !== target.cwd || session.projectPath !== target.project) return fail('session target changed');
      const live = await liveness(); if (live) return live;
      const fresh = await (deps.resolveTarget || resolveLocalTarget)(id, { ...deps, now, deadline });
      if (!fresh.ok) return fail(fresh.reason, fresh.error ? { error: fresh.error } : {});
      check();
      if (fresh.transcript !== target.transcript || fresh.transcriptIdentity !== target.transcriptIdentity
        || fresh.cwd !== target.cwd || fresh.project !== target.project) return fail('session target changed');
      return { ok: true };
    };
    const ack = await deps.broker.request(operation, async () => {
      check();
      if (mode === 'resume') { const refusal = await liveness(); if (refusal) return refusal; }
      check();
      marker();
    });
    if (ack?.created) { effects.created = true; reservation?.retain(); }
    if (ack?.resumed) effects.resumed = true;
    if (!ack?.ok) {
      if (ack?.uncertain) reservation?.retain();
      return fail(ack?.reason || 'session open failed', { ...(ack?.error ? { error: ack.error } : {}), ...(ack?.uncertain ? { uncertain: true } : {}) });
    }
    check();
    const session = deps.activeSessions.get(tabKey);
    if (!session || session.exited || session.generation !== ack.generation || (entry && session !== entry.session)) return fail('session target changed');
    if (eligibility(session)) return fail(eligibility(session));
    marker();
    const acceptedPty = firstTarget?.pty ?? session.pty;
    const acceptedGeneration = firstTarget?.generation ?? session.generation;
    const targetChanged = () => sessionChanged(session, acceptedPty, acceptedGeneration);
    acceptedCheck = targetChanged;
    if (!pinned) {
      entry = ctx.getPtyForSession(id);
      if (entry?.session !== session) return fail('session target changed');
      const failure = await pin(entry); if (failure) return failure;
    }
    if (isNew) {
      try {
        check();
        const saved = await bound(() => deps.saveName(id, operation.name));
        if (saved?.name !== operation.name) return fail('session name could not be saved');
      } catch (error) { return fail(error.code === 'TRIGGER_DEADLINE' ? 'session action timed out' : 'session name could not be saved', { error: error.message }); }
    }
    check();
    const moved = targetChanged(); if (moved) return moved;
    const cwd = cwdFailure(session.cwd); if (cwd) return cwd;
    if (own(trigger, 'prompt')) {
      const result = await execution.deliver({ sessionId: id, command: trigger.prompt, wait: 'idle', expectedCwd: trigger.expectedCwd,
        entry, pinned, deadline, startup: mode !== 'reattach', launchStartedAt: session.launchStartedAt, sandbox: !!session.sandbox });
      effects = { ...effects, ...result };
      marker();
      if (result.timedOut || (expired() && result.enter_written)) return fail('session action timed out', { ...(result.enter_written ? { uncertain: true } : {}) });
      if (!result.ok) return fail(result.reason || result.error || 'session open failed');
      check();
    }
    if (!admitted()) { check(); }
    const final = targetChanged(); if (final) return final;
    return { ...fail(null), ok: true, outcome: 'opened', reason: null };
  }
  let result;
  try {
    try { result = await run(); }
    catch (error) {
      const step = pinned?.binding.step;
      result = fail(error.refusal || error.code === 'TRIGGER_DEADLINE' ? error.code === 'TRIGGER_DEADLINE' ? 'session action timed out' : error.message
        : error.deliveryRefusal ? error.message : 'session open failed', { error: error.message,
        ...(step?.text_written ? { wrote: true, text_written: true, enter_written: !!step.enter_written,
          submitted: step.enter_written ? 'assumed' : 'no', ...(expired() && step.enter_written ? { uncertain: true } : {}) } : {}) });
    }
    const finalize = pending => {
      const next = pending.ok && acceptedCheck ? acceptedCheck() || pending : pending;
      result = !allowed() && next.reason !== 'Switchboard is closing.'
        ? { ...next, ok: false, outcome: 'refused', reason: 'Switchboard is closing.', error: 'Switchboard is closing.' } : next;
      return result;
    };
    await execution.publish(finalize(result), finalize);
    return result;
  } finally {
    reservation?.refund();
    try { pinned?.ctx.forgetTranscriptTurn?.(id); } catch {}
    releaseTab?.(); releaseSession?.();
  }
}

module.exports = { createNewSessionLimiter, resolveLocalTarget, resolveProject, createTriggerActions, isVersioned, validateTrigger, refusal };
