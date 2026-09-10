// Issue #252 — a remote project group header carries a manual reconnect
// action next to the host dot: it targets only that alias, flips the dot to
// a "connecting" state immediately (before ssh returns), and asks for a
// fresh render once the IPC call settles.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function remoteProject(overrides) {
  return makeSampleProject({
    projectPath: '/srv/supervision',
    folder: 'planificator::-srv-supervision',
    remoteAlias: 'planificator',
    remoteHostAt: Date.now(),
    remoteHostError: null,
    sessions: [],
    ...overrides,
  });
}

test('clicking the remote host refresh action targets only its own alias and flips the dot to connecting', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = [];
    let resolveRefresh;
    ctx.window.api.remoteHostRefresh = (alias) => {
      calls.push(alias);
      return new Promise((resolve) => { resolveRefresh = resolve; });
    };
    let loadCount = 0;
    ctx.window.loadProjects = () => { loadCount++; };

    ctx.sidebar.renderProjects([remoteProject()], true);

    const fId = ctx.sidebar.folderId('/srv/supervision');
    const header = ctx.document.getElementById('ph-' + fId);
    const refreshBtn = header.querySelector('.remote-host-refresh-btn');
    assert.ok(refreshBtn, 'a remote project header must carry a reconnect action');

    const clickPromise = refreshBtn.onclick({ stopPropagation: () => {} });

    assert.deepEqual(calls, ['planificator'], 'the action must target the project host alias only');
    const dot = header.querySelector('.remote-host-dot');
    assert.ok(dot.classList.contains('remote-host-connecting'),
      'the dot must flip to connecting immediately, before ssh returns');

    resolveRefresh({ ok: true });
    await clickPromise;

    assert.equal(loadCount, 1, 'a fresh get-projects re-render is requested once the refresh settles');
  } finally { ctx.destroy(); }
});

test('the reconnect action never bubbles into the header collapse toggle', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.api.remoteHostRefresh = () => new Promise(() => {}); // never resolves in this test
    ctx.sidebar.renderProjects([remoteProject()], true);

    const fId = ctx.sidebar.folderId('/srv/supervision');
    const header = ctx.document.getElementById('ph-' + fId);
    const refreshBtn = header.querySelector('.remote-host-refresh-btn');

    let stopped = false;
    refreshBtn.onclick({ stopPropagation: () => { stopped = true; } });

    assert.equal(stopped, true, 'the click must stop propagation before reaching the header toggle');
    assert.equal(header.classList.contains('collapsed'), false, 'the reconnect action must not collapse the group');
  } finally { ctx.destroy(); }
});

test('a local project group carries no remote host refresh action', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);
    const fId = ctx.sidebar.folderId('/home/dev/myproj');
    const header = ctx.document.getElementById('ph-' + fId);
    assert.equal(header.querySelector('.remote-host-refresh-btn'), null);
  } finally { ctx.destroy(); }
});
