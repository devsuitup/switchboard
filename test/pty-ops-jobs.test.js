'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const ops = require('../pty-ops');

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  const exit = new EventEmitter();
  const pty = { pid: 897, _agent: {}, kill() { calls.push('pty'); }, write() {},
    onExit(fn) { exit.on('exit', fn); return { dispose: () => exit.off('exit', fn) }; } };
  const jobs = { assign(id, pid, time) { calls.push(['assign', id, pid, time]); return Promise.resolve(true); },
    terminate(id) { calls.push(['terminate', id]); return Promise.resolve(true); },
    release(id) { calls.push(['release', id]); return Promise.resolve(true); } };
  return { pty, jobs, exit, calls, session: { pty, kind: 'local-pty' } };
}

test('close is synchronous even if discovery never returns', () => {
  const calls = [];
  const session = { kind: 'local-pty', pty: { pid: 897, kill() { calls.push('pty'); } } };
  ops.killPty(session, 'quit', { platform: 'win32', queryProcesses: () => new Promise(() => {}) });
  assert.deepEqual(calls, ['pty'], 'quit must close ConPTY before returning to the shutdown drain');
});

test('a tracked close terminates after native exit or the 2000ms bound, once', async t => {
  assert.equal(typeof ops.trackWindowsPty, 'function', 'local PTYs must acquire a job at spawn');
  for (const earlyExit of [true, false]) {
    const f = fixture(t);
    ops.trackWindowsPty(f.pty, { jobs: f.jobs, platform: 'win32', spawnTime: 100 });
    const id = f.calls[0][1];
    assert.deepEqual(f.calls, [['assign', id, 897, 100]]);
    ops.killPty(f.session, 'tab', { platform: 'win32' });
    assert.equal(f.calls.at(-1), 'pty');
    assert.equal(ops.killPty(f.session, 'tab', { platform: 'win32' }), false);
    if (earlyExit) { f.pty._agent.exitCode = 0; t.mock.timers.tick(25); }
    else { t.mock.timers.tick(1999); assert.equal(f.calls.length, 2); t.mock.timers.tick(1); }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, [['assign', id, 897, 100], 'pty', ['terminate', id]]);
    f.exit.emit('exit');
    assert.equal(f.calls.length, 3, 'close-induced root exit must not release the job');
    t.mock.timers.reset();
  }
});

test('natural/native exit and all excluded states release before plain close', async t => {
  assert.equal(typeof ops.trackWindowsPty, 'function');
  for (const extra of [{ exited: true }, { isAttach: true }, { detaching: true }, { backgrounding: true },
    { backgrounded: true }, { host: 'host' }, { kind: 'remote-attach' }, { native: true }]) {
    const f = fixture(t);
    ops.trackWindowsPty(f.pty, { jobs: f.jobs, platform: 'win32' });
    const id = f.calls[0][1];
    Object.assign(f.session, extra);
    if (extra.native) f.pty._agent.exitCode = 0;
    ops.killPty(f.session, 'excluded', { platform: 'win32' });
    assert.deepEqual(f.calls.slice(1), [['release', id], 'pty']);
    t.mock.timers.tick(2000);
    assert.equal(f.calls.length, 3);
    t.mock.timers.reset();
  }
  const f = fixture(t);
  ops.trackWindowsPty(f.pty, { jobs: f.jobs, platform: 'win32' });
  f.exit.emit('exit');
  assert.equal(f.calls[1][0], 'release');
});

test('detach releases before writing the background handoff, including write failure', t => {
  assert.equal(typeof ops.trackWindowsPty, 'function');
  const f = fixture(t);
  ops.trackWindowsPty(f.pty, { jobs: f.jobs, platform: 'win32' });
  f.pty.write = () => { f.calls.push('detach'); throw new Error('gone'); };
  ops.detachPty(f.session, 'detach');
  assert.deepEqual(f.calls.slice(1).map(c => Array.isArray(c) ? c[0] : c), ['release', 'detach', 'pty']);
});

test('deferred ConPTY root PID is assigned on native connection, never PID zero', async t => {
  const f = fixture(t);
  f.pty.pid = 0; f.pty._agent.outSocket = new EventEmitter();
  const assigned = ops.trackWindowsPty(f.pty, { jobs: f.jobs, platform: 'win32', spawnTime: 100 });
  assert.deepEqual(f.calls, [], 'node-pty beta returns before the native root exists');
  f.pty.pid = 897;
  f.pty._agent.outSocket.emit('ready_datapipe');
  assert.equal(await assigned, true);
  assert.equal(f.calls[0][2], 897);
});

test('failed helper assignment preserves synchronous plain ConPTY close', async t => {
  const f = fixture(t);
  f.jobs.assign = async () => false;
  f.jobs.terminate = async () => false;
  assert.equal(await ops.trackWindowsPty(f.pty, { jobs: f.jobs, platform: 'win32' }), false);
  assert.equal(ops.killPty(f.session, 'fallback', { platform: 'win32' }), true);
  assert.deepEqual(f.calls, ['pty']);
  t.mock.timers.tick(2000);
  assert.deepEqual(f.calls, ['pty']);
});
