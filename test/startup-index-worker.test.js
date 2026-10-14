'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('startup indexing preserves fixture results with bounded writes and no main bulk folder reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-index-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/startup-index-equivalence.cjs')], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /startup and refresh equivalence verified/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real worker remote full and subset rescans match the previous scanner and clear repair markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-index-equivalence-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/remote-index-equivalence.cjs')], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /remote full and subset equivalence verified/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
