'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { EventEmitter } = require('node:events');
const { guardPtyInputErrors } = require('../pty-ops');

test('main spawnPty registers the input error guard for ConPTY, fallback and POSIX spawns', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', range: true });
  const spawnFunction = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'spawnPty');
  assert.ok(spawnFunction, 'main.js must retain its shared spawn path');
  const scenarios = [
    { platform: 'win32', env: {}, attempts: 1, useConptyDll: true },
    { platform: 'win32', env: {}, attempts: 2, failBundled: true },
    { platform: 'win32', env: { SWITCHBOARD_NO_CONPTY_DLL: '1' }, attempts: 1 },
    { platform: 'linux', env: {}, attempts: 1 },
    { platform: 'darwin', env: {}, attempts: 1 },
  ];
  for (const scenario of scenarios) {
    const input = new EventEmitter();
    const pty = { pid: 517, _agent: { inSocket: input } };
    const calls = [];
    const context = vm.createContext({
      guardPtyInputErrors,
      pty: { spawn(file, args, opts) {
        calls.push({ file, args, opts });
        if (scenario.failBundled && opts.useConptyDll) throw new Error('missing conpty.dll');
        return pty;
      } },
      process: { platform: scenario.platform, env: scenario.env },
      log: { warn() {} },
    });
    vm.runInContext(source.slice(...spawnFunction.range), context);
    assert.equal(context.spawnPty('shell', ['arg'], { cols: 80 }), pty);
    assert.ok(input.listenerCount('error') > 0, `${JSON.stringify(scenario)} returned an unguarded PTY`);
    assert.doesNotThrow(() => input.emit('error', new Error('write EAGAIN')));
    assert.equal(calls.length, scenario.attempts);
    assert.equal(calls.at(-1).opts.useConptyDll, scenario.useConptyDll);
    assert.equal(calls.at(-1).opts.cols, 80);
  }
  assert.match(source, /const\s*\{[^}]*\bguardPtyInputErrors\b[^}]*\}\s*=\s*require\('\.\/pty-ops'\)/);
});
