// see .ai/contexts/session-cache.md ("Archived projects", worktree nesting)

const SIDEBAR_WORKTREE_RE = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;

/** The repository path a sidebar worktree group nests under, or null. */
function worktreeParentPath(projectPath) {
  const match = typeof projectPath === 'string' ? projectPath.match(SIDEBAR_WORKTREE_RE) : null;
  return match ? match[1] : null;
}

/** The worktree's directory name, or null when the path is not a worktree. */
function worktreeName(projectPath) {
  const match = typeof projectPath === 'string' ? projectPath.match(SIDEBAR_WORKTREE_RE) : null;
  return match ? match[2] : null;
}

// see .ai/contexts/session-cache.md ("Project Archive and Delete")
function isProjectHidden(hiddenProjects, alias, projectPath, hiddenProjectScopes = {}, normalize = value => value) {
  const target = normalize(projectPath);
  for (const entry of hiddenProjects || []) {
    if (typeof entry !== 'string') continue;
    const separator = entry.indexOf('::');
    const entryAlias = separator < 0 ? null : entry.slice(0, separator);
    const entryPath = separator < 0 ? entry : entry.slice(separator + 2);
    if (entryAlias !== null && entryAlias !== alias) continue;
    const scope = Object.prototype.hasOwnProperty.call(hiddenProjectScopes || {}, entry) ? hiddenProjectScopes[entry] : null;
    if (scope && Object.prototype.hasOwnProperty.call(scope, 'alias') && scope.alias !== alias) continue;
    if (normalize(entryPath) === target) return true;
  }
  return false;
}

function isHiddenRepositoryWorktree(projectPath, alias, hiddenProjects, hiddenProjectScopes) {
  const parentPath = worktreeParentPath(projectPath);
  if (parentPath === null) return false;
  return isProjectHidden(hiddenProjects, alias, parentPath, hiddenProjectScopes);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SIDEBAR_WORKTREE_RE, worktreeParentPath, worktreeName, isProjectHidden, isHiddenRepositoryWorktree };
}
