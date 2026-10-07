'use strict';

// Issue #218: the per-host probe for tmux and inotifywait. LIST_COMMAND stays
// pinned elsewhere; this command is its own, run rarely, and answers two booleans.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { spawnSyncRetryingCrash } = require('./spawn-retry');

const { createSshTransport, PROBE_COMMAND, parseProbe } = require('../remote-transport');
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

test('PROBE_COMMAND is pinned exactly: it asks for tmux and inotifywait and nothing else', () => {
  assert.equal(PROBE_COMMAND,
    'if command -v tmux >/dev/null 2>&1; then echo tmux=1; else echo tmux=0; fi; '
    + 'if command -v inotifywait >/dev/null 2>&1; then echo inotifywait=1; else echo inotifywait=0; fi');
});

test('parseProbe reads the two booleans and refuses anything else', () => {
  assert.deepEqual(parseProbe('tmux=1\ninotifywait=0\n'), { tmux: true, inotifywait: false });
  assert.deepEqual(parseProbe('tmux=0\ninotifywait=1\n'), { tmux: false, inotifywait: true });
  assert.equal(parseProbe(''), null);
  assert.equal(parseProbe('tmux=1\n'), null);
  assert.equal(parseProbe('tmux=2\ninotifywait=1\n'), null);
  assert.equal(parseProbe('motd: welcome\ntmux=1\ninotifywait=1\n'), null);
});

test('probeTools spawns one bounded ssh with the same options and the alias as an operand', async () => {
  const spawn = spawnRecorder((child) => {
    child.stdout.push('tmux=1\ninotifywait=0\n');
    child.stdout.push(null);
    child.emit('close', 0);
  });
  const t = createSshTransport({ spawn });

  const result = await t.probeTools('planificator');

  assert.deepEqual(result, { tmux: true, inotifywait: false });
  assert.equal(spawn.calls.length, 1);
  const { cmd, args } = spawn.calls[0];
  assert.equal(cmd, resolveSshPath());
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.some(a => /^ConnectTimeout=/.test(a)));
  assert.equal(args[args.length - 2], 'planificator');
  assert.equal(args[args.length - 1], PROBE_COMMAND);
  assert.equal(t.liveCount(), 0);
});

test('probeTools rejects on a failed exit and on unparseable output', async () => {
  const failing = createSshTransport({ spawn: spawnRecorder((child) => {
    child.stderr.push('Permission denied');
    child.stdout.push(null);
    child.emit('close', 255);
  }) });
  await assert.rejects(() => failing.probeTools('vps'), /exit 255/);

  const garbage = createSshTransport({ spawn: spawnRecorder((child) => {
    child.stdout.push('hello\n');
    child.stdout.push(null);
    child.emit('close', 0);
  }) });
  await assert.rejects(() => garbage.probeTools('vps'), /unexpected output/);
});

test('probeTools kills a hung ssh at its own timeout', async () => {
  const hung = spawnRecorder(null);
  const t = createSshTransport({ spawn: hung, probeTimeoutMs: 30 });
  await assert.rejects(() => t.probeTools('vps'), /timed out/);
  assert.equal(hung.calls[0].child.killed, 1);
  assert.equal(t.liveCount(), 0);
});

test('probeTools caps the output it reads', async () => {
  const spawn = spawnRecorder((child) => {
    child.stdout.push('x'.repeat(4096));
    child.stdout.push(null);
  });
  const t = createSshTransport({ spawn });
  await assert.rejects(() => t.probeTools('vps'), /size cap/);
  assert.equal(spawn.calls[0].child.killed, 1);
});

const SH_SKIP = spawnSync('sh', ['-c', 'exit 0']).error ? 'sh is not available on this machine' : false;

function runProbe(prelude) {
  const result = spawnSyncRetryingCrash('sh', ['-c', prelude + PROBE_COMMAND], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'a missing tool is an answer, not a failure');
  return parseProbe(result.stdout);
}

test('PROBE_COMMAND reports each tool independently through a real shell', { skip: SH_SKIP }, () => {
  assert.deepEqual(runProbe('PATH=/nonexistent; '), { tmux: false, inotifywait: false });
  assert.deepEqual(runProbe('PATH=/nonexistent; tmux() { :; }; '), { tmux: true, inotifywait: false });
  assert.deepEqual(runProbe('PATH=/nonexistent; inotifywait() { :; }; '), { tmux: false, inotifywait: true });
  assert.deepEqual(runProbe('PATH=/nonexistent; tmux() { :; }; inotifywait() { :; }; '), { tmux: true, inotifywait: true });
});
