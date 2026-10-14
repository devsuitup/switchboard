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

function violations(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
  const found = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
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
      const sql = argument?.value ?? (argument?.type === 'TemplateLiteral' ? argument.quasis.map(q => q.value.raw).join(' ') : '');
      if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX)\b/i.test(sql)) found.push(`SQL mutation at ${node.loc.start.line}`);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
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
    .flatMap(file => violations(fs.readFileSync(path.join(root, file), 'utf8')).map(problem => `${file}: ${problem}`));
  assert.deepEqual(found, ['main.js: inline raw DB writer rekeySessionMeta']);
});
