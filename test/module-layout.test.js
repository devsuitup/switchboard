'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { appFiles, relativeRequires, walk } = require('../scripts/module-paths');
const allowed = require('./fixtures/root-app-modules.json');

const ROOT = path.join(__dirname, '..');

function unresolved(root) {
  const pending = appFiles(root);
  const visited = new Set();
  const failures = [];
  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    if (visited.has(file)) continue;
    visited.add(file);
    const absolute = path.join(root, file);
    const resolve = createRequire(absolute).resolve;
    for (const spec of relativeRequires(fs.readFileSync(absolute, 'utf8'))) {
      try {
        const target = resolve(spec.value);
        const rel = path.relative(root, target).replace(/\\/g, '/');
        if (rel.startsWith('public/') && rel.endsWith('.js')) pending.push(rel);
      } catch (error) {
        failures.push(`${file}:${spec.loc.start.line}: ${spec.value}: ${error.code}`);
      }
    }
  }
  return failures;
}

function rootModules(root) {
  return fs.readdirSync(root).filter((f) => f.endsWith('.js') && f !== 'eslint.config.js').sort();
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
  for (const file of ['entry.js', 'workers/w.js', 'src/main/nested/a.js', 'scripts/s.js', 'public/shared.js']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "function lazy() { return require('./missing'); }");
  }
  fs.appendFileSync(path.join(root, 'entry.js'), "\nrequire('./public/shared'); // require('./comment')");
  fs.writeFileSync(path.join(root, 'public/browser-only.js'), "require('./not-main-code');");
  const failures = unresolved(root);
  assert.equal(failures.length, 5, failures.join('\n'));
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
