'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeProjectPath } = require('../shared/normalize-project-path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateTriggerAction(request, filename) {
  const fail = reason => ({ reason, value: null });
  if (!object(request)) return fail('trigger must be an object');
  if (request.version !== 1) return fail('unsupported version');
  if (request.action !== 'open' && request.action !== 'stop') return fail('unsupported action');
  if (!FILENAME.test(filename)) return fail('trigger filename must be a lowercase UUID');
  const isNew = own(request, 'new');
  if (request.action === 'open' && own(request, 'sessionId') === isNew) return fail('open requires exactly one of sessionId or new');
  if (request.action === 'stop' && !own(request, 'sessionId')) return fail('missing required field: sessionId');
  const allowed = new Set(['version', 'action', 'timeout_ms', ...(isNew && request.action === 'open' ? ['new', 'prompt'] : ['sessionId', 'expectedCwd', request.action === 'open' ? 'prompt' : 'before'])]);
  const extra = Object.keys(request).filter(key => !allowed.has(key));
  if (isNew && request.action === 'open' && object(request.new)) {
    extra.push(...Object.keys(request.new).filter(key => !['project', 'name'].includes(key)).map(key => `new.${key}`));
  }
  if (extra.length) return fail(`unsupported field: ${extra.sort()[0]}`);
  if (own(request, 'sessionId') && (typeof request.sessionId !== 'string' || !UUID.test(request.sessionId))) return fail('sessionId must be a UUID');
  if (isNew && request.action === 'open') {
    if (!object(request.new)) return fail('new must be an object');
    if (typeof request.new.project !== 'string' || !path.isAbsolute(request.new.project)) return fail('new.project must be an absolute path');
    if (typeof request.new.name !== 'string' || !request.new.name.trim()) return fail('new.name must be a non-empty string');
    if (request.new.name.length > 256) return fail('new.name too long (max 256 characters)');
    if (/[\x00-\x1f\x7f]/.test(request.new.name)) return fail('new.name contains control characters');
  }
  const field = request.action === 'open' ? 'prompt' : 'before';
  if (own(request, field) || (isNew && request.action === 'open')) {
    const value = request[field];
    if (typeof value !== 'string' || !value.trim()) return fail(`${field} must be a non-empty string`);
    if (value.length > 4096) return fail(`${field} too long (max 4 KB)`);
    if (/[\r\n\0\x1b]/.test(value)) return fail(`${field} contains forbidden control characters (\\r \\n \\0 \\x1b)`);
  }
  if (own(request, 'timeout_ms') && (!Number.isInteger(request.timeout_ms) || request.timeout_ms < 1 || request.timeout_ms > 600000)) return fail('invalid timeout_ms');
  if (own(request, 'expectedCwd') && (typeof request.expectedCwd !== 'string' || !request.expectedCwd.trim())) return fail('expectedCwd must be a non-empty string when present');
  return { reason: null, value: { ...request, ...(own(request, 'sessionId') ? { sessionId: request.sessionId.toLowerCase() } : {}), ...(isNew ? { new: { ...request.new, name: request.new.name.trim() } } : {}) } };
}

function createNewSessionLimiter(now = Date.now) {
  let tokens = 3;
  let updated = now();
  return {
    reserve() {
      const current = now();
      tokens = Math.min(3, tokens + Math.max(0, current - updated) / 20000);
      updated = current;
      if (tokens < 1) return null;
      tokens -= 1;
      let refunded = false;
      return { refund() {
        if (refunded) return;
        refunded = true;
        tokens = Math.min(3, tokens + 1);
      } };
    },
  };
}

async function checkProject(project, getSnapshot, directoryExists, cwd = project) {
  let snapshot;
  try { snapshot = await getSnapshot(); } catch { return 'project lookup unavailable'; }
  if (!snapshot || !Array.isArray(snapshot.allProjects) || !object(snapshot.global)
    || !Array.isArray(snapshot.global.hiddenProjects) || !object(snapshot.global.hiddenProjectKinds)) {
    return 'project lookup unavailable';
  }
  const target = normalizeProjectPath(project);
  if (snapshot.global.hiddenProjects.some(entry => typeof entry === 'string' && path.isAbsolute(entry) && normalizeProjectPath(entry) === target)) {
    return 'project is archived';
  }
  if (!snapshot.allProjects.some(entry => entry && !entry.remoteAlias && normalizeProjectPath(entry.projectPath) === target)) {
    return 'unknown project';
  }
  try { return await directoryExists(cwd) ? null : 'project directory does not exist'; }
  catch { return 'project lookup unavailable'; }
}


const REASON = {
  TIMEOUT: 'session action timed out',
  LIVE_ELSEWHERE: 'session live elsewhere',
  BACKGROUND: 'background session is not supported',
  SCHEDULE: 'scheduled session is not supported',
  REMOTE: 'remote sessions are not supported',
  PLAIN: 'plain terminal sessions are not supported',
  NO_TRANSCRIPT: 'no readable transcript',
  NOT_FOUND: 'session not found',
  NOT_OPEN: 'session not open here',
  AMBIGUOUS_TRANSCRIPT: 'ambiguous session transcript',
  AMBIGUOUS_TAB: 'ambiguous normalized local tab id; nothing was written',
  AMBIGUOUS_DESCRIPTOR: 'ambiguous descriptor-to-tab ownership; nothing was written',
  CWD_UNAVAILABLE: 'session cwd unavailable',
  LIVENESS: 'session liveness unavailable',
  RATE: 'new session rate limit exceeded',
  MARKER: 'action state could not be saved',
  CHANGED: 'session target changed',
  OPEN_FAILED: 'session open failed',
  NAME_FAILED: 'session name could not be saved',
  STOP_FAILED: 'session stop failed',
  STOP_UNCONFIRMED: 'session stop not confirmed',
  NOTE_UNFINISHED: 'note step not finished',
  BUSY: 'session busy',
  WAITING: 'session waiting on a dialog',
  SHELL: 'session running a shell command',
  STATE_UNAVAILABLE: 'session state unavailable',
  PENDING_INPUT: 'session has unsubmitted input',
  COMPOSER_UNAVAILABLE: 'session composer unavailable',
  NOT_QUIET: 'session input not quiet',
  READINESS: 'session readiness unavailable',
  CWD_UNKNOWN: "this session's cwd could not be determined; refusing rather than risk targeting the wrong session",
  CWD_MISMATCH: "expectedCwd does not match this session's actual cwd",
};

function validationResult(raw, reason) {
  const has = key => object(raw) && own(raw, key);
  return {
    version: has('version') ? raw.version : null, action: has('action') ? raw.action : null,
    ok: false, outcome: 'refused', reason, sessionId: null, submitted: 'no', wrote: false, steps_total: 0,
  };
}

function resolveClosedTarget(rawId, deps) {
  const id = String(rawId).toLowerCase();
  const fsx = deps.fs || fs;
  const clock = deps.now || Date.now;
  const expired = () => Number.isFinite(deps.deadline) && clock() >= deps.deadline;
  const refuse = reason => ({ status: 'refused', reason });
  let row;
  let cachedFolder;
  try {
    row = deps.getCachedSession(id) || null;
    cachedFolder = deps.getCachedFolder(id) || null;
  } catch { return refuse('project lookup unavailable'); }
  if (row?.remoteAlias || (cachedFolder && deps.isRemoteFolder(cachedFolder))) return { status: 'remote' };
  let folders;
  try { folders = fsx.readdirSync(deps.projectsDir, { withFileTypes: true }); }
  catch (err) { if (err.code !== 'ENOENT') return refuse(REASON.NO_TRANSCRIPT); folders = []; }
  const matches = [];
  for (const folder of folders) {
    if (expired()) return refuse(REASON.TIMEOUT);
    if (!folder.isDirectory()) continue;
    let names;
    try { names = fsx.readdirSync(path.join(deps.projectsDir, folder.name)); } catch { return refuse(REASON.NO_TRANSCRIPT); }
    for (const name of names) if (name.toLowerCase() === `${id}.jsonl`) matches.push({ folder: folder.name, name });
  }
  if (!matches.length) return row || cachedFolder ? refuse(REASON.NO_TRANSCRIPT) : { status: 'unknown' };
  if (matches.length > 1) return refuse(REASON.AMBIGUOUS_TRANSCRIPT);
  const file = path.join(deps.projectsDir, matches[0].folder, matches[0].name);
  let stat;
  try {
    stat = fsx.lstatSync(file);
    if (!stat.isFile() || stat.size === 0) return refuse(REASON.NO_TRANSCRIPT);
    const fd = fsx.openSync(file, 'r');
    try { fsx.readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { fsx.closeSync(fd); }
  } catch { return refuse(REASON.NO_TRANSCRIPT); }
  let cwd;
  try { cwd = deps.extractVerifiedCwd(file, matches[0].folder)?.cwd; } catch { return refuse(REASON.NO_TRANSCRIPT); }
  if (typeof cwd !== 'string' || !cwd) return refuse(REASON.CWD_UNAVAILABLE);
  return { status: 'found', sessionId: id, file, folder: matches[0].folder, cwd, projectPath: deps.resolveWorktreePath(cwd), identity: { dev: stat.dev, ino: stat.ino } };
}

function createTriggerActions(deps) {
  const { ctx, helpers, bridge } = deps;
  const clock = deps.now || Date.now;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const limiter = createNewSessionLimiter(clock);
  const hasPrompt = req => req.prompt !== undefined || req.before !== undefined;

  const refusal = (state, reason, extra = {}) => ({ ...state.out, ...extra, outcome: 'refused', ok: false, reason });
  const notFound = (state, reason) => ({ ...state.out, outcome: 'not-found', ok: false, reason });
  const success = (state, outcome, extra = {}) => ({ ...state.out, ...extra, outcome, ok: true, reason: null });
  const deliveryRefusal = (state, err) => refusal(state, err.message, { error: 'not sent' });

  async function liveGate(state, id) {
    let verdict;
    try { verdict = await deps.liveV1(id, { deadline: state.env.deadline }); } catch { verdict = null; }
    if (!verdict || verdict.known !== true) return refusal(state, REASON.LIVENESS);
    const live = verdict.live;
    if (!live) return null;
    if (live.kind === 'bg') return refusal(state, REASON.BACKGROUND);
    if (live.kind === 'schedule') return refusal(state, REASON.SCHEDULE);
    return refusal(state, REASON.LIVE_ELSEWHERE);
  }

  function cwdGuard(state, observed) {
    const expected = state.req.expectedCwd;
    if (expected === undefined) return null;
    const actual = helpers.normalizeCwd(observed);
    if (actual === null) return refusal(state, REASON.CWD_UNKNOWN, { targetCwdUnknown: true, expectedCwd: expected, observedCwd: null });
    if (helpers.normalizeCwd(expected) !== actual) return refusal(state, REASON.CWD_MISMATCH, { targetMismatch: true, expectedCwd: expected, observedCwd: observed });
    return null;
  }

  function claim(state, phase, evidence) {
    try { return state.env.mark(phase, evidence) !== false; } catch { return false; }
  }

  async function findOpen(state, id) {
    let entry = ctx.getPtyForSession(id);
    if (entry?.ambiguous) return { result: refusal(state, REASON.AMBIGUOUS_TAB) };
    if (!entry && typeof ctx.lookupDeliveryFallback === 'function') {
      const found = await ctx.lookupDeliveryFallback(id, state.env.deadline);
      if (found.background) return { result: refusal(state, REASON.BACKGROUND) };
      if (found.ambiguous) return { result: refusal(state, REASON.AMBIGUOUS_DESCRIPTOR) };
      entry = found.entry || null;
    }
    if (!entry) return {};
    const session = entry.session;
    if (session.isPlainTerminal) return { result: refusal(state, REASON.PLAIN) };
    if (session.host != null) return { result: refusal(state, REASON.REMOTE) };
    if (session.isAttach || session.backgrounding || session.backgrounded) return { result: refusal(state, REASON.BACKGROUND) };
    return { entry };
  }

  async function pin(state, entry, requestedId) {
    const pinned = ctx.pinDelivery(requestedId, entry, false, { v1: true });
    state.pinned = pinned;
    state.entry = entry;
    const unlock = await state.env.acquireTabLock(pinned.binding.tab, state.env.deadline);
    if (!unlock) return refusal(state, REASON.TIMEOUT);
    state.release.push(unlock);
    return null;
  }

  const targetIntact = state => !!state.pinned.ctx.getPtyForSession(state.requestedId);
  const evidenceOf = d => d.evidence || {};

  function deliver(state, text, { startupAfterMs = null, finalTurn = false } = {}) {
    claim(state, 'prompt-attempted');
    return helpers.deliverPrompt({
      id: state.requestedId, pinned: state.pinned, entry: state.entry, text, deadline: state.env.deadline, startupAfterMs, finalTurn,
    });
  }

  function promptFailure(state, d, { note }) {
    const ev = evidenceOf(d);
    if (d.cause === 'verify-timeout') {
      return refusal(state, note ? REASON.NOTE_UNFINISHED : REASON.TIMEOUT, { ...ev, uncertain: true, ...(note ? { delivery: ev } : {}) });
    }
    if (note) return refusal(state, REASON.NOTE_UNFINISHED, { ...ev, ...(d.error ? { error: d.error } : {}), delivery: { reason: d.reason, ...ev } });
    return refusal(state, d.reason, { ...ev, ...(d.error ? { error: d.error } : {}) });
  }

  async function admitDelivery(state) {
    try { await state.pinned.binding.admit(state.env.deadline); return null; }
    catch (err) { if (!err.deliveryRefusal) throw err; return err; }
  }

  async function runOpen(state, entry, id) {
    const guard = cwdGuard(state, entry.cwd);
    if (guard) return guard;
    const pinFailure = await pin(state, entry, id);
    if (pinFailure) return pinFailure;
    const tabKey = entry.tabKey ?? id;
    if (!claim(state, 'claimed', { mode: 'reattach', tabKey })) return refusal(state, REASON.MARKER);
    const ack = await bridge.ensureOpen({ mode: 'reattach', requestedSessionId: id, tabKey, generation: entry.session.generation,
      session: entry.session, deadline: state.env.deadline });
    if (!ack.ok) return refusal(state, ack.reason, ack.error ? { error: ack.error } : {});
    if (!targetIntact(state)) return refusal(state, REASON.CHANGED);
    if (state.req.prompt === undefined) return success(state, 'opened');
    const refused = await admitDelivery(state);
    if (refused) return deliveryRefusal(state, refused);
    const d = await deliver(state, state.req.prompt);
    return d.ok ? success(state, 'opened', evidenceOf(d)) : promptFailure(state, d, { note: false });
  }

  async function runResume(state, id) {
    let remote = false;
    try { remote = deps.isRemoteTarget ? await deps.isRemoteTarget(id) : false; } catch { return refusal(state, REASON.LIVENESS); }
    if (remote) return refusal(state, REASON.REMOTE);
    const live = await liveGate(state, id);
    if (live) return live;
    const found = await deps.resolveClosed(id, { deadline: state.env.deadline });
    if (found.status === 'remote') return refusal(state, REASON.REMOTE);
    if (found.status === 'unknown') return notFound(state, REASON.NOT_FOUND);
    if (found.status === 'refused') return refusal(state, found.reason);
    const project = await checkProject(found.projectPath, deps.getSnapshot, deps.directoryExists, found.cwd);
    if (project) return refusal(state, project);
    const guard = cwdGuard(state, found.cwd);
    if (guard) return guard;
    const again = await liveGate(state, id);
    if (again) return again;
    if (!claim(state, 'claimed', { mode: 'resume', tabKey: id })) return refusal(state, REASON.MARKER);
    const ack = await bridge.ensureOpen({ mode: 'resume', requestedSessionId: id, tabKey: id, generation: null, target: found,
      project: found.projectPath, session: { sessionId: id, projectPath: found.projectPath }, deadline: state.env.deadline });
    if (ack.spawned) { state.out.resumed = true; claim(state, 'spawned', { generation: ack.generation, resumed: true }); }
    if (!ack.ok) return refusal(state, ack.reason, { ...(ack.error ? { error: ack.error } : {}), ...(ack.uncertain ? { uncertain: true } : {}) });
    const entry = ctx.getPtyForSession(id);
    if (!entry || entry.ambiguous || entry.session.generation !== ack.generation) return refusal(state, REASON.CHANGED);
    const failure = await pin(state, entry, id);
    if (failure) return failure;
    if (state.req.prompt === undefined) return success(state, 'opened');
    const refused = await admitDelivery(state);
    if (refused) return deliveryRefusal(state, refused);
    const d = await deliver(state, state.req.prompt, { startupAfterMs: ack.launchStartedAt });
    return d.ok ? success(state, 'opened', evidenceOf(d)) : promptFailure(state, d, { note: false });
  }

  async function runNew(state) {
    const { req, env } = state;
    const projectRefusal = await checkProject(req.new.project, deps.getSnapshot, deps.directoryExists);
    if (projectRefusal) return refusal(state, projectRefusal);
    const token = limiter.reserve();
    if (!token) return refusal(state, REASON.RATE);
    const id = deps.reserveId();
    state.out.sessionId = id;
    state.requestedId = id;
    const lock = await env.acquireSessionLock(id, env.deadline);
    if (!lock) { token.refund(); return refusal(state, REASON.TIMEOUT); }
    state.release.push(lock);
    const stale = env.staleCheck();
    if (stale) { token.refund(); return refusal(state, stale, { error: 'not sent' }); }
    if (!claim(state, 'claimed', { mode: 'new', tabKey: id })) { token.refund(); return refusal(state, REASON.MARKER); }
    const ack = await bridge.ensureOpen({ mode: 'new', requestedSessionId: null, tabKey: id, generation: null,
      project: req.new.project, name: req.new.name, session: { sessionId: id, projectPath: req.new.project }, deadline: env.deadline });
    if (ack.spawned) { state.out.created = true; claim(state, 'spawned', { generation: ack.generation, created: true }); }
    if (!ack.ok) {
      if (ack.preSpawn === true) token.refund();
      return refusal(state, ack.reason, { ...(ack.error ? { error: ack.error } : {}), ...(ack.uncertain ? { uncertain: true } : {}) });
    }
    const entry = ctx.getPtyForSession(id);
    if (!entry || entry.ambiguous || entry.session.generation !== ack.generation) return refusal(state, REASON.CHANGED);
    try { await deps.saveName(id, req.new.name); }
    catch (err) { return refusal(state, REASON.NAME_FAILED, { error: err.message }); }
    const failure = await pin(state, entry, id);
    if (failure) return failure;
    const refused = await admitDelivery(state);
    if (refused) return deliveryRefusal(state, refused);
    const d = await deliver(state, req.prompt, { startupAfterMs: ack.launchStartedAt });
    return d.ok ? success(state, 'opened', evidenceOf(d)) : promptFailure(state, d, { note: false });
  }

  function sampleStop(state, afterNote) {
    const { pinned, requestedId } = state;
    const pctx = pinned.ctx;
    if (!pctx.getPtyForSession(requestedId)) return { refuse: REASON.CHANGED };
    try { pinned.binding.verify('stop'); }
    catch (err) { if (!err.deliveryRefusal) throw err; return { refuse: err.message, delivery: true }; }
    const status = typeof pctx.getCliStatus === 'function' ? pctx.getCliStatus(requestedId) : undefined;
    const flagBusy = !!pctx.isSessionBusy(requestedId);
    const transcriptDone = afterNote?.source === 'transcript';
    const staleBusy = transcriptDone && status?.status === 'busy' && status.statusUpdatedAt <= afterNote.stamp;
    if (status?.status === 'busy' ? !staleBusy : flagBusy && !transcriptDone) return { refuse: REASON.BUSY };
    if (status?.status === 'waiting') return { refuse: REASON.WAITING };
    if (status?.status === 'shell') return { refuse: REASON.SHELL };
    if (!status || (status.status !== 'idle' && !staleBusy)) return { refuse: REASON.STATE_UNAVAILABLE };
    const composer = pctx.getComposerState(requestedId);
    if (!composer) return { refuse: REASON.COMPOSER_UNAVAILABLE };
    if (composer.pending > 0) return { refuse: REASON.PENDING_INPUT };
    if (afterNote) return { ok: true };
    const remaining = (composer.lastInputAt || 0) + helpers.getQuietMs() - clock();
    return remaining > 0 ? { wait: remaining } : { ok: true };
  }

  async function stopWhenEligible(state, afterNote) {
    const { env } = state;
    let waited = false;
    for (;;) {
      if (clock() >= env.deadline) return waited ? refusal(state, REASON.NOT_QUIET) : refusal(state, REASON.TIMEOUT);
      const sample = sampleStop(state, afterNote);
      if (sample.refuse) return refusal(state, sample.refuse, sample.delivery ? { error: 'not sent' } : {});
      if (sample.wait > 0) {
        waited = true;
        await sleep(Math.max(1, Math.min(sample.wait, 100, env.deadline - clock())));
        continue;
      }
      const final = sampleStop(state, afterNote);
      if (final.ok) return null;
      if (final.refuse) return refusal(state, final.refuse);
      waited = true;
    }
  }

  async function performStop(state) {
    const { entry, env } = state;
    const session = entry.session;
    if (!targetIntact(state)) return refusal(state, REASON.CHANGED);
    claim(state, 'stop-requested');
    let result;
    try { result = await deps.stopSession(entry.tabKey ?? state.requestedId, session); }
    catch (err) { result = { ok: false, error: err.message }; }
    if (!result || !result.ok) return refusal(state, REASON.STOP_FAILED, { error: result?.error || 'stop failed' });
    while (!session.exited) {
      if (clock() >= env.deadline) return refusal(state, REASON.STOP_UNCONFIRMED, { uncertain: true });
      await sleep(Math.max(1, Math.min(50, env.deadline - clock())));
    }
    return success(state, 'closed');
  }

  async function runStop(state, entry, id) {
    const guard = cwdGuard(state, entry.cwd);
    if (guard) return guard;
    const pinFailure = await pin(state, entry, id);
    if (pinFailure) return pinFailure;
    const ready = await bridge.waitReady({ deadline: state.env.deadline });
    if (!ready.ok) return refusal(state, ready.reason);
    const tabKey = entry.tabKey ?? id;
    if (state.req.before === undefined) {
      const gate = await stopWhenEligible(state, null);
      if (gate) return gate;
      if (!claim(state, 'claimed', { mode: 'stop', tabKey })) return refusal(state, REASON.MARKER);
      return performStop(state);
    }
    if (!claim(state, 'claimed', { mode: 'stop', tabKey })) return refusal(state, REASON.MARKER);
    const refused = await admitDelivery(state);
    if (refused) return refusal(state, REASON.NOTE_UNFINISHED, { error: 'not sent', delivery: { reason: refused.message } });
    const d = await deliver(state, state.req.before, { finalTurn: true });
    if (!d.ok) return promptFailure(state, d, { note: true });
    Object.assign(state.out, evidenceOf(d));
    if (entry.session.exited) return success(state, 'closed');
    const gate = await stopWhenEligible(state, { source: d.source, stamp: d.stamp ?? -Infinity });
    if (gate) return gate;
    return performStop(state);
  }

  async function runExisting(state) {
    const { req, env } = state;
    const id = req.sessionId;
    state.requestedId = id;
    state.out.sessionId = id;
    const lock = await env.acquireSessionLock(id, env.deadline);
    if (!lock) return refusal(state, REASON.TIMEOUT);
    state.release.push(lock);
    const stale = env.staleCheck();
    if (stale) return refusal(state, stale, { error: 'not sent' });
    const found = await findOpen(state, id);
    if (found.result) return found.result;
    if (found.entry) return req.action === 'stop' ? runStop(state, found.entry, id) : runOpen(state, found.entry, id);
    if (req.action === 'open') return runResume(state, id);
    let remote = false;
    try { remote = deps.isRemoteTarget ? await deps.isRemoteTarget(id) : false; } catch { return refusal(state, REASON.LIVENESS); }
    if (remote) return refusal(state, REASON.REMOTE);
    const live = await liveGate(state, id);
    if (live) return live;
    const closed = await deps.resolveClosed(id, { deadline: env.deadline });
    if (closed.status === 'remote') return refusal(state, REASON.REMOTE);
    return notFound(state, closed.status === 'unknown' ? REASON.NOT_FOUND : REASON.NOT_OPEN);
  }

  async function run(req, env) {
    const state = { req, env, release: [], out: {
      version: 1, action: req.action, ok: false, outcome: 'refused', reason: null,
      sessionId: req.sessionId ?? null,
      ...(req.action === 'open' ? (req.new ? { created: false } : { resumed: false }) : {}),
      submitted: 'no', wrote: false, steps_total: hasPrompt(req) ? 1 : 0,
    } };
    try {
      return await (req.action === 'open' && req.new ? runNew(state) : runExisting(state));
    } catch (err) {
      return refusal(state, `internal error: ${err && err.message}`);
    } finally {
      for (const release of state.release.reverse()) { try { release(); } catch {} }
    }
  }

  return { run, limiter };
}

module.exports = { validateTriggerAction, validationResult, createNewSessionLimiter, checkProject, resolveClosedTarget, createTriggerActions, REASON };
