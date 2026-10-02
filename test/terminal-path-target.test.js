// Openability of a path matched in terminal output, main-side.
//
// The link provider asks this one question per candidate: may the panel open
// this? Everything the answer depends on — the sensitive-path denylist, the
// session's working directory for a relative path, regular-file-ness, the
// panel's size bound, a NUL byte — is exercised against real files on disk.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTerminalPathTarget, resolveTerminalPaths, fileHasNullByte } = require('../terminal-path-target');
const { isSensitivePathAsync } = require('../ipc-path-validator');

const MAX_BYTES = 2 * 1024 * 1024;

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-path-links-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(cwd, 'public'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'emptydir'));
  fs.writeFileSync(path.join(cwd, 'public', 'app.js'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(cwd, 'my file.txt'), 'spaced\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(cwd, 'huge.txt'), Buffer.alloc(MAX_BYTES + 1, 0x61));
  fs.writeFileSync(path.join(home, 'notes.md'), '# notes\n');
  return { root, home, cwd };
}

function deps(home) {
  return {
    isSensitivePath: isSensitivePathAsync,
    stat: (p) => fs.promises.stat(p),
    hasNullByte: fileHasNullByte,
    homedir: () => home,
    maxBytes: MAX_BYTES,
  };
}

const fixture = makeFixture();
test.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

// The matrix. A row added here is covered without anyone remembering to wire it.
const ROWS = [
  { name: 'absolute path to a regular file', text: (f) => path.join(f.cwd, 'public/app.js'), ok: true, resolved: (f) => path.join(f.cwd, 'public/app.js') },
  { name: 'relative path, against the session cwd', text: () => 'public/app.js', ok: true, resolved: (f) => path.join(f.cwd, 'public/app.js') },
  { name: 'dot-relative path', text: () => './public/app.js', ok: true, resolved: (f) => path.join(f.cwd, 'public/app.js') },
  { name: 'tilde path, against the home directory', text: () => '~/notes.md', ok: true, resolved: (f) => path.join(f.home, 'notes.md') },
  { name: 'path with spaces', text: () => 'my file.txt', ok: true, resolved: (f) => path.join(f.cwd, 'my file.txt') },
  { name: 'path that does not exist', text: () => 'public/nope.js', ok: false, reason: 'missing' },
  { name: 'path the guards refuse', text: () => '.env', ok: false, reason: 'sensitive' },
  { name: 'absolute path the guards refuse', text: (f) => path.join(f.cwd, '.env'), ok: false, reason: 'sensitive' },
  { name: 'directory', text: () => 'emptydir', ok: false, reason: 'directory' },
  { name: 'file over the panel size bound', text: () => 'huge.txt', ok: false, reason: 'too-large' },
  { name: 'binary file', text: () => 'blob.bin', ok: false, reason: 'binary' },
  { name: 'empty text', text: () => '', ok: false, reason: 'invalid-path' },
  { name: 'text with a NUL byte', text: () => 'pub\0lic/app.js', ok: false, reason: 'invalid-path' },
  { name: 'text over the length bound', text: () => `a/${'b'.repeat(5000)}`, ok: false, reason: 'invalid-path' },
];

for (const row of ROWS) {
  test(`openability: ${row.name}`, async () => {
    const result = await resolveTerminalPathTarget(row.text(fixture), fixture.cwd, deps(fixture.home));
    assert.strictEqual(result.ok, row.ok, JSON.stringify(result));
    if (row.ok) assert.strictEqual(result.path, row.resolved(fixture));
    else assert.strictEqual(result.reason, row.reason);
  });
}

test('a relative path with no session cwd is refused, never resolved against the app cwd', async () => {
  const result = await resolveTerminalPathTarget('public/app.js', null, deps(fixture.home));
  assert.deepStrictEqual(result, { ok: false, reason: 'no-cwd' });
});

test('an absolute path still resolves when the session cwd is unknown', async () => {
  const abs = path.join(fixture.cwd, 'public/app.js');
  assert.deepStrictEqual(await resolveTerminalPathTarget(abs, null, deps(fixture.home)), { ok: true, path: abs });
});

test('an existing file in a credential location is refused as sensitive, a missing one as missing', async () => {
  const ssh = path.join(fixture.cwd, '.ssh');
  fs.mkdirSync(ssh);
  fs.writeFileSync(path.join(ssh, 'id_rsa'), 'key\n');
  try {
    assert.deepStrictEqual(await resolveTerminalPathTarget('.ssh/id_rsa', fixture.cwd, deps(fixture.home)), { ok: false, reason: 'sensitive' });
    assert.deepStrictEqual(await resolveTerminalPathTarget('.ssh/absent', fixture.cwd, deps(fixture.home)), { ok: false, reason: 'missing' });
  } finally {
    fs.rmSync(ssh, { recursive: true, force: true });
  }
});

test('a symlink into a sensitive location is refused on its resolved target', async () => {
  const link = path.join(fixture.cwd, 'innocent.txt');
  fs.symlinkSync(path.join(fixture.cwd, '.env'), link);
  try {
    const result = await resolveTerminalPathTarget('innocent.txt', fixture.cwd, deps(fixture.home));
    assert.deepStrictEqual(result, { ok: false, reason: 'sensitive' });
  } finally {
    fs.unlinkSync(link);
  }
});

test('the resolved path is the one the panel is handed, not the text that was matched', async () => {
  const result = await resolveTerminalPathTarget('public/../public/app.js', fixture.cwd, deps(fixture.home));
  assert.deepStrictEqual(result, { ok: true, path: path.join(fixture.cwd, 'public', 'app.js') });
});

test('fileHasNullByte reports true for an unreadable path rather than letting it through', async () => {
  assert.strictEqual(await fileHasNullByte(path.join(fixture.cwd, 'does-not-exist')), true);
});

// --- Which cwd a session's candidates resolve against ---

const { resolveTerminalPathsCwd } = require('../terminal-path-target');
const { resolvePanelTerminalCwd } = require('../panel-terminal-target');

function cwdDeps(sessions, targets) {
  return {
    getSession: (id) => sessions[id],
    resolveTarget: (id) => targets[id] || { ok: false, error: 'could not resolve a working directory' },
    resolvePanelCwd: resolvePanelTerminalCwd,
  };
}

test('a local session resolves against its own working directory', () => {
  const deps = cwdDeps({}, { s1: { ok: true, kind: 'local', cwd: '/repo' } });
  assert.deepStrictEqual(resolveTerminalPathsCwd('s1', deps), { ok: true, cwd: '/repo' });
});

test('a remote session is refused', () => {
  const deps = cwdDeps({}, { s1: { ok: true, kind: 'remote', cwd: '/repo' } });
  assert.deepStrictEqual(resolveTerminalPathsCwd('s1', deps), { ok: false, reason: 'remote' });
});

// The refusal that matters: a remote host whose descriptor has not been indexed
// yet resolves to an error, and an error must not read as "no cwd, keep going"
// — absolute paths and ~/… would then be stat-ed on the local disk and opened
// while the user believes they are reading the remote file.
test('a session whose working directory cannot be resolved is refused, not resolved locally', () => {
  const deps = cwdDeps({}, {});
  assert.deepStrictEqual(resolveTerminalPathsCwd('unknown', deps), { ok: false, reason: 'no-cwd' });
});

test('an ok target with no usable cwd is refused', () => {
  const deps = cwdDeps({}, { s1: { ok: true, kind: 'local', cwd: '' } });
  assert.deepStrictEqual(resolveTerminalPathsCwd('s1', deps), { ok: false, reason: 'no-cwd' });
});

test('a panel shell resolves through the session that owns it', () => {
  const deps = cwdDeps(
    { 'panel:s1': { panelFor: 's1' } },
    { s1: { ok: true, kind: 'local', cwd: '/repo' } },
  );
  assert.deepStrictEqual(resolveTerminalPathsCwd('panel:s1', deps), { ok: true, cwd: '/repo' });
});

test('a panel shell over a remote session is refused', () => {
  const deps = cwdDeps(
    { 'panel:s1': { panelFor: 's1' } },
    { s1: { ok: true, kind: 'remote', cwd: '/repo' } },
  );
  assert.deepStrictEqual(resolveTerminalPathsCwd('panel:s1', deps), { ok: false, reason: 'no-cwd' });
});

// --- Non-regular files ---

// Stubbed rather than run against a real FIFO on purpose: the check this pins
// is what stops the NUL sniff below it from calling openSync on one, and an
// openSync on a FIFO with no writer never returns. A real FIFO here would turn
// a broken guard into a CI that hangs instead of a CI that fails.
test('a path that exists but is not a regular file is refused', async () => {
  const notAFile = { isDirectory: () => false, isFile: () => false, size: 0 };
  const result = await resolveTerminalPathTarget('public/app.js', fixture.cwd, {
    ...deps(fixture.home),
    stat: async () => notAFile,
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'not-a-regular-file' });
});

// --- A batch: same answers, same order, bounded, and the event loop stays free ---

function instrumentedFs(delayMs) {
  const state = { inFlight: 0, peak: 0, calls: 0 };
  const track = async (fn) => {
    state.calls++;
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return await fn();
    } finally {
      state.inFlight--;
    }
  };
  return {
    state,
    stat: (p) => track(() => fs.promises.stat(p)),
    hasNullByte: (p) => track(() => fileHasNullByte(p)),
  };
}

function batchDeps(home, over = {}) {
  return { ...deps(home), ...over };
}

test('a batch answers exactly what each path answers alone, in the order asked', async () => {
  const texts = ROWS.map((row) => row.text(fixture));
  const alone = [];
  for (const text of texts) alone.push(await resolveTerminalPathTarget(text, fixture.cwd, deps(fixture.home)));
  const batch = await resolveTerminalPaths(texts, fixture.cwd, deps(fixture.home));
  assert.deepStrictEqual(batch, alone);
});

test('a batch never has more checks in flight than the concurrency limit', async () => {
  const fake = instrumentedFs(3);
  const texts = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'public/app.js' : `public/missing-${i}.js`));
  const out = await resolveTerminalPaths(texts, fixture.cwd, batchDeps(fixture.home, fake), { concurrency: 4 });
  assert.strictEqual(out.length, 40);
  assert.ok(fake.state.peak <= 4, `peak ${fake.state.peak}`);
  assert.ok(fake.state.peak > 1, `no overlap at all: peak ${fake.state.peak}`);
});

test('the default concurrency is 8', async () => {
  const fake = instrumentedFs(3);
  const texts = Array.from({ length: 40 }, () => 'public/app.js');
  await resolveTerminalPaths(texts, fixture.cwd, batchDeps(fixture.home, fake));
  assert.strictEqual(fake.state.peak, 8);
});

test('answers keep the order asked when the checks finish out of order', async () => {
  const delays = { 'a.txt': 30, 'b.txt': 1, 'c.txt': 15 };
  const stat = async (p) => {
    await new Promise((resolve) => setTimeout(resolve, delays[path.basename(p)]));
    return fs.promises.stat(path.join(fixture.cwd, 'my file.txt'));
  };
  const out = await resolveTerminalPaths(['a.txt', 'b.txt', 'c.txt'], fixture.cwd, batchDeps(fixture.home, { stat, hasNullByte: async () => false }), { concurrency: 3 });
  assert.deepStrictEqual(out.map((r) => path.basename(r.path)), ['a.txt', 'b.txt', 'c.txt']);
});

test('the event loop keeps turning while a slow batch is out', async () => {
  const fake = instrumentedFs(5);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const texts = Array.from({ length: 16 }, () => 'public/app.js');
  await resolveTerminalPaths(texts, fixture.cwd, batchDeps(fixture.home, fake));
  clearInterval(timer);
  assert.ok(ticks >= 3, `only ${ticks} ticks ran during the batch`);
});

for (const bad of [0, -3, NaN, undefined, 1.5, Infinity]) {
  test(`a concurrency of ${bad} still answers every path, at least one at a time`, async () => {
    const fake = instrumentedFs(1);
    const texts = ['public/app.js', 'public/nope.js', 'my file.txt'];
    const out = await resolveTerminalPaths(texts, fixture.cwd, batchDeps(fixture.home, fake), { concurrency: bad });
    assert.strictEqual(out.length, 3);
    assert.ok(out.every((r) => r && typeof r.ok === 'boolean'), JSON.stringify(out));
    assert.ok(fake.state.peak >= 1 && fake.state.peak <= 8);
  });
}

test('an empty batch is an empty answer', async () => {
  assert.deepStrictEqual(await resolveTerminalPaths([], fixture.cwd, deps(fixture.home)), []);
});

test('the resolve-terminal-paths handler is async and reaches the disk only through the bounded resolver', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('resolve-terminal-paths'");
  const block = source.slice(start, source.indexOf('\n});', start));
  assert.match(block, /async \(_event, sessionId, texts\)/);
  assert.match(block, /terminalPathTarget\.resolveTerminalPaths\(/);
  assert.doesNotMatch(block, /Sync\b/);
});
