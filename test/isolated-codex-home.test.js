'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Codex isolation restores absent and existing values with real test hooks', async t => {
  const filename = path.join(__dirname, 'fixtures/isolated-codex-home.cjs');
  assert.ok(fs.existsSync(filename), 'the shared Codex home isolation helper must exist');
  const isolateCodexHome = require(filename);
  const original = process.env.CODEX_HOME;
  try {
    for (const previous of [undefined, '', 'previous-disposable-codex-home']) {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      let home;
      await t.test(`previous value: ${String(previous)}`, child => {
        ({ home } = isolateCodexHome(child));
        assert.equal(process.env.CODEX_HOME, home);
        assert.deepEqual(fs.readdirSync(home), []);
        fs.mkdirSync(path.join(home, 'sessions'));
        fs.writeFileSync(path.join(home, 'sessions/fixture.jsonl'), '{}\n');
      });
      assert.equal(process.env.CODEX_HOME, previous);
      assert.equal(Object.hasOwn(process.env, 'CODEX_HOME'), previous !== undefined);
      assert.equal(fs.existsSync(home), false);
    }
  } finally {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  }
});

test('two isolations on one test context restore the original value and remove both homes', async t => {
  const isolate = require('./fixtures/isolated-codex-home.cjs');
  const previous = process.env.CODEX_HOME;
  let first, second;
  try {
    await t.test('two hooks on the same context', child => {
      first = isolate(child);
      second = isolate(child);
      assert.equal(process.env.CODEX_HOME, second.home);
    });
    assert.equal(process.env.CODEX_HOME, previous, 'FIFO test hooks must restore the original CODEX_HOME');
    assert.equal(fs.existsSync(first.home), false);
    assert.equal(fs.existsSync(second.home), false);
    second.restore(); first.restore();
    assert.equal(process.env.CODEX_HOME, previous, 'restoration is idempotent');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

const scanTokens = /populateCacheViaWorker|scan-projects|readHarnessFolder|harnesses\/codex|scanFoldersViaWorker|reconcileCacheFromFilesystem|workers\/projects-query|projects-worker-/;

function hasIsolation(source, shared = false, script = false) {
  const ast = require('espree').parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
  const functions = new Map(), fixtures = new Set(), isolates = new Set(), callbacks = [], functionNodes = [];
  const isFunction = node => /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node?.type);
  const required = node => node?.type === 'CallExpression' && node.callee.name === 'require' ? node.arguments[0]?.value : null;
  const sharedPath = value => /(?:warm-start-1144|continuation-718)\.cjs$/.test(value || '');
  const helperPath = value => /isolated-codex-home\.cjs$/.test(value || '');
  function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (node.type) visit(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, visit));
      else if (value && typeof value === 'object') walk(value, visit);
    }
  }
  walk(ast, node => {
    if (isFunction(node)) functionNodes.push(node);
    if (node.type === 'FunctionDeclaration') functions.set(node.id.name, node);
    if (node.type === 'VariableDeclarator') {
      if (isFunction(node.init)) functions.set(node.id.name, node.init);
      if (helperPath(required(node.init))) isolates.add(node.id.name);
      if (sharedPath(required(node.init)) && node.id.type === 'ObjectPattern') {
        for (const property of node.id.properties) if (property.key?.name === 'fixture') fixtures.add(property.value.name);
      }
    }
    if (node.type === 'CallExpression' && (node.callee.name === 'test' || node.callee.property?.name === 'test')) {
      const callback = node.arguments.find(isFunction);
      if (callback) callbacks.push(callback);
    }
  });
  function isolationCall(node) {
    if (node.type !== 'CallExpression' || !node.arguments.length) return false;
    const callee = node.callee;
    return helperPath(required(callee)) || isolates.has(callee.name) || fixtures.has(callee.name)
      || (callee.property?.name === 'fixture' && sharedPath(required(callee.object)));
  }
  if (script && ast.body.some(node => node.type === 'VariableDeclaration' && node.declarations.some(declaration =>
    declaration.init?.type === 'CallExpression' && helperPath(required(declaration.init.callee))))) return true;
  if (ast.body.some(node => node.type === 'ExpressionStatement' && isolationCall(node.expression)
    && node.expression.arguments[0]?.name === 'test')) return true;
  function inspect(node, seen = new Set()) {
    if (seen.has(node)) return { scan: false, isolated: false };
    seen.add(node);
    let scan = scanTokens.test(source.slice(node.range[0], node.range[1])), isolated = false;
    function visit(current) {
      if (current !== node && isFunction(current)) return;
      if (isolationCall(current)) isolated = true;
      if (current.type === 'CallExpression' && functions.has(current.callee.name)) {
        const result = inspect(functions.get(current.callee.name), seen);
        scan ||= result.scan; isolated ||= result.isolated;
      }
      for (const value of Object.values(current)) {
        if (Array.isArray(value)) value.filter(child => child?.type).forEach(visit);
        else if (value?.type) visit(value);
      }
    }
    visit(node);
    return { scan, isolated };
  }
  if (shared) return functions.has('fixture') && inspect(functions.get('fixture')).isolated;
  if (script) {
    let outside = '', end = 0;
    for (const node of functionNodes) {
      if (node.range[0] < end) continue;
      outside += source.slice(end, node.range[0]);
      end = node.range[1];
    }
    if (scanTokens.test(outside + source.slice(end))) return false;
    const scanners = functionNodes.map(node => inspect(node)).filter(result => result.scan);
    if (scanners.length) return scanners.every(result => result.isolated);
  }
  const results = callbacks.map(callback => inspect(callback));
  const scans = results.filter(result => result.scan);
  return scans.length > 0 ? scans.every(result => result.isolated) : results.length > 0 && results.every(result => result.isolated);
}

test('guard rejects unused imports and isolation belonging to a different test', async t => {
  for (const source of [
    "const isolate = require('./fixtures/isolated-codex-home.cjs'); test('scan', () => cache.populateCacheViaWorker());",
    "const { OLD } = require('./fixtures/continuation-718.cjs'); test('scan', () => cache.reconcileCacheFromFilesystem());",
    "test('isolated', t => { require('./fixtures/isolated-codex-home.cjs')(t); cache.populateCacheViaWorker(); }); test('unsafe', () => cache.populateCacheViaWorker());",
    "function unused() { require('./fixtures/isolated-codex-home.cjs')(test); } test('scan', () => cache.populateCacheViaWorker());",
  ]) assert.equal(hasIsolation(source), false, `unprotected scan: ${source}`);
  const scripts = {
    'A exported arrow scanner': "const cache = require('../../session-cache'); function safe(){ require('./isolated-codex-home.cjs')(null); return require('../../workers/scan-projects'); } module.exports.run = () => cache.populateCacheViaWorker(); module.exports.safe = safe;",
    'B top-level scan import': "const worker = require('../../workers/scan-projects'); function safe(){ require('./isolated-codex-home.cjs')(null); return require('../../harnesses/codex'); } function go(){ return worker.run(); } module.exports = { go, safe };",
    'C object-method scanner': "const cache = require('../../session-cache'); function safe(){ require('./isolated-codex-home.cjs')(null); return readHarnessFolder(); } module.exports = { run() { return cache.populateCacheViaWorker(); }, safe };",
  };
  for (const [name, source] of Object.entries(scripts)) await t.test(name, () => {
    assert.equal(hasIsolation(source, false, true), false, `unprotected script: ${name}`);
  });
});

test('guard accepts file isolation and actually invoked scoped fixtures', () => {
  for (const source of [
    "require('./fixtures/isolated-codex-home.cjs')(test); test('scan', () => cache.populateCacheViaWorker());",
    "test('scan', t => { require('./fixtures/isolated-codex-home.cjs')(t); cache.reconcileCacheFromFilesystem(); });",
    "const { fixture: setup } = require('./fixtures/continuation-718.cjs'); test('scan', t => { setup(t); cache.reconcileCacheFromFilesystem(); });",
  ]) assert.equal(hasIsolation(source), true, source);
});

test('scan callers opt into the shared Codex home isolation fixture', () => {
  const exempt = new Map([
    ['archive-writer-compatibility.test.js', 'scan API is stubbed'],
    ['check-changelog.test.js', 'scan token occurs in changelog fixture text'],
    ['codex-viewer-and-guard.test.js', 'pure viewer transformations and source checks'],
    ['continuation-choice-sweep.test.js', 'scan API is stubbed'],
    ['get-projects-archive-conflicts.test.js', 'scan API is stubbed'],
    ['get-projects-archive-writer.test.js', 'scan API is stubbed'],
    ['get-projects-cold-start-reconcile.test.js', 'scan and reconcile APIs are stubbed'],
    ['get-projects-worker-wiring.test.js', 'scan and reconcile APIs are stubbed'],
    ['harness-activity.test.js', 'pure activity transformations'],
    ['project-delete-main.test.js', 'scan API is stubbed'],
    ['session-restore-cold-cache.test.js', 'scan API is stubbed'],
    ['head-turn-spinner.test.js', 'scanFoldersViaWorker is a counting stub'],
    ['projects-worker-client.test.js', 'injected EventEmitter worker; never runs projects-query'],
    ['worker-exit-grace.test.js', 'injected EventEmitter worker; never runs projects-query'],
    ['session-index-writer-guard.test.js', 'source-only writer boundary guard'],
    ['fixtures/deferred-1193.cjs', 'helpers for guarded session-cache-deferred-1193 and deferral-causes-1193 callers'],
    ['fixtures/projects-worker-718.cjs', 'VM adapter inherits caller environment; caller files are guarded'],
    ['fixtures/projects-worker-delayed.cjs', 'worker inherits environment from guarded equivalence/slow-reconcile callers'],
    ['fixtures/projects-worker-equivalence.cjs', 'child inherits environment from guarded projects-worker-equivalence.test.js'],
    ['fixtures/projects-worker-progress.cjs', 'child inherits environment from guarded projects-worker-equivalence.test.js'],
    ['fixtures/projects-worker-slow-reconcile.cjs', 'child inherits environment from guarded projects-worker-equivalence.test.js'],
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
      if (!shared && !scanTokens.test(source)) continue;
      if (exempt.has(relative)) continue;
      if (!hasIsolation(source, shared, relative.endsWith('.cjs'))) missing.push(relative);
    }
  }
  walk(__dirname);
  assert.deepEqual(missing, [], 'scan callers must use the shared Codex isolation helper');
});
