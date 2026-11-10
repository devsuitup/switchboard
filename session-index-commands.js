'use strict';

const archive = require('./archived-projects');
const { scheduleRegistry } = require('./src/main/schedules/schedule-runner');
const { whatsNewOnStartup } = require('./src/main/app/changelog');
const { isProjectHidden } = require('./public/worktree-nesting');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { archiveProjectIdentity: projectIdentity } = require('./src/main/projects/project-archive-workflow');
const { parseFolderKey } = require('./src/main/remote/remote-hosts');

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
  const matches = (owner, input) => input.suppliedHash != null ? owner.suppliedHash === input.suppliedHash
    : owner.suppliedHash === null && input.rawHash != null && owner.rawHash === input.rawHash;
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

// see .ai/contexts/session-index-writer.md
function createWriterCommands(db) {
  const settings = { getSetting: db.getSetting, setSetting: db.setSetting, scheduleName: () => null };
  const patch = fields => db.setSetting('global', { ...(db.getSetting('global') || {}), ...fields });
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
    readProjectArchiveEpochs: epochs,
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
        if (global.hiddenProjectScopes) {
          fields.hiddenProjectScopes = { ...global.hiddenProjectScopes };
          delete fields.hiddenProjectScopes[projectPath];
        }
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
      if (!isProjectHidden([entry], alias, projectPath, global.hiddenProjectScopes)) return;
      const kinds = { ...global.hiddenProjectKinds };
      delete kinds[entry];
      const fields = { hiddenProjects: (global.hiddenProjects || []).filter(p => p !== entry), hiddenProjectKinds: kinds };
      if (global.hiddenProjectScopes) {
        fields.hiddenProjectScopes = { ...global.hiddenProjectScopes };
        delete fields.hiddenProjectScopes[entry];
      }
      patch(fields);
    },
    revealAddedProject(projectPath, proof) {
      reopen([{ alias: null, projectPath }], proof);
      const global = db.getSetting('global') || {};
      if (isProjectHidden(global.hiddenProjects, null, projectPath, global.hiddenProjectScopes)) {
        const kinds = { ...global.hiddenProjectKinds };
        delete kinds[projectPath];
        const fields = { hiddenProjects: global.hiddenProjects.filter(p => p !== projectPath), hiddenProjectKinds: kinds };
        if (global.hiddenProjectScopes) {
          fields.hiddenProjectScopes = { ...global.hiddenProjectScopes };
          delete fields.hiddenProjectScopes[projectPath];
        }
        patch(fields);
      }
      archive.clearArchivedEntry(db.getSetting, db.setSetting, null, projectPath);
    },
    retireArchivedEntries(entries, snapshot, proof) {
      const current = db.getSetting('archivedProjects') || {};
      entries = entries.filter(entry => Object.hasOwn(current, entry));
      guard(entries.map(entryProject), proof);
      const state = { archivedProjects: current, hiddenProjects: (db.getSetting('global') || {}).hiddenProjects || [],
        hiddenProjectScopes: (db.getSetting('global') || {}).hiddenProjectScopes || {},
        scheduleReenableOffers: db.getSetting('scheduleReenableOffers') || {} };
      if (JSON.stringify(state) !== JSON.stringify(snapshot)) {
        throw Object.assign(new Error('archive snapshot changed before writer admission'), { code: 'WRITER_STALE' });
      }
      archive.retireArchivedEntries(db.getSetting, db.setSetting, current, entries);
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

module.exports = { createWriterCommands, hashSessionRequestCommand };
