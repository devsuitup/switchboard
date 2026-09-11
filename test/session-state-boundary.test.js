// Boundary check for public/session-state.js: it must stay a pure domain
// module — no DOM, no IPC, no electron. Same source-grep technique as
// test/main-ctx-db-wiring.test.js (no require() of the module under test,
// since the point is to catch an accidental DOM/electron dependency before
// it ever gets a chance to run under node:test).
// See .ai/contexts/session-state.md.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'session-state.js'), 'utf8');

test('session-state.js never references document', () => {
  assert.ok(!/\bdocument\b/.test(SRC), 'session-state.js must not touch the DOM');
});

test('session-state.js never references window', () => {
  assert.ok(!/\bwindow\b/.test(SRC), 'session-state.js must not touch window');
});

test("session-state.js never requires 'electron'", () => {
  assert.ok(!/require\(\s*['"]electron['"]\s*\)/.test(SRC), 'session-state.js must not depend on electron');
});

test('session-state.js never references ipcRenderer', () => {
  assert.ok(!/\bipcRenderer\b/.test(SRC), 'session-state.js must not touch IPC directly');
});

test('session-state.js keeps the dual-load module.exports guard (like public/restore-plan.js)', () => {
  assert.match(SRC, /if\s*\(\s*typeof module\s*!==\s*['"]undefined['"]\s*&&\s*module\.exports\s*\)/,
    'session-state.js must stay require()-able from node:test with no DOM shim');
});
