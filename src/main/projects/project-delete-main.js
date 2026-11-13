'use strict';

const fs = require('node:fs/promises');
const { createDiscoveryBounds, closeDiscoveryHandle } = require('./project-delete-deadline');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createProjectDeleteInventory } = require('./project-delete-inventory');
const { createProjectDeletePlanner } = require('./project-delete-plan');
const { createProjectDeleteStop } = require('./project-delete-stop');
const { createProjectDeleteService } = require('./project-delete');
const { registerProjectDeleteIpc } = require('./project-delete-ipc');
const { parseJobState, parseCliList, JOB_ID_RE } = require('../bg-agents/bg-agents-roster');
const { stopPtyWithEvidence, detachPty } = require('../terminals/pty-ops');
const { fail } = require('./project-delete-identity');

const RECOVERY_TIMEOUT_MS = 4096 * 30000 + 65 * 10000 + 32 * 80000;
const HOLDS_TIMEOUT_MS = 120000;

function createProjectDeleteRuntime(ports) {
  const io = ports.fs || fs, now = ports.now || Date.now;
  const schedule = ports.schedule || setTimeout, cancel = ports.cancel || clearTimeout;
  const scopes = new AsyncLocalStorage();
  const captureRuntimeRelease = () => {
    const scope = scopes.getStore();
    return () => { scope?.members.clear(); scope?.pins.clear(); };
  };
  const withScope = (fn, retain = false) => scopes.run({ members: new Map(), pins: new Map() }, () => {
    const release = captureRuntimeRelease(), work = Promise.resolve(fn());
    return retain ? work : work.finally(release);
  });
  const normalize = value => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)).replaceAll('\\', '/');
  const bounded = createDiscoveryBounds({ now, schedule, cancel });
  async function readJobs(project, budget) {
    if (project.alias !== null) throw fail('DISCOVERY_UNAVAILABLE', 'Remote background inventory has no exhaustive read port.');
    const jobs = [], candidates = [], records = new Map();
    let directory, count = 0, bytes = 0;
    try {
      if ((await bounded('fs.lstat', () => io.lstat(ports.jobsDir), budget)).isSymbolicLink()) throw fail('DISCOVERY_CANDIDATE', 'Linked job directory.');
      directory = await bounded('fs.opendir', () => io.opendir(ports.jobsDir), budget, late => late.close());
      for (;;) {
        const entry = await bounded('fs.directory.read', () => directory.read(), budget);
        if (!entry) break;
        if (++count > Math.min(budget.limit, 20000)) throw fail('DISCOVERY_LIMIT', 'Too many background records.');
        if (!JOB_ID_RE.test(entry.name)) { candidates.push({ id: entry.name, reason: 'Unrecognized background record.' }); continue; }
        if (!entry.isDirectory() || entry.isSymbolicLink()) { candidates.push({ id: entry.name, reason: 'Linked or unreadable background record.' }); continue; }
        const file = path.join(ports.jobsDir, entry.name, 'state.json');
        let handle;
        try {
          const stat = await bounded('fs.lstat', () => io.lstat(file), budget);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576 || (bytes += stat.size) > 8 * 1048576) throw fail('DISCOVERY_LIMIT', 'Background record exceeds budget.');
          handle = await bounded('fs.open', () => io.open(file, 'r'), budget, late => late.close());
          const buffer = Buffer.alloc(stat.size + 1);
          const read = await bounded('fs.file.read', () => handle.read(buffer, 0, buffer.length, 0), budget);
          if (read.bytesRead !== stat.size) throw fail('SNAPSHOT_STALE', 'Background record changed.');
          const text = buffer.subarray(0, read.bytesRead).toString('utf8'), parsed = parseJobState(text);
          if (!parsed?.state) throw fail('DISCOVERY_CANDIDATE', 'Unreadable background state.');
          records.set(entry.name, { ...parsed, cwd: JSON.parse(text).cwd });
        } catch (error) {
          if (error.code === 'DISCOVERY_TIMEOUT') throw error;
          candidates.push({ id: entry.name, reason: error.message });
        }
        finally { await closeDiscoveryHandle('fs.file.close', handle, budget, { now, schedule, cancel }); }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally { await closeDiscoveryHandle('fs.directory.close', directory, budget, { now, schedule, cancel }); }
    const result = await bounded('runClaude.agents', () => ports.runClaude(['agents', '--json', '--all'],
      { cwd: ports.homeDir, timeout: Math.max(1, budget.deadline - now()), maxOutputBytes: 8 * 1048576 }), budget);
    if (result.code !== 0 || Buffer.byteLength(result.stdout || '') > 8 * 1048576) throw fail('DISCOVERY_UNAVAILABLE', 'Authoritative background list unavailable.');
    const listed = parseCliList(result.stdout);
    let raw;
    try { raw = JSON.parse(result.stdout); } catch {}
    if (!Array.isArray(raw) || !listed || listed.length !== raw.length
      || listed.length + count > Math.min(budget.limit, 20000)) throw fail('DISCOVERY_LIMIT', 'Background list invalid or oversized.');
    for (const row of listed.filter(row => row.kind === 'background')) {
      if (!row.id || !records.has(row.id)) candidates.push({ id: row.id || row.sessionId, reason: 'Background list has no durable job record.' });
      else records.set(row.id, { ...records.get(row.id), cwd: row.cwd || records.get(row.id).cwd });
    }
    const root = await bounded('fs.realpath', () => io.realpath(project.projectPath), budget);
    for (const [id, row] of records) {
      if (!row.cwd || !path.isAbsolute(row.cwd) || !row.sessionId) { candidates.push({ id, reason: 'Background ownership unavailable.' }); continue; }
      let cwd;
      try { cwd = row.cwd === project.projectPath ? root : await bounded('fs.realpath', () => io.realpath(row.cwd), budget); }
      catch (error) {
        if (error.code === 'DISCOVERY_TIMEOUT') throw error;
        if (error.code !== 'ENOENT') candidates.push({ id, reason: error.message });
        continue;
      }
      if (normalize(cwd) !== normalize(root)) continue;
      jobs.push({ id, jobId: id, alias: null, projectPath: root, runtime: 'claude', verified: true,
        conversationId: row.sessionId, sessionIds: [row.sessionId], liveness: { state: 'unknown', source: 'job' } });
      candidates.push({ id, reason: 'Background deletion awaits worker-incarnation control (#1090).' });
    }
    return { complete: true, jobs, candidates };
  }
  const sessionsFor = id => [...ports.activeSessions].filter(([key, session]) =>
    [key, session.sessionId, session.realSessionId].includes(id));
  async function readLiveness(row, budget) {
    const scope = scopes.getStore();
    if (!scope) throw fail('DISCOVERY_UNAVAILABLE', 'Runtime operation scope unavailable.');
    const { members, pins } = scope;
    if (members.size >= 50000 && !members.has(row.id)) throw fail('DISCOVERY_LIMIT', 'Runtime identity limit.');
    members.set(row.id, row);
    if (row.alias !== null || row.runtime === 'codex' || row.jobId) return { state: 'unknown' };
    const matches = sessionsFor(row.sessionId || row.id);
    if (matches.length > 1) return { state: 'unknown' };
    const previous = pins.get(row.id);
    const [sessionKey, session] = matches[0] || (previous ? [previous.key, previous.session] : []);
    if (session) {
      if (session.kind !== 'local-pty' || session.isAttach || session.host || !session.statusPtyStart || !session.pty?.pid) return { state: 'unknown' };
      const identity = { pid: session.pty.pid, procStart: session.statusPtyStart, generation: session.generation };
      const pin = { key: sessionKey, session, identity };
      pins.set(row.id, pin);
      if (!session.exited && matches.length) {
        if (row.runtime !== 'terminal') {
          const external = await bounded('cliSessionState.liveElsewhereV1Checked', () => ports.cliSessionState.liveElsewhereV1Checked(row.sessionId || row.id,
            () => false, () => [identity.pid], { deadline: budget.deadline, requireUnique: true }), budget);
          if (!external?.known || external.live || ports.cliSessionState.deliveryPtyStart(identity.pid) !== identity.procStart) return { state: 'unknown' };
        }
        return { state: 'running', source: 'pty', targetId: sessionKey, sessionKey, identity };
      }
      let proof = await bounded('pty.stopEvidence', () => session.pty.stopEvidence, budget);
      if (proof?.ended !== true) proof = await bounded('pty.statusTreeExit', () => session.pty.statusTreeExit, budget);
      if (proof?.ended !== true || proof.pid !== undefined && proof.pid !== identity.pid
        || proof.generation !== undefined && proof.generation !== identity.generation) return { state: 'unknown' };
    }
    if (row.runtime === 'terminal') return session ? { state: 'stopped', source: 'pty' } : { state: 'unknown' };
    const evidence = await bounded('cliSessionState.readStatusEvidence', () => ports.cliSessionState.readStatusEvidence(row.sessionId || row.id, budget.deadline), budget);
    return evidence?.known && !evidence.live && !evidence.ambiguous
      ? { state: 'stopped', source: 'descriptor' } : { state: 'unknown', source: 'external' };
  }
  async function readTarget(target) {
    const session = ports.activeSessions.get(target.sessionKey);
    if (!session || target.kind !== 'pty') return null;
    return { ...target, identity: { pid: session.pty?.pid, procStart: session.statusPtyStart, generation: session.generation },
      session, supported: true, attachments: [] };
  }
  async function readConversation(conversation) {
    const scope = scopes.getStore();
    if (!scope) throw fail('DISCOVERY_UNAVAILABLE', 'Runtime operation scope unavailable.');
    const { members, pins } = scope;
    const owners = [], budget = { deadline: now() + 10000 };
    for (const id of conversation.sessionIds) {
      const row = members.get(id);
      if (!row) return { known: false };
      const live = await readLiveness(row, budget), pin = pins.get(id);
      if (!['running', 'stopped'].includes(live.state)) return { known: false };
      if (pin && !owners.some(owner => owner.id === pin.key)) owners.push({ id: pin.key, identity: pin.identity, treeState: live.state === 'running' ? 'live' : 'dead' });
    }
    return { known: true, complete: true, owners };
  }
  return { readJobs, readLiveness, readTarget, readConversation, withScope, captureRuntimeRelease,
    getScheduleRunSnapshot: () => ports.cliSessionState.getScheduleRunSnapshot(),
    bg: ports.bg, remote: ports.remote,
    detach: attachment => detachPty(attachment.session, attachment.sessionKey),
    stopPtyWithEvidence: ports.stopPtyWithEvidence || stopPtyWithEvidence };
}

function createProjectDeleteMain(deps) {
  const { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = deps;
  const clock = { now, schedule, cancel }, bindings = new Map();
  const delivered = deps.notificationState ||= new Map();
  const writer = { ...deps.writer,
    async listProjectDeletionOperations(input) {
      const page = await deps.writer.listProjectDeletionOperations(input);
      for (const row of page.rows) {
        const [alias, projectPath] = JSON.parse(row.projectKey);
        bindings.set(row.operationId, { project: { alias, projectPath }, expectedProjectEpoch: row.expectedEpoch });
      }
      return page;
    },
    completeProjectDeletion(input) {
      bindings.set(input.operationId, { project: input.project, expectedProjectEpoch: input.expectedProjectEpoch });
      return deps.writer.completeProjectDeletion(input);
    } };
  const notify = kind => async (invalidation, id, change) => {
    const binding = bindings.get(id);
    if (!binding || change?.operationId !== id || change.expectedProjectEpoch !== binding.expectedProjectEpoch) return;
    const state = await deps.writer.getProjectDeletionState({ ...binding, operationId: id });
    if (state.state !== 'committed' || !state.terminal || !state.receiptAvailable
      || state.projectEpoch !== binding.expectedProjectEpoch + 2 || state.committedRevision !== change.committedRevision) return;
    const key = `${kind}:${id}:${change.expectedProjectEpoch}:${change.committedRevision}`;
    if (delivered.has(key)) return;
    delivered.set(key, now());
    try { deps[kind]?.(structuredClone(invalidation), id, structuredClone(change)); }
    catch (error) { delivered.delete(key); throw error; }
    for (const [old, at] of delivered) if (now() - at >= 86400000) delivered.delete(old);
  };
  const runtime = createProjectDeleteRuntime({ ...deps, ...clock });
  const inventory = createProjectDeleteInventory({ ...deps, ...runtime, ...clock, writer });
  const planner = createProjectDeletePlanner({ ...inventory, ...clock });
  const stop = createProjectDeleteStop({ ...deps, ...runtime, ...clock });
  const service = createProjectDeleteService({ ...clock, writer, inventory, planner, stop, gate: deps.gate,
    captureRuntimeRelease: runtime.captureRuntimeRelease,
    onHoldsInstalled: () => settleHolds?.(!disposed),
    notifyProjects: notify('notifyProjects'), notifySchedules: notify('notifySchedules') });
  let ready = false, disposed = false, recovery = null, pendingAttach = null, cancelRecovery, bootstrap = 0;
  let holds, settleHolds;
  const guarded = { rebind: sender => service.rebind(sender) };
  for (const method of ['preview', 'execute', 'readState']) guarded[method] = async (sender, input) => {
    const result = ready && !disposed
      ? await runtime.withScope(() => service[method](sender, input), method === 'execute')
      : { ok: false, code: 'NOT_READY', retryable: true, ...(method === 'preview' ? { token: null } : {}) };
    if (result.code === 'DISCOVERY_TIMEOUT') deps.log?.debug(`[project-delete] ${method}: ${result.port} elapsed=${result.elapsedMs}ms bound=${result.boundMs}ms`);
    return result;
  };
  const registration = registerProjectDeleteIpc({ ...deps, service: guarded });
  function startRecovery() {
    if (disposed) return Promise.resolve(false);
    if (recovery) return recovery;
    ready = false;
    let holdsOutcome;
    holds = new Promise(resolve => {
      const timer = schedule(() => settleHolds(false, `HOLDS_TIMEOUT: ${HOLDS_TIMEOUT_MS} ms elapsed.`), HOLDS_TIMEOUT_MS);
      settleHolds = (value, reason) => {
        if (holdsOutcome !== undefined) return;
        holdsOutcome = value; cancel(timer);
        if (!value && reason) deps.log?.warn('[project-delete] holds wait failed: ' + reason);
        resolve(value);
      };
    });
    recovery = (async () => {
      let timer;
      try {
        const work = async () => {
          for (;;) {
            const observed = bootstrap;
            try { await service.recover(); }
            catch (error) { if (observed === bootstrap || disposed) throw error; }
            if (observed === bootstrap || disposed) return !disposed;
          }
        };
        const result = await Promise.race([Promise.resolve().then(work), new Promise(resolve => {
          cancelRecovery = () => resolve(false);
          timer = schedule(cancelRecovery, RECOVERY_TIMEOUT_MS);
        })]);
        if (result && !disposed) { ready = true; deps.announce?.(registration.rebind() || []); }
        return result;
      } catch (error) {
        if (holdsOutcome === true) deps.log?.warn('[project-delete] recovery unavailable: ' + error.message);
        settleHolds(false, `${error.code || 'RECOVERY_UNAVAILABLE'}: ${error.message}`);
        return false;
      }
      finally { settleHolds(false); cancel(timer); cancelRecovery = null; recovery = null; }
    })();
    return recovery;
  }
  const unsubscribe = deps.onBootstrap?.(() => { bootstrap++; void startRecovery(); });
  function clearPending() {
    if (!pendingAttach) return;
    const { win, bind, closed } = pendingAttach;
    win.webContents.removeListener('did-finish-load', bind); win.removeListener('closed', closed); pendingAttach = null;
  }
  function attach(win) {
    clearPending(); registration.attach(null);
    if (disposed || !win || win !== deps.getMainWindow() || win.isDestroyed()) return;
    const bind = () => { clearPending(); registration.attach(win); };
    const closed = () => clearPending();
    pendingAttach = { win, bind, closed };
    win.webContents.once('did-finish-load', bind); win.once('closed', closed);
  }
  return { startRecovery, attach, recoveryTimeoutMs: RECOVERY_TIMEOUT_MS,
    whenHoldsInstalled() { return disposed ? Promise.resolve(false) : holds || Promise.resolve(false); },
    dispose() { disposed = true; ready = false; settleHolds?.(false); cancelRecovery?.(); clearPending(); unsubscribe?.(); registration.dispose(); service.dispose(); } };
}

module.exports = { createProjectDeleteMain, createProjectDeleteRuntime };
