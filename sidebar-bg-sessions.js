'use strict';

const fs = require('fs');
const { encodeProjectPath } = require('./encode-project-path');
const { resolveWorktreePath } = require('./derive-project-path');
const { parseFolderKey } = require('./remote-hosts');
const { resolveContinuationsSync, validId } = require('./session-continuations');

// see .ai/contexts/session-cache.md ("Local background sidebar rows")
function mergeLocalBackgroundSessions(projects, cachedRows, descriptors, { hiddenProjects, metaMap, showArchived }) {
  const key = id => String(id).toLowerCase();
  const localRows = new Map(cachedRows.filter(row => !row.parentSessionId && parseFolderKey(row.folder).alias === null)
    .map(row => [key(row.sessionId), row]));
  const findVisible = id => projects.filter(project => !project.remoteAlias).flatMap(project => project.sessions)
    .find(row => [row.sessionId, ...(row.mergedMemberIds || [])].some(member => key(member) === key(id)));
  for (const descriptor of descriptors) {
    if (!validId(descriptor.sessionId)) continue;
    const head = key(descriptor.sessionId);
    let visible = findVisible(head);
    if (descriptor.kind === 'bg' && descriptor.jobId) {
      const paths = [];
      const getNode = id => {
        const row = localRows.get(key(id));
        if (!row) return key(id) === head ? { index: { ids: [] } } : null;
        let index;
        try { index = JSON.parse(row.continuationIndex); } catch {}
        if (!index && key(id) === head) return { index: { ids: [] } };
        if (index?.format !== 3 || !index.complete || index.unresolved || !Array.isArray(index.ids) || index.ids.length > 1
          || (row.fileMtime && index.mtime !== row.fileMtime)) return null;
        return { index, modified: row.modified };
      };
      for (const row of localRows.values()) {
        if (key(row.sessionId) === head) continue;
        const result = resolveContinuationsSync(row.sessionId, getNode, { includeReachable: true });
        if (!result.incomplete && result.continued && result.candidates.length === 1 && key(result.candidates[0].sessionId) === head) {
          paths.push({ id: row.sessionId, reachable: result.reachable });
        }
      }
      const roots = paths.filter(candidate => !paths.some(other => other !== candidate
        && other.reachable.some(id => key(id) === key(candidate.id))));
      if (roots.length === 1) {
        const root = findVisible(roots[0].id);
        if (!root) continue;
        const members = new Set(root.mergedMemberIds || []);
        for (const id of roots[0].reachable) {
          const child = findVisible(id);
          if (child && child !== root) {
            root.messageCount += child.messageCount || 0;
            if (child.modified > root.modified) root.modified = child.modified;
            members.add(child.sessionId);
            for (const member of child.mergedMemberIds || []) members.add(member);
            for (const project of projects) project.sessions = project.sessions.filter(row => row !== child);
          }
          if (key(id) !== key(root.sessionId)) members.add(localRows.get(key(id))?.sessionId || descriptor.sessionId);
        }
        root.mergedMemberIds = [...members].sort((a, b) =>
          (localRows.get(key(b))?.modified || '').localeCompare(localRows.get(key(a))?.modified || '') || a.localeCompare(b));
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
      }
      visible.bgJobId = descriptor.jobId;
      visible.bgSessionId = descriptor.sessionId;
    }
    if (visible && descriptor.nameSource === 'user' && descriptor.name
      && (!visible.bgSessionId || key(visible.bgSessionId) === head)) visible.name = descriptor.name;
  }
  return projects;
}

module.exports = { mergeLocalBackgroundSessions };
