'use strict';

// The mirror's whole data path runs against an injected fake transport — no
// ssh, no network, no host. That is the point of the seam: the acceptance
// criteria of issue #201 are all reachable offline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncMirror, readManifest, MAX_CYCLE_FILES, MAX_CYCLE_BYTES } = require('../remote-mirror');
const { readSubagentMeta } = require('../read-session-file');

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
      return {
        files: Object.entries(files).map(([rel, f]) => ({
          rel, size: f.content.length, mtimeMs: f.mtimeMs,
        })),
        sessions: opts.sessions || [],
      };
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

// scp is bounded in time, never in bytes, and its output cap applies to stdout
// while the payload goes to the destination file. The inventory already carries
// size, so refusing an oversized transcript before the fetch is the only bound
// that exists. See .ai/contexts/session-cache.md, "Remote hosts".
test('a file above the per-file ceiling is never fetched', async () => {
  const dir = tmp('mirror-toobig');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'manifest.json');
    const asked = [];
    const transport = {
      listFiles: async () => ({
        files: [
          { rel: '-srv-a/small.jsonl', size: 10, mtimeMs: 1 },
          { rel: '-srv-a/huge.jsonl', size: 200 * 1024 * 1024, mtimeMs: 1 },
        ],
        sessions: [],
      }),
      fetchFiles: async (_alias, rels, destRoot) => {
        asked.push(...rels);
        for (const rel of rels) {
          const p = path.join(destRoot, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, 'x');
        }
        return { fetched: rels, failed: [] };
      },
    };
    const warned = [];
    await syncMirror({
      alias: 'vps', transport, projectsDir, manifestPath,
      log: { warn: (m) => warned.push(m), info() {}, error() {} },
    });
    assert.deepEqual(asked, ['-srv-a/small.jsonl'], 'the oversized file must never be asked for');
    assert.equal(fs.existsSync(path.join(projectsDir, '-srv-a/huge.jsonl')), false);
    assert.ok(warned.some(m => m.includes('skipped')), 'the skip must be reported, not silent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// issue #217: nothing bounded a whole cycle before this — a host back after a
// long outage could rebuild its entire mirror (hundreds of files) in one pull.
test('a per-cycle ceiling on file count defers the rest to the next cycle', async () => {
  const dir = tmp('mirror-cycle-files');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'manifest.json');
    const extra = 37;
    const entries = Array.from({ length: MAX_CYCLE_FILES + extra }, (_, i) => ({
      rel: `-srv-a/f${String(i).padStart(4, '0')}.jsonl`, size: 10, mtimeMs: 1,
    }));
    const asked = [];
    const transport = {
      listFiles: async () => ({ files: entries, sessions: [] }),
      fetchFiles: async (_alias, rels, destRoot) => {
        asked.push(...rels);
        for (const rel of rels) {
          const p = path.join(destRoot, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, 'x');
        }
        return { fetched: rels, failed: [] };
      },
    };
    const warned = [];
    const log = { warn: (m) => warned.push(m), info() {}, error() {} };

    const first = await syncMirror({ alias: 'vps', transport, projectsDir, manifestPath, log });
    assert.equal(first.fetched, MAX_CYCLE_FILES, 'the first cycle stops at the file-count ceiling');
    assert.equal(asked.length, MAX_CYCLE_FILES);
    assert.ok(warned.some(m => m.includes('deferred')), 'the deferral must be logged');

    asked.length = 0;
    const second = await syncMirror({ alias: 'vps', transport, projectsDir, manifestPath, log });
    assert.equal(second.fetched, extra, 'the deferred remainder is picked up next cycle');
    assert.equal(asked.length, extra);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a per-cycle ceiling on total bytes defers the rest to the next cycle', async () => {
  const dir = tmp('mirror-cycle-bytes');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'manifest.json');
    const fileSize = 60 * 1024 * 1024; // under MAX_FILE_BYTES; 4 of these fit under MAX_CYCLE_BYTES
    const entries = Array.from({ length: 6 }, (_, i) => ({
      rel: `-srv-a/big${i}.jsonl`, size: fileSize, mtimeMs: 1,
    }));
    const asked = [];
    const transport = {
      listFiles: async () => ({ files: entries, sessions: [] }),
      fetchFiles: async (_alias, rels, destRoot) => {
        asked.push(...rels);
        for (const rel of rels) {
          const p = path.join(destRoot, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, 'x');
        }
        return { fetched: rels, failed: [] };
      },
    };
    const warned = [];
    const log = { warn: (m) => warned.push(m), info() {}, error() {} };

    const first = await syncMirror({ alias: 'vps', transport, projectsDir, manifestPath, log });
    assert.equal(first.fetched, 4, 'the first cycle stops once a fifth file would exceed the byte ceiling');
    assert.deepEqual(asked, entries.slice(0, 4).map(e => e.rel));
    assert.ok(warned.some(m => m.includes('deferred') && m.includes('bytes')), 'the byte deferral must be logged');

    asked.length = 0;
    const second = await syncMirror({ alias: 'vps', transport, projectsDir, manifestPath, log });
    assert.equal(second.fetched, 2, 'the deferred remainder is picked up next cycle');
    assert.deepEqual(asked, entries.slice(4).map(e => e.rel));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a mirrored file that changed but got deferred is still refetched once room frees up', async () => {
  const dir = tmp('mirror-cycle-deferred-change');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'manifest.json');
    const targetRel = '-srv-z/target.jsonl';
    const state = { mtimeMs: 1 };
    const buildEntries = (withFillers) => [
      ...(withFillers ? Array.from({ length: MAX_CYCLE_FILES }, (_, i) => ({
        rel: `-srv-a/filler${String(i).padStart(4, '0')}.jsonl`, size: 10, mtimeMs: 1,
      })) : []),
      { rel: targetRel, size: 10, mtimeMs: state.mtimeMs },
    ];
    let withFillers = false;
    const asked = [];
    const transport = {
      listFiles: async () => ({ files: buildEntries(withFillers), sessions: [] }),
      fetchFiles: async (_alias, rels, destRoot) => {
        asked.push(...rels);
        for (const rel of rels) {
          const p = path.join(destRoot, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, rel === targetRel ? `mtime=${state.mtimeMs}` : 'x');
        }
        return { fetched: rels, failed: [] };
      },
    };
    const targetPath = path.join(projectsDir, ...targetRel.split('/'));

    // Cycle 1: target alone, fetched and mirrored.
    const first = await syncMirror({ alias: 'vps', transport, projectsDir, manifestPath });
    assert.equal(first.fetched, 1);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'mtime=1');

    // Cycle 2: target changes remotely, but a flood of new filler files fills
    // the per-cycle quota first (targetRel sorts after the fillers in
    // insertion order), so target is deferred without ever being attempted.
    state.mtimeMs = 2;
    withFillers = true;
    asked.length = 0;
    const second = await syncMirror({ alias: 'vps', transport, projectsDir, manifestPath });
    assert.equal(second.fetched, MAX_CYCLE_FILES, 'only the fillers fit this cycle');
    assert.ok(!asked.includes(targetRel), 'target was deferred, not attempted');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'mtime=1', 'target on disk is untouched by the deferred cycle');

    // Cycle 3: fillers now match the manifest and are skipped, freeing the
    // quota. The deferred file must still look "changed" and get refetched.
    withFillers = false;
    asked.length = 0;
    const third = await syncMirror({ alias: 'vps', transport, projectsDir, manifestPath });
    assert.equal(third.fetched, 1, 'the deferred file is picked up once room frees up');
    assert.deepEqual(asked, [targetRel]);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'mtime=2', 'the deferred change finally lands');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deletions still run on a cycle that hits the per-cycle ceiling', async () => {
  const dir = tmp('mirror-cycle-delete');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'manifest.json');
    const files = {
      '-srv-a/a.jsonl': { content: line('/srv/a'), mtimeMs: 1000 },
      '-srv-b/b.jsonl': { content: line('/srv/b'), mtimeMs: 2000 },
    };
    await syncMirror({ alias: 'vps', transport: fakeTransport(files), projectsDir, manifestPath });

    // b vanishes remotely; a flood of new files also blows the per-cycle
    // ceiling. The deletion of b must still run: a deferred cycle is not a
    // failed one. (PR #224 regressed a failed inventory into deleting
    // everything for a host — this proves a deferred cycle is not confused
    // with that case.)
    const extra = MAX_CYCLE_FILES + 10;
    const entries = [
      { rel: '-srv-a/a.jsonl', size: files['-srv-a/a.jsonl'].content.length, mtimeMs: 1000 },
      ...Array.from({ length: extra }, (_, i) => ({
        rel: `-srv-c/f${String(i).padStart(4, '0')}.jsonl`, size: 10, mtimeMs: 1,
      })),
    ];
    const transport = {
      listFiles: async () => ({ files: entries, sessions: [] }),
      fetchFiles: async (_alias, rels, destRoot) => {
        for (const rel of rels) {
          const p = path.join(destRoot, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, 'x');
        }
        return { fetched: rels, failed: [] };
      },
    };
    const warned = [];
    const r = await syncMirror({
      alias: 'vps', transport, projectsDir, manifestPath,
      log: { warn: (m) => warned.push(m), info() {}, error() {} },
    });

    assert.equal(r.fetched, MAX_CYCLE_FILES, 'the new-file flood is bounded');
    assert.equal(r.removed, 1, 'the deletion still runs: deferral is not a failure');
    assert.equal(fs.existsSync(path.join(projectsDir, '-srv-b', 'b.jsonl')), false);
    assert.equal(fs.existsSync(path.join(projectsDir, '-srv-b')), false);
    assert.ok(fs.existsSync(path.join(projectsDir, '-srv-a', 'a.jsonl')), 'the survivor is untouched');
    assert.ok(warned.some(m => m.includes('deferred')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// issue #211: a host with no ~/.claude/sessions dir still resolves normally.
test('a host with no sessions dir completes the cycle with zero descriptors', async () => {
  const dir = tmp('mirror-nosessions');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const t = fakeTransport({
      '-srv-a/a.jsonl': { content: line('/srv/a'), mtimeMs: 1000 },
    });

    const result = await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    assert.deepEqual(result.sessions, []);
    assert.equal(result.fetched, 1, 'inventory fetch/deletion behavior is unaffected');
    assert.ok(fs.existsSync(path.join(projectsDir, '-srv-a', 'a.jsonl')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// issue #244: readSubagentMeta() (read-session-file.js) is the real consumer
// of the mirrored sidecar — it derives the sidecar path from the jsonl path by
// suffix substitution, so the two must land in the same mirrored directory.
// See .ai/contexts/session-cache.md ("Remote hosts — meta.json sidecars").
test('a subagent .meta.json sidecar is mirrored next to its transcript, and readSubagentMeta finds it', async () => {
  const dir = tmp('mirror-meta-sidecar');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const jsonlRel = '-srv-x/parent-uuid/subagents/agent-1.jsonl';
    const metaRel = '-srv-x/parent-uuid/subagents/agent-1.meta.json';
    const t = fakeTransport({
      [jsonlRel]: { content: line('/srv/x'), mtimeMs: 1000 },
      [metaRel]: { content: JSON.stringify({ agentType: 'Explore', description: 'find things' }), mtimeMs: 1000 },
    });

    const r = await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    assert.equal(r.total, 2, 'both the transcript and its sidecar are in the inventory');
    assert.equal(r.fetched, 2);
    const mirroredJsonl = path.join(projectsDir, ...jsonlRel.split('/'));
    const mirroredMeta = path.join(projectsDir, ...metaRel.split('/'));
    assert.ok(fs.existsSync(mirroredJsonl));
    assert.ok(fs.existsSync(mirroredMeta));
    assert.deepEqual(readSubagentMeta(mirroredJsonl), { agentType: 'Explore', description: 'find things' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The sidecar's own rel path is meaningless to the file-subset rescan (it
// carries no session row of its own); it must be reported under its
// transcript's rel path instead, so a sidecar arriving alone still triggers a
// re-derive of the row that needs it.
test('a sidecar-only change is reported to the indexer under its transcript rel path', async () => {
  const dir = tmp('mirror-meta-changed');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const jsonlRel = '-srv-x/parent-uuid/subagents/agent-1.jsonl';
    const metaRel = '-srv-x/parent-uuid/subagents/agent-1.meta.json';
    // First cycle: transcript only, no sidecar yet on the host.
    const files = { [jsonlRel]: { content: line('/srv/x'), mtimeMs: 1000 } };
    await syncMirror({ alias: 'vps', transport: fakeTransport(files), projectsDir, manifestPath });

    // Second cycle: the sidecar shows up; the transcript itself is unchanged.
    files[metaRel] = { content: JSON.stringify({ agentType: 'Explore' }), mtimeMs: 2000 };
    const r = await syncMirror({ alias: 'vps', transport: fakeTransport(files), projectsDir, manifestPath });

    assert.equal(r.fetched, 1, 'only the sidecar is new');
    assert.ok(r.changedFolders.has('-srv-x'));
    const files1 = r.changedFilesByFolder.get('-srv-x');
    assert.ok(files1 && files1.has('parent-uuid/subagents/agent-1.jsonl'),
      'the transcript, not the sidecar, must be the file the indexer re-derives');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// issue #244 acceptance: no sidecar on the host must never be an error.
test('a subagent transcript with no sidecar on the host still mirrors cleanly', async () => {
  const dir = tmp('mirror-meta-absent');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'inventory.json');
    const jsonlRel = '-srv-x/parent-uuid/subagents/agent-1.jsonl';
    const t = fakeTransport({ [jsonlRel]: { content: line('/srv/x'), mtimeMs: 1000 } });

    const r = await syncMirror({ alias: 'vps', transport: t, projectsDir, manifestPath });

    assert.equal(r.total, 1);
    const mirroredJsonl = path.join(projectsDir, ...jsonlRel.split('/'));
    assert.ok(fs.existsSync(mirroredJsonl));
    assert.equal(readSubagentMeta(mirroredJsonl), null, 'no sidecar on disk, no error, just null');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// issue #244: sidecars are tiny but must never starve a transcript out of a
// full cycle. Fillers are all .jsonl transcripts (bigger consumers of the
// same per-cycle file quota) placed ahead of the sidecar in host `find`
// order — the priority sort must still put every transcript ahead of every
// sidecar regardless of listing order.
test('transcripts keep priority over .meta.json sidecars when a cycle is full', async () => {
  const dir = tmp('mirror-meta-priority');
  try {
    const projectsDir = path.join(dir, 'projects');
    const manifestPath = path.join(dir, 'manifest.json');
    const metaRel = '-srv-a/parent/subagents/agent-1.meta.json';
    const entries = [
      { rel: metaRel, size: 10, mtimeMs: 1 },
      ...Array.from({ length: MAX_CYCLE_FILES }, (_, i) => ({
        rel: `-srv-a/f${String(i).padStart(4, '0')}.jsonl`, size: 10, mtimeMs: 1,
      })),
    ];
    const asked = [];
    const transport = {
      listFiles: async () => ({ files: entries, sessions: [] }),
      fetchFiles: async (_alias, rels, destRoot) => {
        asked.push(...rels);
        for (const rel of rels) {
          const p = path.join(destRoot, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, 'x');
        }
        return { fetched: rels, failed: [] };
      },
    };
    const warned = [];
    const r = await syncMirror({
      alias: 'vps', transport, projectsDir, manifestPath,
      log: { warn: (m) => warned.push(m), info() {}, error() {} },
    });

    assert.equal(r.fetched, MAX_CYCLE_FILES, 'the cycle is exactly full of transcripts');
    assert.ok(!asked.includes(metaRel), 'the sidecar was deferred even though it was listed first');
    assert.ok(warned.some(m => m.includes('deferred')));

    asked.length = 0;
    const second = await syncMirror({ alias: 'vps', transport, projectsDir, manifestPath, log: { warn: () => {}, info() {}, error() {} } });
    assert.equal(second.fetched, 1, 'the deferred sidecar is picked up once the transcripts are unchanged');
    assert.deepEqual(asked, [metaRel], 'the deferred sidecar is picked up once the transcripts are unchanged');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
