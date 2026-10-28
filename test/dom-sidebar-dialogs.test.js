const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

for (const action of ['Change path', 'Delete worktree']) {
  test(`${action} ignores repeated clicks through checking and confirmation and restores focus on cancel`, async t => {
    const ctx = setupSidebarDom();
    t.after(() => ctx.destroy());
    const remap = action === 'Change path';
    const projectPath = remap ? '/missing' : '/p/.claude/worktrees/w';
    const projects = remap ? [makeSampleProject({ projectPath, missing: true })]
      : [makeSampleProject({ projectPath: '/p' }), makeSampleProject({ projectPath })];
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    let checks = 0, dialogs = 0, writes = 0;
    ctx.window.api[remap ? 'checkRemapProject' : 'checkDeleteWorktree'] = () => { checks++; return ready; };
    ctx.window.api.browseFolder = async () => '/replacement';
    ctx.window.api.worktreeStatus = async () => ({ ok: true, total: 0, dirty: [] });
    ctx.window.api[remap ? 'remapProject' : 'deleteWorktree'] = async () => { writes++; return { ok: true }; };
    const dialogName = remap ? 'appConfirm' : 'showDeleteWorktreeDialog';
    const showDialog = ctx.window[dialogName];
    ctx.window[dialogName] = (...args) => { dialogs++; return showDialog(...args); };
    ctx.sidebar.renderProjects(projects, true);
    const opener = ctx.document.querySelector(remap ? '.project-remap-btn' : '.worktree-delete-btn');
    opener.focus();
    const click = () => opener.onclick(new ctx.window.MouseEvent('click'));
    const first = click();
    const second = click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 1, 'one check while the IPC is pending');
    assert.equal(dialogs, 0);
    release({ ok: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dialogs, 1, 'one dialog after the check');
    assert.equal(opener.disabled, false, 'the opener stays focusable while the dialog is open');
    await click();
    assert.equal(checks, 1, 'no second check while the dialog is pending');
    assert.equal(dialogs, 1);
    ctx.document.querySelector(remap ? '.choice-dialog-cancel' : '#dwt-cancel').click();
    await Promise.all([first, second]);
    assert.equal(ctx.document.activeElement, opener, 'cancel returns focus to the opener');
    assert.equal(writes, 0);
    const retry = click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 2, 'cancel releases the guard');
    assert.equal(dialogs, 2);
    ctx.document.querySelector(remap ? '.choice-dialog-cancel' : '#dwt-cancel').click();
    await retry;
    assert.equal(ctx.document.activeElement, opener);
  });
}

for (const agree of [false, true]) {
  test('Remap ' + (agree ? 'proceeds and reports failure' : 'cancels') + ' after an async decision', async () => {
    const ctx = setupSidebarDom();
    try {
      const project = makeSampleProject({ projectPath: '/missing', missing: true });
      const remapped = [];
      const alerts = [];
      ctx.window.api = {
        checkRemapProject: async () => ({ ok: true }),
        browseFolder: async () => '/replacement',
        remapProject: async (...args) => { remapped.push(args); return { error: 'busy' }; },
      };
      ctx.window.appAlert = async ({ message }) => { alerts.push(message); };
      ctx.sidebar.renderProjects([project], true);
      let answer;
      ctx.window.appConfirm = () => new Promise(resolve => { answer = resolve; });
      const pending = ctx.document.querySelector('.project-remap-btn').onclick(new ctx.window.MouseEvent('click'));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(remapped, []);
      answer(agree);
      await pending;
      assert.deepEqual(remapped, agree ? [['/missing', '/replacement']] : []);
      assert.deepEqual(alerts, agree ? ['Failed to remap: busy'] : []);
    } finally { ctx.destroy(); }
  });
}
test('a failed worktree delete reports the error through a persistent notice', async () => {
  const ctx = setupSidebarDom();
  try {
    const parent = makeSampleProject({ projectPath: '/p' });
    const child = makeSampleProject({ projectPath: '/p/.claude/worktrees/w' });
    const alerts = [];
    ctx.window.api = {
      checkDeleteWorktree: async () => ({ ok: true }),
      deleteWorktree: async () => ({ ok: false, error: 'busy' }),
    };
    ctx.window.showDeleteWorktreeDialog = async () => true;
    ctx.window.appAlert = async ({ message }) => { alerts.push(message); };
    ctx.sidebar.renderProjects([parent, child], true);
    await ctx.document.querySelector('.worktree-delete-btn').onclick(new ctx.window.MouseEvent('click'));
    assert.deepEqual(alerts, []);
    assert.match(ctx.document.querySelector('[role="alert"]').textContent, /busy/);
  } finally { ctx.destroy(); }
});
