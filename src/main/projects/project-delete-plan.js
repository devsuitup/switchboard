'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeProjectPath } = require('../shared/normalize-project-path');
const { parseFolderKey, isValidAlias } = require('../remote/remote-hosts');
const { worktreeParentPath } = require('../../../public/worktree-nesting');

const OPTION_KEYS = ['sessions', 'settings', 'schedules', 'transcripts', 'stopBackgroundJobs'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const fail = (code, error) => Object.assign(new Error(error), { code });

function canonicalPath(value, alias) {
  if (!text(value)) throw fail('IDENTITY_UNAVAILABLE', 'A known absolute project path is required.');
  if (alias !== null) {
    if (!isValidAlias(alias) || !path.posix.isAbsolute(value)) throw fail('IDENTITY_UNAVAILABLE', 'Remote identity is unavailable.');
    return path.posix.normalize(value).replace(/\/$/, '') || '/';
  }
  if (!path.isAbsolute(value)) throw fail('IDENTITY_UNAVAILABLE', 'A local absolute path is required.');
  const normalized = normalizeProjectPath(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function identity(value) {
  if (!isRecord(value) || !Object.hasOwn(value, 'alias')) throw fail('IDENTITY_UNAVAILABLE', 'Ownership must include an explicit host.');
  const alias = value.alias;
  const projectPath = canonicalPath(value.projectPath, alias);
  return { key: JSON.stringify([alias, projectPath]), entry: alias === null ? path.resolve(value.projectPath) : `${alias}::${projectPath}`, alias, projectPath };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const ordered = values => values.sort((a, b) => stable(a).localeCompare(stable(b), 'en'));

function validateRequest(request) {
  if (!isRecord(request) || Object.keys(request).some(key => !['projectPath', 'folderKey', 'options'].includes(key))
    || !text(request.projectPath) || (request.folderKey !== undefined && !text(request.folderKey))
    || !isRecord(request.options) || Object.keys(request.options).length !== OPTION_KEYS.length
    || Object.keys(request.options).some(key => !OPTION_KEYS.includes(key))
    || OPTION_KEYS.some(key => !Object.hasOwn(request.options, key) || typeof request.options[key] !== 'boolean')
    || request.options.schedules || request.options.transcripts) {
    throw fail('INVALID_REQUEST', 'Use the five explicit boolean A4 options; physical deletion is unavailable.');
  }
}

function resolveProject(request, snapshot, boundKey) {
  const known = snapshot.projects.map(row => ({ row, project: identity(row) }));
  let matches;
  if (boundKey !== undefined) {
    matches = known.filter(item => item.project.key === boundKey);
  } else if (request.folderKey === undefined) {
    const key = identity({ projectPath: request.projectPath, alias: null }).key;
    matches = known.filter(item => item.project.key === key);
  } else {
    const mappings = known.filter(item => Array.isArray(item.row.folderKeys) && item.row.folderKeys.includes(request.folderKey));
    const hintedAlias = parseFolderKey(request.folderKey).alias;
    const key = identity({ projectPath: request.projectPath, alias: hintedAlias }).key;
    if (mappings.some(item => item.project.alias !== hintedAlias || item.project.key !== key)) throw fail('IDENTITY_UNAVAILABLE', 'Folder and path hints conflict.');
    matches = mappings.filter(item => item.project.key === key);
  }
  if (!matches.length || new Set(matches.map(item => item.project.key)).size !== 1) throw fail('IDENTITY_UNAVAILABLE', 'No unambiguous known project mapping; reload projects.');
  const project = matches[0].project;
  if (project.alias !== null && !snapshot.declaredHosts.includes(project.alias)) throw fail('IDENTITY_UNAVAILABLE', 'Declare the remote host before planning.');
  return { project, known };
}

function createProjectDeletePlanner(deps) {
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(1, Math.min(deps.timeoutMs, 15000)) : 10000;
  const maxItems = Number.isInteger(deps.maxItems) ? Math.max(1, Math.min(deps.maxItems, 50000)) : 20000;

  async function preview(input, boundKey) {
    let timer;
    const controller = new AbortController();
    try {
      validateRequest(input);
      const request = structuredClone(input);
      const budget = { signal: controller.signal, limit: maxItems, deadline: Date.now() + timeoutMs };
      const expired = () => {
        if (controller.signal.aborted || Date.now() >= budget.deadline) throw fail('DISCOVERY_TIMEOUT', 'Planning timed out; retry after indexing settles.');
      };
      let itemCount = 0;
      const items = value => {
        if (!Array.isArray(value)) throw fail('SNAPSHOT_INCOMPLETE', 'Discovery must return every inventory, including empty ones.');
        itemCount += value.length;
        if (itemCount > maxItems) throw fail('DISCOVERY_LIMIT', 'Inventory exceeds the bounded preview budget.');
        return value;
      };
      const complete = value => {
        if (!isRecord(value) || value.complete !== true) throw fail('SNAPSHOT_INCOMPLETE', 'Index or discovery is incomplete; retry after indexing.');
      };
      const collect = async () => {
        await deps.waitForIndex(budget);
        expired();
        const snapshot = structuredClone(await deps.readSnapshot(budget));
        expired();
        complete(snapshot);
        if (snapshot.initialScanComplete !== true || !text(snapshot.revision)) throw fail('SNAPSHOT_INCOMPLETE', 'Wait for the normal initial index and writer fence.');
        items(snapshot.projects); items(snapshot.declaredHosts);
        const { project, known } = resolveProject(request, snapshot, boundKey);
        const ownership = structuredClone(await deps.discoverOwnership(project, { ...budget, snapshot }));
        expired(); complete(ownership);
        const rawGroups = items(ownership.groups), rawMembers = items(ownership.members);
        const ownershipCandidates = items(ownership.candidates);
        const discovery = structuredClone(await deps.discoverSchedules(project, budget));
        expired(); complete(discovery);
        const rawSchedules = items(discovery.schedules), scheduleCandidates = items(discovery.candidates);
        const runtime = structuredClone(await deps.readRuntimeState(project, budget));
        expired(); complete(runtime);
        const rawTabs = items(runtime.tabs), rawJobs = items(runtime.jobs), runtimeCandidates = items(runtime.candidates);
        const refusals = [], warnings = [];
        const refuse = (code, target, error) => refusals.push({ code, target, error });
        const own = row => {
          try {
            const candidate = identity(row);
            return candidate.alias === project.alias && candidate.projectPath === project.projectPath;
          } catch {
            refuse('OWNERSHIP_UNKNOWN', row?.id || row?.folderKey || null, 'Resolve the missing host/path ownership before retrying.');
            return false;
          }
        };
        for (const candidate of [...ownershipCandidates, ...scheduleCandidates, ...runtimeCandidates]) {
          refuse('DISCOVERY_CANDIDATE', candidate.path || candidate.id || null, candidate.reason || 'Resolve the unindexed or unmappable candidate.');
        }
        const groups = [];
        for (const row of rawGroups) {
          if (own(row)) groups.push({ ...row, effect: 'selected' });
          else if (row.alias === project.alias) {
            const parent = row.parentProjectPath || worktreeParentPath(row.projectPath?.replace(/\\/g, '/'));
            if (parent && canonicalPath(parent, row.alias) === project.projectPath && row.verified === true) groups.push({ ...row, effect: 'kept' });
          }
        }
        const selectedGroups = groups.filter(row => row.effect === 'selected');
        const folders = new Set();
        for (const row of selectedGroups) {
          if (!text(row.folderKey) || row.verified !== true || !['claude', 'codex'].includes(row.runtime)
            || parseFolderKey(row.folderKey).alias !== project.alias || folders.has(row.folderKey)) {
            refuse('GROUP_OWNERSHIP', row.folderKey, 'Verify the unique cache group host/path/runtime.');
          }
          folders.add(row.folderKey);
        }
        for (const item of known.filter(item => item.project.key === project.key)) {
          for (const folder of items(item.row.cacheFolderKeys || [])) {
            if (!folders.has(folder)) refuse('GROUP_MISSING', folder, 'Reconcile the missing backing cache group before retrying.');
          }
        }
        const members = rawMembers.filter(own), tabs = rawTabs.filter(own), jobs = rawJobs.filter(own), schedules = rawSchedules.filter(own);
        const memberIds = new Set();
        for (const member of members) {
          if (!text(member.id) || !text(member.conversationId) || !text(member.partId) || memberIds.has(member.id)
            || member.verified !== true || member.indexed !== true || member.present !== true || member.linked === true
            || !folders.has(member.folderKey) || !selectedGroups.some(group => group.folderKey === member.folderKey && group.runtime === member.runtime)
            || parseFolderKey(member.folderKey).alias !== project.alias
            || canonicalPath(member.cwd, project.alias) !== project.projectPath || !['claude', 'codex'].includes(member.runtime)) {
            refuse('MEMBER_OWNERSHIP', member.id, 'Reindex and verify this exact conversation part and folder ownership.');
          }
          memberIds.add(member.id);
        }
        const stops = [];
        const inspectLiveness = (row, kind) => {
          const target = row.id;
          if (!text(target) || row.verified !== true || !['claude', 'codex', 'terminal'].includes(row.runtime)) {
            refuse('LIVENESS_UNKNOWN', target, 'Verify runtime and target ownership.'); return;
          }
          const evidence = row.liveness;
          if (!isRecord(evidence) || !['stopped', 'running'].includes(evidence.state)
            || !['pty', 'descriptor', 'remote', 'job', 'external'].includes(evidence.source)) {
            refuse('LIVENESS_UNKNOWN', target, 'Establish authoritative process liveness before retrying.'); return;
          }
          if (evidence.state === 'stopped') return;
          if (evidence.source === 'external' || !text(evidence.targetId)) {
            refuse('EXTERNAL_PROCESS', target, 'Stop the external process and verify its exit.'); return;
          }
          const background = kind === 'job' || evidence.source === 'job' || row.background === true || Boolean(row.jobId);
          const excluded = background && !request.options.stopBackgroundJobs;
          stops.push({ kind, id: target, name: row.name || target, runtime: row.runtime, alias: project.alias,
            projectPath: project.projectPath, conversationId: row.conversationId || null, jobId: row.jobId || (kind === 'job' ? target : null),
            scheduleId: row.scheduleId || null, targetId: evidence.targetId, evidence, excluded });
          if (excluded) refuse('BACKGROUND_CONSENT', target, 'Explicitly consent to stopping this named background job.');
        };
        members.forEach(row => inspectLiveness(row, 'member'));
        tabs.forEach(row => inspectLiveness(row, 'tab'));
        jobs.forEach(row => inspectLiveness(row, 'job'));
        const scheduleIds = new Set(), schedulePaths = new Set();
        for (const row of schedules) {
          if (!text(row.id) || !text(row.path) || row.verified !== true || row.linked === true
            || scheduleIds.has(row.id) || schedulePaths.has(row.path)) refuse('SCHEDULE_OWNERSHIP', row.path, 'Verify this schedule identity and ownership.');
          scheduleIds.add(row.id); schedulePaths.add(row.path);
          if (row.readable !== true) refuse('SCHEDULE_UNREADABLE', row.path, 'Restore read access and retry; the matching file is kept.');
          if (row.problems?.length) warnings.push({ code: 'SCHEDULE_INVALID', target: row.path, problems: row.problems });
        }
        const settingsPath = value => path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/$/, '') || '/';
        const selectedSettingsPath = settingsPath(known.find(item => item.project.key === project.key).row.projectPath);
        const sharedSettings = known.some(item => item.project.alias !== project.alias
          && settingsPath(item.row.projectPath) === selectedSettingsPath);
        if (sharedSettings && request.options.settings) refuse('SHARED_SETTINGS', project.projectPath, 'Another host uses this path-only settings key; keep settings.');
        const categories = {
          sessions: { selected: request.options.sessions, available: true, effect: request.options.sessions ? 'discard' : 'archive' },
          settings: { selected: request.options.settings, available: !sharedSettings, effect: request.options.settings && !sharedSettings ? 'delete' : 'kept', reason: sharedSettings ? 'Shared path-only settings key' : null },
          schedules: { selected: false, available: false, effect: 'kept' },
          transcripts: { selected: false, available: false, effect: 'kept' },
          stopBackgroundJobs: { selected: request.options.stopBackgroundJobs, available: true },
          memory: { effect: 'kept' }, workFiles: { effect: 'kept' }, worktrees: { effect: 'kept' }, projectDirectory: { effect: 'kept' }, branches: { effect: 'kept' },
        };
        warnings.push({ code: 'RETAINED_TRANSCRIPTS', error: 'Retained transcripts can restore transcript titles on re-add even when app names are discarded.' });
        if (schedules.length) warnings.push({ code: 'SCHEDULE_REACTIVATION', error: 'Kept schedule files may reactivate when this project is re-added.' });
        if (project.alias !== null) warnings.push({ code: 'REMOTE_FILES_KEPT', error: 'All remote server files are kept.' });
        for (const list of [groups, members, tabs, stops, schedules, warnings, refusals]) ordered(list);
        const membershipDigest = digest({ project, groups, members, tabs, jobs: ordered(jobs), schedules });
        const fingerprint = digest({ membershipDigest, options: request.options, stops, categories, warnings, refusals });
        const revision = await deps.readRevision(budget);
        expired();
        if (revision !== snapshot.revision) throw fail('SNAPSHOT_STALE', 'Writer changed during discovery; request a fresh preview.');
        return { ok: true, plan: { project, groups, members, tabs, stops, schedules, categories,
          counts: { conversations: new Set(members.map(row => row.conversationId)).size,
            parts: new Set(members.filter(row => !row.subagentId).map(row => row.partId)).size,
            subagents: members.filter(row => row.subagentId).length, transcripts: members.length, tabs: tabs.length,
            processes: new Set(stops.map(row => stable([row.alias, row.evidence.source, row.targetId]))).size, schedules: schedules.length },
          warnings, refusals, membershipDigest, fingerprint, revision } };
      };
      return await Promise.race([collect(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(fail('DISCOVERY_TIMEOUT', 'Planning timed out; retry after indexing settles.')); }, timeoutMs);
      })]);
    } catch (error) {
      return { ok: false, code: error.code || 'DISCOVERY_UNAVAILABLE', error: error.message || 'Read-only planning unavailable.' };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function revalidate(plan) {
    try {
      const options = Object.fromEntries(OPTION_KEYS.map(key => [key, plan.categories[key].selected]));
      if (identity(plan.project).key !== plan.project.key) return { same: false, plan: null };
      const reply = await preview({ projectPath: plan.project.projectPath, options }, plan.project.key);
      return { same: reply.ok && reply.plan.fingerprint === plan.fingerprint && reply.plan.refusals.length === 0,
        plan: reply.ok ? reply.plan : null };
    } catch {
      return { same: false, plan: null };
    }
  }

  return { preview: request => preview(request), revalidate };
}

module.exports = { createProjectDeletePlanner };
