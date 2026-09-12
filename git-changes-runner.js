// git-changes-runner.js — runs the git commands, local or remote — see .ai/contexts/changes-view.md

'use strict';

const { execFile } = require('child_process');
const { defaultRunRemoteCommand } = require('./remote-attach');
const { parseStatusPorcelainV2, parseNumstat, mergeChanges } = require('./git-changes');

const DEFAULT_LOCAL_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 20_000;
const MAX_DIFF_BYTES = 512 * 1024;
const LOCAL_MAX_BUFFER = 20 * 1024 * 1024;

// Denylist, not allowlist — see .ai/contexts/changes-view.md ("Quoting rule")
function isSafeShellArg(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 4096 && !/[\x00\n\r]/.test(s);
}

function isSafeCwd(cwd) {
  return isSafeShellArg(cwd);
}

function isSafeGitPath(p) {
  if (!isSafeShellArg(p)) return false;
  if (p.includes('..')) return false;
  return true;
}

// POSIX single-quote escaping — see .ai/contexts/changes-view.md ("Quoting rule")
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildRemoteGitCommand(cwd, args) {
  return ['git', '-C', shQuote(cwd), ...args.map(shQuote)].join(' ');
}

function defaultLocalExec(args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: LOCAL_MAX_BUFFER, windowsHide: true },
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
    : (command) => defaultRunRemoteCommand(alias, command, { timeoutMs: effectiveTimeout }));

  function invoke(args) {
    return kind === 'local' ? runExec(args) : runExec(buildRemoteGitCommand(cwd, args));
  }

  async function status() {
    let results;
    try {
      results = await Promise.all([
        invoke(['status', '--porcelain=v2', '--branch']),
        invoke(['diff', '--numstat']),
        invoke(['diff', '--cached', '--numstat']),
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
      result = await invoke(args);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (result.code !== 0) return { ok: false, error: firstError(result) };

    const content = result.stdout || '';
    const truncated = content.length > MAX_DIFF_BYTES;
    return { ok: true, content: truncated ? content.slice(0, MAX_DIFF_BYTES) : content, truncated };
  }

  return { status, diff, kind, cwd, alias: alias || null };
}

module.exports = {
  createGitChangesRunner,
  buildRemoteGitCommand,
  shQuote,
  isSafeCwd,
  isSafeGitPath,
  MAX_DIFF_BYTES,
};
