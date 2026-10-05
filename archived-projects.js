// see .ai/contexts/session-cache.md ("Archived projects")

const fs = require('fs');
const path = require('path');
const { joinFolderKey, parseFolderKey } = require('./remote-hosts');
const { encodeProjectPath } = require('./encode-project-path');
const { worktreeParentPath } = require('./public/worktree-nesting');
const { scheduleFileUnlinked, setScheduleEnabled, parseFrontmatter } = require('./schedule-runner');

const SETTING_KEY = 'archivedProjects';
const OFFERS_KEY = 'scheduleReenableOffers';
const LINKED_REASON = 'linked file or directory';

/** The `archivedProjects` key of a group: a bare entry matches the local group only. */
function archivedEntry(alias, projectPath) {
  if (!alias) return path.resolve(projectPath);
  return joinFolderKey(alias, path.posix.normalize(projectPath).replace(/\/$/, ''));
}

const entryOf = (project) => archivedEntry(project.remoteAlias || null, project.projectPath);

/**
 * Every session id the group holds at archive time: its top-level rows, the
 * running sessions opened in it, and the transcripts on disk.
 */
function knownIdsForGroup({ projects, activeSessions, diskIds, alias, projectPath }) {
  const target = archivedEntry(alias || null, projectPath);
  const ids = new Set();
  for (const project of projects || []) {
    if (entryOf(project) !== target) continue;
    for (const s of project.sessions || []) {
      if (!s.parentSessionId) ids.add(s.sessionId);
    }
  }
  for (const [sessionId, session] of activeSessions || []) {
    if (!session || typeof session.projectPath !== 'string') continue;
    if (archivedEntry(session.host || null, session.projectPath) !== target) continue;
    ids.add(sessionId);
    if (session.realSessionId) ids.add(session.realSessionId);
  }
  for (const id of diskIds || []) ids.add(id);
  return [...ids];
}

/**
 * Drop the archived groups from a projects list, unless `showArchived`, and
 * report the entries a new session has cleared.
 */
function applyArchivedProjects(projects, archived, showArchived) {
  const store = archived || {};
  const cleared = new Set();
  for (const project of projects) {
    const entry = entryOf(project);
    const record = store[entry];
    if (!record) continue;
    const known = new Set(record.knownSessionIds || []);
    const reappears = (project.sessions || []).some(s => !s.parentSessionId && !s.archived && !known.has(s.sessionId));
    if (reappears) cleared.add(entry);
  }
  for (const project of projects) {
    const parentPath = worktreeParentPath(project.projectPath);
    if (parentPath === null) continue;
    const entry = entryOf(project);
    if (store[entry] && !cleared.has(entry)) continue;
    const parentEntry = archivedEntry(project.remoteAlias || null, parentPath);
    if (store[parentEntry]) cleared.add(parentEntry);
  }
  const kept = showArchived
    ? projects
    : projects.filter(project => {
      const entry = entryOf(project);
      return !store[entry] || cleared.has(entry);
    });
  return { projects: kept, cleared: [...cleared] };
}

/** The schedule's display name, or null when its file is gone. */
function readScheduleName(filePath) {
  try {
    return parseFrontmatter(fs.readFileSync(filePath, 'utf8')).meta.name || path.basename(filePath);
  } catch {
    return null;
  }
}

/**
 * Remove entries from `archivedProjects`; an entry that disabled schedules
 * becomes a re-enable offer. Both settings are written in one synchronous step.
 */
function retireArchivedEntries(getSetting, setSetting, archived, entries) {
  const next = { ...archived };
  let offers = null;
  for (const entry of entries) {
    const files = archived[entry] && archived[entry].disabledSchedules;
    if (Array.isArray(files) && files.length > 0) {
      offers = offers || { ...(getSetting(OFFERS_KEY) || {}) };
      offers[entry] = { disabledSchedules: files, archivedAt: archived[entry].archivedAt };
    }
    delete next[entry];
  }
  setSetting(SETTING_KEY, next);
  if (offers) setSetting(OFFERS_KEY, offers);
}

/**
 * applyArchivedProjects against the stored setting, writing it back only when
 * an entry was cleared; then mark each worktree group whose repository is
 * hidden on its host (`hiddenRepository`) and each project holding a re-enable
 * offer.
 */
function applyAndPersistArchived(projects, showArchived, { getSetting, setSetting, scheduleName = readScheduleName }) {
  const archived = getSetting(SETTING_KEY) || {};
  const { projects: kept, cleared } = applyArchivedProjects(projects, archived, showArchived);
  if (cleared.length > 0) retireArchivedEntries(getSetting, setSetting, archived, cleared);
  const hidden = new Set(((getSetting('global') || {}).hiddenProjects) || []);
  for (const project of kept) {
    const parentPath = worktreeParentPath(project.projectPath);
    if (parentPath === null) continue;
    const alias = project.remoteAlias || null;
    if (hidden.has(parentPath) || (alias !== null && hidden.has(joinFolderKey(alias, parentPath)))) {
      project.hiddenRepository = true;
    }
  }
  const offers = getSetting(OFFERS_KEY) || {};
  for (const project of kept) {
    const offer = offers[entryOf(project)];
    if (!offer || !Array.isArray(offer.disabledSchedules)) continue;
    const names = offer.disabledSchedules.map(scheduleName).filter(Boolean);
    if (names.length === 0) continue;
    project.reenableOffer = Array.isArray(offer.failed) && offer.failed.length > 0
      ? { names, failed: offer.failed }
      : { names };
  }
  return kept;
}

/** Remove a group's entry, when it has one, keeping its disabled schedules as an offer. */
function clearArchivedEntry(getSetting, setSetting, alias, projectPath) {
  const archived = getSetting(SETTING_KEY);
  const entry = archivedEntry(alias, projectPath);
  if (!archived || !Object.prototype.hasOwnProperty.call(archived, entry)) return false;
  retireArchivedEntries(getSetting, setSetting, archived, [entry]);
  return true;
}

/**
 * Turn back on the offered schedule files that still read `enabled: false`.
 * A vanished file, or one whose `enabled` was changed since, is left as it is.
 */
function reenableScheduleFiles(filePaths, projectRoot) {
  const enabled = [];
  const failed = [];
  for (const filePath of filePaths || []) {
    let meta;
    try { meta = parseFrontmatter(fs.readFileSync(filePath, 'utf8')).meta; } catch { continue; }
    if (meta.enabled !== 'false') continue;
    const name = meta.name || path.basename(filePath);
    const res = setScheduleEnabled(filePath, true, { projectRoot });
    if (res.ok) enabled.push(name);
    else failed.push({ name, filePath, error: res.error });
  }
  return { enabled, failed };
}

/**
 * The enabled schedules of the archived groups, each marked `disableable`
 * when no link below the project root reaches its file.
 */
function archivePlanForGroups(groups, { registered, scan, realpath }) {
  const registry = new Set(registered || []);
  const plan = [];
  for (const group of groups) {
    if (parseFolderKey(group.folderKey).alias !== null) continue;
    if (!registry.has(path.resolve(group.projectPath))) continue;
    for (const schedule of scan(group.projectPath)) {
      try { realpath(schedule.filePath); } catch { continue; }
      if (scheduleFileUnlinked(group.projectPath, schedule.filePath, realpath)) {
        plan.push({ name: schedule.name, filePath: schedule.filePath, disableable: true });
      } else {
        plan.push({ name: schedule.name, filePath: schedule.filePath, disableable: false, reason: LINKED_REASON });
      }
    }
  }
  return plan;
}

/** The groups of an archive-project call that are well formed. */
function validArchiveGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.filter(g => g && typeof g.projectPath === 'string' && g.projectPath !== ''
    && (g.folderKey === undefined || g.folderKey === null || typeof g.folderKey === 'string'));
}

/** The schedule file's parsed `enabled`, or undefined when it cannot be read. */
function readScheduleEnabled(filePath) {
  try {
    return parseFrontmatter(fs.readFileSync(filePath, 'utf8')).meta.enabled;
  } catch {
    return undefined;
  }
}

/** Re-index every folder of the group and return the transcript ids on disk. */
function groupDiskIds(alias, projectPath, { getAllCached, resolveFolderDir, refreshFolder }) {
  const entry = archivedEntry(alias, projectPath);
  const encoded = encodeProjectPath(projectPath);
  const folders = new Set([alias === null ? encoded : joinFolderKey(alias, encoded)]);
  for (const row of getAllCached()) {
    if (typeof row.projectPath !== 'string') continue;
    const rowAlias = parseFolderKey(row.folder).alias;
    if (rowAlias === alias && archivedEntry(rowAlias, row.projectPath) === entry) folders.add(row.folder);
  }
  const ids = [];
  for (const folder of folders) {
    const dir = resolveFolderDir(folder);
    if (!dir || !fs.existsSync(dir)) continue;
    refreshFolder(folder);
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl')) ids.push(name.slice(0, -'.jsonl'.length));
    }
  }
  return ids;
}

/**
 * archive-project: snapshot each group's sessions, record the entries, then
 * disable the confirmed schedules and record them too. Synchronous.
 */
function archiveProjectFolders(groups, opts, deps) {
  const { getSetting, setSetting, readEnabled = readScheduleEnabled } = deps;
  if (!deps.isInitialScanComplete()) return { error: 'indexing' };
  const targets = validArchiveGroups(groups).map(group => ({ group, alias: parseFolderKey(group.folderKey).alias }));
  const confirmed = Array.isArray(opts && opts.disableSchedules) ? opts.disableSchedules : [];
  const disabled = [];
  const failed = [];
  try {
    const diskIds = targets.map(({ group, alias }) => groupDiskIds(alias, group.projectPath, deps));
    const projects = deps.buildProjects();
    const archivedAt = deps.now();
    const offers = { ...(getSetting(OFFERS_KEY) || {}) };
    const entries = targets.map(({ group, alias }, i) => {
      const entry = archivedEntry(alias, group.projectPath);
      const offered = (offers[entry] && Array.isArray(offers[entry].disabledSchedules)) ? offers[entry].disabledSchedules : [];
      delete offers[entry];
      return {
        entry,
        record: {
          archivedAt,
          knownSessionIds: knownIdsForGroup({ projects, activeSessions: deps.activeSessions, diskIds: diskIds[i], alias, projectPath: group.projectPath }),
          disabledSchedules: offered.filter(filePath => readEnabled(filePath) === 'false'),
        },
      };
    });
    const writeEntries = () => {
      const next = { ...(getSetting(SETTING_KEY) || {}) };
      for (const { entry, record } of entries) next[entry] = record;
      setSetting(SETTING_KEY, next);
    };
    writeEntries();
    setSetting(OFFERS_KEY, offers);

    targets.forEach(({ group }, i) => {
      for (const schedule of deps.plan([group])) {
        if (!schedule.disableable || !confirmed.includes(schedule.filePath)) continue;
        let res;
        try {
          res = deps.setEnabled(schedule.filePath, false, { projectRoot: group.projectPath });
        } catch (err) {
          res = { ok: false, error: err.message };
        }
        if (res.ok) {
          entries[i].record.disabledSchedules.push(schedule.filePath);
          disabled.push(schedule.name);
        } else {
          failed.push({ name: schedule.name, error: res.error });
        }
      }
    });
    if (disabled.length > 0) writeEntries();
    deps.notify();
    return { ok: true, disabled, failed };
  } catch (err) {
    return { error: err.message, disabled };
  }
}

/** reenable-project-schedules: turn back on the folder's offered schedules; failures stay offered. */
function reenableOfferedSchedules(projectPath, folderKey, { getSetting, setSetting, notify, reenable = reenableScheduleFiles }) {
  if (typeof projectPath !== 'string' || projectPath === '') return { error: 'invalid project path' };
  const entry = archivedEntry(parseFolderKey(folderKey).alias, projectPath);
  const offers = getSetting(OFFERS_KEY) || {};
  const offer = offers[entry];
  if (!offer) return { ok: true, enabled: [], failed: [] };
  const result = reenable(offer.disabledSchedules, projectPath);
  const failed = result.failed.map(f => ({ name: f.name, error: f.error }));
  const next = { ...offers };
  if (failed.length > 0) next[entry] = { ...offer, disabledSchedules: result.failed.map(f => f.filePath), failed };
  else delete next[entry];
  setSetting(OFFERS_KEY, next);
  notify();
  return { ok: true, enabled: result.enabled, failed };
}

/** dismiss-schedule-reenable-offer: forget the folder's offer. */
function dismissReenableOffer(projectPath, folderKey, { getSetting, setSetting, notify }) {
  if (typeof projectPath !== 'string' || projectPath === '') return { error: 'invalid project path' };
  const entry = archivedEntry(parseFolderKey(folderKey).alias, projectPath);
  const next = { ...(getSetting(OFFERS_KEY) || {}) };
  delete next[entry];
  setSetting(OFFERS_KEY, next);
  notify();
  return { ok: true };
}

module.exports = {
  archivedEntry, knownIdsForGroup, applyArchivedProjects, applyAndPersistArchived,
  clearArchivedEntry, archivePlanForGroups, reenableScheduleFiles,
  validArchiveGroups, archiveProjectFolders, reenableOfferedSchedules, dismissReenableOffer,
};
