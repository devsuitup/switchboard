'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { isJavaScript, appFiles, relativeRequires, requireCalls, staticDirnameJoins, walk } = require('../scripts/module-paths');
const allowed = require('./fixtures/root-app-modules.json');

const ROOT = path.join(__dirname, '..');

const optionalPaths = {
  'scripts/postinstall.js:../node_modules': 'Dependencies are installed separately; disposable layout copies use NODE_PATH.',
  'scripts/postinstall.js:../node_modules/node-pty/prebuilds': 'Optional native prebuild directory varies by package/platform.',
};
const dynamicRequires = {
  "scripts/test-pr.js:require(path.join(worktree, 'node_modules', 'electron'))": 'The PR launcher intentionally selects Electron from a runtime-selected worktree.',
};

function unresolved(root) {
  const pending = appFiles(root);
  const visited = new Set();
  const failures = [];
  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    if (visited.has(file)) continue;
    visited.add(file);
    const absolute = path.join(root, file);
    const source = fs.readFileSync(absolute, 'utf8');
    const resolve = createRequire(absolute).resolve;
    for (const call of requireCalls(source)) {
      if (call.arguments[0]?.type === 'Literal' && typeof call.arguments[0].value === 'string') continue;
      const expression = source.slice(...call.range);
      if (!dynamicRequires[`${file}:${expression}`]) {
        failures.push(`${file}:${call.loc.start.line}: non-literal require: ${expression}`);
      }
    }
    for (const call of staticDirnameJoins(source)) {
      const parts = call.arguments.slice(1).map(part => part.value);
      const target = path.join(path.dirname(absolute), ...parts);
      if (!fs.existsSync(target) && !optionalPaths[`${file}:${parts.join('/')}`]) {
        failures.push(`${file}:${call.loc.start.line}: path.join(__dirname): ${parts.join('/')}: missing target`);
      }
    }
    for (const spec of relativeRequires(source)) {
      try {
        const target = resolve(spec.value);
        const rel = path.relative(root, target).replace(/\\/g, '/');
        if (rel.startsWith('public/') && isJavaScript(rel)) pending.push(rel);
      } catch (error) {
        failures.push(`${file}:${spec.loc.start.line}: ${spec.value}: ${error.code}`);
      }
    }
  }
  return failures;
}

function rootModules(root) {
  return fs.readdirSync(root).filter((f) => isJavaScript(f) && f !== 'eslint.config.js').sort();
}

test('every literal relative require in app code resolves, including lazy calls and shared public modules', () => {
  assert.deepEqual(unresolved(ROOT), []);
});

test('new app modules cannot be added at root; move PRs must shrink the allow-list', () => {
  assert.deepEqual(rootModules(ROOT), [...allowed].sort(), 'New modules belong in src/main/<context>/; remove moved modules from the allow-list.');
});

test('the resolver guard detects lazy broken requires at root, in workers/src/scripts and required public modules', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['entry.js', 'workers/w.js', 'src/main/nested/a.js', 'scripts/s.js', 'harnesses/claude.js', 'public/shared.js']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "function lazy() { return require('./missing'); }");
  }
  fs.appendFileSync(path.join(root, 'entry.js'), "\nrequire('./public/shared'); // require('./comment')");
  fs.writeFileSync(path.join(root, 'public/browser-only.js'), "require('./not-main-code');");
  const failures = unresolved(root);
  assert.equal(failures.length, 6, failures.join('\n'));
  assert.ok(failures.every((f) => f.includes('./missing')));
  assert.deepEqual(walk(root, 'src'), ['src/main/nested/a.js']);
});

test('the root inventory detects an added module and ignores context modules', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'new-module.js'), '');
  fs.mkdirSync(path.join(root, 'src/main/viewer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/main/viewer/context.js'), '');
  assert.deepEqual(rootModules(root), ['new-module.js']);
});

test('the guard resolves cjs and mjs requires at root, in nested scopes and required public modules', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [];
  for (const dir of ['', 'workers', 'src/main/context', 'scripts', 'public']) {
    for (const extension of ['cjs', 'mjs']) {
      const file = path.posix.join(dir, `consumer.${extension}`);
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "require('./missing');");
      files.push(file);
    }
  }
  fs.writeFileSync(path.join(root, 'entry.js'), "require('./public/consumer.cjs'); require('./public/consumer.mjs');");
  const failures = unresolved(root);
  assert.equal(failures.length, files.length, failures.join('\n'));
  for (const file of files) assert.ok(failures.some(failure => failure.startsWith(`${file}:`) && failure.includes('MODULE_NOT_FOUND')), file);
});

test('the layout guard detects broken static worker, preload, HTML and shell paths after a move', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/main/app'), { recursive: true });
  const targets = ['workers/query.js', 'preload.js', 'public/index.html', 'scripts/claude-sandbox.sh'];
  fs.writeFileSync(path.join(root, 'src/main/app/main.js'), targets.map(target =>
    `path.join(__dirname, '${target}');`).join('\n'));
  const failures = unresolved(root);
  assert.equal(failures.length, 4, failures.join('\n'));
  for (const target of targets) assert.ok(failures.some(f => f.includes(target)), target);
  for (const target of targets) {
    const file = path.join(root, 'src/main/app', target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  assert.deepEqual(unresolved(root), []);
});

test('non-literal require calls are reported and literal require.resolve targets must exist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'entry.js'), [
    'require(`./template`);', 'require(name);', 'require.resolve(name);', "require.resolve('./missing');",
  ].join('\n'));
  const failures = unresolved(root);
  assert.equal(failures.length, 4, failures.join('\n'));
  assert.ok(failures.some(f => f.includes('./missing')));
  assert.equal(failures.filter(f => f.includes('non-literal')).length, 3);
});
