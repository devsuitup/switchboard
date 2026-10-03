'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateLaunchCwd,
  validateSessionId,
  buildClaudeArgs,
  buildLaunchScript,
  buildLaunchCommand,
  parseLaunchOutput,
  tmuxSessionName,
  createRemoteLaunchAdapter,
  handleLaunchRequest,
  NO_DIR_EXIT_CODE,
  NO_TMUX_EXIT_CODE,
  NO_CLAUDE_EXIT_CODE,
} = require('../remote-launch');
const { buildStopCommand } = require('../remote-stop');
const { shellSingleQuote, parseTmuxField } = require('../remote-attach');

const UUID = '3f2a9c10-7b1d-4e55-9a60-0123456789ab';
const silentLog = { info() {}, warn() {}, error() {} };

test('the script is an exact string: directory check, tmux and claude checks, detached tmux session running claude', () => {
  const script = buildLaunchScript({ sessionId: UUID, cwd: '/srv/app', options: {} });
  assert.equal(script,
    `cwd='/srv/app'; [ -d "$cwd" ] || exit ${NO_DIR_EXIT_CODE}; ` +
    `command -v tmux >/dev/null 2>&1 || exit ${NO_TMUX_EXIT_CODE}; ` +
    `command -v claude >/dev/null 2>&1 || exit ${NO_CLAUDE_EXIT_CODE}; ` +
    `exec tmux new-session -d -P -F '#{session_name}:#{window_id}.#{pane_id} #{pane_pid}' ` +
    `-s switchboard-3f2a9c10 -c "$cwd" 'claude --session-id ${UUID}'`);
});

test('the command wraps the script in sh -c so a non-POSIX login shell never parses it', () => {
  const script = buildLaunchScript({ sessionId: UUID, cwd: '/srv/app', options: {} });
  assert.equal(buildLaunchCommand({ sessionId: UUID, cwd: '/srv/app', options: {} }), `sh -c ${shellSingleQuote(script)}`);
});

test('permission options map to CLI flags and nothing else reaches the command', () => {
  assert.deepEqual(buildClaudeArgs({ permissionMode: 'plan' }), { ok: true, args: ['--permission-mode', 'plan'] });
  assert.deepEqual(buildClaudeArgs({ dangerouslySkipPermissions: true, permissionMode: 'plan' }), { ok: true, args: ['--dangerously-skip-permissions'] });
  assert.deepEqual(buildClaudeArgs({}), { ok: true, args: [] });
  assert.deepEqual(buildClaudeArgs(null), { ok: true, args: [] });
  assert.deepEqual(buildClaudeArgs({ permissionMode: null, addDirs: '/x; rm -rf /', preLaunchCmd: 'evil' }), { ok: true, args: [] });
  const bad = buildClaudeArgs({ permissionMode: 'plan; rm -rf /' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /permission mode/);
  const script = buildLaunchScript({ sessionId: UUID, cwd: '/srv/app', options: { permissionMode: 'acceptEdits' } });
  assert.match(script, /'claude --session-id [0-9a-f-]+ --permission-mode acceptEdits'$/);
});

test('a hostile working directory is refused, naming the rule', () => {
  const hostile = [
    "/srv/it's", '/srv/$(id)', '/srv/`id`', '/srv/a\nb', '/srv/a;b', '/srv/a"b', '/srv/a\\b', '/srv/a|b', '/srv/a&b',
    '/srv/a$HOME', '/srv/../etc', '-rf', '--help', 'relative/path', '', '/srv/a\0b', '/' + 'a'.repeat(4100), 42, null, undefined,
  ];
  for (const cwd of hostile) {
    const verdict = validateLaunchCwd(cwd);
    assert.equal(verdict.ok, false, JSON.stringify(cwd));
    assert.equal(typeof verdict.error, 'string');
    assert.throws(() => buildLaunchScript({ sessionId: UUID, cwd, options: {} }), undefined, JSON.stringify(cwd));
  }
  assert.match(validateLaunchCwd('/srv/a$b').error, /characters/);
  assert.match(validateLaunchCwd('-rf').error, /absolute/);
  assert.match(validateLaunchCwd('/srv/../etc').error, /\.\./);
});

test('an ordinary directory, spaces and punctuation included, is accepted and stays single-quoted', () => {
  for (const cwd of ['/', '/srv/app', '/home/jb/My Project', '/srv/a.b_c-d+e@f:g,h=i', '/srv/app/']) {
    assert.deepEqual(validateLaunchCwd(cwd), { ok: true }, cwd);
  }
  assert.match(buildLaunchScript({ sessionId: UUID, cwd: '/home/jb/My Project', options: {} }), /^cwd='\/home\/jb\/My Project'; /);
});

test('the session id must be a uuid', () => {
  assert.deepEqual(validateSessionId(UUID), { ok: true });
  for (const id of ['', 'abc', UUID + ' ', UUID + "'; id", UUID.toUpperCase() + 'x', null, 7, `${UUID}\n`]) {
    assert.equal(validateSessionId(id).ok, false, JSON.stringify(id));
    assert.throws(() => buildLaunchScript({ sessionId: id, cwd: '/srv/app', options: {} }), undefined, JSON.stringify(id));
  }
});

test('the tmux session name is generated from the uuid and is a valid tmux field', () => {
  assert.equal(tmuxSessionName(UUID), 'switchboard-3f2a9c10');
  assert.ok(parseTmuxField(`${tmuxSessionName(UUID)}:@3.%5`));
});

test('the launch output yields the pane target and pid; anything else is refused', () => {
  assert.deepEqual(parseLaunchOutput('switchboard-3f2a9c10:@3.%5 4242\n'), { tmux: 'switchboard-3f2a9c10:@3.%5', pid: 4242 });
  for (const bad of ['', 'garbage', 'x:@3.%5 0', 'x:@3.%5 abc', 'x:@3 4242', "x:@3.%5 4242; id", 'a b:@3.%5 4242', null]) {
    assert.equal(parseLaunchOutput(bad), null, JSON.stringify(bad));
  }
});

test('the stop command for a session we launched kills the pane and never the session', () => {
  const parsed = parseLaunchOutput('switchboard-3f2a9c10:@3.%5 4242\n');
  const stop = buildStopCommand(4242, parseTmuxField(parsed.tmux).target);
  assert.match(stop, /kill-pane -t switchboard-3f2a9c10:@3\.%5/);
  assert.doesNotMatch(stop, /kill-session/);
});

function fakeRun(result) {
  const calls = [];
  const run = async (alias, command, opts) => { calls.push({ alias, command, opts }); return typeof result === 'function' ? result(command) : result; };
  return { run, calls };
}

test('adapter: success returns a descriptor naming the created pane, over the same ssh runner', async () => {
  const { run, calls } = fakeRun({ code: 0, stdout: 'switchboard-3f2a9c10:@3.%5 4242\n', stderr: '' });
  const adapter = createRemoteLaunchAdapter({ runRemoteCommand: run, log: silentLog });
  const result = await adapter.launch('box', { sessionId: UUID, cwd: '/srv/app', options: { permissionMode: 'plan' } });
  assert.deepEqual(result, { ok: true, descriptor: { sessionId: UUID, pid: 4242, tmux: 'switchboard-3f2a9c10:@3.%5', cwd: '/srv/app' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].alias, 'box');
  assert.equal(calls[0].command, buildLaunchCommand({ sessionId: UUID, cwd: '/srv/app', options: { permissionMode: 'plan' } }));
  assert.ok(calls[0].opts.timeoutMs > 0);
});

test('adapter: a missing directory is reported and a hostile one never reaches ssh', async () => {
  const missing = fakeRun({ code: NO_DIR_EXIT_CODE, stdout: '', stderr: '' });
  let result = await createRemoteLaunchAdapter({ runRemoteCommand: missing.run, log: silentLog })
    .launch('box', { sessionId: UUID, cwd: '/nope', options: {} });
  assert.equal(result.ok, false);
  assert.match(result.error, /directory \/nope does not exist on box/);

  const never = fakeRun({ code: 0, stdout: '', stderr: '' });
  result = await createRemoteLaunchAdapter({ runRemoteCommand: never.run, log: silentLog })
    .launch('box', { sessionId: UUID, cwd: '/srv/$(id)', options: {} });
  assert.equal(result.ok, false);
  assert.equal(never.calls.length, 0);
});

test('adapter: no tmux, no claude, ssh failure, timeout and unreadable output each say what happened', async () => {
  const launch = (res) => createRemoteLaunchAdapter({ runRemoteCommand: fakeRun(res).run, log: silentLog })
    .launch('box', { sessionId: UUID, cwd: '/srv/app', options: {} });
  assert.match((await launch({ code: NO_TMUX_EXIT_CODE, stdout: '', stderr: '' })).error, /tmux is not installed on box/);
  assert.match((await launch({ code: NO_CLAUDE_EXIT_CODE, stdout: '', stderr: '' })).error, /claude was not found on the PATH of an ssh command on box/);
  assert.match((await launch({ code: 255, stdout: '', stderr: 'Connection refused\n' })).error, /launch failed \(exit 255\): Connection refused/);
  assert.match((await launch({ code: 1, stdout: '', stderr: '' })).error, /no stderr/);
  assert.match((await launch({ code: -1, stdout: '', stderr: '', timedOut: true })).error, /timed out/);
  assert.match((await launch({ code: 0, stdout: 'nonsense', stderr: '' })).error, /tmux target/);
  assert.match((await launch(null)).error, /no response/);
  const throwing = createRemoteLaunchAdapter({ runRemoteCommand: async () => { throw new Error('boom'); }, log: silentLog });
  assert.match((await throwing.launch('box', { sessionId: UUID, cwd: '/srv/app', options: {} })).error, /launch failed: boom/);
});

function makeDeps(overrides = {}) {
  const calls = { launch: [], attach: [] };
  const deps = {
    hasHost: (alias) => alias === 'box',
    launchBlockReason: () => null,
    adapter: {
      launch: async (alias, req) => {
        calls.launch.push({ alias, req });
        return { ok: true, descriptor: { sessionId: req.sessionId, pid: 4242, tmux: 'switchboard-3f2a9c10:@3.%5', cwd: req.cwd } };
      },
    },
    attach: async (alias, descriptor, size) => {
      calls.attach.push({ alias, descriptor, size });
      return { ok: true, ptyProcess: { id: 'pty' } };
    },
    ...overrides,
  };
  return { deps, calls };
}

const PAYLOAD = { alias: 'box', sessionId: UUID, cwd: '/srv/app', options: { permissionMode: 'plan' }, initialSize: { cols: 100, rows: 30 } };

test('flow: on success attach is called with the created target and the local size', async () => {
  const { deps, calls } = makeDeps();
  const result = await handleLaunchRequest(PAYLOAD, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.attach, [{
    alias: 'box',
    descriptor: { sessionId: UUID, pid: 4242, tmux: 'switchboard-3f2a9c10:@3.%5', cwd: '/srv/app' },
    size: { cols: 100, rows: 30 },
  }]);
  assert.deepEqual(result.attachResult, { ok: true, ptyProcess: { id: 'pty' } });
});

test('flow: a failed directory check is reported and attach is never called', async () => {
  const { deps, calls } = makeDeps({ adapter: { launch: async () => ({ ok: false, error: 'directory /srv/app does not exist on box' }) } });
  const result = await handleLaunchRequest(PAYLOAD, deps);
  assert.deepEqual(result, { ok: false, error: 'directory /srv/app does not exist on box' });
  assert.equal(calls.attach.length, 0);
});

test('flow: a host whose launch tier is blocked is refused before any ssh', async () => {
  const { deps, calls } = makeDeps({ launchBlockReason: () => 'needs tmux on the host' });
  const result = await handleLaunchRequest(PAYLOAD, deps);
  assert.deepEqual(result, { ok: false, error: 'needs tmux on the host' });
  assert.equal(calls.launch.length, 0);
});

test('flow: an undeclared host, a bad id or a malformed request is refused before any ssh', async () => {
  const { deps, calls } = makeDeps();
  for (const payload of [
    null, {}, { ...PAYLOAD, alias: 'other' }, { ...PAYLOAD, alias: 7 }, { ...PAYLOAD, sessionId: 'nope' }, { ...PAYLOAD, cwd: '/a/$(id)' },
  ]) {
    const result = await handleLaunchRequest(payload, deps);
    assert.equal(result.ok, false, JSON.stringify(payload));
  }
  assert.equal(calls.launch.length, 0);
});

test('flow: a failed attach after a successful launch says the session is running on the host', async () => {
  const { deps } = makeDeps({ attach: async () => ({ ok: false, error: 'size probe failed' }) });
  const result = await handleLaunchRequest(PAYLOAD, deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /started on box as switchboard-3f2a9c10:@3\.%5/);
  assert.match(result.error, /size probe failed/);
});

test('flow: a bogus initialSize is passed on as null rather than trusted', async () => {
  const { deps, calls } = makeDeps();
  await handleLaunchRequest({ ...PAYLOAD, initialSize: { cols: -1, rows: 'x' } }, deps);
  assert.equal(calls.attach[0].size, null);
});

const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
const HAVE_SH = sh.status === 0 && /ok/.test(sh.stdout || '');

test('real sh: the script refuses a missing directory with its own exit code, runs nothing', { skip: !HAVE_SH }, () => {
  const script = buildLaunchScript({ sessionId: UUID, cwd: '/definitely/not/a/dir', options: {} });
  const res = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, NO_DIR_EXIT_CODE);
});

function toPosix(p) {
  return p.split(path.sep).join('/').replace(/^([A-Za-z]):/, (_m, d) => '/' + d.toLowerCase());
}

test('real sh: with tmux and claude stubbed on PATH the script runs the exact tmux argv', { skip: !HAVE_SH }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const cwd = path.join(dir, 'work dir');
    fs.mkdirSync(cwd);
    const posixCwd = toPosix(cwd);
    if (!validateLaunchCwd(posixCwd).ok) { t.skip('the temporary directory path is outside the accepted character set'); return; }
    const argvFile = path.join(dir, 'argv.txt');
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'tmux'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\n' "$a"; done > '${toPosix(argvFile)}'\necho 'switchboard-3f2a9c10:@3.%5 4242'\n`, { mode: 0o755 });
    const script = buildLaunchScript({ sessionId: UUID, cwd: posixCwd, options: { permissionMode: 'plan' } });
    const res = spawnSync('sh', ['-c', `PATH='${toPosix(bin)}':"$PATH"; ${script}`], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${res.stderr} / ${res.stdout}`);
    assert.deepEqual(parseLaunchOutput(res.stdout), { tmux: 'switchboard-3f2a9c10:@3.%5', pid: 4242 });
    const argv = fs.readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
    assert.deepEqual(argv, [
      'new-session', '-d', '-P', '-F', '#{session_name}:#{window_id}.#{pane_id} #{pane_pid}',
      '-s', 'switchboard-3f2a9c10', '-c', posixCwd, `claude --session-id ${UUID} --permission-mode plan`,
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory of 4096 bytes is accepted and one of 4097 is refused', () => {
  assert.deepEqual(validateLaunchCwd('/' + 'a'.repeat(4095)), { ok: true });
  assert.equal(validateLaunchCwd('/' + 'a'.repeat(4096)).ok, false);
});

test('only a boolean true adds the skip-permissions flag', () => {
  assert.deepEqual(buildClaudeArgs({ dangerouslySkipPermissions: true }), { ok: true, args: ['--dangerously-skip-permissions'] });
  for (const value of ['true', 1, 'false', 0, null, {}]) {
    assert.deepEqual(buildClaudeArgs({ dangerouslySkipPermissions: value }), { ok: true, args: [] }, JSON.stringify(value));
  }
});

test('the launch output is read from its last non-empty line, so rc-file noise before it is ignored', () => {
  const target = 'switchboard-3f2a9c10:@3.%5 4242';
  assert.deepEqual(parseLaunchOutput(`Welcome to box\nmotd line\n${target}\n\n`), { tmux: 'switchboard-3f2a9c10:@3.%5', pid: 4242 });
  assert.deepEqual(parseLaunchOutput(`${target}\r\n`), { tmux: 'switchboard-3f2a9c10:@3.%5', pid: 4242 });
  assert.equal(parseLaunchOutput(`${target}\ntrailing noise\n`), null);
});

test('real sh: buildLaunchCommand itself, run through sh -c, executes the exact tmux argv', { skip: !HAVE_SH }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const cwd = path.join(dir, 'work dir');
    fs.mkdirSync(cwd);
    const posixCwd = toPosix(cwd);
    if (!validateLaunchCwd(posixCwd).ok) { t.skip('the temporary directory path is outside the accepted character set'); return; }
    const argvFile = path.join(dir, 'argv.txt');
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'tmux'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\n' "$a"; done > '${toPosix(argvFile)}'\necho 'noise'\necho 'switchboard-3f2a9c10:@3.%5 4242'\n`, { mode: 0o755 });
    const command = buildLaunchCommand({ sessionId: UUID, cwd: posixCwd, options: { dangerouslySkipPermissions: true } });
    const res = spawnSync('sh', ['-c', `PATH='${toPosix(bin)}':"$PATH"; ${command}`], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${res.stderr} / ${res.stdout}`);
    assert.deepEqual(parseLaunchOutput(res.stdout), { tmux: 'switchboard-3f2a9c10:@3.%5', pid: 4242 });
    const argv = fs.readFileSync(argvFile, 'utf8').split('\n').slice(0, -1);
    assert.deepEqual(argv.slice(-3), ['-c', posixCwd, `claude --session-id ${UUID} --dangerously-skip-permissions`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
