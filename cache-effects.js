'use strict';

// see .ai/contexts/session-index-writer.md
function createCacheEffects(read) {
  let rows, meta, folders, settings, effects, active = false;
  function begin() {
    rows = new Map();
    meta = new Map();
    folders = new Map();
    settings = new Map([['_writer_revision', read.getSetting('_writer_revision')]]);
    effects = [];
    active = true;
  }
  const rowFor = id => {
    if (!rows.has(id)) rows.set(id, structuredClone(read.getCachedSession(id)));
    return rows.get(id);
  };
  const metaFor = id => {
    if (!meta.has(id)) meta.set(id, structuredClone(read.getMeta(id)));
    return meta.get(id);
  };
  function mergedRows(source) {
    const result = new Map(source.map(row => [row.sessionId, row]));
    for (const [id, row] of rows) { if (row) result.set(id, row); else result.delete(id); }
    return [...result.values()];
  }
  const adapter = {
    ...read,
    getAllCached: () => active ? mergedRows(read.getAllCached()) : read.getAllCached(),
    getCachedByFolder: folder => active ? mergedRows(read.getCachedByFolder(folder)).filter(row => row.folder === folder) : read.getCachedByFolder(folder),
    getCachedSession: id => active ? rowFor(id) || null : read.getCachedSession(id),
    getAllMeta: (...args) => active ? new Map([...read.getAllMeta(...args), ...meta]) : read.getAllMeta(...args),
    getMeta: id => active ? metaFor(id) : read.getMeta(id),
    getAllFolderMeta: () => active ? new Map([...read.getAllFolderMeta(), ...folders]) : read.getAllFolderMeta(),
    getFolderMeta: folder => active ? folders.has(folder) ? folders.get(folder) : read.getFolderMeta(folder) : read.getFolderMeta(folder),
    getSetting: key => {
      if (!active) return read.getSetting(key);
      if (!settings.has(key)) settings.set(key, structuredClone(read.getSetting(key)));
      return structuredClone(settings.get(key) ?? null);
    },
    isInitialScanComplete: () => adapter.getSetting('initial_scan_complete') === true,
  };
  const writes = {
    upsertCachedSessions: sessions => { for (const row of sessions) rows.set(row.sessionId, { ...rowFor(row.sessionId), ...row }); },
    deleteCachedSession: id => rows.set(id, null),
    deleteCachedFolder: folder => { for (const row of adapter.getCachedByFolder(folder)) rows.set(row.sessionId, null); folders.set(folder, null); },
    touchCachedModified: (id, modified) => { const row = rowFor(id); if (row) Object.assign(row, { modified, fileMtime: modified }); },
    setFolderMeta: (folder, projectPath, indexMtimeMs) => folders.set(folder, { folder, projectPath, indexMtimeMs }),
    setName: (id, name, source = 'user') => meta.set(id, { ...metaFor(id), sessionId: id, name, nameSource: source }),
    setSetting: (key, value) => settings.set(key, value),
    replaceSessionMetrics() {}, deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {},
    setCachedEntrypoints() {}, setCachedCustomTitles() {}, setCachedContinuationIndex() {},
    setInitialScanComplete: () => settings.set('initial_scan_complete', true),
  };
  for (const [name, write] of Object.entries(writes)) adapter[name] = (...args) => {
    if (!active) throw new Error('cache mutation outside writer command');
    if (name === 'setSetting' && args[0] === 'bridge_uuid_reindex_folders') {
      const removed = (adapter.getSetting(args[0]) || []).filter(key => !args[1].includes(key));
      effects.push({ name: 'completeRepairFolders', args: [removed] });
    } else effects.push({ name, args: structuredClone(args) });
    return write(...args);
  };
  return { adapter, begin, revision: () => settings.get('_writer_revision') || 0, finish: () => { active = false; return effects; } };
}

module.exports = { createCacheEffects };
