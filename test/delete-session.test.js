// Wiring checks for the Delete Session action.
//
// The guards themselves — id validation, symlink resolution, containment within
// PROJECTS_DIR, target selection — are EXECUTED against real paths and symlinks
// in test/delete-session-target.test.js. Regex-matching main.js proved nothing:
// the review neutered the containment check while leaving the matched substring
// in place and every assertion here still passed. What remains below is only
// what cannot be reached without electron: that the handler is wired to the
// extracted module, cleans up the rows it owns, and that the UI confirms.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('21: Delete delegates conversation membership to the shared resolver', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf('function getConversationPartIds(');
  const body = main.slice(start, main.indexOf('\n}', start));
  assert.match(body, /sessionCache\.conversationMemberIds\(rows, canonicalId\)/);
});

test('delete-session: the IPC handler exists and is exposed to the renderer', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('delete-session'/);
  assert.match(preload, /deleteSession: \(id, partIds\) => ipcRenderer\.invoke\('delete-session', id, partIds\)/);
});


test('delete-session: the liveness guard runs before anything is resolved or removed', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));
  const guard = body.indexOf('await deleteSessionGuard(id, partIds)');
  assert.ok(guard > 0, 'the handler asks delete-session-guard.js (behaviour tested in delete-session-guard.test.js)');
  assert.match(main, /const deleteSessionGuard = makeDeleteSessionGuard\(\{\s*activeSessions, bgAgents, cliSessionState, sessionHasPty, ptyPids,/,
    'the guard is built from the real modules, not stubs');
  assert.ok(guard < body.indexOf('resolveRowDeletionTargets('));
  assert.match(body, /if \(refusal\) return \{ ok: false, error: refusal \}/);
});

test('delete-session: clears the caches so the row does not reappear', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));
  // Cleared for the parent and every subagent in one loop.
  assert.match(body, /deleteCachedSession\(sid\)/, 'session cache rows must go');
  assert.match(body, /deleteSearchSession\(sid\)/, 'search index entries must go');
});

test('delete button: rendered on session cards and confirms before deleting', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'sidebar.js'), 'utf8');
  assert.match(sidebar, /deleteBtn\.className = 'session-delete-btn'/);
  assert.match(sidebar, /actions\.appendChild\(deleteBtn\)/, 'the button must actually be placed on the card');

  const start = sidebar.indexOf("item.querySelector('.session-delete-btn')");
  // Slice to the next handler rather than a fixed length — the block grew and a
  // fixed window silently dropped the assertions off the end.
  const handler = sidebar.slice(start, sidebar.indexOf('const archiveBtn', start));
  assert.match(handler, /await showDeleteSessionDialog\(session\)/,
    'an irreversible action must be confirmed, via the styled dialog');
  // issue #271: a running LOCAL session is stopped via the shared
  // stop-then-archive/delete helper (stopBeforeArchive, public/stop-session-ui.js);
  // a REMOTE session must skip the stop entirely — delete is refused
  // server-side for remote regardless (REMOTE_READ_ONLY, main.js), so
  // stopping first would strand a killed process behind a delete that never
  // happens.
  assert.match(handler, /stopBeforeArchive\(session\)/,
    'a running session must be stopped before deletion, via the shared helper');
  assert.match(handler, /resolveSessionStop\(session\)\.remote/,
    'the stop must be skipped for a remote session — delete is refused server-side for remote anyway');
  assert.match(handler, /window\.api\.deleteSession/);
  assert.doesNotMatch(handler, /window\.alert\(/,
    'alert() is modal and hard to dismiss — a failure must not block the renderer');
  assert.match(handler, /surfaceStopFailure\(deleteBtn,.*'Delete'\)/, 'a refusal must surface through the persistent notice adapter');
  assert.match(handler, /pendingSessions\.delete\(id\)/,
    'the sidebar re-injects transcript-less sessions, so the pending entry must be forgotten too');

  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.match(css, /\.session-delete-btn:hover \{/, 'delete should read as danger on hover');
});

test('delete-session: a session with no transcript is dismissed, not refused', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));

  // Regression: launchNewSession shows a card before claude starts, so a failed
  // launch leaves a session with nothing on disk. Refusing those made the very
  // cards a user wants gone undeletable ("no transcript found for that session").
  assert.match(body, /if \(!removed\.length\) \{/, 'the empty case must be handled explicitly');
  const empty = body.slice(body.indexOf('if (!removed.length) {'));
  assert.match(empty, /ok: true/, 'a placeholder must be reported as deleted, not as a failure');
  assert.match(empty, /placeholder: true/, 'the caller should be able to tell the two apart');
  // The cache clearing happens just above, for the parent and its subagents
  // alike, so it covers the placeholder case without repeating itself.
  assert.match(body, /for \(const sid of deletedIds\)/,
    'caches must still be cleared for a placeholder');
});

test('delete-session: delegates its guards to the executable module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(src, /require\('\.\/delete-session-target'\)/,
    'validation must live in the module the tests can execute, not inline in main.js');
  const start = src.indexOf("ipcMain.handle('delete-session'");
  const body = src.slice(start, src.indexOf('\n});', start));
  assert.match(body, /resolveRowDeletionTargets\(PROJECTS_DIR, id, memberIds,/);
  assert.match(body, /getCachedFolder\(partId\)/, 'the cached folder makes the lookup O(1)');
  assert.match(body, /resolved\.refused/, 'a refused target must be logged, not silently dropped');
});

test('delete-session: clears subagent rows, which are indexed under their own ids', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('delete-session'");
  const body = src.slice(start, src.indexOf('\n});', start));

  // Subagent transcripts live inside the parent directory and go with it, but
  // they are cached under `sub:<parent>:<agent>` ids. Left behind, the sidebar
  // renders them as a phantom "Orphan subagents" group and search returns hits
  // for deleted files.
  assert.match(body, /getCachedByParent\(partId\)/, 'subagent rows must be collected');
  const collect = body.indexOf('getCachedByParent(partId)');
  const remove = body.indexOf('fs.rmSync');
  assert.ok(collect < remove, 'they must be collected BEFORE the files are removed');
  assert.match(body, /for \(const sid of deletedIds\)/,
    'the parent and every subagent row must be cleared');
});

test('delete button: uses the styled dialog, not a renderer-blocking native prompt', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'sidebar.js'), 'utf8');
  assert.match(sidebar, /async function showDeleteSessionDialog/, 'the dialog must exist');
  assert.doesNotMatch(sidebar, /window\.confirm\(/,
    'confirm() blocks the whole renderer, including every other live terminal');

  const start = sidebar.indexOf('async function showDeleteSessionDialog');
  const dlg = sidebar.slice(start, sidebar.indexOf('// --- Delete worktree', start));
  assert.match(dlg, /deleteSessionPreview/, 'it must state what will be lost');
  assert.match(dlg, /Archive/, 'and point at the non-destructive alternative');
});

test('delete button: closes the tab so it cannot point at a deleted transcript', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'sidebar.js'), 'utf8');
  const start = sidebar.indexOf("item.querySelector('.session-delete-btn')");
  const handler = sidebar.slice(start, sidebar.indexOf('const archiveBtn', start));
  assert.match(handler, /destroySession\(id\)/);
});

test('preview and delete use the same merged member source as the liveness guard', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  for (const name of ['delete-session-preview', 'delete-session']) {
    const start = main.indexOf(`ipcMain.handle('${name}'`);
    const body = main.slice(start, main.indexOf('\n});', start));
    assert.match(body, /const memberIds = \[\.\.\.getMergedMemberIds\(id\)\]/);
    assert.match(body, /resolveRowDeletionTargets\(PROJECTS_DIR, id, memberIds,/);
  }
  assert.match(main, /sessionHasPty, ptyPids,\s*getMergedMemberIds[,\s]/);
});

const os = require('node:os');
const { loadDeletionHandlers } = require('./delete-session-harness');

function deletionFixture(t, memberIds = ['b']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delete-row-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = 'project';
  fs.mkdirSync(path.join(root, folder));
  const cached = new Set(['a', 'b', 'sub:a:x', 'sub:b:y']);
  const search = new Set(cached);
  const touched = new Set(cached);
  const a = path.join(root, folder, 'a.jsonl');
  const b = path.join(root, folder, 'b.jsonl');
  fs.writeFileSync(a, '{}\n');
  fs.writeFileSync(b, '{}\n');
  const dependencies = {
    PROJECTS_DIR: root,
    getCachedFolder: () => folder,
    getMergedMemberIds: () => memberIds,
    getCachedByParent: id => [{ sessionId: `sub:${id}:${id === 'a' ? 'x' : 'y'}` }],
    deleteCachedSession: id => cached.delete(id),
    deleteSearchSession: id => search.delete(id),
    mainTouchedCache: { dropSession: id => touched.delete(id) },
  };
  return { root, a, b, cached, search, touched, dependencies };
}

test('preview counts all parts and deletion clears every part and subagent from every cache', async t => {
  const f = deletionFixture(t);
  const handlers = loadDeletionHandlers(f.dependencies);
  const preview = handlers.get('delete-session-preview')(null, 'a');
  assert.equal(preview.parts, 2);
  assert.equal(preview.subagents, 2);
  assert.equal(preview.transcripts, 2);
  const result = await handlers.get('delete-session')(null, 'a', preview.partIds);
  assert.equal(result.ok, true);
  assert.equal(result.subagents, 2);
  for (const entries of [f.cached, f.search, f.touched]) assert.equal(entries.size, 0);
  assert.equal(fs.existsSync(f.a), false);
  assert.equal(fs.existsSync(f.b), false);
});

test('an unresolved member refuses preview and deletion without removing files or cache rows', async t => {
  const f = deletionFixture(t, ['b', 'missing']);
  const handlers = loadDeletionHandlers(f.dependencies);
  const preview = handlers.get('delete-session-preview')(null, 'a');
  const result = await handlers.get('delete-session')(null, 'a', ['a', 'b', 'missing']);
  for (const out of [preview, result]) {
    assert.equal(out.ok, false);
    assert.match(out.error, /missing/);
  }
  assert.equal(fs.existsSync(f.a), true);
  assert.equal(fs.existsSync(f.b), true);
  for (const entries of [f.cached, f.search, f.touched]) assert.equal(entries.size, 4);
});

test('an unreadable member folder refuses the whole delete', async t => {
  const f = deletionFixture(t);
  f.dependencies.getCachedFolder = id => { if (id === 'b') throw new Error('folder lookup failed'); return 'project'; };
  const handlers = loadDeletionHandlers(f.dependencies);
  const result = await handlers.get('delete-session')(null, 'a', ['a', 'b']);
  assert.equal(result.ok, false);
  assert.match(result.error, /folder lookup failed/);
  assert.equal(fs.existsSync(f.a), true);
  assert.equal(fs.existsSync(f.b), true);
});

test('the live-part guard refuses before any folder lookup or removal', async t => {
  const f = deletionFixture(t);
  f.dependencies.deleteSessionGuard = async () => 'member is live';
  f.dependencies.getCachedFolder = () => { throw new Error('must not resolve'); };
  const handlers = loadDeletionHandlers(f.dependencies);
  const result = await handlers.get('delete-session')(null, 'a', ['a', 'b']);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'member is live');
  assert.equal(fs.existsSync(f.a), true);
  assert.equal(fs.existsSync(f.b), true);
});

test('unknown subagent lookup refuses preview and delete before any removal', async t => {
  const f = deletionFixture(t);
  f.dependencies.getCachedByParent = id => { if (id === 'b') throw new Error('subagents unavailable'); return []; };
  const handlers = loadDeletionHandlers(f.dependencies);
  for (const name of ['delete-session-preview', 'delete-session']) {
    const result = await handlers.get(name)(null, 'a', ['a', 'b']);
    assert.equal(result.ok, false);
    assert.match(result.error, /subagents unavailable/);
  }
  assert.equal(fs.existsSync(f.a), true);
  assert.equal(fs.existsSync(f.b), true);
});

const { makeDeleteSessionGuard } = require('../delete-session-guard');

test('a part joining during the real liveness guard refuses deletion and preserves every transcript', async t => {
  const members = ['b'];
  const f = deletionFixture(t, members);
  const c = path.join(f.root, 'project', 'c.jsonl');
  fs.writeFileSync(c, '{}\n');
  const checked = [];
  f.dependencies.deleteSessionGuard = makeDeleteSessionGuard({
    activeSessions: new Map(), bgAgents: { liveJobCheck: () => ({ known: true }) },
    cliSessionState: { liveElsewhereChecked: async id => {
      checked.push(id);
      if (id === 'a') { await Promise.resolve(); members.push('c'); }
      return { known: true, live: null };
    } },
    getMergedMemberIds: () => members,
  });
  const result = await loadDeletionHandlers(f.dependencies).get('delete-session')(null, 'a', ['a', 'b']);
  assert.equal(result.ok, false);
  assert.match(result.error, /the conversation changed while checking; try Delete again/i);
  assert.deepEqual(checked, ['a', 'b']);
  for (const file of [f.a, f.b, c]) assert.equal(fs.existsSync(file), true);
  assert.equal(f.cached.size, 4);
});

test('the guard checks the explicit snapshot even when its member source changes', async () => {
  const checked = [];
  const guard = makeDeleteSessionGuard({
    activeSessions: new Map(), bgAgents: { liveJobCheck: () => ({ known: true }) },
    cliSessionState: { liveElsewhereChecked: async id => { checked.push(id); return { known: true }; } },
    getMergedMemberIds: () => ['unchecked-new-member'],
  });
  assert.equal(await guard('a', ['a', 'b']), null);
  assert.deepEqual(checked, ['a', 'b']);
});

test('the handler gives the real guard its deletion snapshot rather than letting it re-read members', async t => {
  const f = deletionFixture(t);
  const checked = [];
  f.dependencies.deleteSessionGuard = makeDeleteSessionGuard({
    activeSessions: new Map(), bgAgents: { liveJobCheck: () => ({ known: true }) },
    cliSessionState: { liveElsewhereChecked: async id => { checked.push(id); return { known: true }; } },
    getMergedMemberIds: () => ['different-at-guard-time'],
  });
  const result = await loadDeletionHandlers(f.dependencies).get('delete-session')(null, 'a', ['a', 'b']);
  assert.equal(result.ok, true);
  assert.deepEqual(checked, ['a', 'b']);
});

test('deletion refuses added or removed preview parts but accepts a reordered set', async t => {
  const f = deletionFixture(t);
  const del = loadDeletionHandlers(f.dependencies).get('delete-session');
  for (const shown of [['a'], ['a', 'b', 'c'], undefined]) {
    const result = await del(null, 'a', shown);
    assert.equal(result.ok, false);
    assert.match(result.error, /the conversation changed while checking; try Delete again/i);
    assert.equal(fs.existsSync(f.a), true);
    assert.equal(fs.existsSync(f.b), true);
  }
  assert.equal((await del(null, 'a', ['b', 'a', 'b'])).ok, true);
});

test('a middle-part EBUSY keeps the head listed, clears completed parts and allows a fresh-preview retry', async t => {
  const f = deletionFixture(t, ['b', 'c', 'd']);
  for (const id of ['c', 'd']) {
    fs.writeFileSync(path.join(f.root, 'project', id + '.jsonl'), '{}\n');
    for (const entries of [f.cached, f.search, f.touched]) entries.add(id);
  }
  f.dependencies.getMergedMemberIds = () => ['b', 'c', 'd'].filter(id => f.cached.has(id));
  const rm = fs.rmSync;
  const attempted = [];
  f.dependencies.fs = { ...fs, rmSync: (file, options) => {
    attempted.push(path.basename(file));
    if (file.endsWith('d.jsonl')) throw Object.assign(new Error('EBUSY: foreign handle'), { code: 'EBUSY' });
    return rm(file, options);
  } };
  const handlers = loadDeletionHandlers(f.dependencies);
  const result = await handlers.get('delete-session')(null, 'a', ['a', 'b', 'c', 'd']);
  assert.equal(result.ok, false);
  assert.match(result.error, /Deleted 2 of 4 parts;.*EBUSY.*Try Delete again\./);
  assert.match(result.error, /Removed: b, c; remaining: a, d/);
  assert.deepEqual(Array.from(result.removedPartIds), ['b', 'c']);
  assert.deepEqual(attempted, ['b.jsonl', 'c.jsonl', 'd.jsonl']);
  assert.equal(fs.existsSync(f.a), true);
  assert.equal(f.cached.has('a'), true, 'head is still listed');
  for (const entries of [f.cached, f.search, f.touched]) {
    for (const id of ['b', 'c', 'sub:b:y']) assert.equal(entries.has(id), false, id);
    for (const id of ['a', 'd']) assert.equal(entries.has(id), true, id);
  }
  f.dependencies.fs = fs;
  const retry = loadDeletionHandlers(f.dependencies);
  const preview = retry.get('delete-session-preview')(null, 'a');
  assert.equal(preview.parts, 2);
  assert.equal((await retry.get('delete-session')(null, 'a', preview.partIds)).ok, true);
  assert.equal(f.cached.size, 0);
  assert.equal(f.search.size, 0);
  assert.equal(fs.existsSync(f.a), false);
});

test('a failed head directory removal keeps its transcript and incomplete cache for retry', async t => {
  const f = deletionFixture(t);
  const dir = path.join(f.root, 'project', 'a');
  fs.mkdirSync(dir);
  f.dependencies.fs = { ...fs, rmSync: (file, options) => {
    if (file === dir) throw new Error('EBUSY head directory');
    return fs.rmSync(file, options);
  } };
  const result = await loadDeletionHandlers(f.dependencies).get('delete-session')(null, 'a', ['a', 'b']);
  assert.equal(result.ok, false);
  assert.match(result.error, /Deleted 1 of 2 parts/);
  assert.equal(fs.existsSync(f.a), true);
  assert.equal(f.cached.has('a'), true);
  assert.equal(f.cached.has('b'), false);
});

test('preview counts transcript files separately from subagent directories and returns its exact parts', t => {
  const f = deletionFixture(t);
  fs.mkdirSync(path.join(f.root, 'project', 'b', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'project', 'b', 'subagents', 'agent-y.jsonl'), '{}\n');
  const preview = loadDeletionHandlers(f.dependencies).get('delete-session-preview')(null, 'a');
  assert.equal(preview.transcripts, 2);
  assert.equal(preview.subagents, 2);
  assert.deepEqual(Array.from(preview.partIds), ['a', 'b']);
});

for (const remoteId of ['a', 'b']) {
  test(`remote part ${remoteId} refuses preview and delete before removal`, async t => {
    const f = deletionFixture(t);
    f.dependencies.getCachedFolder = id => id === remoteId ? 'host::project' : 'project';
    const handlers = loadDeletionHandlers(f.dependencies);
    for (const name of ['delete-session-preview', 'delete-session']) {
      const result = await handlers.get(name)(null, 'a', ['a', 'b']);
      assert.equal(result.ok, false);
      assert.match(result.error, /remote transcript is read-only/);
    }
    assert.equal(fs.existsSync(f.a), true);
    assert.equal(fs.existsSync(f.b), true);
    assert.equal(f.cached.size, 4);
  });
}

test('preview reports a running member even when the head is stopped', t => {
  const f = deletionFixture(t);
  f.dependencies.activeSessions = new Map([['a', { exited: true }], ['b', { exited: false }]]);
  assert.equal(loadDeletionHandlers(f.dependencies).get('delete-session-preview')(null, 'a').running, true);
  f.dependencies.activeSessions.get('b').exited = true;
  assert.equal(loadDeletionHandlers(f.dependencies).get('delete-session-preview')(null, 'a').running, false);
});

test('a failed transcript removal clears subagents whose directory is confirmed gone', async t => {
  const f = deletionFixture(t);
  const dir = path.join(f.root, 'project', 'b', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-y.jsonl'), '{}\n');
  f.dependencies.fs = { ...fs, rmSync: (file, options) => {
    if (file === f.b) throw new Error('EBUSY transcript');
    return fs.rmSync(file, options);
  } };
  const result = await loadDeletionHandlers(f.dependencies).get('delete-session')(null, 'a', ['a', 'b']);
  assert.equal(result.ok, false);
  assert.match(result.error, /Deleted 0 of 2 parts;.*EBUSY transcript/);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(f.b), true);
  for (const entries of [f.cached, f.search, f.touched]) {
    assert.equal(entries.has('sub:b:y'), false, 'deleted subagent must be forgotten');
    for (const id of ['a', 'b', 'sub:a:x']) assert.equal(entries.has(id), true, id);
  }
  assert.deepEqual(Array.from(result.removedPartIds), []);
});

test('a failed subagent directory removal retains its subagent cache and search rows', async t => {
  const f = deletionFixture(t);
  const dir = path.join(f.root, 'project', 'b');
  fs.mkdirSync(dir);
  f.dependencies.fs = { ...fs, rmSync: (file, options) => {
    if (file === dir) throw new Error('EBUSY subagent directory');
    return fs.rmSync(file, options);
  } };
  const result = await loadDeletionHandlers(f.dependencies).get('delete-session')(null, 'a', ['a', 'b']);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(dir), true);
  for (const entries of [f.cached, f.search, f.touched]) assert.equal(entries.has('sub:b:y'), true);
});

test('preview labels a target stat failure as a file inspection failure', t => {
  const f = deletionFixture(t);
  f.dependencies.fs = { ...fs, statSync: () => { throw new Error('EACCES stat'); } };
  const result = loadDeletionHandlers(f.dependencies).get('delete-session-preview')(null, 'a');
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot inspect conversation files: EACCES stat/);
});
