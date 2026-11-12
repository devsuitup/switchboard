'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { operationId } = require('./project-delete-progress');
const { membershipDigest, stable, isRecord, text, fail, OPTION_KEYS } = require('./project-delete-identity');

function createProjectDeleteService(deps) {
  const { writer, planner, inventory, stop, gate, now = Date.now, schedule = setTimeout, cancel = clearTimeout } = deps;
  const tokens = new Map(), operations = new Map(), projects = new Map(), tasks = new Set();
  const boot = randomUUID();
  let ready = false, disposed = false, initializing;
  const valid = sender => !disposed && sender?.valid?.() === true;
  const failure = (code, extra = {}) => ({ ok: false, code, partial: false, completed: [], kept: [], failed: [], skipped: [], stopped: [], retryable: false, ...extra });
  const track = promise => { tasks.add(promise); promise.finally(() => tasks.delete(promise)).catch(() => {}); return promise; };
  function prune() {
    for (const [key, value] of tokens) if (now() - value.created >= 300000 || !valid(value.sender)) tokens.delete(key);
    const terminal = [...operations.values()].filter(op => op.released).sort((a, b) => a.finished - b.finished);
    for (const op of terminal) if (now() - op.finished >= 86400000 || terminal.length > 128 && terminal.indexOf(op) < terminal.length - 128) operations.delete(op.id);
  }
  const inputKeys = (input, keys) => isRecord(input) && Object.keys(input).length === keys.length
    && keys.every(key => text(input[key]));
  const binding = op => ({ project: op.project, operationId: op.id, expectedProjectEpoch: op.epoch });
  async function bounded(fn, ms = 10000) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = schedule(() => reject(fail('READ_TIMEOUT', 'Readback unavailable.')), ms);
      })]);
    } finally { cancel(timer); }
  }
  async function reply(op, work) {
    let timer;
    try {
      const result = await Promise.race([work, new Promise(resolve => {
        timer = schedule(() => resolve(view(op)), deps.replyTimeoutMs ?? 15000);
      })]);
      return structuredClone(result);
    } finally { cancel(timer); }
  }
  function view(op) {
    return { ...failure('UNKNOWN'), operationId: op.id, state: 'unknown', ...op.result,
      stopped: structuredClone(op.stopped), ...(op.historyUnknown ? { stoppedHistoryUnknown: true } : {}) };
  }
  function acquire(op) {
    op.launch = gate.hold(op.project.projectPath, op.project.alias);
    try { op.archive = writer.reserveProjectDeletion([op.project]); }
    catch (error) { op.launch.release(); op.launch = null; throw error; }
    op.admission = Promise.all([op.launch.ready, op.archive.ready]);
  }
  async function release(op) {
    if (op.released) return;
    await op.admission;
    op.archive?.release(); op.launch?.release();
    op.releaseRuntime?.(); op.releaseRuntime = null;
    op.released = true; op.finished = op.historicalFinished ?? now();
    if (projects.get(op.project.key) === op) projects.delete(op.project.key);
    prune();
  }
  async function preview(sender, request) {
    if (!valid(sender)) return failure('UNAUTHORIZED', { token: null });
    if (!ready) return failure('NOT_READY', { token: null });
    prune();
    try {
      const result = await planner.preview(request);
      if (!result.ok) return { ...result, token: null };
      const plan = structuredClone(result.plan);
      if (plan.refusals.length) return { ...result, token: null };
      const scope = await bounded(() => writer.readProjectDeletionScope({ project: plan.project }));
      if (String(scope.writerRevision) !== plan.revision) return failure('SNAPSHOT_STALE', { token: null, refresh: true });
      if (!valid(sender)) return failure('UNAUTHORIZED', { token: null });
      prune();
      if (tokens.size >= 32) return failure('TOKEN_LIMIT', { token: null });
      const token = (deps.randomToken || (() => randomBytes(32).toString('hex')))();
      const options = Object.fromEntries(OPTION_KEYS.map(key => [key, plan.categories[key].selected]));
      tokens.set(token, { sender, boot, plan, options, epoch: scope.projectEpoch, created: now() });
      return { ...result, token };
    } catch (error) { return failure(error.code || 'DISCOVERY_UNAVAILABLE', { token: null, error: error.message }); }
  }
  function stopRequest(plan, options) {
    const conversations = new Map(), targets = new Map(), targetMembers = new Map();
    for (const row of [...plan.members, ...plan.tabs, ...plan.jobs]) {
      const id = row.conversationId || row.id;
      if (!conversations.has(id)) conversations.set(id, new Set());
      const ids = row.sessionIds || [row.sessionId || row.id];
      for (const sessionId of ids) conversations.get(id).add(sessionId);
      if (row.liveness?.state === 'running') {
        const key = stable([row.liveness.targetId, id]);
        if (!targetMembers.has(key)) targetMembers.set(key, new Set());
        for (const sessionId of ids) targetMembers.get(key).add(sessionId);
      }
    }
    for (const row of plan.stops) {
      const evidence = row.evidence, kind = evidence.source === 'job' ? 'job' : evidence.source === 'remote' ? 'remote' : 'pty';
      const conversationId = row.conversationId || row.id;
      const target = { id: row.targetId, kind, conversationId, sessionIds: [...(targetMembers.get(stable([row.targetId, conversationId])) || [])].sort(),
        identity: evidence.identity, sessionKey: evidence.sessionKey || row.targetId,
        ...(kind === 'job' ? { jobId: row.jobId || row.targetId } : {}),
        ...(row.scheduleId ? { scheduleId: row.scheduleId, claimId: evidence.claimId } : {}) };
      const old = targets.get(target.id);
      if (old && stable(old) !== stable(target)) throw fail('STOP_IDENTITY', 'Conflicting stop identities.');
      targets.set(target.id, target);
    }
    return { project: plan.project, targets: [...targets.values()], stopBackgroundJobs: options.stopBackgroundJobs,
      conversations: [...conversations].map(([id, ids]) => ({ id, sessionIds: [...ids].sort() })) };
  }
  function acceptedInventory(op, plan) {
    if (!plan || plan.refusals.length || plan.stops.length) return null;
    const result = Object.fromEntries(['groups', 'members', 'tabs', 'jobs', 'schedules'].map(key => [key, structuredClone(plan[key])]));
    for (const kind of ['tabs', 'jobs']) for (const row of op.plan[kind]) {
      if (result[kind].some(item => item.id === row.id)) continue;
      const pinned = op.plan.stops.find(target => target.id === row.id && target.kind === (kind === 'tabs' ? 'tab' : 'job'));
      if (pinned && op.stopped.some(target => target.id === pinned.targetId && target.effect === 'proven-dead')) result[kind].push(row);
    }
    return membershipDigest(op.project, result) === op.plan.membershipDigest ? result : null;
  }
  async function retained(op) {
    if (!op.plan) return { historicalFileManifestUnknown: true };
    const files = [...new Set([...op.plan.members.map(row => row.sessionFile), ...op.plan.schedules.map(row => row.path)].filter(text))];
    const controller = new AbortController();
    try { return { retainedFiles: await bounded(() => inventory.inspectRetainedFiles(files,
      { signal: controller.signal, deadline: now() + 10000, limit: 20000 })) }; }
    catch (error) { return { refresh: true, readbackWarning: error.message }; }
    finally { controller.abort(); }
  }
  async function acceptState(op, state) {
    const committed = state.state === 'committed' && state.receiptAvailable === true && state.terminal === true && state.invalidation;
    const known = state.receiptAvailable === true && state.terminal === true && ['partial', 'notStarted'].includes(state.state);
    op.result = { ...failure('UNKNOWN'), operationId: op.id, state: committed ? 'committed' : known ? state.state : 'unknown',
      ok: !!committed, partial: known && state.state === 'partial', retryable: false,
      completed: state.completed || [], kept: state.kept || [], failed: state.failed || [], skipped: state.remaining || [],
      observations: { projectHidden: state.projectHidden, settingsPresent: state.settingsPresent, metadata: state.metadata, readRevision: state.readRevision },
      ...(committed ? { code: undefined, invalidation: structuredClone(state.invalidation) } : {}),
      ...(known ? { code: state.state === 'partial' ? 'PARTIAL' : 'NOT_STARTED', refresh: true } : {}) };
    if (state.terminal || state.noLateCommit) await release(op);
    if (committed) {
      for (const name of ['notifyProjects', 'notifySchedules']) {
        const key = name + ':' + state.committedRevision;
        if (op.notified.has(key)) continue;
        op.notified.add(key);
        try { await bounded(() => deps[name]?.(structuredClone(state.invalidation), op.id,
          { operationId: op.id, expectedProjectEpoch: op.epoch, committedRevision: state.committedRevision })); }
        catch (error) { op.result.refresh = true; op.result.notificationWarning = error.message; }
      }
    }
    Object.assign(op.result, await retained(op));
    op.resultReady = op.released;
    return view(op);
  }
  async function observe(op) {
    let lastProgress = now(), nextUnit = -1, lastRevision = -1, delay = 100;
    for (;;) {
      const state = await bounded(() => writer.getProjectDeletionState(binding(op)));
      if (op.released || state.terminal || state.noLateCommit || !['absent', 'inProgress'].includes(state.state)) return state;
      if (state.nextUnit > nextUnit || state.lastRevision > lastRevision) {
        nextUnit = Math.max(nextUnit, state.nextUnit ?? -1);
        lastRevision = Math.max(lastRevision, state.lastRevision ?? -1);
        lastProgress = now(); delay = 100;
      }
      const remaining = 60000 - (now() - lastProgress);
      if (remaining <= 0) return state;
      await new Promise(resolve => schedule(resolve, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, 2000);
    }
  }
  async function reconcile(op) {
    if (op.reconciling) return op.reconciling;
    op.reconciling = (async () => {
      try {
        await op.admission;
        let state, readError;
        try { state = await observe(op); }
        catch (error) { state = null; readError = error; }
        if ((!state || !state.terminal && !state.noLateCommit) && !op.released) {
          try { state = await bounded(() => writer.fenceProjectDeletion(binding(op))); }
          catch { Object.assign(op.result ||= {}, await retained(op)); return view(op); }
        }
        if (state) return await acceptState(op, state);
        Object.assign(op.result ||= {}, await retained(op), { refresh: true, readbackWarning: readError?.message || 'Fresh observation unavailable.' });
        return view(op);
      } catch (error) { op.result = { ...failure('UNKNOWN'), error: error.message, state: 'unknown' }; return view(op); }
      finally { op.reconciling = null; }
    })();
    return op.reconciling;
  }
  async function run(op) {
    try {
      await op.admission;
      const before = await planner.revalidate(op.plan);
      const scope = await bounded(() => writer.readProjectDeletionScope({ project: op.project }));
      if (!before.same || scope.projectEpoch !== op.epoch || String(scope.writerRevision) !== before.plan?.revision) throw fail('PREVIEW_CHANGED', 'Fresh preview required.');
      const prepared = await stop.preflight(stopRequest(op.plan, op.options));
      const stopped = prepared.ok ? await stop.stop(prepared) : prepared;
      op.stopped = [...stopped.stopped, ...stopped.failed.filter(row => row.effect && row.effect !== 'none')];
      if (!stopped.ok) {
        op.result = { ...failure('STOP_FAILED'), state: 'notStarted', failed: stopped.failed, skipped: stopped.skipped, refresh: true };
        return view(op);
      }
      const after = await planner.revalidate(op.plan);
      if (!after.plan) throw fail('REVALIDATION_UNAVAILABLE', after.error || 'Post-stop inventory read unavailable.');
      let manifestInventory = acceptedInventory(op, after.plan);
      if (!manifestInventory || !(await stop.verify(prepared)).ok) throw fail('PREVIEW_CHANGED', 'Post-stop ownership changed.');
      const fresh = await bounded(() => writer.readProjectDeletionScope({ project: op.project }));
      const final = await planner.revalidate(op.plan);
      if (!final.plan) throw fail('REVALIDATION_UNAVAILABLE', final.error || 'Final inventory read unavailable.');
      manifestInventory = acceptedInventory(op, final.plan);
      if (!manifestInventory || fresh.projectEpoch !== op.epoch || String(fresh.writerRevision) !== final.plan.revision
        || !(await stop.verify(prepared)).ok) throw fail('PREVIEW_CHANGED', 'Ownership changed during final scope read.');
      const manifest = { ...binding(op), expectedRevision: fresh.writerRevision, writerMembershipDigest: fresh.writerMembershipDigest,
        membershipDigest: op.plan.membershipDigest, inventory: manifestInventory, groups: manifestInventory.groups, members: manifestInventory.members, options: op.options };
      op.submitted = true;
      try { return await acceptState(op, await bounded(() => writer.completeProjectDeletion(manifest), 60000)); }
      catch { return await reconcile(op); }
    } catch (error) {
      op.result = { ...failure(error.code || 'DELETE_UNAVAILABLE'), error: error.message, state: 'notStarted', refresh: true };
      return view(op);
    } finally {
      op.running = false;
      if (!op.submitted) await release(op);
    }
  }
  function execute(sender, input) {
    if (!inputKeys(input, ['token', 'fingerprint'])) return Promise.resolve(failure('INVALID_REQUEST'));
    const token = tokens.get(input.token);
    if (!token || token.boot !== boot) return Promise.resolve(failure('INVALID_TOKEN'));
    if (!valid(sender) || token.sender !== sender) return Promise.resolve(failure('UNAUTHORIZED'));
    if (now() - token.created >= 300000 || input.fingerprint !== token.plan.fingerprint) return Promise.resolve(failure('INVALID_TOKEN'));
    tokens.delete(input.token); prune();
    const busy = projects.get(token.plan.project.key);
    if (busy) { busy.authorities.add(sender); return Promise.resolve(failure('BUSY', { operationId: busy.id })); }
    if ([...operations.values()].filter(op => !op.released).length >= 32) return Promise.resolve(failure('OPERATION_LIMIT'));
    let id;
    try { id = operationId(token.plan.project, token.epoch, (deps.randomUUID || randomUUID)()); }
    catch (error) { return Promise.resolve(failure(error.code || 'DELETION_ID')); }
    const op = { id, project: token.plan.project,
      epoch: token.epoch, plan: token.plan, options: token.options, stopped: [], authorities: new Set([sender]), notified: new Set(), running: true,
      releaseRuntime: deps.captureRuntimeRelease?.() };
    operations.set(op.id, op); projects.set(op.project.key, op);
    try { acquire(op); }
    catch (error) {
      projects.delete(op.project.key); operations.delete(op.id);
      return Promise.resolve(failure(error.code || 'BUSY'));
    }
    return reply(op, track(run(op)));
  }
  function readState(sender, input) {
    if (!inputKeys(input, ['operationId'])) return Promise.resolve(failure('INVALID_REQUEST'));
    prune();
    const op = operations.get(input.operationId);
    if (!valid(sender) || !op?.authorities.has(sender)) return Promise.resolve(failure('UNAUTHORIZED'));
    if (op.running || op.released && (!op.submitted || op.resultReady)) return Promise.resolve(structuredClone(view(op)));
    return reply(op, track(reconcile(op)));
  }
  function rebind(sender) {
    if (!valid(sender)) return [];
    prune();
    for (const op of operations.values()) { op.authorities.clear(); op.authorities.add(sender); }
    return [...operations.keys()];
  }
  function initialize() {
    if (initializing) return initializing;
    initializing = track((async () => {
      let cursor = null, revision, count = 0;
      const recovered = [];
      do {
        const page = await bounded(() => writer.listProjectDeletionOperations({ cursor, expectedRevision: revision, limit: 64, maxBytes: 1048576 }));
        revision = page.revision;
        for (const row of page.rows) {
          if (++count > 4096) throw fail('RECOVERY_LIMIT', 'Receipt enumeration limit.');
          if (operations.has(row.operationId) || row.sealed && now() - row.finishedAt >= 86400000) continue;
          const [alias, projectPath] = JSON.parse(row.projectKey);
          const op = { id: row.operationId, project: { alias, projectPath, key: row.projectKey }, epoch: row.expectedEpoch,
            options: JSON.parse(row.optionsJson), historicalFinished: row.finishedAt, stopped: [], historyUnknown: true,
            submitted: true, released: !!row.sealed, finished: row.finishedAt, authorities: new Set(), notified: new Set() };
          recovered.push(op);
        }
        if (page.nextCursor !== null && page.nextCursor === cursor) throw fail('RECOVERY_LIMIT', 'Receipt enumeration did not advance.');
        cursor = page.nextCursor;
      } while (cursor !== null);
      for (const op of recovered) {
        if (!op.released) {
          if ([...operations.values()].filter(value => !value.released).length >= 32) throw fail('OPERATION_LIMIT', 'Resolve retained operations before recovering more.');
          acquire(op); projects.set(op.project.key, op);
        }
        operations.set(op.id, op);
      }
      deps.onHoldsInstalled?.();
      for (const op of recovered) await reconcile(op);
      ready = true; prune();
    })());
    initializing.catch(() => { initializing = null; });
    return initializing;
  }
  return { preview, execute, readState, rebind, initialize,
    async whenIdle() { await Promise.all([...tasks]); },
    async recover() {
      const retained = [...operations.values()].filter(op => !op.running && !op.released);
      if (!initializing) for (const op of retained) await reconcile(op);
      await initialize();
      deps.onHoldsInstalled?.();
      for (const op of retained) if (!op.released) await reconcile(op);
    },
    dispose() { disposed = true; tokens.clear(); for (const op of operations.values()) op.authorities.clear(); } };
}

module.exports = { createProjectDeleteService };
