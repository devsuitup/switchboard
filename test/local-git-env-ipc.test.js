'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProjectActionHandlers } = require('./project-action-harness');
const { localGitEnv } = require('../git-changes-runner');
const { savedEnv } = require('./git-discovery-fixture');

test('local worktree IPCs pass the C environment on every Git attempt', async t => {
  savedEnv(t,{ LC_ALL:'fr_FR.utf8', LANG:'fr_FR.utf8', LC_MESSAGES:'fr_FR.utf8', LANGUAGE:'fr', GIT_DIR:'/wrong' });
  const calls = [];
  let cleanup = 0;
  let mode = 'locked';
  const target='/repo/.claude/worktrees/task';
  const handlers = loadProjectActionHandlers({
    localGitEnv,
    os: { homedir: () => '/home/test' },
    cliSessionState: { getSidebarDescriptors: () => [] },
    execFile(cmd,args,options,callback) {
      const cb = typeof options === 'function' ? options : callback;
      calls.push({cmd,args:Array.from(args),options:typeof options === 'function' ? undefined : options});
      if (args.includes('status')) cb(null,' M file\0','');
      else if (args.includes('list')) cb(null, `worktree ${target}\0HEAD abc\0branch refs/heads/topic\0locked backup\0\0`, '');
      else if (mode === 'error') cb(new Error('denied'),'', 'fatal: denied');
      else cb(null,'','');
    },
    writer: { cleanupWorktree: async () => { cleanup++; return 2; } },
    log: { info() {} }, notifyRendererProjectsChanged() {},
  });
  const status = await handlers.get('worktree-status')(null,target);
  assert.equal(status.total,1);
  assert.equal((await handlers.get('delete-worktree')(null,target,status)).ok,false);
  assert.equal(calls.filter(c => c.args.includes('remove')).length,0);
  assert.equal((await handlers.get('delete-worktree')(null,target,{ ...status, confirmLocked: true })).ok,true);
  assert.equal(cleanup,1);
  assert.equal(calls.length,7);
  assert.deepEqual(calls[6].args,['-C','/repo','worktree','remove','-f','-f','--',target]);
  for (const c of calls) {
    assert.ok(c.options?.env, 'every Git attempt must receive options.env');
    for (const k of ['LANG','LC_ALL','LC_MESSAGES']) assert.equal(c.options.env[k],'C');
    assert.equal(Object.hasOwn(c.options.env,'LANGUAGE'),false);
    assert.equal(Object.hasOwn(c.options.env,'GIT_DIR'),false);
  }
  mode='error';
  const result=await handlers.get('delete-worktree')(null,target,{ ...status, confirmLocked: true });
  assert.equal(result.ok,false);
  assert.match(result.error,/fatal: denied.*Review.*confirm Delete again/);
  assert.equal(calls.length,12);
  assert.equal(cleanup,1);
});
