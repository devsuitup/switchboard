'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const gitChangesFile = require('../git-changes-file');
const { isSensitivePath } = require('../ipc-path-validator');
const { createMainPanelSaves } = require('../viewer-save-guard');

const { runToExit } = require('../run-to-exit');
const MAX_BYTES = 1024;
async function fixtureRunGit(args, options) {
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: os.tmpdir(), USERPROFILE: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'sb-touched-no-config'),
    GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()), LC_ALL: 'C', LANGUAGE: 'C',
  };
  const result = await runToExit('git', args, { ...options, env });
  return { ...result, tooLarge: result.overflow };
}
const fixtureGitFiles = {
  ...gitChangesFile,
  readTouchedChangesFile: args => gitChangesFile.readTouchedChangesFile(args, { runGit: fixtureRunGit }),
  writeTouchedChangesFile: args => gitChangesFile.writeTouchedChangesFile(args, { runGit: fixtureRunGit }),
};
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const { fakeTouchedShell } = require('./remote-touched-shell');

for (const [label, probe] of [
  ['removed cwd', { code: 128, stderr: 'fatal: cannot change to cwd: No such file or directory' }],
  ['missing git', { code: 127, stderr: 'git: command not found' }],
  ['dubious ownership', { code: 128, stderr: 'fatal: detected dubious ownership in repository' }],
]) {
  test('round 2 M3: ' + label + ' falls back to the successful plain read', async () => {
    let calls = 0;
    const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command) => {
      calls++;
      return command.includes('rev-parse') ? { ...probe, stdout: '' } : { code: 0, stdout: 'plain text' };
    });
    const result = await api.read('/repo/file', { sessionId: 'R1' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.git, false);
    assert.equal(result.readOnly, true);
    assert.equal(result.current, 'plain text');
    assert.equal(result.original, 'plain text');
    assert.equal(calls, 2);
  });
}

test('round 2 M3: a transport failure after a successful read stays unreachable', async () => {
  for (const probe of [{ code: -1 }, { code: 255 }, { code: 128, timedOut: true }]) {
    const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command) => command.includes('rev-parse')
      ? { ...probe, stdout: '' } : { code: 0, stdout: 'plain text' });
    const result = await api.read('/repo/file', { sessionId: 'R1' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown');
  }
});

test('round 2 m1: a read uses the checked resolved path after the original changes', async t => {
  const shell = fakeTouchedShell(t);
  fs.writeFileSync(path.join(shell.dir, 'original'), 'safe');
  fs.writeFileSync(path.join(shell.dir, 'resolved'), 'safe');
  shell.tool('realpath', 'printf "swapped" > original; printf "%s/resolved\\n" "$PWD"');
  const api = panelHandlers(fs, fixtureGitFiles, async (alias, command, options) => command.includes('rev-parse')
    ? { code: 128, stdout: '', stderr: 'not a git repository' } : shell.run(alias, command, options));
  const result = await api.read(shell.root + '/original', { sessionId: 'R1' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.current, 'safe');
});

test('round 2 m2: oversized HEAD is too large at the real transport cap', async () => {
  const { defaultRunRemoteCommand } = require('../remote-attach');
  const { PassThrough } = require('node:stream');
  const { EventEmitter } = require('node:events');
  const api = panelHandlers(fs, fixtureGitFiles, async (alias, command, options) => {
    if (command.includes('rev-parse')) return { code: 0, stdout: '/repo\n' };
    if (!command.includes("'show'")) return { code: 0, stdout: 'working text' };
    return defaultRunRemoteCommand(alias, command, { ...options, resolveSshPath: () => 'fake-transport', spawnFn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { setImmediate(() => child.emit('close', -1)); };
      setImmediate(() => { child.stdout.emit('data', Buffer.alloc(options.maxStdoutBytes + 1, 120)); child.emit('close', 0); });
      return child;
    } });
  });
  const result = await api.read('/repo/file', { sessionId: 'R1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-large');
});

test('round 2 s2: main refuses remote panel saves before touching the local disk', async () => {
  let accesses = 0;
  const api = panelHandlers({ realpathSync: { native() { accesses++; throw new Error('local disk accessed'); } } });
  for (const opts of [
    { sessionId: 'R1' }, { sessionId: 'R1', git: false, readOnly: false, remote: false },
    { sessionId: 'R1', git: true, version: 'forged', kind: 'local' },
  ]) {
    const result = await api.save('/repo/file', 'overwrite', 'before', opts);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'remote');
    assert.equal(accesses, 0);
  }
});

test('round 3 M1: opening a remote path leaves the same local file saveable', async t => {
  const { dir } = fixture(t);
  const nativePath = path.join(dir, 'file.txt');
  if (process.platform === 'win32' && nativePath.slice(0, 2).toLowerCase() !== process.cwd().slice(0, 2).toLowerCase()) {
    t.skip('the drive-less spelling only resolves to the temp file when it sits on the current drive');
    return;
  }
  const filePath = process.platform === 'win32' ? nativePath.slice(2).replace(/\\/g, '/') : nativePath;
  fs.writeFileSync(nativePath, 'local content');
  const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command) => command.includes('rev-parse')
    ? { code: 128, stderr: 'not a git repository' } : { code: 0, stdout: 'remote content' });
  assert.equal((await api.read(filePath, { sessionId: 'R1' })).ok, true);
  const refused = await api.save(filePath, 'overwrite', 'local content', { sessionId: 'R1' });
  assert.equal(refused.reason, 'remote');
  assert.equal(fs.readFileSync(nativePath, 'utf8'), 'local content');
  const saved = await api.save(filePath, 'saved locally', 'local content');
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(nativePath, 'utf8'), 'saved locally');
  assert.equal((await api.save(filePath, 'saved again', 'saved locally', {})).ok, true);
  assert.equal(fs.readFileSync(nativePath, 'utf8'), 'saved again');
});

test('round 3 m2: ordinary id_ source paths open but exact SSH key names stay refused on both guards', async t => {
  const shell = fakeTouchedShell(t);
  const safePaths = [shell.root + '/id_generator.py', shell.root + '/src/id_utils/x.js'];
  fs.writeFileSync(path.join(shell.dir, 'id_generator.py'), 'source');
  fs.mkdirSync(path.join(shell.dir, 'src', 'id_utils'), { recursive: true });
  fs.writeFileSync(path.join(shell.dir, 'src', 'id_utils', 'x.js'), 'source');
  let resolved = safePaths[0];
  let calls = 0;
  shell.setFunctions(`sh() { shift; script=$1; shift; shift; eval "$script"; }
realpath() { printf '%s\\n' "${'$'}{RESOLVED:-$3}"; }
stat() { printf '123\\n'; }
tr() { text=; IFS= read -r text; printf '%s' "${'$'}{text,,}"; }
`);
  const api = panelHandlers(fs, fixtureGitFiles, (alias, command, options) => {
    calls++;
    return command.includes('rev-parse') ? { code: 128, stderr: 'not a git repository' }
      : shell.run(alias, 'RESOLVED=' + require('../git-changes-runner').shQuote(resolved) + '; ' + command, options);
  });
  for (const filePath of safePaths) {
    resolved = filePath;
    const pair = await api.read(filePath, { sessionId: 'R1' });
    assert.equal(pair.ok, true, filePath + ': ' + pair.error);
    assert.equal(pair.current, 'source');
    assert.equal(pair.readOnly, true);
  }
  const keys = ['rsa', 'dsa', 'ecdsa', 'ed25519'].flatMap(algorithm =>
    ['', '_sk', '.pub', '_sk.pub'].map(suffix => '/outside/id_' + algorithm + suffix));
  for (const key of keys) {
    const before = calls;
    assert.equal((await api.read(key, { sessionId: 'R1' })).reason, 'refused', key);
    assert.equal(calls, before, 'literal key must not reach transport');
  }
  const { inspectRemoteTouchedPaths } = require('../remote-touched-files');
  const states = await inspectRemoteTouchedPaths('host', [...safePaths, ...keys], {
    runRemoteCommand: shell.run,
  });
  for (const filePath of safePaths) assert.equal(states.get(filePath).state, 'present', filePath);
  for (const key of keys) assert.equal(states.get(key).state, 'refused', key);
  for (const key of keys) {
    resolved = key;
    assert.equal((await api.read(safePaths[0], { sessionId: 'R1' })).reason, 'refused', key);
  }
});

for (const key of ['deploy/id_ed25519_deploy', 'keys/id_rsa_github', 'backup/id_rsa.bak']) {
  test('round 4 s2 JS: renamed private key is refused before transport: ' + key, async () => {
    let calls = 0;
    const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command) => {
      calls++;
      return command.includes('rev-parse') ? { code: 128, stderr: 'not a git repository' }
        : { code: 0, stdout: 'source' };
    });
    for (const safe of ['/outside/id_generator.py', '/outside/id_utils/x.js']) {
      assert.equal((await api.read(safe, { sessionId: 'R1' })).current, 'source');
    }
    const before = calls;
    const filePath = '/outside/' + key;
    assert.equal((await api.read(filePath, { sessionId: 'R1' })).reason, 'refused', filePath);
    const { inspectRemoteTouchedPaths } = require('../remote-touched-files');
    const states = await inspectRemoteTouchedPaths('host', [filePath], {
      runRemoteCommand: async () => { calls++; return { code: 0, stdout: 'present\t123\n' }; },
    });
    assert.equal(states.get(filePath).state, 'refused');
    assert.equal(calls, before, 'neither literal read nor inspection reaches transport');
  });

  test('round 4 s2 shell: resolved private key is refused on read and inspection: ' + key, async t => {
    const shell = fakeTouchedShell(t);
    const { shQuote } = require('../git-changes-runner');
    const { inspectRemoteTouchedPaths } = require('../remote-touched-files');
    for (const name of ['id_generator.py', 'id_utils/x.js', key]) {
      const file = path.join(shell.dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'source');
    }
    let resolved;
    shell.setFunctions(`sh() { shift; script=$1; shift; shift; eval "$script"; }
realpath() { printf '%s\\n' "${'$'}{RESOLVED:-$3}"; }
stat() { printf '123\\n'; }
tr() { text=; IFS= read -r text; printf '%s' "${'$'}{text,,}"; }
`);
    const run = (alias, command, options) => command.includes('rev-parse')
      ? { code: 128, stderr: 'not a git repository' }
      : shell.run(alias, 'RESOLVED=' + shQuote(resolved) + '; ' + command, options);
    const api = panelHandlers(fs, fixtureGitFiles, run);
    for (const safe of [shell.root + '/id_generator.py', shell.root + '/id_utils/x.js']) {
      resolved = safe;
      assert.equal((await api.read(safe, { sessionId: 'R1' })).current, 'source');
      assert.equal((await inspectRemoteTouchedPaths('host', [safe], { runRemoteCommand: run })).get(safe).state, 'present');
    }
    resolved = shell.root + '/' + key;
    const alias = shell.root + '/id_generator.py';
    assert.equal((await api.read(alias, { sessionId: 'R1' })).reason, 'refused', resolved);
    assert.equal((await inspectRemoteTouchedPaths('host', [alias], { runRemoteCommand: run })).get(alias).state, 'refused');
  });
}

test('round 3 m3: Git blob errors fall back to plain text while transport failures stay unreachable', async () => {
  for (const failure of [
    { code: 128, stderr: 'fatal: bad object HEAD:file' },
    { code: 128, stderr: 'fatal: could not fetch missing object from promisor remote' },
    { code: 127, stderr: 'git: command not found' },
    { code: -1 }, { code: 255 }, { code: 128, timedOut: true }, { code: 0, timedOut: true },
  ]) {
    let calls = 0;
    const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command) => {
      calls++;
      if (command.includes('rev-parse')) return { code: 0, stdout: '/repo\n' };
      return command.includes("'show'") ? failure : { code: 0, stdout: 'working text' };
    });
    const pair = await api.read('/repo/file', { sessionId: 'R1' });
    const unreachable = failure.code === -1 || failure.code === 255 || failure.timedOut;
    if (unreachable) {
      assert.equal(pair.ok, false);
      assert.equal(pair.reason, 'unknown');
    } else {
      assert.equal(pair.ok, true, pair.error);
      assert.equal(pair.git, false);
      assert.equal(pair.readOnly, true);
      assert.equal(pair.current, 'working text');
      assert.equal(pair.original, 'working text');
    }
    assert.equal(calls, 3);
  }
});

test('round 2 s1: remote reads refuse system passwords and private key names before transport', async () => {
  let calls = 0;
  const api = panelHandlers(fs, fixtureGitFiles, async () => { calls++; return { code: 0, stdout: 'secret' }; });
  for (const filePath of ['/etc/shadow', '/etc/gshadow', '/etc/ssh/ssh_host_rsa_key', '/etc/ssh/ssh_host_ed25519_key.pub',
    '/outside/private.pem', '/outside/private.KEY', '/outside/id_rsa', '/outside/id_ed25519']) {
    const result = await api.read(filePath, { sessionId: 'R1' });
    assert.equal(result.reason, 'refused', filePath);
  }
  assert.equal(calls, 0);
});

test('round 2 s1: resolved remote key paths are refused by the shell guard', async t => {
  const shell = fakeTouchedShell(t);
  fs.writeFileSync(path.join(shell.dir, 'ordinary'), 'safe');
  for (const resolved of ['/etc/shadow', '/etc/gshadow', '/etc/ssh/ssh_host_rsa_key', '/outside/private.pem', '/outside/private.key', '/outside/id_rsa']) {
    shell.tool('realpath', 'printf "%s\\n" "' + resolved + '"');
    const api = panelHandlers(fs, fixtureGitFiles, shell.run);
    const result = await api.read(shell.root + '/ordinary', { sessionId: 'R1' });
    assert.equal(result.reason, 'refused', resolved);
  }
});

function panelHandlers(fsOps = fs, gitOps = fixtureGitFiles, remoteExec = null) {
  const handlers = new Map();
  const context = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    fs: fsOps, path, isSensitivePath, gitChangesFile: gitOps, PANEL_FILE_MAX_BYTES: MAX_BYTES,
    panelSaves: createMainPanelSaves({ getKnownProjectPaths: () => [], invalidateFtsSignature() {} }),
    invalidateFtsSignature() {},
    remotePanelPaths: new Set(),
    resolveGitChangesTarget: id => id === 'R1' ? { ok: true, kind: 'remote', alias: 'host', cwd: '/repo/sub' } : { ok: false, error: 'invalid remote session' },
    readRemoteTouchedFile: args => require('../remote-touched-files').readRemoteTouchedFile(args, { runRemoteCommand: remoteExec }),
  };
  for (const channel of ['read-file-for-panel', 'save-file-for-panel']) {
    const start = source.indexOf("ipcMain.handle('" + channel + "'");
    const end = source.indexOf('\n});', start) + '\n});'.length;
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(source.slice(start, end), context, { filename: 'main.js' });
  }
  return { read: (...args) => handlers.get('read-file-for-panel')(null, ...args), save: (...args) => handlers.get('save-file-for-panel')(null, ...args) };
}

test('remote Touched IPC opens a repository file against HEAD on its remote target without local disk access', async () => {
  const calls = [];
  const api = panelHandlers({ realpathSync: { native() { throw new Error('remote paths must not reach local fs'); } } }, fixtureGitFiles,
    async (alias, command, options) => {
      calls.push({ alias, command, options });
      assert.equal(alias, 'host');
      assert.ok(options.timeoutMs > 0 && options.maxStdoutBytes > 0);
      if (command.includes('rev-parse')) return { code: 0, stdout: '/repo\n' };
      if (command.includes("'show'")) return { code: 0, stdout: 'base\n' };
      return { code: 0, stdout: 'current\n' };
    });
  const pair = await api.read('/repo/file.txt', { editor: true, sessionId: 'R1' });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.kind, 'remote');
  assert.equal(pair.git, true);
  assert.equal(pair.original, 'base\n');
  assert.equal(pair.current, 'current\n');
  assert.equal(pair.readOnly, true);
  const gitCalls = calls.filter(c => c.command.includes('git '));
  assert.equal(gitCalls.length, 2);
  assert.ok(gitCalls.every(c => c.command.includes("'--literal-pathspecs'")));
  assert.ok(gitCalls[0].command.includes("'/repo/sub'"));
  assert.ok(gitCalls[1].command.includes("'/repo'"));
  assert.ok(gitCalls[1].command.includes("'HEAD:file.txt'"));
});

test('remote Touched IPC opens outside the session repository read-only and enforces the named byte cap', async () => {
  let body = 'outside\n';
  const calls = [];
  const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command, options) => {
    calls.push({ command, options });
    return { code: 0, stdout: command.includes('rev-parse') ? '/repo\n' : body };
  });
  const pair = await api.read('/outside/file', { editor: true, sessionId: 'R1' });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, false);
  assert.equal(pair.current, body);
  assert.equal(pair.readOnly, true);
  const { REMOTE_TOUCHED_READ_MAX_BYTES } = require('../remote-touched-files');
  assert.ok(Number.isFinite(REMOTE_TOUCHED_READ_MAX_BYTES));
  body = 'é'.repeat(Math.floor(REMOTE_TOUCHED_READ_MAX_BYTES / 2));
  assert.equal((await api.read('/outside/file', { editor: true, sessionId: 'R1' })).ok, true);
  body += 'x';
  const over = await api.read('/outside/file', { editor: true, sessionId: 'R1' });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'too-large');
  const readCall = calls.find(c => c.command.includes('head'));
  assert.equal(readCall.options.maxStdoutBytes, REMOTE_TOUCHED_READ_MAX_BYTES + 1);
  assert.ok(readCall.command.includes(String(REMOTE_TOUCHED_READ_MAX_BYTES + 1)));
});

test('remote Touched IPC refuses unsafe paths and unknown targets without issuing a remote read', async () => {
  let calls = 0;
  const api = panelHandlers(fs, fixtureGitFiles, async () => { calls++; return { code: 0, stdout: '' }; });
  for (const p of ['relative', '/repo/../escape', '/new\nline', '/repo/.git/config', '/home/user/.ssh/id_rsa']) {
    const result = await api.read(p, { editor: true, sessionId: 'R1' });
    assert.equal(result.ok, false);
  }
  assert.equal((await api.read('/repo/file', { editor: true, sessionId: 'missing' })).ok, false);
  assert.equal(calls, 0);
});

test('remote Touched IPC keeps gone and unreadable read messages and stops on an unreachable host', async () => {
  for (const [code, message] of [[44, /does not exist/], [45, /could not be read/], [255, /connection|unreachable/]]) {
    let calls = 0;
    const api = panelHandlers(fs, fixtureGitFiles, async () => { calls++; return { code, stdout: '' }; });
    const result = await api.read('/repo/file', { editor: true, sessionId: 'R1' });
    assert.equal(result.ok, false);
    assert.match(result.error, message);
    assert.equal(calls, 1);
  }
});

test('remote Touched opens a file with no repository read-only and an untracked repo file against empty HEAD', async () => {
  for (const hasRepo of [false, true]) {
    const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command) => {
      if (command.includes('rev-parse')) return hasRepo ? { code: 0, stdout: '/repo\n' }
        : { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
      if (command.includes("'show'")) return { code: 128, stdout: '', stderr: "fatal: path 'new.txt' does not exist in 'HEAD'" };
      return { code: 0, stdout: 'new content\n' };
    });
    const pair = await api.read('/repo/new.txt', { editor: true, sessionId: 'R1' });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, hasRepo);
    assert.equal(pair.original, hasRepo ? '' : 'new content\n');
    assert.equal(pair.readOnly, true);
  }
});

test('remote Touched quotes hostile read operands and refuses binary and oversized HEAD content', async () => {
  for (const filePath of ['/repo/back`tick', '/repo/$(touch owned)', "/repo/one'quote", '/repo/two"quotes']) {
    const calls = [];
    const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command) => {
      calls.push(command);
      return { code: 0, stdout: command.includes('rev-parse') ? '/repo\n' : 'text' };
    });
    assert.equal((await api.read(filePath, { editor: true, sessionId: 'R1' })).ok, true);
    assert.ok(calls[0].includes("'" + filePath.replace(/'/g, "'\\''") + "'"));
    const rel = filePath.slice('/repo/'.length);
    assert.ok(calls.at(-1).includes("'HEAD:" + rel.replace(/'/g, "'\\''") + "'"));
  }
  const { REMOTE_TOUCHED_READ_MAX_BYTES } = require('../remote-touched-files');
  for (const body of ['bin\0ary', 'x'.repeat(REMOTE_TOUCHED_READ_MAX_BYTES + 1)]) {
    const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command) => ({ code: 0,
      stdout: command.includes('rev-parse') ? '/repo\n' : command.includes("'show'") ? body : 'working text' }));
    const result = await api.read('/repo/file', { editor: true, sessionId: 'R1' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, body.includes('\0') ? 'binary' : 'too-large');
  }
});

test('remote Touched refuses invalid UTF-8 in the working file and in HEAD', async () => {
  for (const badHead of [false, true]) {
    const api = panelHandlers(fs, fixtureGitFiles, async (_alias, command, options) => {
      assert.equal(options.rawStdout, true);
      if (command.includes('rev-parse')) return { code: 0, stdout: Buffer.from('/repo\n') };
      const isHead = command.includes("'show'");
      return { code: 0, stdout: isHead === badHead ? Buffer.from([0xff]) : Buffer.from('valid\n') };
    });
    const result = await api.read('/repo/file', { editor: true, sessionId: 'R1' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'encoding');
  }
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-touched-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'empty-config') };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, timeout: 10_000, stdio: 'pipe' });
  return { dir, git };
}

for (const inGit of [true, false]) {
  test('shipped panel IPC opens, saves, reloads and rejects stale Touched text (git=' + inGit + ')', async t => {
    const { dir, git } = fixture(t);
    const target = path.join(dir, 'file.txt');
    fs.writeFileSync(target, 'base\n');
    if (inGit) {
      git('init', '-q');
      git('config', 'core.autocrlf', 'false');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      git('add', 'file.txt');
      git('commit', '-qm', 'fixture');
      fs.writeFileSync(target, 'indexed\n');
      git('add', 'file.txt');
    }
    fs.writeFileSync(target, 'current\n');
    const api = panelHandlers();
    const pair = await api.read(target, { editor: true });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, inGit);
    assert.equal(pair.current, 'current\n');
    assert.equal(pair.original, inGit ? 'base\n' : 'current\n');
    const saved = await api.save(target, 'saved\n', pair.current, { git: pair.git, version: pair.version });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
    const reloaded = await api.read(target, { editor: true });
    assert.equal(reloaded.current, 'saved\n');
    assert.equal(reloaded.original, inGit ? 'base\n' : 'saved\n');
    const stale = await api.save(target, 'overwrite', pair.current, { git: pair.git, version: pair.version });
    assert.equal(stale.reason, 'stale');
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
    const ordinary = await api.read(target);
    assert.equal(ordinary.content, 'saved\n');
  });
}

test('shipped Touched read keeps missing, binary, oversized, directory and unreadable refusals', async t => {
  const { dir } = fixture(t);
  const api = panelHandlers();
  const target = path.join(dir, 'file.txt');
  assert.equal((await api.read(target, { editor: true })).ok, false);
  assert.equal((await api.read(dir, { editor: true })).ok, false);
  fs.writeFileSync(target, Buffer.from([0, 1]));
  assert.match((await api.read(target)).error, /binary/);
  const binaryPair = await api.read(target, { editor: true });
  assert.equal(binaryPair.ok, false);
  assert.match(binaryPair.error, /binary file/);
  fs.writeFileSync(target, 'x'.repeat(MAX_BYTES + 1));
  assert.match((await api.read(target, { editor: true })).error, /large/);
  const unreadable = panelHandlers({ realpathSync: fs.realpathSync, statSync: fs.statSync, readFileSync: () => { throw new Error('unreadable fixture'); } });
  fs.writeFileSync(target, 'text');
  assert.match((await unreadable.read(target, { editor: true })).error, /unreadable fixture/);
});

for (const inGit of [true, false]) {
  test('round 3: refusing a binary Touched open preserves its exact bytes (git=' + inGit + ')', async t => {
    const { dir, git } = fixture(t);
    if (inGit) git('init', '-q');
    const target = path.join(dir, 'bin.dat');
    const before = Buffer.from([0x41, 0x00, 0xff, 0x42]);
    fs.writeFileSync(target, before);
    const api = panelHandlers();
    const pair = await api.read(target, { editor: true });
    if (pair.ok) await api.save(target, pair.current, pair.current, { git: pair.git, version: pair.version });
    assert.deepEqual(fs.readFileSync(target), before, 'opening and attempting to save must preserve binary bytes');
    assert.equal(pair.ok, false);
    assert.equal(pair.error, 'binary file');
    if (inGit) {
      const direct = await fixtureGitFiles.readTouchedChangesFile({ absolutePath: target, maxBytes: MAX_BYTES });
      assert.equal(direct.ok, false);
      assert.equal(direct.reason, 'binary');
    }
  });

  test('round 3: a final file symlink opens read-only and every save refuses the link (git=' + inGit + ')', async t => {
    const { dir, git } = fixture(t);
    if (inGit) git('init', '-q');
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    fs.writeFileSync(target, 'target bytes\n');
    fs.symlinkSync(target, link, 'file');
    const api = panelHandlers();
    const ordinary = await api.read(link);
    assert.equal(ordinary.ok, true, ordinary.error);
    assert.equal(ordinary.content, 'target bytes\n');
    const pair = await api.read(link, { editor: true });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.readOnly, true);
    assert.equal(pair.current, 'target bytes\n');
    for (const opts of [undefined, { git: false }, { git: true, version: pair.version }]) {
      const saved = await api.save(link, 'overwrite', pair.current, opts);
      assert.equal(saved.ok, false);
      assert.equal(saved.reason, 'symlink');
    }
    const direct = await fixtureGitFiles.writeTouchedChangesFile({ absolutePath: link, content: 'overwrite', version: 'v1', maxBytes: MAX_BYTES });
    assert.equal(direct.reason, 'symlink');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'target bytes\n');
  });
}

for (const [name, body] of [['dash name', 'text\n'], ['mixed EOL', 'one\r\ntwo\n']]) {
  test('round 2: shipped IPC opens and saves plain content for ' + name, async t => {
    const { dir, git } = fixture(t);
    git('init', '-q');
    const target = path.join(dir, name === 'dash name' ? '-file.txt' : 'mixed.txt');
    fs.writeFileSync(target, body);
    const api = panelHandlers();
    const pair = await api.read(target, { editor: true });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, false);
    assert.equal(pair.current, gitChangesFile.toLf(body));
    const saved = await api.save(target, 'saved\n', pair.current, { git: pair.git });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
  });
}

test('round 2: real git opens and saves a Touched path through an internal junction', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'real'));
  const target = path.join(dir, 'real', 'file.txt');
  fs.writeFileSync(target, 'base\n');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', 'real/file.txt');
  git('commit', '-qm', 'fixture');
  fs.writeFileSync(target, 'current\n');
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const api = panelHandlers();
  const alias = path.join(dir, 'link', 'file.txt');
  const pair = await api.read(alias, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.original, 'base\n');
  assert.equal(pair.current, 'current\n');
  const saved = await api.save(alias, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
});

test('round 3: real git preserves HEAD and saves a modified Windows 8.3 Touched path', { skip: process.platform !== 'win32' }, async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  const target = path.join(dir, 'long-file-name.txt');
  fs.writeFileSync(target, 'base\n');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', 'long-file-name.txt');
  git('commit', '-qm', 'fixture');
  fs.writeFileSync(target, 'current\n');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir };
  const longDir = fs.realpathSync.native(dir);
  const shortDir = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("' + longDir + '") do @echo %~sI'], { env, encoding: 'utf8', timeout: 10_000, windowsVerbatimArguments: true }).trim();
  if (shortDir.toLowerCase() === longDir.toLowerCase()) { t.skip('the derived directory spelling equals its long spelling'); return; }
  const short = path.join(shortDir, 'long-file-name.txt');
  assert.notEqual(short.toLowerCase(), fs.realpathSync.native(target).toLowerCase());
  const api = panelHandlers();
  const pair = await api.read(short, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.original, 'base\n');
  assert.equal(pair.current, 'current\n');
  const saved = await api.save(short, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
});

for (const failure of [{ code: -1, stderr: 'git timed out' }, new Error('spawn git ENOENT')]) {
  test('round 2: shipped IPC falls back to plain content when git cannot run: ' + (failure.stderr || failure.message), async t => {
    const { dir } = fixture(t);
    const target = path.join(dir, 'file.txt');
    fs.writeFileSync(target, 'current\n');
    const api = panelHandlers(fs, { ...gitChangesFile, readTouchedChangesFile: args => gitChangesFile.readTouchedChangesFile(args, {
      runGit: async () => { if (failure instanceof Error) throw failure; return failure; },
    }) });
    const pair = await api.read(target, { editor: true });
    assert.equal(pair.ok, true, pair.error);
    assert.equal(pair.git, false);
    assert.equal(pair.current, 'current\n');
    assert.equal((await api.save(target, 'saved\n', pair.current, { git: false })).ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
  });
}

test('round 2: shipped plain and git read/save paths refuse .git metadata independently of git version', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  const target = path.join(dir, '.git', 'config');
  const before = fs.readFileSync(target, 'utf8');
  const api = panelHandlers(fs, { ...gitChangesFile, readTouchedChangesFile: () => { throw new Error('git must not run'); } });
  for (const opts of [undefined, { editor: true }]) assert.equal((await api.read(target, opts)).reason, 'git-dir');
  for (const opts of [undefined, { git: false }, { git: true, version: 'v1' }]) assert.equal((await api.save(target, 'overwrite', before, opts)).reason, 'git-dir');
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('round 2: real git opens a Touched file through a repository directory alias', async t => {
  const { dir, git } = fixture(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', repo);
  const target = path.join(repo, 'file.txt');
  fs.writeFileSync(target, 'current\n');
  fs.symlinkSync(repo, path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const api = panelHandlers();
  const alias = path.join(dir, 'alias', 'file.txt');
  const pair = await api.read(alias, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.current, 'current\n');
  const saved = await api.save(alias, 'saved\n', pair.current, { git: pair.git, version: pair.version });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
});

test('round 2: a noncanonical root from real git is resolved before computing the relative path', async t => {
  const { dir, git } = fixture(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', repo);
  const target = path.join(repo, 'file.txt');
  fs.writeFileSync(target, 'current\n');
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const runGit = async (args, options) => {
    const result = await fixtureRunGit(args, options);
    if (args[0] === 'rev-parse' && result.code === 0) {
      const lines = result.stdout.toString().split('\n');
      lines[0] = alias;
      result.stdout = Buffer.from(lines.join('\n'));
    }
    return result;
  };
  const pair = await gitChangesFile.readTouchedChangesFile({ absolutePath: target, maxBytes: MAX_BYTES }, { runGit });
  assert.equal(pair.ok, true, pair.error);
  assert.equal(pair.git, true);
  assert.equal(pair.current, 'current\n');
  assert.equal((await gitChangesFile.writeTouchedChangesFile({ absolutePath: target, content: 'saved\n', version: pair.version, maxBytes: MAX_BYTES }, { runGit })).ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'saved\n');
});

test('round 2: a git-directory junction is refused before probing on every panel path', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  const alias = path.join(dir, 'metadata');
  fs.symlinkSync(path.join(dir, '.git'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(alias, 'config');
  const before = fs.readFileSync(target, 'utf8');
  const deps = { runGit: () => { throw new Error('git must not run'); } };
  assert.equal((await gitChangesFile.readTouchedChangesFile({ absolutePath: target, maxBytes: MAX_BYTES }, deps)).reason, 'git-dir');
  assert.equal((await gitChangesFile.writeTouchedChangesFile({ absolutePath: target, content: 'overwrite', version: 'v1', maxBytes: MAX_BYTES }, deps)).reason, 'git-dir');
  const api = panelHandlers();
  assert.equal((await api.read(target, { editor: true })).reason, 'git-dir');
  assert.equal((await api.save(target, 'overwrite', before, { git: false })).reason, 'git-dir');
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

for (const [name, bytes] of [['binary', Buffer.from([0, 1])], ['encoding', Buffer.from([0xff])]]) {
  test('round 3: real Git ' + name + ' refusal retains its panel policy', async t => {
    const { dir, git } = fixture(t);
    git('init', '-q');
    const target = path.join(dir, 'file.txt');
    fs.writeFileSync(target, bytes);
    const pair = await panelHandlers().read(target, { editor: true });
    if (name === 'binary') {
      assert.equal(pair.ok, false);
      assert.equal(pair.error, 'binary file');
      assert.deepEqual(fs.readFileSync(target), bytes);
      return;
    }
    assert.equal(pair.ok, false);
    assert.equal(pair.reason, 'encoding');
    assert.deepEqual(fs.readFileSync(target), bytes);
  });
}

for (const phase of ['repository reread', 'blob read']) {
  for (const throws of [false, true]) {
    test('round 2: git failure during ' + phase + ' falls back to plain content (throws=' + throws + ')', async t => {
      const { dir, git } = fixture(t);
      git('init', '-q');
      const target = path.join(dir, 'file.txt');
      fs.writeFileSync(target, 'current\n');
      let probes = 0;
      const runGit = async (args, options) => {
        if (args[0] === 'rev-parse') probes++;
        if ((phase === 'repository reread' && probes === 2) || (phase === 'blob read' && args[0] === 'cat-file')) {
          if (throws) throw new Error('spawn git ENOENT');
          return { code: -1, stdout: '', stderr: 'git timed out' };
        }
        return fixtureRunGit(args, options);
      };
      const api = panelHandlers(fs, { ...fixtureGitFiles, readTouchedChangesFile: args => gitChangesFile.readTouchedChangesFile(args, { runGit }) });
      const pair = await api.read(target, { editor: true });
      assert.equal(pair.ok, true, pair.error);
      assert.equal(pair.git, false);
      assert.equal(pair.current, 'current\n');
    });
  }
}

test('round 3: a binary HEAD blob is refused without plain fallback or writes', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const target = path.join(dir, 'file.txt');
  fs.writeFileSync(target, Buffer.from([0x41, 0x00, 0xff, 0x42]));
  git('add', 'file.txt');
  git('commit', '-qm', 'fixture');
  const before = Buffer.from('now text\n');
  fs.writeFileSync(target, before);
  const pair = await panelHandlers().read(target, { editor: true });
  assert.equal(pair.ok, false);
  assert.equal(pair.reason, 'binary');
  assert.deepEqual(fs.readFileSync(target), before);
});

for (const inGit of [true, false]) {
  test('round 5: invalid UTF-8 open and every save preserve bytes (git=' + inGit + ')', async t => {
    const { dir, git } = fixture(t);
    const target = path.join(dir, 'file.txt');
    const before = Buffer.from([0x41, 0xff, 0x42, 0x0a]);
    fs.writeFileSync(target, before);
    if (inGit) {
      git('init', '-q');
      git('add', 'file.txt');
    }
    const api = panelHandlers();
    const pair = await api.read(target, { editor: true });
    assert.deepEqual(fs.readFileSync(target), before, 'open preserves the original bytes');
    for (const opts of [undefined, { git: false }, { git: true, version: gitChangesFile.versionOf(before) }]) {
      const saved = await api.save(target, before.toString('utf8'), before.toString('utf8'), opts);
      assert.deepEqual(fs.readFileSync(target), before, 'every save preserves the original bytes');
      assert.equal(saved.ok, false);
      assert.equal(saved.reason, 'encoding');
    }
    assert.equal(pair.ok, false);
    assert.equal(pair.reason, 'encoding');
    if (inGit) {
      const direct = await fixtureGitFiles.readTouchedChangesFile({ absolutePath: target, maxBytes: MAX_BYTES });
      assert.equal(direct.ok, false);
      assert.equal(direct.reason, 'encoding');
      const saved = await fixtureGitFiles.writeTouchedChangesFile({ absolutePath: target, content: 'overwrite', version: gitChangesFile.versionOf(before), maxBytes: MAX_BYTES });
      assert.equal(saved.ok, false);
      assert.deepEqual(fs.readFileSync(target), before);
    }
  });
}

test('round 5: invalid UTF-8 HEAD stays refused with valid working text', async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const target = path.join(dir, 'file.txt');
  fs.writeFileSync(target, Buffer.from([0x41, 0xff, 0x42, 0x0a]));
  git('add', 'file.txt');
  git('commit', '-qm', 'fixture');
  const before = Buffer.from('valid text\n');
  fs.writeFileSync(target, before);
  const pair = await panelHandlers().read(target, { editor: true });
  assert.equal(pair.ok, false);
  assert.equal(pair.reason, 'encoding');
  assert.deepEqual(fs.readFileSync(target), before);
});

for (const operation of ['read', 'save']) {
  test('round 5: native realpath blocks injected short metadata spelling on ' + operation, async t => {
    const { dir } = fixture(t);
    const target = path.join(dir, 'GIT~1', 'DESCRI~1');
    fs.mkdirSync(path.dirname(target));
    const before = Buffer.from('metadata bytes\n');
    fs.writeFileSync(target, before);
    const realpathSync = p => fs.realpathSync(p);
    realpathSync.native = () => path.join(dir, '.git', 'description');
    const api = panelHandlers({ ...fs, realpathSync });
    const result = operation === 'read' ? await api.read(target) : await api.save(target, 'overwrite', before.toString('utf8'), { git: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'git-dir');
    assert.deepEqual(fs.readFileSync(target), before);
  });
}

test('round 5: real Windows short metadata spelling blocks plain read and every save', { skip: process.platform !== 'win32' }, async t => {
  const { dir, git } = fixture(t);
  git('init', '-q');
  const target = path.join(dir, '.git', 'description');
  const before = fs.readFileSync(target);
  const long = fs.realpathSync.native(target);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir };
  const short = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("' + long + '") do @echo %~sI'], { env, encoding: 'utf8', timeout: 10_000, windowsVerbatimArguments: true }).trim();
  if (short.toLowerCase() === long.toLowerCase() || gitChangesFile.hasGitSegment(short)) {
    t.skip('no short spelling hiding the .git segment is available');
    return;
  }
  assert.equal(fs.realpathSync.native(short).toLowerCase(), long.toLowerCase());
  const api = panelHandlers();
  for (const opts of [undefined, { editor: true }]) {
    assert.equal((await api.read(short, opts)).reason, 'git-dir');
  }
  for (const opts of [undefined, { git: false }, { git: true, version: 'v1' }]) {
    assert.equal((await api.save(short, 'overwrite', before.toString('utf8'), opts)).reason, 'git-dir');
    assert.deepEqual(fs.readFileSync(target), before);
  }
});

test('round 5: saving a deleted file returns the friendly missing-file error', async t => {
  const { dir } = fixture(t);
  const target = path.join(dir, 'file.txt');
  fs.writeFileSync(target, 'before\n');
  const api = panelHandlers();
  const pair = await api.read(target, { editor: true });
  assert.equal(pair.ok, true, pair.error);
  fs.unlinkSync(target);
  for (const opts of [undefined, { git: false }, { git: true, version: 'v1' }]) {
    const result = await api.save(target, 'overwrite', pair.current, opts);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'File does not exist');
    assert.equal(fs.existsSync(target), false);
  }
});

test('round 5: UTF-8 save validation keeps sensitive paths unread', async t => {
  const { dir } = fixture(t);
  const target = path.join(dir, '.env');
  const before = Buffer.from('fixture-only bytes\n');
  fs.writeFileSync(target, before);
  let reads = 0;
  const api = panelHandlers({ ...fs, readFileSync: () => { reads++; throw new Error('sensitive content must not be read'); } });
  for (const opts of [undefined, { git: false }, { git: true, version: 'v1' }]) {
    const result = await api.save(target, 'overwrite', before.toString('utf8'), opts);
    assert.equal(reads, 0);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'access to sensitive path denied');
    assert.deepEqual(fs.readFileSync(target), before);
  }
});
