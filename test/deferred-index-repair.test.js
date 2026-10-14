'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('production database bootstrap defers bridge invalidation and repairs in bounded worker batches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-index-repair-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/deferred-index-repair.cjs')], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir, SWITCHBOARD_DEFER_CACHE_REPAIRS: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /deferred repair verified/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
