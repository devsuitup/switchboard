'use strict';

// listSettingKeys(prefix): the settings keys that start with a prefix, and
// only those. Same Electron-as-Node subprocess pattern as
// test/db-initial-scan-marker.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const electronBin = require('electron');

test('listSettingKeys returns the keys with the prefix, not those that merely contain it or use it as a pattern', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-setting-keys-'));
  try {
    const code = `
      const db = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      for (const k of ['global', 'project:/a', 'project:/b', 'xproject:/c', 'project_/d', 'project%']) db.setSetting(k, { v: 1 });
      console.log(JSON.stringify(db.listSettingKeys('project:').sort()));
    `;
    const r = spawnSync(electronBin, ['-e', code], {
      cwd: APP_DIR,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['project:/a', 'project:/b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
