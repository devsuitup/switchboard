'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTmuxAttachAdapter } = require('../remote-attach');

const SEP = '\u0001';
const flush = () => new Promise(resolve => setImmediate(resolve));
const descriptor = { pid: 4242, tmux: 'main:@0.%0' };

function fixture({ initialCount = 1, retryCount = initialCount, localSize = { cols: 100, rows: 40 } } = {}) {
  const events = new EventEmitter();
  const commands = [];
  const resizes = [];
  const spawns = [];
  const retryDelays = [];
  const timers = new Map();
  let nextTimer = 0;
  let discoveries = 0;
  let polls = 0;
  let killed = 0;
  let clients = '4242:4242\n9000:4242\n';
  let answer;
  let applyAnswer;
  let retryAnswer;
  let detachAnswer;
  const raw = {
    pid: 4242,
    onData: cb => events.on('data', cb),
    onExit: cb => events.on('exit', cb),
    write() {},
    resize: (cols, rows) => resizes.push({ cols, rows }),
    kill() { killed++; events.emit('exit'); },
  };
  const adapter = createTmuxAttachAdapter({
    spawnPty(file, args, options) { spawns.push({ file, args, options }); return raw; },
    resolveSshPath: () => 'fake-ssh',
    waitForClientRetry: async ms => { retryDelays.push(ms); },
    setTimeoutFn(cb, ms) {
      const timer = { id: ++nextTimer, unref() {} };
      timers.set(timer, { cb, ms });
      return timer;
    },
    clearTimeoutFn: timer => timers.delete(timer),
    runRemoteCommand: async (alias, command, options) => {
      commands.push({ command, options });
      if (command.includes('/proc/4242/environ')) {
        if (discoveries > 0 && retryAnswer) return retryAnswer();
        const count = discoveries++ === 0 ? initialCount : retryCount;
        return { code: 0, stdout: ['/tmp/tmux-0/test', '200x50', 'status on', 'mouse off', 'window-size manual', 'set-titles off', 'set-titles-string plain', count, '1'].join(SEP) };
      }
      if (command.includes('list-clients') && command.includes('client_pid')) {
        polls++;
        if (answer) return answer();
        return { code: 0, stdout: clients };
      }
      if (command.includes('list-clients')) return detachAnswer ? detachAnswer() : { code: 0, stdout: '1\n' };
      if (command.includes('status off') && applyAnswer) return applyAnswer();
      return { code: 0, stdout: '' };
    },
  });
  return {
    attach: () => adapter.attach('vps', descriptor, localSize), commands, resizes, spawns, timers, events, retryDelays,
    clients: value => { clients = value; },
    answer: value => { answer = value; },
    applyAnswer: value => { applyAnswer = value; },
    retryAnswer: value => { retryAnswer = value; },
    detachAnswer: value => { detachAnswer = value; },
    polls: () => polls, killed: () => killed,
    async tick() {
      const entry = timers.entries().next().value;
      assert.ok(entry, 'shared mode must schedule a bounded poll');
      const [timer, { cb, ms }] = entry;
      assert.ok(ms > 0 && ms <= 15000);
      timers.delete(timer);
      cb();
      await flush();
    },
  };
}

test('shared attach becomes solo once, sends the latest size, and restores all options once', async t => {
  const f = fixture();
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  result.ptyProcess.resize(120, 50);
  assert.deepEqual(f.resizes, []);
  f.clients('4242:4242\n');
  await f.tick();
  assert.deepEqual(f.resizes, [{ cols: 120, rows: 50 }], 'the current local size must reach the pty after the peer leaves');
  assert.equal(f.timers.size, 0);
  const calls = f.commands.length;
  await result.ptyProcess.reevaluateMode();
  assert.equal(f.commands.length, calls, 'solo reevaluation must not apply options twice or downgrade');
  result.ptyProcess.resize(130, 60);
  assert.deepEqual(f.resizes.at(-1), { cols: 130, rows: 60 });
  assert.equal(f.commands.filter(c => c.command.includes('status off')).length, 1);
  const apply = f.commands.find(c => c.command.includes('status off')).command;
  assert.match(apply, /mouse on/);
  assert.match(apply, /window-size latest/);
  result.ptyProcess.kill();
  result.ptyProcess.kill();
  await flush();
  const restores = f.commands.filter(c => c.command.includes('status on'));
  assert.equal(restores.length, 1, 'transition must enroll exactly one full restore');
  assert.match(restores[0].command, /mouse off/);
  assert.match(restores[0].command, /window-size manual/);
  assert.match(restores[0].command, /set-titles off/);
  assert.equal(f.killed(), 1);
});

test('a genuine client that remains keeps shared sizing and bounded polling', async t => {
  const f = fixture();
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  result.ptyProcess.resize(120, 50);
  await f.tick();
  await f.tick();
  assert.equal(f.polls(), 2);
  assert.deepEqual(f.resizes, []);
  assert.equal(f.timers.size, 1);
  assert.ok(f.commands.filter(c => c.command.includes('client_pid')).every(c => c.options.timeoutMs > 0 && c.options.timeoutMs <= 15000));
});

test('a previous instance client gone at the retry opens directly in solo mode', async t => {
  const f = fixture({ retryCount: 0 });
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  assert.equal(f.commands.filter(c => c.command.includes('/proc/4242/environ')).length, 2);
  assert.ok(f.retryDelays[0] > 0 && f.retryDelays[0] <= 15000);
  assert.deepEqual(f.spawns[0].options, { name: 'xterm-256color', cols: 100, rows: 40 });
  assert.match(f.spawns[0].args.at(-1), /status off/);
  result.ptyProcess.resize(120, 50);
  assert.deepEqual(f.resizes, [{ cols: 120, rows: 50 }]);
  assert.equal(f.timers.size, 0);
});

test('an old unproven client still registered is never ignored or detached', async t => {
  const f = fixture();
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  assert.deepEqual({ cols: result.cols, rows: result.rows }, { cols: 200, rows: 51 });
  await f.tick();
  assert.ok(f.commands.every(c => !c.command.includes('detach-client')));
  assert.ok(f.commands.every(c => !c.command.includes('status off')));
});

test('detach and exit cancel polling and reevaluation cannot spawn more commands', async () => {
  for (const action of ['detach', 'exit']) {
    const f = fixture();
    const result = await f.attach();
    if (action === 'detach') result.ptyProcess.kill();
    else f.events.emit('exit');
    await flush();
    assert.equal(f.timers.size, 0);
    const calls = f.commands.length;
    assert.equal(typeof result.ptyProcess.reevaluateMode, 'function');
    await result.ptyProcess.reevaluateMode();
    assert.equal(f.commands.length, calls);
  }
});

test('failed, rejected and malformed polls remain shared and retry later', async t => {
  for (const response of [() => ({ code: 1, stdout: '4242:4242\n' }), () => { throw new Error('ssh failed'); }, () => ({ code: 0, stdout: '' }), () => ({ code: 0, stdout: 'garbage' })]) {
    const f = fixture();
    const result = await f.attach();
    t.after(() => f.events.emit('exit'));
    f.answer(response);
    await f.tick();
    assert.deepEqual(f.resizes, []);
    assert.equal(f.timers.size, 1);
    f.answer(null);
    f.clients('4242:4242\n');
    await f.tick();
    result.ptyProcess.resize(120, 50);
    assert.deepEqual(f.resizes.at(-1), { cols: 120, rows: 50 });
  }
});

test('polls and manual reevaluation share one in-flight request', async t => {
  const f = fixture();
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  let finish;
  f.answer(() => new Promise(resolve => { finish = resolve; }));
  await f.tick();
  const one = result.ptyProcess.reevaluateMode();
  const two = result.ptyProcess.reevaluateMode();
  await flush();
  assert.equal(f.polls(), 1);
  assert.equal(f.timers.size, 0);
  finish({ code: 0, stdout: '4242:4242\n9000:4242\n' });
  await Promise.all([one, two]);
  await flush();
  assert.equal(f.timers.size, 1);
});

test('detach during a pending poll cannot apply solo options after it settles', async () => {
  const f = fixture();
  const result = await f.attach();
  let finish;
  f.answer(() => new Promise(resolve => { finish = resolve; }));
  await f.tick();
  result.ptyProcess.kill();
  await flush();
  const calls = f.commands.length;
  finish({ code: 0, stdout: '4242:4242\n' });
  await flush();
  assert.equal(f.commands.length, calls);
  assert.deepEqual(f.resizes, []);
  assert.equal(f.timers.size, 0);
});

test('detach during solo option application waits and restores the applied options', async () => {
  const f = fixture();
  const result = await f.attach();
  let finish;
  f.clients('4242:4242\n');
  f.applyAnswer(() => new Promise(resolve => { finish = resolve; }));
  await f.tick();
  result.ptyProcess.kill();
  await flush();
  assert.equal(f.killed(), 0, 'restore must follow the in-flight option application');
  finish({ code: 0, stdout: '' });
  await flush();
  assert.equal(f.killed(), 1);
  assert.equal(f.commands.filter(c => c.command.includes('status on')).length, 1);
  assert.deepEqual(f.resizes, []);
});

test('a failed option command retries while remembering a possibly partial restore', async t => {
  const f = fixture();
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  f.clients('4242:4242\n');
  f.applyAnswer(() => ({ code: 1, stdout: '', stderr: 'partial failure' }));
  await f.tick();
  assert.deepEqual(f.resizes, []);
  assert.equal(f.timers.size, 1);
  result.ptyProcess.kill();
  await flush();
  assert.equal(f.commands.filter(c => c.command.includes('status on')).length, 1);
});

test('no valid local size prevents solo promotion until a valid resize arrives', async t => {
  const f = fixture({ localSize: null });
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  assert.equal(typeof result.ptyProcess.reevaluateMode, 'function');
  f.clients('4242:4242\n');
  await result.ptyProcess.reevaluateMode();
  assert.deepEqual(f.resizes, []);
  result.ptyProcess.resize(0, 20);
  await result.ptyProcess.reevaluateMode();
  assert.deepEqual(f.resizes, []);
  result.ptyProcess.resize(120, 50);
  await f.tick();
  assert.deepEqual(f.resizes, [{ cols: 120, rows: 50 }]);
});


test('a lone other client is not mistaken for our still-connecting attach', async t => {
  const f = fixture();
  const result = await f.attach();
  assert.equal(result.ok, true);
  t.after(() => f.events.emit('exit'));
  f.clients('9000:4242\n');
  await f.tick();
  assert.deepEqual(f.resizes, []);
  assert.equal(f.commands.filter(c => c.command.includes('status off')).length, 0);
  assert.equal(f.timers.size, 1);
  f.clients('4242:4242\n');
  await f.tick();
  assert.deepEqual(f.resizes, [{ cols: 100, rows: 40 }]);
});

test('our attach is tagged by remote process identity and removes only its own marker on detach', async () => {
  const f = fixture();
  const result = await f.attach();
  const command = f.spawns[0].args.at(-1);
  assert.match(command, /set-option -t 'main:@0\.%0' '@switchboard-attach-[a-f0-9-]+' "\$\$" && exec tmux/);
  await f.tick();
  assert.match(f.commands.find(c => c.command.includes('client_pid')).command, /#\{client_pid\}:#\{@switchboard-attach-[a-f0-9-]+\}/);
  result.ptyProcess.kill();
  await flush();
  const tag = command.match(/@switchboard-attach-[a-f0-9-]+/)[0];
  assert.equal(f.commands.filter(c => c.command.includes('set -u') && c.command.includes(tag)).length, 1);
});

test('a failed restart retry keeps the last known shared mode and recovers by polling', async t => {
  for (const response of [() => ({ code: 1 }), () => { throw new Error('ssh failed'); }, () => ({ code: 0, stdout: 'bad probe' })]) {
    const f = fixture();
    f.retryAnswer(response);
    const result = await f.attach();
    t.after(() => f.events.emit('exit'));
    assert.equal(result.ok, true);
    assert.equal(result.cols, 200);
    f.clients('4242:4242\n');
    await f.tick();
    assert.deepEqual(f.resizes, [{ cols: 100, rows: 40 }]);
  }
});

test('a restart retry that detects pid reuse refuses before spawning the attach', async () => {
  const f = fixture();
  f.retryAnswer(() => ({ code: 0, stdout: ['/tmp/tmux-0/test', '200x50', 'status on', '', '', '', '', '0', '0'].join(SEP) }));
  const result = await f.attach();
  assert.equal(result.ok, false);
  assert.match(result.error, /not a claude CLI/);
  assert.equal(f.spawns.length, 0);
});

test('a rejected option command retries and the latest size during application is used', async t => {
  const f = fixture();
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  f.clients('4242:4242\n');
  f.applyAnswer(() => { throw new Error('ssh failed'); });
  await f.tick();
  assert.equal(f.timers.size, 1);
  let finish;
  f.applyAnswer(() => new Promise(resolve => { finish = resolve; }));
  await f.tick();
  result.ptyProcess.resize(140, 70);
  assert.deepEqual(f.resizes, []);
  finish({ code: 0 });
  await flush();
  assert.deepEqual(f.resizes, [{ cols: 140, rows: 70 }]);
  assert.equal(f.timers.size, 0);
});

test('exit during a pending poll cannot spawn an option command or restart polling', async () => {
  const f = fixture();
  await f.attach();
  let finish;
  f.answer(() => new Promise(resolve => { finish = resolve; }));
  await f.tick();
  f.events.emit('exit');
  const calls = f.commands.length;
  finish({ code: 0, stdout: '4242:4242\n' });
  await flush();
  assert.equal(f.commands.length, calls);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.resizes, []);
});

test('a pending detach probe cannot let a simultaneous poll promote the still-alive client', async () => {
  const f = fixture();
  const result = await f.attach();
  let finishPoll;
  let finishDetach;
  f.answer(() => new Promise(resolve => { finishPoll = resolve; }));
  f.detachAnswer(() => new Promise(resolve => { finishDetach = resolve; }));
  await f.tick();
  result.ptyProcess.kill();
  await flush();
  assert.equal(result.ptyProcess.isAlive(), true);
  finishPoll({ code: 0, stdout: '4242:4242\n' });
  await flush();
  assert.equal(f.commands.filter(c => c.command.includes('status off')).length, 0);
  assert.equal(f.timers.size, 0);
  finishDetach({ code: 0, stdout: '1\n' });
  await flush();
  assert.equal(f.killed(), 1);
});

test('a promoted attach restores inherited base options by unsetting session overrides', async () => {
  const f = fixture();
  f.retryAnswer(() => ({ code: 0, stdout: ['/tmp/tmux-0/test', '200x50', 'status* on', 'mouse* off', 'window-size* manual', '', '', '1', '1'].join(SEP) }));
  const result = await f.attach();
  f.clients('4242:4242\n');
  await f.tick();
  result.ptyProcess.kill();
  await flush();
  const restore = f.commands.find(c => /set -u -t main:@0\.%0 status/.test(c.command));
  assert.ok(restore);
  assert.match(restore.command, /set -u -t main:@0\.%0 mouse/);
  assert.match(restore.command, /set -u -t main:@0\.%0 window-size/);
});
