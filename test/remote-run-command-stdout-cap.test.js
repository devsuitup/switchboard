'use strict';

// defaultRunRemoteCommand's stdout cap — see .ai/contexts/changes-view.md
// ("Quoting rule") and issue #251 (adversarial review, CRITICAL finding 1).
// A fake child is injected via opts.spawnFn — no real ssh, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { defaultRunRemoteCommand, DEFAULT_MAX_STDOUT_BYTES } = require('../remote-attach');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (sig) => { child.killed.push(sig); };
  return child;
}

test('DEFAULT_MAX_STDOUT_BYTES is 8 MB', () => {
  assert.equal(DEFAULT_MAX_STDOUT_BYTES, 8 * 1024 * 1024);
});

test('a fake child emitting more than maxStdoutBytes is killed and the promise resolves ok:false-shaped (code!==0, stderr names the cap)', async () => {
  const child = fakeChild();
  const spawnFn = () => child;

  const resultPromise = defaultRunRemoteCommand('vps', 'git -C /repo status', { maxStdoutBytes: 10, spawnFn });

  child.stdout.emit('data', Buffer.from('this chunk alone is already more than ten bytes'));
  // A real child would emit 'close' only after the SIGKILL takes effect; the
  // fake simulates that by closing right after the overflow is observed.
  child.emit('close', null);

  const result = await resultPromise;
  assert.equal(result.code, -1, 'an overflow must not report the process\'s own exit code as success');
  assert.match(result.stderr, /stdout exceeded 10 bytes/);
  assert.equal(result.stdout, '', 'no partial/overflowing stdout must leak through');
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('a fake child under the cap resolves normally with full stdout, no kill', async () => {
  const child = fakeChild();
  const spawnFn = () => child;

  const resultPromise = defaultRunRemoteCommand('vps', 'git -C /repo status', { maxStdoutBytes: 1024, spawnFn });

  child.stdout.emit('data', Buffer.from('small output'));
  child.emit('close', 0);

  const result = await resultPromise;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'small output');
  assert.deepEqual(child.killed, []);
});

test('overflow across multiple small chunks is still caught (byte-counted cumulatively, not per-chunk)', async () => {
  const child = fakeChild();
  const spawnFn = () => child;

  const resultPromise = defaultRunRemoteCommand('vps', 'git -C /repo diff', { maxStdoutBytes: 20, spawnFn });

  child.stdout.emit('data', Buffer.from('12345678901')); // 11 bytes, under cap alone
  child.stdout.emit('data', Buffer.from('12345678901')); // cumulative 22 bytes, over cap
  child.emit('close', null);

  const result = await resultPromise;
  assert.equal(result.code, -1);
  assert.match(result.stderr, /stdout exceeded 20 bytes/);
  assert.deepEqual(child.killed, ['SIGKILL']);
});

test('no maxStdoutBytes option falls back to the 8 MB default, not unbounded (RED before the fix: the old code had no cap at all)', async () => {
  const child = fakeChild();
  const spawnFn = () => child;

  const resultPromise = defaultRunRemoteCommand('vps', 'git -C /repo diff', { spawnFn });

  const over8mb = Buffer.alloc(DEFAULT_MAX_STDOUT_BYTES + 1, 97); // 'a'
  child.stdout.emit('data', over8mb);
  child.emit('close', null);

  const result = await resultPromise;
  assert.equal(result.code, -1);
  assert.match(result.stderr, new RegExp(`stdout exceeded ${DEFAULT_MAX_STDOUT_BYTES} bytes`));
});
