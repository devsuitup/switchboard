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
function isHiddenRepositoryWorktree(projectPath, alias, hiddenProjects) {
  const parentPath = worktreeParentPath(projectPath);
  if (parentPath === null) return false;
  const hidden = Array.isArray(hiddenProjects) ? hiddenProjects : [];
  return hidden.includes(parentPath) || !!(alias && hidden.includes(alias + '::' + parentPath));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SIDEBAR_WORKTREE_RE, worktreeParentPath, worktreeName, isHiddenRepositoryWorktree };
}
