'use strict';

// see .ai/contexts/session-index-writer.md
function createCacheEffects(read) {
  let rows, meta, folders, settings, effects, active = false;
  function begin() {
    const snapshot = read.snapshotForEffects?.() || { rows: read.getAllCached(), meta: read.getAllMeta(true), folders: read.getAllFolderMeta(), settings: read.listSettingKeys('').map(key => [key, read.getSetting(key)]) };
    rows = new Map(snapshot.rows.map(row => [row.sessionId, row]));
    meta = snapshot.meta;
    folders = snapshot.folders;
    settings = new Map(snapshot.settings);
    effects = [];
    active = true;
  }
  const adapter = {
    ...read,
    getAllCached: () => active ? [...rows.values()] : read.getAllCached(),
    getCachedByFolder: folder => active ? [...rows.values()].filter(row => row.folder === folder) : read.getCachedByFolder(folder),
    getCachedSession: id => active ? rows.get(id) || null : read.getCachedSession(id),
    getAllMeta: (...args) => active ? meta : read.getAllMeta(...args),
    getMeta: id => active ? meta.get(id) : read.getMeta(id),
    getAllFolderMeta: () => active ? folders : read.getAllFolderMeta(),
    getFolderMeta: folder => active ? folders.get(folder) : read.getFolderMeta(folder),
    getSetting: key => active ? structuredClone(settings.get(key) ?? null) : read.getSetting(key),
    isInitialScanComplete: () => active ? settings.get('initial_scan_complete') === true : read.isInitialScanComplete(),
  };
  const writes = {
    upsertCachedSessions: sessions => { for (const row of sessions) rows.set(row.sessionId, { ...rows.get(row.sessionId), ...row }); },
    deleteCachedSession: id => rows.delete(id),
    deleteCachedFolder: folder => { for (const row of rows.values()) if (row.folder === folder) rows.delete(row.sessionId); },
    touchCachedModified: (id, modified) => { const row = rows.get(id); if (row) Object.assign(row, { modified, fileMtime: modified }); },
    setFolderMeta: (folder, projectPath, indexMtimeMs) => folders.set(folder, { folder, projectPath, indexMtimeMs }),
    setName: (id, name, source = 'user') => meta.set(id, { ...meta.get(id), sessionId: id, name, nameSource: source }),
    setSetting: (key, value) => settings.set(key, value),
    replaceSessionMetrics() {}, deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {},
    setCachedEntrypoints() {}, setCachedCustomTitles() {}, setCachedContinuationIndex() {}, setInitialScanComplete() {},
  };
  for (const [name, write] of Object.entries(writes)) adapter[name] = (...args) => {
    if (!active) throw new Error('cache mutation outside writer command');
    if (name === 'setSetting' && args[0] === 'bridge_uuid_reindex_folders') {
      const removed = (settings.get(args[0]) || []).filter(key => !args[1].includes(key));
      effects.push({ name: 'completeRepairFolders', args: [removed] });
    } else effects.push({ name, args: structuredClone(args) });
    return write(...args);
  };
  return { adapter, begin, revision: () => settings.get('_writer_revision') || 0, finish: () => { active = false; return effects; } };
}

module.exports = { createCacheEffects };
