'use strict';

// defaultRunRemoteCommand's `input` option (issue #219): the text goes to the
// child's stdin, stdin is closed after it, and `-n` (which points ssh's stdin at
// /dev/null) is dropped. Same spawn site as every other remote command — see
// test/remote-ssh-spawn-sites.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

const { defaultRunRemoteCommand, buildRemoteCommandArgs } = require('../remote-attach');

function fakeSpawn({ exitOnEnd = true, code = 0, emitError = false } = {}) {
  const record = { calls: [], written: [], ended: false, killed: false };
  const spawn = (file, args, options) => {
    record.calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.stdin = new Writable({
      write(chunk, _enc, cb) { record.written.push(chunk.toString('utf8')); cb(); },
      final(cb) {
        record.ended = true;
        cb();
        if (exitOnEnd) setImmediate(() => { child.stdout.push(null); child.emit('close', code); });
      },
    });
    if (emitError) child.stdin.on('error', () => {});
    if (options.stdio[0] === 'ignore') { child.stdin = null; setImmediate(() => { child.stdout.push(null); child.emit('close', code); }); }
    child.kill = () => { record.killed = true; setImmediate(() => child.emit('close', null)); };
    return child;
  };
  return { spawn, record };
}

const RESOLVE = () => '/usr/bin/ssh';

test('buildRemoteCommandArgs: -n is present without input and absent with it', () => {
  assert.ok(buildRemoteCommandArgs('h', 'cmd').includes('-n'));
  assert.ok(buildRemoteCommandArgs('h', 'cmd', { input: 'x\n' }).every((a) => a !== '-n'));
  const args = buildRemoteCommandArgs('h', 'cmd', { input: 'x\n' });
  assert.deepEqual(args.slice(-2), ['h', 'cmd'], 'alias and command stay last; the input is never an argument');
  assert.ok(!args.some((a) => a.includes('x\n')));
});

test('a run with input pipes stdin, writes the line exactly, closes stdin, and passes no -n', async () => {
  const { spawn, record } = fakeSpawn();
  const line = '{"a":"ZZQ\'$(touch x)"}\n';
  const res = await defaultRunRemoteCommand('host', 'the-command', { spawnFn: spawn, resolveSshPath: RESOLVE, input: line });
  assert.equal(res.code, 0);
  const { file, args, options } = record.calls[0];
  assert.equal(file, '/usr/bin/ssh');
  assert.ok(!args.includes('-n'));
  assert.ok(!args.some((a) => a.includes('ZZQ')), 'the text is on no command line');
  assert.equal(options.stdio[0], 'pipe');
  assert.equal(record.written.join(''), line);
  assert.equal(record.ended, true);
});

test('a run without input keeps -n and an ignored stdin', async () => {
  const { spawn, record } = fakeSpawn();
  await defaultRunRemoteCommand('host', 'cmd', { spawnFn: spawn, resolveSshPath: RESOLVE }).catch(() => {});
  const { args, options } = record.calls[0];
  assert.ok(args.includes('-n'));
  assert.equal(options.stdio[0], 'ignore');
});

test('when nc never exits after the line is written, the timeout kills it and the result says timedOut', async () => {
  const { spawn, record } = fakeSpawn({ exitOnEnd: false });
  const res = await defaultRunRemoteCommand('host', 'cmd', { spawnFn: spawn, resolveSshPath: RESOLVE, input: 'x\n', timeoutMs: 20 });
  assert.equal(record.killed, true);
  assert.equal(res.timedOut, true);
  assert.notEqual(res.code, 0);
});

test('a normal exit carries no timedOut flag', async () => {
  const { spawn } = fakeSpawn();
  const res = await defaultRunRemoteCommand('host', 'cmd', { spawnFn: spawn, resolveSshPath: RESOLVE, input: 'x\n' });
  assert.equal(res.timedOut, undefined);
});

test('a stdin error (ssh gone before reading) does not throw and the run still settles', async () => {
  const { spawn } = fakeSpawn({ exitOnEnd: false });
  const wrapped = (...a) => {
    const child = spawn(...a);
    setImmediate(() => { child.stdin.emit('error', new Error('EPIPE')); child.emit('close', 255); });
    return child;
  };
  const res = await defaultRunRemoteCommand('host', 'cmd', { spawnFn: wrapped, resolveSshPath: RESOLVE, input: 'x\n', timeoutMs: 1000 });
  assert.equal(res.code, 255);
});
