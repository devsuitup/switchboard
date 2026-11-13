'use strict';

// see .ai/contexts/trigger-watcher.md ("Naming a new session")
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, ID } = require('./fixtures/trigger-main-open.cjs');
const profiles = require('../src/main/terminals/shell-profiles');
const { validatePreLaunchCmd } = require('../src/main/terminals/pre-launch-cmd-guard');

function open({ options = {}, overrides = {}, afterValidation, permit = 'new', isNew = true } = {}) {
  const mcp = { starts: 0, shutdowns: [] };
  let validations = 0;
  const f = fixture({
    resolveShell: () => ({ path: '/bin/bash' }), quoteArgvForShell: profiles.quoteArgvForShell, claudeCommand: profiles.claudeCommand,
    shellArgs: profiles.shellArgs, validatePreLaunchCmd, os: require('node:os'),
    sandboxScriptPath: () => '/opt/switchboard/claude-sandbox.sh', sandboxBindEnv: () => null,
    startMcpServer: async () => { mcp.starts++; mcp.server = { port: 4242 }; return mcp.server; }, shutdownMcpServer: id => { mcp.shutdowns.push(id); },
    validateTriggerOpen: async permit => { validations++; return afterValidation?.(validations, permit) ?? { ok: true, cwd: permit.target?.cwd }; },
    parseAddDirs: () => [], ...overrides,
  });
  if (permit === 'new') { f.permit.mode = 'new'; f.permit.requestedSessionId = null; f.permit.name = 'Task'; }
  if (permit) f.authorize();
  return { f, mcp, result: () => f.open(permit ? 'permit' : null, isNew, { mcpEmulation: true, ...options }) };
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

const launches = [
  ['an ordinary new session', { permit: false, isNew: true }, 'new', '--session-id'],
  ['an ordinary resume', { permit: false, isNew: false, overrides: { sessionTranscriptExists: () => true } }, 'resume', '--resume'],
  ['an ordinary fork', { permit: false, isNew: true, options: { forkFrom: 'source' } }, 'fork', '--fork-session'],
  ['a trigger resume', { permit: 'resume', isNew: false, overrides: { sessionTranscriptExists: () => true } }, 'resume', '--resume'],
  ['a trigger new session', { permit: 'new', isNew: true }, 'new', '--session-id'],
];
for (const [label, config, mode, flag] of launches) {
  test(`${label} keeps the MCP server it started`, async () => {
    const { f, mcp, result } = open(config);
    assert.equal((await result()).ok, true);
    assert.deepEqual([mcp.starts, mcp.shutdowns, f.map.size], [1, [], 1]);
    const session = f.map.get(ID);
    assert.equal(session.launchMode, mode);
    assert.ok(f.spawns[0].args.join(' ').includes(flag), f.spawns[0].args.join(' '));
    assert.equal(session.mcpServer, mcp.server);
  });
  for (const [failure, failing] of [
    ['project storage rejects', { scheduleProjects: () => ({ add: async () => { throw new Error('storage'); } }) }],
    ['the PTY cannot be spawned', { spawnPty: () => { throw new Error('spawn'); } }],
  ]) {
    test(`${label} shuts its MCP server down exactly once when ${failure}`, async () => {
      const { f, mcp, result } = open({ ...config, overrides: { ...config.overrides, ...failing } });
      assert.equal((await result()).ok, false);
      assert.deepEqual([mcp.starts, mcp.shutdowns, f.map.size], [1, [ID], 0]);
    });
  }
}
