'use strict';

const path = require('path');
const { normalizeProjectPath } = require('./normalize-project-path');
const PROJECT_OPERATION_ERROR = 'A project operation is in progress. Wait for it to finish before starting a session.';

function createProjectOperationGate() {
  const entries = new Map();
  const trees = new Map();
  const keyFor = (project, alias) => {
    const remote = typeof alias === 'string' && alias.length > 0;
    const normalized = remote ? path.posix.normalize(project || '/').replace(/\/$/, '') || '/' : normalizeProjectPath(path.resolve(project || '.'));
    return JSON.stringify([remote ? alias : null, !remote && process.platform === 'win32' ? normalized.toLowerCase() : normalized]);
  };
  const entryFor = key => {
    if (!entries.has(key)) entries.set(key, { active: 0, held: false, drained: [] });
    return entries.get(key);
  };
  const settle = (key, entry) => {
    if (entry.active) return;
    for (const resolve of entry.drained.splice(0)) resolve();
    if (!entry.held) entries.delete(key);
  };
  const contains = (root, key) => {
    const [host, directory] = JSON.parse(root), [candidateHost, candidate] = JSON.parse(key);
    return host === candidateHost && (directory === candidate || candidate.startsWith(directory.replace(/\/$/, '') + '/'));
  };
  const treeBlocked = key => [...trees.keys()].some(root => contains(root, key));
  const tryAdmitAll = (projects, alias = null) => {
    const keys = [...new Set(projects.filter(project => project != null && project !== '').map(project => keyFor(project, alias)))];
    if (keys.some(key => entries.get(key)?.held || treeBlocked(key))) return null;
    const admitted = keys.map(key => [key, entryFor(key)]);
    for (const [, entry] of admitted) entry.active++;
    let released = false;
    return { release() {
      if (released) return;
      released = true;
      for (const [key, entry] of admitted) {
        entry.active--;
        settle(key, entry);
      }
    } };
  };
  return {
    tryAdmit(project, alias = null) {
      return tryAdmitAll([project], alias);
    },
    tryAdmitAll,
    holdTree(project, alias = null) {
      const key = keyFor(project, alias);
      if ([...trees.keys()].some(root => contains(root, key) || contains(key, root))
        || [...entries].some(([candidate, entry]) => entry.held && contains(key, candidate))) throw new Error(PROJECT_OPERATION_ERROR);
      const pending = [...entries].filter(([candidate, entry]) => entry.active && contains(key, candidate));
      const marker = {};
      trees.set(key, marker);
      return { ready: Promise.all(pending.map(([, entry]) => new Promise(resolve => entry.drained.push(resolve)))),
        release() { if (trees.get(key) === marker) trees.delete(key); } };
    },
    hold(project, alias = null) {
      const key = keyFor(project, alias);
      const entry = entryFor(key);
      if (entry.held || treeBlocked(key)) throw new Error(PROJECT_OPERATION_ERROR);
      entry.held = true;
      const ready = entry.active ? new Promise(resolve => { entry.drained.push(resolve); }) : Promise.resolve();
      let released = false;
      return { ready, release() {
        if (released) return;
        released = true;
        entry.held = false;
        settle(key, entry);
      } };
    },
  };
}

module.exports = { createProjectOperationGate, projectOperationGate: createProjectOperationGate(), PROJECT_OPERATION_ERROR };
