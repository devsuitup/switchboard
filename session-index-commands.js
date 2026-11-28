'use strict';

const archive = require('./archived-projects');
const { scheduleRegistry } = require('./src/main/schedules/schedule-runner');
const { whatsNewOnStartup } = require('./src/main/app/changelog');
const { migrateSchedulesTabDefault } = require('./src/main/schedules/schedules-tab-migration');
const { isProjectHidden, longVisibilityPath } = require('./public/worktree-nesting');
const { createLongPathResolver } = require('./src/main/shared/long-path');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { archiveProjectIdentity: projectIdentity } = require('./src/main/projects/project-archive-workflow');
const { parseFolderKey, enabledHosts } = require('./src/main/remote/remote-hosts');
const { assertHarnessSettings } = require('./harnesses');

const requestError = (code, message) => Object.assign(new Error(message), { code });
const requestBytes = value => Buffer.isBuffer(value) || (ArrayBuffer.isView(value) && value.BYTES_PER_ELEMENT === 1);
const canonicalRequestArgs = value => requestBytes(value) ? JSON.stringify({ bytes: Buffer.from(value).toString('base64') })
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalRequestArgs(value[key])}`).join(',')}}`
    : JSON.stringify(value);
function hashSessionRequestCommand(command, input) {
  const { argsHash: _argsHash, ...args } = input;
  return createHash('sha256').update(canonicalRequestArgs({ command, args })).digest('hex');
}
function sessionRequestStem(value) {
  if (typeof value !== 'string' || value.includes('\0') || path.basename(value + '.json') !== value + '.json') {
    throw requestError('SESSION_REQUEST_INPUT', 'A safe filename stem is required');
  }
  return value.toLowerCase();
}
const serializeRequestOutcome = value => JSON.stringify(value, (key, part) => key === 'resultBytes' && part !== null
  ? Buffer.from(part.type === 'Buffer' ? part.data : part).toString('base64') : part);
const deserializeRequestOutcome = value => JSON.parse(value, (key, part) => key === 'resultBytes' && part !== null ? Buffer.from(part, 'base64') : part);

function createSessionRequestCommands(db) {
  const store = db.sessionRequests;
  const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const readOwner = key => {
    const row = store.get(key);
    return row ? { ...row, resultBytes: row.resultBytes === null ? null : Buffer.from(row.resultBytes) } : null;
  };
  const matches = (owner, input) => (input.rawHash != null && owner.rawHash === input.rawHash)
    || (input.suppliedHash != null && owner.suppliedHash === input.suppliedHash);
  function querySessionRequestOutcome(input) {
    const stemKey = sessionRequestStem(input.stemKey);
    for (const key of ['suppliedHash', 'rawHash']) if (input[key] != null && !hashValid(input[key])) throw requestError('SESSION_REQUEST_INPUT', 'Invalid request hash');
    if (!store.available()) throw requestError('SESSION_REQUEST_SCHEMA', 'Request journal schema is unavailable');
    const owner = readOwner(stemKey);
    if (!owner) return { state: 'absent', stemKey };
    const saved = input.rawHash && store.conflict(stemKey, input.rawHash);
    if (saved) return { state: 'conflict', owner, conflict: deserializeRequestOutcome(saved).conflict };
    if ((input.suppliedHash != null || input.rawHash != null) && !matches(owner, input)) return { state: 'conflict', owner, conflict: null };
    if (!matches(owner, input)) return { state: 'owned', owner };
    return { state: owner.resultBytes === null ? 'pending' : 'completed', owner };
  }
  function mutate(command, input) {
    const stemKey = sessionRequestStem(input.stemKey);
    if (sessionRequestStem(input.actualStem) !== stemKey || typeof input.actionToken !== 'string' || !input.actionToken || input.actionToken.includes('\0')) {
      throw requestError('SESSION_REQUEST_INPUT', 'Invalid publication stem or command token');
    }
    for (const key of Object.keys(input)) if (!['stemKey', 'actualStem', 'actionToken', 'argsHash', 'suppliedHash', 'rawHash', 'family', 'resultBytes'].includes(key)) {
      throw requestError('SESSION_REQUEST_INPUT', 'Unexpected request command field');
    }
    for (const key of ['suppliedHash', 'rawHash']) if (input[key] != null && !hashValid(input[key])) throw requestError('SESSION_REQUEST_INPUT', 'Invalid request hash');
    if (!hashValid(input.argsHash) || input.argsHash !== hashSessionRequestCommand(command, input)) throw requestError('SESSION_REQUEST_ARGS_HASH', 'Command arguments do not match their hash');
    if (!store.available()) throw requestError('SESSION_REQUEST_SCHEMA', 'Request journal schema is unavailable');
    const prior = store.receipt(stemKey, input.actionToken);
    if (prior) {
      if (prior.command !== command || prior.argsHash !== input.argsHash) throw requestError('SESSION_REQUEST_TOKEN_CONFLICT', 'Command token already has different arguments');
      return deserializeRequestOutcome(prior.outcomeJson);
    }
    const conflict = command === 'recordSessionRequestConflict';
    const claim = command === 'claimSessionResultNamespace';
    const consume = command === 'recordConsumedSessionStatusRequest';
    const family = input.family === undefined ? 'session-status' : input.family;
    if ((consume && (!hashValid(input.suppliedHash) || !['session-status', 'open-session'].includes(family)))
      || (!consume && !conflict && !['legacy', 'action'].includes(family))
      || (conflict && !hashValid(input.rawHash))
      || ((!claim || input.resultBytes !== undefined) && !requestBytes(input.resultBytes))) {
      throw requestError('SESSION_REQUEST_INPUT', 'Invalid request family, identity or result bytes');
    }
    if (family === 'action' && input.actualStem !== stemKey) throw requestError('SESSION_REQUEST_INPUT', 'Action publication stem must be canonical lowercase');
    const revision = (db.getSetting('_writer_revision') || 0) + 1, now = Date.now();
    let owner = readOwner(stemKey), outcome;
    if (conflict) {
      if (!owner) throw requestError('SESSION_REQUEST_ABSENT', 'A conflict requires an owned namespace');
      if (owner.rawHash === input.rawHash || matches(owner, input)) throw requestError('SESSION_REQUEST_INPUT', 'An owner replay is not a conflict');
      const saved = store.conflict(stemKey, input.rawHash);
      const result = saved ? deserializeRequestOutcome(saved).conflict : {
        stemKey, actualStem: input.actualStem, rawHash: input.rawHash, resultBytes: Buffer.from(input.resultBytes), createdAt: now, revision,
      };
      outcome = { state: 'conflict', owner, conflict: result };
    } else {
      if (!owner && (consume || claim)) {
        owner = { stemKey, suppliedHash: input.suppliedHash ?? null, rawHash: input.rawHash ?? null, family,
          actualStem: input.actualStem, resultBytes: input.resultBytes === undefined ? null : Buffer.from(input.resultBytes),
          createdAt: now, completedAt: input.resultBytes === undefined ? null : now, revision };
        store.insert(owner);
      } else if (!owner) throw requestError('SESSION_REQUEST_ABSENT', 'Publication requires a prior namespace claim');
      else if (matches(owner, input) && owner.family === family && !claim && !consume && owner.resultBytes === null) {
        owner = { ...owner, resultBytes: Buffer.from(input.resultBytes), completedAt: now, revision };
        store.publish(owner);
      }
      outcome = matches(owner, input) && owner.family !== family ? { state: 'conflict', owner, conflict: null }
        : querySessionRequestOutcome({ stemKey, suppliedHash: input.suppliedHash, rawHash: input.rawHash });
    }
    const receipt = { domainId: stemKey, actionToken: input.actionToken, argsHash: input.argsHash, revision, createdAt: now };
    outcome = { ...outcome, receipt };
    store.addReceipt({ ...receipt, command, rawHash: conflict ? input.rawHash : null, outcomeJson: serializeRequestOutcome(outcome) });
    return outcome;
  }
  return { querySessionRequestOutcome,
    recordConsumedSessionStatusRequest: input => mutate('recordConsumedSessionStatusRequest', input),
    recordSessionRequestConflict: input => mutate('recordSessionRequestConflict', input),
    claimSessionResultNamespace: input => mutate('claimSessionResultNamespace', input),
    recordSessionResultPublication: input => mutate('recordSessionResultPublication', input),
  };
}

function localHiddenEntriesEqualTo(global, projectPath, admits = () => true, normalize = longVisibilityPath(createLongPathResolver())) {
  const target = normalize(projectPath);
  return (global.hiddenProjects || []).filter(entry => typeof entry === 'string' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}::/.test(entry)
    && normalize(entry) === target && admits(entry, normalize));
}

function fieldsWithoutHiddenEntries(global, matched) {
  const kinds = { ...global.hiddenProjectKinds };
  const fields = { hiddenProjects: global.hiddenProjects.filter(p => !matched.includes(p)), hiddenProjectKinds: kinds };
  if (global.hiddenProjectScopes) fields.hiddenProjectScopes = { ...global.hiddenProjectScopes };
  if (global.hiddenProjectArchivedAt) fields.hiddenProjectArchivedAt = { ...global.hiddenProjectArchivedAt };
  for (const entry of matched) {
    delete kinds[entry];
    if (fields.hiddenProjectScopes) delete fields.hiddenProjectScopes[entry];
    if (fields.hiddenProjectArchivedAt) delete fields.hiddenProjectArchivedAt[entry];
  }
  return fields;
}

// see .ai/contexts/session-index-writer.md
function createWriterCommands(db) {
  const settings = { getSetting: db.getSetting, setSetting: db.setSetting, scheduleName: () => null };
  const patch = fields => {
    const global = { ...(db.getSetting('global') || {}), ...assertHarnessSettings(fields) };
    if (global.hiddenProjectArchivedAt && !Object.keys(global.hiddenProjectArchivedAt).length) delete global.hiddenProjectArchivedAt;
    return db.setSetting('global', global);
  };
  const entryProject = entry => { const { alias, folder } = parseFolderKey(entry); return { alias, projectPath: alias && folder === '' ? '/' : folder }; };
  const groupProjects = groups => archive.validArchiveGroups(groups).map(group => ({ alias: parseFolderKey(group.folderKey).alias, projectPath: group.projectPath }));
  const fence = project => db.projectDeletion?.fence(projectIdentity(project).key) || { epoch: 0, blocked: 0 };
  function epochs(projects, allowBlocked = false) {
    return projects.map(project => {
      const current = fence(project);
      if (!allowBlocked && current.blocked) throw requestError('PROJECT_EPOCH_STALE', 'Project is pending deletion or deleted');
      return { project, epoch: current.epoch };
    });
  }
  function guard(projects, proof, reopen = false) {
    for (const project of projects) {
      const identity = projectIdentity(project), current = fence(project);
      const expected = proof?.find(item => projectIdentity(item.project).key === identity.key)?.epoch;
      if ((proof ? expected === undefined || expected !== current.epoch : current.epoch !== 0) || (!reopen && current.blocked)) {
        throw requestError('PROJECT_EPOCH_STALE', 'Project epoch changed before writer admission');
      }
      if (reopen && current.operationId && !db.projectDeletion.operation(current.operationId)?.sealed) throw requestError('PROJECT_EPOCH_STALE', 'Project still owns unfinished deletion');
    }
  }
  function reopen(projects, proof) {
    guard(projects, proof, true);
    for (const project of projects) {
      const identity = projectIdentity(project), current = fence(project);
      if (current.epoch >= Number.MAX_SAFE_INTEGER) throw requestError('PROJECT_EPOCH_STALE', 'Project epoch exhausted');
      db.projectDeletion?.setFence(identity.key, current.epoch + 1, null, 0);
    }
  }
  return {
    ...createSessionRequestCommands(db),
    beginFullIndex(folder, token, control) {
      const revision = db.getSetting('_writer_revision') || 0;
      if (control?.expectedRevision !== undefined && control.expectedRevision !== revision) throw requestError('WRITER_STALE', 'Index producer snapshot changed before begin');
      const { folderReadWitness } = require('./src/main/session-index/full-read-state');
      if (control?.expectedFolder !== undefined && control.expectedFolder !== folderReadWitness(db, folder, control.sessionIds)) {
        throw requestError('WRITER_STALE', 'Index folder changed before begin');
      }
      const previous = db.beginFullIndex(folder, token);
      return control?.receipt ? { previous, committedRevision: revision + 1,
        ...(control.expectedFolder !== undefined ? { folderWitness: folderReadWitness(db, folder, control.sessionIds) } : {}) } : previous;
    },
    sealFullIndex(...args) {
      const beforeRevision = db.getSetting('_writer_revision') || 0;
      const sealed = db.sealFullIndex(...args);
      return args[5]?.receipt ? { sealed, beforeRevision, committedRevision: beforeRevision + (sealed ? 1 : 0) } : sealed;
    },
    certifyFullReads(folder, token, rows, control) {
      const beforeRevision = db.getSetting('_writer_revision') || 0;
      let certified = true, changed = false;
      for (const row of rows) {
        const accepted = db.certifyFullRead(folder, token, row.sessionId, row.stamp, row.witness);
        certified &&= accepted;
        changed ||= accepted;
      }
      return control?.receipt ? { certified, beforeRevision, committedRevision: beforeRevision + (changed ? 1 : 0), continuous: true } : certified;
    },
    readProjectArchiveEpochs: epochs,
    patchGlobal: patch,
    mergeGlobal(fields, remove = []) {
      const global = { ...(db.getSetting('global') || {}), ...fields };
      for (const key of remove) delete global[key];
      assertHarnessSettings(global);
      db.setSetting('global', global);
      return global;
    },
    cleanupWorktree(projectPath) {
      let removed = 0;
      for (const row of db.getAllCached()) {
        if (row.projectPath !== projectPath) continue;
        db.deleteCachedSession(row.sessionId);
        db.deleteSearchSession(row.sessionId);
        removed++;
      }
      const global = db.getSetting('global') || {};
      const matched = localHiddenEntriesEqualTo(global, projectPath);
      if (matched.length) {
        const fields = fieldsWithoutHiddenEntries(global, matched);
        if (!global.hiddenProjectKinds) delete fields.hiddenProjectKinds;
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
      for (const part of Array.isArray(id) ? id : [id]) {
        db.updateSearchTitle(part, 'session', (name ? name + ' ' : '') + (db.getCachedSession(part)?.summary || ''));
      }
      return { name: name || null };
    },
    rekeySessionMeta(from, to) {
      const row = db.getCachedSession(from);
      db.rekeySessionMeta(from, to, row?.customTitle || row?.aiTitle || row?.summary);
    },
    hideProject(entry, kind, scope, proof) {
      guard([scope ? { alias: scope.alias, projectPath: entryProject(entry).projectPath } : entryProject(entry)], proof);
      const global = db.getSetting('global') || {};
      const fields = {};
      if (kind === 'archive' || global.hiddenProjectArchivedAt) {
        fields.hiddenProjectArchivedAt = { ...global.hiddenProjectArchivedAt };
        if (kind === 'archive') fields.hiddenProjectArchivedAt[entry] = Date.now();
        else delete fields.hiddenProjectArchivedAt[entry];
      }
      if (scope || global.hiddenProjectScopes) {
        fields.hiddenProjectScopes = { ...global.hiddenProjectScopes };
        if (scope && (!(global.hiddenProjects || []).includes(entry) || Object.hasOwn(global.hiddenProjectScopes || {}, entry))) fields.hiddenProjectScopes[entry] = scope;
        else delete fields.hiddenProjectScopes[entry];
      }
      patch({ hiddenProjects: [...new Set([...(global.hiddenProjects || []), entry])],
        hiddenProjectKinds: { ...global.hiddenProjectKinds, [entry]: kind }, ...fields });
    },
    clearArchivedEntry(alias, projectPath, proof) {
      guard([{ alias, projectPath }], proof);
      return archive.clearArchivedEntry(db.getSetting, db.setSetting, alias, projectPath);
    },
    unhideProject(entry, alias, projectPath, proof) {
      reopen([{ alias, projectPath }], proof);
      archive.clearArchivedEntry(db.getSetting, db.setSetting, alias, projectPath);
      const global = db.getSetting('global') || {};
      if (!isProjectHidden([entry], alias, projectPath, global.hiddenProjectScopes, longVisibilityPath(createLongPathResolver()))) return;
      const kinds = { ...global.hiddenProjectKinds };
      delete kinds[entry];
      const fields = { hiddenProjects: (global.hiddenProjects || []).filter(p => p !== entry), hiddenProjectKinds: kinds };
      if (global.hiddenProjectArchivedAt) {
        fields.hiddenProjectArchivedAt = { ...global.hiddenProjectArchivedAt };
        delete fields.hiddenProjectArchivedAt[entry];
      }
      if (global.hiddenProjectScopes) {
        fields.hiddenProjectScopes = { ...global.hiddenProjectScopes };
        delete fields.hiddenProjectScopes[entry];
      }
      patch(fields);
    },
    revealAddedProject(projectPath, proof) {
      reopen([{ alias: null, projectPath }], proof);
      const global = db.getSetting('global') || {};
      const matched = localHiddenEntriesEqualTo(global, projectPath, (entry, normalize) => isProjectHidden([entry], null, projectPath, global.hiddenProjectScopes, normalize));
      if (matched.length) patch(fieldsWithoutHiddenEntries(global, matched));
      archive.clearArchivedEntry(db.getSetting, db.setSetting, null, projectPath);
    },
    retireArchivedEntries(entries, snapshot, proof) {
      const current = db.getSetting('archivedProjects') || {};
      entries = entries.filter(entry => {
        if (!Object.hasOwn(current, entry)) return false;
        const project = entryProject(entry), state = fence(project);
        const expected = proof?.find(item => projectIdentity(item.project).key === projectIdentity(project).key)?.epoch;
        return !state.blocked || (proof && expected !== state.epoch);
      });
      guard(entries.map(entryProject), proof);
      const state = { archivedProjects: current, hiddenProjects: (db.getSetting('global') || {}).hiddenProjects || [],
        hiddenProjectScopes: (db.getSetting('global') || {}).hiddenProjectScopes || {},
        scheduleReenableOffers: db.getSetting('scheduleReenableOffers') || {} };
      if (JSON.stringify(state) !== JSON.stringify(snapshot)) {
        throw Object.assign(new Error('archive snapshot changed before writer admission'), { code: 'WRITER_STALE' });
      }
      archive.retireArchivedEntries(db.getSetting, db.setSetting, current, entries);
      return entries;
    },
    dismissReenableOffer(projectPath, folderKey, proof) {
      if (typeof projectPath !== 'string' || projectPath === '') return { error: 'invalid project path' };
      guard([{ alias: parseFolderKey(folderKey).alias, projectPath }], proof);
      return archive.dismissReenableOffer(projectPath, folderKey, { ...settings, notify() {} });
    },
    beginOffer(entry, proof) { guard([entryProject(entry)], proof); return (db.getSetting('scheduleReenableOffers') || {})[entry] || null; },
    completeOffer(entry, original, result, proof) {
      guard([entryProject(entry)], proof);
      const offers = { ...(db.getSetting('scheduleReenableOffers') || {}) };
      if (JSON.stringify(offers[entry]) !== JSON.stringify(original)) return false;
      const failed = result.failed.map(f => ({ name: f.name, error: f.error }));
      if (failed.length) offers[entry] = { ...original, disabledSchedules: result.failed.map(f => f.filePath), failed };
      else delete offers[entry];
      db.setSetting('scheduleReenableOffers', offers);
      return true;
    },
    beginArchive(entries, proof) {
      guard(entries.map(({ entry }) => entryProject(entry)), proof);
      const archived = { ...(db.getSetting('archivedProjects') || {}) };
      const offers = { ...(db.getSetting('scheduleReenableOffers') || {}) };
      for (const { entry, record, disabledFiles } of entries) {
        const offered = offers[entry]?.disabledSchedules || [];
        archived[entry] = { ...record, disabledSchedules: offered.filter(file => disabledFiles.includes(file)),
          disabledByArchive: [], priorOffer: offers[entry] || null };
        delete offers[entry];
      }
      db.setSetting('archivedProjects', archived);
      db.setSetting('scheduleReenableOffers', offers);
      return entries.map(({ entry }) => ({ entry, record: archived[entry] }));
    },
    completeArchive(entries, disabled, proof) {
      guard(entries.map(({ entry }) => entryProject(entry)), proof);
      const archived = { ...(db.getSetting('archivedProjects') || {}) };
      if (entries.some(({ entry, record }) => JSON.stringify(archived[entry]) !== JSON.stringify(record))) return false;
      for (const { entry, record } of entries) {
        archived[entry] = { ...record, disabledSchedules: [...new Set([...record.disabledSchedules, ...(disabled[entry] || [])])],
          disabledByArchive: disabled[entry] || [] };
      }
      db.setSetting('archivedProjects', archived);
      return true;
    },
    undoArchiveProjectFolders(groups, archivedAt, proof) {
      guard(groupProjects(groups), proof);
      const schedules = [];
      const result = archive.undoArchiveProjectFolders(groups, archivedAt, { ...settings, notify() {},
        reenable(filePaths, projectRoot) {
          schedules.push({ filePaths, projectRoot });
          return { enabled: [], failed: [] };
        } });
      return result.error ? result : { ...result, schedules };
    },
    completeRepairFolders(folders) {
      const pending = db.getSetting('bridge_uuid_reindex_folders');
      if (Array.isArray(pending)) db.setSetting('bridge_uuid_reindex_folders', pending.filter(key => !folders.includes(key)));
    },
    pruneUndeclaredRepairFolders(folders) {
      const enabled = new Set(enabledHosts((db.getSetting('global') || {}).remoteHosts).map(host => host.alias));
      const removable = new Set((Array.isArray(folders) ? folders : []).filter(key => {
        if (typeof key !== 'string') return false;
        const { alias } = parseFolderKey(key);
        return alias !== null && !enabled.has(alias);
      }));
      const pending = db.getSetting('bridge_uuid_reindex_folders');
      if (Array.isArray(pending) && pending.some(key => removable.has(key))) db.setSetting('bridge_uuid_reindex_folders', pending.filter(key => !removable.has(key)));
      return [...removable];
    },
    addRepairFolders(folders) {
      const pending = db.getSetting('bridge_uuid_reindex_folders');
      const current = Array.isArray(pending) ? pending : [];
      const added = folders.filter(key => typeof key === 'string' && !current.includes(key));
      if (added.length) db.setSetting('bridge_uuid_reindex_folders', [...current, ...added]);
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
    migrateSchedulesTabDefault() {
      return migrateSchedulesTabDefault(db);
    },
  };
}

module.exports = { createWriterCommands, hashSessionRequestCommand };
