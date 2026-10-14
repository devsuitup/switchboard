'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('real isolated WAL DB applies file deltas without rewriting unchanged rows or leaving deleted FTS content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lists-db-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/file-lists-fts-db.cjs')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /incremental file FTS verified/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
