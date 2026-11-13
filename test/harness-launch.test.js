'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../main.js');
const cases = [
  ['browser extension', true, true, true, { browserMode: 'claude-in-chrome' }, ['--session-id', 'session', '--chrome']],
  ['browser resume', false, true, true, { browserMode: 'claude-in-chrome' }, ['--resume', 'session', '--chrome']],
  ['browser fork', true, true, true, { browserMode: 'claude-in-chrome', forkFrom: 'source' }, ['--resume', 'source', '--fork-session', '--chrome']],
  ['explicit off defeats legacy chrome', true, true, true, { browserMode: 'off', chrome: true }, ['--session-id', 'session']],
  ['managed is inert', true, true, true, { browserMode: 'managed', chrome: true }, ['--session-id', 'session']],
  ['invalid is safe off', true, true, true, { browserMode: null, chrome: true }, ['--session-id', 'session']],
  ['string false is not chrome', true, true, true, { chrome: 'false' }, ['--session-id', 'session']],
  ['new', true, true, true, {}, ['--session-id', 'session']],
  ['resume', false, true, true, { worktree: true }, ['--resume', 'session']],
  ['start-fresh', false, false, true, {}, ['--session-id', 'session']],
  ['fork', true, true, true, { forkFrom: 'source' }, ['--resume', 'source', '--fork-session']],
  ['fork with worktree', true, true, true, { forkFrom: 'source', worktree: true, worktreeName: 'branch' },
    ['--resume', 'source', '--fork-session', '--worktree', 'branch']],
  ['worktree-not-git', true, true, false, { worktree: true, worktreeName: 'branch' }, ['--session-id', 'session']],
  ['worktree', true, true, true, { worktree: true, worktreeName: 'branch' }, ['--session-id', 'session', '--worktree', 'branch']],
  ['all options', true, true, true, { dangerouslySkipPermissions: true, permissionMode: 'plan', chrome: true,
    addDirs: ' /a, ,C:\\space dir, /b ', appendSystemPrompt: 'prompt', sandbox: true, preLaunchCmd: 'prefix', mcpEmulation: true },
  ['--session-id', 'session', '--dangerously-skip-permissions', '--chrome', '--add-dir', '/a', '--add-dir', 'C:\\space dir', '--add-dir', '/b', '--append-system-prompt', 'prompt']],
  ['permission mode', false, true, true, { permissionMode: 'plan' }, ['--resume', 'session', '--permission-mode', 'plan']],
];

for (const [name, isNew, exists, git, options, expected] of cases) {
  test(`open-terminal preserves argv: ${name}`, () => {
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf('const claudeArgs = []', source.indexOf("ipcMain.handle('open-terminal'"));
    assert.ok(start > 0);
    const end = source.indexOf('if (!isAttach && sessionOptions?.sandbox && process.platform', start);
    assert.ok(end > start);
    const context = {
      sessionId: 'session', isNew, sessionOptions: Object.freeze(options), spawnCwd: '/project',
      isAttach: false, PROJECTS_DIR: '/unused', sessionTranscriptExists: () => exists,
      triggerPermit: null,
      launchMode: null,
      isGitRepo: () => git, parseAddDirs: value => String(value || '').split(',').map(s => s.trim()).filter(Boolean),
      log: { info() {}, warn() {} },
      getHarness: id => require('../harnesses').getHarness(id),
    };
    vm.runInNewContext(source.slice(start, end) + '\nglobalThis.result = claudeArgs;', context, { filename });
    assert.deepEqual(Array.from(context.result), expected);
  });
}

test('Claude pure argv builder exposes the characterized launch contract', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../harnesses/claude.js')), 'Claude adapter must exist');
  const { buildLaunchArgs } = require('../harnesses/claude');
  for (const [, isNew, exists, git, options, expected] of cases) {
    const startsFresh = isNew || (!options.forkFrom && !exists);
    const effective = { ...options, worktree: options.worktree && git };
    assert.deepEqual(buildLaunchArgs({ sessionId: 'session', isNew: startsFresh, options: effective }), expected);
  }
});

const { buildLaunchArgs: claudeArgs } = require('../harnesses/claude');
const awkwardNames = ['smithy hardening', `it's "quoted"`, 'a\\', 'C:\\dir\\', '$HOME `id` $(id) %PATH% !x ^y', 'a&b|c>d<e (f)',
  '--dangerously-skip-permissions', 'cafe\u0301 \u{1F600}', '-n'];

for (const name of awkwardNames) {
  test(`fresh launch passes ${JSON.stringify(name)} as one --name value`, () => {
    assert.deepEqual(claudeArgs({ sessionId: 'session', isNew: true, options: {}, name }), ['--session-id', 'session', '--name', name]);
  });
}
test('launch name coexists with the other fresh-launch options', () => {
  const options = { permissionMode: 'plan', worktree: true, worktreeName: 'branch', addDirs: '/a', appendSystemPrompt: 'prompt' };
  assert.deepEqual(claudeArgs({ sessionId: 'session', isNew: true, options, name: 'Task' }),
    ['--session-id', 'session', '--name', 'Task', '--permission-mode', 'plan', '--worktree', 'branch', '--add-dir', '/a', '--append-system-prompt', 'prompt']);
});
test('a name inside the session options never becomes the launch name', () => {
  assert.deepEqual(claudeArgs({ sessionId: 'session', isNew: true, options: { name: 'sneaky' } }), ['--session-id', 'session']);
});
test('resume and fork ignore the launch name', () => {
  assert.deepEqual(claudeArgs({ sessionId: 'session', isNew: false, options: {}, name: 'Task' }), ['--resume', 'session']);
  assert.deepEqual(claudeArgs({ sessionId: 'session', isNew: true, options: { forkFrom: 'source' }, name: 'Task' }),
    ['--resume', 'source', '--fork-session']);
});
test('a launch name that is not a nonempty string is not passed', () => {
  for (const name of [{ toString: () => 'x' }, 5, '', null, ['a']]) {
    assert.deepEqual(claudeArgs({ sessionId: 'session', isNew: true, options: {}, name }), ['--session-id', 'session']);
  }
});
