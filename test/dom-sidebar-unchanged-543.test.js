const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const w = ctx.window;
  w.Date.now = () => Date.parse('2026-10-29T12:00:00Z');
  w.showArchived = false;
  w.searchInput = Object.assign(ctx.document.createElement('input'), { value: '' });
  w.pruneRemoteActivityTimers = () => {};
  w.pruneLocalTranscriptTimers = () => {};
  const { refreshSidebar } = loadAppFunctions(ctx.context, { functions: ['refreshSidebar'] });
  const projects = [makeSampleProject()];
  w.cachedProjects = projects;
  w.cachedAllProjects = projects;
  for (const session of projects[0].sessions) w.sessionMap.set(session.sessionId, session);
  let renders = 0;
  let morphs = 0;
  const render = w.renderProjects;
  const morph = w.morphdom;
  w.renderProjects = Object.assign((...args) => { renders++; return render(...args); }, render);
  w.morphdom = (...args) => { morphs++; return morph(...args); };
  const refresh = options => refreshSidebar({ skipUnchanged: true, ...options });
  return { ...ctx, w, projects, refresh, counts: () => [renders, morphs] };
}

test('identical cloned payload skips the sidebar build and morphdom', t => {
  const ctx = setup(t);
  ctx.refresh();
  ctx.w.cachedProjects = JSON.parse(JSON.stringify(ctx.projects));
  ctx.w.cachedAllProjects = ctx.w.cachedProjects;
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('a field changed in place rebuilds the sidebar', t => {
  const ctx = setup(t);
  ctx.refresh();
  ctx.projects[0].sessions[0].name = 'Changed name';
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [2, 2]);
  assert.equal(ctx.document.querySelector('#si-s-top-1 .session-summary').textContent, 'Changed name');
});

const changes = {
  'star filter': ctx => { ctx.w.showStarredOnly = true; },
  'running filter': ctx => { ctx.w.showRunningOnly = true; },
  'today filter': ctx => { ctx.w.showTodayOnly = true; },
  'archive setting': ctx => { ctx.w.showArchived = true; },
  'visible count': ctx => { ctx.w.visibleSessionCount = 1; },
  'max age': ctx => { ctx.w.sessionMaxAgeDays = 1; },
  'search input': ctx => { ctx.w.searchInput.value = 'abc'; },
  'search matches': ctx => { ctx.w.searchMatchIds = new Set(['s-top-1']); },
  'selection': ctx => { ctx.w.activeSessionId = 's-top-1'; },
  'pending session': ctx => { ctx.w.pendingSessions.set('s-top-1', {}); },
  'active PTY': ctx => { ctx.w.activePtyIds.add('s-top-1'); },
  'attention': ctx => { ctx.attentionSessions.add('s-sub-1'); },
  'response ready': ctx => { ctx.responseReadySessions.add('s-sub-1'); },
  'busy overlay': ctx => { ctx.sessionBusyState.set('s-sub-1', true); },
  'head turn': ctx => { ctx.emitHeadTurn('s-top-1', 'open'); },
  'unread output': ctx => { ctx.w.noteWrittenActivity('s-top-1'); },
  'expanded children': ctx => { ctx.w.localStorage.setItem('expandedSubagents', '["s-top-1"]'); },
  'expanded schedule groups': ctx => { ctx.w.getExpandedSlugs = () => new Set(['slug-test']); },
  'collapsed DOM group': ctx => { ctx.document.querySelector('.project-header').classList.add('collapsed'); },
  'hidden project metadata': ctx => { ctx.w.cachedAllProjects = [...ctx.projects, makeSampleProject({ projectPath: '/hidden' })]; },
};

for (const [name, change] of Object.entries(changes)) {
  test(`identical payload rebuilds after changing ${name}`, t => {
    const ctx = setup(t);
    ctx.refresh();
    change(ctx);
    ctx.refresh();
    assert.deepEqual(ctx.counts(), [2, 2]);
  });
}

test('remote host label changes rebuild with an identical payload', t => {
  const ctx = setup(t);
  ctx.projects[0].remoteAlias = 'vps';
  ctx.refresh();
  ctx.w.setRemoteHostLabels([{ alias: 'vps', label: 'Production' }]);
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [2, 2]);
  assert.match(ctx.document.querySelector('.project-name').textContent, /Production/);
});

test('explicit refresh and resort still rebuild identical data', t => {
  const ctx = setup(t);
  ctx.refresh();
  ctx.refresh({ skipUnchanged: false });
  ctx.refresh({ resort: true });
  assert.deepEqual(ctx.counts(), [3, 3]);
});

test('an empty payload can skip after the first completed render', t => {
  const ctx = setup(t);
  ctx.w.cachedProjects = ctx.w.cachedAllProjects = [];
  ctx.refresh();
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('identical payload skips even when preserved project order differs from payload order', t => {
  const ctx = setup(t);
  const other = makeSampleProject({ projectPath: '/other' });
  ctx.projects.push(other);
  ctx.w.sortedOrder = [{ projectPath: other.projectPath, itemIds: [] }, { projectPath: ctx.projects[0].projectPath, itemIds: [] }];
  ctx.refresh();
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('real loadProjects skips identical replies while committing changed fields and filters', async t => {
  const ctx = setup(t);
  const w = ctx.w;
  w.loadingStatus = ctx.document.createElement('div');
  for (const name of ['reportActivityFocus', 'reportActivityTitles', 'renderDefaultStatus']) w[name] = () => {};
  w.api.getProjects = async () => ({
    defaultProjects: JSON.parse(JSON.stringify(ctx.projects)),
    allProjects: JSON.parse(JSON.stringify(ctx.projects)),
  });
  const settings = {};
  w.api.getSetting = async () => settings;
  w.api.getActiveTerminals = async () => [];
  w.pollActiveSessions = async () => undefined;
  const { loadProjects } = loadAppFunctions(ctx.context, { functions: ['loadProjects', 'dedup'] });
  await loadProjects();
  await loadProjects();
  assert.deepEqual(ctx.counts(), [1, 1]);
  ctx.projects[0].sessions[0].name = 'From IPC';
  await loadProjects();
  assert.deepEqual(ctx.counts(), [2, 2]);
  assert.equal(ctx.document.querySelector('#si-s-top-1 .session-summary').textContent, 'From IPC');
  w.showRunningOnly = true;
  await loadProjects();
  assert.deepEqual(ctx.counts(), [3, 3]);
  assert.equal(w.loadProjects.state.committed, 4);
  settings.hiddenProjects = ['/hidden'];
  await loadProjects();
  assert.deepEqual(ctx.counts(), [4, 4]);
});

test('completed render stays skippable after mutation observer delivery', async t => {
  const ctx = setup(t);
  ctx.refresh();
  await new Promise(resolve => setImmediate(resolve));
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('failed render cannot leave an earlier key eligible for skipping', t => {
  const ctx = setup(t);
  ctx.refresh();
  const morph = ctx.w.morphdom;
  ctx.w.morphdom = () => { throw new Error('render failed'); };
  assert.throws(() => ctx.refresh({ skipUnchanged: false }), /render failed/);
  ctx.w.morphdom = morph;
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [3, 2]);
});
