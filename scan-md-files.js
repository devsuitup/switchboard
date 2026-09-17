// scan-md-files.js — non-recursive scan of a directory for the Markdown files
// the Memory/brain tab lists. Electron-free so it can be tested directly.
// See .ai/contexts/ipc-bridge.md, "IPC path-guard inventory".
'use strict';

const fs = require('fs');
const path = require('path');
const { isSensitivePath } = require('./ipc-path-validator');

/**
 * Scan `dir` for non-empty `.md` files (non-recursive).
 *
 * @param {string} dir
 * @param {(filePath: string) => boolean} [isAllowed] - caller's allowlist, given the literal path
 * @returns {Array<{filename: string, filePath: string, modified: string}>}
 */
function scanMdFiles(dir, isAllowed) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.name.endsWith('.md')) continue;
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const fp = path.join(dir, e.name);
      try {
        const stat = fs.statSync(fp);
        if (!stat.isFile()) continue;
        if (isSensitivePath(fp)) continue;
        if (isAllowed && !isAllowed(fp)) continue;
        const content = fs.readFileSync(fp, 'utf8').trim();
        if (content) {
          results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString() });
        }
      } catch { /* unreadable or dangling — skip this entry, keep the rest */ }
    }
  } catch { /* unreadable directory */ }
  return results;
}

module.exports = { scanMdFiles };
