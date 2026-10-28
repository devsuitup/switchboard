'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { rewrite, validateMap } = require('../scripts/move-modules');

const map = { 'a.js': 'src/main/viewer/a.js', 'b.js': 'src/main/shared/b.js' };

test('requires follow both endpoints, including lazy calls, without editing comments', () => {
  const input = "// require('./b')\nfunction lazy() { return require('./b'); }\nrequire('./c.js');";
  const output = rewrite('src/main/viewer/a.js', input, map);
  assert.equal(output, "// require('./b')\nfunction lazy() { return require('../shared/b'); }\nrequire('../../../c.js');");
  assert.equal(rewrite('src/main/viewer/a.js', output, map), output);
});

test('test requires, fixture paths and path.join anchors follow moved modules', () => {
  const input = "require('../a'); require('../../a'); path.join(__dirname, '..', 'a.js'); path.join(ROOT, 'a.js');";
  assert.equal(rewrite('test/x.test.js', input, map),
    "require('../src/main/viewer/a'); require('../../a'); path.join(__dirname, '../src/main/viewer/a.js'); path.join(ROOT, 'src/main/viewer/a.js');");
  assert.equal(rewrite('test/fixtures/x.js', "require('../../a')", map), "require('../../src/main/viewer/a')");
});

test('vm stubs follow the source being loaded, including unmoved dependencies', () => {
  const input = "const src = fs.readFileSync(path.join(ROOT, 'a.js')); const stubs = { './b': 1, './c': 2 };";
  const options = { sources: { 'a.js': "require('./b'); require('./c');" } };
  const output = rewrite('test/x.test.js', input, map, options);
  assert.match(output, /'\.\.\/shared\/b': 1/);
  assert.match(output, /'\.\.\/\.\.\/\.\.\/c': 2/);
  assert.equal(rewrite('test/x.test.js', output, map, options), output);
});

test('documentation changes only qualified references and preserves basenames', () => {
  const input = '`../a.js` and `workers/child.js` and a.js';
  assert.equal(rewrite('docs/guide.md', input, { ...map, 'workers/child.js': 'src/main/sessions/workers/child.js' }),
    '`../src/main/viewer/a.js` and `src/main/sessions/workers/child.js` and a.js');
});

test('maps reject escaping paths, renamed modules, cycles and duplicate destinations', () => {
  for (const bad of [ { '../a.js': 'src/a.js' }, { 'a.js': '../a.js' },
    { 'a.js': 'src/renamed.js' }, { 'a.js': 'b/a.js', 'b/a.js': 'a.js' },
    { 'x/a.js': 'src/a.js', 'y/a.js': 'src/a.js' } ]) {
    assert.throws(() => validateMap(bad));
  }
});

test('--check lists every pending rewrite, never writes, and becomes clean after applying twice', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-modules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src/main/viewer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/source-map.json'), JSON.stringify({ 'a.js': map['a.js'] }));
  fs.writeFileSync(path.join(root, map['a.js']), 'module.exports = 1;');
  const input = "require('./a'); require('./a.js');";
  fs.writeFileSync(path.join(root, 'consumer.js'), input);
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../scripts/move-modules.js'), '--root', root, ...args], { encoding: 'utf8' });
  const before = run('--check');
  assert.equal(before.status, 1, before.stderr);
  assert.match(before.stdout, /consumer.js.*\.\/a/);
  assert.equal(before.stdout.trim().split('\n').length, 2);
  assert.equal(fs.readFileSync(path.join(root, 'consumer.js'), 'utf8'), input);
  assert.equal(run().status, 0);
  const once = fs.readFileSync(path.join(root, 'consumer.js'), 'utf8');
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'consumer.js'), 'utf8'), once);
  assert.equal(run('--check').status, 0);
});
