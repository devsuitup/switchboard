'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { createTmuxAttachAdapter } = require('../remote-attach');

const SEP = '\u0001';
const flush = () => new Promise(resolve => setImmediate(resolve));
const descriptor = { pid: 4242, tmux: 'main:@0.%0' };
const OWN = '4242\t/dev/pts/1\tworkstation:current:attach\n';
const PEER = '9000\t/dev/pts/2\t\n';
const STALE = '9000\t/dev/pts/2\tworkstation:previous:old\n';
const TEST_SHELL = process.platform === 'win32' && existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

test('a dev profile on the same machine never detaches the installed profile live client', async t => {
  const installed = fixture({ initialCount: 0, identity: { profileId: 'installed', instanceId: 'live' } });
  await installed.attach();
  t.after(() => installed.events.emit('exit'));
  const tag = /SWITCHBOARD_ATTACH=([A-Za-z0-9_:-]+)/.exec(installed.spawns[0].args.at(-1))[1];
  const peer = `9000\t/dev/pts/2\t${tag}\n`;
  const dev = fixture({ initialClients: peer, identity: { profileId: 'dev', instanceId: 'dev-live' } });
  const attached = await dev.attach();
  t.after(() => dev.events.emit('exit'));
  assert.equal(attached.ok, true);
  assert.equal(attached.remoteResizeAllowed, false, 'a different live profile must keep shared mode');
  assert.ok(dev.commands.every(c => !c.command.includes('detach-client')), 'the installed profile client must remain attached');
  attached.ptyProcess.resize(120, 50, { refresh: true });
  assert.deepEqual(dev.resizes, [], 'refresh must never resize a shared attach');
});

test('the client discovery script reads environment tags and treats unreadable or oversized environments as real', async t => {
  const script = String.raw`
tmux() { printf '9000\t/dev/pts/2\n9001\t/dev/pts/3\n9002\t/dev/pts/4\n'; }
head() {
  if [ "$1" != '-c' ]; then command head "$@"; return; fi
  case "$3" in
    /proc/9000/environ) printf 'SWITCHBOARD_ATTACH=workstation:previous:old\000OTHER=value\000';;
    /proc/9001/environ) return 1;;
    /proc/9002/environ) printf 'SWITCHBOARD_ATTACH=workstation:previous:old\000'; printf '%*s' "$2" 'x';;
    *) return 1;;
  esac
}
export -f tmux head
`;
  const f = fixture({ initialCount: 3, clientListRunner: command => {
    const result = spawnSync(TEST_SHELL, ['-c', script + command], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, STALE + '9001\t/dev/pts/3\t\n9002\t/dev/pts/4\t\n');
    return { code: result.status, stdout: result.stdout };
  } });
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  assert.equal(result.cols, 200);
  assert.equal(f.commands.filter(c => c.command.includes('detach-client')).length, 1);
});

test('a failed tmux list in the discovery script cannot masquerade as an empty list', async t => {
  const f = fixture({ clientListRunner: command => {
    const result = spawnSync(TEST_SHELL, ['-c', 'tmux() { return 1; }; export -f tmux; ' + command], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.ifError(result.error);
    return { code: result.status, stdout: result.stdout };
  } });
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  assert.equal(result.cols, 200);
  assert.ok(f.commands.every(c => !c.command.includes('detach-client')));
});

for (const [name, client] of [
  ['untagged client', PEER],
  ['another profile on the same machine', '9000\t/dev/pts/2\telsewhere:previous:old\n'],
  ['unreadable environment', '9000\t/dev/pts/2\t\n'],
  ['invalid tty', '9000\t/dev/pts/2;touch unsafe\tworkstation:previous:old\n'],
  ['same instance another attach', '9000\t/dev/pts/2\tworkstation:current:other\n'],
  ['malformed tag', '9000\t/dev/pts/2\tworkstation:previous\n'],
  ['invalid pid', 'oops\t/dev/pts/2\tworkstation:previous:old\n'],
]) {
  test(`client classification never detaches ${name}`, async t => {
    const f = fixture({ initialClients: client });
    const result = await f.attach();
    t.after(() => f.events.emit('exit'));
    assert.equal(result.ok, true);
    assert.equal(result.cols, 200);
    assert.ok(f.commands.every(c => !c.command.includes('detach-client')));
    f.clients(OWN + client);
    await f.tick();
    assert.deepEqual(f.resizes, []);
  });
}

test('client discovery batches all pid/tty environment reads with bounded quoted output', async t => {
  const f = fixture({ initialCount: 2, initialClients: STALE + PEER });
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  const lists = f.commands.filter(c => c.command.includes('client_pid'));
  assert.equal(lists.length, 1);
  const { command, options } = lists[0];
  assert.match(command, /^sh -c '/);
  assert.match(command, /#\{client_pid\}.*#\{client_tty\}/);
  assert.match(command, /\/proc\/.*\/environ/);
  assert.match(command, /SWITCHBOARD_ATTACH=/);
  assert.match(command, /head -c/);
  assert.match(command, /head -n/);
  assert.ok(!command.includes('`'));
  assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 15000);
  assert.ok(options.maxStdoutBytes > 0 && options.maxStdoutBytes <= 128 * 1024);
  assert.equal(f.commands.filter(c => c.command.includes('detach-client')).length, 1);
  assert.equal(result.cols, 200, 'a genuine peer still requires shared sizing');
});

test('failed stale detach stays shared without retry delay', async t => {
  const f = fixture({ initialClients: STALE });
  f.staleDetachAnswer(() => ({ code: 1, stderr: 'detach failed' }));
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  assert.equal(f.commands.filter(c => c.command.includes('detach-client')).length, 1);
  assert.equal(result.cols, 200);
  assert.deepEqual(f.retryDelays, []);
});

test('client discovery refuses overflow and truncated records rather than assuming solitude', async t => {
  for (const client of [STALE.repeat(201), `9000\t/dev/pts/2\t${'x'.repeat(128 * 1024)}\n`, '9000\t/dev/pts/2', '9000\t/dev/pts/2\tworkstation:previous:old']) {
    const f = fixture({ initialClients: client });
    const result = await f.attach();
    t.after(() => f.events.emit('exit'));
    assert.equal(result.cols, 200);
    assert.ok(f.commands.every(c => !c.command.includes('detach-client')));
  }
});

test('a lone tagged peer never impersonates this attach on a later poll', async t => {
  for (const client of [
    '9000\t/dev/pts/2\tworkstation:current:other\n',
    '9000\t/dev/pts/2\telsewhere:current:attach\n',
    '9000\t/dev/pts/2\tworkstation:previous:attach\n',
  ]) {
    const f = fixture();
    await f.attach();
    t.after(() => f.events.emit('exit'));
    f.clients(client);
    await f.tick();
    assert.deepEqual(f.resizes, []);
    assert.equal(f.timers.size, 1);
  }
});

test('oversized poll output cannot promote an otherwise matching attach', async t => {
  const f = fixture();
  await f.attach();
  t.after(() => f.events.emit('exit'));
  f.clients(`4242\t${'x'.repeat(128 * 1024)}\tworkstation:current:attach\n`);
  await f.tick();
  assert.deepEqual(f.resizes, []);
  assert.equal(f.timers.size, 1);
});

test('environment identity validates every component before any remote command', async () => {
  for (const identity of [{ profileId: 'bad:profile' }, { instanceId: 'bad;instance' }, { createAttachId: () => 'bad attach' }, { profileId: '' }, { profileId: 'valid\n' }, { createAttachId: () => { throw new Error('generator failed'); } }]) {
    const f = fixture({ identity });
    let result;
    await assert.doesNotReject(async () => { result = await f.attach(); }, 'invalid identity must return an error result');
    assert.equal(result.ok, false);
    assert.match(result.error, /identity/i);
    assert.equal(f.commands.length, 0);
    assert.equal(f.spawns.length, 0);
  }
});

test('default run-only profile and app-instance identities persist across adapters while attach ids differ', async t => {
  const tags = [];
  for (let i = 0; i < 2; i++) {
    const f = fixture({ initialCount: 0, identity: { profileId: undefined, instanceId: undefined, createAttachId: undefined } });
    await f.attach();
    t.after(() => f.events.emit('exit'));
    const tag = /SWITCHBOARD_ATTACH=([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)/.exec(f.spawns[0].args.at(-1));
    assert.ok(tag);
    tags.push(tag.slice(1));
  }
  assert.equal(tags[0][0], tags[1][0]);
  assert.equal(tags[0][1], tags[1][1]);
  assert.notEqual(tags[0][2], tags[1][2]);
});

function fixture({ initialCount = 1, initialClients = PEER, inherited = false, localSize = { cols: 100, rows: 40 }, identity = {}, clientListRunner } = {}) {
  const events = new EventEmitter();
  const commands = [];
  const resizes = [];
  const spawns = [];
  const retryDelays = [];
  const timers = new Map();
  let nextTimer = 0;
  let polls = 0;
  let killed = 0;
  let clients = OWN + PEER;
  let answer;
  let applyAnswer;
  let discoveryAnswer;
  let detachAnswer;
  let staleDetachAnswer;
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
    profileId: 'workstation', instanceId: 'current', createAttachId: () => 'attach', ...identity,
    waitForClientRetry: async ms => { retryDelays.push(ms); },
    setTimeoutFn(cb, ms) {
      const timer = { id: ++nextTimer, unref() {} };
      timers.set(timer, { cb, ms });
      return timer;
    },
    clearTimeoutFn: timer => timers.delete(timer),
    runRemoteCommand: async (alias, command, options) => {
      commands.push({ command, options });
      if (command.includes('detach-client')) return staleDetachAnswer ? staleDetachAnswer() : { code: 0, stdout: '' };
      if (command.includes('/proc/4242/environ')) {
        return { code: 0, stdout: ['/tmp/tmux-0/test', '200x50', `status${inherited ? '*' : ''} on`, `mouse${inherited ? '*' : ''} off`, `window-size${inherited ? '*' : ''} manual`, 'set-titles off', 'set-titles-string plain', initialCount, '1'].join(SEP) };
      }
      if (command.includes('list-clients') && command.includes('client_pid')) {
        if (clientListRunner) return clientListRunner(command);
        if (spawns.length === 0) return discoveryAnswer ? discoveryAnswer() : { code: 0, stdout: initialClients };
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
    discoveryAnswer: value => { discoveryAnswer = value; },
    detachAnswer: value => { detachAnswer = value; },
    staleDetachAnswer: value => { staleDetachAnswer = value; },
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
  f.clients(OWN);
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

test('a previous instance client of the same profile is detached by validated tty and opens solo immediately', async t => {
  const f = fixture({ initialClients: STALE });
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  const detaches = f.commands.filter(c => c.command.includes('detach-client'));
  assert.equal(detaches.length, 1);
  assert.equal(detaches[0].command, "tmux -S '/tmp/tmux-0/test' detach-client -t '/dev/pts/2'");
  assert.deepEqual(f.retryDelays, []);
  assert.equal(f.commands.filter(c => c.command.includes('/proc/4242/environ')).length, 1);
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
  for (const response of [() => ({ code: 1, stdout: OWN }), () => { throw new Error('ssh failed'); }, () => ({ code: 0, stdout: '' }), () => ({ code: 0, stdout: 'garbage' })]) {
    const f = fixture();
    const result = await f.attach();
    t.after(() => f.events.emit('exit'));
    f.answer(response);
    await f.tick();
    assert.deepEqual(f.resizes, []);
    assert.equal(f.timers.size, 1);
    f.answer(null);
    f.clients(OWN);
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
  finish({ code: 0, stdout: OWN + PEER });
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
  finish({ code: 0, stdout: OWN });
  await flush();
  assert.equal(f.commands.length, calls);
  assert.deepEqual(f.resizes, []);
  assert.equal(f.timers.size, 0);
});

test('detach during solo option application waits and restores the applied options', async () => {
  const f = fixture();
  const result = await f.attach();
  let finish;
  f.clients(OWN);
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
  f.clients(OWN);
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
  f.clients(OWN);
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
  f.clients(PEER);
  await f.tick();
  assert.deepEqual(f.resizes, []);
  assert.equal(f.commands.filter(c => c.command.includes('status off')).length, 0);
  assert.equal(f.timers.size, 1);
  f.clients(OWN);
  await f.tick();
  assert.deepEqual(f.resizes, [{ cols: 100, rows: 40 }]);
});

test('solo and shared attaches carry portable environment identity without session markers', async () => {
  for (const initialCount of [0, 1]) {
    const f = fixture({ initialCount });
    const result = await f.attach();
    assert.match(f.spawns[0].args.at(-1), /^exec env 'SWITCHBOARD_ATTACH=workstation:current:attach' tmux -S /);
    result.ptyProcess.kill();
    await flush();
    assert.ok(f.commands.every(c => !c.command.includes('@switchboard-attach-')));
    assert.ok(!f.spawns[0].args.at(-1).includes('$$'));
  }
});

test('failed, unreadable and malformed client discovery stays shared and recovers by polling', async t => {
  for (const response of [() => ({ code: 1 }), () => { throw new Error('ssh failed'); }, () => ({ code: 0, stdout: 'bad clients' })]) {
    const f = fixture();
    f.discoveryAnswer(response);
    const result = await f.attach();
    t.after(() => f.events.emit('exit'));
    assert.equal(result.ok, true);
    assert.equal(result.cols, 200);
    assert.ok(f.commands.every(c => !c.command.includes('detach-client')));
    f.clients(OWN);
    await f.tick();
    assert.deepEqual(f.resizes, [{ cols: 100, rows: 40 }]);
  }
});



test('a rejected option command retries and the latest size during application is used', async t => {
  const f = fixture();
  const result = await f.attach();
  t.after(() => f.events.emit('exit'));
  f.clients(OWN);
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
  finish({ code: 0, stdout: OWN });
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
  finishPoll({ code: 0, stdout: OWN });
  await flush();
  assert.equal(f.commands.filter(c => c.command.includes('status off')).length, 0);
  assert.equal(f.timers.size, 0);
  finishDetach({ code: 0, stdout: '1\n' });
  await flush();
  assert.equal(f.killed(), 1);
});

test('a promoted attach restores inherited base options by unsetting session overrides', async () => {
  const f = fixture({ inherited: true });
  const result = await f.attach();
  f.clients(OWN);
  await f.tick();
  result.ptyProcess.kill();
  await flush();
  const restore = f.commands.find(c => /set -u -t main:@0\.%0 status/.test(c.command));
  assert.ok(restore);
  assert.match(restore.command, /set -u -t main:@0\.%0 mouse/);
  assert.match(restore.command, /set -u -t main:@0\.%0 window-size/);
});
