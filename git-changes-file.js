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

// see .ai/contexts/changes-view.md ("Containment, and which path the write runs on")
async function resolveRepoDirs(cwd, deps) {
  const runGit = deps.runGit || defaultRunGit;
  const result = await runGit(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {
    cwd,
    timeoutMs: deps.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: TOPLEVEL_MAX_BUFFER,
  });
  if (result.code !== 0) return null;
  const lines = String(result.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  const root = lines[0];
  if (!root) return null;
  const gitDirs = [];
  for (const dir of lines.slice(1)) {
    const resolved = resolveOnDisk(path.resolve(root, dir));
    if (resolved && !gitDirs.includes(resolved)) gitDirs.push(resolved);
  }
  return { root, gitDirs };
}

async function resolveRepoRoot(cwd, deps) {
  const dirs = await resolveRepoDirs(cwd, deps);
  return dirs ? dirs.root : null;
}

function hasGitSegment(relativePath) {
  return relativePath.split(/[/\\]/).some((segment) => segment.toLowerCase() === '.git');
}

// Returns the single resolved path every later read/write must use — see .ai/contexts/changes-view.md
function resolveTargetInsideRepo(repo, relPath, deps) {
  const fs = deps.fs || realFs;
  const repoRoot = typeof repo === 'string' ? repo : repo.root;
  const gitDirs = (typeof repo === 'string' ? [] : repo.gitDirs) || [];
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
  // Every check that matters runs on the resolved path: a symlinked directory
  // component defeats one that reads the string the renderer sent.
  if (hasGitSegment(path.relative(realRoot, real))) {
    return { ok: false, error: 'the git directory is not editable', reason: 'git-dir' };
  }
  for (const gitDir of gitDirs) {
    if (isInsideDir(real, gitDir)) {
      return { ok: false, error: 'the git directory is not editable', reason: 'git-dir' };
    }
  }
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

const BOM = '\ufeff';

// see .ai/contexts/changes-view.md ("Caps, line endings and encoding")
function lineEndingsOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const kinds = [];
  if (crlf) kinds.push('\r\n');
  if (cr) kinds.push('\r');
  if (lf) kinds.push('\n');
  return kinds;
}

function soleEol(text) {
  const kinds = lineEndingsOf(text);
  if (kinds.length === 0) return '\n';
  return kinds.length === 1 ? kinds[0] : null;
}

// CodeMirror folds CRLF *and* a lone CR to LF, so both have to fold here too,
// or the buffer never compares equal to what was read.
function toLf(text) {
  return text.replace(/\r\n?/g, '\n');
}

function applyEol(text, eol) {
  const lf = toLf(text);
  return eol === '\n' ? lf : lf.replace(/\n/g, eol);
}

function stripBom(text) {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

// ignoreBOM keeps a leading U+FEFF instead of consuming it, so a Windows-authored
// file does not lose three bytes to a round trip.
function decodeUtf8(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null;
  }
}

async function readChangesFile({ cwd, relPath, staged, maxBytes }, deps = {}) {
  const fs = deps.fs || realFs;
  if (!isSafeRevPathOperand(relPath)) return { ok: false, error: 'invalid path', reason: 'invalid-path' };

  const repo = await resolveRepoDirs(cwd, deps);
  if (!repo) return { ok: false, error: 'not a git repository', reason: 'repo' };

  const target = resolveTargetInsideRepo(repo, relPath, deps);
  if (!target.ok) return target;

  if (target.size > maxBytes) return { ok: false, error: 'file too large to edit', reason: 'too-large' };
  const buf = fs.readFileSync(target.path);
  if (buf.includes(0)) return { ok: false, error: 'binary file', reason: 'binary' };
  if (buf.length > maxBytes) return { ok: false, error: 'file too large to edit', reason: 'too-large' };
  const decoded = decodeUtf8(buf);
  if (decoded === null) return { ok: false, error: 'file is not valid UTF-8', reason: 'encoding' };
  const currentText = stripBom(decoded);
  if (soleEol(currentText) === null) {
    return { ok: false, error: 'file mixes line endings', reason: 'mixed-eol' };
  }

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
    original = toLf(stripBom(originalText));
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

  const repo = await resolveRepoDirs(cwd, deps);
  if (!repo) return { ok: false, error: 'not a git repository', reason: 'repo' };

  const target = resolveTargetInsideRepo(repo, relPath, deps);
  if (!target.ok) return target;

  const onDisk = fs.readFileSync(target.path);
  if (versionOf(onDisk) !== version) {
    return { ok: false, error: 'this file changed on disk since it was opened', reason: 'stale' };
  }

  // The bytes the token was taken from decide how this file is written back.
  const decoded = decodeUtf8(onDisk);
  if (decoded === null) return { ok: false, error: 'file is not valid UTF-8', reason: 'encoding' };
  const eol = soleEol(stripBom(decoded));
  if (eol === null) return { ok: false, error: 'file mixes line endings', reason: 'mixed-eol' };
  const prefix = decoded.startsWith(BOM) ? BOM : '';
  const bytes = Buffer.from(prefix + applyEol(stripBom(content), eol), 'utf8');
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
  hasGitSegment,
  buildBlobRev,
  versionOf,
  resolveRepoDirs,
  lineEndingsOf,
  soleEol,
  toLf,
};
