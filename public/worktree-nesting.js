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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SIDEBAR_WORKTREE_RE, worktreeParentPath, worktreeName };
}
