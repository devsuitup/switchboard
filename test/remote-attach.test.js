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
  buildClientCountProbeCommand,
  shellSingleQuote,
} = require('../remote-attach');
const { classifyTitleActivity } = require('../classify-title-activity');

const PROBE_SEP = '';
const silentLog = { info() {}, warn() {}, error() {} };
// Flushes every pending microtask (any depth of chained awaits), unlike a
// fixed count of `await Promise.resolve()` calls -- see
// .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles, issue #290)
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

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
    { cols: 200, rows: 52, pre: { status: 'on', mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
});

test('parseProbeOutput sizes rows as height plus 0 when status is off', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status off'),
    { cols: 200, rows: 50, pre: { status: 'off', mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
});

test('parseProbeOutput honors a rendered status line count beyond on/off', () => {
  assert.deepEqual(
    parseProbeOutput('200x51' + PROBE_SEP + 'status 2'),
    { cols: 200, rows: 53, pre: { status: 2, mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
});

test('parseProbeOutput returns null when the size cannot be parsed', () => {
  assert.equal(parseProbeOutput('garbage'), null);
});

// issue #253 -- pre-attach mouse/window-size, present.
test('parseProbeOutput parses pre-attach mouse and window-size when present', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status off' + PROBE_SEP + 'mouse on' + PROBE_SEP + 'window-size latest'),
    { cols: 200, rows: 50, pre: { status: 'off', mouse: 'on', windowSize: 'latest', setTitles: null, setTitlesString: null } },
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: 'off', windowSize: 'manual', setTitles: null, setTitlesString: null } },
  );
});

// issue #253 -- pre-attach mouse/window-size, absent/unset: the probe segment
// is empty (as it would be if the remote tmux produced no matching line),
// never guessed at.
test('parseProbeOutput reports null for mouse and window-size when absent from the probe output', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + ''),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
  // No separators at all beyond size+status -- same as the pre-#253 wire format.
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status off'),
    { cols: 200, rows: 50, pre: { status: 'off', mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
});

// --- set-titles / set-titles-string probe parsing (issue #290) ------------

test('parseProbeOutput parses a session-scoped set-titles override', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + 'set-titles on'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null, setTitles: 'on', setTitlesString: null } },
  );
});

test('parseProbeOutput reports setTitles null when absent or inherited (starred)', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + 'set-titles* off'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
});

// Host measurement (tmux 3.6): the default set-titles-string is
// `#S:#I:#W - "#T" #{session_alerts}`, and `show-options -A` prints it in
// tmux's own re-parsable quoting: `"#S:#I:#W - \"#T\" #{session_alerts}"`.
// `parseTitleStringToken` reverses that quoting (see the full escaping table
// below) -- see .ai/contexts/session-cache.md ("Remote hosts — tmux attach",
// set-titles).
const DEFAULT_SET_TITLES_STRING = '#S:#I:#W - "#T" #{session_alerts}';
const PRINTED_DEFAULT_SET_TITLES_STRING = '"#S:#I:#W - \\"#T\\" #{session_alerts}"';

test('parseProbeOutput unescapes the default set-titles-string back to its real value', () => {
  const probed = parseProbeOutput(
    '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + '' +
      PROBE_SEP + `set-titles-string ${PRINTED_DEFAULT_SET_TITLES_STRING}`,
  );
  assert.equal(probed.pre.setTitlesString, DEFAULT_SET_TITLES_STRING);
});

test('parseProbeOutput reports setTitlesString null when starred (inherited)', () => {
  const probed = parseProbeOutput(
    '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + '' +
      PROBE_SEP + `set-titles-string* ${PRINTED_DEFAULT_SET_TITLES_STRING}`,
  );
  assert.equal(probed.pre.setTitlesString, null);
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
  // The local ssh client is now only killed once the detach-time
  // client-count probe settles -- see .ai/contexts/session-cache.md
  // ("Remote hosts — tmux attach", set-titles, issue #290).
  await flushAsync();
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
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + '0',
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
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + '1',
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
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + 'garbage',
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
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + '0',
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
    { cols: 200, rows: 52, pre: { status: null, mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status* off'),
    { cols: 200, rows: 50, pre: { status: null, mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
  assert.deepEqual(
    parseProbeOutput('200x51' + PROBE_SEP + 'status* 2'),
    { cols: 200, rows: 53, pre: { status: null, mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
  );
});

// A session-scoped (unstarred) override must be preserved in `pre` for
// restore-via-`set -t`; an inherited (starred) one must not.
test('parseProbeOutput: pre.mouse is the value for a session-scoped override, null for an inherited one', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + ''),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: 'off', windowSize: null, setTitles: null, setTitlesString: null } },
    'unstarred "mouse off" is a real session override -- must be restored via set -t',
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse* on' + PROBE_SEP + ''),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
    'starred "mouse* on" is inherited -- no session override exists, restore must set -u',
  );
});

test('parseProbeOutput: pre.windowSize follows the same starred/unstarred rule as status and mouse', () => {
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + 'window-size manual'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: 'manual', setTitles: null, setTitlesString: null } },
  );
  assert.deepEqual(
    parseProbeOutput('200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + 'window-size* latest'),
    { cols: 200, rows: 51, pre: { status: 'on', mouse: null, windowSize: null, setTitles: null, setTitlesString: null } },
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
      "set -t main:@0.%0 set-titles on \\; " +
      "set -t main:@0.%0 set-titles-string '#T' \\; " +
      'attach -t main:@0.%0',
  );
  const statusIdx = cmd.indexOf('status off');
  const mouseIdx = cmd.indexOf('mouse on');
  const windowSizeIdx = cmd.indexOf('window-size latest');
  const setTitlesIdx = cmd.indexOf('set-titles on');
  const setTitlesStringIdx = cmd.indexOf("set-titles-string '#T'");
  const attachIdx = cmd.indexOf('attach -t');
  assert.ok(
    statusIdx < mouseIdx && mouseIdx < windowSizeIdx && windowSizeIdx < setTitlesIdx && setTitlesIdx < setTitlesStringIdx && setTitlesStringIdx < attachIdx,
    'sets must precede attach, in order',
  );
  assert.ok(!cmd.includes('-g'), 'solo attach must never touch the global option scope');
  assert.ok(!cmd.includes('-w'), 'solo attach must never touch window-scoped options');
});

// issue #290 -- title forwarding is applied in shared mode too (it only
// changes each client's own outer-terminal title, unlike status/mouse/
// window-size, which stay untouched for a shared attach).
test('buildAttachCommand: shared still turns on title forwarding, quoting #T so the shell does not treat it as a comment', () => {
  const cmd = buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0', { solo: false });
  assert.equal(
    cmd,
    "tmux -S '/tmp/tmux-0/main' set -t main:@0.%0 set-titles on \\; " +
      "set -t main:@0.%0 set-titles-string '#T' \\; " +
      'attach -t main:@0.%0',
  );
  assert.equal(buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0'), cmd, 'solo omitted behaves like solo: false');
  assert.ok(!cmd.includes('status'), 'shared attach must never touch status');
  assert.ok(!cmd.includes('mouse'), 'shared attach must never touch mouse');
  assert.ok(!cmd.includes('window-size'), 'shared attach must never touch window-size');
});

test('buildRestoreCommand: restores each probed value when non-null', () => {
  const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {
    status: 'on', mouse: 'off', windowSize: 'manual', setTitles: 'off', setTitlesString: 'plain',
  });
  assert.equal(
    cmd,
    "tmux -S '/tmp/tmux-0/main' set -t main:@0.%0 status on \\; " +
      'set -t main:@0.%0 mouse off \\; ' +
      'set -t main:@0.%0 window-size manual \\; ' +
      'set -t main:@0.%0 set-titles off \\; ' +
      "set -t main:@0.%0 set-titles-string 'plain'",
  );
});

test('buildRestoreCommand: restores a numeric status value', () => {
  const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', { status: 2, mouse: 'on', windowSize: 'latest' });
  assert.match(cmd, /set -t main:@0\.%0 status 2 \\;/);
});

test('buildRestoreCommand: uses "set -u" for each probed value that was null', () => {
  const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {
    status: null, mouse: null, windowSize: null, setTitles: null, setTitlesString: null,
  });
  assert.equal(
    cmd,
    "tmux -S '/tmp/tmux-0/main' set -u -t main:@0.%0 status \\; " +
      'set -u -t main:@0.%0 mouse \\; ' +
      'set -u -t main:@0.%0 window-size \\; ' +
      'set -u -t main:@0.%0 set-titles \\; ' +
      'set -u -t main:@0.%0 set-titles-string',
  );
});

test('buildRestoreCommand: defaults every option to "set -u" when pre is empty/absent', () => {
  assert.equal(
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {}),
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {
      status: null, mouse: null, windowSize: null, setTitles: null, setTitlesString: null,
    }),
  );
});

test('buildRestoreCommand: mixes "set" and "set -u" per option independently', () => {
  const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {
    status: 'off', mouse: null, windowSize: 'latest', setTitles: 'on', setTitlesString: null,
  });
  assert.equal(
    cmd,
    "tmux -S '/tmp/tmux-0/main' set -t main:@0.%0 status off \\; " +
      'set -u -t main:@0.%0 mouse \\; ' +
      'set -t main:@0.%0 window-size latest \\; ' +
      'set -t main:@0.%0 set-titles on \\; ' +
      'set -u -t main:@0.%0 set-titles-string',
  );
});

// issue #290, corrected 2026-09-14 -- live measurement on tmux 3.6 (a
// throwaway server) proved the earlier "keep the raw token, let tmux
// re-parse it" restore approach wrong: `set -t t set-titles-string
// '"<raw-with-escapes>"'` stores the quotes and backslashes LITERALLY --
// tmux's argv is never re-parsed by tmux's own quoting rules. Each `printed`
// value below is exactly what `show-options -t t set-titles-string` printed
// after the option name for that `input` value on that host. See
// .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles).
const SET_TITLES_STRING_CASES = [
  { name: 'plain', input: `plain`, printed: `plain` },
  { name: 'space', input: `has space`, printed: `"has space"` },
  { name: 'double quote', input: `dq"in`, printed: `'dq"in'` },
  { name: 'backslash', input: `bs\\in`, printed: `bs\\\\in` },
  { name: 'dollar before name char', input: `dollar$x`, printed: `"dollar\\$x"` },
  { name: 'semicolon', input: `semi;colon`, printed: `"semi;colon"` },
  { name: 'tilde', input: `tilde~x`, printed: `tilde~x` },
  { name: 'single quote', input: `sq'in`, printed: `"sq'in"` },
  { name: 'hash', input: `hash#T`, printed: `"hash#T"` },
  { name: 'unicode', input: `uni é⠋`, printed: `"uni é⠋"` },
  { name: 'newline', input: `nl\nx`, printed: `nl\\nx` },
  { name: 'tab', input: `tab\tx`, printed: `tab\\tx` },
  { name: 'trailing backslash', input: `trail\\`, printed: `trail\\\\` },
  { name: 'single and double quote', input: `both'and"q`, printed: `"both'and\\"q"` },
  { name: 'double quote then trailing dollar (unescaped)', input: `dq"and$`, printed: `"dq\\"and$"` },
  { name: 'single quote then backslash', input: `sq'and\\bs`, printed: `"sq'and\\\\bs"` },
  { name: 'double quote then backslash', input: `dq"bs\\x`, printed: `'dq"bs\\\\x'` },
  { name: 'double quote then newline', input: `dq"nl\nx`, printed: `'dq"nl\\nx'` },
  { name: 'double quote then dollar before name char', input: `dq"dollar$x`, printed: `"dq\\"dollar\\$x"` },
  { name: 'newline then double quote', input: `nl\nx"dq`, printed: `'nl\\nx"dq'` },
  { name: 'empty', input: ``, printed: `''` },
  { name: 'entirely single-quoted content', input: `'abc'`, printed: `"'abc'"` },
  { name: 'entirely double-quoted content', input: `"abc"`, printed: `'"abc"'` },
];

for (const { name, input, printed } of SET_TITLES_STRING_CASES) {
  test(`set-titles-string escaping (${name}): parse(printed) recovers the input, and restore re-quotes the input`, () => {
    const probed = parseProbeOutput(
      '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + '' +
        PROBE_SEP + `set-titles-string ${printed}`,
    );
    assert.equal(probed.pre.setTitlesString, input, `parse(${JSON.stringify(printed)}) must recover the original input`);

    const cmd = buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {
      status: null, mouse: null, windowSize: null, setTitles: null, setTitlesString: input,
    });
    const m = /set -t main:@0\.%0 set-titles-string ([\s\S]+)$/.exec(cmd);
    assert.ok(m, `restore command must set set-titles-string: ${cmd}`);
    assert.equal(m[1], shellSingleQuote(input), 'the restore segment must be exactly set-titles-string + shellSingleQuote(input)');

    // Structural check independent of the production encoder: a valid shell
    // single-quoted word starts and ends with `'`, and once every `'\''`
    // escape is removed, no bare `'` remains inside.
    const quoted = m[1];
    assert.equal(quoted[0], "'", `restore segment must start with a single quote: ${quoted}`);
    assert.equal(quoted[quoted.length - 1], "'", `restore segment must end with a single quote: ${quoted}`);
    const withoutEscapes = quoted.slice(1, -1).split(`'\\''`).join('');
    assert.ok(!withoutEscapes.includes("'"), `no unescaped single quote may remain inside the quoted segment: ${quoted}`);
  });
}

// issue #290 -- the probe must read back both new options so a restore has
// something to put back.
test('buildProbeCommand reads both set-titles and set-titles-string', () => {
  const cmd = buildProbeCommand(4242, 'main:@0.%0');
  assert.match(cmd, /show-options -A -t main:@0\.%0 set-titles 2>\/dev\/null/);
  assert.match(cmd, /show-options -A -t main:@0\.%0 set-titles-string 2>\/dev\/null/);
  const setTitlesIdx = cmd.indexOf('show-options -A -t main:@0.%0 set-titles 2');
  const setTitlesStringIdx = cmd.indexOf('show-options -A -t main:@0.%0 set-titles-string 2');
  const listClientsIdx = cmd.indexOf('list-clients');
  assert.ok(setTitlesIdx < setTitlesStringIdx && setTitlesStringIdx < listClientsIdx, 'both option probes must precede the trailing client-count/cmdline segments');
});

// issue #290 (follow-up) -- the small, standalone detach-time probe reuses
// the same list-clients command and the same parseClientCount() the
// attach-time probe already uses, just against the already-known socket/
// target instead of rediscovering them.
test('buildClientCountProbeCommand builds the same list-clients query the attach-time probe uses', () => {
  const cmd = buildClientCountProbeCommand('/tmp/tmux-0/main', 'main:@0.%0');
  assert.equal(cmd, "tmux -S '/tmp/tmux-0/main' list-clients -t main:@0.%0 2>/dev/null | wc -l");
});

// No remote command string may ever contain a backtick -- these run over ssh,
// where a backtick executes (issue #253 acceptance criterion).
test('no builder ever emits a backtick', () => {
  const commands = [
    buildProbeCommand(4242, 'main:@0.%0'),
    buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0'),
    buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0', { solo: true }),
    buildAttachCommand('/tmp/tmux-0/main', 'main:@0.%0', { solo: false }),
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {
      status: 'on', mouse: 'off', windowSize: 'manual', setTitles: 'on', setTitlesString: DEFAULT_SET_TITLES_STRING,
    }),
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {
      status: null, mouse: null, windowSize: null, setTitles: null, setTitlesString: null,
    }),
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', {}),
    buildRestoreCommand('/tmp/tmux-0/main', 'main:@0.%0', { setTitles: 'on', setTitlesString: DEFAULT_SET_TITLES_STRING }, { includeBase: false }),
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
    const base = [FAKE_SOCKET, '200x50', 'status on', '', '', '', '', '0'];
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
    probeStdout: ['200x50', 'status on', '', '', '', '', '0', '1'].join(PROBE_SEP),
    spawnCalls,
  });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0', procStart: '123456' });
  assert.equal(result.ok, true);
  assert.equal(spawnCalls.length, 1);
});

test('attach() refuses before spawnPty when the probed cmdline no longer says claude', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: ['200x50', 'status on', '', '', '', '', '0', '0'].join(PROBE_SEP),
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
    probeStdout: ['200x50', 'status on', '', '', '', '', '0'].join(PROBE_SEP),
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
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + '0',
    spawnCalls,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);
  const attachCommand = spawnCalls[0].args[spawnCalls[0].args.length - 1];
  assert.match(
    attachCommand,
    /set -t main:@0\.%0 status off \\; set -t main:@0\.%0 mouse on \\; set -t main:@0\.%0 window-size latest \\; set -t main:@0\.%0 set-titles on \\; set -t main:@0\.%0 set-titles-string '#T' \\; attach -t main:@0\.%0/,
  );
});

// issue #290 -- title forwarding is turned on in shared mode too, unlike
// status/mouse/window-size which stay untouched for a shared attach.
test('attach() turns on title forwarding in the real ssh argv when shared, leaving everything else unchanged', async () => {
  const spawnCalls = [];
  const adapter = makeAdapter({
    probeStdout: '200x50' + PROBE_SEP + 'status on' + PROBE_SEP + 'mouse off' + PROBE_SEP + 'window-size manual' + PROBE_SEP + '' + PROBE_SEP + '' + PROBE_SEP + '1',
    spawnCalls,
  });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);
  const attachCommand = spawnCalls[0].args[spawnCalls[0].args.length - 1];
  assert.equal(
    attachCommand,
    "tmux -S '/tmp/tmux-0/test' set -t main:@0.%0 set-titles on \\; set -t main:@0.%0 set-titles-string '#T' \\; attach -t main:@0.%0",
  );
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
      stdout: `${FAKE_SOCKET}${PROBE_SEP}200x50${PROBE_SEP}status on${PROBE_SEP}mouse off${PROBE_SEP}window-size manual${PROBE_SEP}set-titles on${PROBE_SEP}set-titles-string ${PRINTED_DEFAULT_SET_TITLES_STRING}${PROBE_SEP}0`,
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
  // The restore call is fire-and-forget from inside kill(); let it settle.
  await flushAsync();

  assert.equal(restoreCalls.length, 1, 'exactly one restore call must be sent on detach when solo');
  assert.equal(
    restoreCalls[0],
    "tmux -S '/tmp/tmux-0/test' set -t main:@0.%0 status on \\; set -t main:@0.%0 mouse off \\; set -t main:@0.%0 window-size manual \\; " +
      `set -t main:@0.%0 set-titles on \\; set -t main:@0.%0 set-titles-string ${shellSingleQuote(DEFAULT_SET_TITLES_STRING)}`,
    'solo detach must restore all five options, set-titles-string unescaped from the probe and re-quoted for the shell',
  );
});

// issue #290 (MAJOR) -- a shared attach still turns title forwarding on
// (see buildAttachCommand), so leaving the session at `set-titles on` /
// `'#T'` forever after the first shared attach would silently ratchet the
// baseline every later probe restores against. A shared detach must restore
// the two title options -- and only those two, since status/mouse/window-size
// were never touched in shared mode and must stay untouched.
test('detach() restores only set-titles/set-titles-string on a shared detach, leaving status/mouse/window-size untouched', async () => {
  const raw = fakeRawPty();
  const restoreCalls = [];
  const runRemoteCommand = async (alias, command) => {
    if (/^tmux -S /.test(command) && !command.includes('attach') && !/display-message|show-options|list-clients/.test(command)) {
      restoreCalls.push(command);
      return { code: 0, stdout: '', stderr: '' };
    }
    return {
      code: 0,
      stdout: `${FAKE_SOCKET}${PROBE_SEP}200x50${PROBE_SEP}status on${PROBE_SEP}mouse off${PROBE_SEP}window-size manual${PROBE_SEP}set-titles* off${PROBE_SEP}${PROBE_SEP}1`,
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
  await flushAsync();

  assert.equal(restoreCalls.length, 1, 'a shared detach must still restore the title options');
  assert.equal(
    restoreCalls[0],
    "tmux -S '/tmp/tmux-0/test' set -u -t main:@0.%0 set-titles \\; set -u -t main:@0.%0 set-titles-string",
    'shared detach restores only the two title options, using set -u since both were inherited (starred) before attach',
  );
});

// --- issue #290 (follow-up): two Switchboard clients attached to the same
// remote session must not race each other's title restore -- see
// .ai/contexts/session-cache.md ("Remote hosts — tmux attach", set-titles).

// Builds a fake runRemoteCommand that tells apart the three kinds of calls
// detach() can now make: the detach-time client-count probe (list-clients,
// answered with a bare count), the restore call itself, and (falling through
// to the default) the original attach-time discovery probe. `raw` is the
// fake local pty -- the probe handler snapshots raw.killedCount() at the
// moment it runs, proving the probe is sent while our own client is still
// unconditionally attached, before raw.kill() ever runs (issue #290
// follow-up: a probe taken after killing our own client would undercount by
// one and misread "one real peer left" as "we were the last client out").
function makeDetachClientCountFake({ raw, clientCountAtDetach, clientCountProbeFails = false } = {}) {
  const restoreCalls = [];
  const clientCountProbeCalls = [];
  let killedCountAtProbeTime = null;
  const runRemoteCommand = async (alias, command) => {
    if (/^tmux -S '.*' list-clients -t /.test(command)) {
      clientCountProbeCalls.push(command);
      killedCountAtProbeTime = raw.killedCount();
      if (clientCountProbeFails) return { code: 1, stdout: '', stderr: 'ssh: connection refused' };
      return { code: 0, stdout: `${clientCountAtDetach}\n`, stderr: '' };
    }
    if (/^tmux -S /.test(command) && !command.includes('attach') && !/display-message|show-options|list-clients/.test(command)) {
      restoreCalls.push(command);
      return { code: 0, stdout: '', stderr: '' };
    }
    return {
      code: 0,
      // discoveryClientCount 0 + a supplied localSize -> solo attach, so the
      // "other three still restored" half of the fix is exercised too.
      stdout: `${FAKE_SOCKET}${PROBE_SEP}200x50${PROBE_SEP}status on${PROBE_SEP}mouse off${PROBE_SEP}window-size manual${PROBE_SEP}set-titles on${PROBE_SEP}set-titles-string ${PRINTED_DEFAULT_SET_TITLES_STRING}${PROBE_SEP}0`,
      stderr: '',
    };
  };
  return { runRemoteCommand, restoreCalls, clientCountProbeCalls, killedCountAtProbeTime: () => killedCountAtProbeTime };
}

for (const count of [0, 1]) {
  test(`detach() still restores the title options when the detach-time client count is ${count} ("ours may still be counted")`, async () => {
    const raw = fakeRawPty();
    const { runRemoteCommand, restoreCalls, clientCountProbeCalls, killedCountAtProbeTime } = makeDetachClientCountFake({ raw, clientCountAtDetach: count });
    const adapter = createTmuxAttachAdapter({ spawnPty: () => raw.pty, runRemoteCommand, log: silentLog });
    const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 });
    assert.equal(result.ok, true);

    result.ptyProcess.kill();
    await flushAsync();

    assert.equal(clientCountProbeCalls.length, 1, 'detach must probe the live client count exactly once');
    assert.equal(killedCountAtProbeTime(), 0, 'the client-count probe must be sent before the local ssh client is killed');
    assert.equal(raw.killedCount(), 1, 'the local ssh client must be killed once the probe has settled');
    assert.equal(restoreCalls.length, 1);
    assert.match(
      restoreCalls[0],
      /set -t main:@0\.%0 set-titles on \\; set -t main:@0\.%0 set-titles-string/,
      `title options must be restored when the detach-time count is ${count}`,
    );
  });
}

test('detach() skips the title restore, but still restores status/mouse/window-size, when another client is attached at detach time (count 2)', async () => {
  const raw = fakeRawPty();
  const logLines = [];
  const log = { info() {}, warn() {}, error() {}, debug: (msg) => logLines.push(msg) };
  const { runRemoteCommand, restoreCalls, clientCountProbeCalls, killedCountAtProbeTime } = makeDetachClientCountFake({ raw, clientCountAtDetach: 2 });
  const adapter = createTmuxAttachAdapter({ spawnPty: () => raw.pty, runRemoteCommand, log });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 });
  assert.equal(result.ok, true);

  result.ptyProcess.kill();
  await flushAsync();

  assert.equal(clientCountProbeCalls.length, 1);
  assert.equal(killedCountAtProbeTime(), 0, 'the client-count probe must be sent before the local ssh client is killed');
  assert.equal(raw.killedCount(), 1, 'the local ssh client must still be killed once the probe has settled');
  assert.equal(restoreCalls.length, 1, 'status/mouse/window-size must still be restored -- their solo rule is unchanged by this fix');
  assert.equal(
    restoreCalls[0],
    "tmux -S '/tmp/tmux-0/test' set -t main:@0.%0 status on \\; set -t main:@0.%0 mouse off \\; set -t main:@0.%0 window-size manual",
    'no set-titles/set-titles-string segment when another client is still attached at detach time',
  );
  assert.ok(logLines.some((l) => /skipping title restore/i.test(l)), 'must log at debug why the title restore was skipped');
});

// Test gap: a shared attach (never touches status/mouse/window-size) whose
// detach-time client count is >= 2 must send no restore call at all --
// includeBase is false (shared) and includeTitles is false (another client
// still attached), so buildRestoreCommand returns null.
test('detach() sends no restore call at all on a shared detach when another client is attached at detach time (count 2)', async () => {
  const raw = fakeRawPty();
  const restoreCalls = [];
  const clientCountProbeCalls = [];
  let killedCountAtProbeTime = null;
  const runRemoteCommand = async (alias, command) => {
    if (/^tmux -S '.*' list-clients -t /.test(command)) {
      clientCountProbeCalls.push(command);
      killedCountAtProbeTime = raw.killedCount();
      return { code: 0, stdout: '2\n', stderr: '' };
    }
    if (/^tmux -S /.test(command) && !command.includes('attach') && !/display-message|show-options|list-clients/.test(command)) {
      restoreCalls.push(command);
      return { code: 0, stdout: '', stderr: '' };
    }
    return {
      code: 0,
      // discovery-time clientCount 1 -> shared (non-solo) attach.
      stdout: `${FAKE_SOCKET}${PROBE_SEP}200x50${PROBE_SEP}status on${PROBE_SEP}mouse off${PROBE_SEP}window-size manual${PROBE_SEP}set-titles on${PROBE_SEP}set-titles-string ${PRINTED_DEFAULT_SET_TITLES_STRING}${PROBE_SEP}1`,
      stderr: '',
    };
  };
  const adapter = createTmuxAttachAdapter({ spawnPty: () => raw.pty, runRemoteCommand, log: silentLog });
  const result = await adapter.attach(
    'vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 },
  );
  assert.equal(result.ok, true);

  result.ptyProcess.kill();
  await flushAsync();

  assert.equal(clientCountProbeCalls.length, 1, 'detach must still probe the live client count on a shared attach');
  assert.equal(killedCountAtProbeTime, 0, 'the client-count probe must be sent before the local ssh client is killed');
  assert.equal(raw.killedCount(), 1, 'the local ssh client must still be killed');
  assert.equal(
    restoreCalls.length, 0,
    'a shared detach with another client still attached must send no restore call at all -- base was never touched and titles are skipped',
  );
});

test('detach() falls back to restoring the title options when the detach-time client-count probe fails', async () => {
  const raw = fakeRawPty();
  const { runRemoteCommand, restoreCalls, clientCountProbeCalls, killedCountAtProbeTime } = makeDetachClientCountFake({ raw, clientCountAtDetach: 0, clientCountProbeFails: true });
  const adapter = createTmuxAttachAdapter({ spawnPty: () => raw.pty, runRemoteCommand, log: silentLog });
  const result = await adapter.attach('vps', { sessionId: 's1', pid: 4242, tmux: 'main:@0.%0' }, { cols: 100, rows: 40 });
  assert.equal(result.ok, true);

  result.ptyProcess.kill();
  await flushAsync();

  assert.equal(clientCountProbeCalls.length, 1);
  assert.equal(killedCountAtProbeTime(), 0, 'the client-count probe must be sent before the local ssh client is killed, even when the probe fails');
  assert.equal(raw.killedCount(), 1, 'the local ssh client must still be killed after a failed probe');
  assert.equal(restoreCalls.length, 1);
  assert.match(
    restoreCalls[0],
    /set -t main:@0\.%0 set-titles on \\; set -t main:@0\.%0 set-titles-string/,
    'a failed client-count probe must fall back to restoring the titles, same as before this fix',
  );
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
      stdout: `${FAKE_SOCKET}${PROBE_SEP}200x50${PROBE_SEP}status on${PROBE_SEP}mouse off${PROBE_SEP}window-size manual${PROBE_SEP}${PROBE_SEP}${PROBE_SEP}0`,
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
  await flushAsync();
  assert.equal(raw.killedCount(), 1, 'the local ssh client must still be killed even if the restore call rejects');
});

// issue #290 -- pins that '#T' is the right choice: once set-titles-string is
// '#T', the pane title tmux forwards through the OSC 0 sequence IS the CLI's
// own title, unwrapped by any surrounding format (no "#S:#I:#W - ..." around
// it) -- so the same OSC-extraction regex wireSessionPty() uses on a local
// PTY (main.js, see .ai/contexts/session-cache.md) classifies it identically.
test('a tmux-forwarded #T title reaches classifyTitleActivity as busy, same as a local OSC 0 title', () => {
  const data = '\x1b]0;⠋ Claude Code\x07';
  const oscMatches = [...data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)];
  assert.equal(oscMatches.length, 1);
  assert.equal(oscMatches[0][1], '0');
  const payload = oscMatches[0][2];
  assert.equal(payload, '⠋ Claude Code');
  assert.deepEqual(classifyTitleActivity(payload), { busy: true, idle: false, via: 'glyph' });
});
