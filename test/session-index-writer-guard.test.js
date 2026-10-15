'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('espree');

const reads = new Set(['getMeta', 'getAllMeta', 'isCachePopulated', 'getAllCached', 'getCachedByFolder',
  'getCachedByParent', 'getCachedFolder', 'getCachedSession', 'getCachedMissingEntrypoint', 'getCachedMissingCustomTitle',
  'getFolderMeta', 'getAllFolderMeta', 'getSearchFileIds', 'searchByType', 'isSearchIndexPopulated',
  'searchFtsRecreated', 'getSetting', 'listSettingKeys', 'isInitialScanComplete', 'getDailyActivity',
  'getDailyMetrics', 'getDailyModelTokens', 'getModelUsage', 'getTotalCounts', 'DB_PATH', 'getProjectsRevision', 'applySettingsAcknowledgment', 'closeDb']);

const cacheWriters = new Set(['deleteCachedFolder', 'upsertCachedSessions', 'deleteCachedSession',
  'replaceSessionMetrics', 'touchCachedModified', 'deleteSearchFolder', 'deleteSearchSession',
  'upsertSearchEntries', 'setFolderMeta', 'setSetting', 'setName', 'setInitialScanComplete',
  'setCachedEntrypoints', 'setCachedContinuationIndex', 'setCachedCustomTitles']);
const cacheCommands = new Set(['init', 'refreshFolder', 'dropFolderRows', 'releaseLiveSession',
  'writeScannedFolder', 'writeScannedFolderPartial', 'applyProjectsWorkerEffects', 'buildProjectsFromCache', 'reconcileCacheFromFilesystem']);
const cacheWriteOwners = new Set([...cacheCommands, 'setTranscriptName']);

function violations(source, file = '') {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
  const found = [];
  const scopes = require('eslint-scope').analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const references = new Map(scopes.scopes.flatMap(scope => scope.references.map(ref => [ref.identifier, ref])));
  function isRegexp(node) {
    if (node.type === 'Literal') return !!node.regex;
    if (node.type === 'NewExpression') return node.callee.name === 'RegExp';
    const ref = references.get(node);
    const variable = ref?.resolved;
    return !!variable && variable.defs.length === 1
      && variable.defs[0].type === 'Variable'
      && variable.references.filter(reference => reference.isWrite()).length === 1
      && ['Literal', 'NewExpression'].includes(variable.defs[0].node.init?.type)
      && isRegexp(variable.defs[0].node.init);
  }
  function walk(node, owner = null) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration') owner = node.id.name;
    if (node.type === 'CallExpression' && node.callee.name === 'require'
      && (node.arguments[0]?.type !== 'Literal' || typeof node.arguments[0].value !== 'string')
      && !(node.arguments[0]?.type === 'CallExpression'
        && node.arguments[0].callee.object?.name === 'path' && node.arguments[0].callee.property?.name === 'join'
        && node.arguments[0].arguments.at(-2)?.value === 'node_modules'
        && node.arguments[0].arguments.at(-1)?.value === 'electron')) {
      found.push('non-literal require may load the DB backend');
    }
    if (file === 'main.js' && node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.name === 'sessionCache') {
      const property = node.callee.computed ? node.callee.property.value : node.callee.property.name;
      if (!property || cacheCommands.has(property)) found.push(`direct cache writer ${property || 'dynamic'}`);
    }
    if (file === 'session-index-writer.js' && node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.name === 'backend' && !reads.has(node.callee.property.name ?? node.callee.property.value)) {
      found.push('write through main readonly backend');
    }
    if (file === 'session-cache.js' && node.type === 'CallExpression'
      && node.callee.type === 'Identifier' && (cacheWriters.has(node.callee.name) || cacheCommands.has(node.callee.name))
      && !cacheWriteOwners.has(owner)) {
      found.push(`raw cache writer ${node.callee.name} in ${owner || 'top level'}`);
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'Identifier'
      && ((file === 'main.js' && node.init.name === 'sessionCache')
        || (file === 'session-cache.js' && cacheWriters.has(node.init.name)))) {
      found.push(`writer alias ${node.init.name}`);
    }
    if (node.type === 'VariableDeclarator' && node.init?.type === 'CallExpression'
      && node.init.callee.name === 'require' && /(?:^|\/)db(?:\.js)?$/.test(node.init.arguments[0]?.value || '')) {
      if (node.id.type !== 'ObjectPattern') found.push('unrestricted DB import');
      else for (const prop of node.id.properties) if (!reads.has(prop.key?.name)) found.push(`raw DB writer ${prop.key?.name}`);
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'CallExpression' && node.callee.object.callee.name === 'require'
      && /(?:^|\/)db(?:\.js)?$/.test(node.callee.object.arguments[0]?.value || '')
      && !reads.has(node.callee.property.name ?? node.callee.property.value)) {
      found.push(`inline raw DB writer ${node.callee.property.name ?? node.callee.property.value}`);
    }
    if (node.type === 'NewExpression' && node.callee.name === 'Database'
      && !node.arguments[1]?.properties?.some(p => p.key.name === 'readonly' && p.value.value === true)) found.push('writable SQLite connection outside writer');
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.property.name === 'pragma' && !/^busy_timeout\s*=/i.test(node.arguments[0]?.value || '') && /(?:=|wal_checkpoint|vacuum)/i.test(node.arguments[0]?.value || '')) found.push('SQLite mutation pragma');
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && node.callee.property.name === 'openSessionIndexStore'
      && !node.arguments[0]?.properties?.some(p => p.key.name === 'readonly' && p.value.value === true)) {
      found.push('writable store outside writer worker');
    }
    if (node.type === 'CallExpression' && node.callee.name === 'require'
      && /(?:^|\/)session-index-store(?:\.js)?$/.test(node.arguments[0]?.value || '') && file !== 'db.js') {
      found.push('unrestricted store import');
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && ['prepare', 'exec'].includes(node.callee.property.name ?? node.callee.property.value)
      && !((node.callee.property.name ?? node.callee.property.value) === 'exec' && isRegexp(node.callee.object))) {
      const argument = node.arguments[0];
      const literal = (argument?.type === 'Literal' && typeof argument.value === 'string')
        || (argument?.type === 'TemplateLiteral' && argument.expressions.length === 0);
      if (!literal) {
        found.push(`non-literal SQL at ${node.loc.start.line}`);
      }
      const sql = argument?.value ?? (argument?.type === 'TemplateLiteral' ? argument.quasis.map(q => q.value.raw).join(' ') : '');
      if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX)\b/i.test(sql)) found.push(`SQL mutation at ${node.loc.start.line}`);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, owner));
      else if (value && typeof value === 'object') walk(value, owner);
    }
  }
  walk(ast);
  return found;
}

test('the writer guard detects multiline SQL and injected raw writer imports', () => {
  assert.equal(violations("const {setSetting: save} = require('./db');").length, 1);
  assert.equal(violations("const {newWriter} = require('./db.js');").length, 1);
  assert.equal(violations("require('./db')['setSetting']('global', {});").length, 1);
  assert.equal(violations('db.prepare(`\nUPDATE settings SET value = ?`);').length, 1);
  assert.equal(violations("db.exec('DELETE FROM settings');").length, 1);
  assert.deepEqual(violations("const {getSetting} = require('./db'); db.prepare('SELECT * FROM settings');"), []);
});

test('the guard rejects a raw setting write injected in a cache reader', () => {
  assert.ok(violations("function revealIfSdkSession(id) { setSetting('probe', 1); }", 'session-cache.js').length);
});

test('the guard rejects a cache writer injected in a main IPC handler', () => {
  assert.ok(violations("ipcMain.handle('probe', () => sessionCache.refreshFolder('x'));", 'main.js').length);
});

test('the guard rejects a non-literal DB require', () => {
  assert.ok(violations("const dbm = './db'; require(dbm).setSetting('probe', 1);").length);
});

test('the guard rejects non-literal and interpolated SQL outside the backend', () => {
  assert.ok(violations('db.prepare(sql);').length);
  assert.ok(violations('db.prepare(`SELECT ${columns} FROM settings`);').length);
});


test('the guard rejects non-literal exec SQL', () => {
  assert.ok(violations('getDb().exec(sql);').length);
  assert.ok(violations('getDb().exec(`SELECT ${columns} FROM settings`);').length);
  assert.deepEqual(violations("db.exec('SELECT * FROM settings');"), []);
  assert.deepEqual(violations("const re = /a/; re.exec(text); new RegExp('a').exec(text);"), []);
  assert.ok(violations("const re = /a/; function probe(re) { re.exec(sql); }").length);
  assert.ok(violations('const re = re; re.exec(sql);').length);
});

test('the guard rejects a cache command injected in a cache reader', () => {
  assert.ok(violations("function revealIfSdkSession(id) { refreshFolder('x'); }", 'session-cache.js').length);
});

test('the guard rejects aliases of sessionCache in main', () => {
  assert.ok(violations("const sc = sessionCache; sc.refreshFolder('x');", 'main.js').length);
});

test('the guard rejects aliases of injected cache writers', () => {
  assert.ok(violations("function revealIfSdkSession(id) { const w = setSetting; w('probe', 1); }", 'session-cache.js').length);
});

test('production mutations and writable store stay inside the writer worker boundary', () => {
  const root = path.join(__dirname, '..');
  const excluded = new Set(['node_modules', '.git', '.work-files', '.agents', '.codex', 'test', 'e2e', 'dist', 'build']);
  function sources(dir = '') {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
      const file = path.posix.join(dir, entry.name);
      if (excluded.has(entry.name) || entry.name === 'codemirror-bundle.js') return [];
      if (entry.isDirectory()) return sources(file);
      return /\.(?:c?js)$/.test(entry.name) ? [file] : [];
    });
  }
  const files = sources();
  const found = files.filter(file => !['session-index-store.js', 'workers/session-index-writer.js'].includes(file))
    .flatMap(file => violations(fs.readFileSync(path.join(root, file), 'utf8'), file).map(problem => `${file}: ${problem}`));
  assert.deepEqual(found, []);
});

test('guard rejects writable main connections and direct connection write access', () => {
  assert.ok(violations("backend.setSetting('global', {});", 'session-index-writer.js').length);
  assert.ok(violations("require('./session-index-store').openSessionIndexStore({ readonly: false });", 'main.js').length);
  assert.ok(violations("new Database(path);", 'main.js').length);
  assert.ok(violations("db.pragma('user_version = 1');", 'main.js').length);
  assert.ok(violations("require('./db').connection.prepare('UPDATE settings SET value = 1').run();", 'main.js').length);
});
