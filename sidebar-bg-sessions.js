'use strict';

const fs = require('fs');
const path = require('path');
const { encodeProjectPath } = require('./encode-project-path');
const { resolveWorktreePath } = require('./derive-project-path');
const { parseFolderKey } = require('./remote-hosts');
const { validId, continuationRollup } = require('./session-continuations');
const { isHostedJob, JOB_ID_RE, JOB_STATES } = require('./bg-agents-roster');
const { conversationMeta } = require('./conversation-meta');

const key = id => String(id).toLowerCase();

function rowScope(row) {
  return row && typeof row.projectPath === 'string' && row.projectPath.trim() && row.folder
    && !row.remoteAlias && parseFolderKey(row.folder).alias === null
    ? { projectPath: row.projectPath, folder: row.folder } : null;
}

function sameScope(a, b) {
  return !!a && !!b && a.projectPath === b.projectPath && a.folder === b.folder;
}

function scopedConversationRows(rows) {
  const byId = new Map(rows.map(row => [key(row.sessionId), row]));
  return rows.map(row => {
    const target = row.mergedIntoSessionId && byId.get(key(row.mergedIntoSessionId));
    return target && (!row.projectPath || row.projectPath !== target.projectPath || row.folder !== target.folder)
      ? { ...row, mergedIntoSessionId: null } : row;
  });
}

function conversationTargets(rows, descriptors, jobs, { projectsDir, folderMeta = new Map(), activeSessions = new Map() } = {}) {
  jobs = new Map([...jobs].map(([id, job]) => [key(id), job]));
  const byId = new Map(rows.filter(row => parseFolderKey(row.folder).alias === null).map(row => [key(row.sessionId), row]));
  const targets = new Map();
  const transcriptFolder = (file, id) => {
    if (!projectsDir || typeof file !== 'string' || !path.isAbsolute(file)) return null;
    const relative = path.relative(path.resolve(projectsDir), path.resolve(file)).split(path.sep);
    return relative.length === 2 && relative[0] && relative[0] !== '..' && relative[0] !== '.'
      && parseFolderKey(relative[0]).alias === null && key(relative[1]) === key(id) + '.jsonl' ? relative[0] : null;
  };
  const scopeForFolder = folder => {
    if (folderMeta.has(folder)) {
      const projectPath = folderMeta.get(folder)?.projectPath;
      return typeof projectPath === 'string' && projectPath.trim() ? { folder, projectPath } : null;
    }
    const scopes = rows.filter(row => row.folder === folder).map(rowScope).filter(Boolean);
    return scopes.length && scopes.every(scope => sameScope(scope, scopes[0])) ? scopes[0] : null;
  };
  const candidates = new Map();
  for (const [id, job] of jobs) {
    if (!JOB_ID_RE.test(id) || !validId(job.sessionId) || !JOB_STATES.has(job.state)) continue;
    const target = key(job.sessionId), cached = byId.get(target);
    const folder = transcriptFolder(job.transcriptPath, target);
    let scope = cached ? rowScope(cached) : folder ? scopeForFolder(folder) : null;
    if (cached && folder && (!scope || folder !== scope.folder || folderMeta.has(folder) && !sameScope(scope, scopeForFolder(folder)))) scope = null;
    if (!candidates.has(target)) candidates.set(target, []);
    candidates.get(target).push({ id: key(id), job, scope, folder });
  }
  for (const [target, list] of candidates) {
    if (list.some(candidate => !candidate.scope) || !list.every(candidate => sameScope(candidate.scope, list[0].scope))) continue;
    targets.set(target, { sessionId: list[0].job.sessionId, scope: list[0].scope, jobs: list.map(c => c.id), descriptors: [], attaches: [] });
  }
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'bg' || !descriptor.jobId || !validId(descriptor.sessionId)) continue;
    const target = key(descriptor.sessionId), cached = byId.get(target), canonical = targets.get(target);
    const job = jobs.get(key(descriptor.jobId));
    if (job?.sessionId && key(job.sessionId) !== target) continue;
    if (candidates.has(target) && !canonical && (cached || candidates.get(target).some(c => c.folder))) continue;
    const projectPath = descriptor.cwd ? resolveWorktreePath(descriptor.cwd) : rowScope(cached)?.projectPath;
    if (!projectPath) continue;
    const descriptorScope = { projectPath, folder: descriptor.cwd ? encodeProjectPath(descriptor.cwd) : cached?.folder };
    const scope = cached ? rowScope(cached) : canonical?.scope || descriptorScope;
    if (!scope || scope.projectPath !== projectPath || (!cached && !sameScope(scope, descriptorScope))) continue;
    if (!isHostedJob({ ...job, id: descriptor.jobId, sessionId: descriptor.sessionId }, [descriptor])) continue;
    if (!targets.has(target)) targets.set(target, { sessionId: descriptor.sessionId, scope,
      jobs: (candidates.get(target) || []).map(c => c.id), descriptors: [], attaches: [] });
    targets.get(target).descriptors.push(descriptor);
  }
  for (const [id, open] of activeSessions) {
    if (!open.isAttach || open.exited || open.host || !open.attachJobId) continue;
    const sessionId = open.realSessionId || id, target = targets.get(key(sessionId));
    const job = jobs.get(key(open.attachJobId));
    if (!target || !job?.sessionId || key(job.sessionId) !== key(sessionId) || !target.jobs.includes(key(open.attachJobId))) continue;
    const cwd = open.cwd || open.projectPath;
    if (!cwd || resolveWorktreePath(cwd) !== target.scope.projectPath) continue;
    target.attaches.push({ sessionId, jobId: key(open.attachJobId) });
  }
  return targets;
}

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
    if (depth === 32) {
      if (predecessors.get(id)?.length) return null;
      continue;
    }
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

function conversationGroups(cachedRows, descriptors = [], jobs = new Map(), rollup, options = {}) {
  cachedRows = scopedConversationRows(cachedRows);
  rollup ||= continuationRollup(cachedRows);
  const groups = new Map();
  for (const row of cachedRows) {
    const representative = row.mergedIntoSessionId || row.sessionId;
    const rootId = rollup.get(representative) || representative;
    if (!groups.has(key(rootId))) groups.set(key(rootId), { rootId, partIds: new Set([rootId]) });
    groups.get(key(rootId)).partIds.add(row.sessionId);
  }
  const byPart = new Map();
  for (const group of groups.values()) for (const id of group.partIds) byPart.set(key(id), group);
  const targets = conversationTargets(cachedRows, descriptors, jobs, options);
  const localRows = new Map(cachedRows.filter(row => !row.parentSessionId && rowScope(row)).map(row => [key(row.sessionId), row]));
  const graph = targets.size ? continuationGraph(localRows) : { indexes: new Map(), predecessors: new Map() };
  for (const [head, target] of targets) {
    const reachable = backgroundPath(head, graph);
    if (!reachable) continue;
    const participants = new Set(reachable.flatMap(id => [...(byPart.get(id)?.partIds || [id])]));
    if (![...participants].every(id => !localRows.has(key(id)) ? key(id) === head && !cachedRows.some(row => key(row.sessionId) === head)
      : sameScope(rowScope(localRows.get(key(id))), target.scope))) continue;
    const root = byPart.get(reachable[0]);
    if (!root) continue;
    root.targets ||= new Map();
    root.targets.set(head, target);
    root.backgroundPaths ||= new Map();
    root.backgroundPaths.set(head, reachable);
    for (const id of reachable) {
      const parts = byPart.get(id)?.partIds || [target.sessionId];
      for (const part of parts) root.partIds.add(part);
    }
    for (const part of root.partIds) byPart.set(key(part), root);
  }
  byPart.targets = targets;
  byPart.proofs = rollup.proofs;
  return byPart;
}

function conversationMemberIds(rows, id, descriptors = [], jobs = new Map(), options = {}) {
  const group = conversationGroups(rows, descriptors, jobs, undefined, options).get(key(id));
  return [...(group?.partIds || [])].filter(part => key(part) !== key(id));
}

// see .ai/contexts/session-cache.md ("Local background sidebar rows")
function mergeLocalBackgroundSessions(projects, cachedRows, descriptors, options) {
  const { hiddenProjects, metaMap, showArchived, jobs = new Map() } = options;
  const conversations = options.conversations || conversationGroups(cachedRows, descriptors, jobs, undefined, options);
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
  const targets = conversations.targets || conversationTargets(cachedRows, descriptors, jobs);
  const acceptedDescriptors = new Set([...targets.values()].flatMap(target => target.descriptors));
  const validDescriptors = descriptors.filter(descriptor => validId(descriptor.sessionId) && (descriptor.kind !== 'bg' || acceptedDescriptors.has(descriptor)));
  const backgrounds = [...targets.values()].map(target => {
    const attached = [...new Set(target.attaches.map(a => a.jobId))];
    const selected = attached.length === 1 ? attached[0] : target.jobs.length === 1 ? target.jobs[0] : null;
    const descriptor = target.descriptors.length === 1 ? target.descriptors[0] : target.descriptors.find(d => d.jobId === selected);
    return { target, selected, descriptor, sessionId: target.sessionId };
  });
  const suppressedNames = new Set();
  for (const candidate of backgrounds) {
    const { target, selected, descriptor } = candidate;
    const head = key(target.sessionId);
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
        if (key(id) !== key(root.sessionId)) members.add(localRows.get(key(id))?.sessionId || target.sessionId);
      }
      root.mergedMemberIds = [...members].sort((a, b) =>
        (localRows.get(key(b))?.modified || '').localeCompare(localRows.get(key(a))?.modified || '') || a.localeCompare(b));
      for (const id of [root.sessionId, ...root.mergedMemberIds]) visibleRows.set(key(id), root);
      const originalId = root.sessionId;
      if (descriptor || target.attaches.length && selected) {
        root.sessionId = target.sessionId;
        root.headSessionId = target.sessionId;
        root.mergedMemberIds = [...new Set([originalId, ...root.mergedMemberIds])].filter(id => key(id) !== head);
      }
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
      if (!descriptor || localRows.has(head) || !descriptor.cwd) continue;
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
    if (selected) {
      visible.identityJobId = selected;
      visible.identitySessionId = target.sessionId;
    }
    if (target.attaches.length === 1) {
      visible.attachJobId = target.attaches[0].jobId;
      visible.attachSessionId = target.sessionId;
    }
    if (descriptor) {
      visible.bgJobId = descriptor.jobId;
      visible.bgSessionId = descriptor.sessionId;
    }
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

module.exports = { mergeLocalBackgroundSessions, conversationGroups, conversationMemberIds, scopedConversationRows };
