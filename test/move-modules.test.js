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

test('vm stubs stay unchanged when rewritten loaded sources are fed back in', () => {
  const input = "const src = fs.readFileSync(path.join(ROOT, 'a.js')); const stubs = { './b': 1, './c': 2 };";
  const sources = { 'a.js': "require('./b'); require('./c');", 'b.js': '', 'c.js': '' };
  const output = rewrite('test/x.test.js', input, map, { sources });
  const rewritten = Object.fromEntries(Object.entries(sources).map(([file, source]) =>
    [file, rewrite(map[file] || file, source, map)]));
  const edits = [];
  assert.equal(rewrite('test/x.test.js', output, map, { sources: rewritten, onEdits: e => edits.push(...e) }), output);
  assert.deepEqual(edits, []);
});

test('moving schedule-runner apart from db does not invent a stub ambiguity in project-settings-archive', () => {
  const moves = { 'schedule-runner.js': 'src/main/schedules/schedule-runner.js', 'db.js': 'src/main/shared/db.js' };
  const source = fs.readFileSync(path.join(__dirname, 'project-settings-archive.test.js'), 'utf8');
  const sources = Object.fromEntries(['main.js', 'schedule-runner.js', 'db.js'].map(file =>
    [file, fs.readFileSync(path.join(__dirname, '..', file), 'utf8')]));
  assert.doesNotThrow(() => rewrite('test/project-settings-archive.test.js', source, moves, { sources }));
});

test('a genuine conflicting require-stub key is refused', () => {
  const input = "path.join(ROOT, 'a.js'); path.join(ROOT, 'b.js'); const stubs = { './c': 1 };";
  assert.throws(() => rewrite('test/x.test.js', input, { ...map, 'b.js': 'src/main/shared/adapters/b.js' }, {
    sources: { 'a.js': "require('./c')", 'b.js': "require('./c')" },
  }), /ambiguous vm stub/);
});

test('a shared stub key is refused when only one loaded source moves, in either load order', () => {
  const sources = Object.fromEntries(['main.js', 'schedule-runner.js'].map(file =>
    [file, fs.readFileSync(path.join(__dirname, '..', file), 'utf8')]));
  for (const order of [['main.js', 'schedule-runner.js'], ['schedule-runner.js', 'main.js']]) {
    const input = order.map(file => `path.join(ROOT, '${file}');`).join('\n')
      + "\nconst stubs = { './encode-project-path': 1 };";
    assert.throws(() => rewrite('test/shared.test.js', input,
      { 'schedule-runner.js': 'src/main/schedules/schedule-runner.js' }, { sources }),
    /ambiguous vm stub \.\/encode-project-path/);
  }
});

test('helper-loaded sources with unassociated stub keys produce a listed warning', () => {
  const source = fs.readFileSync(path.join(__dirname, 'git-changes-file-paths.test.js'), 'utf8');
  const warnings = [];
  rewrite('test/git-changes-file-paths.test.js', source,
    { 'git-changes-file.js': 'src/main/changes/git-changes-file.js' }, {
      sources: { 'git-changes-file.js': fs.readFileSync(path.join(__dirname, '..', 'git-changes-file.js'), 'utf8') },
      onWarning: warning => warnings.push(warning),
    });
  assert.ok(warnings.some(warning => /git-changes-file-paths.*unassociated vm stub.*resolve-path-on-disk/.test(warning)), warnings.join('\n'));
});

test('the CLI rewrites cjs and mjs consumers in every scanned JavaScript scope', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-extensions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/main/viewer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/source-map.json'), JSON.stringify({ 'a.js': map['a.js'] }));
  fs.writeFileSync(path.join(root, map['a.js']), "module.exports = require('./c');");
  fs.writeFileSync(path.join(root, 'c.js'), 'module.exports = 1;');
  const consumers = [];
  for (const dir of ['', 'workers', 'src', 'scripts', 'public', 'test/fixtures', 'e2e']) {
    for (const extension of ['cjs', 'mjs']) {
      const file = path.posix.join(dir, `consumer.${extension}`);
      const prefix = dir ? '../'.repeat(dir.split('/').length) : './';
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), `require('${prefix}a');`);
      const relative = path.posix.relative(dir || '.', 'src/main/viewer/a');
      consumers.push([file, `require('${relative.startsWith('.') ? relative : `./${relative}`}');`]);
    }
  }
  fs.writeFileSync(path.join(root, 'test/helper.test.cjs'),
    "function load(filename) { return path.join(ROOT, filename); } const stubs = { './c': 1 };");
  const run = (...args) => spawnSync(process.execPath,
    [path.join(__dirname, '../scripts/move-modules.js'), '--root', root, ...args], { encoding: 'utf8', timeout: 120000 });
  const check = run('--check');
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stdout, /test\/fixtures\/consumer.cjs/);
  assert.match(check.stderr, /WARNING test\/helper.test.cjs: unassociated vm stub \.\/c/);
  assert.equal(run().status, 0);
  for (const [file, expected] of consumers) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), expected, file);
  const final = run('--check');
  assert.equal(final.status, 0);
  assert.match(final.stderr, /WARNING test\/helper.test.cjs: unassociated vm stub \.\/c/);
});

test('require.resolve follows an unmoved target from a moved source', () => {
  const input = "const worker = require.resolve('./c.js');";
  const output = rewrite(map['a.js'], input, map);
  assert.equal(output, "const worker = require.resolve('../../../c.js');");
  assert.equal(rewrite(map['a.js'], output, map), output);
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
  fs.writeFileSync(path.join(root, map['a.js']), "module.exports = require('./c');");
  fs.writeFileSync(path.join(root, 'c.js'), 'module.exports = 1;');
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test/vm.test.js'), "const source = path.join(ROOT, 'a.js'); const stubs = { './c': 1 };");
  const input = "require('./a'); require('./a.js');";
  fs.writeFileSync(path.join(root, 'consumer.js'), input);
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../scripts/move-modules.js'), '--root', root, ...args], { encoding: 'utf8' });
  const before = run('--check');
  assert.equal(before.status, 1, before.stderr);
  assert.match(before.stdout, /consumer.js.*\.\/a/);
  assert.match(before.stdout, /vm.test.js.*\.\/c/);
  assert.equal(fs.readFileSync(path.join(root, 'consumer.js'), 'utf8'), input);
  assert.equal(run().status, 0);
  const once = fs.readFileSync(path.join(root, 'consumer.js'), 'utf8');
  const onceStub = fs.readFileSync(path.join(root, 'test/vm.test.js'), 'utf8');
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, '');
  assert.equal(fs.readFileSync(path.join(root, 'consumer.js'), 'utf8'), once);
  assert.equal(fs.readFileSync(path.join(root, 'test/vm.test.js'), 'utf8'), onceStub);
  assert.equal(run('--check').status, 0);
});
