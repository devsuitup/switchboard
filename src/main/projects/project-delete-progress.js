'use strict';

const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeProjectPath } = require('../shared/normalize-project-path');
const { parseFolderKey, isValidAlias } = require('../remote/remote-hosts');
const { isProjectHidden } = require('../../../public/worktree-nesting');
const { durableRowLinks } = require('./project-delete-identity');
const fail = (code, message) => Object.assign(new Error(message), { code });
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const WEEK = 7 * 86400000;

function projectIdentity(project, memo = new Map()) {
  if (!project || !Object.hasOwn(project, 'alias') || typeof project.projectPath !== 'string' || !project.projectPath || project.projectPath.includes('\0')) throw fail('DELETION_ID', 'Explicit project host and absolute path required');
  const { alias } = project;
  let projectPath;
  if (alias === null) {
    if (!path.isAbsolute(project.projectPath)) throw fail('DELETION_ID', 'Local project path must be absolute');
    const absolute = path.resolve(project.projectPath);
    if (!memo.has(absolute)) {
      let normalized = normalizeProjectPath(absolute);
      if (process.platform === 'win32') normalized = normalized.toLowerCase();
      memo.set(absolute, normalized);
    }
    projectPath = memo.get(absolute);
  } else {
    if (!isValidAlias(alias) || !path.posix.isAbsolute(project.projectPath)) throw fail('DELETION_ID', 'Invalid remote project');
    projectPath = path.posix.normalize(project.projectPath).replace(/\/$/, '') || '/';
  }
  return { alias, projectPath, key: JSON.stringify([alias, projectPath]) };
}

function operationId(project, epoch, uuid = randomUUID(), memo) {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) throw fail('DELETION_ID', 'Invalid operation epoch or UUID');
  return `pd1:${hash(projectIdentity(project, memo).key)}:${epoch}:${uuid}`;
}

function bind(input, memo) {
  const project = projectIdentity(input.project, memo);
  const parts = typeof input.operationId === 'string' && /^pd1:([0-9a-f]{64}):(0|[1-9][0-9]*):([0-9a-f-]{36})$/i.exec(input.operationId);
  if (!parts || !Number.isSafeInteger(Number(parts[2])) || operationId(input.project, Number(parts[2]), parts[3], memo) !== input.operationId
    || (input.expectedProjectEpoch !== undefined && input.expectedProjectEpoch !== Number(parts[2]))) throw fail('DELETION_ID', 'Operation identity or epoch mismatch');
  return { ...project, expectedEpoch: Number(parts[2]), operationId: input.operationId };
}

function commitTransaction(db, fn, hook) {
  return db.transact(() => {
    const before = db.changeCount(), revision = db.getSetting('_writer_revision') || 0;
    const result = fn();
    hook?.(revision + 1);
    const changed = db.changeCount() !== before;
    const committedRevision = revision + (changed ? 1 : 0);
    if (changed) db.setSetting('_writer_revision', committedRevision);
    return { result, committedRevision };
  });
}

// see .ai/contexts/project-delete.md
function createProjectDeleteProgress(db, { now = Date.now } = {}) {
  const store = db.projectDeletion;
  const revision = () => db.getSetting('_writer_revision') || 0;
  const fenceRow = key => store.fence(key) || { epoch: 0, operationId: null, blocked: 0 };
  const otherOwner = project => {
    const fence = fenceRow(project.key);
    const owner = fence.operationId && fence.operationId !== project.operationId && store.operation(fence.operationId);
    return owner && !owner.sealed ? owner : null;
  };
  const expired = row => !!row.sealed && row.finishedAt < now() - WEEK;
  function readScope({ project }, memo = new Map()) {
    const identity = projectIdentity(project, memo);
    return db.connection.transaction(() => {
      const identities = new Map([[JSON.stringify([project.alias, project.projectPath]), identity.key]]);
      const ownership = db.getAllCached().map(row => ({ ...row })).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      const rows = ownership.filter(row => {
        if (!row.projectPath || parseFolderKey(row.folder).alias !== identity.alias) return false;
        const key = JSON.stringify([identity.alias, row.projectPath]);
        if (!identities.has(key)) {
          let owner = null;
          try { owner = projectIdentity({ alias: identity.alias, projectPath: row.projectPath }, memo).key; } catch {}
          identities.set(key, owner);
        }
        return identities.get(key) === identity.key;
      });
      const ids = new Set(rows.flatMap(row => [row.sessionId, ...durableRowLinks(row)]));
      const metadata = [...db.getAllMeta(true).values()].filter(row => ids.has(row.sessionId));
      const fields = store.metadataFields().filter(row => ids.has(row.sessionId));
      const folders = [...db.getAllFolderMeta()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      const settingsKeys = db.listSettingKeys('project:').sort();
      const scope = { rows, metadata, fields, ownership, folders, settingsKeys };
      return { writerRevision: revision(), projectEpoch: fenceRow(identity.key).epoch, writerMembershipDigest: hash(scope), scope };
    })();
  }
  function observations(project) {
    const global = db.getSetting('global') || {};
    const hidden = isProjectHidden(global.hiddenProjects, project.alias, project.projectPath, global.hiddenProjectScopes, value => {
      try { return projectIdentity({ alias: project.alias, projectPath: value }).projectPath; }
      catch { return value; }
    });
    const snapshot = readScope({ project });
    const settingsPresent = snapshot.scope.settingsKeys.some(key => {
      try { return projectIdentity({ alias: project.alias, projectPath: key.slice(8) }).key === project.key; }
      catch { return false; }
    });
    return { revision: revision(), readRevision: revision(), projectHidden: hidden, settingsPresent, metadata: snapshot.scope.metadata };
  }
  function read(input) {
    const project = bind(input);
    return db.connection.transaction(() => {
      const row = store.operation(input.operationId), fence = fenceRow(project.key);
      const observed = observations(project);
      if (!row || expired(row) || row.phase === 'purging') {
        const advanced = fence.epoch > project.expectedEpoch;
        const owner = otherOwner(project);
        return { state: row || advanced ? 'unknown' : 'absent', terminal: false, noLateCommit: !!row?.sealed || advanced,
          receiptAvailable: false, projectEpoch: fence.epoch,
          reason: owner ? 'project-owned-by-another-operation' : row || advanced ? 'receipt-expired-or-unavailable' : 'not-observed',
          ...(owner ? { ownerOperationId: owner.operationId } : {}), ...observed };
      }
      if (row.projectKey !== project.key) throw fail('DELETION_ID', 'Receipt belongs to another project');
      const units = store.units(input.operationId).map(unit => ({ ordinal: unit.ordinal, category: unit.category, target: JSON.parse(unit.targetJson), status: unit.status, result: JSON.parse(unit.resultJson) }));
      const ids = new Set([...observed.metadata.map(row => row.sessionId), ...units.filter(unit => unit.category === 'session').map(unit => unit.target.id)]);
      observed.metadata = [...db.getAllMeta(true).values()].filter(row => ids.has(row.sessionId));
      const final = row.state === 'committed' && units.find(unit => unit.category === 'finalize')?.target;
      return { operationId: row.operationId, state: row.sealed ? row.state : 'inProgress', phase: row.phase,
        terminal: !!row.sealed, noLateCommit: !!row.sealed, receiptAvailable: true, projectEpoch: fence.epoch,
        startRevision: row.startRevision, lastRevision: row.lastRevision, committedRevision: row.lastRevision, nextUnit: row.nextUnit, totalUnits: row.totalUnits,
        stagedUnits: units.length, unstagedUnits: row.totalUnits - units.length,
        completed: units.filter(unit => unit.status === 'completed'), remaining: units.filter(unit => unit.status === 'pending'),
        kept: units.filter(unit => unit.status === 'kept'), failed: units.filter(unit => unit.status === 'failed'),
        error: JSON.parse(row.errorJson), ...(final ? { invalidation: { sessionIds: units.filter(unit => unit.category === 'session').map(unit => unit.target.id).sort(),
          folderKeys: final.folderKeys || [], restoreTargets: final.restoreTargets } } : {}), ...observed };
    })();
  }
  function manifest(input) {
    const project = bind(input);
    const keys = ['sessions', 'settings', 'schedules', 'transcripts', 'stopBackgroundJobs'];
    if (!input.options || Object.keys(input.options).length !== keys.length || keys.some(key => typeof input.options[key] !== 'boolean')
      || input.options.schedules || input.options.transcripts || !Array.isArray(input.units) || input.units.length > 50000
      || input.units.some(unit => !unit || Object.keys(unit).length !== 2 || typeof unit.category !== 'string' || !unit.category || unit.target === undefined)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || typeof input.membershipDigest !== 'string' || !input.membershipDigest
      || typeof input.writerMembershipDigest !== 'string') throw fail('DELETION_MANIFEST', 'Invalid substrate manifest');
    const copy = JSON.parse(JSON.stringify(input));
    const { units: _units, ...request } = copy;
    return { project, copy, manifestHash: `${hash(request)}:${hash(copy)}` };
  }
  function progressHook(row, beforeCommit) {
    return nextRevision => {
      row.lastRevision = nextRevision;
      store.progress(row);
      beforeCommit?.(nextRevision);
    };
  }
  function owned(input) {
    const project = bind(input), row = store.operation(input.operationId), fence = fenceRow(project.key);
    if (!row || row.sealed || fence.operationId !== input.operationId || fence.epoch !== row.ownedEpoch) throw fail('DELETION_TERMINAL', 'Operation no longer owns an open epoch');
    if (row.lastRevision !== revision()) throw fail('WRITER_STALE', 'Writer changed between deletion chunks');
    if (row.manifestHash !== manifest(input).manifestHash) throw fail('DELETION_HASH', 'Operation manifest changed');
    return row;
  }
  function admit(input, firstEffect, { all = false, preflight } = {}) {
    const { project, copy, manifestHash } = manifest(input);
    let row;
    commitTransaction(db, () => {
      const existing = store.operation(input.operationId);
      if (existing) {
        if (existing.sealed && !existing.manifestHash) throw fail('DELETION_TERMINAL', 'Operation already sealed');
        if (existing.projectKey !== project.key || existing.manifestHash !== manifestHash) throw fail('DELETION_HASH', 'Operation ID reused with different manifest');
        return;
      }
      preflight?.();
      if (otherOwner(project)) throw fail('DELETION_BUSY', 'Project is owned by another unsealed operation');
      const snapshot = readScope(input);
      if (snapshot.projectEpoch !== project.expectedEpoch) throw fail('DELETION_TERMINAL', 'Operation epoch has advanced');
      if (snapshot.writerRevision !== copy.expectedRevision) throw fail('WRITER_STALE', 'Writer revision changed before admission');
      if (snapshot.writerMembershipDigest !== copy.writerMembershipDigest) throw fail('DELETION_SCOPE', 'Durable ownership changed');
      if (store.active().length >= 32) throw fail('DELETION_LIMIT', 'At most 32 nonterminal operations');
      if (firstEffect && (!copy.units.length || copy.units.length > 16
        || (copy.units.length > 1 && Buffer.byteLength(JSON.stringify(copy.units)) > 60000))) throw fail('DELETION_STAGING', 'First effect requires a completely staged bounded manifest');
      if (project.expectedEpoch >= Number.MAX_SAFE_INTEGER - 1) throw fail('DELETION_ID', 'Project epoch exhausted');
      row = { operationId: input.operationId, projectKey: project.key, expectedEpoch: project.expectedEpoch, ownedEpoch: project.expectedEpoch + 1,
        manifestHash, membershipDigest: copy.membershipDigest, writerMembershipDigest: copy.writerMembershipDigest, optionsJson: JSON.stringify(copy.options),
        state: 'inProgress', phase: 'preparing', startRevision: snapshot.writerRevision, lastRevision: null,
        nextUnit: 0, totalUnits: copy.units.length, sealed: 0, errorJson: null, createdAt: now(), finishedAt: null };
      store.setFence(project.key, row.ownedEpoch, input.operationId, 1);
      store.insert(row);
      if (firstEffect) {
        copy.units.forEach((unit, ordinal) => store.addUnit(input.operationId, ordinal, unit));
        row.phase = 'applying';
        for (let ordinal = 0; ordinal < (all ? copy.units.length : 1); ordinal++) applyUnit(row, { ...copy.units[ordinal], ordinal }, firstEffect);
      }
    }, next => { if (row) progressHook(row)(next); });
    trimReceipts();
    return read(input);
  }
  function stage(input, batch, { beforeChunk } = {}) {
    let row;
    commitTransaction(db, () => {
      row = owned(input);
      beforeChunk?.();
      const units = store.units(input.operationId), expected = input.units.slice(units.length, units.length + batch.length);
      if (!Array.isArray(batch) || batch.length > 16 || !batch.length || hash(batch) !== hash(expected)) throw fail('DELETION_HASH', 'Staged units differ from frozen manifest');
      for (let i = 0; i < batch.length; i++) {
        const applied = db.chunkUnit(() => store.addUnit(input.operationId, units.length + i, batch[i]), i, { rows: 2, bytes: 2048 });
        if (applied.deferred) break;
      }
      const staged = store.units(input.operationId);
      if (staged.length === row.totalUnits) {
        if (hash(staged.map(unit => ({ category: unit.category, target: JSON.parse(unit.targetJson) }))) !== hash(input.units)) throw fail('DELETION_HASH', 'Staged manifest hash mismatch');
        row.phase = 'applying';
      }
    }, next => progressHook(row)(next));
    return read(input);
  }
  function seal(row, state, error = null) {
    const fence = fenceRow(row.projectKey);
    if (fence.operationId === row.operationId && fence.epoch === row.ownedEpoch) store.setFence(row.projectKey, fence.epoch + 1, null, 1);
    row.state = state; row.phase = 'terminal'; row.sealed = 1; row.errorJson = error && JSON.stringify(error); row.finishedAt = now();
  }
  function applyUnit(row, unit, effect) {
    const result = effect(unit);
    if (result && typeof result.then === 'function') throw fail('DELETION_ASYNC', 'Deletion units must be synchronous');
    const status = result?.status || 'completed';
    if (!['completed', 'kept', 'failed'].includes(status)) throw fail('DELETION_RESULT', 'Invalid unit result');
    store.unitResult(row.operationId, unit.ordinal, status, result);
    row.nextUnit++;
    if (status === 'failed') seal(row, 'partial', { reason: 'unit-failed', ordinal: unit.ordinal });
    else if (row.nextUnit === row.totalUnits) seal(row, 'committed');
  }
  function apply(input, effect, { beforeCommit, beforeChunk } = {}) {
    let row;
    commitTransaction(db, () => {
      row = owned(input);
      beforeChunk?.();
      if (row.phase !== 'applying' && row.totalUnits !== 0) throw fail('DELETION_STAGING', 'Manifest staging is incomplete');
      const unit = store.units(input.operationId)[row.nextUnit];
      if (unit) {
        const projected = { category: unit.category, target: JSON.parse(unit.targetJson), ordinal: unit.ordinal };
        db.chunkUnit(() => {
          applyUnit(row, projected, effect);
        }, 0, { rows: 3, bytes: 2048 });
      }
      if (!row.sealed && row.nextUnit === row.totalUnits) seal(row, 'committed');
    }, next => progressHook(row, beforeCommit)(next));
    trimReceipts();
    return read(input);
  }
  function fence(input) {
    const project = bind(input);
    let row;
    commitTransaction(db, () => {
      row = store.operation(input.operationId);
      if (row?.sealed) { row = null; return; }
      if (row) { seal(row, 'partial', { reason: 'fenced' }); return; }
      const current = fenceRow(project.key);
      if (otherOwner(project)) return;
      if (current.epoch !== project.expectedEpoch) return;
      if (current.epoch >= Number.MAX_SAFE_INTEGER) throw fail('DELETION_ID', 'Project epoch exhausted');
      store.setFence(project.key, current.epoch + 1, null, 1);
      row = { operationId: input.operationId, projectKey: project.key, expectedEpoch: project.expectedEpoch, ownedEpoch: null,
        manifestHash: '', membershipDigest: '', writerMembershipDigest: '', optionsJson: '{}', state: 'notStarted', phase: 'terminal',
        startRevision: revision(), lastRevision: null, nextUnit: 0, totalUnits: 0, sealed: 1, errorJson: null, createdAt: now(), finishedAt: now() };
      store.insert(row);
    }, next => { if (row) progressHook(row)(next); });
    trimReceipts();
    return read(input);
  }
  function failOperation(input, error) {
    const project = bind(input);
    let row;
    commitTransaction(db, () => {
      row = store.operation(input.operationId);
      if (!row || row.sealed || fenceRow(project.key).operationId !== row.operationId) { row = null; return; }
      if (error.code !== 'WRITER_STALE' && error.code !== 'DELETION_TERMINAL') {
        const unit = store.units(row.operationId)[row.nextUnit];
        if (unit) store.unitResult(row.operationId, unit.ordinal, 'failed', { code: error.code, error: error.message });
      }
      seal(row, 'partial', { code: error.code, reason: error.message });
    }, next => { if (row) progressHook(row)(next); });
    return read(input);
  }
  function recover() {
    if (!store) throw fail('DELETION_STORE', 'Deletion store capability is required');
    const unfinished = store.active()[0];
    if (!unfinished) return false;
    commitTransaction(db, () => seal(unfinished, 'partial', { reason: 'writer-restart' }), progressHook(unfinished));
    trimReceipts();
    const [alias, projectPath] = JSON.parse(unfinished.projectKey);
    return { operationId: unfinished.operationId, project: { alias, projectPath } };
  }
  function purge() {
    const terminal = store.terminal();
    const candidate = terminal.find(row => row.phase === 'purging')
      || terminal.find((row, index) => index >= 128 || row.finishedAt < now() - WEEK);
    if (!candidate) return false;
    db.transact(() => {
      const row = store.operation(candidate.operationId);
      if (row.phase !== 'purging') {
        row.phase = 'purging';
        store.progress(row);
      }
      store.purgeUnits(candidate.operationId);
      if (!store.units(candidate.operationId).length) store.purgeOperation(candidate.operationId);
    });
    return true;
  }
  function trimReceipts() {
    if (store.terminal().length > 128) purge();
  }
  return { readScope, admit, stage, apply, read, fence, recover, purge, failOperation };
}

module.exports = { createProjectDeleteProgress, operationId, commitTransaction, projectIdentity, bind };
