// Issue #214: a project group mirrored from an SSH host has no local
// filesystem to spawn a PTY in. The "+" new-session button in its header
// must not let a click reach launchNewSession/open-terminal with isNew and
// the remote host's projectPath.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function remoteProject() {
  return makeSampleProject({
    projectPath: '/srv/supervision',
    folder: 'planificator::-srv-supervision',
    remoteAlias: 'planificator',
    sessions: [{
      sessionId: 'remote-1',
      summary: 'ripcord protocol',
      modified: '2026-09-06T10:00:00.000Z',
      starred: false,
      archived: 0,
      messageCount: 4,
      projectPath: '/srv/supervision',
      remoteAlias: 'planificator',
    }],
  });
}

test('the new-session button of a remote project group is disabled', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([remoteProject()], true);
    const fId = ctx.sidebar.folderId('/srv/supervision');
    const header = ctx.document.getElementById('ph-' + fId);
    const newBtn = header.querySelector('.project-new-btn');
    assert.ok(newBtn, 'the button must still render');
    assert.equal(newBtn.disabled, true);
    assert.match(newBtn.title, /planificator/);
  } finally { ctx.destroy(); }
});

test('clicking the new-session button of a remote project group opens nothing', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([remoteProject()], true);
    const fId = ctx.sidebar.folderId('/srv/supervision');
    const header = ctx.document.getElementById('ph-' + fId);
    const newBtn = header.querySelector('.project-new-btn');

    const popovers = [];
    ctx.window.showNewSessionPopover = (project, btn) => popovers.push(project.projectPath);

    newBtn.onclick({ stopPropagation: () => {} });

    assert.deepEqual(popovers, [], 'showNewSessionPopover must never be invoked for a remote project group');
  } finally { ctx.destroy(); }
});

test('a local project group is unaffected: the new-session button stays enabled and wired', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);
    const fId = ctx.sidebar.folderId('/home/dev/myproj');
    const header = ctx.document.getElementById('ph-' + fId);
    const newBtn = header.querySelector('.project-new-btn');
    assert.equal(newBtn.disabled, false);
    assert.equal(newBtn.title, 'New session');

    const popovers = [];
    ctx.window.showNewSessionPopover = (project, btn) => popovers.push(project.projectPath);

    newBtn.onclick({ stopPropagation: () => {} });

    assert.deepEqual(popovers, ['/home/dev/myproj']);
  } finally { ctx.destroy(); }
});
