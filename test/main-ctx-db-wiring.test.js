const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function read(f) {
  return fs.readFileSync(path.join(root, f), 'utf8');
}

function mainCtxDbKeys() {
  assert.match(read('main.js'), /writer\.initializeCache\(\{/);
  const { createSessionIndexWriter } = require('../session-index-writer');
  const source = read('db.js').split('module.exports =')[1];
  const ast = require('espree').parse('(' + source.trim().replace(/;$/, '') + ')', { ecmaVersion: 'latest' });
  const keys = ast.body[0].expression.properties.map(p => p.key.name);
  const backend = Object.fromEntries(keys.map(key => [key, () => {}]));
  let injected;
  createSessionIndexWriter(backend, { init: ctx => { injected = ctx.db; } }).initializeCache({});
  assert.notEqual(injected, backend);
  for (const key of Object.keys(injected)) assert.equal(injected[key], backend[key]);
  return new Set(Object.keys(injected));
}

// Every ctx.db.<name> that session-cache.js dereferences.
function sessionCacheDbDeps() {
  const src = read('session-cache.js');
  const deps = new Set();
  const re = /ctx\.db\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) deps.add(m[1]);
  return deps;
}

// Pure static analysis only — does NOT require('../db'), because better-sqlite3 is
// compiled against Electron's Node ABI and throws when loaded under plain node:test
// (same constraint db-daily-activity.test.js documents).

test('facade injects every exported backend dependency consumed by session-cache.js', () => {
  const provided = mainCtxDbKeys();
  const required = sessionCacheDbDeps();
  assert.deepEqual([...provided].sort(), [...required].sort());
});

test('ctx.db forwards the two functions from the 2026-06-02 stats incident', () => {
  const provided = mainCtxDbKeys();
  assert.ok(provided.has('replaceSessionMetrics'), 'ctx.db must forward replaceSessionMetrics');
  assert.ok(provided.has('touchCachedModified'), 'ctx.db must forward touchCachedModified');
});

// db.js must actually export those names too (a name forwarded in main.js but not
// exported by db.js is undefined just the same). Checked by source-grep, not require,
// to stay native-module-free.
test('db.js exports replaceSessionMetrics and touchCachedModified', () => {
  const dbSrc = read('db.js');
  for (const name of ['replaceSessionMetrics', 'touchCachedModified']) {
    assert.ok(
      new RegExp(`(^|[^\\w])${name}([^\\w]|$)`, 'm').test(dbSrc.split('module.exports')[1] || ''),
      `db.js module.exports should include ${name}`
    );
  }
});
