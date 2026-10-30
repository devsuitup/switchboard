'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { extractFunction } = require('./app-source');
const { stopProcessTree } = require('../src/main/terminals/stop-process-tree');

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
    if (commands.length) assert.deepEqual(commands[0], {
      program: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), args: ['/PID', '897', '/T', '/F'],
    });
    assert.equal(kills, ['background', 'tree-failed'].includes(scenario) ? 1 : 0);
  });
}
