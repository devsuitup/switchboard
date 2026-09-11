'use strict';

// The tmux attach adapter, fully injected: no ssh, no node-pty, no network.
// Three properties matter for issue #221 and each is proven capable of
// catching its own violation (see .ai/contexts/session-cache.md, "Remote
// hosts -- tmux attach"):
//   1. PTY size = window height + status lines, not the bare height.
//   2. A descriptor with no multiplexer field never attempts an attach.
//   3. The returned ptyProcess is pilotable (write/kill) without assuming
//      any real local pty underneath it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  createTmuxAttachAdapter,
  parseTmuxField,
  parseProbeOutput,
  parseDiscoveryProbeOutput,
  buildProbeCommand,
  buildAttachCommand,
  buildRestoreCommand,
  buildRemoteCommandArgs,
} = require('../remote-attach');

const PROBE_SEP = '';
const silentLog = { info() {}, warn() {}, error() {} };

/** A minimal IPty-like double: onData/onExit/write/resize/kill/pid. */
function fakeRawPty() {
  const emitter = new EventEmitter();
  const writes = [];
  const resizes = [];
  let killed = 0;
  const pty = {
    write: (d) => writes.push(d),
    resize: (cols, rows) => resizes.push({ cols, rows }),
    onData: (cb) => emitter.on('data', cb),
    onExit: (cb) => emitter.on('exit', cb),
    kill: () => { killed++; emitter.emit('exit', { exitCode: 0 }); },
    pid: 4242,
  };
  return { pty, writes, resizes, emitter, killedCount: () => killed };
}

const FAKE_SOCKET = '/tmp/tmux-0/test';

function makeAdapter({ probeStdout, probeCode = 0, spawnCalls = [], rawPtyFactory, socket = FAKE_SOCKET, probeCalls, log = silentLog } = {}) {
  const runRemoteCommand = async (alias, command) => {
    if (probeCalls) probeCalls.push(command);
    return {
      code: probeCode,
      stdout: probeCode === 0 ? `${socket}${PROBE_SEP}${probeStdout || ''}` : (probeStdout || ''),
      stderr: '',
    };
  };
  const spawnPty = (file, args, ptyOpts) => {
    spawnCalls.push({ file, args, ptyOpts });
    return (rawPtyFactory || (() => fakeRawPty().pty))();
  };
  return createTmuxAttachAdapter({ spawnPty, runRemoteCommand, log });
}

test('parseTmuxField accepts the CLI-written format and rejects the rest', () => {
  assert.deepEqual(parseTmuxField('main:@0.%0'), { socket: 'main', target: 'main:@0.%0' });
  assert.equal(parseTmuxField(undefined), null);
  assert.equal(parseTmuxField(''), null);
  assert.equal(parseTmuxField('no-colon-here'), null);
  assert.equal(parseTmuxField('main:@0; rm -rf /'), null, 'shell metacharacters must be refused, not escaped');
});

// Property 1 -- sizing rule.
test('parseProbeOutput sizes rows as height plus status lines (status on)', () => {
  assert.deepEqual(
    parseProbeOutput('200x51' + PROBE_SEP + 'status on'),
    { cols: 200, rows: 52, pre: { status: 'on', mouse: null, windowSize: null } },
  );
});

test('parseProbeOutput sizes rows as height plus 0 when status is off', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status off'),
    { cols: 200, rows: 50, pre: { status: 'off', mouse: null, windowSize: null } },
  );
});

test('parseProbeOutput honors a rendered status line count beyond on/off', () => {
  assert.deepEqual(
    parseProbeOutput('200x51' + PROBE_SEP + 'status 2'),
    { cols: 200, rows: 53, pre: { status: 2, mouse: null, windowSize: null } },
  );
});

test('parseProbeOutput returns null when the size cannot be parsed', () => {
  assert.equal(parseProbeOutput('garbage'), null);
});

// issue #253 -- pre-attach mouse/window-size, present.
test('parseProbeOutput parses pre-attach mouse and window-size when present', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status off' + PROBE_SEP + 'mouse on' + PROBE_SEP + 'window-size latest'),
    { cols: 200, rows: 50, pre: { status: 'off', mouse: 'on', windowSize: 'latest' } },
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: 'off', windowSize: 'manual' } },
  );
});

// issue #253 -- pre-attach mouse/window-size, absent/unset: the probe segment
// is empty (as it would be if the remote tmux produced no matching line),
// never guessed at.
test('parseProbeOutput reports null for mouse and window-size when absent from the probe output', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + ''),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null } },
  );
  // No separators at all beyond size+status -- same as the pre-#253 wire format.
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status off'),
    { cols: 200, rows: 50, pre: { status: 'off', mouse: null, windowSize: null } },
  );
});

// Property 1, through the adapter: the size handed to spawnPty must already
// carry the status-line correction, not the bare tmux window height.
test('attach() spawns the pty at window height plus status lines, never the bare height', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({ probeStdout: '200x50' + PROBE_SEP + 'status on', spawnCalls });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' });

  assert.equal(result.ok, true);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(
    { cols: spawnCalls[0].ptyOpts.cols, rows: spawnCalls[0].ptyOpts.rows },
    { cols: 200, rows: 51 },
    'a client attaching at the bare tmux height (50) leaves the window one row short after detach -- see .ai/contexts/session-cache.md',
  );
});

// Property 2 -- a descriptor naming no multiplexer is refused up front.
test('attach() refuses a descriptor with no tmux field, before any ssh call', async () => {
  const spawnCalls = [];
  let probeCalls = 0;
  const runRemoteCommand = async () => { probeCalls++; return { code: 0, stdout: '' }; };
  const adapter = createTmuxAttachAdapter({
    spawnPty: (...args) => { spawnCalls.push(args); return fakeRawPty().pty; },
    runRemoteCommand,
    log: silentLog,
  });

  const result = await adapter.attach('vps', { sessionId: 's1' });

  assert.equal(result.ok, false);
  assert.match(result.error, /tmux/i);
  assert.equal(probeCalls, 0, 'no size probe should ever be sent for a host with no declared multiplexer');
  assert.equal(spawnCalls.length, 0, 'no attach pty should ever be spawned for a host with no declared multiplexer');
});

test('supports() reports false for a descriptor without a usable tmux field or a readable pid', () => {
  const adapter = makeAdapter({});
  assert.equal(adapter.supports({ sessionId: 's1' }), false);
  assert.equal(adapter.supports({ sessionId: 's1', tmux: 'not valid', pid: 4242 }), false);
  assert.equal(
    adapter.supports({ sessionId: 's1', tmux: 'main:@0.%0' }),
    false,
    'no pid means no way to discover the socket -- not attachable',
  );
  assert.equal(adapter.supports({ sessionId: 's1', tmux: 'main:@0.%0', pid: 4242 }), true);
});

// Property: the socket comes from the process's own TMUX environment
// variable, never from the descriptor's tmux field -- issue #221's actual
// production failure ("error connecting to /tmp/tmux-0/main") came from
// treating the descriptor's "main:@0.%0" as a socket name.
test('attach() discovers the socket from the process TMUX env var, not the descriptor tmux field (issue #221)', async () => {
  const spawnCalls = [];
  let probeCalls = 0;
  const runRemoteCommand = async (alias, command) => {
    probeCalls++;
    assert.match(command, /\/proc\/4085772\/environ/, 'must read the environ of the descriptor pid, not a guessed one');
    assert.doesNotMatch(command, /-L /, 'must never derive a -L socket name from the descriptor tmux field');
    // What a real /proc/<pid>/environ TMUX line yields once the remote
    // shell does `cut -d, -f1` on it -- measured on the host 2026-09-08.
    const socket = 'TMUX=/tmp/tmux-0/orchestration,4085772,0'.slice('TMUX='.length).split(',')[0];
    return { code: 0, stdout: `${socket}${PROBE_SEP}200x50${PROBE_SEP}status on`, stderr: '' };
  };
  const adapter = createTmuxAttachAdapter({
    spawnPty: (file, args, ptyOpts) => { spawnCalls.push({ file, args, ptyOpts }); return fakeRawPty().pty; },
    runRemoteCommand,
    log: silentLog,
  });

  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4085772, tmux: 'main:@0.%0' });

  assert.equal(result.ok, true);
  assert.equal(probeCalls, 1, 'discovery must ride the existing probe call, not a separate ssh connection');
  assert.equal(spawnCalls.length, 1);
  const attachCommand = spawnCalls[0].args[spawnCalls[0].args.length - 1];
  assert.match(
    attachCommand,
    /-S '\/tmp\/tmux-0\/orchestration'/,
    'attach must use the socket discovered from TMUX, never one derived from the descriptor tmux field',
  );
  assert.match(attachCommand, /-t main:@0\.%0/, 'the descriptor tmux field still supplies the -t target');
});

// Property: no readable TMUX env var means no attach attempt, ever -- never
// a guess at a socket name.
test('attach() refuses when the remote process has no readable TMUX env var, without attempting to attach', async () => {
  const spawnCalls = [];
  let probeCalls = 0;
  const runRemoteCommand = async () => { probeCalls++; return { code: 3, stdout: '', stderr: 'NO_TMUX_ENV\n' }; };
  const adapter = createTmuxAttachAdapter({
    spawnPty: (...args) => { spawnCalls.push(args); return fakeRawPty().pty; },
    runRemoteCommand,
    log: silentLog,
  });

  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' });

  assert.equal(result.ok, false);
  assert.match(result.error, /tmux environment/i);
  assert.equal(probeCalls, 1);
  assert.equal(spawnCalls.length, 0, 'no attach pty may be spawned when the socket cannot be discovered');
});

// Property: a descriptor with no readable pid is refused before any ssh call
// at all -- there is nothing to read /proc/<pid>/environ from.
test('attach() refuses a descriptor with no readable pid, before any ssh call', async () => {
  const spawnCalls = [];
  let probeCalls = 0;
  const runRemoteCommand = async () => { probeCalls++; return { code: 0, stdout: '' }; };
  const adapter = createTmuxAttachAdapter({
    spawnPty: (...args) => { spawnCalls.push(args); return fakeRawPty().pty; },
    runRemoteCommand,
    log: silentLog,
  });

  const result = await adapter.attach('vps', { sessionId: 's1', tmux: 'main:@0.%0' });

  assert.equal(result.ok, false);
  assert.match(result.error, /pid/i);
  assert.equal(probeCalls, 0);
  assert.equal(spawnCalls.length, 0);
});

// Property 3 -- the returned ptyProcess is pilotable without any real local
// node-pty: writes reach the underlying process, and kill() detaches by
// ending the local ssh client, sending nothing to the remote session.
test('the returned ptyProcess pilots the fake remote pty through write() and kill()', async () => {
  const raw = fakeRawPty();
  const adapter = makeAdapter({ probeStdout: '200x50' + PROBE_SEP + 'status on', rawPtyFactory: () => raw.pty });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' });

  assert.equal(result.ok, true);
  const { ptyProcess } = result;

  ptyProcess.write('echo hi\n');
  assert.deepEqual(raw.writes, ['echo hi\n'], 'write() must reach the underlying process verbatim');
  assert.equal(ptyProcess.isAlive(), true);
  assert.equal(ptyProcess.pid, 4242);

  ptyProcess.kill();
  // Detaching means ending the local ssh client and nothing else: any prefix
  // keystroke would assume this host's tmux prefix and land as literal text
  // in the remote session on a host that remapped it. Measured on the live
  // host: killing the client alone takes the attached client count back to 0
  // and leaves the session running.
  assert.deepEqual(raw.writes, ['echo hi\n'], 'kill() must not send any keystroke to the remote session');
  assert.equal(raw.killedCount(), 1, 'kill() must end the local ssh client');
  assert.equal(ptyProcess.isAlive(), false);
});

test('resize() is a no-op -- a fixed-size attach is never resized mid-session', async () => {
  const raw = fakeRawPty();
  const adapter = makeAdapter({ probeStdout: '200x50' + PROBE_SEP + 'status on', rawPtyFactory: () => raw.pty });
  const { ptyProcess } = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' });
  assert.doesNotThrow(() => ptyProcess.resize(80, 24));
  assert.deepEqual(raw.writes, []);
});

test('attach() surfaces a failed size probe without spawning anything', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({ probeCode: 1, spawnCalls });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' });
  assert.equal(result.ok, false);
  assert.equal(spawnCalls.length, 0);
});

// Solo vs shared (issue #221 follow-up) -- property 1: no other client means
// a normal, resizable terminal at the locally measured size.
test('attach() opens at the local size and forwards resize to the ssh pty when no other client is attached', async () => {
  const raw = fakeRawPty();
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '0',
    spawnCalls,
    rawPtyFactory: () => raw.pty,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    { cols: spawnCalls[0].ptyOpts.cols, rows: spawnCalls[0].ptyOpts.rows },
    { cols: 100, rows: 40 },
    'solo attach must open at the locally measured size, not the remote window size',
  );

  result.ptyProcess.resize(120, 50);
  assert.deepEqual(raw.resizes, [{ cols: 120, rows: 50 }], 'a later local resize must reach the ssh pty when solo');
});

// Property 2: another client already attached means the previous fixed
// behavior, unchanged, with the reason logged.
test('attach() keeps the fixed remote size and ignores resize when another client is already attached', async () => {
  const raw = fakeRawPty();
  const spawnCalls = [];
  const logLines = [];
  const log = { info: (msg) => logLines.push(msg), warn() {}, error() {} };
  const adapter = makeAdapter({
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '1',
    spawnCalls,
    rawPtyFactory: () => raw.pty,
    log,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    { cols: spawnCalls[0].ptyOpts.cols, rows: spawnCalls[0].ptyOpts.rows },
    { cols: 200, rows: 51 },
    'a session with another attached client must keep the sizing-rule remote size, not the local one',
  );

  result.ptyProcess.resize(120, 50);
  assert.deepEqual(raw.resizes, [], 'resize must not reach the ssh pty while another client is attached');
  assert.ok(logLines.some((l) => /other client/i.test(l)), 'the log must say why resize is disabled');
});

// Fail-closed: an unparseable client count must be treated the same as
// "someone's there", not guessed as solo.
test('attach() fails closed to the fixed remote size when the client count cannot be parsed', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + 'garbage',
    spawnCalls,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    { cols: spawnCalls[0].ptyOpts.cols, rows: spawnCalls[0].ptyOpts.rows },
    { cols: 200, rows: 51 },
  );
});

// Property 3: the attached-client count must ride the existing probe
// connection -- the Windows OpenSSH client has no ControlMaster, so a
// second call would be a second full ssh connection.
test('the attached-client count rides the existing probe connection, never a second ssh call', async () => {
  const spawnCalls = [];
  const probeCalls = [];
  const adapter = makeAdapter({
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '0',
    spawnCalls,
    probeCalls,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );

  assert.equal(result.ok, true);
  assert.equal(probeCalls.length, 1, 'reading the client count must not add a second ssh round trip');
  assert.match(probeCalls[0], /list-clients/, 'the probe command must ask tmux for the attached client count');
});

// --- Inherited (starred) option parsing, real-host measurement (tmux 3.6) -

// `tmux show-options -A` marks an option with no session-scoped override
// (inherited from a higher scope) with a trailing `*` right after the
// option name -- e.g. "status* on". Sizing must react to the value exactly
// like the unstarred form; only `pre` (below) treats it differently.
test('parseProbeOutput sizes a starred (inherited) status option exactly like the unstarred form', () => {
  assert.deepEqual(
    parseProbeOutput('200x51' + PROBE_SEP + 'status* on'),
    { cols: 200, rows: 52, pre: { status: null, mouse: null, windowSize: null } },
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status* off'),
    { cols: 200, rows: 50, pre: { status: null, mouse: null, windowSize: null } },
  );
  assert.deepEqual(
    parseProbeOutput('200x51' + PROBE_SEP + 'status* 2'),
    { cols: 200, rows: 53, pre: { status: null, mouse: null, windowSize: null } },
  );
});

// A session-scoped (unstarred) override must be preserved in `pre` for
// restore-via-`set -t`; an inherited (starred) one must not.
test('parseProbeOutput: pre.mouse is the value for a session-scoped override, null for an inherited one', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + ''),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: 'off', windowSize: null } },
    'unstarred "mouse off" is a real session override -- must be restored via set -t',
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse* on' + PROBE_SEP + ''),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null } },
    'starred "mouse* on" is inherited -- no session override exists, restore must set -u',
  );
});

test('parseProbeOutput: pre.windowSize follows the same starred/unstarred rule as status and mouse', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + 'window-size manual'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: 'manual' } },
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + 'window-size* latest'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null } },
  );
});

// --- Solo attach parity (issue #253) ------------------------------------

test('buildAttachCommand: solo prefixes session-scoped option sets before attach, in order', () => {
  const cmd = buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0', { solo: true });
  assert.equal(
    cmd,
    "tmux -S '/tmp/tmux-0/main' set -t main:@0.%0 status off \\; " +
      'set -t main:@0.%0 mouse on \\; ' +
      'set -t main:@0.%0 window-size latest \\; ' +
      'attach -t main:@0.%0',
  );
  const statusIdx = cmd.indexOf('status off');
  const mouseIdx = cmd.indexOf('mouse on');
  const windowSizeIdx = cmd.indexOf('window-size latest');
  const attachIdx = cmd.indexOf('attach -t');
  assert.ok(statusIdx < mouseIdx && mouseIdx < windowSizeIdx && windowSizeIdx < attachIdx, 'sets must precede attach, in order');
  assert.ok(!cmd.includes('-g'), 'solo attach must never touch the global option scope');
  assert.ok(!cmd.includes('-w'), 'solo attach must never touch window-scoped options');
});

test('buildAttachCommand: shared (solo false or omitted) emits the byte-identical unchanged command', () => {
  const unchanged = "tmux -S '/tmp/tmux-0/main' attach -t main:@0.%0";
  assert.equal(buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0', { solo: false }), unchanged);
  assert.equal(buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0'), unchanged);
});

test('buildRestoreCommand: restores each probed value when non-null', () => {
  const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', { status: 'on', mouse: 'off', windowSize: 'manual' });
  assert.equal(
    cmd,
    "tmux -S '/tmp/tmux-0/main' set -t main:@0.%0 status on \\; " +
      'set -t main:@0.%0 mouse off \\; ' +
      'set -t main:@0.%0 window-size manual',
  );
});

test('buildRestoreCommand: restores a numeric status value', () => {
  const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', { status: 2, mouse: 'on', windowSize: 'latest' });
  assert.match(cmd, /set -t main:@0\.%0 status 2 \\;/);
});

test('buildRestoreCommand: uses "set -u" for each probed value that was null', () => {
  const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', { status: null, mouse: null, windowSize: null });
  assert.equal(
    cmd,
    "tmux -S '/tmp/tmux-0/main' set -u -t main:@0.%0 status \\; " +
      'set -u -t main:@0.%0 mouse \\; ' +
      'set -u -t main:@0.%0 window-size',
  );
});

test('buildRestoreCommand: mixes "set" and "set -u" per option independently', () => {
  const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', { status: 'off', mouse: null, windowSize: 'latest' });
  assert.equal(
    cmd,
    "tmux -S '/tmp/tmux-0/main' set -t main:@0.%0 status off \\; " +
      'set -u -t main:@0.%0 mouse \\; ' +
      'set -t main:@0.%0 window-size latest',
  );
});

// No remote command string may ever contain a backtick -- these run over ssh,
// where a backtick executes (issue #253 acceptance criterion).
test('no builder ever emits a backtick', () => {
  const commands = [
    buildProbeCommand(4242, 'main:@0.%0'),
    buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0'),
    buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0', { solo: true }),
    buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0', { solo: false }),
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', { status: 'on', mouse: 'off', windowSize: 'manual' }),
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', { status: null, mouse: null, windowSize: null }),
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {}),
    buildRemoteCommandArgs('vps', 'echo hi').join(' '),
  ];
  for (const cmd of commands) {
    assert.ok(!cmd.includes('`'), `command must not contain a backtick: ${cmd}`);
  }
});

// F10 (audit-fable-2026-09-11): the probe and restore-on-detach ssh must not
// hang past a broken/half-open connection waiting for the (much longer) kill
// timer.
test('buildRemoteCommandArgs adds ConnectTimeout=5 alongside BatchMode, alias last before the command', () => {
  const args = buildRemoteCommandArgs('vps', 'echo hi');
  assert.deepEqual(args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-n', 'vps', 'echo hi']);
});

// --- F6 (audit-fable-2026-09-11): pid-reuse guard before a tmux attach -----

test('parseDiscoveryProbeOutput reads the trailing cmdline-check segment as cmdlineHasClaude', () => {
  const fields = (cmdline) => {
    const base = [FAKE_SOCKET, '200x50', 'status on', '', '', '0'];
    return (cmdline == null ? base : [...base, cmdline]).join(PROBE_SEP);
  };
  assert.equal(parseDiscoveryProbeOutput(fields('1')).cmdlineHasClaude, true);
  assert.equal(parseDiscoveryProbeOutput(fields('0')).cmdlineHasClaude, false);
  assert.equal(parseDiscoveryProbeOutput(fields(null)).cmdlineHasClaude, null,
    'a probe predating this segment (old fixture/host script) must read as unknown, not false');
});

// Design note (see .ai/contexts/session-cache.md, "pid-reuse guard"): the
// CLI's own `procStart` field is a Windows FILETIME-scale value in the one
// sample this repo has measured (cli-session-state.md) -- there is no
// evidence it lines up with Linux's /proc/<pid>/stat starttime (clock ticks
// since boot) on a remote host, and ssh access to check was out of scope
// here. Comparing the two numerically risks either shipping a check that
// always mismatches (attach always refused) or one whose units silently
// don't line up (false confidence). This adapter instead verifies
// `/proc/<pid>/cmdline` still contains "claude" -- weaker than an exact
// start-time match, but it catches the audited scenario (pid reused by an
// unrelated process in another tmux server) without depending on an
// unverified cross-platform format match. `descriptor.procStart != null` is
// still what gates the check, per the interface asked for.
test('attach() proceeds when the probed cmdline still says claude', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: ['200x50', 'status on', '', '', '0', '1'].join(PROBE_SEP),
    spawnCalls,
  });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0', procStart: '123456' });
  assert.equal(result.ok, true);
  assert.equal(spawnCalls.length, 1);
});

test('attach() refuses before spawnPty when the probed cmdline no longer says claude', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: ['200x50', 'status on', '', '', '0', '0'].join(PROBE_SEP),
    spawnCalls,
  });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0', procStart: '123456' });
  assert.equal(result.ok, false);
  assert.match(result.error, /pid 4242 now belongs to a process that is not a claude CLI/);
  assert.equal(spawnCalls.length, 0, 'no pty may be spawned once the pid-reuse guard refuses');
});

test('attach() proceeds unverified when the probe carries no cmdline segment (older probe output)', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: ['200x50', 'status on', '', '', '0'].join(PROBE_SEP),
    spawnCalls,
  });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0', procStart: '123456' });
  assert.equal(result.ok, true, 'a probe without the cmdline segment cannot refuse');
  assert.equal(spawnCalls.length, 1);
});

// Solo attach must actually apply the session-scoped option sets end-to-end
// through attach(), not just at the buildAttachCommand unit level.
test('attach() applies the session-scoped option sets in the real ssh argv when solo', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '0',
    spawnCalls,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);
  const attachCommand = spawnCalls[0].args[spawnCalls[0].args.length - 1];
  assert.match(attachCommand, /set -t main:@0\.%0 status off \\; set -t main:@0\.%0 mouse on \\; set -t main:@0\.%0 window-size latest \\; attach -t main:@0\.%0/);
});

// Shared attach() must emit the byte-identical unchanged attach command --
// never touch another attached client's view.
test('attach() emits the unchanged attach command in the real ssh argv when shared', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '1',
    spawnCalls,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);
  const attachCommand = spawnCalls[0].args[spawnCalls[0].args.length - 1];
  assert.equal(attachCommand, "tmux -S '/tmp/tmux-0/test' attach -t main:@0.%0");
});

// Detach must run a best-effort restore ssh call using the probed pre-attach
// values, only when the attach was solo.
test('detach() runs a best-effort restore call with the probed pre-attach values when solo', async () => {
  const raw = fakeRawPty();
  const restoreCalls = [];
  const runRemoteCommand = async (alias, command) => {
    if (/^tmux -S /.test(command) && !command.includes('attach') && !/display-message|show-options|list-clients/.test(command)) {
      restoreCalls.push(command);
      return { code: 0, stdout: '', stderr: '' };
    }
    return {
      code: 0,
      stdout: `${FAKE_SOCKET}${PROBE_SEP}200x50${PROBE_SEP}status on${PROBE_SEP}mouse off${PROBE_SEP}window-size manual${PROBE_SEP}0`,
      stderr: '',
    };
  };
  const adapter = createTmuxAttachAdapter({
    spawnPty: () => raw.pty,
    runRemoteCommand,
    log: silentLog,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);

  result.ptyProcess.kill();
  // The restore call is fire-and-forget from inside kill(); let its microtask run.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(restoreCalls.length, 1, 'exactly one restore call must be sent on detach when solo');
  assert.equal(
    restoreCalls[0],
    "tmux -S '/tmp/tmux-0/test' set -t main:@0.%0 status on \\; set -t main:@0.%0 mouse off \\; set -t main:@0.%0 window-size manual",
  );
});

// Shared attach must never restore anything on detach -- it never changed
// anything in the first place, and another client's view must not move.
test('detach() sends no restore call when shared', async () => {
  const raw = fakeRawPty();
  const restoreCalls = [];
  const runRemoteCommand = async (alias, command) => {
    if (/^tmux -S /.test(command) && !command.includes('attach') && !/display-message|show-options|list-clients/.test(command)) {
      restoreCalls.push(command);
      return { code: 0, stdout: '', stderr: '' };
    }
    return {
      code: 0,
      stdout: `${FAKE_SOCKET}${PROBE_SEP}200x50${PROBE_SEP}status on${PROBE_SEP}mouse off${PROBE_SEP}window-size manual${PROBE_SEP}1`,
      stderr: '',
    };
  };
  const adapter = createTmuxAttachAdapter({
    spawnPty: () => raw.pty,
    runRemoteCommand,
    log: silentLog,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);

  result.ptyProcess.kill();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(restoreCalls.length, 0, 'a shared attach must never send a restore call on detach');
});

// A restore-on-detach failure must never throw out of kill()/detach(), and
// must not prevent the local ssh client from being killed.
test('detach() swallows a failing restore call without throwing', async () => {
  const raw = fakeRawPty();
  const runRemoteCommand = async (alias, command) => {
    if (/^tmux -S /.test(command) && !command.includes('attach') && !/display-message|show-options|list-clients/.test(command)) {
      throw new Error('ssh: connection refused');
    }
    return {
      code: 0,
      stdout: `${FAKE_SOCKET}${PROBE_SEP}200x50${PROBE_SEP}status on${PROBE_SEP}mouse off${PROBE_SEP}window-size manual${PROBE_SEP}0`,
      stderr: '',
    };
  };
  const adapter = createTmuxAttachAdapter({
    spawnPty: () => raw.pty,
    runRemoteCommand,
    log: silentLog,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);

  assert.doesNotThrow(() => result.ptyProcess.kill());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(raw.killedCount(), 1, 'the local ssh client must still be killed even if the restore call rejects');
});
