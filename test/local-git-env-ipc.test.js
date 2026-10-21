'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { localGitEnv } = require('../git-changes-runner');
const { savedEnv } = require('./git-discovery-fixture');

test('local worktree IPCs pass the C environment on every Git attempt', async t => {
  savedEnv(t,{ LC_ALL:'fr_FR.utf8', LANG:'fr_FR.utf8', LC_MESSAGES:'fr_FR.utf8', LANGUAGE:'fr', GIT_DIR:'/wrong' });
  const source = fs.readFileSync(path.join(__dirname,'..','main.js'),'utf8');
  const handlers = {};
  const calls = [];
  let cleanup = 0;
  let mode = 'locked';
  const context = vm.createContext({
    ipcMain: { handle: (name,fn) => { handlers[name]=fn; } },
    checkDeleteWorktree: value => value === '/repo/.claude/worktrees/task' ? { ok:true, normalizedPath:value, parentRepo:'/repo' } : { ok:false, error:'invalid' },
    localGitEnv,
    execFile(cmd,args,options,callback) {
      const cb = typeof options === 'function' ? options : callback;
      calls.push({cmd,args:Array.from(args),options:typeof options === 'function' ? undefined : options});
      if (args.includes('status')) cb(null,' M file\n','');
      else if (mode === 'locked' && args.filter(a=>a==='-f').length===1) cb(new Error('locked'),'', 'fatal: locked');
      else if (mode === 'error') cb(new Error('denied'),'', 'fatal: denied');
      else cb(null,'','');
    },
    writer: { cleanupWorktree: async () => { cleanup++; return 2; } },
    log: { info() {} }, notifyRendererProjectsChanged() {},
  });
  for (const name of ['delete-worktree','worktree-status']) {
    const start=source.indexOf("ipcMain.handle('"+name+"'");
    vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),context);
  }
  const target='/repo/.claude/worktrees/task';
  assert.equal((await handlers['worktree-status'](null,target)).total,1);
  assert.equal((await handlers['delete-worktree'](null,target)).ok,true);
  assert.equal(cleanup,1);
  assert.equal(calls.length,3);
  assert.deepEqual(calls[1].args,['-C','/repo','worktree','remove','-f','--',target]);
  assert.deepEqual(calls[2].args,['-C','/repo','worktree','remove','-f','-f','--',target]);
  for (const c of calls) {
    assert.ok(c.options?.env, 'every Git attempt must receive options.env');
    for (const k of ['LANG','LC_ALL','LC_MESSAGES']) assert.equal(c.options.env[k],'C');
    assert.equal(Object.hasOwn(c.options.env,'LANGUAGE'),false);
    assert.equal(Object.hasOwn(c.options.env,'GIT_DIR'),false);
  }
  mode='error';
  const result=await handlers['delete-worktree'](null,target);
  assert.equal(result.ok,false);
  assert.equal(result.error,'fatal: denied');
  assert.equal(calls.length,4);
  assert.equal(cleanup,1);
});
