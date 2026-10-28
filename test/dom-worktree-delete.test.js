'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const tick = () => new Promise(resolve => setImmediate(resolve));
const target = '/home/jb/repo/.claude/worktrees/task';
const preview = { ok: true, path: target, homeDir: '/home/jb', branch: 'topic',
  dirty: [], total: 0, fingerprint: 'clean', ignoredCount: 2,
  sessions: [{ sessionId: 'live', cwd: target + '/nested' }], locked: false, lockReason: '' };

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.window.api.worktreeStatus = async () => preview;
  return ctx;
}

test('dialog names the full path, branch, running sessions and ignored count', async t => {
  const ctx = setup(t);
  const pending = ctx.window.showDeleteWorktreeDialog('task', target);
  await tick();
  try {
    const dialog = ctx.document.querySelector('.delete-worktree-dialog');
    assert.match(dialog.textContent, /~\/repo\/\.claude\/worktrees\/task/);
    assert.equal(dialog.querySelector('[title="' + target + '"]').title, target);
    assert.match(dialog.textContent, /Branch: topic/);
    assert.match(dialog.textContent, /live/);
    assert.match(dialog.textContent, /2 ignored.*deleted/i);
    ctx.document.querySelector('#dwt-confirm').click();
    assert.equal((await pending).fingerprint, 'clean');
  } finally { ctx.document.querySelector('#dwt-cancel')?.click(); }
});

test('confirmation stays disabled until a successful preview and explicit lock consent', async t => {
  const ctx = setup(t);
  let release;
  ctx.window.api.worktreeStatus = () => new Promise(resolve => { release = resolve; });
  const pending = ctx.window.showDeleteWorktreeDialog('task', target);
  await tick();
  try {
    assert.equal(ctx.document.querySelector('#dwt-confirm').disabled, true);
    release({ ...preview, locked: true, lockReason: 'backup disk' });
    await tick();
    assert.match(ctx.document.querySelector('.delete-worktree-dialog').textContent, /backup disk/);
    assert.equal(ctx.document.querySelector('#dwt-confirm').disabled, true);
    ctx.document.querySelector('#dwt-lock-confirm').click();
    assert.equal(ctx.document.querySelector('#dwt-confirm').disabled, false);
    ctx.document.querySelector('#dwt-confirm').click();
    assert.equal((await pending).confirmLocked, true);
  } finally { ctx.document.querySelector('#dwt-cancel')?.click(); }
});

test('changed status keeps a persistent notice and reopens for fresh confirmation', async t => {
  const ctx = setup(t);
  ctx.window.appAlert = async () => {};
  const calls = [];
  ctx.window.api.deleteWorktree = async (_path, shown) => {
    calls.push(shown);
    return { ok: false, refresh: true, error: 'Worktree changed. Review and confirm again.',
      status: { ...preview, fingerprint: 'dirty', dirty: ['?? late.txt'], total: 1 } };
  };
  ctx.sidebar.renderProjects([
    makeSampleProject({ projectPath: '/home/jb/repo', sessions: [] }),
    makeSampleProject({ projectPath: target, sessions: [] }),
  ], true);
  const pending = ctx.document.querySelector('.worktree-delete-btn').onclick({ stopPropagation() {} });
  await tick();
  ctx.document.querySelector('#dwt-confirm').click();
  await tick();
  try {
    assert.equal(calls[0]?.fingerprint, 'clean');
    assert.match(ctx.document.querySelector('[role="alert"]').textContent, /Review and confirm/);
    assert.match(ctx.document.querySelector('#dwt-status').textContent, /late.txt/);
    assert.equal(calls.length, 1);
  } finally {
    ctx.document.querySelector('#dwt-cancel')?.click();
    await pending;
  }
});

test('submodule force consent and lock consent must both be checked', async t => {
  const ctx = setup(t);
  ctx.window.api.worktreeStatus = async () => ({ ...preview, submodules: ['vendor/lib'], locked: true });
  const pending = ctx.window.showDeleteWorktreeDialog('task', target);
  await tick();
  try {
    const box = ctx.document.querySelector('#dwt-submodules-confirm');
    assert.ok(box, 'submodule removal needs an explicit consent checkbox');
    assert.match(ctx.document.querySelector('#dwt-status').textContent, /vendor\/lib/);
    ctx.document.querySelector('#dwt-lock-confirm').click();
    assert.equal(ctx.document.querySelector('#dwt-confirm').disabled, true);
    box.click();
    assert.equal(ctx.document.querySelector('#dwt-confirm').disabled, false);
    ctx.document.querySelector('#dwt-confirm').click();
    const shown = await pending;
    assert.equal(shown.confirmSubmodules, true);
    assert.equal(shown.confirmLocked, true);
  } finally { ctx.document.querySelector('#dwt-cancel')?.click(); await pending; }
});

test('a failed preview disables Delete and reports a persistent actionable notice', async t => {
  const ctx = setup(t);
  ctx.window.api.worktreeStatus = async () => { throw new Error('Git unavailable'); };
  const pending = ctx.window.showDeleteWorktreeDialog('task', target);
  await tick();
  try {
    assert.equal(ctx.document.querySelector('#dwt-confirm').disabled, true);
    assert.match(ctx.document.querySelector('[role="alert"]').textContent, /Git unavailable.*Cancel.*try Delete again/);
  } finally { ctx.document.querySelector('#dwt-cancel').click(); await pending; }
});

test('remote worktree uses no local deletion IPC even when the path matches a local project', async t => {
  const ctx = setup(t);
  const calls = [];
  ctx.window.api.checkDeleteWorktree = async () => { calls.push('local check'); return { ok: false }; };
  const projects = ['', 'server'].flatMap(remoteAlias => [
    makeSampleProject({ projectPath: '/home/jb/repo', sessions: [], remoteAlias }),
    makeSampleProject({ projectPath: target, sessions: [], remoteAlias }),
  ]);
  ctx.sidebar.renderProjects(projects, true);
  const buttons = ctx.document.querySelectorAll('.worktree-delete-btn');
  assert.equal(buttons.length, 2);
  await buttons[1].onclick({ stopPropagation() {} });
  assert.equal(calls.length, 0);
  assert.match(ctx.document.querySelector('[role="alert"]').textContent, /remote.*host/i);
});
