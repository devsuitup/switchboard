'use strict';

const fs = require('fs');
const { encodeProjectPath } = require('./encode-project-path');
const { resolveWorktreePath } = require('./derive-project-path');
const { parseFolderKey } = require('./remote-hosts');
const { validId } = require('./session-continuations');
const { isLiveJobState } = require('./bg-agents-roster');

const key = id => String(id).toLowerCase();

function continuationGraph(localRows) {
  const indexes = new Map(), predecessors = new Map();
  for (const [id, row] of localRows) {
    let index;
    try { index = JSON.parse(row.continuationIndex); } catch {}
    if (!index) continue;
    if (index.format !== 3 || !index.complete || index.unresolved || !Array.isArray(index.ids) || index.ids.length > 1
      || (row.fileMtime && index.mtime !== row.fileMtime)) {
      indexes.set(id, null);
      continue;
    }
    indexes.set(id, index);
    if (!index.ids.length) continue;
    const target = key(index.ids[0]);
    if (!predecessors.has(target)) predecessors.set(target, []);
    predecessors.get(target).push(id);
  }
  return { indexes, predecessors };
}

function backgroundPath(head, { indexes, predecessors }) {
  if (indexes.has(head) && (!indexes.get(head) || indexes.get(head).ids.length)) return null;
  const depths = new Map([[head, 0]]);
  const pending = [head];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i], depth = depths.get(id);
    if (depth === 32) continue;
    for (const predecessor of predecessors.get(id) || []) {
      if (!validId(predecessor) || depths.has(predecessor)) continue;
      depths.set(predecessor, depth + 1);
      pending.push(predecessor);
    }
  }
  const roots = pending.filter(id => id !== head && !(predecessors.get(id) || []).some(parent => depths.has(parent)));
  if (roots.length !== 1) return null;
  const reachable = [roots[0]];
  while (reachable[reachable.length - 1] !== head) reachable.push(key(indexes.get(reachable[reachable.length - 1]).ids[0]));
  return reachable;
}

// see .ai/contexts/session-cache.md ("Local background sidebar rows")
function mergeLocalBackgroundSessions(projects, cachedRows, descriptors, { hiddenProjects, metaMap, showArchived, jobs = new Map() }) {
  const localRows = new Map(cachedRows.filter(row => !row.parentSessionId && parseFolderKey(row.folder).alias === null)
    .map(row => [key(row.sessionId), row]));
  const visibleRows = new Map();
  for (const project of projects) {
    if (project.remoteAlias) continue;
    for (const row of project.sessions) {
      for (const id of [row.sessionId, ...(row.mergedMemberIds || [])]) visibleRows.set(key(id), row);
    }
  }
  const findVisible = id => visibleRows.get(key(id));
  const validDescriptors = descriptors.filter(descriptor => validId(descriptor.sessionId));
  const backgrounds = validDescriptors.filter(descriptor => descriptor.kind === 'bg' && descriptor.jobId
    && isLiveJobState(jobs.get(descriptor.jobId)?.state));
  const graph = backgrounds.length ? continuationGraph(localRows) : null;
  const suppressedNames = new Set();
  for (const descriptor of backgrounds) {
    const head = key(descriptor.sessionId);
    let visible = findVisible(head);
    const reachable = backgroundPath(head, graph);
    if (reachable) {
      const root = findVisible(reachable[0]);
      if (!root) { suppressedNames.add(head); continue; }
      const members = new Set(root.mergedMemberIds || []);
      for (const id of reachable) {
        const child = findVisible(id);
        if (child && child !== root) {
          root.messageCount += child.messageCount || 0;
          if (child.modified > root.modified) root.modified = child.modified;
          members.add(child.sessionId);
        for (const member of child.mergedMemberIds || []) members.add(member);
        for (const project of projects) project.sessions = project.sessions.filter(row => row !== child);
        for (const member of [child.sessionId, ...(child.mergedMemberIds || [])]) visibleRows.set(key(member), root);
        }
        if (key(id) !== key(root.sessionId)) members.add(localRows.get(key(id))?.sessionId || descriptor.sessionId);
      }
      root.mergedMemberIds = [...members].sort((a, b) =>
        (localRows.get(key(b))?.modified || '').localeCompare(localRows.get(key(a))?.modified || '') || a.localeCompare(b));
      for (const id of [root.sessionId, ...root.mergedMemberIds]) visibleRows.set(key(id), root);
      visible = root;
    }
    if (!visible) {
      if (localRows.has(head) || !descriptor.cwd) continue;
      const projectPath = resolveWorktreePath(descriptor.cwd);
      if (hiddenProjects.has(projectPath) || (!showArchived && metaMap.get(descriptor.sessionId)?.archived)) continue;
      let project = projects.find(p => !p.remoteAlias && p.projectPath === projectPath);
      if (!project) {
        project = { folder: encodeProjectPath(projectPath), projectPath, remoteAlias: null,
          missing: !fs.existsSync(projectPath), sessions: [] };
        projects.push(project);
      }
      const modified = Number.isFinite(descriptor.startedAt) && Math.abs(descriptor.startedAt) <= 8640000000000000
        ? new Date(descriptor.startedAt).toISOString() : null;
      visible = { sessionId: descriptor.sessionId, projectPath, remoteAlias: null, summary: descriptor.name || 'Background session',
        name: metaMap.get(descriptor.sessionId)?.name || null, messageCount: 0, modified, created: modified,
        starred: metaMap.get(descriptor.sessionId)?.starred || 0, archived: metaMap.get(descriptor.sessionId)?.archived || 0,
        mergedMemberIds: [], descriptorOnly: true };
      project.sessions.push(visible);
      visibleRows.set(head, visible);
    }
    visible.bgJobId = descriptor.jobId;
    visible.bgSessionId = descriptor.sessionId;
  }
  const namesByRow = new Map();
  for (const descriptor of validDescriptors) {
    if (descriptor.nameSource !== 'user' || !descriptor.name || suppressedNames.has(key(descriptor.sessionId))) continue;
    const row = findVisible(descriptor.sessionId);
    if (!row) continue;
    if (!namesByRow.has(row)) namesByRow.set(row, []);
    namesByRow.get(row).push(descriptor);
  }
  const launchName = name => name?.replace(/ \(\d+\)$/, '');
  for (const [row, names] of namesByRow) {
    names.sort((a, b) => Number(key(b.sessionId) === key(row.bgSessionId)) - Number(key(a.sessionId) === key(row.bgSessionId))
      || (localRows.get(key(b.sessionId))?.modified || '').localeCompare(localRows.get(key(a.sessionId))?.modified || '')
      || (b.startedAt || 0) - (a.startedAt || 0) || a.sessionId.localeCompare(b.sessionId) || a.name.localeCompare(b.name));
    const name = row.name;
    const launches = [localRows.get(key(row.sessionId))?.customTitle, jobs.get(row.bgJobId)?.name];
    if (!name || launches.some(title => title && launchName(name) === launchName(title))) row.name = names[0].name;
  }
  return projects;
}

module.exports = { mergeLocalBackgroundSessions };
