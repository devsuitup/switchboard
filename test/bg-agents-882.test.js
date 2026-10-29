'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bg = require('../bg-agents');

function fixture(t, indexed = true) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bg-882-')));
  t.after(() => { bg.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const descriptors = [{ kind: 'interactive', sessionId: 'session-a', cwd: dir }];
  let descriptorChanged, lookups = 0, stats = 0, throws = 0;
  const stat = fs.statSync;
  const file = path.join(dir, 'session-a.jsonl');
  const resolveFile = () => { lookups++; return indexed ? file : null; };
  fs.writeFileSync(file, 'transcript');
  t.mock.method(fs, 'statSync', (p, opts) => {
    if (p === file || p === file + '.missing') stats++;
    try { return stat(p, opts); } catch (err) { throws++; throw err; }
  });
  bg.init({ jobsDir: path.join(dir, 'jobs'), homeDir: dir,
    runClaude: async () => ({ code: 0, stdout: '[]' }),
    resolveProjectRoots: async () => ({ projectRoot: dir, worktreeRoot: dir }),
    resolveTranscriptPath: resolveFile,
    transcriptExists: () => { const p = resolveFile(); return !!p && fs.statSync(p).isFile(); },
    cliSessionState: { readAllDescriptors: () => descriptors, ensureWatching() {},
      onDescriptorsChanged: cb => { descriptorChanged = cb; return () => {}; } },
  });
  bg.start();
  return { file, descriptors, counts: () => ({ lookups, stats, throws }),
    setIndexed: value => { indexed = value; }, change: () => descriptorChanged(),
    indexed: ids => bg.invalidateTranscripts(ids) };
}

function nextPush(action, allowUnchanged = false) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      if (allowUnchanged) resolve(bg.getSnapshot());
      else reject(new Error('roster push timed out'));
    }, 3000);
    const off = bg.onChange(snapshot => { clearTimeout(timer); off(); resolve(snapshot); });
    action();
  });
}

test('882 unchanged descriptor rebuilds reuse transcript lookup and stat, reconcile rechecks', async t => {
  const f = fixture(t);
  const first = await bg.reconcile();
  assert.equal(first.roster[0].transcriptAvailable, true);
  assert.deepEqual(f.counts(), { lookups: 1, stats: 1, throws: 0 });
  for (let n = 0; n < 4; n++) {
    await nextPush(() => { f.descriptors[0].name = 'revision-' + n; f.change(); });
  }
  assert.deepEqual(f.counts(), { lookups: 1, stats: 1, throws: 0 });
  await bg.reconcile();
  assert.equal(f.counts().stats, 2);
});

test('882 indexed transcript invalidates only its session and pushes availability without reconcile', async t => {
  const f = fixture(t, false);
  f.descriptors.push({ kind: 'interactive', sessionId: 'session-b' });
  assert.equal((await bg.reconcile()).roster[0].transcriptAvailable, false);
  assert.equal(f.counts().lookups, 2);
  assert.equal(typeof bg.invalidateTranscripts, 'function', 'index commits must be able to invalidate transcript availability');
  f.setIndexed(true);
  const snapshot = await nextPush(() => f.indexed(['SESSION-A']), true);
  assert.equal(snapshot.roster[0].transcriptAvailable, true);
  assert.equal(snapshot.roster[1].transcriptAvailable, false);
  assert.equal(f.counts().lookups, 3);
});

test('882 fallback path changes recheck and missing transcripts never throw', async t => {
  const f = fixture(t);
  bg.stop();
  let changed;
  fs.mkdirSync(path.join(path.dirname(f.file), 'jobs', 'aaaaaaaa'), { recursive: true });
  const state = path.join(path.dirname(f.file), 'jobs', 'aaaaaaaa', 'state.json');
  const write = file => fs.writeFileSync(state, JSON.stringify({ state: 'stopped', sessionId: '11111111-1111-4111-8111-111111111111', linkScanPath: file }));
  write(f.file);
  bg.init({ jobsDir: path.dirname(path.dirname(state)), homeDir: path.dirname(f.file),
    runClaude: async () => ({ code: 0, stdout: '[]' }),
    cliSessionState: { readAllDescriptors: () => [], ensureWatching() {}, onDescriptorsChanged: cb => { changed = cb; return () => {}; } },
    resolveProjectRoots: async () => null });
  bg.start();
  assert.equal((await bg.reconcile()).roster[0].transcriptAvailable, true);
  write(f.file + '.missing');
  const result = await nextPush(() => changed());
  assert.equal(result.roster[0].transcriptAvailable, false);
  assert.equal(f.counts().throws, 0);
});
