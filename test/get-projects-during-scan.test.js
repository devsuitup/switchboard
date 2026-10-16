'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const mode of ['held', 'queued', 'effects']) {
  test(`cold get-projects serves SQLite rows during ${mode} scan writes`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-scan-6166f-'));
    try {
      const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/get-projects-during-scan.cjs'), mode], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /cached rows published before scan completion/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
