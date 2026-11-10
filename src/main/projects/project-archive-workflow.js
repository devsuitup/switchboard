'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { projectIdentity } = require('./project-delete-progress');
const gates = new WeakMap();
const error = code => Object.assign(new Error(code === 'WORKFLOW_BUSY' ? 'project workflow is busy' : 'project workflow is sealed'), { code });

function archiveProjectIdentity(project) {
  if (project?.alias && typeof project.projectPath === 'string' && !path.posix.isAbsolute(project.projectPath) && path.win32.isAbsolute(project.projectPath)) {
    return projectIdentity({ ...project, projectPath: '/' + path.win32.normalize(project.projectPath).replaceAll('\\', '/') });
  }
  return projectIdentity(project);
}

// see .ai/contexts/project-delete.md
function projectArchiveWorkflows(client) {
  if (gates.has(client)) return gates.get(client);
  const active = new Map(), holds = new Map(), deletions = new Map(), scope = new AsyncLocalStorage();
  const identities = (projects, skipInvalid = false) => [...new Map(projects.flatMap(project => {
    try { const identity = archiveProjectIdentity(project); return [[identity.key, identity]]; }
    catch (failure) { if (skipInvalid && failure.code === 'DELETION_ID') return []; throw failure; }
  })).values()].sort((a, b) => a.key.localeCompare(b.key));
  const current = () => scope.getStore();
  const assertLive = () => { if (current()?.sealed) throw error('WORKFLOW_SEALED'); };
  function run(projects, fn, { skipInvalid = false } = {}) {
    let targets;
    try {
      targets = identities(projects, skipInvalid);
      if (skipInvalid) targets = targets.filter(project => !holds.has(project.key));
      else if (targets.some(project => holds.has(project.key))) throw error('WORKFLOW_BUSY');
    } catch (failure) { return Promise.reject(failure); }
    let finish;
    const lease = { id: randomUUID(), projects: targets, sealed: false, settled: new Promise(resolve => { finish = resolve; }) };
    for (const project of targets) {
      if (!active.has(project.key)) active.set(project.key, new Set());
      active.get(project.key).add(lease);
    }
    const release = () => {
      for (const project of targets) {
        const leases = active.get(project.key);
        leases?.delete(lease);
        if (!leases?.size) active.delete(project.key);
      }
      client.retireWorkflow?.(lease.id);
      finish();
    };
    return scope.run(lease, async () => {
      let releasable = true;
      try { return await fn(lease); }
      catch (failure) {
        lease.sealed = true;
        throw failure;
      } finally {
        if (lease.sealed) {
          try { await client.fenceWorkflow(lease.id); }
          catch {
            releasable = false;
            client.waitForWorkflowTermination?.(lease.id).then(release).catch(() => {});
          }
        }
        if (releasable) {
          release();
        }
      }
    });
  }
  function reserve(projects) {
    const targets = identities(projects);
    if (targets.some(project => holds.has(project.key))) throw error('WORKFLOW_BUSY');
    const token = {};
    for (const project of targets) holds.set(project.key, token);
    const waiting = [...new Set(targets.flatMap(project => [...(active.get(project.key) || [])]))];
    let released = false, ready = false;
    const hold = {
      ready: Promise.all(waiting.map(lease => lease.settled)).then(() => { ready = true; }),
      release() {
        if (!ready) throw error('WORKFLOW_BUSY');
        if ([...deletions.values()].some(lease => lease.hold === hold)) throw error('WORKFLOW_BUSY');
        if (released) return;
        released = true;
        for (const project of targets) if (holds.get(project.key) === token) holds.delete(project.key);
      },
    };
    token.hold = hold;
    return hold;
  }
  const waitForHold = project => holds.get(archiveProjectIdentity(project).key)?.hold.ready;
  function deletionLease(input) {
    const { bind } = require('./project-delete-progress');
    const project = bind(input);
    if (!deletions.has(input.operationId)) {
      const existing = holds.get(project.key)?.hold;
      if (existing && [...deletions.values()].some(lease => lease.hold === existing)) throw error('WORKFLOW_BUSY');
      deletions.set(input.operationId, { hold: existing || reserve([input.project]), owned: !existing });
    }
    return deletions.get(input.operationId);
  }
  function settleDeletion(input, state) {
    const lease = deletions.get(input.operationId);
    if (lease && (state.terminal || state.noLateCommit)) {
      deletions.delete(input.operationId);
      if (lease.owned) lease.hold.release();
    }
  }
  const gate = { run, reserve, current, assertLive, waitForHold, deletionLease, settleDeletion };
  gates.set(client, gate);
  return gate;
}
module.exports = { projectArchiveWorkflows, archiveProjectIdentity };
