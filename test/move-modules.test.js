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

test('moving a loader apart from its dependency does not invent a stub ambiguity', () => {
  const source = "path.join(ROOT, 'a.js'); const stubs = { './b': 1 };";
  const sources = { 'entry.js': "require('./b')", 'a.js': "require('./b')", 'b.js': '' };
  assert.equal(rewrite('test/archive.test.js', source, map, { sources }),
    "path.join(ROOT, 'src/main/viewer/a.js'); const stubs = { '../shared/b': 1 };");
});

test('a genuine conflicting require-stub key is refused', () => {
  const input = "path.join(ROOT, 'a.js'); path.join(ROOT, 'b.js'); const stubs = { './c': 1 };";
  assert.throws(() => rewrite('test/x.test.js', input, { ...map, 'b.js': 'src/main/shared/adapters/b.js' }, {
    sources: { 'a.js': "require('./c')", 'b.js': "require('./c')" },
  }), /ambiguous vm stub/);
});

test('a shared stub key is refused when only one loaded source moves, in either load order', () => {
  const sources = { 'entry.js': "require('./c')", 'a.js': "require('./c')" };
  for (const order of [['entry.js', 'a.js'], ['a.js', 'entry.js']]) {
    const input = order.map(file => `path.join(ROOT, '${file}');`).join('\n')
      + "\nconst stubs = { './c': 1 };";
    assert.throws(() => rewrite('test/shared.test.js', input,
      { 'a.js': map['a.js'] }, { sources }),
    /ambiguous vm stub \.\/c/);
  }
});

test('helper-loaded sources with unassociated stub keys produce a listed warning', () => {
  const source = "function load(filename) { return fs.readFileSync(path.join(ROOT, filename)); } const stubs = { './c': 1 };";
  const warnings = [];
  rewrite('test/helper.test.js', source,
    { 'a.js': map['a.js'] }, {
      sources: { 'a.js': "require('./c')" },
      onWarning: warning => warnings.push(warning),
    });
  assert.ok(warnings.some(warning => /helper.*unassociated vm stub.*\.\/c/.test(warning)), warnings.join('\n'));
});

test('excerpt-only reads in projects-changed and run-schedule-now-result warn without conflicting with a full source', () => {
  const sources = { 'entry.js': "require('./c')", 'a.js': "require('./c')" };
  for (const excerpt of [
    "const file = path.join(ROOT, 'entry.js'); const text = fs.readFileSync(file, 'utf8'); const start = text.indexOf('function f'); vm.runInContext(text.slice(start), ctx);",
    "const text = fs.readFileSync(path.join(ROOT, 'entry.js'), 'utf8'); vm.runInContext(text.replace(/x/, 'y').substring(1), ctx);",
  ]) {
    const warnings = [];
    const input = `${excerpt}\nvm.runInContext(fs.readFileSync(path.join(ROOT, 'a.js'), 'utf8'), ctx); const stubs = { './c': 1 };`;
    let output;
    assert.doesNotThrow(() => {
      output = rewrite('test/excerpt.test.js', input, { 'a.js': map['a.js'] }, { sources, onWarning: warning => warnings.push(warning) });
    });
    assert.match(output, /'\.\.\/\.\.\/\.\.\/c': 1/);
    assert.ok(warnings.some(warning => /excerpt.test.js.*excerpt-only.*entry.js.*manual review/.test(warning)), warnings.join('\n'));
    assert.equal(rewrite('test/excerpt.test.js', output, { 'a.js': map['a.js'] }, { sources }), output);
  }
});

test('a full source evaluation still participates in conflicts even when the source is also sliced', () => {
  const input = "const text = fs.readFileSync(path.join(ROOT, 'entry.js')); text.indexOf('x'); text.slice(1); vm.runInContext(text, ctx); path.join(ROOT, 'a.js'); const stubs = { './c': 1 };";
  assert.throws(() => rewrite('test/mixed.test.js', input, { 'a.js': map['a.js'] }, {
    sources: { 'entry.js': "require('./c')", 'a.js': "require('./c')" },
  }), /ambiguous vm stub/);
});

test('path.join trailing segments are never rewritten as bare module filenames', () => {
  const moves = { 'writer.js': 'src/main/sessions/writer.js' };
  for (const input of [
    "path.join(__dirname, 'workers', 'writer.js');",
    "path.join(ROOT, 'workers', 'writer.js');",
    "path.join(base, 'workers', 'writer.js');",
    "path.join(__dirname, directory, 'writer.js');",
    "path.join('workers', 'writer.js');",
    "path.join(base, 'writer.js');",
  ]) assert.equal(rewrite('entry.js', input, moves), input);
  const relocated = rewrite('entry.js', "path.join(__dirname, 'workers', 'writer.js');", {
    'workers/writer.js': 'src/main/sessions/writer.js',
  });
  assert.equal(relocated, "path.join(__dirname, 'src/main/sessions/writer.js');");
  assert.equal(rewrite('entry.js', relocated, moves), relocated);
});

test('source-text assertions warn for embedded requires and quoted relative paths without altering text', () => {
  const input = `const start = source.indexOf("const x = require('./a');"); const other = source.indexOf("'./b'");`;
  const warnings = [];
  assert.equal(rewrite('test/assertions.test.js', input, map, { onWarning: warning => warnings.push(warning) }), input);
  assert.ok(warnings.some(warning => /assertions.test.js:1:.*source-text.*\.\/a/.test(warning)), warnings.join('\n'));
  assert.ok(warnings.some(warning => /assertions.test.js:1:.*source-text.*\.\/b/.test(warning)), warnings.join('\n'));
});

test('prototype-named literals stay byte-identical with a nonempty move map', () => {
  const input = "const names = ['toString', 'constructor', 'valueOf', 'hasOwnProperty'];";
  assert.equal(rewrite('consumer.js', input, map), input);
  assert.equal(rewrite('consumer.js', input, validateMap(map)), input);
});

for (const [kind, input] of [
  ['regex', String.raw`const re = /require\('\.\/a'\)/;`],
  ['template', "const text = `require('./a')`;"],
]) test(`${kind} source assertions warn without changing their text`, () => {
  const warnings = [];
  assert.equal(rewrite('test/assertions.test.js', input, map, { onWarning: w => warnings.push(w) }), input);
  assert.ok(warnings.some(w => /:1: source-text reference \.\/a;/.test(w)), warnings.join('\n'));
});

test('unsupported path.join anchors warn for moved keys and basenames only', () => {
  const input = "path.join(root, 'a.js');\npath.join(base, 'workers', 'child.js');\npath.join(base, 'other.js');";
  const warnings = [];
  assert.equal(rewrite('test/joins.test.js', input, { ...map, 'workers/child.js': 'src/workers/child.js' }, {
    onWarning: w => warnings.push(w),
  }), input);
  assert.deepEqual(warnings, [
    'test/joins.test.js:1: path.join segment a.js names a moved module; review manually',
    'test/joins.test.js:2: path.join segment child.js names a moved module; review manually',
  ]);
});

test('excerpt warnings require a moved dependency or a matching local stub', () => {
  const input = "const text = fs.readFileSync(path.join(ROOT, 'entry.js')); text.slice(1);";
  for (const [content, suffix, expected] of [
    ["require('./unrelated')", '', false],
    ["require('./a')", '', true],
    ["require('./unrelated')", "const stubs = { './unrelated': 1 };", true],
  ]) {
    const warnings = [];
    rewrite('test/excerpts.test.js', input + suffix, map, {
      sources: { 'entry.js': content }, onWarning: w => warnings.push(w),
    });
    assert.equal(warnings.some(w => w.includes('excerpt-only')), expected, content);
  }
});

test('excerpt warnings still resolve moved dependencies after applying the move', () => {
  const input = "const text = fs.readFileSync(path.join(ROOT, 'a.js')); text.slice(1);";
  const firstWarnings = [];
  const output = rewrite('test/excerpts.test.js', input, map, {
    sources: { 'a.js': "require('./b')" }, onWarning: w => firstWarnings.push(w),
  });
  assert.ok(firstWarnings.some(w => w.includes('excerpt-only')), firstWarnings.join('\n'));
  const warnings = [];
  assert.equal(rewrite('test/excerpts.test.js', output, map, {
    sources: { 'a.js': "require('../shared/b')" }, onWarning: w => warnings.push(w),
  }), output);
  assert.ok(warnings.some(w => w.includes('excerpt-only')), 'moved source must retain its affected-excerpt warning');
});

for (const expression of ['text.slice(0)', 'text.substring(0)', 'extractFunction(text)', 'extractAndRun(text)']) {
  test(`${expression} remains a full source load`, () => {
    const input = `const text = fs.readFileSync(path.join(ROOT, 'entry.js')); vm.runInContext(${expression}, ctx); path.join(ROOT, 'a.js'); const stubs = { './c': 1 };`;
    assert.throws(() => rewrite('test/full.test.js', input, { 'a.js': map['a.js'] }, {
      sources: { 'entry.js': "require('./c')", 'a.js': "require('./c')" },
    }), /ambiguous vm stub/, expression);
  });
}
test('extractAndRun calling vm internally remains a full source load', () => {
  const input = "function extractAndRun(text) { vm.runInContext(text, ctx); } const text = fs.readFileSync(path.join(ROOT, 'entry.js')); extractAndRun(text); path.join(ROOT, 'a.js'); const stubs = { './c': 1 };";
  assert.throws(() => rewrite('test/full.test.js', input, { 'a.js': map['a.js'] }, {
    sources: { 'entry.js': "require('./c')", 'a.js': "require('./c')" },
  }), /ambiguous vm stub/);
});

test('the CLI preserves its own script and helper bytes across repeated applies', t => {
  const { root, write } = cliFixture(t, 'move-self-');
  const protectedFiles = ['scripts/move-modules.js', 'scripts/module-paths.js'];
  const originals = new Map(protectedFiles.map(file => [file, fs.readFileSync(path.join(__dirname, '..', file))]));
  for (const [file, bytes] of originals) write(file, bytes);
  write('scripts/source-map.json', JSON.stringify({ 'a.js': map['a.js'] }));
  write(map['a.js'], 'module.exports = 1;');
  write('consumer.js', "require('./a');");
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/move-modules.js')], {
      env: { ...process.env, NODE_PATH: [path.join(__dirname, '../node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
      encoding: 'utf8', timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr);
    for (const [file, bytes] of originals) assert.ok(fs.readFileSync(path.join(root, file)).equals(bytes), `${file} must stay byte-identical`);
  }
  assert.equal(fs.readFileSync(path.join(root, 'consumer.js'), 'utf8'), "require('./src/main/viewer/a');");
});

function cliFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  const run = (...args) => spawnSync(process.execPath,
    [path.join(__dirname, '../scripts/move-modules.js'), '--root', root, ...args], { encoding: 'utf8', timeout: 120000 });
  return { root, write, run };
}

test('renderer basename collisions stay unchanged and warn even when their consumer moves', t => {
  const { write, run } = cliFixture(t, 'move-renderer-collision-');
  write('scripts/source-map.json', JSON.stringify({
    'activity-trace.js': 'src/main/shared/activity-trace.js',
    'loader.js': 'src/main/shared/loader.js',
  }));
  write('src/main/shared/activity-trace.js', 'module.exports = {};');
  const renderer = [
    "path.join(PUBLIC_DIR, 'activity-trace.js');",
    "path.join(ROOT, 'public', 'activity-trace.js');",
    "path.join(__dirname, 'public', 'activity-trace.js');",
  ];
  write('src/main/shared/loader.js', renderer.join('\n'));
  write('test/collision.test.js', [
    ...renderer.slice(0, 2),
    "path.join(__dirname, '..', 'public', 'activity-trace.js');",
    "path.join(ROOT, 'activity-trace.js');",
  ].join('\n'));
  write('public/activity-trace.js', 'window.trace = {};');
  const check = run('--check');
  assert.equal(check.status, 1, check.stderr);
  assert.doesNotMatch(check.stdout, /src\/main\/shared\/loader.js:/, 'non-root joins must not be rewritten when their consumer moves');
  for (const file of ['src/main/shared/loader.js', 'test/collision.test.js']) {
    for (let line = 1; line <= 3; line++) {
      assert.ok(check.stderr.includes(`WARNING ${file}:${line}: path.join segment activity-trace.js`), check.stderr);
    }
  }
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
});

function historyFixture(t) {
  const fixture = cliFixture(t, 'move-history-');
  fixture.write('scripts/source-map.json', '{}');
  fixture.write('gitconfig', '');
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      cwd: fixture.root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(fixture.root, 'gitconfig') },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init');
  fixture.write('before.txt', 'fixture\n');
  git('add', 'before.txt');
  git('commit', '-m', 'fixture base');
  const base = git('rev-parse', 'HEAD');
  git('mv', 'before.txt', 'after.txt');
  git('commit', '-m', 'fixture pure rename');
  const rename = git('rev-parse', 'HEAD');
  return { ...fixture, git, base, rename };
}

test('--check rejects every unreachable blame-ignore commit, including an existing dangling commit', t => {
  const { write, run, git, rename } = historyFixture(t);
  const dangling = git('commit-tree', 'HEAD^{tree}', '-m', 'fixture unrelated root');
  for (const stale of ['0'.repeat(40), dangling]) {
    write('.git-blame-ignore-revs', `${stale}\n${rename}\n`);
    const result = run('--check');
    assert.equal(result.status, 1, `must reject stale SHA ${stale}: ${result.stderr}`);
    assert.ok(result.stderr.includes(stale), result.stderr);
  }
});

test('--check accepts reachable rename history and rejects a newest entry with edits or no renames', t => {
  const { write, run, git, base, rename } = historyFixture(t);
  write('.git-blame-ignore-revs', `# move history\n${base}\n${rename} # newest move\n`);
  assert.equal(run('--check').status, 0);
  git('mv', 'after.txt', 'final.txt');
  write('extra.txt', 'edited\n');
  git('add', 'extra.txt');
  git('commit', '-m', 'fixture impure rename');
  const impure = git('rev-parse', 'HEAD');
  for (const sha of [impure, base]) {
    write('.git-blame-ignore-revs', `${rename}\n${sha}\n`);
    const result = run('--check');
    assert.equal(result.status, 1, `must reject impure newest entry: ${result.stderr}`);
    assert.match(result.stderr, /pure.rename|R100/);
  }
});

test('--check explicitly skips unreachable history in a shallow repository or a non-repository fixture', t => {
  const { write, run, base, rename } = historyFixture(t);
  write('.git/shallow', `${rename}\n`);
  write('.git-blame-ignore-revs', `${base}\n${rename}\n`);
  const shallow = run('--check');
  assert.equal(shallow.status, 0, shallow.stderr);
  assert.match(shallow.stderr, /SKIP.*blame.*shallow/i);
  const archive = cliFixture(t, 'move-archive-');
  archive.write('scripts/source-map.json', '{}');
  archive.write('.git-blame-ignore-revs', `${rename}\n`);
  const result = archive.run('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /SKIP.*blame.*histor|SKIP.*blame.*repository/i);
});

test('the CLI refuses apply before moves without changing any file and allows check to list pending moves', t => {
  const { root, write, run } = cliFixture(t, 'move-pending-');
  write('scripts/source-map.json', JSON.stringify({ 'a.js': map['a.js'] }));
  write('a.js', 'module.exports = 1;');
  const input = "require('./a'); path.join(__dirname, 'workers', 'a.js');";
  write('consumer.js', input);
  const check = run('--check');
  assert.equal(check.status, 1, check.stderr);
  assert.match(check.stdout, /pending git mv/);
  const apply = run();
  assert.equal(apply.status, 2, apply.stderr);
  assert.match(apply.stderr, /pending.*git mv|git mv.*pending/);
  assert.equal(fs.readFileSync(path.join(root, 'consumer.js'), 'utf8'), input);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'module.exports = 1;');
});

test('the CLI lists every ambiguous stub in every file and refuses all writes', t => {
  const { root, write, run } = cliFixture(t, 'move-conflicts-');
  const moves = { ...map, 'b.js': 'src/main/shared/adapters/b.js' };
  write('scripts/source-map.json', JSON.stringify(moves));
  write(map['a.js'], "require('./c'); require('./d');");
  write(moves['b.js'], "require('./c'); require('./d');");
  const input = "path.join(ROOT, 'a.js'); path.join(ROOT, 'b.js'); const stubs = { './c': 1, './d': 2 };";
  for (const file of ['test/first.test.js', 'test/last.test.js']) write(file, input);
  write('consumer.js', "require('./a');");
  for (const args of [['--check'], []]) {
    const result = run(...args);
    assert.equal(result.status, 2, result.stderr);
    for (const file of ['first', 'last']) {
      for (const key of ['c', 'd']) assert.ok(result.stderr.includes(`test/${file}.test.js: ambiguous vm stub ./${key}`), result.stderr);
    }
    assert.equal(fs.readFileSync(path.join(root, 'consumer.js'), 'utf8'), "require('./a');");
    assert.equal(fs.readFileSync(path.join(root, 'test/first.test.js'), 'utf8'), input);
  }
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
