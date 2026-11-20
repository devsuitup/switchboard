'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProjectActionHandlers } = require('./project-action-harness');

test('check-delete-worktree refuses a worktree name or ancestor of . or .. even when the parent resolves to a known project', async () => {
  const handlers = loadProjectActionHandlers({ _isKnownProjectRoot: () => true, execFile: () => assert.fail('no git runs in the check') });
  const check = handlers.get('check-delete-worktree');
  for (const requested of ['/repo/.worktrees/.', '/repo/.worktrees/..', '/repo/.worktrees/../task', '/repo/./.worktrees/task',
    '/repo/.claude/worktrees/..', '/repo/.claude-worktrees/./', 'C:/repo/.worktrees/..']) {
    const result = await check(null, requested);
    assert.equal(result.ok, false, requested);
    assert.match(result.error, /recognized worktree layout/, requested);
  }
  for (const accepted of ['/repo/.worktrees/task.', '/repo/.worktrees/..task/', '/repo/.worktrees/.hidden']) {
    assert.deepEqual(JSON.parse(JSON.stringify(await check(null, accepted))), { ok: true }, `${accepted}: only whole . and .. segments are refused`);
  }
});

test('Windows backslash dot segments are refused before opening the worktree dialog', async () => {
  const handlers = loadProjectActionHandlers({ path: path.win32, _isKnownProjectRoot: () => true,
    execFile: () => assert.fail('no git runs in the check') });
  const check = handlers.get('check-delete-worktree');
  for (const requested of ['C:/repo/.worktrees/task\\..', 'C:/repo/.worktrees/task\\.',
    'C:/repo/..\\known/.worktrees/task', 'C:/repo/.\\known/.worktrees/task']) {
    const result = await check(null, requested);
    assert.equal(result.ok, false, `Windows dot segment must be refused: ${requested}`);
    assert.match(result.error, /recognized worktree layout/);
  }
  assert.equal((await check(null, 'C:/repo/.worktrees/task\\..name')).ok, true);
});

test('POSIX worktree names preserve literal backslashes before dots', async () => {
  const handlers = loadProjectActionHandlers({ path: path.posix, _isKnownProjectRoot: () => true });
  for (const requested of ['/repo/.worktrees/task\\..', '/repo/.worktrees/task\\.']) {
    assert.equal((await handlers.get('check-delete-worktree')(null, requested)).ok, true, requested);
  }
});
