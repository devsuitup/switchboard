const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

for (const agree of [false, true]) {
  test('Remap ' + (agree ? 'proceeds and reports failure' : 'cancels') + ' after an async decision', async () => {
    const ctx = setupSidebarDom();
    try {
      const project = makeSampleProject({ projectPath: '/missing', missing: true });
      const remapped = [];
      const alerts = [];
      ctx.window.api = {
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
test('a failed worktree delete reports the error through appAlert', async () => {
  const ctx = setupSidebarDom();
  try {
    const parent = makeSampleProject({ projectPath: '/p' });
    const child = makeSampleProject({ projectPath: '/p/.claude/worktrees/w' });
    const alerts = [];
    ctx.window.api = { deleteWorktree: async () => ({ ok: false, error: 'busy' }) };
    ctx.window.showDeleteWorktreeDialog = async () => true;
    ctx.window.appAlert = async ({ message }) => { alerts.push(message); };
    ctx.sidebar.renderProjects([parent, child], true);
    await ctx.document.querySelector('.worktree-delete-btn').onclick(new ctx.window.MouseEvent('click'));
    assert.deepEqual(alerts, ['Failed to delete worktree: busy']);
  } finally { ctx.destroy(); }
});
