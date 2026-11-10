'use strict';
const path = require('node:path');
const { identity, canonicalPath, membershipDigest, durableRowLinks: links, stable, digest, OPTION_KEYS, isRecord, text, fail } = require('./project-delete-identity');
const { parseFolderKey } = require('../remote/remote-hosts');
const { createProjectDeleteProgress, bind } = require('./project-delete-progress');
const { archivedEntry } = require('../../../archived-projects');

const readDurableScope = (db, input, memo) => createProjectDeleteProgress(db).readScope(input, memo);
const settingsPath = (value, alias) => {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '') || '/';
  return alias === null && process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
// see .ai/contexts/project-delete.md
function validateDeletionManifest(db, input) {
  if (!isRecord(input) || Object.keys(input).some(key => !['project', 'operationId', 'expectedRevision', 'expectedProjectEpoch', 'writerMembershipDigest', 'membershipDigest', 'inventory', 'groups', 'members', 'options'].includes(key))
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !Number.isSafeInteger(input.expectedProjectEpoch) || input.expectedProjectEpoch < 0
    || !isRecord(input.options) || Object.keys(input.options).length !== OPTION_KEYS.length
    || OPTION_KEYS.some(key => typeof input.options[key] !== 'boolean') || input.options.schedules || input.options.transcripts
    || !isRecord(input.inventory) || Object.keys(input.inventory).sort().join(',') !== 'groups,jobs,members,schedules,tabs'
    || Object.values(input.inventory).some(rows => !Array.isArray(rows))
    || Object.values(input.inventory).reduce((n, rows) => n + rows.length, 0) > 50000
    || !Array.isArray(input.groups) || !Array.isArray(input.members)
    || stable(input.groups) !== stable(input.inventory.groups) || stable(input.members) !== stable(input.inventory.members)) throw fail('DELETION_MANIFEST', 'Explicit options and identical complete inventory required');
  const memo = new Map(), ownerKeys = new Map();
  const sameOwner = (row, project) => {
    if (!ownerKeys.has(row)) {
      let key = null;
      try { key = identity({ alias: parseFolderKey(row.folder).alias, projectPath: row.projectPath }, memo).key; } catch {}
      ownerKeys.set(row, key);
    }
    return ownerKeys.get(row) === project.key;
  };
  const project = identity(input.project, memo), binding = bind(input, memo);
  const snapshot = readDurableScope(db, { project: input.project }, memo);
  if (binding.expectedEpoch !== snapshot.projectEpoch || input.expectedRevision !== snapshot.writerRevision
    || input.writerMembershipDigest !== snapshot.writerMembershipDigest) throw fail('WRITER_STALE', 'Durable ownership or revision changed');
  if (membershipDigest(input.project, input.inventory, memo) !== input.membershipDigest) throw fail('DELETION_MANIFEST', 'Membership digest mismatch');
  for (const kind of ['tabs', 'jobs', 'schedules']) {
    const seen = new Set();
    for (const row of input.inventory[kind]) {
      if (!text(row.id) || seen.has(row.id) || row.verified !== true || identity(row, memo).key !== project.key
        || row.linked === true || (kind !== 'schedules' && !['claude', 'codex', 'terminal'].includes(row.runtime))) throw fail('DELETION_OWNERSHIP', 'Runtime inventory contradicts selected identity');
      seen.add(row.id);
    }
  }
  const fence = db.projectDeletion.fence(project.key);
  if (fence?.blocked && !sealedPartial(db, project.key, fence)) throw fail('PROJECT_EPOCH_STALE', 'Project is blocked');
  const { rows, ownership, folders } = snapshot.scope;
  const ownershipById = new Map(), ownershipByFolder = new Map(), folderMeta = new Map(folders), groupsByFolder = new Map();
  for (const row of ownership) {
    ownershipById.set(row.sessionId, row);
    if (!ownershipByFolder.has(row.folder)) ownershipByFolder.set(row.folder, []);
    ownershipByFolder.get(row.folder).push(row);
    sameOwner(row, project);
  }
  for (const group of input.groups) if (!groupsByFolder.has(group.folderKey)) groupsByFolder.set(group.folderKey, group);
  const groupKeys = new Set(), exclusiveFolders = [];
  for (const group of input.groups) {
    if (group.effect === 'kept') {
      if (identity(group, memo).key === project.key) throw fail('DELETION_OWNERSHIP', 'Selected group cannot be kept');
      continue;
    }
    if (group.effect !== 'selected' || group.verified !== true || !text(group.folderKey) || groupKeys.has(group.folderKey)
      || !['claude', 'codex'].includes(group.runtime) || identity(group, memo).key !== project.key || parseFolderKey(group.folderKey).alias !== project.alias) throw fail('DELETION_OWNERSHIP', 'Unverified group ownership');
    const stored = folderMeta.get(group.folderKey);
    if (!stored || !sameOwner({ folder: group.folderKey, projectPath: stored.projectPath }, project)) throw fail('DELETION_OWNERSHIP', 'Group lacks durable mapping');
    groupKeys.add(group.folderKey);
    if ((ownershipByFolder.get(group.folderKey) || []).every(row => sameOwner(row, project))) exclusiveFolders.push(group.folderKey);
  }
  const selectedRows = new Map(rows.map(row => [row.sessionId, row])), ids = new Set();
  const metadataIds = new Set([...db.getAllMeta().keys(), ...db.projectDeletion.metadataFields().map(row => row.sessionId)]);
  const linked = new Set(rows.flatMap(links)), foreignLinks = new Set(ownership.filter(row => !sameOwner(row, project)).flatMap(links));
  for (const member of input.members) {
    if (!text(member.id) || !text(member.conversationId) || !text(member.partId) || member.linked === true
      || ids.has(member.id) || member.verified !== true || identity(member, memo).key !== project.key
      || !groupKeys.has(member.folderKey) || member.cwd !== null && canonicalPath(member.cwd, member.alias, memo) !== project.projectPath
      || !['claude', 'codex'].includes(member.runtime)
      || groupsByFolder.get(member.folderKey)?.runtime !== member.runtime) throw fail('DELETION_OWNERSHIP', 'Invalid exact member');
    const row = selectedRows.get(member.id);
    const owner = ownershipById.get(member.id);
    if (foreignLinks.has(member.id) || owner && !sameOwner(owner, project)) throw fail('DELETION_OWNERSHIP', 'Ambiguous session ID ownership');
    if (row) {
      if (row.folder !== member.folderKey || member.metadataOnly === true || member.indexed !== true || member.present !== true
        || (row.parentSessionId || null) !== (member.parentSessionId || null)) throw fail('DELETION_OWNERSHIP', 'Member contradicts durable row');
    } else if (member.metadataOnly !== true || !metadataIds.has(member.id) || !linked.has(member.id)) throw fail('DELETION_OWNERSHIP', 'Historical metadata lacks independent ownership proof');
    ids.add(member.id);
  }
  if (rows.some(row => !ids.has(row.sessionId) || !groupKeys.has(row.folder))
    || [...linked].some(id => metadataIds.has(id) && !ownershipById.has(id) && !ids.has(id))) throw fail('DELETION_OWNERSHIP', 'Exact persisted membership is incomplete');
  const durableOwners = [...ownership, ...folders.map(([folder, row]) => ({ folder, projectPath: row.projectPath }))];
  const keys = db.listSettingKeys('project:').filter(key => settingsPath(key.slice(8), project.alias) === settingsPath(input.project.projectPath, project.alias));
  if (input.options.settings) {
    if (!durableOwners.some(row => sameOwner(row, project)) || durableOwners.some(row => !text(row.projectPath))) throw fail('SETTINGS_OWNERSHIP_UNKNOWN', 'Settings ownership is unknown');
    const owners = durableOwners.filter(row => settingsPath(row.projectPath, project.alias) === settingsPath(input.project.projectPath, project.alias));
    if (owners.some(row => !sameOwner(row, project))) throw fail('SHARED_SETTINGS', 'Another host owns the path-only settings key');
    if (keys.length > 1) throw fail('SHARED_SETTINGS', 'Ambiguous path-only settings spelling');
  }
  const restoreIds = new Set([...ids, ...input.inventory.tabs.flatMap(row => [row.id, row.sessionId].filter(text))]);
  const invalidation = { sessionIds: [...ids].sort(), folderKeys: [...groupKeys].sort(),
    restoreTargets: [...restoreIds].sort().map(sessionId => ({ sessionId, alias: project.alias, projectPath: project.projectPath })) };
  return { project, entry: archivedEntry(project.alias, input.project.projectPath), options: { ...input.options },
    sessionIds: invalidation.sessionIds, exclusiveFolders: exclusiveFolders.sort(), settingsKey: keys[0] || null, invalidation };
}

function buildDeletionUnits(validated) {
  const units = validated.sessionIds.map(id => ({ category: 'session', target: { id, erase: validated.options.sessions } }));
  for (const folder of validated.exclusiveFolders) units.push({ category: 'folderMeta', target: folder });
  if (validated.options.settings && validated.settingsKey) units.push({ category: 'settings', target: validated.settingsKey });
  return units;
}
function buildFinalizationUnits(validated) {
  return [{ category: 'finalize', target: { project: validated.project, entry: validated.entry,
    folderKeys: validated.invalidation.folderKeys, restoreTargets: validated.invalidation.restoreTargets } }];
}
function applyDeletionUnit(db, { category, target }) {
  if (category === 'session') {
    if (target.erase) db.projectDeletion.eraseMetadata(target.id);
    else db.setArchived(target.id, true);
    db.projectDeletion.clearSearchStaging(target.id);
    db.deleteSearchSession(target.id);
    db.deleteCachedSession(target.id);
    db.deleteSetting('continuationChoice:' + target.id);
  } else if (category === 'folderMeta') db.projectDeletion.deleteFolderMeta(target);
  else if (category === 'settings') db.deleteSetting(target);
  else if (category === 'finalize') {
    const { project, entry } = target, current = db.getSetting('global') || {};
    const matches = value => {
      const { alias, folder } = parseFolderKey(value);
      try { return identity({ alias, projectPath: alias && folder === '' ? '/' : folder }).key === project.key; } catch { return false; }
    };
    const scopes = { ...current.hiddenProjectScopes };
    const existing = (current.hiddenProjects || []).find(value => matches(value) && (!Object.hasOwn(scopes[value] || {}, 'alias') || scopes[value].alias === project.alias));
    const hiddenEntry = existing || entry;
    if (!existing && Object.hasOwn(scopes[hiddenEntry] || {}, 'alias') && scopes[hiddenEntry].alias !== project.alias) throw fail('DELETION_OWNERSHIP', 'Visibility key already belongs to another host');
    const hiddenProjects = [...new Set([...(current.hiddenProjects || []), hiddenEntry])];
    if (!existing) scopes[hiddenEntry] = { alias: project.alias };
    const ids = new Set(target.restoreTargets.map(row => row.sessionId));
    const openWorkingSet = (current.openWorkingSet || []).filter(row => {
      if (!ids.has(row.sessionId)) return true;
      if (typeof row.projectPath !== 'string') return true;
      try { return canonicalPath(row.projectPath, project.alias) !== project.projectPath; } catch { return true; }
    });
    db.setSetting('global', { ...current, hiddenProjects, hiddenProjectKinds: { ...current.hiddenProjectKinds, [hiddenEntry]: 'delete' },
      ...(current.hiddenProjectScopes || Object.keys(scopes).length ? { hiddenProjectScopes: scopes } : {}),
      ...(current.openWorkingSet ? { openWorkingSet } : {}) });
    for (const key of ['archivedProjects', 'scheduleReenableOffers']) {
      const stored = db.getSetting(key);
      const selected = Object.keys(stored || {}).filter(matches);
      if (selected.length) { const next = { ...stored }; for (const value of selected) delete next[value]; db.setSetting(key, next); }
    }
    if (project.alias === null) {
      const stored = db.getSetting('scheduleProjects');
      if (Array.isArray(stored)) db.setSetting('scheduleProjects', stored.filter(value => {
        try { return identity({ alias: null, projectPath: value }).key !== project.key; } catch { return true; }
      }));
    }
  } else throw fail('DELETION_UNIT', 'Unknown deletion effect');
  return { status: 'completed', category, target };
}
function* completeProjectDeletion(db, input) {
  bind(input);
  const progress = createProjectDeleteProgress(db), existing = db.projectDeletion.operation(input.operationId);
  if (existing) {
    yield () => {
      if (!existing.manifestHash) throw fail('DELETION_TERMINAL', 'Operation evidence is unavailable or fenced');
      if (existing.manifestHash.split(':')[0] !== digest(input)) throw fail('DELETION_HASH', 'Operation ID reused with different manifest');
      return progress.read(input);
    };
    return;
  }
  const validated = validateDeletionManifest(db, input);
  const units = [...buildDeletionUnits(validated), ...buildFinalizationUnits(validated)];
  const manifest = { ...input, units };
  const apply = unit => applyDeletionUnit(db, unit);
  const beforeChunk = () => {
    const memo = new Map(), members = new Map(input.members.map(row => [row.id, row]));
    for (const row of db.getAllCached()) {
      let owner;
      try { owner = identity({ alias: parseFolderKey(row.folder).alias, projectPath: row.projectPath }, memo).key; } catch {}
      if (owner === validated.project.key) {
        const member = members.get(row.sessionId);
        if (!member || member.folderKey !== row.folder) throw fail('DELETION_OWNERSHIP', 'Current selected membership changed');
      } else if (members.has(row.sessionId) || links(row).some(id => members.has(id))) throw fail('DELETION_OWNERSHIP', 'Current member ownership became ambiguous');
    }
    for (const folder of validated.exclusiveFolders) {
      const stored = db.getAllFolderMeta().get(folder);
      if (stored && identity({ alias: parseFolderKey(folder).alias, projectPath: stored.projectPath }, memo).key !== validated.project.key) throw fail('DELETION_OWNERSHIP', 'Current folder ownership changed');
    }
  };
  let state;
  const result = value => value.state === 'committed' ? { ...value, invalidation: validated.invalidation } : value;
  yield () => {
    const tiny = units.length <= 2 && Buffer.byteLength(JSON.stringify(manifest)) <= 16000;
    state = progress.admit(manifest, tiny ? apply : undefined, { all: tiny, preflight: () => validateDeletionManifest(db, input) });
    return result(state);
  };
  while (!state.terminal) {
    yield () => {
      try {
        if (state.stagedUnits < units.length) state = progress.stage(manifest, units.slice(state.stagedUnits, state.stagedUnits + 16), { beforeChunk });
        else state = progress.apply(manifest, apply, { beforeChunk });
      } catch (error) { state = progress.failOperation(manifest, error); }
      return result(state);
    };
  }
}
function bindDeletionProducer(db, command, args) {
  const sessions = [], folders = [], projects = [], memo = new Map();
  const inspect = (name, values) => {
    if (name === 'effects') { for (const effect of values[0]) inspect(effect.name, effect.args); }
    else if (['setSetting', 'deleteSetting'].includes(name) && values[0].startsWith('continuationChoice:')) sessions.push({ id: values[0].slice('continuationChoice:'.length) });
    else if (name === 'upsertCachedSessions') for (const row of values[0]) sessions.push({ id: row.sessionId, folder: row.folder, projectPath: row.projectPath });
    else if (name === 'upsertSearchEntries') for (const row of values[0]) { if (row.type === 'session') sessions.push({ id: row.id, folder: row.folder }); }
    else if (name === 'applySearchFileBatch' && values[0] === 'session') {
      for (const id of values[1]) sessions.push({ id });
      inspect('upsertSearchEntries', [values[2]]);
    } else if (['setCachedEntrypoints', 'setCachedCustomTitles'].includes(name)) for (const row of values[0]) sessions.push({ id: row.sessionId });
    else if (['setName', 'renameSession', 'toggleStar', 'setStarred', 'setArchived', 'replaceSessionMetrics', 'deleteCachedSession', 'deleteSearchSession', 'touchCachedModified', 'setCachedContinuationIndex', 'setCachedFileSize', 'rekeySessionMeta'].includes(name)) {
      sessions.push({ id: values[0] });
      if (name === 'rekeySessionMeta') sessions.push({ id: values[1] });
    } else if (['setFolderMeta', 'deleteCachedFolder', 'deleteSearchFolder', 'dropRemoteFolder', 'completeRepairFolders'].includes(name)) {
      for (const folder of name === 'completeRepairFolders' ? values[0] : [values[0]]) folders.push(folder);
      if (name === 'setFolderMeta' && values[1]) projects.push({ alias: parseFolderKey(values[0]).alias, projectPath: values[1], folder: values[0] });
    }
  };
  inspect(command, args);
  if (!sessions.length && !folders.length && !projects.length) return [];
  const owners = new Map(), folderOwners = new Map();
  const add = (map, key, project) => {
    if (!key) return;
    const value = identity(project, memo);
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(value.key, value);
  };
  for (const row of db.getAllCached()) {
    try {
      const project = { alias: parseFolderKey(row.folder).alias, projectPath: row.projectPath };
      for (const id of [row.sessionId, ...links(row)]) add(owners, id, project);
      add(folderOwners, row.folder, project);
    } catch {}
  }
  for (const [folder, row] of db.getAllFolderMeta()) {
    try { add(folderOwners, folder, { alias: parseFolderKey(folder).alias, projectPath: row.projectPath }); } catch {}
  }
  for (const operation of [...db.projectDeletion.active(), ...db.projectDeletion.terminal().map(row => db.projectDeletion.operation(row.operationId))]) {
    const [alias, projectPath] = JSON.parse(operation.projectKey), project = { alias, projectPath };
    for (const unit of db.projectDeletion.units(operation.operationId)) {
      const target = JSON.parse(unit.targetJson);
      if (unit.category === 'session') add(owners, target.id, project);
      if (unit.category === 'finalize') for (const folder of target.folderKeys || []) add(folderOwners, folder, project);
    }
  }
  for (const target of sessions) if (target.projectPath) {
    const project = { alias: parseFolderKey(target.folder).alias, projectPath: target.projectPath };
    add(owners, target.id, project);
    add(folderOwners, target.folder, project);
  }
  for (const project of projects) add(folderOwners, project.folder, project);
  const selected = new Map();
  let unowned = false;
  const include = project => { const value = identity(project, memo); selected.set(value.key, value); };
  for (const target of sessions) {
    const known = owners.get(target.id);
    if (known?.size > 1) throw fail('DELETION_OWNERSHIP', 'Ambiguous producer session identity');
    if (known?.size) for (const owner of known.values()) include(owner);
    else if (target.folder && !target.projectPath) for (const owner of folderOwners.get(target.folder)?.values() || []) include(owner);
    if (target.projectPath) {
      const supplied = identity({ alias: parseFolderKey(target.folder).alias, projectPath: target.projectPath }, memo);
      if (known?.size && !known.has(supplied.key)) throw fail('DELETION_OWNERSHIP', 'Producer contradicts durable ownership');
      include(supplied);
    }
    if (!known?.size && !target.projectPath && (!target.folder || !folderOwners.has(target.folder))) {
      if (db.projectDeletion.hasFences()) throw fail('PROJECT_EPOCH_STALE', 'Unowned producer cannot bypass deletion history');
      unowned = true;
    }
  }
  for (const folder of folders) for (const owner of folderOwners.get(folder)?.values() || []) include(owner);
  for (const project of projects) include(project);
  return [...selected.values()].map(project => ({ key: project.key, epoch: db.projectDeletion.fence(project.key)?.epoch || 0 }))
    .concat(unowned ? [{ key: null, epoch: 0 }] : []);
}

function assertDeletionProducer(db, binding) {
  for (const expected of binding) {
    if (expected.key === null) {
      if (db.projectDeletion.hasFences()) throw fail('PROJECT_EPOCH_STALE', 'Unowned producer predates a deletion epoch');
      continue;
    }
    const current = db.projectDeletion.fence(expected.key) || { epoch: 0, blocked: 0 };
    const partial = sealedPartial(db, expected.key, current);
    if (current.epoch !== expected.epoch || current.blocked && !partial) throw fail('PROJECT_EPOCH_STALE', 'Producer project epoch changed or is blocked');
  }
}
function sealedPartial(db, key, fence) {
  return fence.blocked && !fence.operationId && db.projectDeletion.terminal().some(item => {
    const row = db.projectDeletion.operation(item.operationId);
    return row.projectKey === key && row.state === 'partial' && row.sealed && row.ownedEpoch + 1 === fence.epoch;
  });
}
module.exports = { validateDeletionManifest, readDurableScope, buildDeletionUnits, applyDeletionUnit, buildFinalizationUnits, completeProjectDeletion, bindDeletionProducer, assertDeletionProducer };
