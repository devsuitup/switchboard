// scan-md-files.js — the Markdown files the Memory/brain tab lists: one
// acceptance rule, and a non-recursive scan built on it. Electron-free so it
// can be tested directly.
// See .ai/contexts/ipc-bridge.md, "IPC path-guard inventory".
'use strict';

const fs = require('fs');
const path = require('path');
const { isSensitivePath } = require('./ipc-path-validator');

/**
 * Accept `filePath` as a listable Markdown file, or return null.
 *
 * The accepted content comes back with the entry. A caller that needs the body
 * must use it rather than read the path again: a second read is a second
 * resolution of the same string, free to land somewhere the checks above never
 * saw. See resolve-path-on-disk.js.
 *
 * @param {string} filePath
 * @param {(filePath: string) => boolean} [isAllowed] - caller's allowlist, given the literal path
 * @returns {{filename: string, filePath: string, modified: string, content: string}|null}
 */
function acceptMdFile(filePath, isAllowed) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (isSensitivePath(filePath)) return null;
    if (isAllowed && !isAllowed(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) return null;
    return { filename: path.basename(filePath), filePath, modified: stat.mtime.toISOString(), content };
  } catch {
    return null; // unreadable, dangling or absent
  }
}

/**
 * Scan `dir` for listable `.md` files (non-recursive).
 *
 * @param {string} dir
 * @param {(filePath: string) => boolean} [isAllowed] - caller's allowlist, given the literal path
 * @returns {Array<{filename: string, filePath: string, modified: string}>}
 */
function scanMdFiles(dir, isAllowed) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.name.endsWith('.md')) continue;
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const accepted = acceptMdFile(path.join(dir, e.name), isAllowed);
      if (accepted) results.push(accepted);
    }
  } catch { /* unreadable directory */ }
  return results;
}

module.exports = { scanMdFiles, acceptMdFile };
