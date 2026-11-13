'use strict';

// see .ai/contexts/trigger-watcher.md ("Naming a new session")
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, ID } = require('./fixtures/trigger-main-open.cjs');
const profiles = require('../src/main/terminals/shell-profiles');
const { validatePreLaunchCmd } = require('../src/main/terminals/pre-launch-cmd-guard');

function open({ options = {}, overrides = {}, afterValidation } = {}) {
  const mcp = { starts: 0, shutdowns: [] };
  let validations = 0;
  const f = fixture({
    resolveShell: () => ({ path: '/bin/bash' }), quoteArgvForShell: profiles.quoteArgvForShell, claudeCommand: profiles.claudeCommand,
    shellArgs: profiles.shellArgs, validatePreLaunchCmd, os: require('node:os'),
    sandboxScriptPath: () => '/opt/switchboard/claude-sandbox.sh', sandboxBindEnv: () => null,
    startMcpServer: async () => { mcp.starts++; return { port: 4242 }; }, shutdownMcpServer: id => { mcp.shutdowns.push(id); },
    validateTriggerOpen: async permit => { validations++; return afterValidation?.(validations, permit) ?? { ok: true, cwd: permit.target?.cwd }; },
    parseAddDirs: () => [], ...overrides,
  });
  f.permit.mode = 'new'; f.permit.requestedSessionId = null; f.permit.name = 'Task'; f.authorize();
  return { f, mcp, result: () => f.open('permit', true, { mcpEmulation: true, ...options }) };
}

test('a launch that registers its session keeps the MCP server it started', async () => {
  const { f, mcp, result } = open();
  assert.equal((await result()).ok, true);
  assert.deepEqual([mcp.starts, mcp.shutdowns], [1, []]);
  assert.equal(f.map.size, 1);
});
test('a rejected launch prefix starts no MCP server', async () => {
  const { f, mcp, result } = open({ options: { preLaunchCmd: 'a;b' } });
  assert.equal((await result()).ok, false);
  assert.deepEqual([mcp.starts, mcp.shutdowns.length, f.spawns.length], [0, 0, 0]);
});
test('an unsupported sandbox platform starts no MCP server', async () => {
  const platform = new Proxy(process, { get: (target, key) => (key === 'platform' ? 'win32' : Reflect.get(target, key)) });
  const { mcp, result } = open({ options: { sandbox: true }, overrides: { process: platform } });
  assert.match((await result()).error, /Sandbox mode requires Linux/);
  assert.deepEqual([mcp.starts, mcp.shutdowns.length], [0, 0]);
});

const afterStart = [
  ['the final validation refuses the permit', { afterValidation: n => (n > 1 ? { ok: false, reason: 'revoked', error: 'revoked' } : undefined) }],
  ['the deadline has passed at the last guard', { afterValidation: (n, permit) => { if (n > 1) permit.deadline = Date.now() - 1; } }],
  ['building the command throws', { overrides: { claudeCommand: () => { throw new Error('encode'); } } }],
  ['project storage rejects', { overrides: { scheduleProjects: () => ({ add: async () => { throw new Error('storage'); } }) } }],
  ['the PTY cannot be spawned', { overrides: { spawnPty: () => { throw new Error('spawn'); } } }],
];
for (const [label, config] of afterStart) {
  test(`the MCP server is shut down exactly once when ${label}`, async () => {
    const { f, mcp, result } = open(config);
    assert.equal((await result()).ok, false);
    assert.deepEqual([mcp.starts, mcp.shutdowns, f.map.size, f.spawns.length], [1, [ID], 0, 0]);
  });
}
