'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const current = require('../session-cache');
const root = path.resolve(__dirname, '..');
function baselineModule(file, overrides = {}) {
  const filename = path.join(root, file);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(root);
  const original = mod.require.bind(mod);
  mod.require = id => overrides[id] || original(id);
  mod._compile(execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' }), filename);
  return mod.exports;
}
const baseline = baselineModule('session-cache.js', { './sidebar-bg-sessions': baselineModule('sidebar-bg-sessions.js') });
const rows = Array.from({ length: 5000 }, (_, i) => ({ sessionId: `s${i}`, folder: 'fixture', projectPath: root,
  fileMtime: '2026-10-19T00:00:00.000Z', modified: '2026-10-19T00:00:00.000Z', messageCount: 1,
  continuationIndex: JSON.stringify({ format: 3, complete: true, unresolved: false, mtime: '2026-10-19T00:00:00.000Z',
    ids: i < 200 && i % 2 === 0 ? [`s${i + 1}`] : [], pending: 'x'.repeat(1024) }) }));
const context = { PROJECTS_DIR: root, activeSessions: new Map(), getMainWindow: () => null, log: console,
  db: { getAllCached: () => rows, getAllMeta: () => new Map(), getSetting: () => null, getAllFolderMeta: () => new Map() } };
baseline.init(context); current.init(context);
function measure(label) {
  for (let i = 0; i < 10; i++) { baseline.buildProjectsFromCache(false); current.buildProjectsFromCache(false); }
  const before = [], after = [];
  for (let i = 0; i < 20; i++) {
    for (const [api, times] of i % 2 ? [[current, after], [baseline, before]] : [[baseline, before], [current, after]]) {
      const start = performance.now(); api.buildProjectsFromCache(false); times.push(performance.now() - start);
    }
  }
  const median = values => values.sort((a, b) => a - b)[10];
  const original = median(before), rolled = median(after);
  return { label, baselineMs: original, rollupMs: rolled, addedMs: rolled - original };
}
const results = [measure('5000 rows, 100 edges')];
for (const row of rows) row.continuationIndex = row.continuationIndex.replace(/"ids":\[[^\]]*\]/, '"ids":[]');
results.push(measure('5000 rows, no edges'));
const result = { node: process.version, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  rows: rows.length, warmRuns: 20, results };
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
if (results.some(item => item.addedMs > 10)) process.exitCode = 1;
