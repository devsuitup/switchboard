// viewer-save-guard.js — refuses a ViewerPanel save over a file that moved — see .ai/contexts/viewer-panel.md ("Saving over a file that moved")

'use strict';

const fs = require('fs');

function asEditorText(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
}

/**
 * `expected` is the viewer's disk baseline; null or undefined skips the check.
 * Returns null when the write may go ahead, or the refusal to return.
 */
function refuseIfMoved(resolvedPath, expected, deps = {}) {
  if (expected === null || expected === undefined) return null;
  if (typeof expected !== 'string') return { ok: false, error: 'invalid expected content', reason: 'invalid-expected' };
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  if (asEditorText(readFile(resolvedPath)) !== expected) {
    return { ok: false, error: 'this file changed on disk since it was opened', reason: 'stale' };
  }
  return null;
}

module.exports = { refuseIfMoved, asEditorText };
