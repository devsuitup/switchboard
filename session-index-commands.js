'use strict';

const archive = require('./archived-projects');
const { scheduleRegistry } = require('./schedule-runner');
const { whatsNewOnStartup } = require('./changelog');

// see .ai/contexts/session-index-writer.md
function createWriterCommands(db) {
  const settings = { getSetting: db.getSetting, setSetting: db.setSetting, scheduleName: () => null };
  const patch = fields => db.setSetting('global', { ...(db.getSetting('global') || {}), ...fields });
  return {
    patchGlobal: patch,
    cleanupWorktree(projectPath) {
      let removed = 0;
      for (const row of db.getAllCached()) {
        if (row.projectPath !== projectPath) continue;
        db.deleteCachedSession(row.sessionId);
        db.deleteSearchSession(row.sessionId);
        removed++;
      }
      const global = db.getSetting('global') || {};
      if (global.hiddenProjects?.includes(projectPath)) {
        const kinds = { ...global.hiddenProjectKinds };
        delete kinds[projectPath];
        const fields = { hiddenProjects: global.hiddenProjects.filter(p => p !== projectPath) };
        if (global.hiddenProjectKinds) fields.hiddenProjectKinds = kinds;
        patch(fields);
      }
      archive.clearArchivedEntry(db.getSetting, db.setSetting, null, projectPath);
      const folder = require('./encode-project-path').encodeProjectPath(projectPath);
      db.deleteCachedFolder(folder);
      db.deleteSearchFolder(folder);
      return removed;
    },
    renameSession(id, name) {
      db.setName(id, name || null);
      db.updateSearchTitle(id, 'session', (name ? name + ' ' : '') + (db.getCachedSession(id)?.summary || ''));
      return { name: name || null };
    },
    rekeySessionMeta(from, to) {
      const row = db.getCachedSession(from);
      db.rekeySessionMeta(from, to, row?.customTitle || row?.aiTitle || row?.summary);
    },
    hideProject(entry, kind) {
      const global = db.getSetting('global') || {};
      patch({ hiddenProjects: [...new Set([...(global.hiddenProjects || []), entry])],
        hiddenProjectKinds: { ...global.hiddenProjectKinds, [entry]: kind } });
    },
    clearArchivedEntry: (alias, projectPath) => archive.clearArchivedEntry(db.getSetting, db.setSetting, alias, projectPath),
    unhideProject(entry, alias, projectPath) {
      archive.clearArchivedEntry(db.getSetting, db.setSetting, alias, projectPath);
      const global = db.getSetting('global') || {};
      const kinds = { ...global.hiddenProjectKinds };
      delete kinds[entry];
      patch({ hiddenProjects: (global.hiddenProjects || []).filter(p => p !== entry), hiddenProjectKinds: kinds });
    },
    revealAddedProject(projectPath) {
      const global = db.getSetting('global') || {};
      if (global.hiddenProjects?.includes(projectPath)) {
        const kinds = { ...global.hiddenProjectKinds };
        delete kinds[projectPath];
        patch({ hiddenProjects: global.hiddenProjects.filter(p => p !== projectPath), hiddenProjectKinds: kinds });
      }
      archive.clearArchivedEntry(db.getSetting, db.setSetting, null, projectPath);
    },
    retireArchivedEntries(entries, snapshot) {
      const current = db.getSetting('archivedProjects') || {};
      const state = { archivedProjects: current, hiddenProjects: (db.getSetting('global') || {}).hiddenProjects || [],
        scheduleReenableOffers: db.getSetting('scheduleReenableOffers') || {} };
      if (JSON.stringify(state) !== JSON.stringify(snapshot)) {
        throw Object.assign(new Error('archive snapshot changed before writer admission'), { code: 'WRITER_STALE' });
      }
      archive.retireArchivedEntries(db.getSetting, db.setSetting, current, entries.filter(entry => Object.hasOwn(current, entry)));
    },
    dismissReenableOffer: (projectPath, folderKey) => archive.dismissReenableOffer(projectPath, folderKey, { ...settings, notify() {} }),
    beginOffer(entry) { return (db.getSetting('scheduleReenableOffers') || {})[entry] || null; },
    completeOffer(entry, original, result) {
      const offers = { ...(db.getSetting('scheduleReenableOffers') || {}) };
      if (JSON.stringify(offers[entry]) !== JSON.stringify(original)) return false;
      const failed = result.failed.map(f => ({ name: f.name, error: f.error }));
      if (failed.length) offers[entry] = { ...original, disabledSchedules: result.failed.map(f => f.filePath), failed };
      else delete offers[entry];
      db.setSetting('scheduleReenableOffers', offers);
      return true;
    },
    beginArchive(entries) {
      const archived = { ...(db.getSetting('archivedProjects') || {}) };
      const offers = { ...(db.getSetting('scheduleReenableOffers') || {}) };
      for (const { entry, record, disabledFiles } of entries) {
        const offered = offers[entry]?.disabledSchedules || [];
        archived[entry] = { ...record, disabledSchedules: offered.filter(file => disabledFiles.includes(file)) };
        delete offers[entry];
      }
      db.setSetting('archivedProjects', archived);
      db.setSetting('scheduleReenableOffers', offers);
      return entries.map(({ entry }) => ({ entry, record: archived[entry] }));
    },
    completeArchive(entries, disabled) {
      const archived = { ...(db.getSetting('archivedProjects') || {}) };
      if (entries.some(({ entry, record }) => JSON.stringify(archived[entry]) !== JSON.stringify(record))) return false;
      for (const { entry, record } of entries) {
        archived[entry] = { ...record, disabledSchedules: [...new Set([...record.disabledSchedules, ...(disabled[entry] || [])])] };
      }
      db.setSetting('archivedProjects', archived);
      return true;
    },
    completeRepairFolders(folders) {
      const pending = db.getSetting('bridge_uuid_reindex_folders');
      if (Array.isArray(pending)) db.setSetting('bridge_uuid_reindex_folders', pending.filter(key => !folders.includes(key)));
    },
    completeRemap() {},
    recordRemap(folder, newPath) {
      const stored = db.getSetting('projectRemaps');
      db.setSetting('projectRemaps', { ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}), [folder]: newPath });
    },
    scheduleRegistry(action, seed, projectPath) {
      return scheduleRegistry(db.getSetting, db.setSetting, () => seed)[action](projectPath);
    },
    whatsNewStartup(options, changelog) {
      const lastSeenVersion = (db.getSetting('global') || {}).lastSeenVersion ?? options.lastSeenDefault;
      const result = whatsNewOnStartup({ ...options, lastSeenVersion, readChangelog: () => changelog });
      if (result.record) patch({ lastSeenVersion: result.record });
      return result;
    },
  };
}

module.exports = { createWriterCommands };
