// resolve-path-on-disk.js — resolves a path to its real, symlink-free
// location on disk. See .ai/contexts/ipc-bridge.md, "IPC path-guard
// inventory", for why every path guard needs this and not just path.resolve().
'use strict';

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const realpathJs = promisify((p, cb) => fs.realpath(p, cb));

/**
 * Resolve `filePath` to its real, symlink-free location on disk.
 *
 * Returns `null` when the path (or any component of it) does not exist
 * (ENOENT), when resolution hits a symlink loop (ELOOP), or on any other
 * filesystem error — callers that must also accept a path which may
 * legitimately not exist yet (e.g. a file about to be created) are expected
 * to fall back to `path.resolve(filePath)` themselves in that case, the same
 * way they did before this primitive existed.
 *
 * That fallback is a known, accepted gap, not a fixed one: a symlink whose
 * target does not exist yet resolves to `null` here, so a guard built on top
 * of this function falls back to validating the literal (unresolved) string
 * — the same string a symlink could still point outside the allowed root
 * from once something is created at the far end. It is safe in this
 * codebase's current callers only because they separately require the
 * target to already exist (`fs.existsSync`) before reading or writing it,
 * which fails the same way for a dangling link. A future caller that skips
 * that existence check, or that races a concurrent process creating the
 * target between the two calls, would reopen it.
 *
 * Whether or not that fallback fires, the caller MUST perform its eventual
 * read/write on the value a guard built on this function *returns* (its
 * resolved path), never on a path the caller re-derives with its own
 * `path.resolve(filePath)` afterwards. Two independent resolutions of the
 * same literal string are two independent chances for an in-between symlink
 * swap to point them at different places — the classic TOCTOU shape. A
 * single resolution, reused, cannot diverge from itself.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function resolveOnDisk(filePath) {
  try {
    return fs.realpathSync(path.resolve(filePath));
  } catch {
    return null;
  }
}

async function resolveOnDiskAsync(filePath) {
  try {
    return await realpathJs(path.resolve(filePath));
  } catch {
    return null;
  }
}

const EXTENDED_UNC = /^[\\/]{2}[?.][\\/]UNC[\\/]/i;
const EXTENDED_DRIVE = /^[\\/]{2}[?.][\\/](?=[A-Za-z]:)/;
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

// see .ai/contexts/ipc-bridge.md, "Sensitive-path candidates"
function stripExtendedPrefix(p) {
  if (typeof p !== 'string') return p;
  if (EXTENDED_UNC.test(p)) return '\\\\' + p.replace(EXTENDED_UNC, '');
  return p.replace(EXTENDED_DRIVE, '');
}

function attempt(fn, arg) {
  try { return { real: fn(arg) }; } catch (e) { return { code: e && e.code }; }
}

function attemptAsync(fn, arg) {
  return new Promise((resolve) => {
    try {
      fn(arg, (e, real) => resolve(e ? { code: e.code } : { real }));
    } catch (e) {
      resolve({ code: e && e.code });
    }
  });
}

function ancestorsOf(p) {
  const out = [];
  let dir = path.dirname(p);
  let prev = p;
  while (dir !== prev) {
    out.push(dir);
    prev = dir;
    dir = path.dirname(dir);
  }
  return out;
}

function collect(literal, results) {
  const paths = [literal];
  for (const r of results) if (r.real) paths.push(r.real);
  const resolved = paths.length > 1;
  const missing = !resolved && results.every((r) => MISSING.has(r.code));
  return { paths, resolved, missing };
}

// see .ai/contexts/ipc-bridge.md, "Sensitive-path candidates"
function sensitiveCandidates(filePath) {
  const literal = path.resolve(stripExtendedPrefix(filePath));
  const paths = new Set([path.resolve(filePath), literal]);
  const first = collect(literal, [attempt(fs.realpathSync, literal), attempt(fs.realpathSync.native, literal)]);
  first.paths.forEach((p) => paths.add(p));
  if (first.resolved) return { paths: [...paths], unresolved: false };
  if (!first.missing) return { paths: [...paths], unresolved: true };
  for (const dir of ancestorsOf(literal)) {
    const r = collect(dir, [attempt(fs.realpathSync, dir), attempt(fs.realpathSync.native, dir)]);
    if (r.resolved) {
      const tail = path.relative(dir, literal);
      r.paths.slice(1).forEach((p) => paths.add(path.join(p, tail)));
      return { paths: [...paths], unresolved: false };
    }
    if (!r.missing) return { paths: [...paths], unresolved: true };
  }
  return { paths: [...paths], unresolved: false };
}

async function sensitiveCandidatesAsync(filePath) {
  const literal = path.resolve(stripExtendedPrefix(filePath));
  const paths = new Set([path.resolve(filePath), literal]);
  const both = async (p) => collect(p, [
    await attemptAsync(fs.realpath, p),
    await attemptAsync(fs.realpath.native, p),
  ]);
  const first = await both(literal);
  first.paths.forEach((p) => paths.add(p));
  if (first.resolved) return { paths: [...paths], unresolved: false };
  if (!first.missing) return { paths: [...paths], unresolved: true };
  for (const dir of ancestorsOf(literal)) {
    const r = await both(dir);
    if (r.resolved) {
      const tail = path.relative(dir, literal);
      r.paths.slice(1).forEach((p) => paths.add(path.join(p, tail)));
      return { paths: [...paths], unresolved: false };
    }
    if (!r.missing) return { paths: [...paths], unresolved: true };
  }
  return { paths: [...paths], unresolved: false };
}

/**
 * True when `child` is `parent` itself or lies beneath it.
 *
 * Compares with a trailing separator so a sibling directory sharing a prefix
 * (…/projects-evil next to …/projects) does not satisfy the check. Does not
 * resolve on disk itself — pass already-resolved paths in from `resolveOnDisk`
 * when the containment check needs to survive symlinks.
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isInsideDir(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

module.exports = { resolveOnDisk, resolveOnDiskAsync, isInsideDir, stripExtendedPrefix, sensitiveCandidates, sensitiveCandidatesAsync };
