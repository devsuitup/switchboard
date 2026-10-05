// see .ai/contexts/session-cache.md ("Archived projects")

const fs = require('fs');
const path = require('path');
const { joinFolderKey } = require('./remote-hosts');
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
    if ((session.host || null) !== (alias || null)) continue;
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
 * an entry was cleared, then mark each listed project holding a re-enable offer.
 */
function applyAndPersistArchived(projects, showArchived, { getSetting, setSetting, scheduleName = readScheduleName }) {
  const archived = getSetting(SETTING_KEY) || {};
  const { projects: kept, cleared } = applyArchivedProjects(projects, archived, showArchived);
  if (cleared.length > 0) retireArchivedEntries(getSetting, setSetting, archived, cleared);
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
function archivePlanForGroups(groups, { registered, scan, realpath, parseFolderKey }) {
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

module.exports = {
  archivedEntry, knownIdsForGroup, applyArchivedProjects, applyAndPersistArchived,
  clearArchivedEntry, archivePlanForGroups, reenableScheduleFiles,
};
