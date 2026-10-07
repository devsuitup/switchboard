const fs = require('fs');
const path = require('path');
const { encodeProjectPath, encodedFolderMayExtend, verifiedTranscriptCwd } = require('./encode-project-path');

// see .ai/contexts/session-cache.md ("Bounded cwd scan")
const CWD_SCAN_BYTES = 256 * 1024;

function extractCwdFromJsonl(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(CWD_SCAN_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, CWD_SCAN_BYTES, 0);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    // The last line is truncated mid-entry when the file is bigger than the
    // scan window — drop it instead of feeding garbage to JSON.parse.
    if (bytesRead === CWD_SCAN_BYTES) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
      } catch {}
    }
  } catch {} finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return null;
}

function* cwdsInWindow(fd, start, fileSize) {
  const from = Math.max(0, start - 1);
  const buf = Buffer.alloc(Math.min(CWD_SCAN_BYTES + start - from, fileSize - from));
  const bytesRead = fs.readSync(fd, buf, 0, buf.length, from);
  const lines = buf.toString('utf8', 0, bytesRead).split('\n');
  if (from + bytesRead < fileSize) lines.pop();
  if (start > 0) lines.shift();
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.cwd) yield parsed.cwd;
    } catch {}
  }
}

const WORKTREE_DIRS = ['.worktrees', '.claude-worktrees', path.join('.claude', 'worktrees')];

function mayBeWorktreeFolderOf(cwd, folderName) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (WORKTREE_DIRS.some((wt) => encodedFolderMayExtend(folderName, path.join(dir, wt) + path.sep))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

// see .ai/contexts/session-cache.md ("A transcript moved into a worktree folder")
function extractVerifiedCwdFromJsonl(filePath, folderName, tailBudget = null) {
  let fd;
  let firstRejected = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    for (const cwd of cwdsInWindow(fd, 0, size)) {
      const verified = verifiedTranscriptCwd(cwd, folderName);
      if (verified) return { cwd: verified, rejected: null, complete: true };
      if (firstRejected !== null) continue;
      firstRejected = cwd;
      if (!mayBeWorktreeFolderOf(cwd, folderName)) return { cwd: null, rejected: cwd, complete: true };
    }
    if (firstRejected !== null && size > CWD_SCAN_BYTES) {
      if (tailBudget && tailBudget.bytes < CWD_SCAN_BYTES) return { cwd: null, rejected: firstRejected, complete: false };
      if (tailBudget) tailBudget.bytes -= CWD_SCAN_BYTES;
      const tail = [...cwdsInWindow(fd, size - CWD_SCAN_BYTES, size)].reverse();
      for (const cwd of tail) {
        const verified = verifiedTranscriptCwd(cwd, folderName);
        if (verified) return { cwd: verified, rejected: null, complete: true };
      }
    }
  } catch {} finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  return { cwd: null, rejected: firstRejected, complete: true };
}

const DERIVE_TAIL_BUDGET_BYTES = 4 * CWD_SCAN_BYTES;
const UNRESOLVED_MEMO_MAX = 4096;
const unresolvedMemo = new Map();

function unresolvedCwdOf(filePath, folderName) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const memo = unresolvedMemo.get(filePath);
  if (memo && memo.folderName === folderName && memo.size === stat.size && memo.mtimeMs === stat.mtimeMs) return memo;
  return { stat };
}

function rememberUnresolved(filePath, folderName, stat, rejected) {
  unresolvedMemo.delete(filePath);
  if (unresolvedMemo.size >= UNRESOLVED_MEMO_MAX) unresolvedMemo.delete(unresolvedMemo.keys().next().value);
  unresolvedMemo.set(filePath, { folderName, size: stat.size, mtimeMs: stat.mtimeMs, rejected });
}

function resolveWorktreePath(cwd) {
  if (!cwd) return cwd;
  // Detect worktree paths: <project>/.claude-worktrees/<name>, <project>/.worktrees/<name>, or <project>/.claude/worktrees/<name>
  // Separators: accept both / and \ so Windows cwds collapse too.
  const worktreeMatch = cwd.match(/^(.+?)[/\\]\.(?:claude[/\\]worktrees|claude-worktrees|worktrees)[/\\][^/\\]+[/\\]?$/);
  if (worktreeMatch) {
    const parent = worktreeMatch[1];
    if (fs.existsSync(parent)) return parent;
  }
  return cwd;
}

function deriveProjectPath(folderPath, folderName, opts) {
  const name = folderName || path.basename(folderPath);
  const remote = !!(opts && opts.remote);
  let firstRejected = null;
  const tailBudget = { bytes: DERIVE_TAIL_BUDGET_BYTES };
  let incomplete = false;
  const trustedCwdOf = (filePath) => {
    if (remote) {
      const cwd = extractCwdFromJsonl(filePath);
      return typeof cwd === 'string' && cwd ? cwd : null;
    }
    const memo = unresolvedCwdOf(filePath, name);
    if (!memo) return null;
    if (!memo.stat) {
      if (memo.rejected && firstRejected === null) firstRejected = memo.rejected;
      return null;
    }
    const { cwd, rejected, complete } = extractVerifiedCwdFromJsonl(filePath, name, tailBudget);
    if (cwd) {
      unresolvedMemo.delete(filePath);
      return cwd;
    }
    if (rejected && firstRejected === null) firstRejected = rejected;
    if (complete) rememberUnresolved(filePath, name, memo.stat, rejected);
    else incomplete = true;
    return null;
  };
  const result = deriveVerified(folderPath, trustedCwdOf);
  if (result === null && firstRejected !== null && opts && typeof opts.onRejected === 'function') {
    opts.onRejected(firstRejected);
  }
  if (result === null && incomplete && opts && typeof opts.onIncomplete === 'function') opts.onIncomplete();
  return result;
}

function deriveVerified(folderPath, trustedCwdOf) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = trustedCwdOf(path.join(folderPath, e.name));
        if (cwd) return resolveWorktreePath(cwd);
      }
    }
    // Check session subdirectories (UUID folders with subagent .jsonl files)
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(folderPath, e.name);
      try {
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          let jsonlPath;
          if (sf.isFile() && sf.name.endsWith('.jsonl')) {
            jsonlPath = path.join(subDir, sf.name);
          } else if (sf.isDirectory() && sf.name === 'subagents') {
            const agentFiles = fs.readdirSync(path.join(subDir, 'subagents')).filter(f => f.endsWith('.jsonl'));
            if (agentFiles.length > 0) jsonlPath = path.join(subDir, 'subagents', agentFiles[0]);
          }
          if (jsonlPath) {
            const cwd = trustedCwdOf(jsonlPath);
            if (cwd) return resolveWorktreePath(cwd);
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Locate a session's transcript under any project folder and return its
// recorded cwd. Used on resume: a worktree session's cached projectPath is
// collapsed to the parent repo for sidebar grouping, but `claude --resume` is
// cwd-scoped — resumed from the parent it reports "No conversation found with
// session ID". Reads go through the bounded extractCwdFromJsonl scan (see
// CWD_SCAN_BYTES above) so a giant live-session JSONL can't peg the caller.
// `preferredFolder` (optional) is the encoded folder the caller expects the
// transcript to live in — checked first so the common non-worktree resume
// answers without scanning every project folder.
/**
 * True when `dir` is inside a git working tree.
 *
 * Walks up looking for `.git` (a directory in a normal clone, a file in a
 * worktree or submodule) rather than shelling out to `git rev-parse`: this runs
 * on the launch path, and a spawn per session start is both slower and one more
 * thing that can fail when git is missing from PATH.
 */
function isGitRepo(dir) {
  if (!dir) return false;
  let current;
  try {
    current = path.resolve(dir);
  } catch {
    return false;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * True when a transcript for `sessionId` exists in any project folder.
 *
 * A session Switchboard shows in the sidebar does not necessarily exist on
 * disk: launchNewSession injects a placeholder card before claude starts, so a
 * launch that fails immediately (bad flag, missing dir) leaves a card whose
 * .jsonl was never written. Resuming that id makes claude report "No
 * conversation found"; callers use this to relaunch it as a new session
 * instead.
 */
function sessionTranscriptExists(projectsDir, sessionId) {
  if (!sessionId) return false;
  try {
    for (const folder of fs.readdirSync(projectsDir)) {
      if (fs.existsSync(path.join(projectsDir, folder, sessionId + '.jsonl'))) return true;
    }
  } catch {}
  return false;
}

function storedProjectPathMatchesFolder(projectPath, folder) {
  if (verifiedTranscriptCwd(projectPath, folder)) return true;
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) return false;
  const base = encodeProjectPath(path.resolve(projectPath));
  return folder.startsWith(base) && /^--(?:claude-)?worktrees-./.test(folder.slice(base.length));
}

function resolveSessionRealCwd(projectsDir, sessionId, preferredFolder) {
  try {
    const folders = fs.readdirSync(projectsDir);
    if (preferredFolder) {
      const i = folders.indexOf(preferredFolder);
      if (i > 0) {
        folders.splice(i, 1);
        folders.unshift(preferredFolder);
      }
    }
    for (const folder of folders) {
      const jsonl = path.join(projectsDir, folder, sessionId + '.jsonl');
      if (!fs.existsSync(jsonl)) continue;
      const { cwd } = extractVerifiedCwdFromJsonl(jsonl, folder);
      if (cwd) return cwd;
    }
  } catch {}
  return null;
}

module.exports = { deriveProjectPath, storedProjectPathMatchesFolder, resolveWorktreePath, extractCwdFromJsonl, extractVerifiedCwdFromJsonl, resolveSessionRealCwd, sessionTranscriptExists, isGitRepo };
