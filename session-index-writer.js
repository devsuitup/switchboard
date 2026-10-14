'use strict';

const archive = require('./archived-projects');
const { scheduleRegistry } = require('./schedule-runner');
const { createWhatsNew } = require('./changelog');
const { remapProjectTranscripts } = require('./project-remap');
const { encodeProjectPath } = require('./encode-project-path');

// see .ai/contexts/session-index-writer.md
function createSessionIndexWriter(backend = require('./db'), cache = require('./session-cache')) {
  const settings = { getSetting: backend.getSetting, setSetting: backend.setSetting };
  const cacheDeps = () => ({
    ...settings, getAllCached: backend.getAllCached,
    isInitialScanComplete: backend.isInitialScanComplete,
    resolveFolderDir: cache.resolveFolderDir, refreshFolder: cache.refreshFolder,
    buildProjects: () => cache.buildProjectsFromCache(true),
  });
  return {
    initializeCache(ctx) {
      cache.init({ ...ctx, writer: this, db: {
        deleteCachedFolder: backend.deleteCachedFolder, getCachedByFolder: backend.getCachedByFolder,
        upsertCachedSessions: backend.upsertCachedSessions, deleteCachedSession: backend.deleteCachedSession,
        replaceSessionMetrics: backend.replaceSessionMetrics, touchCachedModified: backend.touchCachedModified,
        deleteSearchFolder: backend.deleteSearchFolder, deleteSearchSession: backend.deleteSearchSession,
        upsertSearchEntries: backend.upsertSearchEntries, setFolderMeta: backend.setFolderMeta,
        getFolderMeta: backend.getFolderMeta, getAllFolderMeta: backend.getAllFolderMeta,
        getAllMeta: backend.getAllMeta, getAllCached: backend.getAllCached,
        getSetting: backend.getSetting, setSetting: backend.setSetting, getMeta: backend.getMeta, setName: backend.setName,
        isInitialScanComplete: backend.isInitialScanComplete, setInitialScanComplete: backend.setInitialScanComplete,
        getCachedMissingEntrypoint: backend.getCachedMissingEntrypoint, setCachedEntrypoints: backend.setCachedEntrypoints,
        getCachedSession: backend.getCachedSession, setCachedContinuationIndex: backend.setCachedContinuationIndex,
        setCachedCustomTitles: backend.setCachedCustomTitles, getCachedMissingCustomTitle: backend.getCachedMissingCustomTitle,
      } });
    },
    async setSetting(key, value) { return backend.setSetting(key, value); },
    async deleteSetting(key) { return backend.deleteSetting(key); },
    async patchGlobal(fields) {
      const global = backend.getSetting('global') || {};
      backend.setSetting('global', { ...global, ...fields });
    },
    async toggleStar(sessionId) { return backend.toggleStar(sessionId); },
    async setArchived(sessionId, archived) { return backend.setArchived(sessionId, archived); },
    async renameSession(sessionId, name) {
      backend.setName(sessionId, name || null);
      const cached = backend.getCachedSession(sessionId);
      backend.updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + (cached?.summary || ''));
      return { name: name || null };
    },
    async deleteCachedSession(sessionId) { return backend.deleteCachedSession(sessionId); },
    async deleteSearchSession(sessionId) { return backend.deleteSearchSession(sessionId); },
    async deleteCachedFolder(folder) { return backend.deleteCachedFolder(folder); },
    async deleteSearchFolder(folder) { return backend.deleteSearchFolder(folder); },
    async deleteSearchType(type) { return backend.deleteSearchType(type); },
    async applySearchFileBatch(type, deletes, entries) { return backend.applySearchFileBatch(type, deletes, entries); },
    async setCachedEntrypoints(pairs) { return backend.setCachedEntrypoints(pairs); },
    async setCachedCustomTitles(pairs) { return backend.setCachedCustomTitles(pairs); },
    async setCachedContinuationIndex(sessionId, index) { return backend.setCachedContinuationIndex(sessionId, index); },
    async setInitialScanComplete() { return backend.setInitialScanComplete(); },
    async refreshFolder(folder, opts) { return cache.refreshFolder(folder, opts); },
    async dropFolderRows(folder, opts) { return cache.dropFolderRows(folder, opts); },
    async releaseLiveSession(sessionId) { return cache.releaseLiveSession(sessionId); },
    async writeScannedFolder(result, unverifiedLocalFolder) { return cache.writeScannedFolder(result, unverifiedLocalFolder); },
    async writeScannedFolderPartial(result) { return cache.writeScannedFolderPartial(result); },
    async applyProjectsWorkerEffects(result) { return cache.applyProjectsWorkerEffects(result); },
    async buildProjectsFromCache(showArchived) { return cache.buildProjectsFromCache(showArchived); },
    async archiveProjectFolders(groups, opts, deps) {
      const registry = scheduleRegistry(backend.getSetting, backend.setSetting, deps.seedProjects);
      return archive.archiveProjectFolders(groups, opts, { ...deps, ...cacheDeps(),
        buildProjects: () => deps.mergeProjects(cache.buildProjectsFromCache(true)),
        plan: groups => archive.archivePlanForGroups(groups, {
          registered: registry.list(), scan: deps.scan, realpath: deps.realpath,
        }),
      });
    },
    async applyAndPersistArchived(projects, showArchived) {
      return archive.applyAndPersistArchived(projects, showArchived, settings);
    },
    async clearArchivedEntry(alias, projectPath) {
      return archive.clearArchivedEntry(backend.getSetting, backend.setSetting, alias, projectPath);
    },
    async reenableOfferedSchedules(projectPath, folderKey, deps) {
      return archive.reenableOfferedSchedules(projectPath, folderKey, { ...deps, ...settings });
    },
    async dismissReenableOffer(projectPath, folderKey, deps) {
      return archive.dismissReenableOffer(projectPath, folderKey, { ...deps, ...settings });
    },
    async hideProject(entry, kind) {
      const global = backend.getSetting('global') || {};
      const hidden = global.hiddenProjects || [];
      if (kind === 'archive') global.hiddenProjects = [...new Set([...hidden, entry])];
      else { if (!hidden.includes(entry)) hidden.push(entry); global.hiddenProjects = hidden; }
      global.hiddenProjectKinds = { ...global.hiddenProjectKinds, [entry]: kind };
      backend.setSetting('global', global);
    },
    async unhideProject(entry, alias, projectPath) {
      archive.clearArchivedEntry(backend.getSetting, backend.setSetting, alias, projectPath);
      const global = backend.getSetting('global') || {};
      global.hiddenProjects = (global.hiddenProjects || []).filter(p => p !== entry);
      global.hiddenProjectKinds = { ...global.hiddenProjectKinds };
      delete global.hiddenProjectKinds[entry];
      backend.setSetting('global', global);
    },
    async revealAddedProject(projectPath) {
      const global = backend.getSetting('global') || {};
      if (global.hiddenProjects?.includes(projectPath)) {
        global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
        if (global.hiddenProjectKinds) delete global.hiddenProjectKinds[projectPath];
        backend.setSetting('global', global);
      }
      archive.clearArchivedEntry(backend.getSetting, backend.setSetting, null, projectPath);
    },
    async cleanupWorktree(normalizedPath, log) {
      let removed = 0;
      try {
        for (const row of backend.getAllCached()) {
          if (row.projectPath !== normalizedPath) continue;
          backend.deleteCachedSession(row.sessionId);
          backend.deleteSearchSession(row.sessionId);
          removed++;
        }
      } catch (err) { log.warn('[delete-worktree] DB cleanup error:', err.message); }
      try {
        const global = backend.getSetting('global') || {};
        if (Array.isArray(global.hiddenProjects) && global.hiddenProjects.includes(normalizedPath)) {
          global.hiddenProjects = global.hiddenProjects.filter(p => p !== normalizedPath);
          if (global.hiddenProjectKinds) delete global.hiddenProjectKinds[normalizedPath];
          backend.setSetting('global', global);
        }
      } catch {}
      try { archive.clearArchivedEntry(backend.getSetting, backend.setSetting, null, normalizedPath); } catch {}
      try {
        const folder = encodeProjectPath(normalizedPath);
        backend.deleteCachedFolder(folder);
        backend.deleteSearchFolder(folder);
      } catch {}
      return removed;
    },
    async dropRemoteFolder(folderKey) {
      backend.deleteCachedFolder(folderKey);
      backend.deleteSearchFolder(folderKey);
      const pending = backend.getSetting('bridge_uuid_reindex_folders');
      if (Array.isArray(pending) && pending.includes(folderKey)) {
        backend.setSetting('bridge_uuid_reindex_folders', pending.filter(key => key !== folderKey));
      }
    },
    async remapProjectTranscripts(args) { return remapProjectTranscripts({ ...args, ...settings }); },
    scheduleRegistry(seed) {
      const registry = scheduleRegistry(backend.getSetting, backend.setSetting, seed);
      return {
        async list() { return registry.list(); },
        async add(projectPath) { return registry.add(projectPath); },
        async remove(projectPath) { return registry.remove(projectPath); },
      };
    },
    createWhatsNew(options) {
      const whatsNew = createWhatsNew({ ...options, ...settings });
      return {
        async startup() { return whatsNew.startup(); },
        async dismissed() { return whatsNew.dismissed(); },
        forMenu: whatsNew.forMenu,
      };
    },
    async closeDb() { return backend.closeDb(); },
  };
}

module.exports = { createSessionIndexWriter };
