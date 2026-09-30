// git-changes-runner.js — runs the git commands, local or remote — see .ai/contexts/changes-view.md

'use strict';

const { runToExit } = require('./run-to-exit');
const fs = require('fs');
const path = require('path');
const { defaultRunRemoteCommand } = require('./remote-attach');
const {
  parseStatusPorcelainV2,
  parseNumstat,
  mergeChanges,
  countNewFileDiffAdditions,
  countBufferLines,
  parseCheckAttr,
  diffHeaderNamesPath,
  COUNT_STATUS,
} = require('./git-changes');

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

function resolveParentDir(root, dir, fsOps, pathOps) {
  const parent = fsOps.realpath(dir);
  const inside = !!parent && isInsideRoot(root, parent, pathOps);
  return { parent, inside, rel: inside ? pathOps.relative(root, parent) : null };
}

function cached(cache, key, compute) {
  if (!cache) return compute();
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key);
}

// Containment for a --no-index operand; `cache` shares the per-directory work across one batch — see .ai/contexts/changes-view.md ("Untracked files")
function resolveLocalNoIndexTarget(cwd, filePath, fsOps = DEFAULT_FS_OPS, pathOps = path, cache = null) {
  if (!isSafeNoIndexPath(filePath)) return null;

  try {
    const root = cached(cache, '\0root', () => fsOps.realpath(cwd));
    if (!root) return null;
    const absolute = pathOps.resolve(root, filePath);
    const dir = cached(cache, pathOps.dirname(absolute), () => resolveParentDir(root, pathOps.dirname(absolute), fsOps, pathOps));
    if (!dir.inside) return null;

    const base = pathOps.basename(absolute);
    const resolved = pathOps.join(dir.parent, base);
    const stat = fsOps.lstat(resolved);
    if (!stat.isFile() && !stat.isSymbolicLink()) return null;
    if (stat.isSymbolicLink() && !leafSymlinkIsDiffable(resolved, fsOps)) return null;

    const operand = toGitPath(dir.rel ? pathOps.join(dir.rel, base) : base, pathOps);
    return isSafeNoIndexPath(operand) ? { operand, resolved, stat } : null;
  } catch {
    return null;
  }
}

function resolveLocalNoIndexOperand(cwd, filePath, fsOps = DEFAULT_FS_OPS, pathOps = path) {
  const target = resolveLocalNoIndexTarget(cwd, filePath, fsOps, pathOps);
  return target ? target.operand : null;
}

// Never blocks on a FIFO, never follows a leaf swapped for a symlink — see .ai/contexts/changes-view.md ("Untracked line counts")
function readRegularFileUpTo(p, maxBytes) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(p, flags);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.allocUnsafe(Math.min(st.size, maxBytes) + 1);
    let n = 0;
    while (n < buf.length) {
      const read = fs.readSync(fd, buf, n, buf.length - n, null);
      if (read === 0) break;
      n += read;
    }
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Bounds on the local untracked count pass — see .ai/contexts/changes-view.md ("Untracked line counts")
const UNTRACKED_COUNT_MAX_FILES = 500;
const UNTRACKED_COUNT_MAX_FILE_BYTES = 1024 * 1024;
const UNTRACKED_COUNT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const UNTRACKED_COUNT_LIMITS = Object.freeze({
  maxFiles: UNTRACKED_COUNT_MAX_FILES,
  maxFileBytes: UNTRACKED_COUNT_MAX_FILE_BYTES,
  maxTotalBytes: UNTRACKED_COUNT_MAX_TOTAL_BYTES,
});

// The sync half of the local count: containment, then a capped read — see .ai/contexts/changes-view.md ("Untracked line counts")
function measureUntrackedLocal(cwd, paths, fsOps = DEFAULT_FS_OPS, limits = UNTRACKED_COUNT_LIMITS) {
  const results = new Map();
  const measured = [];
  const containmentCache = new Map();
  const readUpTo = fsOps.readUpTo || readRegularFileUpTo;
  let budget = limits.maxTotalBytes;

  paths.slice(0, limits.maxFiles).forEach((p) => {
    const target = resolveLocalNoIndexTarget(cwd, p, fsOps, path, containmentCache);
    if (!target) {
      results.set(p, { countStatus: COUNT_STATUS.UNAVAILABLE });
      return;
    }
    if (target.stat.isSymbolicLink()) {
      results.set(p, { added: 1, deleted: 0 });
      return;
    }
    if (target.stat.size > limits.maxFileBytes) {
      results.set(p, { countStatus: COUNT_STATUS.TOO_LARGE });
      return;
    }
    if (target.stat.size > budget) {
      results.set(p, { countStatus: COUNT_STATUS.OVER_CAP });
      return;
    }
    let buf;
    try {
      buf = readUpTo(target.resolved, limits.maxFileBytes);
    } catch {
      buf = null;
    }
    if (!buf) {
      results.set(p, { countStatus: COUNT_STATUS.UNAVAILABLE });
      return;
    }
    if (buf.length > limits.maxFileBytes) {
      results.set(p, { countStatus: COUNT_STATUS.TOO_LARGE });
      return;
    }
    budget -= buf.length;
    measured.push({ path: p, operand: target.operand, ...countBufferLines(buf) });
  });

  return { results, measured };
}

// A `diff` attribute overrides the content sniff, as it does for git's own diff — see .ai/contexts/changes-view.md ("Untracked line counts")
function settleUntrackedCounts(results, measured, diffAttrs) {
  for (const m of measured) {
    const attr = diffAttrs.get(m.operand);
    const binary = attr === 'unset' || (attr !== 'set' && m.hasNul);
    results.set(m.path, binary ? { countStatus: COUNT_STATUS.BINARY } : { added: m.lines, deleted: 0 });
  }
  return results;
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

async function defaultLocalExec(args, { cwd, timeoutMs, input }) {
  const result = await runToExit('git', args, { cwd, env: localGitEnv(), timeoutMs, maxBuffer: LOCAL_MAX_BUFFER, input });
  const stdout = result.stdout.toString('utf8');
  if (result.code === 0) return { code: 0, stdout, stderr: result.stderr };
  return { code: result.code, stdout, stderr: result.stderr || result.message };
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
    ? (args, localOpts) => defaultLocalExec(args, { cwd, timeoutMs: effectiveTimeout, input: localOpts && localOpts.input })
    : (command, remoteOpts) => defaultRunRemoteCommand(alias, command, {
        timeoutMs: effectiveTimeout,
        maxStdoutBytes: remoteOpts && remoteOpts.maxStdoutBytes,
      }));

  // remoteOpts (maxStdoutBytes) matter only for the remote transport — see .ai/contexts/changes-view.md ("Remote transport stdout cap")
  function invoke(args, remoteOpts) {
    const fullArgs = buildGitArgs(args);
    return kind === 'local' ? runExec(fullArgs) : runExec(buildRemoteGitCommand(cwd, fullArgs), remoteOpts);
  }

  function invokeLocalWithInput(args, input) {
    return runExec(buildGitArgs(args), { input });
  }

  async function diffAttributes(operands) {
    if (operands.length === 0) return new Map();
    try {
      const result = await invokeLocalWithInput(['check-attr', '-z', '--stdin', 'diff'], operands.join('\0') + '\0');
      return result.code === 0 ? parseCheckAttr(result.stdout) : new Map();
    } catch {
      return new Map();
    }
  }

  // {counts, uncountedStatus} for mergeChanges — see .ai/contexts/changes-view.md ("Untracked line counts")
  async function untrackedCounts(files, collapsed) {
    if (kind !== 'local') return { counts: null, uncountedStatus: COUNT_STATUS.ON_OPEN };
    if (collapsed) return { counts: null, uncountedStatus: COUNT_STATUS.OVER_CAP };
    const paths = files.filter((f) => f.untracked).map((f) => f.path);
    const { results, measured } = measureUntrackedLocal(cwd, paths, fsOps || DEFAULT_FS_OPS);
    const attrs = await diffAttributes(measured.map((m) => m.operand));
    return { counts: settleUntrackedCounts(results, measured, attrs), uncountedStatus: COUNT_STATUS.OVER_CAP };
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
    const { counts, uncountedStatus } = await untrackedCounts(parsedStatus.files, untrackedCollapsed);
    return { ok: true, ...mergeChanges(parsedStatus, numstatStaged, numstatUnstaged, counts, uncountedStatus), untrackedCollapsed };
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
    const countStatus = added !== null ? null : (truncated ? COUNT_STATUS.TOO_LARGE : COUNT_STATUS.BINARY);
    return { ok: true, content, truncated, added, deleted: added === null ? null : 0, countStatus };
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
  measureUntrackedLocal,
  readRegularFileUpTo,
  UNTRACKED_COUNT_LIMITS,
  gitEntryAtOrAbove,
  missingCwdError,
  MAX_DIFF_BYTES,
  STATUS_MAX_STDOUT_BYTES,
  DIFF_MAX_STDOUT_BYTES,
  MAX_ERROR_LINES,
  MAX_ERROR_CHARS,
  NOT_A_REPO_REASON,
};
