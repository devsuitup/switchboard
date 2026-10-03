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
async function leafSymlinkIsDiffable(resolved, fsOps) {
  let target;
  try {
    target = await fsOps.stat(resolved);
  } catch {
    return true;
  }
  return target.isFile();
}

async function resolveParentDir(root, dir, fsOps, pathOps) {
  const parent = await fsOps.realpath(dir);
  const inside = !!parent && isInsideRoot(root, parent, pathOps);
  return { parent, inside, rel: inside ? pathOps.relative(root, parent) : null };
}

function cached(cache, key, compute) {
  if (!cache) return compute();
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key);
}

// Containment for a --no-index operand; `cache` shares the per-directory work across one batch — see .ai/contexts/changes-view.md ("Untracked files")
async function resolveLocalNoIndexTarget(root, filePath, fsOps = ASYNC_FS_OPS, pathOps = path, cache = null) {
  if (!isSafeNoIndexPath(filePath)) return null;

  try {
    const realRoot = await cached(cache, '\0root', () => fsOps.realpath(root));
    if (!realRoot) return null;
    const absolute = pathOps.resolve(realRoot, filePath);
    const dirname = pathOps.dirname(absolute);
    const dir = await cached(cache, dirname, () => resolveParentDir(realRoot, dirname, fsOps, pathOps));
    if (!dir.inside) return null;

    const base = pathOps.basename(absolute);
    const resolved = pathOps.join(dir.parent, base);
    const stat = await fsOps.lstat(resolved);
    if (!stat.isFile() && !stat.isSymbolicLink()) return null;
    if (stat.isSymbolicLink() && !(await leafSymlinkIsDiffable(resolved, fsOps))) return null;

    const operand = toGitPath(dir.rel ? pathOps.join(dir.rel, base) : base, pathOps);
    return isSafeNoIndexPath(operand) ? { operand, resolved, stat } : null;
  } catch {
    return null;
  }
}

async function resolveLocalNoIndexOperand(root, filePath, fsOps = ASYNC_FS_OPS, pathOps = path) {
  const target = await resolveLocalNoIndexTarget(root, filePath, fsOps, pathOps);
  return target ? target.operand : null;
}

const PROC_FD_DIR = '/proc/self/fd';

// The opened file is the one containment resolved — see .ai/contexts/changes-view.md ("Untracked line counts")
async function openedFileIs(handle, resolved, expected, pathOps = path) {
  const st = await handle.stat({ bigint: true });
  if (!st.isFile()) return null;
  if (String(st.dev) !== String(expected.dev) || String(st.ino) !== String(expected.ino)) return null;
  let opened = null;
  try {
    opened = await fs.promises.readlink(`${PROC_FD_DIR}/${handle.fd}`);
  } catch {
    opened = null;
  }
  if (opened !== null) return opened === resolved ? st : null;
  const parent = pathOps.dirname(resolved);
  return (await fs.promises.realpath(parent)) === parent ? st : null;
}

// Never blocks on a FIFO, never reads past the cap, never reads a file other than `resolved` — see .ai/contexts/changes-view.md ("Untracked line counts")
async function readRegularFileUpTo(resolved, maxBytes, expected) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fs.promises.open(resolved, flags);
  try {
    const st = await openedFileIs(handle, resolved, expected);
    if (!st) return null;
    const buf = Buffer.allocUnsafe(Math.min(Number(st.size), maxBytes) + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await handle.read(buf, n, buf.length - n, null);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return buf.subarray(0, n);
  } finally {
    await handle.close();
  }
}

// Async fs seam for containment and the count pass — see .ai/contexts/changes-view.md ("Untracked line counts")
const ASYNC_FS_OPS = {
  realpath: (p) => fs.promises.realpath(p),
  lstat: (p) => fs.promises.lstat(p, { bigint: true }),
  stat: (p) => fs.promises.stat(p),
  readUpTo: readRegularFileUpTo,
};

// Bounds on the local untracked count pass — see .ai/contexts/changes-view.md ("Untracked line counts")
const UNTRACKED_COUNT_LIMITS = Object.freeze({
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  timeBudgetMs: 1000,
  concurrency: 2,
});

// Slots held by count-pass workers, across every pass in the process — see .ai/contexts/changes-view.md ("Untracked line counts")
let countSlotsInUse = 0;
const countSlotWaiters = [];

function untrackedCountSlotsInUse() {
  return countSlotsInUse;
}

function untrackedCountSlotWaiters() {
  return countSlotWaiters.length;
}

// A pass with no free slot queues for one — see .ai/contexts/changes-view.md ("Untracked line counts")
function acquireCountSlot(capacity) {
  if (countSlotsInUse < capacity) {
    countSlotsInUse += 1;
    return { granted: Promise.resolve(true), cancel() {} };
  }
  let entry = null;
  const granted = new Promise((resolve) => {
    entry = { resolve, capacity };
    countSlotWaiters.push(entry);
  });
  return {
    granted,
    cancel() {
      const i = countSlotWaiters.indexOf(entry);
      if (i === -1) return;
      countSlotWaiters.splice(i, 1);
      entry.resolve(false);
    },
  };
}

function releaseCountSlot() {
  countSlotsInUse -= 1;
  const i = countSlotWaiters.findIndex((w) => countSlotsInUse < w.capacity);
  if (i === -1) return;
  const [waiter] = countSlotWaiters.splice(i, 1);
  countSlotsInUse += 1;
  waiter.resolve(true);
}

async function measureOneUntracked(root, p, ctx) {
  const target = await resolveLocalNoIndexTarget(root, p, ctx.fsOps, path, ctx.cache);
  if (!target) return { countStatus: COUNT_STATUS.UNAVAILABLE };
  if (target.stat.isSymbolicLink()) return { added: 1, deleted: 0 };
  const size = Number(target.stat.size);
  if (size > ctx.limits.maxFileBytes) return { countStatus: COUNT_STATUS.TOO_LARGE };
  if (size > ctx.budget) return { countStatus: COUNT_STATUS.OVER_CAP };
  ctx.budget -= size;
  let buf = null;
  try {
    buf = await ctx.fsOps.readUpTo(target.resolved, ctx.limits.maxFileBytes, target.stat);
  } catch {
    buf = null;
  }
  if (!buf) return { countStatus: COUNT_STATUS.UNAVAILABLE };
  ctx.budget -= buf.length - size;
  if (buf.length > ctx.limits.maxFileBytes) return { countStatus: COUNT_STATUS.TOO_LARGE };
  return { operand: target.operand, ...countBufferLines(buf) };
}

// Off the main thread's critical path: async, slot-bounded, time-boxed — see .ai/contexts/changes-view.md ("Untracked line counts")
async function measureUntrackedLocal(root, paths, fsOps = ASYNC_FS_OPS, limits = UNTRACKED_COUNT_LIMITS) {
  const candidates = paths.slice(0, limits.maxFiles);
  const ctx = { fsOps: { ...ASYNC_FS_OPS, ...fsOps }, limits, cache: new Map(), budget: limits.maxTotalBytes };
  const results = new Map();
  const measured = [];
  let next = 0;
  let open = true;
  const deadline = Date.now() + limits.timeBudgetMs;

  const pending = new Set();
  const hasWork = () => open && next < candidates.length && Date.now() < deadline;

  // One slot per file, so passes queued together interleave — see .ai/contexts/changes-view.md ("Untracked line counts")
  async function worker() {
    while (hasWork()) {
      const slot = acquireCountSlot(limits.concurrency);
      pending.add(slot);
      const granted = await slot.granted;
      pending.delete(slot);
      if (!granted) return;
      let p;
      let outcome;
      try {
        if (!hasWork()) return;
        p = candidates[next++];
        outcome = await measureOneUntracked(root, p, ctx);
      } catch {
        outcome = { countStatus: COUNT_STATUS.UNAVAILABLE };
      } finally {
        releaseCountSlot();
      }
      if (!open) return;
      if (outcome.operand !== undefined) measured.push({ path: p, ...outcome });
      else results.set(p, outcome);
    }
  }

  const workers = Math.min(limits.concurrency, candidates.length);
  let timer = null;
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, limits.timeBudgetMs); });
  await Promise.race([Promise.all(Array.from({ length: workers }, worker)), expired]);
  clearTimeout(timer);
  open = false;
  for (const slot of pending) slot.cancel();
  return { results, measured };
}

// A `diff` attribute overrides the content sniff, as it does for git's own diff — see .ai/contexts/changes-view.md ("Untracked line counts")
function settleUntrackedCounts(results, measured, diffAttrs, binaryDrivers = new Set()) {
  for (const m of measured) {
    const attr = diffAttrs.get(m.operand);
    const driverBinary = typeof attr === 'string' && binaryDrivers.has(attr);
    const binary = attr === 'unset' || driverBinary || (attr !== 'set' && m.hasNul);
    results.set(m.path, binary ? { countStatus: COUNT_STATUS.BINARY } : { added: m.lines, deleted: 0 });
  }
  return results;
}

const DIFF_ATTR_KEYWORDS = new Set(['set', 'unset', 'unspecified']);

// `git config -z --get-regexp` output → the drivers whose `binary` is true
function parseBinaryDrivers(text) {
  const drivers = new Set();
  for (const record of String(text || '').split('\0')) {
    const nl = record.indexOf('\n');
    if (nl === -1) continue;
    const key = record.slice(0, nl);
    const value = record.slice(nl + 1).trim().toLowerCase();
    const m = /^diff\.(.+)\.binary$/s.exec(key);
    if (m && ['true', 'yes', 'on', '1'].includes(value)) drivers.add(m[1]);
  }
  return drivers;
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
function buildGitArgs(args, opts) {
  const hardened = opts && opts.hardened ? ['-c', 'core.fsmonitor=false'] : [];
  return ['--literal-pathspecs', ...hardened, ...args];
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

// A transport failure often says nothing on stderr — see .ai/contexts/changes-view.md ("Paths are relative to the repository root")
function firstError(result) {
  const said = boundErrorMessage(result.stderr);
  if (said) return said;
  if (result.code === EXEC_FAILED_CODE) return 'git timed out or could not be run';
  if (result.code === SSH_FAILED_CODE) return 'the ssh connection failed';
  return `git exited with code ${result.code}`;
}

// The two stdout-cap overruns: the remote transport's own, and execFile's maxBuffer — see .ai/contexts/changes-view.md ("Untracked files")
// ssh's own exit code, or a spawn that failed or timed out: nothing git said
const SSH_FAILED_CODE = 255;
function isTransportFailure(result) {
  return !!result && (result.code === SSH_FAILED_CODE || result.code === EXEC_FAILED_CODE);
}

function isStdoutCapFailure(result) {
  const stderr = (result && result.stderr) || '';
  return /stdout exceeded \d+ bytes/.test(stderr) || /maxBuffer length exceeded/i.test(stderr);
}

// {kind, cwd, alias, exec, timeoutMs, fsOps, countLimits} — see .ai/contexts/changes-view.md ("Runner interface")
function createGitChangesRunner({ kind, cwd, alias, exec, timeoutMs, fsOps, countLimits, hardened } = {}) {
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
    ? (args, localOpts = {}) => defaultLocalExec(args, { cwd: localOpts.cwd || cwd, timeoutMs: effectiveTimeout, input: localOpts.input })
    : (command, remoteOpts) => defaultRunRemoteCommand(alias, command, {
        timeoutMs: effectiveTimeout,
        maxStdoutBytes: remoteOpts && remoteOpts.maxStdoutBytes,
      }));

  const containmentFs = fsOps || ASYNC_FS_OPS;

  // opts.at runs the command in that directory instead of the session cwd; maxStdoutBytes matters only remotely — see .ai/contexts/changes-view.md ("Remote transport stdout cap")
  function invoke(args, opts = {}) {
    const fullArgs = buildGitArgs(args, { hardened: !!hardened && kind === 'local' });
    const at = opts.at || cwd;
    if (kind === 'local') {
      const localOpts = {};
      if (opts.at) localOpts.cwd = opts.at;
      if (opts.input !== undefined) localOpts.input = opts.input;
      return runExec(fullArgs, localOpts);
    }
    return runExec(buildRemoteGitCommand(at, fullArgs), { maxStdoutBytes: opts.maxStdoutBytes });
  }

  // Status paths are relative to the repository root, not the session cwd — see .ai/contexts/changes-view.md ("Paths are relative to the repository root")
  let rootLookup = null;
  // {root, failure}: failure is the transport's own result, never retried at the cwd — see .ai/contexts/changes-view.md ("Paths are relative to the repository root")
  function lookUpRoot() {
    if (!rootLookup) {
      rootLookup = (async () => {
        let result;
        try {
          result = await invoke(['rev-parse', '--show-toplevel']);
        } catch (err) {
          return { root: null, failure: { code: EXEC_FAILED_CODE, stdout: '', stderr: err.message } };
        }
        if (isTransportFailure(result)) return { root: null, failure: result };
        if (result.code !== 0) return { root: null, failure: null };
        const top = String(result.stdout || '').replace(/\r?\n$/, '');
        const absolute = kind === 'local' ? path.isAbsolute(top) : top.startsWith('/');
        return { root: isSafeCwd(top) && absolute ? top : null, failure: null };
      })();
    }
    return rootLookup;
  }

  async function repoRoot() {
    return (await lookUpRoot()).root;
  }

  async function gitAtRoot(args, opts = {}) {
    const { root, failure } = await lookUpRoot();
    if (failure) return failure;
    return invoke(args, { ...opts, at: root || cwd });
  }

  async function diffAttributes(root, operands) {
    if (operands.length === 0) return { attrs: new Map(), binaryDrivers: new Set() };
    let attrs = new Map();
    try {
      const result = await invoke(['check-attr', '-z', '--stdin', 'diff'], { at: root, input: operands.join('\0') + '\0' });
      if (result.code === 0) attrs = parseCheckAttr(result.stdout);
    } catch {
      attrs = new Map();
    }
    const drivers = [...new Set(attrs.values())].filter((v) => !DIFF_ATTR_KEYWORDS.has(v));
    if (drivers.length === 0) return { attrs, binaryDrivers: new Set() };
    try {
      const config = await invoke(['config', '-z', '--get-regexp', '^diff\\..*\\.binary$'], { at: root });
      return { attrs, binaryDrivers: config.code === 0 ? parseBinaryDrivers(config.stdout) : new Set() };
    } catch {
      return { attrs, binaryDrivers: new Set() };
    }
  }

  // {counts, uncountedStatus} for mergeChanges — see .ai/contexts/changes-view.md ("Untracked line counts")
  async function untrackedCounts(files, collapsed) {
    if (kind !== 'local') return { counts: null, uncountedStatus: COUNT_STATUS.ON_OPEN };
    if (collapsed) return { counts: null, uncountedStatus: COUNT_STATUS.COLLAPSED };
    const paths = files.filter((f) => f.untracked).map((f) => f.path);
    if (paths.length === 0) return { counts: null, uncountedStatus: COUNT_STATUS.OVER_CAP };
    const root = await repoRoot();
    if (!root) return { counts: null, uncountedStatus: COUNT_STATUS.UNAVAILABLE };
    const { results, measured } = await measureUntrackedLocal(root, paths, containmentFs, countLimits || UNTRACKED_COUNT_LIMITS);
    const { attrs, binaryDrivers } = await diffAttributes(root, measured.map((m) => m.operand));
    return { counts: settleUntrackedCounts(results, measured, attrs, binaryDrivers), uncountedStatus: COUNT_STATUS.OVER_CAP };
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
      // see .ai/contexts/changes-view.md ("Local reads run one at a time")
      const calls = [
        () => invoke(['status', '--porcelain=v2', '--branch', '-uall', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
        () => invoke(['diff', '--numstat', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
        () => invoke(['diff', '--cached', '--numstat', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
      ];
      if (kind === 'local') {
        results = [];
        for (const call of calls) results.push(await call());
      } else {
        results = await Promise.all(calls.map((call) => call()));
      }
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
  async function resolveUntrackedOperand(filePath, root) {
    if (!isSafeNoIndexPath(filePath)) return { ok: false, error: 'invalid path' };

    if (kind === 'local') {
      const operand = await resolveLocalNoIndexOperand(root, filePath, containmentFs);
      return operand ? { ok: true, operand } : { ok: false, error: 'invalid path' };
    }

    let listed;
    try {
      listed = await invoke(['ls-files', '--others', '--exclude-standard', '-z', '--', filePath], { at: root, maxStdoutBytes: STATUS_MAX_STDOUT_BYTES });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (listed.code !== 0) return { ok: false, error: firstError(listed) };
    const operand = String(listed.stdout || '').split('\0')[0];
    return operand === filePath ? { ok: true, operand } : { ok: false, error: 'invalid path' };
  }

  // `--no-index` exits 1 on a difference — see .ai/contexts/changes-view.md ("Untracked files")
  async function untrackedDiff(filePath) {
    if (!isSafeNoIndexPath(filePath)) return { ok: false, error: 'invalid path' };
    const lookup = await lookUpRoot();
    if (lookup.failure) return { ok: false, error: firstError(lookup.failure) };
    const root = lookup.root || cwd;
    const contained = await resolveUntrackedOperand(filePath, root);
    if (!contained.ok) return { ok: false, error: contained.error };

    let result;
    try {
      result = await invoke(['-c', 'core.quotepath=false', 'diff', '--no-index', '--', NO_INDEX_EMPTY_SIDE, contained.operand],
        { at: root, maxStdoutBytes: DIFF_MAX_STDOUT_BYTES });
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
      result = await gitAtRoot(args, { maxStdoutBytes: DIFF_MAX_STDOUT_BYTES });
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
  untrackedCountSlotsInUse,
  untrackedCountSlotWaiters,
  parseBinaryDrivers,
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
