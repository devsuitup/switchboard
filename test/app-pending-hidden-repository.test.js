'use strict';

// loadProjects builds a group for a pending session that has no transcript
// yet. In a worktree of a repository hidden with Hide Project, that group must
// stay hidden, like the listed groups of that repository's worktrees.
// See .ai/contexts/session-cache.md ("Archived projects", worktree nesting).

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const ID = '3f2a9c10-7b1d-4e55-9a60-0123456789ac';
const WT = '/r/.claude/worktrees/w';

async function run(pendingSession, hiddenProjects) {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    window.loadingStatus = window.document.createElement('div');
    window.reportActivityFocus = () => {};
    window.reportActivityTitles = () => {};
    window.pollActiveSessions = async () => {};
    window.refreshSidebar = () => {};
    window.renderDefaultStatus = () => {};
    window.api = {
      getProjects: async () => [],
      getActiveTerminals: async () => [],
      getSetting: async (key) => (key === 'global' ? { hiddenProjects } : null),
    };
    window.cachedProjects = [];
    window.cachedAllProjects = [];
    window.pendingSessions.set(ID, { session: pendingSession, projectPath: pendingSession.projectPath, folder: '-wt' });
    const fns = loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects'] });
    await fns.loadProjects();
    const lists = JSON.parse(JSON.stringify({ cached: window.cachedProjects, all: window.cachedAllProjects }));
    ctx.sidebar.renderProjects(window.cachedProjects, true);
    const drawn = !!ctx.document.getElementById('ph-' + ctx.sidebar.folderId(pendingSession.projectPath));
    return { ...lists, drawn };
  } finally {
    ctx.destroy();
  }
}

test('a pending session in a worktree of a hidden repository stays hidden', async () => {
  const { cached, all, drawn } = await run({ sessionId: ID, projectPath: WT, summary: 'New session' }, ['/r']);
  for (const list of [cached, all]) assert.equal(list.find(p => p.projectPath === WT).hiddenRepository, true);
  assert.equal(drawn, false);
});

test('a pending session in a worktree of a repository hidden on another host is shown', async () => {
  const { cached, drawn } = await run({ sessionId: ID, projectPath: WT, summary: 'New session' }, ['box::/r']);
  assert.equal(cached.find(p => p.projectPath === WT).hiddenRepository, undefined);
  assert.equal(drawn, true);
});

test('a pending remote session in a worktree of a repository hidden on its host stays hidden', async () => {
  const { cached } = await run({ sessionId: ID, projectPath: WT, remoteAlias: 'box', summary: 'New session' }, ['box::/r']);
  assert.equal(cached.find(p => p.projectPath === WT).hiddenRepository, true);
});
