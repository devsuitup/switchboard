'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createTmuxAttachAdapter, buildProbeCommand, defaultRunRemoteCommand, parseDiscoveryProbeOutput, shellSingleQuote,
} = require('../src/main/remote/remote-attach');

const SEP = '\u0001';
const flush = () => new Promise(resolve => setImmediate(resolve));
const descriptor = { pid: 4242, tmux: 'main:@0.%0' };
const OWN = '4242\t/dev/pts/1\tworkstation:current:attach\n';
const PEER = '9000\t/dev/pts/2\t\n';
const STALE = '9000\t/dev/pts/2\tworkstation:previous:old\n';
const TEST_SHELL = process.env.TEST_SHELL || (process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/sh.exe')
  ? 'C:/Program Files/Git/usr/bin/sh.exe' : '/bin/sh');

function shellPath(value) {
  return process.platform === 'win32'
    ? value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    : value;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function discoveryRunner(t, scripts) {
  mkdirSync(path.join(__dirname, '../.work-files'), { recursive: true });
  const dir = mkdtempSync(path.join(__dirname, '../.work-files/discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prefix = process.platform === 'win32' ? 'PATH=/usr/bin:$PATH; export PATH; ' : '';
  const resolved = spawnSync(TEST_SHELL, ['-c', prefix + 'command -v "$0"', shellPath(TEST_SHELL)], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.ifError(resolved.error);
  assert.equal(resolved.status, 0, resolved.stderr);
  for (const [name, script] of Object.entries({
    ...scripts, sh: `exec ${shellQuote(resolved.stdout.trim())} "$@"\n`,
  })) {
    writeFileSync(path.join(dir, name), '#!/bin/sh\n' + script, { mode: 0o755 });
  }
  return command => spawnSync(TEST_SHELL, ['-c', prefix + `PATH=${shellQuote(shellPath(dir))}:$PATH; export PATH; ` + command], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
}

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
  const run = discoveryRunner(t, {
    tmux: String.raw`printf '9000\t/dev/pts/2\n9001\t/dev/pts/3\n9002\t/dev/pts/4\n'`,
    head: 'if [ "$1" != \'-c\' ]; then PATH="${PATH#*:}" exec head "$@"; fi\n' + String.raw`
  case "$3" in
    /proc/9000/environ) printf 'SWITCHBOARD_ATTACH=workstation:previous:old\000OTHER=value\000';;
    /proc/9001/environ) exit 1;;
    /proc/9002/environ) printf 'SWITCHBOARD_ATTACH=workstation:previous:old\000'; printf '%*s' "$2" 'x';;
    *) exit 1;;
  esac
`,
  });
  const f = fixture({ initialCount: 3, clientListRunner: command => {
    const result = run(command);
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
  const run = discoveryRunner(t, { tmux: 'exit 1\n' });
  const f = fixture({ clientListRunner: command => {
    const result = run(command);
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

const FAKE_TMUX = String.raw`
{ printf 'tmux'; printf '\037%s' "$@"; printf '\n'; } >> "$FAKE_DIR/log"
fail() { printf '%s\n' "$*" >> "$FAKE_DIR/unexpected"; exit 99; }
[ "$1" = -S ] || fail "missing -S: $*"
if [ "$FAKE_SOCK_ANY" = 1 ]; then
  case "$2" in */tmux-1000/default) ;; *) exit 1;; esac
else
  [ "$2" = "$FAKE_SOCK" ] || exit 1
fi
cmd=$3
shift 3
resolves() {
  t=$1
  case "$t" in =*) exact=1; t=\${t#=};; *) exact=0;; esac
  s=\${t%%:*}
  [ "\${t#*:}" = "$FAKE_REST" ] || return 1
  if [ "$exact" = 1 ]; then [ "$s" = "$FAKE_SESSION" ]; return; fi
  case "$FAKE_SESSION" in "$s"*) return 0;; *) return 1;; esac
}
case "$cmd" in
  display-message)
    [ "$1" = -p ] && [ "$2" = -t ] || fail "display-message: $*"
    case "$4" in
      '#{pane_pid}') resolves "$3" || exit 1; printf '%s' "$FAKE_PANE_PID"; exit "$FAKE_PANE_STATUS";;
      '#{window_width}x#{window_height}') resolves "$3" || exit 1; printf '200x50\n';;
      *) fail "format: $4";;
    esac;;
  show-options)
    [ "$1" = -A ] && [ "$2" = -t ] || fail "show-options: $*"
    resolves "$3" || exit 1
    case "$4" in
      status) printf 'status on\n';;
      mouse) printf 'mouse off\n';;
      window-size) printf 'window-size manual\n';;
      set-titles) printf 'set-titles off\n';;
      set-titles-string) printf 'set-titles-string plain\n';;
      *) fail "option: $4";;
    esac;;
  list-clients)
    [ "$1" = -t ] || fail "list-clients: $*"
    resolves "$2" || exit 1
    printf '%s' "$FAKE_CLIENTS";;
  *) fail "command: $cmd";;
esac
`.replace(/\\\$/g, '$');

const FAKE_ID = String.raw`
{ printf 'id'; printf '\037%s' "$@"; printf '\n'; } >> "$FAKE_DIR/log"
[ "$*" = -u ] || { printf '%s\n' "id: $*" >> "$FAKE_DIR/unexpected"; exit 99; }
[ -z "$FAKE_ID_OUT" ] || printf '%s\n' "$FAKE_ID_OUT"
exit "\${FAKE_ID_STATUS:-0}"
`.replace(/\\\$/g, '$');

const CLAUDE_CMDLINE = Buffer.from('claude\0--resume\0');

function mapProc(command, pid) {
  let mapped = command;
  for (const file of ['environ', 'cmdline']) {
    const token = `/proc/${pid}/${file}`;
    assert.equal(mapped.split(token).length - 1, 1, `${token} must occur exactly once`);
    mapped = mapped.replace(token, `"$SWITCHBOARD_TEST_PROC_ROOT/${pid}/${file}"`);
  }
  assert.doesNotMatch(mapped, /\/proc\/\d+\/(?:environ|cmdline)/);
  return mapped;
}

function runProbe(t, {
  pid = 4242, target = 'main:@0.%0', environ = 'missing', uid = '1000', idStatus = 0, sock = '/tmp/tmux-1000/default',
  session = 'main', rest = '@0.%0', panePid = `${pid}\n`, paneStatus = 0, tmuxTmpdir, prelude = '', env = {}, clients = '', sockAny = false,
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const procDir = path.join(dir, 'proc', String(pid));
  mkdirSync(bin);
  mkdirSync(procDir, { recursive: true });
  writeFileSync(path.join(procDir, 'cmdline'), CLAUDE_CMDLINE);
  if (environ === 'dir') mkdirSync(path.join(procDir, 'environ'));
  else if (environ !== 'missing') writeFileSync(path.join(procDir, 'environ'), environ);
  const resolved = spawnSync(TEST_SHELL, ['-c', 'command -v "$0"', shellPath(TEST_SHELL)], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(resolved.error);
  for (const [name, script] of Object.entries({
    tmux: FAKE_TMUX, id: FAKE_ID, sh: `exec ${shellQuote(resolved.stdout.trim())} "$@"\n`,
  })) writeFileSync(path.join(bin, name), '#!/bin/sh\n' + script, { mode: 0o755 });
  const command = mapProc(buildProbeCommand(pid, target), pid);
  assert.ok(command.startsWith('sh -c '));
  const childEnv = {
    PATH: process.env.PATH, TMPDIR: '/var/other-tmp', TMUX: '/ambient/socket,1,0',
    SWITCHBOARD_TEST_PROC_ROOT: shellPath(path.join(dir, 'proc')), FAKE_DIR: shellPath(dir),
    FAKE_SOCK: sock, FAKE_SESSION: session, FAKE_REST: rest, FAKE_PANE_PID: panePid, FAKE_PANE_STATUS: String(paneStatus),
    FAKE_CLIENTS: clients, FAKE_SOCK_ANY: sockAny ? '1' : '0', FAKE_ID_OUT: uid, FAKE_ID_STATUS: String(idStatus), ...env,
  };
  if (tmuxTmpdir !== undefined) childEnv.TMUX_TMPDIR = tmuxTmpdir;
  const result = spawnSync(TEST_SHELL, ['-c', `PATH=${shellQuote(shellPath(bin))}:$PATH; export PATH; ${prelude}${command}`], {
    timeout: 30000, windowsHide: true, cwd: dir, env: childEnv,
  });
  assert.ifError(result.error);
  const read = name => existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'latin1') : '';
  assert.equal(read('unexpected'), '', 'the fake binaries must only see expected invocations');
  return {
    dir, status: result.status, stdout: result.stdout, stderr: result.stderr,
    calls: read('log').split('\n').filter(Boolean).map(line => line.split('\x1f')),
  };
}

const PANE_QUERY = (sock, target) => ['tmux', '-S', sock, 'display-message', '-p', '-t', target, '#{pane_pid}'];
const ID_CALL = ['id', '-u'];
const FALLBACK = '/tmp/tmux-1000/default';

function assertRefused(result, calls) {
  assert.equal(result.status, 3);
  assert.equal(result.stdout.toString('latin1'), '');
  assert.equal(result.stderr.toString('latin1'), 'NO_TMUX_ENV\n');
  if (calls) assert.deepEqual(result.calls, calls);
}

const firstField = result => result.stdout.toString().split('\u0001')[0];

for (const [name, environ] of [
  ['an unreadable environ', 'dir'],
  ['a missing environ', 'missing'],
  ['a readable environ without TMUX', Buffer.from('PATH=/usr/bin\0HOME=/home/x\0')],
  ['an empty TMUX socket component', Buffer.from('PATH=/usr/bin\0TMUX=,122,0\0')],
]) {
  test(`probe falls back to the verified default socket after ${name}`, t => {
    const result = runProbe(t, { environ });
    assert.equal(result.status, 0, result.stderr.toString());
    const discovery = parseDiscoveryProbeOutput(result.stdout.toString());
    assert.equal(discovery.socket, FALLBACK);
    assert.equal(discovery.cols, 200);
    assert.deepEqual(result.calls.slice(0, 2), [ID_CALL, PANE_QUERY(FALLBACK, '=main:@0.%0')]);
    assert.ok(result.calls.length > 3);
    assert.ok(result.calls.slice(2).every(call => call[0] === 'tmux' && call[2] === FALLBACK && call.at(-1) !== '#{pane_pid}'));
  });
}

test('probe fallback honors a visible custom TMUX_TMPDIR, ignores the ambient TMUX and queries one candidate', t => {
  const custom = '/tmp/sb_custom-base';
  const sock = `${custom}/tmux-1000/default`;
  const result = runProbe(t, { tmuxTmpdir: custom, sock });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(firstField(result), sock);
  assert.equal(result.calls.filter(call => call.includes('#{pane_pid}')).length, 1);
  assert.deepEqual(result.calls[1], PANE_QUERY(sock, '=main:@0.%0'));
});

test('probe fallback uses /tmp for an empty TMUX_TMPDIR', t => {
  const result = runProbe(t, { tmuxTmpdir: '' });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(firstField(result), FALLBACK);
});

test('probe fallback keeps a trailing slash of TMUX_TMPDIR in its single candidate', t => {
  const sock = '/tmp/sb_slash//tmux-1000/default';
  const result = runProbe(t, { tmuxTmpdir: '/tmp/sb_slash/', sock });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(firstField(result), sock);
  assert.equal(result.calls.filter(call => call.includes('#{pane_pid}')).length, 1);
});

test('probe fallback does not retry /tmp after a failing custom candidate', t => {
  const result = runProbe(t, { tmuxTmpdir: '/tmp/sb_custom-base', sock: FALLBACK });
  assertRefused(result, [ID_CALL, PANE_QUERY('/tmp/sb_custom-base/tmux-1000/default', '=main:@0.%0')]);
});

for (const [name, options] of [
  ['the server is unavailable', { sock: '/tmp/other/default' }],
  ['the target is missing', { rest: '@9.%9' }],
  ['tmux fails even though it printed the matching pid', { paneStatus: 1 }],
  ['only a session whose name merely starts with the descriptor session exists', { session: 'mainframe' }],
]) {
  test(`probe refuses without further queries when ${name}`, t => {
    assertRefused(runProbe(t, options), [ID_CALL, PANE_QUERY(FALLBACK, '=main:@0.%0')]);
  });
}

test('probe refuses a pane pid that is the tmux server of the supplied layout', t => {
  const result = runProbe(t, { pid: 123, target: 'switchboard-first:@0.%0', session: 'switchboard-first', panePid: '122\n' });
  assertRefused(result, [ID_CALL, PANE_QUERY(FALLBACK, '=switchboard-first:@0.%0')]);
});

test('probe refuses when the pane process is a shell parent of the descriptor pid', t => {
  assertRefused(runProbe(t, { pid: 4242, panePid: '4000\n' }), [ID_CALL, PANE_QUERY(FALLBACK, '=main:@0.%0')]);
});

test('probe accepts the supplied layout where the pane process is the descriptor pid', t => {
  const result = runProbe(t, { pid: 123, target: 'switchboard-first:@0.%0', session: 'switchboard-first' });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(firstField(result), FALLBACK);
});

for (const [name, panePid] of [
  ['empty', ''], ['nonnumeric', 'abc\n'], ['zero', '0\n'], ['leading-zero', '04242\n'], ['leading-space', ' 4242\n'],
  ['trailing-space', '4242 \n'], ['multi-line', '4242\n4243\n'], ['different', '4243\n'],
]) {
  test(`probe refuses a ${name} pane pid`, t => {
    assertRefused(runProbe(t, { panePid }));
  });
}

const ENV_SOCK = '/custom/tmux-1000/named';
const ENV_TMUX = Buffer.from(`TMUX=${ENV_SOCK},122,0\0`);

test('probe keeps the environ socket, its fields and their order, without uid or pane queries', t => {
  const result = runProbe(t, { environ: ENV_TMUX, sock: ENV_SOCK });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout.toString().split('\u0001').map(field => field.trim()), [
    ENV_SOCK, '200x50', 'status on', 'mouse off', 'window-size manual', 'set-titles off', 'set-titles-string plain', '0', '1',
  ]);
  assert.ok(result.calls.length > 0);
  assert.ok(result.calls.every(call => call[0] === 'tmux' && call[2] === ENV_SOCK && !call.includes('#{pane_pid}')));
});

for (const [name, options] of [
  ['an unreachable server', { sock: '/elsewhere/default' }],
  ['a target absent from the server', { rest: '@9.%9' }],
]) {
  test(`probe never falls back from the environ socket when it has ${name}`, async t => {
    const f = adapterOverShell(t, { environ: ENV_TMUX, sock: ENV_SOCK, ...options });
    const attached = await f.attach();
    assert.equal(attached.ok, false);
    assert.equal(attached.error, 'could not parse the remote window size');
    assert.equal(f.spawns.length, 0);
    const [result] = f.shellResults;
    assert.ok(result.calls.length > 0);
    assert.ok(result.calls.every(call => call[0] === 'tmux' && call[2] === ENV_SOCK && !call.includes('#{pane_pid}')));
  });
}

for (const [name, options] of [
  ['fails with numeric output', { uid: '1000', idStatus: 1 }],
  ['prints nothing', { uid: '' }],
  ['prints letters', { uid: 'abc' }],
  ['prints a signed number', { uid: '-1' }],
  ['prints digits followed by text', { uid: '10x' }],
]) {
  test(`probe refuses without a tmux query when id -u ${name}`, t => {
    assertRefused(runProbe(t, options), [ID_CALL]);
  });
}

test('probe uses the root uid for the default socket', t => {
  const sock = '/tmp/tmux-0/default';
  const result = runProbe(t, { uid: '0', sock });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(firstField(result), sock);
});

function adapterOverShell(t, probeOptions, { chunk = 1, clientList = '' } = {}) {
  const spawns = [];
  const commands = [];
  const shellResults = [];
  const pid = probeOptions.pid ?? 4242;
  const target = probeOptions.target ?? 'main:@0.%0';
  const events = new EventEmitter();
  const raw = {
    pid: 1, onData: cb => events.on('data', cb), onExit: cb => events.on('exit', cb), write() {}, resize() {},
    kill() { events.emit('exit'); },
  };
  const adapter = createTmuxAttachAdapter({
    spawnPty(file, args) { spawns.push({ file, args }); return raw; },
    resolveSshPath: () => 'fake-ssh',
    profileId: 'workstation', instanceId: 'current', createAttachId: () => 'attach',
    waitForClientRetry: async () => {},
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn() {},
    runRemoteCommand: (alias, command, options) => {
      commands.push(command);
      if (command.includes('client_pid')) return Promise.resolve({ code: 0, stdout: clientList });
      if (!command.includes(`/proc/${pid}/environ`)) return Promise.resolve({ code: 0, stdout: '' });
      return defaultRunRemoteCommand(alias, command, {
        ...options,
        resolveSshPath: () => 'fake-ssh',
        spawnFn() {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = () => {};
          setImmediate(() => {
            const result = runProbe(t, probeOptions);
            shellResults.push(result);
            for (let i = 0; i < result.stdout.length; i += chunk) child.stdout.emit('data', result.stdout.subarray(i, i + chunk));
            if (result.stderr.length) child.stderr.emit('data', result.stderr);
            child.emit('close', result.status);
          });
          return child;
        },
      });
    },
  });
  return {
    spawns, commands, shellResults, events,
    attach: () => adapter.attach('vps', { pid, tmux: target }, { cols: 100, rows: 40 }),
  };
}

const EXIT3_ERROR = 'process 4242 carries no readable TMUX environment variable and the default tmux socket could not be verified for target main:@0.%0 with pane pid 4242 — cannot discover its tmux socket';

function assertRejectedThroughAdapter(f, attached) {
  assert.equal(attached.ok, false);
  assert.equal(attached.error, EXIT3_ERROR);
  assert.equal(f.spawns.length, 0);
  assert.equal(f.commands.length, 1, 'only the discovery call may run');
  assert.equal(f.shellResults.length, 1);
  assertRefused(f.shellResults[0], [ID_CALL]);
}

const UTF8_LOCALES = (() => {
  const listed = spawnSync('locale', ['-a'], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return { error: listed.error?.message || `locale -a exited ${listed.status}` };
  const names = listed.stdout.split('\n').filter(name => /\.utf-?8$/i.test(name));
  return { name: names.find(name => /^C\.utf-?8$/i.test(name)) || names[0] || null };
})();

test('the installed locales can be enumerated', () => {
  assert.equal(UTF8_LOCALES.error, undefined, 'locale -a must run so the UTF-8 locale variants are not skipped silently');
});

const BASE_BYTES = [
  ['a space', { tmuxTmpdir: '/tmp/a b' }],
  ['a single quote', { tmuxTmpdir: "/tmp/a'b" }],
  ['a double quote', { tmuxTmpdir: '/tmp/a"b' }],
  ['a backslash', { tmuxTmpdir: '/tmp/a\\b' }],
  ['a tab', { tmuxTmpdir: '/tmp/a\tb' }],
  ['a command substitution', { tmuxTmpdir: '/tmp/a$(touch injected)b' }],
  ['a semicolon', { tmuxTmpdir: '/tmp/a;touch injected;b' }],
  ['a glob', { tmuxTmpdir: '/tmp/a*b' }],
  ['a UTF-8 character', { prelude: "TMUX_TMPDIR=$(printf '/tmp/\\303\\251'); export TMUX_TMPDIR; ", bytes: Buffer.from('/tmp/é') }],
  ['an invalid UTF-8 byte', { prelude: "TMUX_TMPDIR=$(printf '/tmp/\\377'); export TMUX_TMPDIR; ", bytes: Buffer.from([0x2f, 0x74, 0x6d, 0x70, 0x2f, 0xff]) }],
];

for (const [locale, value] of [['C', 'C'], ['a UTF-8 locale', UTF8_LOCALES.name]]) {
  const skip = value || UTF8_LOCALES.error ? false : 'no UTF-8 locale installed';
  for (const [name, { bytes, ...options }] of BASE_BYTES) {
    test(`probe refuses a custom base containing ${name} before any tmux query, under ${locale}`, { skip }, async t => {
      const env = { LC_ALL: value };
      if (bytes) {
        const preflight = spawnSync(TEST_SHELL, ['-c', `${options.prelude}printf '%s' "$TMUX_TMPDIR"`], { env });
        assert.deepEqual(preflight.stdout, bytes);
      }
      const f = adapterOverShell(t, { ...options, env, sockAny: true });
      const attached = await f.attach();
      assertRejectedThroughAdapter(f, attached);
      assert.ok(!existsSync(path.join(f.shellResults[0].dir, 'injected')));
    });
  }

  test(`probe keeps allowed punctuation in a custom base byte for byte over one-byte chunks, under ${locale}`, { skip }, async t => {
    const sock = '/tmp/socket._-:@%+=,/tmux-1000/default';
    const f = adapterOverShell(t, { tmuxTmpdir: '/tmp/socket._-:@%+=,', sock, env: { LC_ALL: value } });
    const attached = await f.attach();
    t.after(() => f.events.emit('exit'));
    assert.equal(attached.ok, true, attached.error);
    assert.equal(f.spawns.length, 1);
    assert.ok(f.spawns[0].args.at(-1).includes(`-S ${shellSingleQuote(sock)}`));
    const [result] = f.shellResults;
    assert.deepEqual(result.calls[1], PANE_QUERY(sock, '=main:@0.%0'));
    assert.ok(result.calls.slice(1).every(call => call[2] === sock));
    assert.equal(f.commands.filter(command => command.includes('/proc/4242/environ')).length, 1);
    assert.ok(f.commands.slice(1).every(command => !command.includes('-S ') || command.includes(`-S ${shellSingleQuote(sock)}`)));
  });
}

for (const [name, tmuxTmpdir] of [
  ['the forged discovery fields', ['/tmp/wrong', '80x24', '', '', '', '', '', '0', '1', ''].join('\x01')],
  ['a single separator', '/tmp/a\x01b'],
  ['an embedded line feed', '/tmp/a\nb'],
]) {
  test(`probe refuses a custom base carrying ${name} before any tmux query`, async t => {
    const f = adapterOverShell(t, { tmuxTmpdir, sock: `${tmuxTmpdir}/tmux-1000/default` });
    const attached = await f.attach();
    assertRejectedThroughAdapter(f, attached);
  });
}

test('probe attaches the supplied layout through the default socket for pid 123', async t => {
  const f = adapterOverShell(t, { pid: 123, target: 'switchboard-first:@0.%0', session: 'switchboard-first' });
  const attached = await f.attach();
  t.after(() => f.events.emit('exit'));
  assert.equal(attached.ok, true, attached.error);
  assert.ok(f.spawns[0].args.at(-1).includes(`-S ${shellSingleQuote(FALLBACK)}`));
  assert.ok(f.spawns[0].args.at(-1).includes('-t switchboard-first:@0.%0'));
});

const REFUSAL_CASES = [
  ['the server is unavailable', { sock: '/tmp/other/default' }],
  ['the target is missing', { rest: '@9.%9' }],
  ['the pane pid differs', { panePid: '4000\n' }],
  ['id -u fails', { idStatus: 1 }],
];

for (const [name, options] of REFUSAL_CASES) {
  test(`adapter refuses through the real probe output when ${name}`, async t => {
    const f = adapterOverShell(t, options);
    const attached = await f.attach();
    assert.equal(attached.ok, false);
    assert.equal(attached.error, EXIT3_ERROR);
    assert.equal(f.spawns.length, 0);
    assert.equal(f.commands.length, 1);
    assertRefused(f.shellResults[0]);
  });
}

for (const [name, clients, clientList, shared] of [
  ['solo', '', '', false],
  ['shared', 'peer\n', '9000\t/dev/pts/2\t\n', true],
]) {
  test(`adapter attaches a ${name} session through the default socket from real probe output`, async t => {
    const f = adapterOverShell(t, { clients }, { clientList });
    const attached = await f.attach();
    t.after(() => f.events.emit('exit'));
    assert.equal(attached.ok, true, attached.error);
    assert.equal(f.shellResults.length, 1);
    assert.equal(f.commands.filter(command => command.includes('/proc/4242/environ')).length, 1);
    assert.equal(attached.cols, shared ? 200 : 100);
    assert.equal(attached.remoteResizeAllowed, !shared);
    const attachCommand = f.spawns[0].args.at(-1);
    assert.ok(attachCommand.includes(`-S ${shellSingleQuote(FALLBACK)}`));
    assert.equal(attachCommand.includes('status off'), !shared);
  });
}
