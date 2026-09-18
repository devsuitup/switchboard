// git-changes-runner.js — runs the git commands, local or remote — see .ai/contexts/changes-view.md

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { defaultRunRemoteCommand } = require('./remote-attach');
const { parseStatusPorcelainV2, parseNumstat, mergeChanges, countNewFileDiffAdditions, diffHeaderNamesPath } = require('./git-changes');

const DEFAULT_LOCAL_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 20_000;
const MAX_DIFF_BYTES = 512 * 1024;
const LOCAL_MAX_BUFFER = 20 * 1024 * 1024;
// Remote stdout caps — see .ai/contexts/changes-view.md ("Remote transport stdout cap").
const STATUS_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const DIFF_STDOUT_SLACK_BYTES = 64 * 1024;
const DIFF_MAX_STDOUT_BYTES = MAX_DIFF_BYTES + DIFF_STDOUT_SLACK_BYTES;
// An unexpected git failure is reported, bounded — see .ai/contexts/changes-view.md ("Bounded error messages")
const MAX_ERROR_LINES = 5;
const MAX_ERROR_CHARS = 500;
// git's generic fatal exit code, not a "no repository" code — see .ai/contexts/changes-view.md ("Not a repository")
const GIT_FATAL_EXIT_CODE = 128;
// defaultLocalExec's code for a spawn that never ran — see .ai/contexts/changes-view.md ("Not a repository")
const EXEC_FAILED_CODE = -1;
const NOT_A_REPO_REASON = 'not-a-repo';

// Denylist, not allowlist — see .ai/contexts/changes-view.md ("Quoting rule")
function isSafeShellArg(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 4096 && !/[\x00\n\r]/.test(s);
}

function isSafeCwd(cwd) {
  return isSafeShellArg(cwd);
}

function hasDotDotSegment(p) {
  return p.split(/[/\\]/).includes('..');
}

// Denylist plus a leading-':' shape check — see .ai/contexts/changes-view.md ("Quoting rule").
function isSafeGitPath(p) {
  if (!isSafeShellArg(p)) return false;
  if (hasDotDotSegment(p)) return false;
  if (p[0] === ':') return false;
  return true;
}

// `git diff --no-index` operands are filesystem paths, not pathspecs — see .ai/contexts/changes-view.md ("Untracked files")
const NO_INDEX_EMPTY_SIDE = '/dev/null';

function isSafeNoIndexPath(p) {
  if (!isSafeGitPath(p)) return false;
  if (p[0] === '-') return false;
  if (p[0] === '/' || p[0] === '\\') return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return true;
}

// fs seam — injected in tests, real fs in production (same pattern as remote-attach.js's spawnFn)
const DEFAULT_FS_OPS = {
  realpath: (p) => fs.realpathSync.native(p),
  lstat: (p) => fs.lstatSync(p),
  stat: (p) => fs.statSync(p),
};

function isInsideRoot(root, candidate, pathOps) {
  if (candidate === root) return true;
  const rel = pathOps.relative(root, candidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + pathOps.sep) && !pathOps.isAbsolute(rel);
}

// git spells every path with forward slashes — see .ai/contexts/changes-view.md ("Untracked files")
function toGitPath(p, pathOps) {
  return pathOps.sep === '/' ? p : p.split(pathOps.sep).join('/');
}

// git follows a symlink to a directory — see .ai/contexts/changes-view.md ("Untracked files")
function leafSymlinkIsDiffable(resolved, fsOps) {
  let target;
  try {
    target = fsOps.stat(resolved);
  } catch {
    return true;
  }
  return target.isFile();
}

// Containment for a --no-index operand — see .ai/contexts/changes-view.md ("Untracked files")
function resolveLocalNoIndexOperand(cwd, filePath, fsOps = DEFAULT_FS_OPS, pathOps = path) {
  if (!isSafeNoIndexPath(filePath)) return null;

  try {
    const root = fsOps.realpath(cwd);
    const absolute = pathOps.resolve(root, filePath);
    const parent = fsOps.realpath(pathOps.dirname(absolute));
    if (!root || !parent || !isInsideRoot(root, parent, pathOps)) return null;

    const resolved = pathOps.join(parent, pathOps.basename(absolute));
    const stat = fsOps.lstat(resolved);
    if (!stat.isFile() && !stat.isSymbolicLink()) return null;
    if (stat.isSymbolicLink() && !leafSymlinkIsDiffable(resolved, fsOps)) return null;

    const operand = toGitPath(pathOps.relative(root, resolved), pathOps);
    return isSafeNoIndexPath(operand) ? operand : null;
  } catch {
    return null;
  }
}

// true/false/null (undecidable) — see .ai/contexts/changes-view.md ("Not a repository")
function gitEntryAtOrAbove(startDir, fsOps = DEFAULT_FS_OPS, pathOps = path) {
  let dir;
  try {
    dir = pathOps.resolve(startDir);
  } catch {
    return null;
  }
  for (;;) {
    try {
      fsOps.lstat(pathOps.join(dir, '.git'));
      return true;
    } catch (err) {
      const code = err && err.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
    }
    const parent = pathOps.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// A local spawn fails on the cwd long before it fails on git — see .ai/contexts/changes-view.md ("Not a repository")
function missingCwdError(cwd, fsOps = DEFAULT_FS_OPS) {
  if (!fsOps || typeof fsOps.stat !== 'function') {
    throw new TypeError('missingCwdError requires fsOps.stat');
  }
  try {
    return fsOps.stat(cwd).isDirectory() ? null : `working directory is not a directory: ${cwd}`;
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return `working directory no longer exists: ${cwd}`;
    return null;
  }
}

// --literal-pathspecs on every invocation — see .ai/contexts/changes-view.md ("Quoting rule").
function buildGitArgs(args) {
  return ['--literal-pathspecs', ...args];
}

// Cut on a line boundary at or under maxBytes, measured in UTF-8 bytes — see .ai/contexts/changes-view.md ("Runner interface")
function truncateDiffContent(content, maxBytes) {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return { content, truncated: false };
  const lines = content.split('\n');
  let acc = '';
  let accBytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const chunk = i < lines.length - 1 ? lines[i] + '\n' : lines[i];
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (accBytes + chunkBytes > maxBytes) break;
    acc += chunk;
    accBytes += chunkBytes;
  }
  return { content: acc, truncated: true };
}

// POSIX single-quote escaping — see .ai/contexts/changes-view.md ("Quoting rule")
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildRemoteGitCommand(cwd, args) {
  return ['git', '-C', shQuote(cwd), ...args.map(shQuote)].join(' ');
}

// The session's cwd is authoritative: inherited repo-location vars must not redirect git — see .ai/contexts/changes-view.md
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_NAMESPACE'];

function localGitEnv() {
  const env = { ...process.env };
  for (const k of GIT_LOCATION_ENV) delete env[k];
  return env;
}

function defaultLocalExec(args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: localGitEnv(), timeout: timeoutMs, maxBuffer: LOCAL_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ code: typeof err.code === 'number' ? err.code : -1, stdout: stdout || '', stderr: stderr || err.message || String(err) });
          return;
        }
        resolve({ code: 0, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}

// Bounds what git wrote — see .ai/contexts/changes-view.md ("Bounded error messages")
function boundErrorMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  let out = lines.slice(0, MAX_ERROR_LINES).join('\n');
  let dropped = lines.length > MAX_ERROR_LINES;
  if (out.length > MAX_ERROR_CHARS) {
    out = out.slice(0, MAX_ERROR_CHARS).trimEnd();
    dropped = true;
  }
  return dropped ? out + '…' : out;
}

function firstError(result) {
  return boundErrorMessage(result.stderr) || `git exited with code ${result.code}`;
}

// The two stdout-cap overruns: the remote transport's own, and execFile's maxBuffer — see .ai/contexts/changes-view.md ("Untracked files")
function isStdoutCapFailure(result) {
  const stderr = (result && result.stderr) || '';
  return /stdout exceeded \d+ bytes/.test(stderr) || /maxBuffer length exceeded/i.test(stderr);
}

// {kind, cwd, alias, exec, timeoutMs, fsOps} — see .ai/contexts/changes-view.md ("Runner interface")
function createGitChangesRunner({ kind, cwd, alias, exec, timeoutMs, fsOps } = {}) {
  if (kind !== 'local' && kind !== 'remote') {
    throw new Error('createGitChangesRunner requires kind "local" or "remote"');
  }
  if (!isSafeCwd(cwd)) {
    throw new Error('createGitChangesRunner requires a valid cwd');
  }
  if (kind === 'remote' && (typeof alias !== 'string' || !alias)) {
    throw new Error('createGitChangesRunner requires an alias for a remote runner');
  }

  const effectiveTimeout = timeoutMs || (kind === 'local' ? DEFAULT_LOCAL_TIMEOUT_MS : DEFAULT_REMOTE_TIMEOUT_MS);

  const runExec = exec || (kind === 'local'
    ? (args) => defaultLocalExec(args, { cwd, timeoutMs: effectiveTimeout })
    : (command, remoteOpts) => defaultRunRemoteCommand(alias, command, {
        timeoutMs: effectiveTimeout,
        maxStdoutBytes: remoteOpts && remoteOpts.maxStdoutBytes,
      }));

  // remoteOpts (maxStdoutBytes) matter only for the remote transport — see .ai/contexts/changes-view.md ("Remote transport stdout cap")
  function invoke(args, remoteOpts) {
    const fullArgs = buildGitArgs(args);
    return kind === 'local' ? runExec(fullArgs) : runExec(buildRemoteGitCommand(cwd, fullArgs), remoteOpts);
  }

  function cwdRefusal() {
    return kind === 'local' ? missingCwdError(cwd, fsOps || DEFAULT_FS_OPS) : null;
  }

  // Only positive evidence withdraws the panel — see .ai/contexts/changes-view.md ("Not a repository")
  async function isWorkTree() {
    let probe;
    try {
      probe = await invoke(['rev-parse', '--is-inside-work-tree']);
    } catch (err) {
      return { ok: false, error: cwdRefusal() || err.message };
    }
    if (probe.code === 0) {
      const answer = String(probe.stdout || '').trim();
      if (answer === 'true' || answer === 'false') return { ok: true, isRepo: answer === 'true' };
      return { ok: false, error: 'git rev-parse gave no answer' };
    }
    if (probe.code === EXEC_FAILED_CODE) return { ok: false, error: cwdRefusal() || firstError(probe) };
    if (probe.code !== GIT_FATAL_EXIT_CODE) return { ok: false, error: firstError(probe) };
    const gone = cwdRefusal();
    if (gone) return { ok: false, error: gone };
    const corroborated = kind === 'local'
      ? gitEntryAtOrAbove(cwd, fsOps || DEFAULT_FS_OPS)
      : null;
    if (corroborated === false) return { ok: true, isRepo: false };
    return { ok: false, error: firstError(probe) };
  }

  async function cwdHasNoWorkTree() {
    const probe = await isWorkTree();
    return probe.ok === true && probe.isRepo === false;
  }

  async function status() {
    let results;
    try {
      results = await Promise.all([
        invoke(['status', '--porcelain=v2', '--branch', '-uall', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
        invoke(['diff', '--numstat', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
        invoke(['diff', '--cached', '--numstat', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
      ]);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    let [st] = results;
    const [, unstagedNum, stagedNum] = results;
    const failed = results.filter((r) => r.code !== 0);
    if (failed.length > 0 && !failed.every(isStdoutCapFailure) && await cwdHasNoWorkTree()) {
      return { ok: false, reason: NOT_A_REPO_REASON, error: 'not a git repository' };
    }
    if (unstagedNum.code !== 0) return { ok: false, error: firstError(unstagedNum) };
    if (stagedNum.code !== 0) return { ok: false, error: firstError(stagedNum) };

    // A repo too large for -uall falls back to git's collapsed listing — see .ai/contexts/changes-view.md ("Untracked files")
    let untrackedCollapsed = false;
    if (st.code !== 0) {
      if (!isStdoutCapFailure(st)) return { ok: false, error: firstError(st) };
      let fallback;
      try {
        fallback = await invoke(['status', '--porcelain=v2', '--branch', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES });
      } catch {
        return { ok: false, error: firstError(st) };
      }
      if (fallback.code !== 0) return { ok: false, error: firstError(st) };
      st = fallback;
      untrackedCollapsed = true;
    }

    const parsedStatus = parseStatusPorcelainV2(st.stdout);
    const numstatUnstaged = parseNumstat(unstagedNum.stdout);
    const numstatStaged = parseNumstat(stagedNum.stdout);
    return { ok: true, ...mergeChanges(parsedStatus, numstatStaged, numstatUnstaged), untrackedCollapsed };
  }

  // The operand git receives is the guard's own, never the caller's — see .ai/contexts/changes-view.md ("Untracked files")
  async function resolveUntrackedOperand(filePath) {
    if (!isSafeNoIndexPath(filePath)) return { ok: false, error: 'invalid path' };

    if (kind === 'local') {
      const operand = resolveLocalNoIndexOperand(cwd, filePath, fsOps || DEFAULT_FS_OPS);
      return operand ? { ok: true, operand } : { ok: false, error: 'invalid path' };
    }

    let listed;
    try {
      listed = await invoke(['ls-files', '--others', '--exclude-standard', '-z', '--', filePath], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (listed.code !== 0) return { ok: false, error: firstError(listed) };
    const operand = String(listed.stdout || '').split('\0')[0];
    return operand === filePath ? { ok: true, operand } : { ok: false, error: 'invalid path' };
  }

  // `--no-index` exits 1 on a difference — see .ai/contexts/changes-view.md ("Untracked files")
  async function untrackedDiff(filePath) {
    const contained = await resolveUntrackedOperand(filePath);
    if (!contained.ok) return { ok: false, error: contained.error };

    let result;
    try {
      result = await invoke(['-c', 'core.quotepath=false', 'diff', '--no-index', '--', NO_INDEX_EMPTY_SIDE, contained.operand],
        { maxStdoutBytes: DIFF_MAX_STDOUT_BYTES });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (result.code !== 0 && result.code !== 1) return { ok: false, error: firstError(result) };
    const stdout = result.stdout || '';
    if (!stdout && (result.stderr || '').trim()) return { ok: false, error: firstError(result) };
    if (!diffHeaderNamesPath(stdout, contained.operand)) return { ok: false, error: 'invalid path' };

    const { content, truncated } = truncateDiffContent(stdout, MAX_DIFF_BYTES);
    const added = truncated ? null : countNewFileDiffAdditions(content);
    return { ok: true, content, truncated, added, deleted: added === null ? null : 0 };
  }

  async function diff(filePath, opts = {}) {
    if (opts.untracked) return untrackedDiff(filePath);
    if (!isSafeGitPath(filePath)) return { ok: false, error: 'invalid path' };
    const staged = !!opts.staged;
    const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];

    let result;
    try {
      result = await invoke(args, { maxStdoutBytes: DIFF_MAX_STDOUT_BYTES });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (result.code !== 0) return { ok: false, error: firstError(result) };

    const { content, truncated } = truncateDiffContent(result.stdout || '', MAX_DIFF_BYTES);
    return { ok: true, content, truncated };
  }

  return { status, diff, isWorkTree, kind, cwd, alias: alias || null };
}

module.exports = {
  createGitChangesRunner,
  buildRemoteGitCommand,
  buildGitArgs,
  localGitEnv,
  truncateDiffContent,
  boundErrorMessage,
  shQuote,
  isSafeCwd,
  isSafeGitPath,
  isSafeNoIndexPath,
  resolveLocalNoIndexOperand,
  gitEntryAtOrAbove,
  missingCwdError,
  MAX_DIFF_BYTES,
  STATUS_MAX_STDOUT_BYTES,
  DIFF_MAX_STDOUT_BYTES,
  MAX_ERROR_LINES,
  MAX_ERROR_CHARS,
  NOT_A_REPO_REASON,
};
