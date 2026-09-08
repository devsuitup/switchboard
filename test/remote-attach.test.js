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
} = require('../remote-attach');

const PROBE_SEP = '';
const silentLog = { info() {}, warn() {}, error() {} };

/** A minimal IPty-like double: onData/onExit/write/kill/pid. */
function fakeRawPty() {
  const emitter = new EventEmitter();
  const writes = [];
  let killed = 0;
  const pty = {
    write: (d) => writes.push(d),
    onData: (cb) => emitter.on('data', cb),
    onExit: (cb) => emitter.on('exit', cb),
    kill: () => { killed++; emitter.emit('exit', { exitCode: 0 }); },
    pid: 4242,
  };
  return { pty, writes, emitter, killedCount: () => killed };
}

const FAKE_SOCKET = '/tmp/tmux-0/test';

function makeAdapter({ probeStdout, probeCode = 0, spawnCalls = [], rawPtyFactory, socket = FAKE_SOCKET } = {}) {
  const runRemoteCommand = async () => ({
    code: probeCode,
    stdout: probeCode === 0 ? `${socket}${PROBE_SEP}${probeStdout || ''}` : (probeStdout || ''),
    stderr: '',
  });
  const spawnPty = (file, args, ptyOpts) => {
    spawnCalls.push({ file, args, ptyOpts });
    return (rawPtyFactory || (() => fakeRawPty().pty))();
  };
  return createTmuxAttachAdapter({ spawnPty, runRemoteCommand, log: silentLog });
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
  assert.deepEqual(parseProbeOutput('200x51' + PROBE_SEP + 'status on'), { cols: 200, rows: 52 });
});

test('parseProbeOutput sizes rows as height plus 0 when status is off', () => {
  assert.deepEqual(parseProbeOutput('200x50' + PROBE_SEP + 'status off'), { cols: 200, rows: 50 });
});

test('parseProbeOutput honors a rendered status line count beyond on/off', () => {
  assert.deepEqual(parseProbeOutput('200x51' + PROBE_SEP + 'status 2'), { cols: 200, rows: 53 });
});

test('parseProbeOutput returns null when the size cannot be parsed', () => {
  assert.equal(parseProbeOutput('garbage'), null);
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
// node-pty: writes reach the underlying process, and kill() detaches cleanly
// (Ctrl-B d) before ending the local ssh client, rather than killing outright.
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
  // Detach sends Ctrl-B d before ending the local client -- see DETACH_KEYS.
  assert.equal(raw.writes[raw.writes.length - 1], '\x02d', 'kill() must send the tmux detach sequence, not just end the process');
  assert.equal(raw.killedCount(), 0, 'the local client must not be ended immediately -- see the detach grace period');

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(raw.killedCount(), 1, 'the local client must be ended once the detach keystroke has had time to land');
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
