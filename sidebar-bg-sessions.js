'use strict';

const fs = require('fs');
const { encodeProjectPath } = require('./encode-project-path');
const { resolveWorktreePath } = require('./derive-project-path');
const { parseFolderKey } = require('./remote-hosts');
const { validId, continuationRollup } = require('./session-continuations');
const { isHostedJob } = require('./bg-agents-roster');
const { conversationMeta } = require('./conversation-meta');

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

function conversationGroups(cachedRows, descriptors = [], jobs = new Map(), rollup = continuationRollup(cachedRows)) {
  const groups = new Map();
  for (const row of cachedRows) {
    const representative = row.mergedIntoSessionId || row.sessionId;
    const rootId = rollup.get(representative) || representative;
    if (!groups.has(key(rootId))) groups.set(key(rootId), { rootId, partIds: new Set([rootId]) });
    groups.get(key(rootId)).partIds.add(row.sessionId);
  }
  const byPart = new Map();
  for (const group of groups.values()) for (const id of group.partIds) byPart.set(key(id), group);
  let graph;
  for (const descriptor of descriptors) {
    if (!validId(descriptor.sessionId) || descriptor.kind !== 'bg' || !descriptor.jobId
      || !isHostedJob({ ...jobs.get(descriptor.jobId), id: descriptor.jobId, sessionId: descriptor.sessionId }, [descriptor])) continue;
    graph ||= continuationGraph(new Map(cachedRows.filter(row => !row.parentSessionId && parseFolderKey(row.folder).alias === null)
      .map(row => [key(row.sessionId), row])));
    const reachable = backgroundPath(key(descriptor.sessionId), graph);
    if (!reachable) continue;
    const root = byPart.get(reachable[0]);
    if (!root) continue;
    root.backgroundPaths ||= new Map();
    root.backgroundPaths.set(key(descriptor.sessionId), reachable);
    for (const id of reachable) {
      for (const part of byPart.get(id)?.partIds || [descriptor.sessionId]) root.partIds.add(part);
    }
    for (const part of root.partIds) byPart.set(key(part), root);
  }
  return byPart;
}

function conversationMemberIds(rows, id, descriptors = [], jobs = new Map()) {
  const group = conversationGroups(rows, descriptors, jobs).get(key(id));
  return [...(group?.partIds || [])].filter(part => key(part) !== key(id));
}

// see .ai/contexts/session-cache.md ("Local background sidebar rows")
function mergeLocalBackgroundSessions(projects, cachedRows, descriptors, { hiddenProjects, metaMap, showArchived, jobs = new Map(),
  conversations = conversationGroups(cachedRows, descriptors, jobs) }) {
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
    && isHostedJob({ ...jobs.get(descriptor.jobId), id: descriptor.jobId, sessionId: descriptor.sessionId }, [descriptor]));
  const suppressedNames = new Set();
  for (const descriptor of backgrounds) {
    const head = key(descriptor.sessionId);
    let visible = findVisible(head);
    const reachable = conversations.get(head)?.backgroundPaths?.get(head);
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
      const originalId = root.sessionId;
      root.sessionId = descriptor.sessionId;
      root.headSessionId = descriptor.sessionId;
      root.mergedMemberIds = [...new Set([originalId, ...root.mergedMemberIds])].filter(id => key(id) !== head);
      const conversation = conversations.get(head);
      const partIds = conversation ? [...conversation.partIds] : [root.sessionId, ...root.mergedMemberIds];
      const metadata = conversationMeta(partIds, metaMap, conversation?.rootId || originalId);
      const userRenamed = partIds.some(id => metaMap.get(id)?.nameSource === 'user');
      root.name = metadata.name || (userRenamed
        ? localRows.get(key(originalId))?.customTitle || root.aiTitle || root.summary || null : root.name);
      root.starred = metadata.starred;
      root.archived = metadata.archived;
      if (!showArchived && root.archived) {
        for (const project of projects) project.sessions = project.sessions.filter(row => row !== root);
        suppressedNames.add(head);
        continue;
      }
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
      visible = { sessionId: descriptor.sessionId, projectPath, remoteAlias: null, summary: (descriptor.nameSource !== 'collision' && descriptor.name) || 'Background session',
        name: metaMap.get(descriptor.sessionId)?.name || null, aiTitle: null, messageCount: 0, modified, created: modified,
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

module.exports = { mergeLocalBackgroundSessions, conversationGroups, conversationMemberIds };
