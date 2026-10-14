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

test('dropping a worker write fails equivalence against the unreconciled DB copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-worker-mutation-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures', 'projects-worker-equivalence.cjs')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir, PROJECTS_WORKER_DROP_WRITE: '1' },
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /session_cache effects must match on the unreconciled copy/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an injected slow real sweep persists folders and completes after its caller deadline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-worker-slow-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures', 'projects-worker-slow-reconcile.cjs')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /slow reconcile progress verified/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a hung real reconcile rejects outstanding waiters at its hard ceiling and restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-worker-hung-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures', 'projects-worker-slow-reconcile.cjs')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir, PROJECTS_WORKER_HUNG_RECONCILE: '1' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /hung reconcile ceiling verified/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a real reconcile emits no progress for unchanged folders and one message for a changed folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-worker-progress-'));
  try {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures', 'projects-worker-progress.cjs')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dir },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /unchanged and changed folder progress verified/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
