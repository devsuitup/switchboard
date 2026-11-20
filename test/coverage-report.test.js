'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Report = require('c8/lib/report');
const { buildYargs } = require('c8/lib/parse-args');

test('coverage merges worker reports incrementally without changing covered counts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'probe.js'), source = 'module.exports = 1;\n';
  fs.writeFileSync(filename, source);
  const reports = path.join(root, 'reports');
  fs.mkdirSync(reports);
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(reports, i + '.json'), JSON.stringify({ result: [{
    scriptId: String(i), url: pathToFileURL(filename).href, functions: [{ functionName: '', isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: source.length, count: i + 1 }] }],
  }] }));
  const argv = buildYargs().parse(['--config', path.join(__dirname, '../.c8rc.json'), 'node']);
  const options = { tempDirectory: reports, resolve: root, allowExternal: true, exclude: [], reporter: [] };
  const reference = await Report(options).getCoverageMapFromAllCoverageFiles();
  const configured = Report({ ...options, mergeAsync: argv.mergeAsync });
  t.mock.method(configured, '_loadReports', () => assert.fail('coverage must not retain all raw worker reports at once'));
  const actual = await configured.getCoverageMapFromAllCoverageFiles();
  assert.deepEqual(actual.toJSON(), reference.toJSON(), 'streaming preserves the complete coverage map');
  assert.ok(Object.values(actual.fileCoverageFor(filename).s).every(count => count === 6));
});
