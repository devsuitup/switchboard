'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { stopProcessTree } = require('../src/main/terminals/stop-process-tree');

function fixture() {
  const calls = [];
  const child = new EventEmitter();
  const spawnChild = (...args) => { calls.push(args); return child; };
  return { calls, child, options: { platform: 'win32', spawnChild, recheckDelayMs: 0 } };
}

test('stops only the owned PID tree with a hidden, bounded taskkill', async () => {
  const f = fixture();
  const done = stopProcessTree(897, f.options);
  assert.equal(f.calls.length, 1);
  const [program, args, options] = f.calls[0];
  assert.equal(program, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'));
  assert.deepEqual(args, ['/PID', '897', '/T', '/F']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, 'ignore');
  assert.ok(options.timeout > 0 && options.timeout <= 2000);
  f.child.emit('close', 0);
  assert.equal(await done, true);
});

test('never spawns after the owned root exits during the recheck delay', async () => {
  const f = fixture();
  let current = true;
  const done = stopProcessTree(897, { ...f.options, recheckDelayMs: 20, isCurrent: () => current,
    spawnChild: (...args) => {
      const child = f.options.spawnChild(...args);
      setImmediate(() => child.emit('close', 0));
      return child;
    } });
  current = false;
  assert.equal(await done, false);
  assert.equal(f.calls.length, 0);
});

test('rejects absent, invalid, self and already exited PIDs without spawning', async () => {
  const f = fixture();
  for (const pid of [undefined, null, 0, -1, 1.2, '897', NaN, Infinity, process.pid]) {
    assert.equal(await stopProcessTree(pid, f.options), false);
  }
  assert.equal(await stopProcessTree(897, { ...f.options, isCurrent: () => false }), false);
  assert.equal(f.calls.length, 0);
});

test('bounded spawn failure and unsuccessful taskkill resolve without throwing or retrying', async () => {
  for (const event of ['error', 'close']) {
    const f = fixture();
    const done = stopProcessTree(897, f.options);
    f.child.emit(event, event === 'error' ? new Error('timeout or spawn failure') : 1);
    assert.equal(await done, false);
    assert.equal(f.calls.length, 1);
  }
  assert.equal(await stopProcessTree(897, { platform: 'win32', spawnChild() { throw new Error('spawn'); } }), false);
});

test('POSIX retains process group SIGKILL, with no Windows subprocess', async () => {
  const f = fixture();
  const signals = [];
  assert.equal(await stopProcessTree(897, { ...f.options, platform: 'linux',
    signalGroup: (...args) => signals.push(args) }), true);
  assert.deepEqual(signals, [[-897, 'SIGKILL']]);
  assert.equal(f.calls.length, 0);
  assert.equal(await stopProcessTree(897, { platform: 'linux', signalGroup() { throw new Error('gone'); } }), false);
});
