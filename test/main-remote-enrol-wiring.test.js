'use strict';

// Reads main.js, preload.js and the Settings panel as text: the IPC and the
// button are glue that no test can load. Behaviour lives in
// test/remote-enrol.test.js and test/dom-remote-enrol-panel.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const settingsSrc = read('public/settings-panel.js');
const indexSrc = read('public/index.html');

const at = mainSrc.indexOf("ipcMain.handle('remote-host-enrol-check'");
const handler = at === -1 ? '' : mainSrc.slice(at, mainSrc.indexOf('\n});', at));

test('remote-host-enrol-check runs the check only for a host declared in the saved settings', () => {
  assert.notEqual(at, -1, 'main.js should register remote-host-enrol-check');
  assert.match(handler, /handleEnrolRequest\(\{ alias \}, \{/);
  assert.match(handler, /isDeclared: \(a\) => normalizeHosts\(\(getSetting\('global'\) \|\| \{\}\)\.remoteHosts\)\.some\(h => h\.alias === a\)/);
  assert.match(handler, /transport: remoteTransport/);
});

test('the preload exposes the check with the alias as its only argument', () => {
  assert.match(preloadSrc, /remoteHostEnrolCheck: \(alias\) => ipcRenderer\.invoke\('remote-host-enrol-check', alias\)/);
});

test('the Settings panel shows the checklist control for each host row and the script is loaded', () => {
  assert.match(settingsSrc, /wireRemoteEnrolControls\(/);
  assert.match(indexSrc, /<script src="remote-enrol-panel\.js"><\/script>/);
  assert.ok(indexSrc.indexOf('remote-enrol-panel.js') < indexSrc.indexOf('settings-panel.js'));
});
