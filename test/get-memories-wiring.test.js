'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = fs.readFileSync(path.join(__dirname, '..', 'file-lists.js'), 'utf8');

test('get-memories: every listing goes through the shared acceptance rule', () => {
  assert.match(handler, /const accepted = acceptMdFile\(fp, isAllowed\);/,
    'the project-root files must go through acceptMdFile, unconditionally');
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
  const worker = fs.readFileSync(path.join(__dirname, '..', 'workers/file-lists-query.js'), 'utf8');
  assert.match(worker, /listing\.bodies\.get\(/);
  assert.doesNotMatch(worker, /message\.kind === 'memory'[^;]+readFileSync/);
});

test('get-memories: the bodies it collects do not travel to the renderer', () => {
  assert.match(handler, /const listed = \(\{ content, \.\.\.entry \}\)/, '`listed` must destructure content off the entry');
  const pushes = handler.match(/files\.push\(\{ \.\.\.[a-zA-Z]+/g) || [];
  assert.ok(pushes.length >= 4, `expected several listing pushes, found ${pushes.length}`);
  for (const push of pushes) {
    assert.match(push, /\.\.\.listed$/, `${push}...) must spread listed(...), not the raw entry`);
  }
});

test('get-memories: the known-project set is resolved once, not per file', () => {
  assert.match(handler, /const knownRoots = getKnownProjectPaths\(options\)/,
    'the handler must bind the known roots once');
  assert.match(handler, /_isAllowedMemoryPath\([^)]*knownRoots\)/,
    'the predicate the handler passes around must close over that binding');
  assert.doesNotMatch(handler, /isAllowed\s*=\s*isAllowedMemoryPath\b/,
    'aliasing the per-call wrapper puts the rebuild back on the per-file path');
  assert.doesNotMatch(handler, /,\s*isAllowedMemoryPath\s*\)/,
    'the per-call wrapper must not be passed into a per-file path');
});
