// git-changes-file.js — content pair and write target for the editable Changes panel — see .ai/contexts/changes-view.md

'use strict';

const realFs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { localGitEnv } = require('./git-changes-runner');
const { resolveOnDisk, isInsideDir } = require('./resolve-path-on-disk');
const { isSensitivePath } = require('./ipc-path-validator');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PATH_LENGTH = 4096;
const TOPLEVEL_MAX_BUFFER = 64 * 1024;

// Guards for a repo-relative path from the renderer — see .ai/contexts/changes-view.md ("Editing a changed file")
function isSafeRepoRelativePath(p) {
  if (typeof p !== 'string' || p === '' || p.length > MAX_PATH_LENGTH) return false;
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  if (p.includes('..')) return false;
  if (p[0] === '/' || p[0] === '\\') return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p[0] === ':') return false;
  if (p[0] === '-') return false;
  return true;
}

// `<rev>:<path>` is a revision operand, not a pathspec — see .ai/contexts/changes-view.md ("Editing a changed file")
function isSafeRevPathOperand(p) {
  if (!isSafeRepoRelativePath(p)) return false;
  if (/^[0-9]+:/.test(p)) return false;
  return true;
}

function buildBlobRev(relPath, staged) {
  return (staged ? 'HEAD:' : ':') + relPath;
}

function defaultRunGit(args, { cwd, timeoutMs, maxBuffer }) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: localGitEnv(), timeout: timeoutMs, maxBuffer, encoding: 'buffer', windowsHide: true },
      (err, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
        if (err) {
          resolve({
            code: typeof err.code === 'number' ? err.code : -1,
            stdout: out,
            tooLarge: err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          });
          return;
        }
        resolve({ code: 0, stdout: out, tooLarge: false });
      });
  });
}

async function resolveRepoRoot(cwd, deps) {
  const runGit = deps.runGit || defaultRunGit;
  const result = await runGit(['rev-parse', '--show-toplevel'], {
    cwd,
    timeoutMs: deps.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: TOPLEVEL_MAX_BUFFER,
  });
  if (result.code !== 0) return null;
  const root = String(result.stdout).trim();
  return root || null;
}

// Returns the single resolved path every later read/write must use — see .ai/contexts/changes-view.md
function resolveTargetInsideRepo(repoRoot, relPath, deps) {
  const fs = deps.fs || realFs;
  const realRoot = resolveOnDisk(repoRoot);
  if (!realRoot) return { ok: false, error: 'the repository directory no longer exists', reason: 'repo' };

  const real = resolveOnDisk(path.join(realRoot, relPath));
  if (!real) return { ok: false, error: 'file is not in the working tree', reason: 'missing' };
  if (!isInsideDir(real, realRoot)) return { ok: false, error: 'path resolves outside the repository', reason: 'outside' };
  if (isSensitivePath(real)) return { ok: false, error: 'access to sensitive path denied', reason: 'sensitive' };

  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, error: 'file is not in the working tree', reason: 'missing' };
  }
  if (!stat.isFile()) return { ok: false, error: 'not a regular file', reason: 'not-a-file' };

  return { ok: true, path: real, size: stat.size, repoRoot: realRoot };
}

async function readChangesFile({ cwd, relPath, staged, maxBytes }, deps = {}) {
  const fs = deps.fs || realFs;
  if (!isSafeRevPathOperand(relPath)) return { ok: false, error: 'invalid path', reason: 'invalid-path' };

  const repoRoot = await resolveRepoRoot(cwd, deps);
  if (!repoRoot) return { ok: false, error: 'not a git repository', reason: 'repo' };

  const target = resolveTargetInsideRepo(repoRoot, relPath, deps);
  if (!target.ok) return target;

  if (target.size > maxBytes) return { ok: false, error: 'file too large to edit', reason: 'too-large' };
  const buf = fs.readFileSync(target.path);
  if (buf.includes(0)) return { ok: false, error: 'binary file', reason: 'binary' };
  if (buf.length > maxBytes) return { ok: false, error: 'file too large to edit', reason: 'too-large' };

  const runGit = deps.runGit || defaultRunGit;
  const blob = await runGit(['cat-file', 'blob', buildBlobRev(relPath, staged)], {
    cwd: target.repoRoot,
    timeoutMs: deps.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: maxBytes + 1,
  });

  if (blob.tooLarge) return { ok: false, error: 'file too large to edit', reason: 'too-large' };

  let original = '';
  if (blob.code === 0) {
    if (blob.stdout.includes(0)) return { ok: false, error: 'binary file', reason: 'binary' };
    if (blob.stdout.length > maxBytes) return { ok: false, error: 'file too large to edit', reason: 'too-large' };
    original = blob.stdout.toString('utf8');
  }

  return { ok: true, original, current: buf.toString('utf8'), binary: false, truncated: false };
}

async function writeChangesFile({ cwd, relPath, content, maxBytes }, deps = {}) {
  const fs = deps.fs || realFs;
  if (typeof content !== 'string') return { ok: false, error: 'invalid content', reason: 'invalid-content' };
  if (!isSafeRepoRelativePath(relPath)) return { ok: false, error: 'invalid path', reason: 'invalid-path' };
  if (Buffer.byteLength(content, 'utf8') > maxBytes) return { ok: false, error: 'content too large to save', reason: 'too-large' };

  const repoRoot = await resolveRepoRoot(cwd, deps);
  if (!repoRoot) return { ok: false, error: 'not a git repository', reason: 'repo' };

  const target = resolveTargetInsideRepo(repoRoot, relPath, deps);
  if (!target.ok) return target;

  fs.writeFileSync(target.path, content, 'utf8');
  return { ok: true, savedPath: target.path };
}

module.exports = {
  readChangesFile,
  writeChangesFile,
  resolveTargetInsideRepo,
  resolveRepoRoot,
  isSafeRepoRelativePath,
  isSafeRevPathOperand,
  buildBlobRev,
};
