'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { AsyncLocalStorage } = require('node:async_hooks');
const archive = require('./archived-projects');
const { encodeProjectPath } = require('./encode-project-path');
const { parseFolderKey } = require('./remote-hosts');
const { createWhatsNew } = require('./changelog');
const { remapProjectTranscripts } = require('./project-remap');
const { createWriterWorkerClient } = require('./session-index-writer-client');
const { createCacheEffects } = require('./cache-effects');

// see .ai/contexts/session-index-writer.md
function createSessionIndexWriter(options = {}, cache = require('./session-cache')) {
  const mirror = new Map();
  const client = options.client || createWriterWorkerClient({
    workerFactory: options.workerFactory || (() => new Worker(path.join(__dirname, 'workers', 'session-index-writer.js'))),
    onSettings: entries => { mirror.clear(); for (const [key, value] of entries) mirror.set(key, value); if (backend) backend.applySettingsAcknowledgment(entries); },
    ...options.clientOptions,
  });
  let backend, recorder, cacheTail = Promise.resolve(), closing, accepting = true, terminated = false;
  const pending = new Set();
  const commandScope = new AsyncLocalStorage();
  const owner = {};
  const admitted = () => !terminated && (accepting || commandScope.getStore() === owner);
  const track = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; };
  const ready = client.ready.then(bootstrap => {
    backend = options.readonlyBackend || require('./db');
    if (bootstrap) backend.searchFtsRecreated = bootstrap.searchFtsRecreated;
    if (!options.client) backend.applySettingsAcknowledgment([...mirror]);
    recorder = createCacheEffects(backend);
  });
  ready.catch(() => {});
  const request = (name, ...args) => !admitted() ? Promise.reject(new Error('writer is closing')) : track(ready.then(() => client.request(name, ...args)));
  const compute = (name, ...args) => {
    if (!admitted()) return Promise.reject(new Error('writer is closing'));
    const sourceVersion = backend?.getProjectsRevision?.();
    const work = cacheTail.then(async () => {
      await ready;
      const folder = name === 'refreshFolder' ? args[0] : name === 'releaseLiveSession' ? cache.getRetainedFolder?.(args[0]) : undefined;
      let continuationRetry = false, combinedResult;
      for (let attempt = 0; ; attempt++) {
        if (name === 'applyProjectsWorkerEffects' && backend.getProjectsRevision() !== sourceVersion) throw Object.assign(new Error('Projects effect snapshot changed while queued'), { code: 'WRITER_STALE' });
        const continuationCollector = { deferred: new Set(), accounted: new Set() };
        let computeArgs = args;
        if (folder !== undefined && cache.prepareContinuationRefresh) {
          const opts = name === 'refreshFolder' ? args[1] : {};
          const preparedContinuations = await cache.prepareContinuationRefresh(folder, opts);
          computeArgs = [args[0], { ...opts, preparedContinuations, continuationCollector,
            managedContinuations: true, continuationRetry, retainedFolder: folder }];
        }
        recorder.begin();
        let result, revision, effects;
        try {
          result = cache[name](...computeArgs);
          revision = recorder.revision();
        } finally {
          effects = recorder.finish();
          if (folder !== undefined) cache.applyContinuationRefresh?.(folder, continuationCollector);
        }
        try {
          const acknowledgment = effects.length ? await client.request('effects', effects, revision) : null;
          if (folder !== undefined) cache.applyContinuationRefresh?.(folder, continuationCollector, true);
          combinedResult = combinedResult === true || result === true ? true : combinedResult === 'activity' || result === 'activity' ? 'activity' : result;
          if (continuationCollector.deferred.size && !continuationRetry) {
            continuationRetry = true;
            attempt--;
            continue;
          }
          return name === 'applyProjectsWorkerEffects' && acknowledgment?.committedRevision !== undefined ? acknowledgment : combinedResult;
        }
        catch (error) { if (error.code !== 'WRITER_STALE' || attempt === 2 || name === 'applyProjectsWorkerEffects') throw error; }
      }
    });
    cacheTail = work.catch(() => {});
    return track(work);
  };
  const admit = fn => {
    if (!admitted()) return Promise.reject(new Error('writer is closing'));
    return track(commandScope.run(owner, () => Promise.resolve().then(fn)));
  };
  const writer = {
    ready,
    initializeCache(ctx) {
      if (!backend) throw new Error('await writer.ready before initializeCache');
      recorder.begin();
      cache.init({ ...ctx, writer, db: recorder.adapter });
      recorder.finish();
    },
    withCache(otherCache) { return createSessionIndexWriter({ client }, otherCache); },
    async patchGlobal(fields) { return request('patchGlobal', fields); },
    async renameSession(id, name) { return request('renameSession', id, name); },
    async rekeySessionMeta(from, to) { return request('rekeySessionMeta', from, to); },
    async completeRepairFolders(folders) { return request('completeRepairFolders', folders); },
    async buildProjectsFromCache(showArchived) { return compute('buildProjectsFromCache', showArchived); },
    async refreshFolder(folder, opts) { return compute('refreshFolder', folder, opts); },
    async dropFolderRows(folder, opts) { return compute('dropFolderRows', folder, opts); },
    async releaseLiveSession(id) {
      if (terminated || closing) throw new Error('writer is closing');
      return commandScope.run(owner, () => admit(() => compute('releaseLiveSession', id)));
    },
    async writeScannedFolder(result, unverified) { return compute('writeScannedFolder', result, unverified); },
    async writeScannedFolderPartial(result) { return compute('writeScannedFolderPartial', result); },
    async applyProjectsWorkerEffects(result) {
      if (result.effects?.length === 0 && result.keptLiveRows?.length === 0) return;
      return compute('applyProjectsWorkerEffects', result);
    },
    async archiveProjectFolders(groups, opts, deps) {
      await ready;
      if (!backend.isInitialScanComplete()) return { error: 'indexing' };
      const targets = archive.validArchiveGroups(groups).map(group => ({ group, alias: parseFolderKey(group.folderKey).alias }));
      const disabled = [], failed = [];
      try {
        const diskIds = [];
        for (const { group, alias } of targets) {
          const folders = new Set([alias ? alias + '::' + encodeProjectPath(group.projectPath) : encodeProjectPath(group.projectPath)]);
          for (const row of backend.getAllCached()) if (row.projectPath === group.projectPath && parseFolderKey(row.folder).alias === alias) folders.add(row.folder);
          const ids = [];
          for (const folder of folders) {
            const dir = cache.resolveFolderDir(folder);
            if (!dir || !fs.existsSync(dir)) continue;
            await writer.refreshFolder(folder);
            for (const file of fs.readdirSync(dir)) if (file.endsWith('.jsonl')) ids.push(file.slice(0, -6));
          }
          diskIds.push(ids);
        }
        const projects = deps.mergeProjects(await writer.buildProjectsFromCache(true));
        const now = deps.now();
        const offers = backend.getSetting('scheduleReenableOffers') || {};
        const entries = targets.map(({ group, alias }, i) => {
          const entry = archive.archivedEntry(alias, group.projectPath);
          const disabledFiles = (offers[entry]?.disabledSchedules || []).filter(file => {
            try { return require('./schedule-runner').parseFrontmatter(fs.readFileSync(file, 'utf8')).meta.enabled === 'false'; } catch { return false; }
          });
          return { entry, disabledFiles, record: { archivedAt: now,
            knownSessionIds: archive.knownIdsForGroup({ projects, activeSessions: deps.activeSessions, diskIds: diskIds[i], alias, projectPath: group.projectPath }) } };
        });
        const accepted = await request('beginArchive', entries);
        const registered = await writer.scheduleRegistry(deps.seedProjects).list();
        const completed = {};
        for (const { group, alias } of targets) {
          const entry = archive.archivedEntry(alias, group.projectPath);
          completed[entry] = [];
          for (const schedule of archive.archivePlanForGroups([group], { registered, scan: deps.scan, realpath: deps.realpath })) {
            if (!schedule.disableable || !opts?.disableSchedules?.includes(schedule.filePath)) continue;
            let result;
            try { result = deps.setEnabled(schedule.filePath, false, { projectRoot: group.projectPath }); }
            catch (error) { result = { error: error.message }; }
            if (result.ok) { completed[entry].push(schedule.filePath); disabled.push(schedule.name); }
            else failed.push({ name: schedule.name, error: result.error });
          }
        }
        const completedArchive = await request('completeArchive', accepted, completed);
        deps.notify();
        if (!completedArchive) return { error: 'archive changed before schedule completion', disabled };
        return { ok: true, disabled, failed };
      } catch (error) { return { error: error.message, disabled }; }
    },
    async applyAndPersistArchived(projects, showArchived) {
      await ready;
      let kept;
      for (let attempt = 0; ; attempt++) {
        const archived = backend.getSetting('archivedProjects') || {};
        const snapshot = { archivedProjects: archived, hiddenProjects: (backend.getSetting('global') || {}).hiddenProjects || [],
          scheduleReenableOffers: backend.getSetting('scheduleReenableOffers') || {} };
        const updates = new Map();
        const copies = projects.map(project => {
          const copy = { ...project };
          if (project.sessions) copy.sessions = project.sessions.map(session => ({ ...session }));
          return copy;
        });
        kept = archive.applyAndPersistArchived(copies, showArchived, {
          getSetting: key => updates.has(key) ? updates.get(key) : backend.getSetting(key),
          setSetting: (key, value) => updates.set(key, value),
          scheduleName: () => null,
        });
        if (!updates.has('archivedProjects')) break;
        const entries = Object.keys(archived).filter(entry => !Object.hasOwn(updates.get('archivedProjects'), entry));
        try {
          await request('retireArchivedEntries', entries, snapshot);
          break;
        } catch (error) {
          if (error.code !== 'WRITER_STALE') throw error;
          if (attempt === 2) break;
        }
      }
      const offers = backend.getSetting('scheduleReenableOffers') || {};
      for (const project of kept) {
        const offer = offers[archive.archivedEntry(project.remoteAlias || null, project.projectPath)];
        const names = (offer?.disabledSchedules || []).map(file => {
          try { return require('./schedule-runner').parseFrontmatter(fs.readFileSync(file, 'utf8')).meta.name || path.basename(file); } catch { return null; }
        }).filter(Boolean);
        if (names.length) project.reenableOffer = offer.failed?.length ? { names, failed: offer.failed } : { names };
      }
      return kept;
    },
    async reenableOfferedSchedules(projectPath, folderKey, deps) {
      if (typeof projectPath !== 'string' || projectPath === '') return { error: 'invalid project path' };
      const entry = archive.archivedEntry(parseFolderKey(folderKey).alias, projectPath);
      const offer = await request('beginOffer', entry);
      if (!offer) return { ok: true, enabled: [], failed: [] };
      const result = (deps.reenable || archive.reenableScheduleFiles)(offer.disabledSchedules, projectPath);
      const completed = await request('completeOffer', entry, offer, result);
      deps.notify();
      if (!completed) return { error: 'schedule offer changed before completion', enabled: result.enabled,
        failed: result.failed.map(f => ({ name: f.name, error: f.error })) };
      return { ok: true, enabled: result.enabled, failed: result.failed.map(f => ({ name: f.name, error: f.error })) };
    },
    async dismissReenableOffer(projectPath, folderKey, deps) {
      const result = await request('dismissReenableOffer', projectPath, folderKey);
      if (result.ok) deps.notify();
      return result;
    },
    async cleanupWorktree(projectPath) { return request('cleanupWorktree', projectPath); },
    async remapProjectTranscripts(args) {
      await request('recordRemap', args.folder, args.newPath);
      remapProjectTranscripts({ ...args, getSetting: () => null, setSetting() {} });
      await request('completeRemap', args.folder, args.newPath);
    },
    scheduleRegistry(seed) {
      const call = async (action, projectPath) => {
        await ready;
        return request('scheduleRegistry', action, backend.getSetting('scheduleProjects') == null ? seed() : [], projectPath);
      };
      return { list: () => admit(() => call('list')), add: p => admit(() => call('add', p)), remove: p => admit(() => call('remove', p)) };
    },
    createWhatsNew(options) {
      const menu = createWhatsNew({ ...options, getSetting: () => null, setSetting() {} });
      return {
        startup: () => admit(async () => {
          const { readChangelog, log, ...data } = options;
          let text;
          try { text = readChangelog(); } catch (error) { log.warn('[whats-new] ' + error.message); return null; }
          const result = await request('whatsNewStartup', data, text);
          if (result.error) log.warn('[whats-new] ' + result.error);
          return result.sections ? { version: data.currentVersion, sections: result.sections } : null;
        }),
        dismissed: () => admit(() => request('patchGlobal', { lastSeenVersion: options.currentVersion })),
        forMenu: menu.forMenu,
      };
    },
    async closeDb() {
      if (closing) return closing;
      accepting = false;
      closing = (async () => {
        await ready;
        while (pending.size) await Promise.allSettled([...pending]);
        backend.closeDb();
        await client.close();
      })();
      return closing;
    },
    beginShutdown(drain) {
      accepting = false;
      return commandScope.run(owner, () => Promise.resolve().then(drain));
    },
    terminate() {
      accepting = false;
      terminated = true;
      return client.terminate();
    },
    async drain() {
      await ready;
      await Promise.allSettled([...pending]);
      await client.request('drain');
    },
    measurements: () => request('measurements'),
  };
  for (const name of ['setSetting', 'deleteSetting', 'toggleStar', 'setStarred', 'setArchived', 'deleteCachedSession',
    'deleteSearchSession', 'deleteCachedFolder', 'deleteSearchFolder', 'deleteSearchType', 'applySearchFileBatch',
    'setCachedEntrypoints', 'setCachedCustomTitles', 'setCachedContinuationIndex', 'setInitialScanComplete',
    'clearArchivedEntry', 'hideProject', 'unhideProject', 'revealAddedProject', 'dropRemoteFolder',
    'upsertCachedSessions', 'replaceSessionMetrics', 'upsertSearchEntries', 'setName']) writer[name] = (...args) => request(name, ...args);
  for (const [name, fn] of Object.entries(writer)) {
    if (typeof fn !== 'function' || ['initializeCache', 'withCache', 'scheduleRegistry', 'createWhatsNew', 'closeDb', 'drain', 'beginShutdown', 'terminate', 'releaseLiveSession'].includes(name)) continue;
    writer[name] = (...args) => admit(() => fn(...args));
  }
  return writer;
}

module.exports = { createSessionIndexWriter };
