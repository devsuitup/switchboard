// terminal-path-target.js — openability check for a path matched in terminal output
// — see .ai/contexts/terminal-path-links.md

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_TEXT_LENGTH = 4096;
const SNIFF_BYTES = 4096;

// see .ai/contexts/terminal-path-links.md ("A candidate is checked")
function fileHasNullByte(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const read = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, read).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function expandHome(text, homedir) {
  if (text === '~') return homedir;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(homedir, text.slice(2));
  return text;
}

// deps: {isSensitivePath, statSync, hasNullByte, homedir, maxBytes}
function resolveTerminalPathTarget(text, cwd, deps) {
  if (typeof text !== 'string' || text === '' || text.length > MAX_TEXT_LENGTH) {
    return { ok: false, reason: 'invalid-path' };
  }
  if (text.includes('\0')) return { ok: false, reason: 'invalid-path' };

  const expanded = expandHome(text, deps.homedir());
  if (!path.isAbsolute(expanded)) {
    if (typeof cwd !== 'string' || cwd === '') return { ok: false, reason: 'no-cwd' };
    if (!path.isAbsolute(cwd)) return { ok: false, reason: 'no-cwd' };
  }
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);

  // Existence first, denylist second, and every check still runs on anything
  // that exists — see .ai/contexts/terminal-path-links.md ("A candidate is checked")
  let stat;
  try {
    stat = deps.statSync(resolved);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (deps.isSensitivePath(resolved)) return { ok: false, reason: 'sensitive' };
  if (stat.isDirectory()) return { ok: false, reason: 'directory' };
  if (!stat.isFile()) return { ok: false, reason: 'not-a-regular-file' };
  if (stat.size > deps.maxBytes) return { ok: false, reason: 'too-large' };
  if (deps.hasNullByte(resolved)) return { ok: false, reason: 'binary' };

  return { ok: true, path: resolved };
}

module.exports = { resolveTerminalPathTarget, fileHasNullByte };
