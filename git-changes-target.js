// git-changes-target.js — cwd resolution for the Changes panel IPCs — see .ai/contexts/changes-view.md

'use strict';

const path = require('path');

// Accepted sessionId shapes — see .ai/contexts/changes-view.md ("cwd resolution").
const PLAIN_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER_SESSION_ID_RE = /^pid:[1-9][0-9]*$/;
const SUBAGENT_SESSION_ID_RE = /^sub:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/;

function isDotSegment(s) {
  return s === '.' || s === '..';
}

function parseSubagentId(id) {
  const m = typeof id === 'string' ? SUBAGENT_SESSION_ID_RE.exec(id) : null;
  if (!m || isDotSegment(m[1]) || isDotSegment(m[2])) return null;
  return { parentId: m[1], agentId: m[2] };
}

// opts.allowSubagent admits the sub:<parent>:<agent> shape, for the read-only IPCs only.
function isValidChangesSessionId(id, opts) {
  if (typeof id !== 'string' || id === '') return false;
  if (id === '.' || id === '..') return false;
  if (PLAIN_SESSION_ID_RE.test(id)) return true;
  if (PLACEHOLDER_SESSION_ID_RE.test(id)) return true;
  return !!(opts && opts.allowSubagent) && parseSubagentId(id) !== null;
}

function isSafeWorktreePath(p) {
  if (typeof p !== 'string' || p === '' || p.length > 4096) return false;
  if (/[\x00-\x1f]/.test(p)) return false;
  if (/^[/\\]{2}/.test(p)) return false;
  if (!path.isAbsolute(p)) return false;
  return !p.split(/[/\\]/).includes('..');
}

// {ok: true, worktree: string|null} (null: the agent records none, so it shares its parent's directory) or a refusal.
function readSubagentWorktree(id, deps) {
  const { parentId, agentId } = parseSubagentId(id);
  let folder = null;
  try { folder = deps.getCachedFolder(id); } catch {}
  if (!folder) return { ok: false, error: 'subagent not found' };
  if (deps.isRemoteFolder(folder)) return { ok: false, error: 'a remote subagent has no Changes view' };

  const jsonlPath = path.join(deps.projectsDir, folder, parentId, 'subagents', `agent-${agentId}.jsonl`);
  const meta = deps.readSubagentMeta(jsonlPath);
  if (!meta || typeof meta !== 'object') {
    return { ok: false, reason: 'no-worktree-recorded', error: 'the subagent has no readable record of its worktree' };
  }
  const recorded = meta.worktreePath;
  if (recorded === undefined || recorded === null) return { ok: true, worktree: null };
  if (!isSafeWorktreePath(recorded)) return { ok: false, error: 'the subagent recorded an unusable worktree path' };
  if (!deps.existsSync(recorded)) {
    return { ok: false, reason: 'worktree-removed', error: 'the worktree of this subagent no longer exists' };
  }
  return { ok: true, worktree: recorded };
}

function resolveSubagentTarget(id, deps) {
  const found = readSubagentWorktree(id, deps);
  if (!found.ok) return found;
  if (found.worktree === null) {
    const parent = resolveGitChangesTarget(parseSubagentId(id).parentId, deps);
    return parent.ok ? { ...parent, subagent: true } : parent;
  }
  return { ok: true, kind: 'local', cwd: found.worktree, subagent: true };
}

const MAX_SUBAGENT_WORKTREES = 8;

// deps adds listSubagents(parentId) -> [{sessionId, agentId, description, subagentType}]
function listSubagentWorktrees(parentId, deps) {
  const id = String(parentId || '');
  if (!isValidChangesSessionId(id)) return [];
  const parent = resolveGitChangesTarget(id, deps);
  if (!parent.ok || parent.kind !== 'local') return [];
  const out = [];
  for (const row of deps.listSubagents(id)) {
    if (out.length >= MAX_SUBAGENT_WORKTREES) break;
    if (!row || !isValidChangesSessionId(row.sessionId, { allowSubagent: true })) continue;
    const parsed = parseSubagentId(row.sessionId);
    if (!parsed || parsed.parentId !== id) continue;
    const found = readSubagentWorktree(row.sessionId, deps);
    if (!found.ok || found.worktree === null) continue;
    if (path.relative(path.resolve(parent.cwd), path.resolve(found.worktree)) === '') continue;
    out.push({
      sessionId: row.sessionId,
      agentId: parsed.agentId,
      label: row.description || row.subagentType || parsed.agentId,
      cwd: found.worktree,
    });
  }
  return out;
}

async function collectSubagentChanges(groups, runnerFor) {
  const settled = await Promise.all(groups.map(async (group) => {
    try {
      const result = await runnerFor(group.cwd).status();
      if (!result || result.ok === false || !Array.isArray(result.files) || result.files.length === 0) return null;
      return {
        sessionId: group.sessionId,
        agentId: group.agentId,
        label: group.label,
        branch: result.branch,
        files: result.files,
        totals: result.totals,
      };
    } catch {
      return null;
    }
  }));
  return settled.filter(Boolean);
}

// deps: {getCachedFolder, isRemoteFolder, parseFolderKey, getRemoteSessions, activeSessions, resolveSessionRealCwd, existsSync, projectsDir, readSubagentMeta}
function resolveGitChangesTarget(sessionId, deps, opts) {
  const id = String(sessionId || '');
  if (!isValidChangesSessionId(id, opts)) return { ok: false, error: 'invalid session id' };
  if (parseSubagentId(id)) return resolveSubagentTarget(id, deps);

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

module.exports = { resolveGitChangesTarget, isValidChangesSessionId, parseSubagentId, listSubagentWorktrees, collectSubagentChanges };
