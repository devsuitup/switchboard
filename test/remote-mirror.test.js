'use strict';

// The mirror's whole data path runs against an injected fake transport — no
// ssh, no network, no host. That is the point of the seam: the acceptance
// criteria of issue #201 are all reachable offline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncMirror, readManifest } = require('../remote-mirror');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-' + name + '-'));
}

/** Fake host: a plain object of rel -> content, plus a call log. */
function fakeTransport(files, opts = {}) {
  const calls = { list: 0, fetch: 0, fetched: [] };
  return {
    calls,
    async listFiles() {
      calls.list++;
      if (opts.listThrows) throw new Error(opts.listThrows);
      return Object.entries(files).map(([rel, f]) => ({
        rel, size: f.content.length, mtimeMs: f.mtimeMs,
      }));
    },
    async fetchFiles(alias, rels, destRoot) {
      calls.fetch++;
      const fetched = [];
      const failed = [];
      for (const rel of rels) {
        calls.fetched.push(rel);
        if (opts.failFetchOf && opts.failFetchOf.includes(rel)) { failed.push(rel); continue; }
        const dest = path.join(destRoot, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, files[rel].content, 'utf8');
        fetched.push(rel);
      }
      return { fetched, failed };
    },
  };
}

function line(cwd) {
  return JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }) + '\n';
}

test('first pull fetches everything and records folders to index', async () => {
  const dir = tmp('mirror');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const t = fakeTransport({
      '-srv-supervision/a.jsonl': { content: line('/srv/supervision'), mtimeMs: 1000 },
      '-srv-orchestration/b.jsonl': { content: line('/srv/orchestration'), mtimeMs: 2000 },
    });

    const r = await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    assert.equal(r.fetched, 2);
    assert.equal(r.total, 2);
    assert.deepEqual([...r.changedFolders].sort(), ['-srv-orchestration', '-srv-supervision']);
    assert.ok(fs.existsSync(path.join(projectsDir, '-srv-supervision', 'a.jsonl')));
    assert.equal(Object.keys(readManifest(manifestPath)).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a second pull with an unchanged inventory transfers nothing', async () => {
  const dir = tmp('mirror-idem');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const files = {
      '-srv-supervision/a.jsonl': { content: line('/srv/supervision'), mtimeMs: 1000 },
      '-srv-orchestration/b.jsonl': { content: line('/srv/orchestration'), mtimeMs: 2000 },
    };
    const t = fakeTransport(files);

    await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });
    const before = t.calls.fetched.length;

    const second = await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    assert.equal(second.fetched, 0, 'nothing should be re-fetched');
    assert.equal(second.unchanged, 2);
    assert.equal(second.changedFolders.size, 0, 'nothing to re-index');
    assert.equal(t.calls.fetched.length, before, 'transport.fetchFiles must not be asked for a file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only the changed file is re-fetched when its mtime moves', async () => {
  const dir = tmp('mirror-delta');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const files = {
      '-srv-a/a.jsonl': { content: line('/srv/a'), mtimeMs: 1000 },
      '-srv-b/b.jsonl': { content: line('/srv/b'), mtimeMs: 2000 },
    };
    const t = fakeTransport(files);
    await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    files['-srv-b/b.jsonl'] = { content: line('/srv/b') + line('/srv/b'), mtimeMs: 3000 };
    t.calls.fetched.length = 0;
    const r = await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    assert.deepEqual(t.calls.fetched, ['-srv-b/b.jsonl']);
    assert.deepEqual([...r.changedFolders], ['-srv-b']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file gone from the remote inventory is dropped from the mirror', async () => {
  const dir = tmp('mirror-del');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const files = {
      '-srv-a/a.jsonl': { content: line('/srv/a'), mtimeMs: 1000 },
      '-srv-b/b.jsonl': { content: line('/srv/b'), mtimeMs: 2000 },
    };
    const t = fakeTransport(files);
    await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    delete files['-srv-b/b.jsonl'];
    const r = await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    assert.equal(r.removed, 1);
    assert.equal(fs.existsSync(path.join(projectsDir, '-srv-b', 'b.jsonl')), false);
    assert.equal(fs.existsSync(path.join(projectsDir, '-srv-b')), false, 'the emptied folder goes too');
    assert.ok(fs.existsSync(path.join(projectsDir, '-srv-a', 'a.jsonl')), 'the survivor is untouched');
    assert.ok(r.changedFolders.has('-srv-b'), 'the emptied folder must be re-indexed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an inventory that fails leaves the mirror byte-identical', async () => {
  const dir = tmp('mirror-fail');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const files = { '-srv-a/a.jsonl': { content: line('/srv/a'), mtimeMs: 1000 } };
    await syncMirror({ alias: 'vps', transport: fakeTransport(files), projectsDir, manifestPath });
    const before = fs.readFileSync(path.join(projectsDir, '-srv-a', 'a.jsonl'), 'utf8');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');

    const dead = fakeTransport(files, { listThrows: 'ssh: connect to host vps port 22: timed out' });
    await assert.rejects(
      () => syncMirror({ alias: 'vps', transport: dead, projectsDir, manifestPath }),
      /timed out/
    );

    assert.equal(fs.readFileSync(path.join(projectsDir, '-srv-a', 'a.jsonl'), 'utf8'), before);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestBefore);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fetch that fails mid-run keeps the previous mirror and retries next time', async () => {
  const dir = tmp('mirror-partial');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const files = {
      '-srv-a/a.jsonl': { content: line('/srv/a'), mtimeMs: 1000 },
      '-srv-b/b.jsonl': { content: line('/srv/b'), mtimeMs: 2000 },
    };
    await syncMirror({ alias: 'vps', transport: fakeTransport(files), projectsDir, manifestPath });

    // b vanishes remotely AND c cannot be fetched: the deletion of b must not
    // happen on a run that did not complete.
    delete files['-srv-b/b.jsonl'];
    files['-srv-c/c.jsonl'] = { content: line('/srv/c'), mtimeMs: 4000 };
    const flaky = fakeTransport(files, { failFetchOf: ['-srv-c/c.jsonl'] });
    const r = await syncMirror({ alias: 'vps', transport: flaky, projectsDir, manifestPath });

    assert.equal(r.failed, 1);
    assert.equal(r.removed, 0, 'no deletion on a partial run');
    assert.ok(fs.existsSync(path.join(projectsDir, '-srv-b', 'b.jsonl')), 'previous mirror intact');

    // Next run, the host is healthy again: c arrives, b is dropped.
    const healthy = fakeTransport(files);
    const second = await syncMirror({ alias: 'vps', transport: healthy, projectsDir, manifestPath });
    assert.deepEqual(healthy.calls.fetched, ['-srv-c/c.jsonl'], 'only the file that failed is retried');
    assert.equal(second.removed, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unsafe rel path from the host is refused, not joined onto a local dir', async () => {
  const dir = tmp('mirror-evil');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const t = fakeTransport({
      '-srv-a/a.jsonl': { content: line('/srv/a'), mtimeMs: 1000 },
      '../../../escape.jsonl': { content: 'x', mtimeMs: 1 },
      "-srv-a/x';id;'.jsonl": { content: 'x', mtimeMs: 1 },
      'toplevel.jsonl': { content: 'x', mtimeMs: 1 },
    });

    const r = await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    assert.equal(r.total, 1, 'only the well-formed entry survives');
    assert.deepEqual(t.calls.fetched, ['-srv-a/a.jsonl']);
    assert.equal(fs.existsSync(path.join(dir, '..', 'escape.jsonl')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
