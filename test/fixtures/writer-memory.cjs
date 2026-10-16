'use strict';
const { createSessionIndexWriter } = require('../../session-index-writer');
const { createWriterCommands } = require('../../session-index-commands');
function memoryWriter(backend, cache) {
  const read = { getAllCached: () => [], getAllMeta: () => new Map(), getAllFolderMeta: () => new Map(),
    listSettingKeys: () => [], getProjectsRevision: () => 'fixture', ...backend };
  const commands = createWriterCommands(backend);
  const client = {
    ready: Promise.resolve(),
    async request(name, ...args) {
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
