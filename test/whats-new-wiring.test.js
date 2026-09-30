// Reads main.js and preload.js as TEXT: the What's new glue is still written
// down. The behaviour is exercised in test/changelog.test.js and
// test/whats-new.test.js. See docs/changelog.md.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SETTING_DEFAULTS } = require('../public/setting-defaults');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

test('lastSeenVersion has its default in the shared table, and it is "none recorded"', () => {
  assert.ok('lastSeenVersion' in SETTING_DEFAULTS);
  assert.equal(SETTING_DEFAULTS.lastSeenVersion, null);
});

test('main reads CHANGELOG.md from the app directory, so the packaged copy is the one read', () => {
  assert.match(MAIN, /path\.join\(__dirname, 'CHANGELOG\.md'\)/);
});

test('whether the install predates this launch is read when main loads, before this run writes a setting', () => {
  const at = MAIN.indexOf("const INSTALL_PREDATES_LAUNCH = getSetting('global') !== null || isInitialScanComplete();");
  assert.notEqual(at, -1);
  assert.ok(at < MAIN.indexOf('function createWindow'), 'it must run at load, not when a window opens');
  assert.ok(at > MAIN.indexOf("} = require('./db');"));
});

test('main builds the What\'s new service from the running version, that signal and the shared default', () => {
  const at = MAIN.indexOf('const whatsNew = createWhatsNew({');
  assert.notEqual(at, -1);
  const args = MAIN.slice(at, MAIN.indexOf('});', at));
  assert.match(args, /currentVersion: app\.getVersion\(\)/);
  assert.match(args, /existingInstall: INSTALL_PREDATES_LAUNCH/);
  assert.match(args, /lastSeenDefault: SETTING_DEFAULTS\.lastSeenVersion/);
  assert.match(args, /getSetting,\s*setSetting,/);
  assert.match(args, /\blog,/);
});

test('the IPC handlers and the menu entry go through the service', () => {
  assert.match(MAIN, /ipcMain\.handle\('whats-new-startup', \(\) => whatsNew\.startup\(\)\);/);
  assert.match(MAIN, /ipcMain\.handle\('whats-new-dismissed', \(\) => whatsNew\.dismissed\(\)\);/);
  const at = MAIN.indexOf('function showWhatsNewFromMenu()');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(body, /const payload = whatsNew\.forMenu\(\);\s*if \(payload\) mainWindow\.webContents\.send\('show-whats-new', payload\);/);
});

test('preload exposes the three calls the dialog uses', () => {
  assert.match(PRELOAD, /whatsNewStartup: \(\) => ipcRenderer\.invoke\('whats-new-startup'\)/);
  assert.match(PRELOAD, /whatsNewDismissed: \(\) => ipcRenderer\.invoke\('whats-new-dismissed'\)/);
  assert.match(PRELOAD, /onShowWhatsNew: \(callback\) => \{\s*ipcRenderer\.on\('show-whats-new', \(_event, payload\) => callback\(payload\)\);/);
});
