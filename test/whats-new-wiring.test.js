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

function handlerBody(channel) {
  const at = MAIN.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(at, -1, `main.js must handle ${channel}`);
  return MAIN.slice(at, MAIN.indexOf('\n});', at));
}

test('lastSeenVersion has its default in the shared table, and it is "none recorded"', () => {
  assert.ok('lastSeenVersion' in SETTING_DEFAULTS);
  assert.equal(SETTING_DEFAULTS.lastSeenVersion, null);
});

test('main reads CHANGELOG.md from the app directory, so the packaged copy is the one read', () => {
  assert.match(MAIN, /path\.join\(__dirname, 'CHANGELOG\.md'\)/);
});

test('whats-new-startup decides from the app version and the stored lastSeenVersion, logs an error, records what it is told', () => {
  const body = handlerBody('whats-new-startup');
  assert.match(body, /whatsNewOnStartup\(\{\s*currentVersion,\s*lastSeenVersion,\s*readChangelog\s*\}\)/);
  assert.match(body, /const currentVersion = app\.getVersion\(\)/);
  assert.match(body, /\.lastSeenVersion \?\? SETTING_DEFAULTS\.lastSeenVersion/);
  assert.match(body, /if \(error\) log\.warn\(/);
  assert.match(body, /if \(record\) recordLastSeenVersion\(record\)/);
});

test('whats-new-dismissed records the running version, whatever the renderer sends', () => {
  const body = handlerBody('whats-new-dismissed');
  assert.match(body, /recordLastSeenVersion\(app\.getVersion\(\)\)/);
  assert.doesNotMatch(body, /\(_event,/);
});

test('the menu entry sends the current section to the renderer, and only logs when there is none', () => {
  const at = MAIN.indexOf('function showWhatsNewFromMenu()');
  assert.notEqual(at, -1);
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(body, /whatsNewForVersion\(\{\s*currentVersion,\s*readChangelog\s*\}\)/);
  assert.match(body, /log\.warn\(/);
  assert.match(body, /webContents\.send\('show-whats-new'/);
});

test('preload exposes the three calls the dialog uses', () => {
  assert.match(PRELOAD, /whatsNewStartup: \(\) => ipcRenderer\.invoke\('whats-new-startup'\)/);
  assert.match(PRELOAD, /whatsNewDismissed: \(\) => ipcRenderer\.invoke\('whats-new-dismissed'\)/);
  assert.match(PRELOAD, /onShowWhatsNew: \(callback\) => \{\s*ipcRenderer\.on\('show-whats-new', \(_event, payload\) => callback\(payload\)\);/);
});
