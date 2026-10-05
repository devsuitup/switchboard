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

const BACKSLASH = String.fromCharCode(92);
const DRIVE_RE = /^[A-Za-z]:/;

function isSep(c) {
  return c === '/' || c === BACKSLASH;
}

function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return true;
  return false;
}

// The path to use, or null. An extended-length drive path (backslash-backslash, '?' or '.', backslash, then a drive
// and a root) is normalised to the drive path; every other path starting with two separators is refused.
function normaliseWorktreePath(p) {
  if (typeof p !== 'string' || p === '' || p.length > 4096) return null;
  if (hasControlChar(p)) return null;
  let q = p;
  if (isSep(q[0]) && isSep(q[1])) {
    const extended = q[0] === BACKSLASH && q[1] === BACKSLASH && (q[2] === '?' || q[2] === '.') && q[3] === BACKSLASH;
    const rest = extended ? q.slice(4) : '';
    if (!DRIVE_RE.test(rest) || !isSep(rest[2])) return null;
    q = rest;
  }
  if (!path.win32.isAbsolute(q) && !path.posix.isAbsolute(q)) return null;
  if (q.split('/').join(BACKSLASH).split(BACKSLASH).includes('..')) return null;
  return q;
}

function samePath(a, b, pathOps = path) {
  return pathOps.relative(pathOps.resolve(a), pathOps.resolve(b)) === '';
}

// {ok: true, worktree: string|null} (null: the agent records none, so it shares its parent's directory) or a refusal.
function worktreeFromMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return { ok: false, reason: 'no-worktree-recorded', error: 'the subagent has no readable record of its worktree' };
  }
  const recorded = meta.worktreePath;
  if (recorded === undefined || recorded === null) return { ok: true, worktree: null };
  const worktree = normaliseWorktreePath(recorded);
  if (worktree === null) return { ok: false, error: 'the subagent recorded an unusable worktree path' };
  return { ok: true, worktree };
}

function subagentJsonlPath(id, folder, deps) {
  const { parentId, agentId } = parseSubagentId(id);
  return path.join(deps.projectsDir, folder, parentId, 'subagents', `agent-${agentId}.jsonl`);
}

function readSubagentWorktree(id, deps) {
  let folder = null;
  try { folder = deps.getCachedFolder(id); } catch {}
  if (!folder) return { ok: false, error: 'subagent not found' };
  if (deps.isRemoteFolder(folder)) return { ok: false, error: 'a remote subagent has no Changes view' };

  const found = worktreeFromMeta(deps.readSubagentMeta(subagentJsonlPath(id, folder, deps)));
  if (!found.ok || found.worktree === null) return found;
  if (!deps.existsSync(found.worktree)) {
    return { ok: false, reason: 'worktree-removed', error: 'the worktree of this subagent no longer exists' };
  }
  return found;
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
const MAX_SCANNED_WORKTREES = 24;
const SIDECAR_READ_CONCURRENCY = 8;
const SUBAGENT_STATUS_CONCURRENCY = 3;
const MAX_CACHE_ENTRIES = 4000;
const TTL_WORKTREE_MS = 300_000;
const TTL_SHORT_MS = 30_000;
const TTL_UNREADABLE_MS = 10_000;

const defaultCache = new Map();

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

function nowOf(deps) {
  return typeof deps.now === 'function' ? deps.now() : Date.now();
}

function cacheGet(cache, key, now) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= now) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(cache, key, value, ttlMs, now) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, { value, expires: now + ttlMs });
}

async function commonDirOf(cwd, deps, cache) {
  const key = 'common:' + cwd;
  const now = nowOf(deps);
  const cached = cacheGet(cache, key, now);
  if (cached) return cached;
  let dir = null;
  try { dir = await deps.gitCommonDir(cwd); } catch {}
  if (typeof dir !== 'string' || dir === '') return null;
  cacheSet(cache, key, dir, TTL_SHORT_MS, now);
  return dir;
}

// A linked worktree's .git is a file naming a directory under <common dir>/worktrees; read it, never ask git.
// deps.readDotGit(worktree) -> {file: boolean, content: string} | null
async function worktreeBelongsTo(worktree, parentCommon, deps, pathOps) {
  let info = null;
  try { info = await deps.readDotGit(worktree); } catch {}
  if (!info || info.file !== true || typeof info.content !== 'string') return false;
  const line = info.content.split('\n')[0].trim();
  if (!line.startsWith('gitdir:')) return false;
  const target = line.slice('gitdir:'.length).trim();
  if (target === '' || hasControlChar(target)) return false;
  const rel = pathOps.relative(pathOps.resolve(parentCommon, 'worktrees'), pathOps.resolve(worktree, target));
  return rel !== '' && rel.split(pathOps.sep)[0] !== '..' && !pathOps.isAbsolute(rel);
}

function timeOf(row) {
  const t = Date.parse(row && row.modified);
  return Number.isNaN(t) ? -Infinity : t;
}

// deps adds listSubagents(parentId) -> [{sessionId, agentId, description, subagentType, modified}],
// readSubagentMetaAsync(jsonlPath), exists(path), gitCommonDir(cwd), readDotGit(worktree) and optionally cache, now and pathOps.
// Resolves {worktrees, notScanned}. see .ai/contexts/changes-view.md ("Subagent worktrees")
async function listSubagentWorktrees(parentId, deps) {
  const none = { worktrees: [], notScanned: 0 };
  const id = String(parentId || '');
  if (!isValidChangesSessionId(id)) return none;
  const parent = resolveGitChangesTarget(id, deps);
  if (!parent.ok || parent.kind !== 'local') return none;
  const pathOps = deps.pathOps || path;
  const cache = deps.cache || defaultCache;
  const now = nowOf(deps);

  const items = [];
  for (const row of deps.listSubagents(id) || []) {
    if (!row || !isValidChangesSessionId(row.sessionId, { allowSubagent: true })) continue;
    const parsed = parseSubagentId(row.sessionId);
    if (!parsed || parsed.parentId !== id) continue;
    let folder = null;
    try { folder = deps.getCachedFolder(row.sessionId); } catch {}
    if (!folder || deps.isRemoteFolder(folder)) continue;
    items.push({ row, parsed, key: 'sidecar:' + subagentJsonlPath(row.sessionId, folder, deps) });
  }

  await mapLimit(items, SIDECAR_READ_CONCURRENCY, async (item) => {
    let entry = cacheGet(cache, item.key, now);
    if (!entry) {
      let meta = null;
      try { meta = await deps.readSubagentMetaAsync(item.key.slice('sidecar:'.length)); } catch {}
      const found = worktreeFromMeta(meta);
      if (found.reason === 'no-worktree-recorded') {
        cacheSet(cache, item.key, { unreadable: true }, TTL_UNREADABLE_MS, now);
        return;
      }
      entry = { worktree: found.ok ? found.worktree : null };
      cacheSet(cache, item.key, entry, entry.worktree ? TTL_WORKTREE_MS : TTL_SHORT_MS, now);
    }
    item.entry = entry;
  });

  const candidates = items
    .filter((item) => item.entry && item.entry.worktree && !cacheGet(cache, 'gone:' + item.entry.worktree, now))
    .sort((x, y) => timeOf(y.row) - timeOf(x.row));
  if (candidates.length === 0) return none;

  const parentCommon = await commonDirOf(parent.cwd, deps, cache);
  if (!parentCommon) return none;

  const worktrees = [];
  let scanned = 0;
  for (const item of candidates) {
    if (scanned >= MAX_SCANNED_WORKTREES) break;
    scanned++;
    const worktree = item.entry.worktree;
    let present = false;
    try { present = await deps.exists(worktree); } catch {}
    if (!present) {
      cacheSet(cache, 'gone:' + worktree, true, TTL_SHORT_MS, now);
      continue;
    }
    if (samePath(parent.cwd, worktree, pathOps)) continue;
    if (!(await worktreeBelongsTo(worktree, parentCommon, deps, pathOps))) continue;
    worktrees.push({
      sessionId: item.row.sessionId,
      agentId: item.parsed.agentId,
      label: item.row.description || item.row.subagentType || item.parsed.agentId,
      cwd: worktree,
    });
  }
  return { worktrees, notScanned: candidates.length - scanned };
}

// A subagent worktree is only read through git when it is a linked worktree of the parent's repository.
async function checkSubagentRepo(sessionId, target, deps) {
  if (!target || target.ok !== true) return target;
  if (!target.subagent) return { ok: true };
  const cache = deps.cache || defaultCache;
  const pathOps = deps.pathOps || path;
  const parent = resolveGitChangesTarget(parseSubagentId(sessionId).parentId, deps);
  if (!parent.ok) return parent;
  if (samePath(parent.cwd, target.cwd, pathOps)) return { ok: true };
  const parentCommon = await commonDirOf(parent.cwd, deps, cache);
  if (!parentCommon || !(await worktreeBelongsTo(target.cwd, parentCommon, deps, pathOps))) {
    return { ok: false, reason: 'other-repo', error: 'the subagent worktree does not belong to the session repository' };
  }
  return { ok: true };
}

async function collectSubagentChanges(groups, runnerFor) {
  const settled = await mapLimit(groups, SUBAGENT_STATUS_CONCURRENCY, async (group) => {
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
  });
  const withChanges = settled.filter(Boolean);
  return {
    subagents: withChanges.slice(0, MAX_SUBAGENT_WORKTREES),
    omitted: Math.max(0, withChanges.length - MAX_SUBAGENT_WORKTREES),
  };
}

// deps: {getCachedFolder, isRemoteFolder, parseFolderKey, getRemoteSessions, activeSessions, wasRemoteSession, resolveSessionRealCwd, existsSync, projectsDir, readSubagentMeta}
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
    if (!cwd) return { ok: false, kind: 'remote', error: 'remote session has no known working directory' };
    return { ok: true, kind: 'remote', alias, cwd };
  }

  const session = deps.activeSessions.get(id);
  if ((session && session.kind && session.kind !== 'local-pty') || deps.wasRemoteSession(id)) return { ok: false, kind: 'remote', error: 'remote session' };
  if (session && !session.exited && session.cwd) {
    return { ok: true, kind: 'local', cwd: session.cwd };
  }
  const realCwd = deps.resolveSessionRealCwd(deps.projectsDir, id, folder);
  if (realCwd && deps.existsSync(realCwd)) {
    return { ok: true, kind: 'local', cwd: realCwd };
  }
  return { ok: false, error: 'could not resolve a working directory for this session' };
}

module.exports = { resolveGitChangesTarget, isValidChangesSessionId, parseSubagentId, listSubagentWorktrees, collectSubagentChanges, checkSubagentRepo };
