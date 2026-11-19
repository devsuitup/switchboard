'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
