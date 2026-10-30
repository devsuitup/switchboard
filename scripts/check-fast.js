'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const normalize = file => file.replace(/\\/g, '/');

function selectTests(files, testFiles) {
  const selected = new Set();
  for (const file of files.map(normalize)) {
    if (!file.endsWith('.js')) continue;
    if (file.startsWith('test/')) {
      if (file.endsWith('.test.js')) selected.add(file);
      continue;
    }
    const basename = path.posix.basename(file, '.js');
    const prefixes = file.startsWith('public/') ? [basename, `dom-${basename}`] : [basename];
    for (const name of testFiles) {
      if (name.endsWith('.test.js') && prefixes.some(prefix => name.startsWith(prefix))) {
        selected.add(`test/${name}`);
      }
    }
  }
  return [...selected].sort();
}

function runFast({ cwd = path.join(__dirname, '..'), files, env = process.env, spawn = spawnSync } = {}) {
  if (files === undefined) {
    const staged = spawn('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
      cwd, env, encoding: 'utf8', timeout: 120000,
    });
    if (staged.error) throw staged.error;
    if (staged.status !== 0) throw new Error(staged.stderr || 'Cannot read staged files');
    files = staged.stdout.split('\0').filter(Boolean);
  }
  const jsFiles = [...new Set(files.map(normalize).filter(file => file.endsWith('.js')))].sort();
  if (!jsFiles.length) return 0;
  const run = args => {
    const result = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', timeout: 120000 });
    if (result.error) throw result.error;
    return result.status === null ? 1 : result.status;
  };
  const eslint = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const lintStatus = run([eslint, '--', ...jsFiles]);
  if (lintStatus !== 0) return lintStatus;
  if (env.SKIP_TESTS) return 0;
  const testFiles = fs.readdirSync(path.join(cwd, 'test'), { withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => entry.name);
  for (const file of selectTests(jsFiles, testFiles)) {
    const status = run(['--test', '--test-concurrency=1', '--test-timeout=120000', file]);
    if (status !== 0) return status;
  }
  return 0;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args[0] !== '--files' || args.length < 2 || args.slice(1).some(arg => arg.startsWith('--')))) {
      throw new Error('Usage: node scripts/check-fast.js [--files <file> ...]');
    }
    process.exitCode = runFast({ files: args.length ? args.slice(1) : undefined });
  } catch (error) {
    console.error(`check-fast: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { selectTests, runFast };
