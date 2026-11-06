// Guards on the session launch path, both reported from the same failure:
// enabling Worktree globally and opening a session in a non-git folder made
// claude refuse to start, and the placeholder card that failure left behind
// could then never be relaunched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isGitRepo, sessionTranscriptExists } = require('../derive-project-path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-launch-'));
}

test('isGitRepo: true at a repo root and anywhere beneath it', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.git'));
  const deep = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(isGitRepo(root), true);
  assert.equal(isGitRepo(deep), true, 'a subdirectory is still inside the working tree');
  fs.rmSync(root, { recursive: true, force: true });
});

test('isGitRepo: a .git FILE counts — worktrees and submodules use one', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
  assert.equal(isGitRepo(root), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('isGitRepo: false for a plain directory and for one that does not exist', () => {
  const root = tmpdir();
  assert.equal(isGitRepo(root), false, 'this is the reported case — a non-git project folder');
  assert.equal(isGitRepo(path.join(root, 'missing')), false);
  assert.equal(isGitRepo(''), false);
  assert.equal(isGitRepo(null), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sessionTranscriptExists: finds a transcript in any project folder', () => {
  const projects = tmpdir();
  fs.mkdirSync(path.join(projects, '-home-u-a'), { recursive: true });
  fs.mkdirSync(path.join(projects, '-home-u-b'), { recursive: true });
  fs.writeFileSync(path.join(projects, '-home-u-b', 'abc.jsonl'), '{}\n');
  assert.equal(sessionTranscriptExists(projects, 'abc'), true, 'scans every folder, not just the expected one');
  fs.rmSync(projects, { recursive: true, force: true });
});

test('sessionTranscriptExists: false for a placeholder session that never started', () => {
  const projects = tmpdir();
  fs.mkdirSync(path.join(projects, '-home-u-a'), { recursive: true });
  // The regression: the sidebar shows a card for this id, but claude exited
  // before writing anything, so resuming it can only ever fail.
  assert.equal(sessionTranscriptExists(projects, 'never-started'), false);
  assert.equal(sessionTranscriptExists(projects, ''), false);
  assert.equal(sessionTranscriptExists('/nonexistent', 'x'), false, 'unreadable dir must not throw');
  fs.rmSync(projects, { recursive: true, force: true });
});

// --- Static guards on main.js (not require()-able under node:test) ---

test('main.js: a session with no transcript is started, not resumed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const startsFresh = isNew/, 'launch path must decide start-vs-resume explicitly');
  assert.match(src, /sessionTranscriptExists\(PROJECTS_DIR, sessionId\)/,
    'the decision must be based on the transcript actually existing');
  assert.match(src, /} else if \(startsFresh\) \{\s*\n\s*claudeArgs\.push\('--session-id'/,
    'a fresh start must pass --session-id, reusing the id the sidebar shows');
  // A fork resumes its source by design and must not be diverted.
  assert.match(src, /sessionOptions\?\.forkFrom\) \{\s*\n\s*claudeArgs\.push\('--resume'/,
    'forking must still resume its source');
});

test('main.js: --worktree is dropped in a non-git directory instead of failing the launch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /sessionOptions\.worktree && !isGitRepo\(spawnCwd\)/,
    'the flag must be gated on the spawn directory being a git repo');
  const idx = src.indexOf('!isGitRepo(spawnCwd)');
  const block = src.slice(idx, idx + 600);
  assert.match(block, /log\.warn/, 'dropping the flag must be recorded, not silent');
  assert.doesNotMatch(block.split('} else if')[0], /claudeArgs\.push\('--worktree'\)/,
    'the non-git branch must not push --worktree');
});

// ── Permit-bound launches (versioned trigger actions) ──
const { launchModeFor } = require('../derive-project-path');
const { createTriggerRendererBridge } = require('../src/main/triggers/trigger-renderer-bridge');

test('launchModeFor: an ordinary resume of a vanished transcript still starts it fresh, as before', () => {
  assert.deepEqual(launchModeFor({ isNew: false, forkFrom: undefined, transcriptExists: false }), { startsFresh: true });
  assert.deepEqual(launchModeFor({ isNew: false, forkFrom: undefined, transcriptExists: true }), { startsFresh: false });
  assert.deepEqual(launchModeFor({ isNew: true, forkFrom: undefined, transcriptExists: false }), { startsFresh: true });
  assert.deepEqual(launchModeFor({ isNew: false, forkFrom: 'x', transcriptExists: false }), { startsFresh: false });
});

test('launchModeFor: a resume permit whose transcript disappeared is refused, never --session-id', () => {
  assert.deepEqual(launchModeFor({ isNew: false, forkFrom: undefined, transcriptExists: false, permitMode: 'resume' }), { refuse: 'no readable transcript' });
  assert.deepEqual(launchModeFor({ isNew: false, forkFrom: undefined, transcriptExists: true, permitMode: 'resume' }), { startsFresh: false });
  assert.deepEqual(launchModeFor({ isNew: true, forkFrom: undefined, transcriptExists: false, permitMode: 'new' }), { startsFresh: true });
});

test('a permit refuses a revoked or expired request before the spawn callback runs', () => {
  const { EventEmitter } = require('node:events');
  const frame = {};
  const wc = Object.assign(new EventEmitter(), { mainFrame: frame, send() {}, isDestroyed: () => false });
  const win = Object.assign(new EventEmitter(), { webContents: wc, isDestroyed: () => false });
  const bridge = createTriggerRendererBridge({ ipcMain: { handle() {}, on() {} }, getWindow: () => win, getSession: () => null, isClosing: () => false });
  let spawns = 0;
  assert.equal(bridge.guardedSpawn('missing', () => { spawns += 1; }).ok, false);
  assert.equal(spawns, 0);
});

test('getTriggersDir resolves a relative override against the app, not against a session cwd', () => {
  const { getTriggersDir } = require('../src/main/triggers/trigger-watcher');
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR = 'relative/dir';
    assert.equal(getTriggersDir(), path.resolve('relative/dir'));
    process.env.SWITCHBOARD_TRIGGERS_DIR = '';
    assert.equal(getTriggersDir(), path.join(os.homedir(), '.switchboard', 'triggers'));
  } finally {
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR; else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
  }
});

// ── The permit-bound preparation and spawn boundary main.js calls ──
const { permitLaunchRefusal, runPermitSpawn, sandboxLaunchEnv } = require('../src/main/triggers/permit-spawn');

function spawnRig(overrides = {}) {
  const calls = { spawn: 0, guard: [] };
  const bridge = { guardedSpawn: (id, spawn) => { calls.guard.push(id); if (overrides.gate) return overrides.gate; return { ok: true, value: spawn() }; } };
  const found = { status: 'found', cwd: '/w', file: '/w/f.jsonl' };
  const input = {
    permit: { mode: 'resume', target: { cwd: '/w', file: '/w/f.jsonl' } }, permitId: 'p', sessionId: 'sid', bridge,
    liveV1: async () => ({ known: true, live: null }), resolveClosed: () => found, spawn: () => { calls.spawn += 1; return 'pty'; }, ...overrides.input,
  };
  return { calls, input, run: () => runPermitSpawn(input) };
}

test('permit spawn: a resume with known absence and the same transcript spawns once', async () => {
  const r = spawnRig();
  assert.deepEqual(await r.run(), { ok: true, value: 'pty' });
  assert.equal(r.calls.spawn, 1);
});

test('permit spawn: a writer that appears during preparation, unknown liveness or a thrown lookup spawn nothing', async () => {
  for (const [liveV1, error] of [
    [async () => ({ known: true, live: { kind: 'interactive' } }), 'session live elsewhere'],
    [async () => ({ known: false, reason: 'x' }), 'session liveness unavailable'],
    [async () => { throw new Error('boom'); }, 'session liveness unavailable'],
  ]) {
    const r = spawnRig({ input: { liveV1 } });
    assert.deepEqual(await r.run(), { ok: false, error });
    assert.equal(r.calls.spawn, 0);
    assert.deepEqual(r.calls.guard, []);
  }
});

test('permit spawn: a transcript whose cwd or file changed, or that vanished, spawns nothing', async () => {
  for (const found of [{ status: 'found', cwd: '/other', file: '/w/f.jsonl' }, { status: 'found', cwd: '/w', file: '/w/g.jsonl' }, { status: 'unknown' }]) {
    const r = spawnRig({ input: { resolveClosed: () => found } });
    assert.deepEqual(await r.run(), { ok: false, error: 'no readable transcript' });
    assert.equal(r.calls.spawn, 0);
  }
});

test('permit spawn: an expired or revoked permit is refused by the synchronous guard and spawns nothing', async () => {
  const r = spawnRig({ gate: { ok: false, reason: 'renderer action timed out' } });
  assert.deepEqual(await r.run(), { ok: false, error: 'renderer action timed out' });
  assert.equal(r.calls.spawn, 0);
});

test('permit spawn: new and reattach permits skip the liveness check but still pass the guard', async () => {
  let checks = 0;
  const r = spawnRig({ input: { permit: { mode: 'new' }, liveV1: async () => { checks += 1; return { known: false }; } } });
  assert.equal((await r.run()).ok, true);
  assert.equal(checks, 0);
});

test('permit launch refusal: only a resume permit refuses a vanished transcript', () => {
  assert.equal(permitLaunchRefusal({ permit: { mode: 'resume' }, isNew: false, transcriptExists: false }), 'no readable transcript');
  assert.equal(permitLaunchRefusal({ permit: { mode: 'resume' }, isNew: false, transcriptExists: true }), null);
  assert.equal(permitLaunchRefusal({ permit: { mode: 'new' }, isNew: true, transcriptExists: false }), null);
  assert.equal(permitLaunchRefusal({ permit: null, isNew: false, transcriptExists: false }), null);
});

test('sandbox launch env: the absolute triggers directory reaches every launch kind, whatever the spawn cwd', () => {
  const { getTriggersDir } = require('../src/main/triggers/trigger-watcher');
  const previous = process.env.SWITCHBOARD_TRIGGERS_DIR;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR = 'relative/ctl';
    const encode = value => value.replace(/[^a-zA-Z0-9]/g, '-');
    for (const transcriptCwd of ['/p/one', '/p/two']) {
      const env = sandboxLaunchEnv({ bindEnv: '/a:/b', transcriptCwd, encodeProjectPath: encode, triggersDir: getTriggersDir() });
      assert.equal(env.SWITCHBOARD_SANDBOX_TRIGGERS_DIR, path.resolve('relative/ctl'));
      assert.equal(env.SWITCHBOARD_SANDBOX_BINDS, '/a:/b');
      assert.equal(env.SWITCHBOARD_SANDBOX_PROJECT_FOLDER, encode(transcriptCwd));
    }
    assert.equal(Object.hasOwn(sandboxLaunchEnv({ transcriptCwd: '/p', encodeProjectPath: encode, triggersDir: '/c' }), 'SWITCHBOARD_SANDBOX_BINDS'), false);
  } finally {
    if (previous === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR; else process.env.SWITCHBOARD_TRIGGERS_DIR = previous;
  }
});

test('main.js hands the scheduled launch the shared environment builder with the absolute triggers directory', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.equal(src.split('sandboxLaunchEnv({').length - 1, 1);
  assert.match(src, /Object\.assign\(env, sandboxLaunchEnv\(\{ bindEnv, transcriptCwd: cwd, encodeProjectPath, triggersDir: getTriggersDir\(\) \}\)\);/);
  assert.match(src, /isClosing: \(\) => !unsavedGuard\.launchAllowed\(\),\s*\n\s*v1:/);
});

const { launchClaudeProcess } = require('../src/main/triggers/permit-spawn');
const { makeProc } = require('./helpers/fake-proc');
const realCli = require('../cli-session-state');

function launchRig(overrides = {}) {
  const calls = { spawn: 0, noted: [] };
  const base = {
    permit: { mode: 'resume', deadline: 100, target: { cwd: '/w', file: '/w/f.jsonl' } }, permitId: 'p', sessionId: 'sid', isNew: false, forkFrom: undefined,
    transcriptExists: true, sandbox: null, ptyEnv: {}, spawn: () => { calls.spawn += 1; return 'pty'; },
    bridge: { guardedSpawn: (id, spawn) => ({ ok: true, value: spawn() }), noteRefusal: (id, reason) => calls.noted.push(reason) },
    liveV1: async () => ({ known: true, live: null }), resolveClosed: () => ({ status: 'found', cwd: '/w', file: '/w/f.jsonl' }),
  };
  const input = { ...base, ...overrides };
  return { calls, input, run: () => launchClaudeProcess(input) };
}

test('launch: an ordinary launch spawns and applies the sandbox environment with the absolute triggers directory', async () => {
  const r = launchRig({ permit: null, sandbox: { bindEnv: '/a', transcriptCwd: '/p', encodeProjectPath: v => v.replace(/\//g, '-'), triggersDir: '/ctl' } });
  assert.deepEqual(await r.run(), { ok: true, value: 'pty' });
  assert.equal(r.input.ptyEnv.SWITCHBOARD_SANDBOX_TRIGGERS_DIR, '/ctl');
  assert.equal(r.input.ptyEnv.SWITCHBOARD_SANDBOX_BINDS, '/a');
  assert.equal(r.input.ptyEnv.SWITCHBOARD_SANDBOX_PROJECT_FOLDER, '-p');
});

test('launch: a permit whose transcript vanished is refused before any environment or spawn', async () => {
  const r = launchRig({ transcriptExists: false, sandbox: { transcriptCwd: '/p', encodeProjectPath: v => v, triggersDir: '/ctl' } });
  assert.deepEqual(await r.run(), { ok: false, error: 'no readable transcript' });
  assert.equal(r.calls.spawn, 0);
  assert.deepEqual(r.input.ptyEnv, {});
});

test('launch: a permit runs the final liveness check and refuses a writer that appeared', async () => {
  const r = launchRig({ liveV1: async () => ({ known: true, live: { kind: 'interactive' } }) });
  assert.deepEqual(await r.run(), { ok: false, error: 'session live elsewhere' });
  assert.equal(r.calls.spawn, 0);
});

test('launch: late scheduled and background writers keep their specific refusal and reach the broker', async () => {
  for (const [kind, reason] of [['schedule', 'scheduled session is not supported'], ['bg', 'background session is not supported']]) {
    const r = launchRig({ liveV1: async () => ({ known: true, live: { kind } }) });
    assert.deepEqual(await r.run(), { ok: false, error: reason });
    assert.deepEqual(r.calls.noted, [reason]);
  }
});

test('launch: the final scans receive the permit deadline', async () => {
  const seen = [];
  const r = launchRig({ liveV1: async (id, deadline) => { seen.push(['live', deadline]); return { known: true, live: null }; },
    resolveClosed: (id, deadline) => { seen.push(['resolve', deadline]); return { status: 'found', cwd: '/w', file: '/w/f.jsonl' }; } });
  await r.run();
  assert.deepEqual(seen, [['live', 100], ['resolve', 100]]);
});

test('launch: the real descriptor reader stops at the deadline instead of scanning on', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-launch-'));
  t.after(() => { realCli.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir);
  const proc = makeProc(path.join(root, 'proc'));
  proc.add(9000, { nspid: [9000, 42], start: '777', ns: 'pid:[99]' });
  const sid = '01234567-89ab-cdef-0123-456789abcdef';
  fs.writeFileSync(path.join(dir, '42.json'), JSON.stringify({ pid: 42, sessionId: sid, procStart: '777', kind: 'interactive', status: 'idle', statusUpdatedAt: 1 }));
  realCli.init({ dir, activeSessions: new Map(), log: { info() {}, warn() {}, error() {}, debug() {} }, platform: 'linux', isProcessAlive: () => false });
  let now = 0;
  const r = launchRig({ sessionId: sid, permit: { mode: 'resume', deadline: 5, target: {} },
    liveV1: (id, deadline) => realCli.liveElsewhereV1Checked(id, { procRoot: proc.root, now: () => (now += 10), deadline }) });
  assert.deepEqual(await r.run(), { ok: false, error: 'session liveness unavailable' });
  assert.equal(r.calls.spawn, 0);
});

test('main.js passes the real permit, sandbox description, readers and refusal handling to the launch function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /launchClaudeProcess\(\{ permit, permitId, sessionId, isNew, forkFrom: sessionOptions\?\.forkFrom,\s*\n\s*transcriptExists: transcriptKnown, sandbox: sandboxLaunch, ptyEnv, spawn: spawnClaude, bridge: triggerBridge, liveV1: triggerLiveV1,\s*\n\s*resolveClosed: \(id, deadline\) => resolveClosedTarget\(id, triggerResolverDeps\(deadline\)\) \}\);\s*\n\s*if \(!launched\.ok\) return \{ ok: false, error: launched\.error \};\s*\n\s*ptyProcess = launched\.value;/);
  assert.match(src, /sandboxLaunch = \{ bindEnv: sandboxBindEnv\(extraBinds\), transcriptCwd: spawnCwd \|\| projectPath, encodeProjectPath, triggersDir: getTriggersDir\(\) \};/);
  assert.match(src, /transcriptKnown = !startsFresh;\s*\n\s*const refusedLaunch = permitLaunchRefusal\(\{ permit, isNew, forkFrom: sessionOptions\?\.forkFrom, transcriptExists: transcriptKnown \}\);\s*\n\s*if \(refusedLaunch\) return \{ ok: false, error: refusedLaunch \};/);
});
