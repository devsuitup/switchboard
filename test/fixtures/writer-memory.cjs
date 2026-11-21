'use strict';
const { createSessionIndexWriter } = require('../../session-index-writer');
const { createWriterCommands } = require('../../session-index-commands');
const { rowWitness, fullIndexConfig } = require('../../src/main/session-index/full-read-state');
function memoryWriter(backend, cache) {
  if (!backend.beginFullIndex) {
    const folders = new Map();
    const getFolderMeta = backend.getFolderMeta?.bind(backend);
    const setFolderMeta = backend.setFolderMeta?.bind(backend);
    const deleteCachedFolder = backend.deleteCachedFolder?.bind(backend);
    backend.getFolderMeta = folder => {
      const meta = getFolderMeta?.(folder);
      return meta || folders.has(folder) ? { ...meta, ...folders.get(folder) } : null;
    };
    backend.setFolderMeta = (folder, projectPath, indexMtimeMs) => {
      setFolderMeta?.(folder, projectPath, indexMtimeMs);
      folders.set(folder, { ...folders.get(folder), folder, projectPath, indexMtimeMs });
    };
    backend.deleteCachedFolder = (folder, opts) => {
      const previous = backend.getFolderMeta(folder);
      deleteCachedFolder?.(folder);
      folders.delete(folder);
      if (opts?.preserveFullIndex && previous?.fullIndexPending) {
        folders.set(folder, { ...previous, projectPath: null, indexMtimeMs: 0 });
        setFolderMeta?.(folder, null, 0);
      }
    };
    backend.beginFullIndex = (folder, token) => {
      const previous = backend.getFolderMeta(folder);
      folders.set(folder, { ...previous, folder, fullIndexPending: token, fullIndexVersion: null, fullIndexConfig: null });
      return previous;
    };
    backend.invalidateFullIndex = folder => {
      const previous = backend.getFolderMeta(folder);
      if (previous) folders.set(folder, { ...previous, fullIndexVersion: null, fullIndexConfig: null });
    };
    backend.sealFullIndex = (folder, token, version, config, capturedConfig) => {
      const previous = backend.getFolderMeta(folder);
      if (previous?.fullIndexPending !== token) return false;
      if (capturedConfig && capturedConfig !== fullIndexConfig({ ...(backend.getSetting('global') || {}),
        remappedProjects: backend.getSetting('projectRemaps') || {} }, JSON.parse(capturedConfig).roots[0])) return false;
      folders.set(folder, { ...previous, fullIndexVersion: version, fullIndexConfig: config, fullIndexPending: null });
      return true;
    };
    backend.invalidateFullRead = id => {
      const row = backend.getCachedSession(id);
      if (row) row.fullReadStamp = null;
    };
    backend.certifyFullRead = (folder, token, id, stamp, witness) => {
      const row = backend.getCachedSession(id);
      if (backend.getFolderMeta(folder)?.fullIndexPending !== token || !row || row.folder !== folder || rowWitness(row) !== witness) return false;
      row.fullReadStamp = stamp;
      return true;
    };
  }
  const read = { getAllCached: () => [], getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(),
    listSettingKeys: () => [], getProjectsRevision: () => 'fixture', ...backend };
  const commands = createWriterCommands(backend);
  const client = {
    ready: Promise.resolve(),
    requestForWorkflow(_workflowId, name, ...args) { return this.request(name, ...args); },
    async fenceWorkflow() {},
    async request(name, ...args) {
      if (name === 'deriveCachedNames') {
        let derived = true;
        for (const row of args[0]) {
          const result = backend.deriveCachedName(row.sessionId, row.stamp, row.witness, row.collision);
          derived = !!result && backend.certifyNameDerivation(row.sessionId, row.stamp, result.witness, result.collision) && derived;
        }
        return derived;
      }
      if (name === 'effects') {
        for (const effect of args[0]) await this.request(effect.name, ...effect.args);
        return;
      }
      if (name === 'dropRemoteFolder') {
        backend.deleteCachedFolder(args[0]);
        backend.deleteSearchFolder(args[0]);
        return commands.completeRepairFolders(args);
      }
      const command = commands[name] || backend[name];
      if (!command) throw new Error('unknown memory command ' + name);
      return command(...args);
    },
    async close() {},
  };
  return createSessionIndexWriter({ client, readonlyBackend: read }, cache);
}
module.exports = { memoryWriter };
