const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

function ticker(ctx) {
  let tick;
  ctx.w.setInterval = (fn, ms) => { assert.equal(ms, 30000); tick = fn; };
  const filename = path.join(__dirname, '../public/app.js');
  const src = fs.readFileSync(filename, 'utf8');
  const start = src.indexOf('// Refresh sidebar timeago labels every 30s');
  const end = src.indexOf('// Shared session map', start);
  vm.runInContext(src.slice(start, end), ctx.context, { filename });
  return () => tick();
}

function olderProject(ctx, extra = {}) {
  ctx.w.visibleSessionCount = 1;
  const project = ctx.projects[0];
  project.sessions = [
    { sessionId: 'recent', modified: '2026-10-29T11:00:00Z' },
    { sessionId: 'older', modified: '2026-01-01T00:00:00Z', ...extra },
  ];
  ctx.w.sessionMap.clear();
  for (const session of project.sessions) ctx.w.sessionMap.set(session.sessionId, session);
  return () => ctx.document.querySelector('.sessions-older-archive-btn');
}

for (const boundary of ['rebindSidebarEvents', 'refreshGridCardMembers']) {
  test(`ticker retains the new host payload when ${boundary} throws after morphdom`, t => {
    const ctx = setup(t);
    const now = ctx.w.Date.now();
    const old = makeSampleProject({ remoteAlias: 'vps', sessions: [], remoteHostAt: now - 1000 });
    ctx.w.renderProjects([old], true);
    const next = { ...old, remoteHostError: 'new timeout', remoteHostAt: now - 5000 };
    ctx.w[boundary] = () => { throw new Error('late render failure'); };
    assert.throws(() => ctx.w.renderProjects([next], true), /late render failure/);
    const dot = ctx.document.querySelector('.remote-host-dot');
    assert.match(dot.title, /host unreachable: new timeout/);
    ctx.w.Date.now = () => now + 30000;
    ticker(ctx)();
    assert.match(dot.title, /^host unreachable: new timeout \(last confirmed 35s ago\)/,
      'ticker must use the payload already committed to the DOM');
    assert.equal(ctx.w.renderProjects.unchanged([next]), false, 'failed render does not commit the skip key');
  });
}

test('ticker keeps each host title when remote projects share a path', t => {
  const ctx = setup(t);
  let now = ctx.w.Date.now();
  ctx.w.Date.now = () => now;
  Object.assign(ctx.projects[0], { remoteAlias: 'healthy', remoteHostAt: now - 1000 });
  ctx.projects.push(makeSampleProject({ projectPath: ctx.projects[0].projectPath, sessions: [],
    remoteAlias: 'offline', remoteHostAt: now - 5000, remoteHostError: 'timeout' }));
  ctx.refresh();
  const dots = [...ctx.document.querySelectorAll('.remote-host-dot')];
  now += 30000;
  ticker(ctx)();
  assert.match(dots[0].title, /^no live session \(confirmed 31s ago\)/);
  assert.match(dots[1].title, /^host unreachable: timeout \(last confirmed 35s ago\)/);
});

test('same-path remote headers reconnect their own host after morphdom refresh', async t => {
  const ctx = setup(t);
  ctx.w.cachedProjects = ctx.w.cachedAllProjects = ['host-a', 'host-b'].map(remoteAlias =>
    makeSampleProject({ remoteAlias, sessions: [], remoteHostAt: ctx.w.Date.now() }));
  const calls = [];
  ctx.w.api.remoteHostRefresh = async alias => { calls.push(alias); };
  ctx.refresh();
  const headers = [...ctx.document.querySelectorAll('.project-header')];
  headers[1].classList.add('collapsed');
  ctx.refresh({ resort: true });
  const next = [...ctx.document.querySelectorAll('.project-header')];
  assert.equal(next[0], headers[0]);
  assert.equal(next[1], headers[1]);
  for (const header of next) {
    assert.equal(typeof header.querySelector('.remote-host-refresh-btn').onclick, 'function',
      'each host has its own reconnect handler');
    await header.querySelector('.remote-host-refresh-btn').onclick({ stopPropagation() {} });
  }
  assert.deepEqual(calls, ['host-a', 'host-b']);
  assert.equal(next[0].classList.contains('collapsed'), false);
  assert.equal(next[1].classList.contains('collapsed'), true);
  const ids = [...ctx.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, 'morphdom keys are unique across hosts');
});

test('search ticker retains narrowed live count without DOM mutations', t => {
  const ctx = setup(t);
  const project = ctx.projects[0];
  Object.assign(project, { remoteAlias: 'vps', remoteHostAt: ctx.w.Date.now(), sessions:
    Array.from({ length: 5 }, (_, i) => ({ sessionId: 'live-' + i, status: 'idle', remoteAlias: 'vps' })) });
  ctx.w.cachedAllProjects = [project];
  ctx.w.searchMatchIds = new Set(['live-0']);
  ctx.refresh();
  const dot = ctx.document.querySelector('.remote-host-dot');
  assert.match(dot.title, /^1 live session /);
  const observer = new ctx.w.MutationObserver(() => {});
  observer.observe(ctx.w.sidebarContent, { subtree: true, childList: true, attributes: true, characterData: true });
  t.after(() => observer.disconnect());
  const tick = ticker(ctx);
  tick();
  tick();
  assert.equal(observer.takeRecords().length, 0, 'search titles must not oscillate on ticks');
  assert.match(dot.title, /^1 live session /);
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('Show archived ticker refreshes a remote project absent from default projects', t => {
  const ctx = setup(t);
  let now = ctx.w.Date.now();
  ctx.w.Date.now = () => now;
  ctx.w.cachedProjects = [];
  ctx.w.cachedAllProjects = [makeSampleProject({ remoteAlias: 'archive-host', sessions: [], remoteHostAt: now - 1000 })];
  ctx.w.showArchived = true;
  ctx.refresh();
  now += 30000;
  ticker(ctx)();
  assert.match(ctx.document.querySelector('.remote-host-dot').title, /confirmed 31s ago/);
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('older archive becomes eligible immediately after a closed tab is evicted', t => {
  const ctx = setup(t);
  const button = olderProject(ctx);
  ctx.w.openSessions.set('older', { closed: true });
  ctx.refresh();
  assert.equal(button().disabled, true);
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
  ctx.w.openSessions.delete('older');
  ctx.refresh();
  assert.equal(button().disabled, false, 'eviction enables Archive without waiting for a clock bucket');
  assert.deepEqual(ctx.counts(), [2, 2]);
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [2, 2]);
  ctx.w.openSessions.set('older', { closed: false });
  ctx.refresh();
  assert.equal(button().disabled, true, 'opening a tab protects the older row again');
  assert.deepEqual(ctx.counts(), [3, 3]);
});

test('changing only the closed flag of an open tab invalidates the skip key', t => {
  const ctx = setup(t);
  ctx.w.openSessions.set('s-top-1', { closed: false });
  ctx.refresh();
  ctx.w.openSessions.get('s-top-1').closed = true;
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [2, 2]);
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [2, 2]);
});

test('remote member liveness can change older archive eligibility with an identical row projection', t => {
  const ctx = setup(t);
  const button = olderProject(ctx, { remoteAlias: 'vps', headSessionId: 'head', mergedMemberIds: ['head'] });
  const state = ctx.w.createSessionState('remote-ssh');
  state.apply({ type: 'attached', value: true });
  state.apply({ type: 'liveness', value: 'alive' });
  ctx.remoteSessionStates.set('head', state);
  ctx.refresh();
  assert.equal(button().disabled, true);
  const row = ctx.projects[0].sessions[1];
  const projection = JSON.stringify(ctx.w.mergedRowSnapshot(ctx.w.rowSessionIds(row), row.sessionId,
    ctx.w.storedActivitySnapshot(row.sessionId, row), row));
  state.apply({ type: 'liveness', value: 'dead' });
  assert.equal(ctx.w.isRemoteSessionAlive(row), false, 'row-level liveness stays false');
  assert.equal(JSON.stringify(ctx.w.mergedRowSnapshot(ctx.w.rowSessionIds(row), row.sessionId,
    ctx.w.storedActivitySnapshot(row.sessionId, row), row)), projection);
  ctx.refresh();
  assert.equal(button().disabled, false, 'dead member enables Archive even though the row projection did not change');
  assert.deepEqual(ctx.counts(), [2, 2]);
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [2, 2]);
});

test('mark unread renders, identical refresh skips, and mark read renders through the skip path', t => {
  const ctx = setup(t);
  ctx.refresh();
  const button = () => ctx.document.querySelector('#si-s-top-1 .session-unread-btn');
  button().click();
  ctx.refresh();
  assert.equal(button().getAttribute('aria-label'), 'Mark as read');
  assert.ok(ctx.document.querySelector('#si-s-top-1 .session-icon--response-ready'));
  assert.deepEqual(ctx.counts(), [2, 2]);
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [2, 2]);
  button().click();
  ctx.refresh();
  assert.equal(button().getAttribute('aria-label'), 'Mark as unread');
  assert.equal(ctx.document.querySelector('#si-s-top-1 .session-icon--response-ready'), null);
  assert.deepEqual(ctx.counts(), [3, 3]);
});

test('ticker leaves unchanged time labels untouched so an identical refresh can skip', t => {
  const ctx = setup(t);
  ctx.refresh();
  const time = ctx.document.querySelector('#si-s-top-1 .session-time');
  const text = time.firstChild;
  ticker(ctx)();
  assert.equal(time.firstChild, text, 'unchanged text does not replace the text node');
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('ticker still updates a changed time label and retains the message count', t => {
  const ctx = setup(t);
  ctx.refresh();
  const time = ctx.document.querySelector('#si-s-top-1 .session-time');
  const before = time.textContent;
  ctx.projects[0].sessions[0].modified = new Date(ctx.w.Date.now()).toISOString();
  ticker(ctx)();
  assert.notEqual(time.textContent, before);
  assert.equal(time.textContent, ctx.w.formatDate(new ctx.w.Date(ctx.projects[0].sessions[0].modified)) + ' · 12 msgs');
});

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
  'background agents': ctx => { ctx.w.bgAgentSessionIds.add('s-top-1'); },
  'parent active subagent': ctx => { ctx.w.taskRegistry.note('s-top-1', 'agent-871'); },
  'dormant membership': ctx => { ctx.w.dormantWorkingSet.set('s-top-1', {}); },
  'task registry running count': ctx => { ctx.w.taskRegistry.note('s-top-1', 'agent-871', 'cli-task'); },
  'detach availability': ctx => { ctx.w.openSessions.get('s-top-1').attach = true; },
  'archiving session ids': ctx => { ctx.read('archivingSessionIds').add('s-top-1'); },
  'archiving group ids': ctx => { ctx.read('archivingGroupIds').add('ph-' + ctx.w.folderId(ctx.projects[0].projectPath, ctx.projects[0].remoteAlias)); },
  'session age bucket': ctx => { const now = ctx.w.Date.now(); ctx.w.Date.now = () => now + 2000; },
  '30 second time bucket without ticker': ctx => { const now = ctx.w.Date.now(); ctx.w.Date.now = () => now + 30000; },
  'local day string': ctx => { ctx.w.Date.prototype.toDateString = () => 'Fri Oct 30 2026'; },
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

const prepareChanges = {
  'background agents': ctx => { ctx.w.bgAgentSessionIds = new Set(); },
  'parent active subagent': ctx => {
    ctx.w.reflectSubagentRunningState = () => {};
    ctx.w.taskRegistry.note('s-top-1', 'bash-871', 'local-ipc', { kind: 'bash' });
  },
  'dormant membership': ctx => {
    ctx.w.dormantWorkingSet = new Map();
    ctx.w.activePtyIds.add('s-top-1');
    ctx.w.openSessions.set('s-top-1', { closed: false });
  },
  'task registry running count': ctx => {
    ctx.w.taskRegistry = ctx.w.createTaskRegistry();
    ctx.w.taskRegistry.note('s-top-1', 'bash-871', 'cli-task', { kind: 'bash' });
  },
  'detach availability': ctx => {
    ctx.w.rowLifecycleLabel = () => null;
    ctx.w.activePtyIds.add('s-top-1');
    ctx.w.openSessions.set('s-top-1', { closed: false, attach: false });
  },
  'session age bucket': ctx => {
    ctx.projects[0].sessions[0].modified = new Date(ctx.w.Date.now() - ctx.w.sessionMaxAgeDays * 86400000 + 1000).toISOString();
  },
};

for (const [name, change] of Object.entries(changes)) {
  test(`identical payload rebuilds after changing ${name}`, t => {
    const ctx = setup(t);
    prepareChanges[name]?.(ctx);
    ctx.refresh();
    ctx.refresh();
    assert.deepEqual(ctx.counts(), [1, 1]);
    change(ctx);
    ctx.refresh();
    assert.deepEqual(ctx.counts(), [2, 2]);
    ctx.refresh();
    assert.deepEqual(ctx.counts(), [2, 2]);
  });
}

test('ticker updates each remote host confirmation age and retry countdown without rebuilding', t => {
  const ctx = setup(t);
  let now = ctx.w.Date.now();
  ctx.w.Date.now = () => now;
  Object.assign(ctx.projects[0], { remoteAlias: 'healthy', remoteHostAt: now - 1000 });
  ctx.projects.push(makeSampleProject({ projectPath: '/offline', sessions: [], remoteAlias: 'offline',
    remoteHostAt: now - 5000, remoteHostError: 'timeout', remoteHostNextAttemptAt: now + 60000,
    remoteHostProfile: { tier: 'poll', missing: [{ tier: 'watch', reason: 'inotifywait missing' }] } }));
  ctx.refresh();
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
  const dots = [...ctx.document.querySelectorAll('.remote-host-dot')];
  assert.equal(dots.length, 2);
  assert.match(dots[0].title, /confirmed 1s ago/);
  assert.match(dots[1].title, /last confirmed 5s ago.*next automatic attempt in 1m/);
  now += 30000;
  ticker(ctx)();
  assert.match(dots[0].title, /confirmed 31s ago/);
  assert.match(dots[1].title, /last confirmed 35s ago.*next automatic attempt in 30s/);
  assert.match(dots[1].title, /Capability: poll\nwatch unavailable: inotifywait missing/);
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('unchanged remote host ticker titles do not dirty the sidebar skip key', t => {
  const ctx = setup(t);
  Object.assign(ctx.projects[0], { remoteAlias: 'vps', remoteHostAt: ctx.w.Date.now() - 1000 });
  ctx.refresh();
  const tick = ticker(ctx);
  const observer = new ctx.w.MutationObserver(() => {});
  observer.observe(ctx.document.querySelector('.remote-host-dot'), { attributes: true });
  t.after(() => observer.disconnect());
  tick();
  assert.equal(observer.takeRecords().length, 0, 'an identical title must not be written again');
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

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
  let entries = [];
  let polls = 0;
  w.api.getActiveSessions = async () => { polls++; return entries; };
  w.scheduleActiveSessionsPoll = () => {};
  const { loadProjects } = loadAppFunctions(ctx.context, {
    functions: ['loadProjects', 'dedup', 'pollActiveSessions', 'updateRunningIndicators', 'updateTerminalHeader'],
    declarations: ['_lastPtySignature'],
  });
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
  entries = [{ sessionId: 's-top-1', busy: true }];
  await loadProjects();
  assert.equal(ctx.sessionBusyState.get('s-top-1'), true);
  assert.equal(ctx.document.querySelector('#si-s-top-1').classList.contains('has-running-pty'), true);
  const count = ctx.counts();
  await loadProjects();
  assert.deepEqual(ctx.counts(), count);
  assert.equal(polls, 7);
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

test('changed payload returns before reading activity overlays', t => {
  const ctx = setup(t);
  ctx.refresh();
  ctx.projects[0].sessions[0].name = 'Changed';
  let reads = 0;
  const snapshot = ctx.w.storedActivitySnapshot;
  ctx.w.storedActivitySnapshot = (...args) => { reads++; return snapshot(...args); };
  assert.equal(ctx.w.renderProjects.unchanged(ctx.projects), false);
  assert.equal(reads, 0);
});

test('activity timestamp and watermark writes with identical projection still skip', t => {
  const ctx = setup(t);
  let version = 1;
  const snapshot = ctx.w.storedActivitySnapshot;
  ctx.w.storedActivitySnapshot = (...args) => ({ ...snapshot(...args),
    lastActivityAt: version, writtenWatermark: version, idleHintAt: version, promptHintAt: version });
  ctx.refresh();
  version++;
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('unrelated local and session storage writes still skip', t => {
  const ctx = setup(t);
  ctx.refresh();
  ctx.w.localStorage.setItem('terminalFontSize', '18');
  ctx.w.sessionStorage.setItem('unrelated-panel', 'open');
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [1, 1]);
});

for (const key of ['expandedSubagentRest', 'orphanExpanded:/home/dev/myproj']) {
  test(`sidebar storage ${key} still invalidates`, t => {
    const ctx = setup(t);
    ctx.refresh();
    ctx.w.localStorage.setItem(key, '1');
    ctx.refresh();
    assert.deepEqual(ctx.counts(), [2, 2]);
  });
}

test('exit correction invalidates and repaints the lifecycle title and aria label', t => {
  const ctx = setup(t);
  ctx.refresh();
  const icon = () => ctx.document.querySelector('#si-s-top-1 .session-icon');
  assert.match(icon().title, /Liveness unknown/);
  ctx.w.noteSessionExit('s-top-1', 1, null, false, false);
  ctx.refresh();
  assert.match(icon().title, /Exited \(code 1\)/);
  assert.match(icon().getAttribute('aria-label'), /Exited \(code 1\)/);
  ctx.w.noteSessionExit('s-top-1', 1, null, true, false);
  ctx.refresh();
  assert.match(icon().title, /Stopped/);
  assert.match(icon().getAttribute('aria-label'), /Stopped/);
  assert.deepEqual(ctx.counts(), [3, 3]);
});

test('30-second ticker updates waiting ages without rebuilding or replacing background labels', t => {
  const ctx = setup(t);
  let now = ctx.w.Date.now();
  ctx.w.Date.now = () => now;
  Object.assign(ctx.projects[0].sessions[0], { status: 'waiting', waitingFor: 'approval', statusUpdatedAt: now - 1000 });
  ctx.refresh();
  const tick = ticker(ctx);
  const status = () => ctx.document.querySelector('#si-s-top-1 .session-status');
  assert.equal(status().textContent, 'approval · 1s ago');
  now += 30000;
  tick();
  assert.equal(status().textContent, 'approval · 31s ago');
  const label = { text: 'Working in background', title: 'Background' };
  ctx.w.backgroundActivityLabel = () => label;
  tick();
  assert.equal(status().textContent, label.text);
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('ticker retains the unavailable background label without an activity provider', t => {
  const ctx = setup(t);
  ctx.projects[0].sessions[0].bgJobId = 'job';
  ctx.w.backgroundActivityLabel = undefined;
  ctx.refresh();
  const status = ctx.document.querySelector('#si-s-top-1 .session-status');
  assert.equal(status.textContent, 'Activity unavailable');
  ticker(ctx)();
  assert.equal(status.textContent, 'Activity unavailable');
});

test('ticker ages the merged head descriptor even without a modified timestamp', t => {
  const ctx = setup(t);
  let now = ctx.w.Date.now();
  ctx.w.Date.now = () => now;
  const row = ctx.projects[0].sessions[0];
  Object.assign(row, { headSessionId: 'head', mergedMemberIds: ['head'],
    mergedMemberStatuses: { head: { status: 'waiting', waitingFor: 'head approval', statusUpdatedAt: now - 2000 } } });
  ctx.refresh();
  delete row.modified;
  now += 30000;
  ticker(ctx)();
  assert.equal(ctx.document.querySelector('#si-s-top-1 .session-status').textContent, 'head approval · 32s ago');
  assert.deepEqual(ctx.counts(), [1, 1]);
});

test('debug trace reports cumulative sidebar renders and skips', t => {
  const ctx = setup(t);
  const records = [];
  ctx.w.ATRACE = true;
  ctx.w.atrace = (category, sessionId, fields) => { if (category === 'sidebar.refresh') records.push(fields); };
  ctx.refresh();
  ctx.refresh();
  ctx.refresh();
  ctx.refresh({ resort: true });
  assert.deepEqual(records.map(r => [r.skipped, r.renders, r.skips]),
    [[false, 1, 0], [true, 1, 1], [true, 1, 2], [false, 2, 2]]);
  ctx.w.ATRACE = false;
  ctx.refresh();
  assert.equal(records.length, 4);
});


test('remote archive busy keys affect only their host and invalidate the skip key', t => {
  const ctx = setup(t);
  ctx.w.cachedProjects = ctx.w.cachedAllProjects = ['host-a', 'host-b'].map(remoteAlias =>
    makeSampleProject({ remoteAlias, sessions: [] }));
  ctx.refresh();
  const headers = [...ctx.document.querySelectorAll('.project-header')];
  ctx.read('archivingGroupIds').add(headers[1].id);
  ctx.refresh();
  const buttons = [...ctx.document.querySelectorAll('.project-archive-btn')];
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, true);
  assert.deepEqual(ctx.counts(), [2, 2]);
  ctx.refresh();
  assert.deepEqual(ctx.counts(), [2, 2]);
});

test('same-path nested worktrees bind their own host and preserve distinct morphdom keys', t => {
  const ctx = setup(t);
  const projects = ['host-a', 'host-b', null].flatMap(remoteAlias =>
    ['/repo', '/repo/.claude/worktrees/branch'].map(projectPath =>
      makeSampleProject({ projectPath, remoteAlias, sessions: [] })));
  ctx.w.cachedProjects = ctx.w.cachedAllProjects = projects;
  const calls = [];
  ctx.w.showNewSessionPopover = project => calls.push([project.remoteAlias, project.projectPath]);
  ctx.refresh();
  ctx.refresh({ resort: true });
  const headers = [...ctx.document.querySelectorAll('.worktree-header')];
  assert.equal(headers.length, 3);
  for (const header of headers) {
    assert.equal(typeof header.querySelector('.worktree-new-btn').onclick, 'function', 'each nested host has its own handler');
    header.querySelector('.worktree-new-btn').onclick({ stopPropagation() {} });
  }
  assert.deepEqual(calls, ['host-a', 'host-b', null].map(alias => [alias, '/repo/.claude/worktrees/branch']));
  const ids = [...ctx.document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
});
