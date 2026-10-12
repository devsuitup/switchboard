'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect, makePlainDir } = require('./fixtures');

const appDir = path.resolve(__dirname, '..');
let existingDirectories;

test.beforeAll(() => {
  existingDirectories = new Set(fs.readdirSync(appDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name));
});

test.afterAll(() => {
  const newUnicodeDirectories = fs.readdirSync(appDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !existingDirectories.has(entry.name) && /[^\x00-\x7f]/.test(entry.name))
    .map(entry => entry.name);
  expect(newUnicodeDirectories).toEqual([]);
});

test('Electron confines relative native writes to the disposable home', async ({ home, launch }) => {
  makePlainDir(home);
  const { app } = await launch();
  const cwd = await app.evaluate(() => process.cwd());
  expect(cwd).toBe(home);
  const sentinel = 'native-relative-write-591.txt';
  await app.evaluate((_electron, name) => process.getBuiltinModule('fs').writeFileSync(name, 'fixture'), sentinel);
  expect(fs.readFileSync(path.join(home, sentinel), 'utf8')).toBe('fixture');
  expect(fs.existsSync(path.join(appDir, sentinel))).toBe(false);
});
