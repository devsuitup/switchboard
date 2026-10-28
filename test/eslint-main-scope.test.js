'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const root = path.join(__dirname, '..');

function javascriptFiles(dir) {
  if (!fs.existsSync(path.join(root, dir))) return [];
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const file = path.posix.join(dir, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : /.c?js$/.test(file) ? [file] : [];
  });
}

test('every main-process module receives the same Node rules as main.js', async () => {
  const eslint = new ESLint({ cwd: root });
  const reference = await eslint.calculateConfigForFile('main.js');
  assert.deepEqual(reference.rules['no-undef'], [2, { typeof: false }]);
  const files = [
    ...fs.readdirSync(root).filter(file => file.endsWith('.js') && !file.endsWith('.config.js')),
    ...javascriptFiles('workers'),
    ...javascriptFiles('scripts'),
    ...javascriptFiles('src/main'),
    'future-main-module.js',
    'workers/future/nested.js',
    'scripts/future/nested.js',
    'src/main/remote/future-module.js',
  ];
  for (const file of files) {
    const effective = await eslint.calculateConfigForFile(file);
    assert.ok(effective, `${file} must not be ignored`);
    assert.deepEqual(effective.rules, reference.rules, file);
    assert.equal(effective.languageOptions.sourceType, 'commonjs', file);
    assert.deepEqual(effective.languageOptions.globals, reference.languageOptions.globals, file);
  }
});

test('new and moved main modules catch undefined names and accept Node globals', async () => {
  const eslint = new ESLint({ cwd: root });
  for (const filePath of ['future-main-module.js', 'workers/future.js', 'scripts/future.js', 'src/main/remote/future.js']) {
    const [result] = await eslint.lintText('const unused = 1;\nmissingMainProcessSymbol();\nmodule.exports = process.pid;\n', { filePath });
    assert.deepEqual(result.messages.map(({ ruleId, severity }) => ({ ruleId, severity })), [
      { ruleId: 'no-unused-vars', severity: 1 },
      { ruleId: 'no-undef', severity: 2 },
    ], filePath);
    assert.match(result.messages[1].message, /missingMainProcessSymbol/);
  }
});

test('the config self-check stays separate from main-process rules', async () => {
  const eslint = new ESLint({ cwd: root });
  const effective = await eslint.calculateConfigForFile('eslint.config.js');
  assert.equal(effective.rules?.['no-undef'], undefined);
});
