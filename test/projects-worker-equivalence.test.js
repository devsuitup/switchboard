'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a real readonly WAL worker matches synchronous views and reconcile effects on a fixture DB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-worker-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures', 'projects-worker-equivalence.cjs')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /equivalence verified/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
