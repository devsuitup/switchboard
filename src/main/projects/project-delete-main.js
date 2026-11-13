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
const { createProjectDeleteWorktrees } = require('./project-delete-worktrees');
const { parseFolderKey } = require('../remote/remote-hosts');

const RECOVERY_TIMEOUT_MS = 4096 * 30000 + 65 * 10000 + 32 * 80000;
const HOLDS_TIMEOUT_MS = 120000;

function createProjectDeleteRuntime(ports) {
  const io = ports.fs || fs, now = ports.now || Date.now;
  const schedule = ports.schedule || setTimeout, cancel = ports.cancel || clearTimeout;
  const scopes = new AsyncLocalStorage();
  const inventories = new WeakMap();
  const inventoryFor = budget => {
    const key = budget.signal || budget;
    if (!inventories.has(key)) inventories.set(key, { paths: new Map() });
    return inventories.get(key);
  };
  const resolvePath = (value, budget) => {
    const paths = inventoryFor(budget).paths;
    if (!paths.has(value)) paths.set(value, bounded('fs.realpath', () => io.realpath(value), budget));
    return paths.get(value);
  };
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
  const processReads = new WeakMap();
  function startProcessReads(request, budget) {
    if (request.folderKey && parseFolderKey(request.folderKey).alias !== null) return;
    if (!processReads.has(budget.signal)) {
      const agents = bounded('runClaude.agents', () => ports.runClaude(['agents', '--json', '--all'],
        { cwd: ports.homeDir, timeout: Math.max(1, budget.deadline - now()), signal: budget.signal, maxOutputBytes: 8 * 1048576 }), budget);
      const table = ports.cliSessionState.readProcessTableSnapshot
        ? bounded('cliSessionState.readProcessTableSnapshot',
          () => ports.cliSessionState.readProcessTableSnapshot(budget.deadline, { fresh: true, signal: budget.signal }), budget)
          .catch(() => ({ map: null })) : Promise.resolve(undefined);
      void agents.catch(() => {});
      processReads.set(budget.signal, { agents, table });
    }
  }
  async function scanJobs(budget) {
    const early = processReads.get(budget.signal);
    const agents = early?.agents || bounded('runClaude.agents', () => ports.runClaude(['agents', '--json', '--all'],
      { cwd: ports.homeDir, timeout: Math.max(1, budget.deadline - now()), signal: budget.signal, maxOutputBytes: 8 * 1048576 }), budget);
    void agents.catch(() => {});
    const candidates = [], records = new Map();
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
    const result = await agents;
    if (result.code !== 0 || Buffer.byteLength(result.stdout || '') > 8 * 1048576) throw fail('DISCOVERY_UNAVAILABLE', 'Authoritative background list unavailable.');
    const listed = parseCliList(result.stdout);
    let raw;
    try { raw = JSON.parse(result.stdout); } catch {}
    if (!Array.isArray(raw) || !listed || listed.length !== raw.length
      || listed.length + count > Math.min(budget.limit, 20000)) throw fail('DISCOVERY_LIMIT', 'Background list invalid or oversized.');
    for (const row of listed.filter(row => row.kind === 'background')) {
      if (!row.id || !records.has(row.id)) candidates.push({ id: row.id || row.sessionId, cwd: row.cwd, reason: 'Background list has no durable job record.' });
      else records.set(row.id, { ...records.get(row.id), cwd: row.cwd || records.get(row.id).cwd });
    }
    return { candidates, records };
  }
  async function readJobs(project, budget) {
    if (project.alias !== null) throw fail('DISCOVERY_UNAVAILABLE', 'Remote background inventory has no exhaustive read port.');
    const inventory = inventoryFor(budget);
    inventory.jobs ||= scanJobs(budget);
    const scanned = await inventory.jobs;
    const globalCandidates = [...scanned.candidates], candidates = [], jobs = [];
    const root = await resolvePath(project.projectPath, budget);
    const records = scanned.records;
    for (const [id, row] of records) {
      if (!row.cwd || !path.isAbsolute(row.cwd) || !row.sessionId) { globalCandidates.push({ id, cwd: row.cwd, reason: 'Background ownership unavailable.' }); continue; }
      let cwd;
      try { cwd = row.cwd === project.projectPath ? root : await resolvePath(row.cwd, budget); }
      catch (error) {
        if (error.code === 'DISCOVERY_TIMEOUT') throw error;
        if (error.code !== 'ENOENT') globalCandidates.push({ id, cwd: row.cwd, reason: error.message });
        continue;
      }
      if (normalize(cwd) !== normalize(root) && !(project.includeDescendants && normalize(cwd).startsWith(normalize(root) + '/'))) continue;
      jobs.push({ id, jobId: id, alias: null, projectPath: root, runtime: 'claude', verified: true,
        conversationId: row.sessionId, sessionIds: [row.sessionId], liveness: { state: 'unknown', source: 'job' } });
      candidates.push({ id, reason: 'Background deletion awaits worker-incarnation control (#1090).' });
    }
    return { complete: true, jobs, candidates: project.worktreeInventory ? candidates : [...globalCandidates, ...candidates], globalCandidates };
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
    const early = processReads.get(budget.signal);
    let processTable = await early?.table;
    if (processTable?.expiresAt <= now() && now() < budget.deadline) {
      early.refreshed ||= bounded('cliSessionState.readProcessTableSnapshot',
        () => ports.cliSessionState.readProcessTableSnapshot(budget.deadline, { fresh: true, signal: budget.signal }), budget);
      processTable = await early.refreshed;
    }
    const evidenceOptions = processTable === undefined ? {} : { processTable };
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
            () => false, () => [identity.pid], { deadline: budget.deadline, requireUnique: true, ...evidenceOptions }), budget);
          if (!external?.known || external.live || ports.cliSessionState.deliveryPtyStart(identity.pid, evidenceOptions) !== identity.procStart) return { state: 'unknown' };
        }
        return { state: 'running', source: 'pty', targetId: sessionKey, sessionKey, identity };
      }
      let proof = await bounded('pty.stopEvidence', () => session.pty.stopEvidence, budget);
      if (proof?.ended !== true) proof = await bounded('pty.statusTreeExit', () => session.pty.statusTreeExit, budget);
      if (proof?.ended !== true || proof.pid !== undefined && proof.pid !== identity.pid
        || proof.generation !== undefined && proof.generation !== identity.generation) return { state: 'unknown' };
    }
    if (row.runtime === 'terminal') return session ? { state: 'stopped', source: 'pty' } : { state: 'unknown' };
    const evidence = await bounded('cliSessionState.readStatusEvidence', () => ports.cliSessionState.readStatusEvidence(row.sessionId || row.id, budget.deadline, evidenceOptions), budget);
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
  async function readWorktreeActivity(project, budget) {
    if (project.alias !== null) throw fail('DISCOVERY_UNAVAILABLE', 'Remote worktree activity is unavailable.');
    const descriptors = await bounded('cliSessionState.getSidebarDescriptors', () => ports.cliSessionState.getSidebarDescriptors({ allWriters: true }), budget);
    const snapshot = budget.snapshot || await ports.readWorktreeSnapshot?.(budget);
    if (!Array.isArray(descriptors) || !Array.isArray(snapshot?.sessions) || !(ports.activeSessions instanceof Map)) {
      throw fail('DISCOVERY_UNAVAILABLE', 'Worktree session inventory is incomplete.');
    }
    const rows = [...ports.activeSessions].map(([id, row]) => ({ ...row, sessionId: row.realSessionId || row.sessionId || id, active: !row.exited }));
    rows.push(...descriptors, ...snapshot.sessions);
    if (rows.length > budget.limit) throw fail('DISCOVERY_LIMIT', 'Too many worktree sessions to inspect.');
    const runs = await bounded('cliSessionState.getScheduleRunSnapshot', () => ports.cliSessionState.getScheduleRunSnapshot(), budget);
    if (!Array.isArray(runs) || runs.length + rows.length > budget.limit) throw fail('DISCOVERY_LIMIT', 'Schedule inventory unavailable or oversized.');
    const evidenceById = new Map(), dialogCandidates = new Map();
    const descriptorRows = new Set(descriptors), scheduledRows = new Set(runs);
    let unlocatedActivity = false;
    const report = candidate => dialogCandidates.set(JSON.stringify([candidate.id, candidate.reason]), candidate);
    const local = row => !(row.host || row.remoteAlias || row.alias || parseFolderKey(row.folder || row.folderKey).alias !== null);
    const associatedPaths = row => {
      const paths = [];
      if (typeof row.projectPath === 'string' && path.isAbsolute(row.projectPath)) paths.push(row.projectPath);
      const folder = row.folder || row.folderKey;
      if (folder) for (const project of snapshot.projects || []) {
        if (project.alias === null && project.folderKeys?.includes(folder)) paths.push(project.projectPath);
      }
      return paths;
    };
    for (const row of [...rows, ...runs]) {
      const value = row.cwd;
      if (local(row) && (typeof value !== 'string' || !path.isAbsolute(value)) && !associatedPaths(row).length) {
        const id = row.sessionId || row.id;
        report({ id, reason: 'Session cwd unavailable.' });
        if (row.active || scheduledRows.has(row) || row.liveness && row.liveness.state !== 'stopped') unlocatedActivity = true;
        else if (descriptorRows.has(row)) {
          if (!id || row.runtime === 'codex') unlocatedActivity = true;
          else {
            if (!evidenceById.has(id)) evidenceById.set(id, bounded('cliSessionState.readStatusEvidence', () => ports.cliSessionState.readStatusEvidence(id, budget.deadline), budget));
            const evidence = await evidenceById.get(id);
            if (!evidence?.known || evidence.live || evidence.ambiguous) unlocatedActivity = true;
          }
        }
      }
    }
    async function forPath(projectPath) {
      const root = normalize(await resolvePath(projectPath, budget));
      const sessions = [], jobs = [], candidates = [], seen = new Set();
      const within = async row => {
        if (!local(row)) return false;
        const value = row.cwd;
        if (typeof value !== 'string' || !path.isAbsolute(value)) {
          for (const value of associatedPaths(row)) {
            const owner = normalize(await resolvePath(value, budget));
            if (owner === root || owner.startsWith(root + '/')) {
              candidates.push({ id: row.sessionId || row.id, reason: 'Session cwd unavailable.' }); break;
            }
          }
          return false;
        }
        let cwd;
        try { cwd = normalize(await resolvePath(value, budget)); }
        catch (error) {
          if (error.code !== 'ENOENT') candidates.push({ id: row.sessionId, reason: 'Session cwd unreadable.' });
          return false;
        }
        return cwd === root || cwd.startsWith(root + '/');
      };
      for (const row of rows) {
        if (!await within(row)) continue;
        const id = row.sessionId || row.id;
        if (row.active) { sessions.push({ sessionId: id, cwd: row.cwd || row.projectPath }); continue; }
        if (!id || row.runtime === 'codex') { candidates.push({ id, reason: 'Worktree runtime liveness unavailable.' }); continue; }
        if (seen.has(id)) continue;
        seen.add(id);
        if (!evidenceById.has(id)) evidenceById.set(id, bounded('cliSessionState.readStatusEvidence', () => ports.cliSessionState.readStatusEvidence(id, budget.deadline), budget));
        const evidence = await evidenceById.get(id);
        if (!evidence?.known || evidence.ambiguous) candidates.push({ id, reason: 'Worktree session liveness uncertain.' });
        else if (evidence.live) sessions.push({ sessionId: id, cwd: row.cwd || row.projectPath });
      }
      const roster = await readJobs({ ...project, projectPath, includeDescendants: true, worktreeInventory: true }, budget);
      jobs.push(...roster.jobs); candidates.push(...roster.candidates);
      let ownershipUncertain = unlocatedActivity
        && (budget.selectedWorktrees || budget.worktreePaths || []).some(value => normalize(value) === normalize(projectPath));
      for (const candidate of roster.globalCandidates) {
        report(candidate);
        if (!(budget.selectedWorktrees || budget.worktreePaths || []).some(value => normalize(value) === normalize(projectPath))) continue;
        let owner;
        if (typeof candidate.cwd === 'string' && path.isAbsolute(candidate.cwd)) {
          try { owner = normalize(await resolvePath(candidate.cwd, budget)); } catch {}
        }
        if (!owner || owner === root || owner.startsWith(root + '/')) ownershipUncertain = true;
      }
      if (runs.length + rows.length + jobs.length > budget.limit) throw fail('DISCOVERY_LIMIT', 'Schedule inventory unavailable or oversized.');
      for (const run of runs) if (await within(run)) jobs.push(run);
      return { complete: true, sessions, jobs, candidates, ownershipUncertain };
    }
    if (!project.worktreePaths) {
      const result = await forPath(project.projectPath);
      return { ...result, candidates: [...result.candidates, ...dialogCandidates.values()] };
    }
    const byPath = Object.create(null);
    for (const directory of project.worktreePaths) byPath[directory] = await forPath(directory);
    return { byPath, candidates: [...dialogCandidates.values()] };
  }
  return { startProcessReads, readJobs, readLiveness, readTarget, readConversation, readWorktreeActivity, withScope, captureRuntimeRelease,
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
  let inventory;
  const runtime = createProjectDeleteRuntime({ ...deps, ...clock, readWorktreeSnapshot: budget => inventory.readSnapshot(budget) });
  inventory = createProjectDeleteInventory({ ...deps, ...runtime, ...clock, writer });
  const worktrees = deps.worktreeGit ? createProjectDeleteWorktrees({ runGit: deps.worktreeGit, readActivity: runtime.readWorktreeActivity, now }) : null;
  const planner = createProjectDeletePlanner({ ...inventory, ...clock, worktrees });
  const stop = createProjectDeleteStop({ ...deps, ...runtime, ...clock });
  const service = createProjectDeleteService({ ...clock, writer, inventory, planner, stop, worktrees, gate: deps.gate, log: deps.log,
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
    if (method !== 'preview' && result.code === 'DISCOVERY_TIMEOUT') deps.log?.debug?.(`[project-delete] ${method}: ${result.port} elapsed=${result.elapsedMs}ms bound=${result.boundMs}ms`);
    if (method === 'execute' && result.code === 'NOT_READY') deps.log?.debug?.('[project-delete] execute operation=- state=refused reason=NOT_READY elapsed=0ms');
    return result;
  };
  const registration = registerProjectDeleteIpc({ ...deps, service: guarded });
  function startRecovery() {
    if (disposed) return Promise.resolve(false);
    if (recovery) return recovery;
    ready = false;
    const startedAt = now();
    let recoveryReason = 'RECOVERY_UNAVAILABLE';
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
          cancelRecovery = () => { recoveryReason = disposed ? 'DISPOSED' : 'RECOVERY_TIMEOUT'; resolve(false); };
          timer = schedule(cancelRecovery, RECOVERY_TIMEOUT_MS);
        })]);
        if (result && !disposed) { ready = true; recoveryReason = 'READY'; deps.announce?.(registration.rebind() || []); }
        return result;
      } catch (error) {
        recoveryReason = error.code || 'RECOVERY_UNAVAILABLE';
        if (holdsOutcome === true) deps.log?.warn('[project-delete] recovery unavailable: ' + error.message);
        settleHolds(false, `${error.code || 'RECOVERY_UNAVAILABLE'}: ${error.message}`);
        return false;
      }
      finally {
        settleHolds(false); cancel(timer); cancelRecovery = null; recovery = null;
        deps.log?.debug?.(`[project-delete] recovery operation=- state=${ready ? 'ready' : 'unavailable'} reason=${recoveryReason} elapsed=${now() - startedAt}ms`);
      }
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
