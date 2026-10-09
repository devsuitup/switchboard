'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { guardPtyInputErrors, setPtyOpLogger } = require('../pty-ops');

test.afterEach(() => setPtyOpLogger(null));

for (const code of ['EAGAIN', 'EPIPE']) {
  test(`a registered PTY absorbs an asynchronous ${code} after a detach write`, () => {
    const script = `
      const { Writable } = require('node:stream');
      const ops = require(process.argv[1]);
      const code = process.argv[2];
      const error = Object.assign(new Error('write ' + code), { code });
      const logs = [];
      const writes = [];
      ops.setPtyOpLogger({ debug: line => logs.push(line) });
      const input = new Writable({
        write(chunk, encoding, callback) {
          writes.push(chunk.toString());
          callback();
          setImmediate(() => {
            input.emit('error', error);
            finish({ uncaught: false });
          });
        }
      });
      const pty = { pid: 517, _agent: { inSocket: input }, write: data => input.write(data) };
      if (typeof ops.guardPtyInputErrors === 'function') ops.guardPtyInputErrors(pty);
      const timer = setTimeout(() => finish({ timedOut: true }), 2000);
      const onUncaught = error => finish({ uncaught: true, code: error.code });
      function finish(result) {
        clearTimeout(timer);
        process.removeListener('uncaughtException', onUncaught);
        console.log(JSON.stringify({ ...result, listeners: input.listenerCount('error'), writes, logs }));
      }
      process.once('uncaughtException', onUncaught);
      ops.detachPty({ pty }, 'attach-517', { schedule: () => null });
    `;
    const result = spawnSync(process.execPath, ['-e', script, require.resolve('../pty-ops'), code], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout.trim());
    assert.equal(observed.timedOut, undefined, 'the asynchronous write must settle');
    assert.equal(observed.uncaught, false, `${code} escaped the PTY input socket: ${result.stdout}`);
    assert.ok(observed.listeners > 0, 'registration must leave an error listener on the input socket');
    assert.deepEqual(observed.writes, ['\x1a']);
    assert.equal(observed.logs.length, 1);
    assert.match(observed.logs[0], new RegExp(code));
  });
}

test('registering a PTY without Windows input internals is a no-op', () => {
  assert.equal(typeof guardPtyInputErrors, 'function', 'the shipped registration helper must exist');
  for (const pty of [undefined, null, {}, { _agent: null }, { _agent: {} }, { _agent: { inSocket: {} } }]) {
    assert.equal(guardPtyInputErrors(pty), pty);
  }
});

test('registration never throws when private fields or listener installation throw', () => {
  assert.equal(typeof guardPtyInputErrors, 'function');
  const broken = [
    { get _agent() { throw new Error('private field unavailable'); } },
    { _agent: { get inSocket() { throw new Error('socket unavailable'); } } },
    { _agent: { inSocket: { get on() { throw new Error('listener API unavailable'); } } } },
    { _agent: { inSocket: { on() { throw new Error('registration failed'); } } } },
  ];
  for (const pty of broken) assert.equal(guardPtyInputErrors(pty), pty);
});

test('input errors remain handled when the debug logger throws', () => {
  assert.equal(typeof guardPtyInputErrors, 'function');
  const input = new EventEmitter();
  setPtyOpLogger({ debug() { throw new Error('logger unavailable'); } });
  guardPtyInputErrors({ _agent: { inSocket: input } });
  assert.doesNotThrow(() => input.emit('error', new Error('write EPIPE')));
});

test('the input error listener survives repeated failures with logging disabled', () => {
  assert.equal(typeof guardPtyInputErrors, 'function');
  const input = new EventEmitter();
  guardPtyInputErrors({ _agent: { inSocket: input } });
  assert.doesNotThrow(() => input.emit('error', new Error('write EAGAIN')));
  assert.doesNotThrow(() => input.emit('error', new Error('write EPIPE')));
  assert.equal(input.listenerCount('error'), 1);
});
