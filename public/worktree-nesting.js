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
  return projectHiddenMatcher(hiddenProjects, hiddenProjectScopes, normalize)(alias, projectPath);
}

function projectHiddenMatcher(hiddenProjects, hiddenProjectScopes = {}, normalize = value => value) {
  const entries = [];
  for (const entry of hiddenProjects || []) {
    if (typeof entry !== 'string') continue;
    const separator = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}::/.test(entry) ? entry.indexOf('::') : -1;
    const entryAlias = separator < 0 ? null : entry.slice(0, separator);
    const entryPath = separator < 0 ? entry : entry.slice(separator + 2);
    const scope = Object.prototype.hasOwnProperty.call(hiddenProjectScopes || {}, entry) ? hiddenProjectScopes[entry] : null;
    entries.push({ alias: entryAlias, path: normalize(entryPath), scope });
  }
  if (!entries.length) return () => false;
  return (alias, projectPath) => {
    const target = normalize(projectPath);
    return entries.some(entry => (entry.alias === null || entry.alias === alias)
      && (!entry.scope || !Object.prototype.hasOwnProperty.call(entry.scope, 'alias') || entry.scope.alias === alias)
      && entry.path === target);
  };
}

function isHiddenRepositoryWorktree(projectPath, alias, hiddenProjects, hiddenProjectScopes) {
  const parentPath = worktreeParentPath(projectPath);
  if (parentPath === null) return false;
  return isProjectHidden(hiddenProjects, alias, parentPath, hiddenProjectScopes);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SIDEBAR_WORKTREE_RE, worktreeParentPath, worktreeName, isProjectHidden, projectHiddenMatcher, isHiddenRepositoryWorktree };
}
