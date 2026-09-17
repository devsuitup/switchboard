// test/get-memories-wiring.test.js — source-text assertions on the get-memories
// handler in main.js.
//
// The acceptance rule and its tests live in scan-md-files.js, which can be
// required directly; the handler cannot (Electron + better-sqlite3 are compiled
// against the Electron ABI), so it is checked the same way the FTS dirty-flag
// helpers are — by extracting the source and reading it. These are the
// properties that make the unit tests next door mean anything: a handler that
// stops calling the rule, or reads a file a second time behind its back, passes
// every test in scan-md-files.test.js.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const start = mainSrc.indexOf("ipcMain.handle('get-memories'");
const end   = mainSrc.indexOf('// --- IPC: read-memory ---');
assert.ok(start !== -1, "get-memories handler not found in main.js");
assert.ok(end > start, '"// --- IPC: read-memory ---" marker not found after the handler');

const handler = mainSrc.slice(start, end);

test('get-memories: every listing goes through the shared acceptance rule', () => {
  // The project-root files are looked up by name, the rest by directory scan.
  // Both must end up in acceptMdFile — a second hand-rolled lookup beside it is
  // how the gate came to be missing from the root files in the first place.
  assert.match(handler, /acceptMdFile\(/, 'the project-root files must go through acceptMdFile');
  assert.doesNotMatch(handler, /existsSync\([^)]*\bfp\b/,
    'a by-name lookup must not probe the file itself — acceptMdFile owns that');
});

test('get-memories: no scan is made without an allowlist', () => {
  const calls = handler.match(/scanMdFiles\([^)]*\)/g) || [];
  assert.ok(calls.length >= 4, `expected the handler to scan several directories, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /,\s*isAllowed\s*\)/, `${call} must pass the allowlist`);
  }
  assert.match(handler, /acceptMdFile\([^)]*,\s*isAllowed\s*\)/, 'the by-name lookup must pass it too');
});

test('get-memories: the FTS index uses the body already read, never a second read', () => {
  // A second fs read of the same path is a second resolution of it, free to
  // land somewhere the allowlist and the denylist never saw — and, if what
  // lands there is a FIFO, to freeze the main process for good.
  const ftsStart = handler.indexOf('upsertSearchEntries');
  assert.ok(ftsStart !== -1, 'the FTS block was not found in the handler');

  assert.doesNotMatch(handler, /body:\s*fs\.readFileSync/, 'the index must not re-read the file');
  assert.match(handler, /body:\s*bodies\.get\(/, 'the index must use the body acceptMdFile returned');
  assert.doesNotMatch(handler.slice(ftsStart), /fs\.readFileSync/,
    'nothing in the FTS block may touch the filesystem again');
});

test('get-memories: the bodies it collects do not travel to the renderer', () => {
  // `listed` is what strips them; every push of a listing entry must go
  // through it, or a file's full content rides the IPC payload to the renderer.
  assert.match(handler, /const listed = \(\{ content, \.\.\.entry \}\)/, '`listed` must destructure content off the entry');
  const pushes = handler.match(/files\.push\(\{ \.\.\.[a-zA-Z]+/g) || [];
  assert.ok(pushes.length >= 4, `expected several listing pushes, found ${pushes.length}`);
  for (const push of pushes) {
    assert.match(push, /\.\.\.listed$/, `${push}...) must spread listed(...), not the raw entry`);
  }
});

test('get-memories: the known-project set is resolved once, not per file', () => {
  // isAllowedMemoryPath rebuilds it from disk on every call — readdir of every
  // project folder, plus a 256 KiB read off a JSONL each — so calling the
  // module-level wrapper per file makes this handler quadratic in projects,
  // synchronously, on the Electron main thread.
  assert.match(handler, /const knownRoots = \[\.\.\.getKnownProjectPaths\(\)\]/,
    'the handler must bind the known roots once');
  assert.match(handler, /_isAllowedMemoryPath\([^)]*knownRoots\)/,
    'the predicate the handler passes around must close over that binding');
  assert.doesNotMatch(handler, /isAllowed\s*=\s*isAllowedMemoryPath\b/,
    'aliasing the per-call wrapper puts the rebuild back on the per-file path');
  assert.doesNotMatch(handler, /,\s*isAllowedMemoryPath\s*\)/,
    'the per-call wrapper must not be passed into a per-file path');
});
