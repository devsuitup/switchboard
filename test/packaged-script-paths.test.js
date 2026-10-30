'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('../package.json');

const root = path.resolve(__dirname, '..');

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

test('scripts referenced from src are unpacked or read through Node fs before external use', () => {
  const scripts = ['src', 'scripts'].flatMap(dir => filesUnder(path.join(root, dir)))
    .filter(file => /\.(ps1|sh|cmd|bat)$/i.test(file));
  let references = 0;
  for (const file of filesUnder(path.join(root, 'src')).filter(file => file.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const script of scripts) {
      const basename = path.basename(script);
      if (!source.includes(basename)) continue;
      references++;
      const relative = path.relative(root, script).split(path.sep).join('/');
      const unpacked = build.asarUnpack.some(pattern => pattern === relative
        || (pattern.endsWith('/**') && relative.startsWith(pattern.slice(0, -2))));
      const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const readByFs = new RegExp(`\\bfs\\.readFileSync\\(\\s*path\\.(?:join|resolve)\\(__dirname,[^)]*['"]${escaped}['"][^)]*\\)`).test(source);
      assert.ok(unpacked || readByFs, `${path.relative(root, file)} references archived script ${relative} without reading it via fs`);
    }
  }
  assert.ok(references > 0, 'scan must discover script references');
});
