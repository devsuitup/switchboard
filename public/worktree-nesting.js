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
function visibilityPath(value, alias = null) {
  if (typeof value !== 'string') return '';
  let normalized = alias ? value : value.replace(/\\/g, '/');
  normalized = normalized.replace(/\/+$/, '');
  if (!alias && (typeof globalThis.process !== 'undefined' ? globalThis.process.platform === 'win32' : window.api?.platform === 'win32')) normalized = normalized.toLowerCase();
  return normalized;
}

function worktreeGroupingPath(value) {
  let current = value, match;
  while (typeof current === 'string' && (match = current.match(/^(.+?)[/\\](?:\.worktrees|\.claude-worktrees|\.claude[/\\]worktrees|\.work-files[/\\]worktrees)[/\\][^/\\]+[/\\]?$/i))) current = match[1];
  return current;
}

function sessionUnderPath(session, projectPath, alias = null) {
  if (!alias && session.runtime !== 'codex'
    && /[/\\](?:\.worktrees|\.claude-worktrees|\.claude[/\\]worktrees)[/\\][^/\\]+[/\\]?$/i.test(projectPath)) return false;
  const target = visibilityPath(projectPath, alias);
  const cwd = visibilityPath(session.runtime === 'claude' ? session.recordedCwd : session.cwd || (session.runtime === 'codex' ? session.projectPath : null), alias);
  if (cwd && (cwd === target || cwd.startsWith(target + '/'))) return true;
  if (session.runtime === 'codex') return false;
  const folder = session.sourceFolder || session.folder;
  if (typeof folder !== 'string') return false;
  const bare = folder.replace(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}::/, '');
  const encode = typeof module !== 'undefined' && module.exports ? module.require('../encode-project-path').encodeProjectPath : encodeProjectPath;
  const encoded = encode(projectPath.replace(/[/\\]+$/, ''));
  const normalize = value => visibilityPath(value, alias);
  return normalize(bare) === normalize(encoded) || ['--worktrees-', '--claude-worktrees-', '--work-files-worktrees-']
    .some(suffix => normalize(bare).startsWith(normalize(encoded + suffix)));
}

function isProjectHidden(hiddenProjects, alias, projectPath, hiddenProjectScopes = {}, normalize = visibilityPath) {
  return projectHiddenMatcher(hiddenProjects, hiddenProjectScopes, normalize)(alias, projectPath);
}

function projectHiddenMatcher(hiddenProjects, hiddenProjectScopes = {}, normalize = visibilityPath, normalizeTarget = normalize) {
  const entries = [];
  for (const entry of hiddenProjects || []) {
    if (typeof entry !== 'string') continue;
    const separator = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}::/.test(entry) ? entry.indexOf('::') : -1;
    const entryAlias = separator < 0 ? null : entry.slice(0, separator);
    const entryPath = separator < 0 ? entry : entry.slice(separator + 2);
    const scope = Object.prototype.hasOwnProperty.call(hiddenProjectScopes || {}, entry) ? hiddenProjectScopes[entry] : null;
    entries.push({ alias: entryAlias, path: normalize(entryPath, entryAlias), sourcePath: entryPath,
      remotePath: normalize === visibilityPath ? visibilityPath(entryPath, 'remote') : null,
      worktree: worktreeGroupingPath(entryPath) !== entryPath, scope });
  }
  if (!entries.length) return () => false;
  return (alias, projectPath, session) => {
    const target = normalizeTarget(projectPath, alias);
    return entries.some(entry => (entry.alias === null || entry.alias === alias)
      && (!entry.scope || !Object.prototype.hasOwnProperty.call(entry.scope, 'alias') || entry.scope.alias === alias)
      && (entry.worktree && session ? sessionUnderPath(session, entry.sourcePath, alias)
        : (alias && entry.remotePath !== null ? entry.remotePath : entry.path) === target
          || entry.worktree && typeof target === 'string' && target.startsWith((alias && entry.remotePath !== null ? entry.remotePath : entry.path) + '/')));
  };
}

function isHiddenRepositoryWorktree(projectPath, alias, hiddenProjects, hiddenProjectScopes) {
  const parentPath = worktreeParentPath(projectPath);
  if (parentPath === null) return false;
  return isProjectHidden(hiddenProjects, alias, parentPath, hiddenProjectScopes);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SIDEBAR_WORKTREE_RE, worktreeParentPath, worktreeName, isProjectHidden, projectHiddenMatcher, isHiddenRepositoryWorktree, visibilityPath, worktreeGroupingPath, sessionUnderPath };
}
