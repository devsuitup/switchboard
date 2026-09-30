// viewer-save-guard.js — a panel save writes only over the content it agreed to replace — see .ai/contexts/viewer-panel.md ("Saving over a file that moved")

'use strict';

const fs = require('fs');
const path = require('path');

function asEditorText(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
}

/**
 * Returns null when the file on disk is `expected` (line endings folded), or
 * the refusal to return, carrying the compared disk text on a stale one.
 */
function refuseIfMoved(resolvedPath, expected, deps = {}) {
  if (typeof expected !== 'string') return { ok: false, error: 'missing expected content', reason: 'invalid-expected' };
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const onDisk = asEditorText(readFile(resolvedPath));
  if (onDisk !== expected) {
    return { ok: false, error: 'this file changed on disk since it was opened', reason: 'stale', disk: onDisk };
  }
  return null;
}

/**
 * The write behind save-memory and save-file-for-panel: checks, writes, then
 * runs `afterWrite`. Returns what the handler returns.
 */
function writeIfUnmoved(resolvedPath, content, expected, { afterWrite, readFile, writeFile } = {}) {
  const refused = refuseIfMoved(resolvedPath, expected, { readFile });
  if (refused) return refused;
  (writeFile || ((p, c) => fs.writeFileSync(p, c, 'utf8')))(resolvedPath, content);
  if (afterWrite) afterWrite();
  return { ok: true };
}

/**
 * The two IPC handlers, with main's policies injected:
 * {isSensitivePath, resolveAllowedMemoryPath, invalidateFtsSignature, existsSync, readFile, writeFile, onError}
 */
function createPanelSaveHandlers(deps) {
  const existsSync = deps.existsSync || fs.existsSync;
  const io = { readFile: deps.readFile, writeFile: deps.writeFile };

  function saveFileForPanel(filePath, content, expected) {
    try {
      const resolved = path.resolve(filePath);
      if (deps.isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
      if (!existsSync(resolved)) return { ok: false, error: 'File does not exist' };
      return writeIfUnmoved(resolved, content, expected, {
        ...io,
        afterWrite: () => {
          if (resolved.includes('/.work-files/')) deps.invalidateFtsSignature('work-file');
          if (resolved.endsWith('.md')) deps.invalidateFtsSignature('memory');
        },
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function saveMemory(filePath, content, expected) {
    try {
      const literal = path.resolve(filePath);
      if (!literal.endsWith('.md')) return { ok: false, error: 'not a .md file' };
      const resolved = deps.resolveAllowedMemoryPath(literal);
      if (!resolved) return { ok: false, error: 'path not allowed' };
      if (!existsSync(resolved)) return { ok: false, error: 'file does not exist' };
      return writeIfUnmoved(resolved, content, expected, {
        ...io,
        afterWrite: () => deps.invalidateFtsSignature('memory'),
      });
    } catch (err) {
      if (deps.onError) deps.onError(err);
      return { ok: false, error: err.message };
    }
  }

  return { saveFileForPanel, saveMemory };
}

module.exports = { refuseIfMoved, writeIfUnmoved, createPanelSaveHandlers, asEditorText };
