// scan-md-files.js — non-recursive scan of a directory for the Markdown files
// the Memory/brain tab lists (CLAUDE.md, memory notes, schedule-*.md commands).
// Electron-free so it can be tested directly.
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Scan `dir` for non-empty `.md` files (non-recursive).
 *
 * Entries are accepted through `fs.statSync`, which follows symlinks, rather
 * than through the directory entry's own type: a `schedule-*.md` or `CLAUDE.md`
 * that is a symlink to a file kept in a git-versioned dotfiles repo is a real
 * Markdown file to every reader of this list, but its dirent reports
 * `isSymbolicLink()`, not `isFile()`. Checking the dirent alone dropped those
 * files from the brain tab (and from the memory FTS index) with no error
 * anywhere — the schedule still fired on cron, it just could not be seen or
 * run from the UI.
 *
 * A symlink pointing at a directory, or a dangling one, still fails the
 * `isFile()` check on the resolved target and is skipped. Per-entry failures
 * are contained: one unreadable file no longer aborts the scan of everything
 * after it in the same directory.
 *
 * @param {string} dir
 * @returns {Array<{filename: string, filePath: string, modified: string}>}
 */
function scanMdFiles(dir) {
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
