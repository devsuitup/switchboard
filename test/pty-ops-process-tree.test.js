'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { killPty, writePty, resizePty, detachPty } = require('../pty-ops');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { extractFunction } = require('./app-source');
const { stopProcessTree } = require('../src/main/terminals/stop-process-tree');

function fixture(extra = {}) {
  const calls = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const pty = { pid: 897, kill: () => calls.push('pty'), write() {}, resize() {} };
  const session = { pty, kind: 'local-pty', exited: false, ...extra };
  const options = { platform: 'win32', stopTree(pid, opts) { calls.push({ pid, ...opts }); return pending; } };
  return { calls, session, options, finish };
}

test('local Windows close stops its still-owned tree before closing ConPTY once', async () => {
  const f = fixture();
  assert.equal(killPty(f.session, 'test', f.options), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].pid, 897);
  assert.equal(f.calls[0].graceMs, 100);
  assert.equal(f.calls[0].isCurrent(), true);
  assert.equal(killPty(f.session, 'test', f.options), false);
  assert.equal(writePty(f.session, 'x'), false);
  assert.equal(resizePty(f.session, 80, 24), false);
  f.finish(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.slice(1), ['pty']);
});

test('the stop guard rejects an exited session, replaced handle or changed root PID', () => {
  for (const change of [s => { s.exited = true; }, s => { s.pty = { pid: 897 }; }, s => { s.pty.pid++; }]) {
    const f = fixture();
    killPty(f.session, 'test', f.options);
    change(f.session);
    assert.equal(f.calls[0].isCurrent(), false);
    f.finish(false);
  }
});

test('background, detach, remote and already exited sessions keep the PTY-only path', () => {
  for (const extra of [{ backgrounding: true }, { backgrounded: true }, { isAttach: true },
    { detaching: true }, { host: 'remote' }, { kind: 'remote-attach' }, { exited: true }]) {
    const f = fixture(extra);
    assert.equal(killPty(f.session, 'test', f.options), true);
    assert.deepEqual(f.calls, ['pty']);
  }
  const f = fixture();
  assert.equal(killPty(f.session, 'test', { ...f.options, platform: 'linux' }), true);
  assert.deepEqual(f.calls, ['pty']);
});

test('failed tree stop still releases ConPTY and detach fallback never starts a tree stop', async () => {
  const f = fixture();
  killPty(f.session, 'test', f.options);
  f.finish(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1), 'pty');
  const d = fixture();
  d.session.pty.write = () => { throw new Error('closed'); };
  assert.equal(detachPty(d.session, 'test'), true);
  assert.deepEqual(d.calls, ['pty']);
});

for (const scenario of ['foreground', 'background', 'exited', 'tree-failed']) {
  test(`runClaudeCommand timeout retains ${scenario} stop policy`, async () => {
    const filename = path.join(__dirname, '..', 'main.js');
    const source = fs.readFileSync(filename, 'utf8');
    const child = new EventEmitter();
    Object.assign(child, { pid: 897, exitCode: null, signalCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter() });
    let kills = 0;
    child.kill = () => { kills++; };
    const commands = [], timers = [];
    const context = vm.createContext({
      path, isWindows: false, getSetting: () => ({}), SETTING_DEFAULTS: {},
      resolveShell: () => ({ path: '/bin/sh' }), shellArgs: () => [], quoteArgvForShell: () => '',
      cleanPtyEnv: {}, spawnChild: () => child,
      setTimeout: fn => { timers.push(fn); return { unref() {} }; }, clearTimeout() {},
      stopProcessTree: (pid, options) => stopProcessTree(pid, { ...options, platform: 'win32',
        spawnChild: (program, args) => {
          commands.push({ program, args });
          const command = new EventEmitter();
          queueMicrotask(() => command.emit('close', scenario === 'tree-failed' ? 1 : 0));
          return command;
        } }),
    });
    vm.runInContext(extractFunction(source, 'runClaudeCommand'), context, { filename });
    const done = context.runClaudeCommand([scenario === 'background' ? '--bg' : 'agents'], { cwd: __dirname, timeout: 50 });
    if (scenario === 'exited') { child.exitCode = 0; child.emit('exit', 0); }
    timers[0]();
    await done;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(commands.length, ['foreground', 'tree-failed'].includes(scenario) ? 1 : 0);
    if (commands.length) assert.deepEqual(commands[0], { program: 'taskkill.exe', args: ['/PID', '897', '/T', '/F'] });
    assert.equal(kills, ['background', 'tree-failed'].includes(scenario) ? 1 : 0);
  });
}
