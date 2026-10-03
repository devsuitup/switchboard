'use strict';

// Issue #222: the enrolment check. One fixed command, one strictly parsed answer,
// and no credential ever read: `claude auth status` runs on the host with its
// output thrown away, and only its exit status comes back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { spawnSyncRetryingCrash } = require('./spawn-retry');

const {
  createSshTransport, ENROL_COMMAND, PROBE_COMMAND, LIST_COMMAND, parseEnrol,
} = require('../remote-transport');
const { resolveSshPath } = require('../remote-ssh-binary');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = 0;
  child.kill = () => { child.killed++; child.emit('close', null); };
  return child;
}

function spawnRecorder(handler) {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = fakeChild();
    calls.push({ cmd, args, child });
    if (handler) setImmediate(() => handler(child, cmd, args));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

function answer(stdout, code = 0, stderr = '') {
  return (child) => {
    if (stderr) child.stderr.push(stderr);
    child.stdout.push(stdout);
    child.stdout.push(null);
    child.emit('close', code);
  };
}

const FULL = 'tmux=1\ninotifywait=0\nclaude=1\nclaude_version=2.1.288 (Claude Code)\nclaude_dir=1\nauth=1\n';

test('ENROL_COMMAND starts with the probe verbatim and credentials are never opened by it', () => {
  assert.ok(ENROL_COMMAND.startsWith(PROBE_COMMAND + '; '));
  assert.ok(!/credentials|\.json|cat |token|keychain|ANTHROPIC/i.test(ENROL_COMMAND));
  assert.match(ENROL_COMMAND, /claude auth status >\/dev\/null 2>&1 <\/dev\/null/);
  assert.equal(
    ENROL_COMMAND.slice(PROBE_COMMAND.length),
    '; if command -v claude >/dev/null 2>&1; then echo claude=1; '
    + 'v=$(claude --version 2>/dev/null | head -n 1 | head -c 64); printf \'claude_version=%s\\n\' "$v"; else echo claude=0; fi; '
    + 'if [ -d "$HOME/.claude" ]; then echo claude_dir=1; else echo claude_dir=0; fi; '
    + 'auth=unknown; '
    + 'if command -v claude >/dev/null 2>&1 && [ -d "$HOME/.claude" ] && claude auth --help 2>/dev/null | grep -q \'^  status\'; then '
    + 'claude auth status >/dev/null 2>&1 </dev/null; rc=$?; if [ $rc -eq 0 ]; then auth=1; elif [ $rc -eq 1 ]; then auth=0; fi; fi; '
    + 'echo auth=$auth',
  );
});

test('the probe and the inventory commands are untouched by enrolment', () => {
  assert.equal(PROBE_COMMAND,
    'if command -v tmux >/dev/null 2>&1; then echo tmux=1; else echo tmux=0; fi; '
    + 'if command -v inotifywait >/dev/null 2>&1; then echo inotifywait=1; else echo inotifywait=0; fi');
  assert.ok(LIST_COMMAND.startsWith('find .claude/projects'));
});

test('parseEnrol reads the facts and keeps unknown auth distinct from logged out', () => {
  assert.deepEqual(parseEnrol(FULL), {
    tmux: true, inotifywait: false, claude: true, claudeVersion: '2.1.288 (Claude Code)', claudeDir: true, auth: true,
  });
  assert.equal(parseEnrol(FULL.replace('auth=1', 'auth=0')).auth, false);
  assert.equal(parseEnrol(FULL.replace('auth=1', 'auth=unknown')).auth, null);
  assert.deepEqual(parseEnrol('tmux=0\ninotifywait=0\nclaude=0\nclaude_dir=0\nauth=unknown\n'), {
    tmux: false, inotifywait: false, claude: false, claudeVersion: null, claudeDir: false, auth: null,
  });
});

test('parseEnrol refuses any other shape', () => {
  assert.equal(parseEnrol(''), null);
  assert.equal(parseEnrol('hello\n'), null);
  assert.equal(parseEnrol(FULL.replace('auth=1\n', '')), null);
  assert.equal(parseEnrol('motd: hi\n' + FULL), null);
  assert.equal(parseEnrol(FULL + 'extra=1\n'), null);
  assert.equal(parseEnrol(FULL.replace('auth=1', 'auth=2')), null);
  assert.equal(parseEnrol(FULL.replace('claude=1', 'claude=0')), null);
  assert.equal(parseEnrol('tmux=0\ninotifywait=0\nclaude=0\nclaude_version=1.0.0\nclaude_dir=0\nauth=unknown\n'), null);
  assert.equal(parseEnrol(FULL.replace('claude_dir=1\nauth=1\n', 'auth=1\nclaude_dir=1\n')), null);
});

test('parseEnrol drops a version string that is not shaped like one', () => {
  for (const bad of ['', '<img src=x onerror=alert(1)>', 'x'.repeat(64), '2.1.288\u001b[31m', '2.1']) {
    const parsed = parseEnrol(FULL.replace('2.1.288 (Claude Code)', bad));
    assert.ok(parsed, `the answer is still readable with version ${JSON.stringify(bad)}`);
    assert.equal(parsed.claudeVersion, null);
  }
  assert.equal(parseEnrol(FULL.replace('2.1.288 (Claude Code)', '2.1.288')).claudeVersion, '2.1.288');
});

test('checkHost spawns one bounded ssh with the same options and the alias as an operand', async () => {
  const spawn = spawnRecorder(answer(FULL));
  const t = createSshTransport({ spawn });

  const result = await t.checkHost('planificator');

  assert.equal(result.reachable, true);
  assert.equal(result.facts.claudeVersion, '2.1.288 (Claude Code)');
  assert.equal(spawn.calls.length, 1);
  const { cmd, args } = spawn.calls[0];
  assert.equal(cmd, resolveSshPath());
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.some(a => /^ConnectTimeout=/.test(a)));
  assert.ok(args.includes('-n'));
  assert.equal(args[args.length - 2], 'planificator');
  assert.equal(args[args.length - 1], ENROL_COMMAND);
  assert.equal(t.liveCount(), 0);
});

test('checkHost reports an ssh that did not connect as unreachable, never as a throw', async () => {
  const refused = createSshTransport({ spawn: spawnRecorder(answer('', 255, 'ssh: connect to host x port 22: Connection refused')) });
  const r = await refused.checkHost('x');
  assert.equal(r.reachable, false);
  assert.equal(r.facts, null);
  assert.match(r.detail, /Connection refused/);

  const gone = createSshTransport({ spawn: () => { throw new Error('spawn ssh ENOENT'); } });
  const g = await gone.checkHost('x');
  assert.equal(g.reachable, false);
  assert.match(g.detail, /ENOENT/);
});

test('checkHost reports a connected host whose command failed as reachable with no facts', async () => {
  const t = createSshTransport({ spawn: spawnRecorder(answer('', 127, "'command' is not recognized")) });
  const r = await t.checkHost('winbox');
  assert.equal(r.reachable, true);
  assert.equal(r.facts, null);
  assert.match(r.detail, /exit 127/);
});

test('checkHost reports unreadable output as reachable with no facts', async () => {
  const t = createSshTransport({ spawn: spawnRecorder(answer('Welcome!\n')) });
  const r = await t.checkHost('x');
  assert.equal(r.reachable, true);
  assert.equal(r.facts, null);
  assert.match(r.detail, /unexpected output/);
});

test('checkHost kills a hung ssh at its own timeout and reports it unreachable', async () => {
  const hung = spawnRecorder(null);
  const t = createSshTransport({ spawn: hung, enrolTimeoutMs: 30 });
  const r = await t.checkHost('x');
  assert.equal(r.reachable, false);
  assert.match(r.detail, /timed out/);
  assert.equal(hung.calls[0].child.killed, 1);
  assert.equal(t.liveCount(), 0);
});

test('checkHost caps the output it reads', async () => {
  const spawn = spawnRecorder((child) => {
    child.stdout.push('x'.repeat(4096));
    child.stdout.push(null);
  });
  const t = createSshTransport({ spawn });
  const r = await t.checkHost('x');
  assert.equal(r.facts, null);
  assert.match(r.detail, /size cap/);
  assert.equal(spawn.calls[0].child.killed, 1);
});

test('checkHost keeps the stderr it reports short and free of control characters', async () => {
  const noisy = 'ssh: bad\u001b[31m thing\n' + 'y'.repeat(1000);
  const t = createSshTransport({ spawn: spawnRecorder(answer('', 255, noisy)) });
  const r = await t.checkHost('x');
  assert.ok(r.detail.length <= 240, `detail is ${r.detail.length} long`);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(r.detail));
});

const SH_SKIP = spawnSync('sh', ['-c', 'exit 0']).error ? 'sh is not available on this machine' : false;

function shQuote(p) { return `'${p.replace(/'/g, `'\\''`)}'`; }

function runEnrol({ home, prelude }) {
  const result = spawnSyncRetryingCrash('sh', ['-c', `HOME=${shQuote(home)}; PATH=/usr/bin:/bin; ${prelude}${ENROL_COMMAND}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, `a missing tool is an answer, not a failure (stderr: ${result.stderr})`);
  const facts = parseEnrol(result.stdout);
  assert.ok(facts, `unreadable answer: ${result.stdout}`);
  const { claude, claudeVersion, claudeDir, auth } = facts;
  return { claude, claudeVersion, claudeDir, auth };
}

function fakeClaude({ status, hasAuthSub = true, version = '2.1.288 (Claude Code)', log }) {
  const authHelp = hasAuthSub ? 'Commands:\\n  login [options]\\n  status [options]  Show authentication status' : 'Usage: claude [options]';
  return `claude() { `
    + `if [ "$1" = --version ]; then echo '${version}'; return 0; fi; `
    + `if [ "$1" = auth ] && [ "$2" = --help ]; then printf '${authHelp}\\n'; return 0; fi; `
    + `if [ "$1" = auth ] && [ "$2" = status ]; then echo "$*" >> ${shQuote(log)}; echo '{"email":"secret@example.com"}'; return ${status}; fi; `
    + `echo "unexpected: $*" >> ${shQuote(log)}; return 99; }; `;
}

test('ENROL_COMMAND answers each fact through a real shell, and discards what claude auth status prints', { skip: SH_SKIP }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'enrol-home-'));
  const log = path.join(home, 'calls.log');
  try {
    assert.deepEqual(runEnrol({ home, prelude: '' }), {
      claude: false, claudeVersion: null, claudeDir: false, auth: null,
    });

    fs.mkdirSync(path.join(home, '.claude'));
    assert.deepEqual(runEnrol({ home, prelude: fakeClaude({ status: 0, log }) }), {
      claude: true, claudeVersion: '2.1.288 (Claude Code)', claudeDir: true, auth: true,
    });
    assert.equal(runEnrol({ home, prelude: fakeClaude({ status: 1, log }) }).auth, false);
    assert.equal(runEnrol({ home, prelude: fakeClaude({ status: 7, log }) }).auth, null);
    assert.equal(runEnrol({ home, prelude: fakeClaude({ status: 1, hasAuthSub: false, log }) }).auth, null);

    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.every(c => c === 'auth status'), `only auth status was ever run, got ${calls}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ENROL_COMMAND never runs claude auth status on a host with no ~/.claude', { skip: SH_SKIP }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'enrol-home-'));
  const log = path.join(home, 'calls.log');
  try {
    const facts = runEnrol({ home, prelude: fakeClaude({ status: 0, log }) });
    assert.equal(facts.claudeDir, false);
    assert.equal(facts.auth, null);
    assert.ok(!fs.existsSync(log) || !/auth status/.test(fs.readFileSync(log, 'utf8')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
