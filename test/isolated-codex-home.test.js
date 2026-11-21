'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Codex isolation restores absent and existing values and removes its populated directory', () => {
  const filename = path.join(__dirname, 'fixtures/isolated-codex-home.cjs');
  assert.ok(fs.existsSync(filename), 'the shared Codex home isolation helper must exist');
  const isolateCodexHome = require(filename);
  const original = process.env.CODEX_HOME;
  try {
    for (const previous of [undefined, '', 'previous-disposable-codex-home']) {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      let cleanup;
      const { home } = isolateCodexHome({ after: fn => { cleanup = fn; } });
      assert.equal(process.env.CODEX_HOME, home);
      assert.deepEqual(fs.readdirSync(home), []);
      fs.mkdirSync(path.join(home, 'sessions'));
      fs.writeFileSync(path.join(home, 'sessions/fixture.jsonl'), '{}\n');
      cleanup();
      assert.equal(process.env.CODEX_HOME, previous);
      assert.equal(Object.hasOwn(process.env, 'CODEX_HOME'), previous !== undefined);
      assert.equal(fs.existsSync(home), false);
    }
  } finally {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  }
});

test('scan callers opt into the shared Codex home isolation fixture', () => {
  const exempt = new Set([
    'archive-writer-compatibility.test.js', 'check-changelog.test.js',
    'codex-viewer-and-guard.test.js', 'continuation-choice-sweep.test.js',
    'get-projects-archive-conflicts.test.js', 'get-projects-archive-writer.test.js',
    'get-projects-cold-start-reconcile.test.js', 'get-projects-worker-wiring.test.js',
    'harness-activity.test.js', 'project-delete-main.test.js', 'session-restore-cold-cache.test.js',
  ]);
  const missing = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(filename); continue; }
      if (!/\.(?:c?js)$/.test(entry.name) || filename === __filename) continue;
      const relative = path.relative(__dirname, filename).split(path.sep).join('/');
      const source = fs.readFileSync(filename, 'utf8');
      const shared = ['fixtures/warm-start-1144.cjs', 'fixtures/continuation-718.cjs'].includes(relative);
      if (!shared && !/populateCacheViaWorker|scan-projects|readHarnessFolder|harnesses\/codex|scanFoldersViaWorker/.test(source)) continue;
      if (exempt.has(relative)) continue;
      if (!/require\(['"][^'"]*(?:isolated-codex-home|warm-start-1144|continuation-718)\.cjs['"]\)/.test(source)) missing.push(relative);
    }
  }
  walk(__dirname);
  assert.deepEqual(missing, [], 'scan callers must use the shared Codex isolation helper');
});
