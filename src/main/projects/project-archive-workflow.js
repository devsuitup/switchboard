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
  const active = new Map(), holds = new Map(), scope = new AsyncLocalStorage();
  const identities = projects => [...new Map(projects.map(project => { const identity = archiveProjectIdentity(project); return [identity.key, identity]; })).values()].sort((a, b) => a.key.localeCompare(b.key));
  const current = () => scope.getStore();
  const assertLive = () => { if (current()?.sealed) throw error('WORKFLOW_SEALED'); };
  function run(projects, fn) {
    let targets;
    try {
      targets = identities(projects);
      if (targets.some(project => active.has(project.key) || holds.has(project.key))) throw error('WORKFLOW_BUSY');
    } catch (failure) { return Promise.reject(failure); }
    let finish;
    const lease = { id: randomUUID(), projects: targets, sealed: false, settled: new Promise(resolve => { finish = resolve; }) };
    for (const project of targets) active.set(project.key, lease);
    return scope.run(lease, async () => {
      let releasable = true;
      try { return await fn(lease); }
      catch (failure) {
        lease.sealed = true;
        throw failure;
      } finally {
        if (lease.sealed) {
          try { await client.fenceWorkflow(lease.id); }
          catch { releasable = false; }
        }
        if (releasable) {
          for (const project of targets) active.delete(project.key);
          client.retireWorkflow?.(lease.id);
          finish();
        }
      }
    });
  }
  function reserve(projects) {
    const targets = identities(projects);
    if (targets.some(project => holds.has(project.key))) throw error('WORKFLOW_BUSY');
    const token = {};
    for (const project of targets) holds.set(project.key, token);
    const waiting = [...new Set(targets.map(project => active.get(project.key)).filter(Boolean))];
    let released = false, ready = false;
    return {
      ready: Promise.all(waiting.map(lease => lease.settled)).then(() => { ready = true; }),
      release() {
        if (!ready) throw error('WORKFLOW_BUSY');
        if (released) return;
        released = true;
        for (const project of targets) if (holds.get(project.key) === token) holds.delete(project.key);
      },
    };
  }
  const gate = { run, reserve, current, assertLive };
  gates.set(client, gate);
  return gate;
}
module.exports = { projectArchiveWorkflows, archiveProjectIdentity };
