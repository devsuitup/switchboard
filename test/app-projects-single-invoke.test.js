'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

test('a reload invokes get-projects once and keeps separate visible and search views', async () => {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    const calls = [];
    const visible = [{ projectPath: '/visible', sessions: [{ sessionId: 'v' }] }];
    const all = [...visible, { projectPath: '/archived', sessions: [{ sessionId: 'a', archived: 1 }] }];
    window.loadingStatus = window.document.createElement('div');
    for (const name of ['reportActivityFocus', 'reportActivityTitles', 'refreshSidebar', 'renderDefaultStatus']) window[name] = () => {};
    window.pollActiveSessions = async () => {};
    window.cachedProjects = [];
    window.cachedAllProjects = [];
    window.api = {
      getProjects: async mode => {
        calls.push(mode);
        return mode === 'both' ? { defaultProjects: visible, allProjects: all } : mode ? all : visible;
      },
      getActiveTerminals: async () => [],
      getSetting: async () => ({}),
    };
    const fns = loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects'] });
    await fns.loadProjects();
    assert.equal(calls.length, 1);
    assert.deepEqual(window.cachedProjects.map(p => p.projectPath), ['/visible']);
    assert.deepEqual(window.cachedAllProjects.map(p => p.projectPath), ['/visible', '/archived']);
    assert.equal(window.cachedProjects[0].sessions[0], window.cachedAllProjects[0].sessions[0]);
    await fns.loadProjects({ resort: true });
    assert.equal(calls.length, 2);
  } finally {
    ctx.destroy();
  }
});

test('archiving during a worker fetch keeps a newly pending session hidden', async () => {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    let release;
    let settings = { hiddenProjects: [] };
    window.loadingStatus = window.document.createElement('div');
    for (const name of ['reportActivityFocus', 'reportActivityTitles', 'refreshSidebar', 'renderDefaultStatus']) window[name] = () => {};
    window.pollActiveSessions = async () => {};
    window.cachedProjects = [];
    window.cachedAllProjects = [];
    window.api = {
      getProjects: () => new Promise(resolve => { release = resolve; }),
      getActiveTerminals: async () => [],
      getSetting: async () => structuredClone(settings),
    };
    const { loadProjects } = loadAppFunctions(ctx.context, { functions: ['dedup', 'loadProjects'] });
    const loading = loadProjects();
    settings = { hiddenProjects: ['/archived'] };
    window.pendingSessions.set('pending', {
      projectPath: '/archived', folder: '-archived',
      session: { sessionId: 'pending', projectPath: '/archived' },
    });
    release({ defaultProjects: [], allProjects: [] });
    await loading;
    assert.equal(window.cachedProjects.length, 0);
    assert.equal(window.cachedAllProjects.length, 0);
  } finally { ctx.destroy(); }
});
