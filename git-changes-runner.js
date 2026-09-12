// git-changes-runner.js — runs the git commands, local or remote — see .ai/contexts/changes-view.md

'use strict';

const { execFile } = require('child_process');
const { defaultRunRemoteCommand } = require('./remote-attach');
const { parseStatusPorcelainV2, parseNumstat, mergeChanges } = require('./git-changes');

const DEFAULT_LOCAL_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 20_000;
const MAX_DIFF_BYTES = 512 * 1024;
const LOCAL_MAX_BUFFER = 20 * 1024 * 1024;
// Remote stdout caps — see .ai/contexts/changes-view.md ("Remote transport stdout cap").
const STATUS_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const DIFF_STDOUT_SLACK_BYTES = 64 * 1024;
const DIFF_MAX_STDOUT_BYTES = MAX_DIFF_BYTES + DIFF_STDOUT_SLACK_BYTES;

// Denylist, not allowlist — see .ai/contexts/changes-view.md ("Quoting rule")
function isSafeShellArg(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 4096 && !/[\x00\n\r]/.test(s);
}

function isSafeCwd(cwd) {
  return isSafeShellArg(cwd);
}

// Denylist plus a leading-':' shape check — see .ai/contexts/changes-view.md ("Quoting rule").
function isSafeGitPath(p) {
  if (!isSafeShellArg(p)) return false;
  if (p.includes('..')) return false;
  if (p[0] === ':') return false;
  return true;
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

function firstError(result) {
  return (result.stderr || '').trim() || `git exited with code ${result.code}`;
}

// {kind, cwd, alias, exec, timeoutMs} — see .ai/contexts/changes-view.md ("Runner interface")
function createGitChangesRunner({ kind, cwd, alias, exec, timeoutMs } = {}) {
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

  async function status() {
    let results;
    try {
      results = await Promise.all([
        invoke(['status', '--porcelain=v2', '--branch', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
        invoke(['diff', '--numstat', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
        invoke(['diff', '--cached', '--numstat', '-z'], { maxStdoutBytes: STATUS_MAX_STDOUT_BYTES }),
      ]);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const [st, unstagedNum, stagedNum] = results;
    if (st.code !== 0) return { ok: false, error: firstError(st) };
    if (unstagedNum.code !== 0) return { ok: false, error: firstError(unstagedNum) };
    if (stagedNum.code !== 0) return { ok: false, error: firstError(stagedNum) };

    const parsedStatus = parseStatusPorcelainV2(st.stdout);
    const numstatUnstaged = parseNumstat(unstagedNum.stdout);
    const numstatStaged = parseNumstat(stagedNum.stdout);
    return { ok: true, ...mergeChanges(parsedStatus, numstatStaged, numstatUnstaged) };
  }

  async function diff(path, opts = {}) {
    if (!isSafeGitPath(path)) return { ok: false, error: 'invalid path' };
    const staged = !!opts.staged;
    const args = staged ? ['diff', '--cached', '--', path] : ['diff', '--', path];

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

  return { status, diff, kind, cwd, alias: alias || null };
}

module.exports = {
  createGitChangesRunner,
  buildRemoteGitCommand,
  buildGitArgs,
  truncateDiffContent,
  shQuote,
  isSafeCwd,
  isSafeGitPath,
  MAX_DIFF_BYTES,
  STATUS_MAX_STDOUT_BYTES,
  DIFF_MAX_STDOUT_BYTES,
};
