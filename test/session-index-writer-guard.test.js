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
  'getDailyMetrics', 'getDailyModelTokens', 'getModelUsage', 'getTotalCounts', 'DB_PATH', 'getProjectsRevision']);

const cacheWriters = new Set(['deleteCachedFolder', 'upsertCachedSessions', 'deleteCachedSession',
  'replaceSessionMetrics', 'touchCachedModified', 'deleteSearchFolder', 'deleteSearchSession',
  'upsertSearchEntries', 'setFolderMeta', 'setSetting', 'setName', 'setInitialScanComplete',
  'setCachedEntrypoints', 'setCachedContinuationIndex', 'setCachedCustomTitles']);
const cacheCommands = new Set(['init', 'refreshFolder', 'dropFolderRows', 'releaseLiveSession',
  'writeScannedFolder', 'writeScannedFolderPartial', 'applyProjectsWorkerEffects', 'buildProjectsFromCache']);
const cacheWriteOwners = new Set([...cacheCommands, 'setTranscriptName']);

function violations(source, file = '') {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
  const found = [];
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
    if (file === 'session-cache.js' && node.type === 'CallExpression'
      && node.callee.type === 'Identifier' && cacheWriters.has(node.callee.name)
      && !cacheWriteOwners.has(owner)) {
      found.push(`raw cache writer ${node.callee.name} in ${owner || 'top level'}`);
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
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && ['prepare', 'exec'].includes(node.callee.property.name ?? node.callee.property.value)) {
      const argument = node.arguments[0];
      const literal = (argument?.type === 'Literal' && typeof argument.value === 'string')
        || (argument?.type === 'TemplateLiteral' && argument.expressions.length === 0);
      if ((node.callee.property.name ?? node.callee.property.value) === 'prepare' && !literal) {
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

test('production SQL and raw DB writers stay inside the backend and facade except the recorded continuation callback', () => {
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
  const found = files.filter(file => !['db.js', 'session-index-writer.js'].includes(file))
    .flatMap(file => violations(fs.readFileSync(path.join(root, file), 'utf8'), file).map(problem => `${file}: ${problem}`));
  assert.deepEqual(found, ['main.js: inline raw DB writer rekeySessionMeta']);
});
