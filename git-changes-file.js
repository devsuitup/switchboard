// git-changes-file.js — content pair and write target for the editable Changes panel — see .ai/contexts/changes-view.md

'use strict';

const realFs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { localGitEnv } = require('./git-changes-runner');
const { resolveOnDisk, isInsideDir } = require('./resolve-path-on-disk');
const { isSensitivePath } = require('./ipc-path-validator');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PATH_LENGTH = 4096;
const TOPLEVEL_MAX_BUFFER = 64 * 1024;
const NOT_IN_TREE_EXIT_CODE = 128;

// Guards for a repo-relative path from the renderer — see .ai/contexts/changes-view.md ("Editing a changed file")
function isSafeRepoRelativePath(p) {
  if (typeof p !== 'string' || p === '' || p.length > MAX_PATH_LENGTH) return false;
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  if (p[0] === '/' || p[0] === '\\') return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p[0] === ':') return false;
  if (p[0] === '-') return false;
  const segments = p.split(/[/\\]/);
  if (segments.some((s) => s === '..')) return false;
  if (segments.some((s) => s.toLowerCase() === '.git')) return false;
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

// There is no file-write path to a remote host anywhere in this app — see .ai/contexts/changes-view.md
function requireLocalTarget(target) {
  if (!target || target.ok !== true) return target;
  if (target.kind !== 'local') {
    return { ok: false, error: 'editing is not available for a remote session', reason: 'remote' };
  }
  return target;
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
            stderr: String(stderr || err.message || ''),
            tooLarge: err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          });
          return;
        }
        resolve({ code: 0, stdout: out, stderr: '', tooLarge: false });
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

  const joined = path.join(realRoot, relPath);
  let link;
  try {
    link = fs.lstatSync(joined);
  } catch {
    return { ok: false, error: 'file is not in the working tree', reason: 'missing' };
  }
  if (link.isSymbolicLink()) {
    return { ok: false, error: 'this row is a symbolic link, not a file', reason: 'symlink' };
  }

  const real = resolveOnDisk(joined);
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

// The token the renderer hands back on save — see .ai/contexts/changes-view.md ("Saving over a file that moved")
function versionOf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex') + '-' + buf.length;
}

function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function toLf(text) {
  return text.replace(/\r\n/g, '\n');
}

function applyEol(text, eol) {
  return eol === '\r\n' ? toLf(text).replace(/\n/g, '\r\n') : toLf(text);
}

// see .ai/contexts/changes-view.md ("Caps, line endings and encoding")
function decodeUtf8(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
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
  const currentText = decodeUtf8(buf);
  if (currentText === null) return { ok: false, error: 'file is not valid UTF-8', reason: 'encoding' };

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
    const originalText = decodeUtf8(blob.stdout);
    if (originalText === null) return { ok: false, error: 'file is not valid UTF-8', reason: 'encoding' };
    original = toLf(originalText);
  } else if (blob.code !== NOT_IN_TREE_EXIT_CODE) {
    return { ok: false, error: (blob.stderr || '').trim() || `git exited with code ${blob.code}`, reason: 'git' };
  }

  return {
    ok: true,
    original,
    current: toLf(currentText),
    version: versionOf(buf),
    binary: false,
    truncated: false,
  };
}

async function writeChangesFile({ cwd, relPath, content, version, maxBytes }, deps = {}) {
  const fs = deps.fs || realFs;
  if (typeof content !== 'string') return { ok: false, error: 'invalid content', reason: 'invalid-content' };
  if (typeof version !== 'string' || !version) return { ok: false, error: 'missing version token', reason: 'invalid-version' };
  if (!isSafeRepoRelativePath(relPath)) return { ok: false, error: 'invalid path', reason: 'invalid-path' };
  if (Buffer.byteLength(content, 'utf8') > maxBytes) return { ok: false, error: 'content too large to save', reason: 'too-large' };

  const repoRoot = await resolveRepoRoot(cwd, deps);
  if (!repoRoot) return { ok: false, error: 'not a git repository', reason: 'repo' };

  const target = resolveTargetInsideRepo(repoRoot, relPath, deps);
  if (!target.ok) return target;

  const onDisk = fs.readFileSync(target.path);
  if (versionOf(onDisk) !== version) {
    return { ok: false, error: 'this file changed on disk since it was opened', reason: 'stale' };
  }

  const eol = dominantEol(decodeUtf8(onDisk) || '');
  const bytes = Buffer.from(applyEol(content, eol), 'utf8');
  if (bytes.length > maxBytes) return { ok: false, error: 'content too large to save', reason: 'too-large' };
  fs.writeFileSync(target.path, bytes);
  return { ok: true, savedPath: target.path, version: versionOf(bytes) };
}

module.exports = {
  readChangesFile,
  writeChangesFile,
  requireLocalTarget,
  resolveTargetInsideRepo,
  resolveRepoRoot,
  isSafeRepoRelativePath,
  isSafeRevPathOperand,
  buildBlobRev,
  versionOf,
  dominantEol,
};
