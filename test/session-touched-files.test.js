'use strict';

// The files a session's file tools touched — see .ai/contexts/touched-files.md.
// The transcript is attacker-influenced data (a sandboxed session writes its
// own), so every case below that matters is about what the listing refuses to
// do with a path, not about what it finds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TOUCH_TOOLS,
  extractTouches,
  resolveTouchedPath,
  collectSessionTouchedFiles,
} = require('../session-touched-files');

function assistantLine(...blocks) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
}

function toolUse(name, input) {
  return { type: 'tool_use', id: 'toolu_' + name, name, input };
}

// --- extractTouches ------------------------------------------------------

test('extractTouches reads the target of Edit, Write, MultiEdit and NotebookEdit calls', () => {
  const line = assistantLine(
    toolUse('Edit', { file_path: '/a/edit.js', old_string: 'x', new_string: 'y' }),
    toolUse('Write', { file_path: '/a/write.js', content: 'z' }),
    toolUse('MultiEdit', { file_path: '/a/multi.js', edits: [] }),
    toolUse('NotebookEdit', { notebook_path: '/a/nb.ipynb', new_source: 's' }),
  );
  const { touches, malformed } = extractTouches(line);
  assert.equal(malformed, false);
  assert.deepEqual(touches, [
    { tool: 'Edit', path: '/a/edit.js' },
    { tool: 'Write', path: '/a/write.js' },
    { tool: 'MultiEdit', path: '/a/multi.js' },
    { tool: 'NotebookEdit', path: '/a/nb.ipynb' },
  ]);
  assert.deepEqual([...TOUCH_TOOLS].sort(), ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
});

test('extractTouches ignores a tool that only reads, a shell call and a user turn', () => {
  for (const line of [
    assistantLine(toolUse('Read', { file_path: '/a/read.js' })),
    assistantLine(toolUse('Bash', { command: 'sed -i s/a/b/ /a/shell.js' })),
    assistantLine(toolUse('Grep', { pattern: 'x', path: '/a' })),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [toolUse('Write', { file_path: '/a/forged.js' })] } }),
    assistantLine({ type: 'text', text: 'I edited /a/prose.js with Write' }),
  ]) {
    assert.deepEqual(extractTouches(line), { touches: [], malformed: false });
  }
});

test('extractTouches skips a call whose path is not a non-empty string', () => {
  const line = assistantLine(
    toolUse('Write', { file_path: 42 }),
    toolUse('Write', { file_path: '' }),
    toolUse('Edit', {}),
    toolUse('Edit'),
    toolUse('NotebookEdit', { file_path: '/a/wrong-key.ipynb' }),
    toolUse('Write', { file_path: '/a/ok.js' }),
  );
  assert.deepEqual(extractTouches(line).touches, [{ tool: 'Write', path: '/a/ok.js' }]);
});

test('extractTouches reports a line that names a touch tool but is not JSON, and not any other garbage', () => {
  assert.equal(extractTouches('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","inp').malformed, true);
  assert.deepEqual(extractTouches('not json at all'), { touches: [], malformed: false });
  assert.deepEqual(extractTouches(''), { touches: [], malformed: false });
  assert.deepEqual(extractTouches('{"type":"assistant","message":null}'), { touches: [], malformed: false });
});

// --- resolveTouchedPath --------------------------------------------------

test('resolveTouchedPath keeps an absolute path, normalised', () => {
  const abs = path.resolve(os.tmpdir(), 'proj', 'sub', '..', 'file.txt');
  assert.deepEqual(resolveTouchedPath(path.join(os.tmpdir(), 'proj', 'sub', '..', 'file.txt'), { cwd: null }), { path: abs });
});

test('resolveTouchedPath resolves a relative path against a verified cwd only', () => {
  const cwd = path.resolve(os.tmpdir(), 'proj');
  assert.deepEqual(resolveTouchedPath(path.join('src', 'a.js'), { cwd }), { path: path.join(cwd, 'src', 'a.js') });
  const unresolved = resolveTouchedPath(path.join('src', 'a.js'), { cwd: null });
  assert.equal(unresolved.path, undefined);
  assert.equal(unresolved.unresolved, 'relative-no-cwd');
});

test('resolveTouchedPath refuses a path the OS would treat as a network, device or drive-relative target', () => {
  const win = { pathOps: path.win32 };
  for (const [raw, reason] of [
    ['\\\\server\\share\\x.txt', 'unsupported-form'],
    ['//server/share/x.txt', 'unsupported-form'],
    ['\\\\?\\C:\\x.txt', 'unsupported-form'],
    ['\\\\.\\C:\\x.txt', 'unsupported-form'],
    ['\\\\?\\UNC\\server\\share\\x.txt', 'unsupported-form'],
    ['/rooted/without/drive.txt', 'rooted-no-drive'],
    ['C:drive-relative.txt', 'drive-relative'],
  ]) {
    const r = resolveTouchedPath(raw, { ...win, cwd: 'C:\\proj' });
    assert.equal(r.path, undefined, raw);
    assert.equal(r.unresolved, reason, raw);
  }
  assert.deepEqual(resolveTouchedPath('C:\\a\\..\\b\\x.txt', { ...win, cwd: null }), { path: 'C:\\b\\x.txt' });
});

test('resolveTouchedPath refuses control characters, a home shortcut and an oversized path', () => {
  const cwd = path.resolve(os.tmpdir(), 'proj');
  for (const raw of [
    path.join(cwd, 'a\0b'),
    path.join(cwd, 'a\nb'),
    '~/x.txt',
    path.join(cwd, 'x'.repeat(5000)),
  ]) {
    const r = resolveTouchedPath(raw, { cwd });
    assert.equal(r.path, undefined, JSON.stringify(raw.slice(0, 40)));
    assert.equal(typeof r.unresolved, 'string');
  }
});

// --- collectSessionTouchedFiles -----------------------------------------

function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touched-'));
  const folder = path.join(root, 'projects', '-proj');
  const work = path.join(root, 'work');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const write = (rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  return { root, folder, work, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function lines(...ls) {
  return ls.join('\n') + '\n';
}

function deps(world, over = {}) {
  return {
    folderPath: world.folder,
    sessionId: 'S1',
    cwdOf: () => null,
    isSensitive: async () => false,
    ...over,
  };
}

function byPath(result) {
  return Object.fromEntries(result.files.map((f) => [f.path, f]));
}

test('a file written outside any repository is listed, present on disk', async () => {
  const w = makeWorld();
  try {
    const outside = w.write('work/notes.txt', 'hello');
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(toolUse('Write', { file_path: outside, content: 'hello' }))));
    const result = await collectSessionTouchedFiles(deps(w));
    assert.equal(result.ok, true);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, path.resolve(outside));
    assert.equal(result.files[0].state, 'present');
    assert.equal(result.files[0].openable, true);
    assert.deepEqual(result.files[0].tools, ['Write']);
    assert.equal(result.files[0].count, 1);
  } finally { w.cleanup(); }
});

test('a subagent transcript is walked, and its files carry the agent that touched them', async () => {
  const w = makeWorld();
  try {
    const mine = w.write('work/mine.txt', 'a');
    const theirs = w.write('work/theirs.txt', 'b');
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(toolUse('Edit', { file_path: mine }))));
    w.write('projects/-proj/S1/subagents/agent-abc123.jsonl', lines(assistantLine(toolUse('Write', { file_path: theirs }))));
    w.write('projects/-proj/S1/subagents/agent-abc123.meta.json', JSON.stringify({ agentType: 'reviewer' }));
    const result = await collectSessionTouchedFiles(deps(w, { labelOf: (entry) => (entry.parentSessionId ? 'subagent ' + entry.sessionId : 'session') }));
    const files = byPath(result);
    assert.deepEqual(files[path.resolve(mine)].sources, ['session']);
    assert.deepEqual(files[path.resolve(theirs)].sources, ['subagent agent-abc123']);
    assert.equal(result.coverage.transcripts, 2);
    assert.equal(result.coverage.subagents, 1);
  } finally { w.cleanup(); }
});

test('a legacy subagent layout (jsonl directly under the session directory) is walked too', async () => {
  const w = makeWorld();
  try {
    const theirs = w.write('work/legacy.txt', 'b');
    w.write('projects/-proj/S1.jsonl', lines());
    w.write('projects/-proj/S1/agent-old.jsonl', lines(assistantLine(toolUse('Write', { file_path: theirs }))));
    const result = await collectSessionTouchedFiles(deps(w));
    assert.equal(result.files.length, 1);
    assert.equal(result.coverage.subagents, 1);
  } finally { w.cleanup(); }
});

test("another session's transcript in the same folder contributes nothing", async () => {
  const w = makeWorld();
  try {
    const other = w.write('work/other.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines());
    w.write('projects/-proj/S2.jsonl', lines(assistantLine(toolUse('Write', { file_path: other }))));
    w.write('projects/-proj/S2/subagents/agent-z.jsonl', lines(assistantLine(toolUse('Write', { file_path: other }))));
    const result = await collectSessionTouchedFiles(deps(w));
    assert.deepEqual(result.files, []);
    assert.equal(result.coverage.transcripts, 1);
  } finally { w.cleanup(); }
});

test('the same file touched by the session and a subagent is one row with merged tools, count and sources', async () => {
  const w = makeWorld();
  try {
    const shared = w.write('work/shared.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines(
      assistantLine(toolUse('Write', { file_path: shared })),
      assistantLine(toolUse('Edit', { file_path: shared })),
    ));
    w.write('projects/-proj/S1/subagents/agent-a.jsonl', lines(assistantLine(toolUse('MultiEdit', { file_path: shared }))));
    const result = await collectSessionTouchedFiles(deps(w, { labelOf: (e) => (e.parentSessionId ? 'sub' : 'main') }));
    assert.equal(result.files.length, 1);
    const [row] = result.files;
    assert.deepEqual(row.tools, ['Edit', 'MultiEdit', 'Write']);
    assert.equal(row.count, 3);
    assert.deepEqual(row.sources, ['main', 'sub']);
  } finally { w.cleanup(); }
});

test('a listed file that no longer exists is reported gone, not dropped and not an error', async () => {
  const w = makeWorld();
  try {
    const missing = path.join(w.work, 'deleted-later.txt');
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(toolUse('Write', { file_path: missing }))));
    const result = await collectSessionTouchedFiles(deps(w));
    assert.equal(result.files[0].state, 'gone');
    assert.equal(result.files[0].openable, false);
  } finally { w.cleanup(); }
});

test('a directory and an unreadable path each get their own state', async () => {
  const w = makeWorld();
  try {
    const dir = path.join(w.work, 'adir');
    fs.mkdirSync(dir);
    const locked = path.join(w.work, 'locked.txt');
    w.write('projects/-proj/S1.jsonl', lines(
      assistantLine(toolUse('Write', { file_path: dir })),
      assistantLine(toolUse('Write', { file_path: locked })),
    ));
    const result = await collectSessionTouchedFiles(deps(w, {
      statPath: async (p) => {
        if (p === path.resolve(locked)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return fs.promises.stat(p);
      },
    }));
    const files = byPath(result);
    assert.equal(files[path.resolve(dir)].state, 'not-file');
    assert.equal(files[path.resolve(dir)].openable, false);
    assert.equal(files[path.resolve(locked)].state, 'unreadable');
    assert.equal(files[path.resolve(locked)].openable, false);
  } finally { w.cleanup(); }
});

test('a path in a credential location is listed as refused and is never stat-ed', async () => {
  const w = makeWorld();
  try {
    const secret = path.join(w.work, '.ssh', 'id_rsa');
    const plain = w.write('work/plain.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines(
      assistantLine(toolUse('Write', { file_path: secret })),
      assistantLine(toolUse('Write', { file_path: plain })),
    ));
    const statted = [];
    const result = await collectSessionTouchedFiles(deps(w, {
      isSensitive: async (p) => /[/\\]\.ssh[/\\]/.test(p),
      statPath: async (p) => { statted.push(p); return fs.promises.stat(p); },
    }));
    const files = byPath(result);
    assert.equal(files[path.resolve(secret)].state, 'refused');
    assert.equal(files[path.resolve(secret)].openable, false);
    assert.deepEqual(statted, [path.resolve(plain)]);
  } finally { w.cleanup(); }
});

test('a sensitivity check that fails leaves the row refused rather than stat-ed', async () => {
  const w = makeWorld();
  try {
    const p = w.write('work/a.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(toolUse('Write', { file_path: p }))));
    const statted = [];
    const result = await collectSessionTouchedFiles(deps(w, {
      isSensitive: async () => { throw new Error('boom'); },
      statPath: async (q) => { statted.push(q); return fs.promises.stat(q); },
    }));
    assert.equal(result.files[0].state, 'refused');
    assert.deepEqual(statted, []);
  } finally { w.cleanup(); }
});

test('a relative path resolves against the verified session cwd, and stays unresolved without one', async () => {
  const w = makeWorld();
  try {
    w.write('work/rel.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(toolUse('Write', { file_path: 'rel.txt' }))));
    w.write('projects/-proj/S1/subagents/agent-a.jsonl', lines(assistantLine(toolUse('Write', { file_path: 'sub-rel.txt' }))));

    const verified = await collectSessionTouchedFiles(deps(w, {
      cwdOf: (entry) => (entry.parentSessionId ? null : w.work),
    }));
    assert.equal(verified.files.length, 1);
    assert.equal(verified.files[0].path, path.join(w.work, 'rel.txt'));
    assert.equal(verified.files[0].state, 'present');
    assert.equal(verified.unresolved.length, 1);
    assert.equal(verified.unresolved[0].raw, 'sub-rel.txt');
    assert.equal(verified.unresolved[0].reason, 'relative-no-cwd');

    const none = await collectSessionTouchedFiles(deps(w));
    assert.deepEqual(none.files, []);
    assert.deepEqual(none.unresolved.map((u) => u.raw).sort(), ['rel.txt', 'sub-rel.txt']);
    for (const u of none.unresolved) assert.equal('path' in u, false, 'an unresolved row carries nothing openable');
  } finally { w.cleanup(); }
});

test('an unresolvable path is listed once with its tools and never stat-ed', async () => {
  const w = makeWorld();
  try {
    w.write('projects/-proj/S1.jsonl', lines(
      assistantLine(toolUse('Write', { file_path: '\\\\attacker\\share\\x.txt' })),
      assistantLine(toolUse('Edit', { file_path: '\\\\attacker\\share\\x.txt' })),
    ));
    const statted = [];
    const result = await collectSessionTouchedFiles(deps(w, {
      pathOps: path.win32,
      statPath: async (p) => { statted.push(p); return fs.promises.stat(p); },
    }));
    assert.deepEqual(result.files, []);
    assert.equal(result.unresolved.length, 1);
    assert.deepEqual(result.unresolved[0].tools, ['Edit', 'Write']);
    assert.equal(result.unresolved[0].count, 2);
    assert.deepEqual(statted, []);
  } finally { w.cleanup(); }
});

test('a malformed line is counted and the lines around it still read', async () => {
  const w = makeWorld();
  try {
    const a = w.write('work/a.txt', 'x');
    const b = w.write('work/b.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines(
      assistantLine(toolUse('Write', { file_path: a })),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","inp',
      'garbage',
      assistantLine(toolUse('Write', { file_path: b })),
    ));
    const result = await collectSessionTouchedFiles(deps(w));
    assert.equal(result.files.length, 2);
    assert.equal(result.coverage.malformedLines, 1);
  } finally { w.cleanup(); }
});

test('a session with no transcript on disk is an error the caller can name', async () => {
  const w = makeWorld();
  try {
    const result = await collectSessionTouchedFiles(deps(w, { sessionId: 'NOPE' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-transcript');
  } finally { w.cleanup(); }
});

test('more distinct files than the cap are counted as omitted, not silently dropped', async () => {
  const w = makeWorld();
  try {
    const blocks = [];
    for (let i = 0; i < 7; i++) blocks.push(toolUse('Write', { file_path: path.join(w.work, `f${i}.txt`) }));
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(...blocks)));
    const result = await collectSessionTouchedFiles(deps(w, { maxFiles: 5 }));
    assert.equal(result.files.length, 5);
    assert.equal(result.omitted, 2);
  } finally { w.cleanup(); }
});

test('a transcript read past the byte budget is flagged truncated without parsing a partial line', async () => {
  const w = makeWorld();
  try {
    const first = w.write('work/first.txt', 'x');
    const second = w.write('work/second.txt', 'x');
    const l1 = assistantLine(toolUse('Write', { file_path: first }));
    const l2 = assistantLine(toolUse('Write', { file_path: second }));
    w.write('projects/-proj/S1.jsonl', lines(l1, l2));
    const result = await collectSessionTouchedFiles(deps(w, { maxBytes: Buffer.byteLength(l1) + 1 }));
    assert.equal(result.coverage.truncated, true);
    assert.deepEqual(result.files, []);

    const full = await collectSessionTouchedFiles(deps(w));
    assert.equal(full.coverage.truncated, false);
    assert.equal(full.files.length, 2);
  } finally { w.cleanup(); }
});

test('stat runs on at most a few rows at once', async () => {
  const w = makeWorld();
  try {
    const blocks = [];
    for (let i = 0; i < 40; i++) blocks.push(toolUse('Write', { file_path: path.join(w.work, `f${i}.txt`) }));
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(...blocks)));
    let inFlight = 0;
    let peak = 0;
    await collectSessionTouchedFiles(deps(w, {
      statPath: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    }));
    assert.ok(peak > 1, 'it does overlap');
    assert.ok(peak <= 8, `peak ${peak}`);
  } finally { w.cleanup(); }
});

test('a stat that never answers leaves the row unreadable instead of holding the listing', async () => {
  const w = makeWorld();
  try {
    const p = w.write('work/slow.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(toolUse('Write', { file_path: p }))));
    const result = await collectSessionTouchedFiles(deps(w, {
      statPath: () => new Promise(() => {}),
      statTimeoutMs: 20,
    }));
    assert.equal(result.files[0].state, 'unreadable');
  } finally { w.cleanup(); }
});

// --- listSessionTouchedFiles (the IPC's target resolution) -----------------

const { listSessionTouchedFiles } = require('../session-touched-files');
const { encodeProjectPath } = require('../encode-project-path');

function remoteListWorld454(t, paths) {
  const w = makeWorld();
  t.after(() => w.cleanup());
  const content = lines(...paths.map(p => assistantLine(toolUse('Write', { file_path: p }))));
  w.write('remote/host/projects/-repo/S1.jsonl', content);
  return { w, content, deps: listDeps(w, {
    dataDir: w.root, getCachedFolder: () => 'host::-repo',
    isRemoteFolder: f => typeof f === 'string' && f.startsWith('host::'),
  }) };
}

for (const count of [1, 500]) {
  test('remote Touched uses exactly one bounded disk batch for ' + count + ' paths', async t => {
    const paths = Array.from({ length: count }, (_, i) => '/repo/f' + i);
    const { deps: remoteDeps } = remoteListWorld454(t, paths);
    let attempts = 0;
    remoteDeps.runRemoteCommand = async () => { attempts++; return { code: 0, stdout: paths.map(() => 'present\t1700000000').join('\n') + '\n' }; };
    const result = await listSessionTouchedFiles('S1', remoteDeps);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.files.length, count);
    assert.ok(result.files.every(f => f.state === 'present'));
    assert.equal(attempts, 1);
  });
}

test('remote Touched makes no transport call for empty, invalid or protected-only lists', async t => {
  for (const paths of [[], ['relative', '/repo/../escape', '/new\nline'], ['/home/user/.ssh/id_rsa', '/repo/.git/config']]) {
    const { deps: remoteDeps } = remoteListWorld454(t, paths);
    remoteDeps.runRemoteCommand = async () => { assert.fail('no accepted path may reach the transport'); };
    const result = await listSessionTouchedFiles('S1', remoteDeps);
    assert.equal(result.ok, true, result.error);
    assert.ok(result.files.every(f => f.state === 'refused'));
  }
});

test('remote Touched mirror equals the local parser and batches disk info once on every refresh', async t => {
  const paths = ['/repo/a', '/repo/b', '/repo/c'];
  const { w, content, deps: remoteDeps } = remoteListWorld454(t, paths);
  w.write('projects/-repo/S1.jsonl', content);
  let attempts = 0;
  remoteDeps.runRemoteCommand = async (alias, command, options) => {
    attempts++;
    assert.equal(alias, 'host');
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 20000);
    assert.ok(options.maxStdoutBytes > 0 && options.maxStdoutBytes <= 65536);
    for (const p of paths) assert.ok(command.includes("'" + p + "'"));
    return { code: 0, stdout: paths.map(() => 'present\t1700000000').join('\n') + '\n' };
  };
  const local = await collectSessionTouchedFiles({ folderPath: path.join(w.root, 'projects/-repo'), sessionId: 'S1',
    pathOps: path.posix, isSensitive: async () => false, statPath: async () => ({ isFile: () => true, mtimeMs: 1700000000000 }) });
  const remote = await listSessionTouchedFiles('S1', remoteDeps);
  assert.equal(remote.ok, true, remote.error);
  assert.deepEqual(remote.files, local.files);
  assert.equal(remote.kind, 'remote');
  assert.equal(attempts, 1);
  const again = await listSessionTouchedFiles('S1', remoteDeps);
  assert.deepEqual(again.files, remote.files);
  assert.equal(attempts, 2);
});

test('remote Touched refuses relative, newline and traversal paths before quoting one batch', async t => {
  const safe = ['/repo/back`tick', '/repo/$(touch owned)', "/repo/one'quote", '/repo/two"quotes'];
  const bad = ['/repo/../escape', 'relative', '/repo/new\nline'];
  const { deps: remoteDeps } = remoteListWorld454(t, [...safe, ...bad]);
  let attempts = 0;
  remoteDeps.runRemoteCommand = async (_alias, command) => {
    attempts++;
    for (const p of safe) assert.ok(command.includes("'" + p.replace(/'/g, "'\\''") + "'"), p + ' must be a single shell argument');
    for (const p of bad) assert.ok(!command.includes(p), p + ' must never reach the command');
    return { code: 0, stdout: safe.map(() => 'present\t1700000000').join('\n') + '\n' };
  };
  const result = await listSessionTouchedFiles('S1', remoteDeps);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.files.length, safe.length);
  assert.ok(result.files.every(f => f.state === 'present'));
  assert.equal(result.unresolved.length, bad.length);
  assert.equal(attempts, 1);
});

test('remote Touched preserves mirrored rows as unknown with one unreachable attempt per refresh', async t => {
  const { deps: remoteDeps } = remoteListWorld454(t, ['/repo/a', '/repo/b']);
  let attempts = 0;
  remoteDeps.runRemoteCommand = async () => { attempts++; return { code: 255, stdout: '', stderr: 'offline' }; };
  const result = await listSessionTouchedFiles('S1', remoteDeps);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.files.map(f => f.state), ['unknown', 'unknown']);
  assert.ok(result.files.every(f => f.diskMtime === null && !f.openable));
  assert.equal(attempts, 1);
  await listSessionTouchedFiles('S1', remoteDeps);
  assert.equal(attempts, 2);
});

test('remote Touched keeps gone and unreadable distinct and rejects malformed or oversized batch answers', async t => {
  const { deps: remoteDeps } = remoteListWorld454(t, ['/repo/a', '/repo/b']);
  remoteDeps.runRemoteCommand = async () => ({ code: 0, stdout: 'gone\t-\nunreadable\t-\n' });
  const inspected = await listSessionTouchedFiles('S1', remoteDeps);
  assert.equal(inspected.ok, true, inspected.error);
  assert.deepEqual(inspected.files.map(f => f.state), ['gone', 'unreadable']);
  for (const response of [{ code: 0, stdout: 'present\tbogus\n' }, { code: 0, stdout: 'x'.repeat(65537) }, new Error('timeout')]) {
    remoteDeps.runRemoteCommand = async () => { if (response instanceof Error) throw response; return response; };
    const result = await listSessionTouchedFiles('S1', remoteDeps);
    assert.ok(result.files.every(f => f.state === 'unknown'));
  }
});

function listDeps(world, over = {}) {
  return {
    projectsDir: path.join(world.root, 'projects'),
    getCachedFolder: () => '-proj',
    isRemoteFolder: () => false,
    isSensitive: async () => false,
    ...over,
  };
}

function cwdLine(cwd) {
  return JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } });
}

test('listSessionTouchedFiles refuses a subagent id, a bad id and a malformed remote folder before reading anything', async () => {
  const w = makeWorld();
  try {
    w.write('projects/-proj/S1.jsonl', lines());
    for (const id of ['sub:S1:abc', '', '..', 'a/b', 'S1\\..\\x', null, 42]) {
      const r = await listSessionTouchedFiles(id, listDeps(w));
      assert.equal(r.ok, false, String(id));
      assert.equal(r.error, 'invalid session id', String(id));
    }
    const remote = await listSessionTouchedFiles('S1', listDeps(w, { isRemoteFolder: () => true }));
    assert.equal(remote.ok, false);
    assert.equal(remote.reason, 'no-transcript');
  } finally { w.cleanup(); }
});

test('listSessionTouchedFiles never follows a folder name that leaves the projects directory', async () => {
  const w = makeWorld();
  try {
    const outside = w.write('work/x.txt', 'x');
    w.write('elsewhere/S1.jsonl', lines(assistantLine(toolUse('Write', { file_path: outside }))));
    for (const folder of ['../elsewhere', '..', '.', 'a/b', 'a\\b', '', null]) {
      const r = await listSessionTouchedFiles('S1', listDeps(w, { getCachedFolder: () => folder }));
      assert.equal(r.ok, false, String(folder));
      assert.equal(r.reason, 'no-transcript', String(folder));
    }
  } finally { w.cleanup(); }
});

test('listSessionTouchedFiles resolves a relative path against a cwd that encodes back to its folder', async () => {
  const w = makeWorld();
  try {
    const folder = encodeProjectPath(w.work);
    w.write('work/rel.txt', 'x');
    w.write(`projects/${folder}/S1.jsonl`, lines(cwdLine(w.work), assistantLine(toolUse('Write', { file_path: 'rel.txt' }))));
    const r = await listSessionTouchedFiles('S1', listDeps(w, { getCachedFolder: () => folder }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.map((f) => [f.path, f.state]), [[path.join(w.work, 'rel.txt'), 'present']]);
  } finally { w.cleanup(); }
});

test('listSessionTouchedFiles does not trust a transcript cwd that does not encode back to its folder', async () => {
  const w = makeWorld();
  try {
    w.write('work/rel.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines(cwdLine(w.work), assistantLine(toolUse('Write', { file_path: 'rel.txt' }))));
    const r = await listSessionTouchedFiles('S1', listDeps(w));
    assert.deepEqual(r.files, []);
    assert.deepEqual(r.unresolved.map((u) => [u.raw, u.reason]), [['rel.txt', 'relative-no-cwd']]);
  } finally { w.cleanup(); }
});

test('listSessionTouchedFiles gives a subagent its own cwd only when that cwd verifies too', async () => {
  const w = makeWorld();
  try {
    const folder = encodeProjectPath(w.work);
    const elsewhere = path.join(w.root, 'worktree-elsewhere');
    fs.mkdirSync(elsewhere);
    w.write('work/same.txt', 'x');
    w.write('worktree-elsewhere/wt.txt', 'x');
    w.write(`projects/${folder}/S1.jsonl`, lines());
    w.write(`projects/${folder}/S1/subagents/agent-a.jsonl`, lines(cwdLine(w.work), assistantLine(toolUse('Write', { file_path: 'same.txt' }))));
    w.write(`projects/${folder}/S1/subagents/agent-b.jsonl`, lines(cwdLine(elsewhere), assistantLine(toolUse('Write', { file_path: 'wt.txt' }))));
    const r = await listSessionTouchedFiles('S1', listDeps(w, { getCachedFolder: () => folder }));
    assert.deepEqual(r.files.map((f) => f.path), [path.join(w.work, 'same.txt')]);
    assert.deepEqual(r.unresolved.map((u) => u.raw), ['wt.txt']);
  } finally { w.cleanup(); }
});

test('listSessionTouchedFiles names a subagent by its recorded type and a short id', async () => {
  const w = makeWorld();
  try {
    const theirs = w.write('work/theirs.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines());
    w.write('projects/-proj/S1/subagents/agent-abcdef0123.jsonl', lines(assistantLine(toolUse('Write', { file_path: theirs }))));
    w.write('projects/-proj/S1/subagents/agent-abcdef0123.meta.json', JSON.stringify({ agentType: 'reviewer\nforged line' }));
    const r = await listSessionTouchedFiles('S1', listDeps(w));
    assert.deepEqual(r.files[0].sources, ['subagent reviewer forged line (abcdef0)']);
  } finally { w.cleanup(); }
});

// --- review follow-ups ------------------------------------------------------

test('a sensitivity check that never answers leaves the row unreadable instead of holding the listing', async () => {
  const w = makeWorld();
  try {
    const p = w.write('work/hang.txt', 'x');
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(toolUse('Write', { file_path: p }))));
    const result = await collectSessionTouchedFiles(deps(w, {
      isSensitive: () => new Promise(() => {}),
      statTimeoutMs: 20,
    }));
    assert.equal(result.files[0].state, 'unreadable');
    assert.equal(result.files[0].openable, false);
  } finally { w.cleanup(); }
});

test('after a few timed-out checks no new file-system call is issued and the rest are unreadable', async () => {
  const w = makeWorld();
  try {
    const blocks = [];
    for (let i = 0; i < 60; i++) blocks.push(toolUse('Write', { file_path: path.join(w.work, `f${i}.txt`) }));
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(...blocks)));
    let issued = 0;
    const result = await collectSessionTouchedFiles(deps(w, {
      isSensitive: () => { issued += 1; return new Promise(() => {}); },
      statTimeoutMs: 15,
      maxTimedOutChecks: 3,
    }));
    assert.equal(result.files.length, 60);
    assert.ok(result.files.every((f) => f.state === 'unreadable'));
    assert.ok(issued <= 3 + 8, `issued ${issued}`);
    assert.ok(issued >= 3, `issued ${issued}`);
  } finally { w.cleanup(); }
});

test('a path with a bidi override, isolate, mark, zero-width or C1 character is not resolved', () => {
  const cwd = path.resolve(os.tmpdir(), 'proj');
  const hostile = [
    '\u202E', '\u202A', '\u2066', '\u2069', '\u200E', '\u200F', '\u061C', '\u200B', '\u2060', '\uFEFF', '\u0085', '\u009F', '\u2028', '\u{E0041}',
  ];
  for (const ch of hostile) {
    const r = resolveTouchedPath(path.join(cwd, `report${ch}txt.exe`), { cwd });
    assert.equal(r.path, undefined, JSON.stringify(ch));
    assert.equal(r.unresolved, 'control-character', JSON.stringify(ch));
  }
  assert.deepEqual(resolveTouchedPath(path.join(cwd, 'rapport-é-日本.txt'), { cwd }), { path: path.join(cwd, 'rapport-é-日本.txt') });
});

test('an unresolved path shows its unsafe characters as visible escapes', async () => {
  const w = makeWorld();
  try {
    const hostile = path.join(w.work, 'report\u202Etxt.exe');
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(
      toolUse('Write', { file_path: hostile }),
      toolUse('Write', { file_path: path.join(w.work, 'tag\u{E0041}x') }),
      toolUse('Write', { file_path: path.join(w.work, 'tab\there') }),
    )));
    const result = await collectSessionTouchedFiles(deps(w));
    assert.deepEqual(result.files, []);
    const raws = result.unresolved.map((u) => u.raw);
    assert.ok(raws.some((r) => r.endsWith('report\\u202Etxt.exe')), raws.join('|'));
    assert.ok(raws.some((r) => r.endsWith('tag\\u{E0041}x')), raws.join('|'));
    assert.ok(raws.some((r) => r.endsWith('tab\\u0009here')), raws.join('|'));
    for (const r of raws) assert.doesNotMatch(r, /[\u0000-\u001f\u202e\u{e0041}]/u);
  } finally { w.cleanup(); }
});

test('a tool-call line past the per-line bound is skipped and counted, the lines around it still read', async () => {
  const w = makeWorld();
  try {
    const a = w.write('work/a.txt', 'x');
    const b = w.write('work/b.txt', 'x');
    const big = assistantLine(toolUse('Write', { file_path: path.join(w.work, 'huge.txt'), content: 'z'.repeat(4 * 1024 * 1024 + 10) }));
    w.write('projects/-proj/S1.jsonl', lines(
      assistantLine(toolUse('Write', { file_path: a })),
      big,
      assistantLine(toolUse('Write', { file_path: b })),
    ));
    const result = await collectSessionTouchedFiles(deps(w));
    assert.deepEqual(result.files.map((f) => f.path).sort(), [path.resolve(a), path.resolve(b)].sort());
    assert.equal(result.coverage.skippedLines, 1);
  } finally { w.cleanup(); }
});

test('the overflow past the cap is counted without keeping the overflowing paths', async () => {
  const w = makeWorld();
  try {
    const blocks = [];
    for (let i = 0; i < 9; i++) blocks.push(toolUse('Write', { file_path: path.join(w.work, `f${i % 9}.txt`) }));
    blocks.push(toolUse('Write', { file_path: path.join(w.work, 'f8.txt') }));
    w.write('projects/-proj/S1.jsonl', lines(assistantLine(...blocks)));
    const result = await collectSessionTouchedFiles(deps(w, { maxFiles: 5 }));
    assert.equal(result.files.length, 5);
    assert.equal(result.omitted, 5);
  } finally { w.cleanup(); }
});
