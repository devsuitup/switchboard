// git-changes-target.js — cwd resolution for the Changes panel IPCs — see .ai/contexts/changes-view.md

'use strict';

// Accepted sessionId shapes — see .ai/contexts/changes-view.md ("cwd resolution").
const PLAIN_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER_SESSION_ID_RE = /^pid:[1-9][0-9]*$/;

function isValidChangesSessionId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (id === '.' || id === '..') return false;
  if (PLAIN_SESSION_ID_RE.test(id)) return true;
  return PLACEHOLDER_SESSION_ID_RE.test(id);
}

// deps: {getCachedFolder, isRemoteFolder, parseFolderKey, getRemoteSessions, activeSessions, resolveSessionRealCwd, existsSync, projectsDir}
function resolveGitChangesTarget(sessionId, deps) {
  const id = String(sessionId || '');
  if (!isValidChangesSessionId(id)) return { ok: false, error: 'invalid session id' };

  let folder = null;
  try { folder = deps.getCachedFolder(id); } catch {}

  if (deps.isRemoteFolder(folder)) {
    const { alias } = deps.parseFolderKey(folder);
    const descriptor = deps.getRemoteSessions(alias).sessions.find((s) => s.sessionId === id);
    const cwd = descriptor && typeof descriptor.cwd === 'string' ? descriptor.cwd : null;
    if (!cwd) return { ok: false, error: 'remote session has no known working directory' };
    return { ok: true, kind: 'remote', alias, cwd };
  }

  const session = deps.activeSessions.get(id);
  if (session && !session.exited && session.cwd) {
    return { ok: true, kind: 'local', cwd: session.cwd };
  }
  const realCwd = deps.resolveSessionRealCwd(deps.projectsDir, id, folder);
  if (realCwd && deps.existsSync(realCwd)) {
    return { ok: true, kind: 'local', cwd: realCwd };
  }
  return { ok: false, error: 'could not resolve a working directory for this session' };
}

module.exports = { resolveGitChangesTarget, isValidChangesSessionId };
