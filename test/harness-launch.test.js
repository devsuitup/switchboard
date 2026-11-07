'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../main.js');
const cases = [
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
    const end = source.indexOf("let claudeCmd = 'claude '", start);
    assert.ok(end > start);
    const context = {
      sessionId: 'session', isNew, sessionOptions: Object.freeze(options), spawnCwd: '/project',
      isAttach: false, PROJECTS_DIR: '/unused', sessionTranscriptExists: () => exists,
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
