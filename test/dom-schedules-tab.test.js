'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions, extractFunction } = require('./app-source');

function setup(t, run = () => ({ ok: true })) {
  const dom = new JSDOM('<body><div id="app-notices"></div><div id="schedules-content"></div></body>', { runScripts: 'outside-only', url: 'http://localhost' });
  t.after(() => dom.window.close());
  const ctx = dom.getInternalVMContext();
  const calls = [];
  const project = { projectPath: '/p', shortName: 'p', known: true, archived: false, schedules: [] };
  const schedule = { file: 'schedule-nightly.md', filePath: '/p/schedule-nightly.md', name: 'Nightly', slug: 'nightly', cron: '* * * * *', cronText: 'every min', enabled: true, linked: false, problems: [], nextRunMs: Date.now() + 60000, catchUp: false, runs: [] };
  project.schedules.push(schedule);
  const data = { now: Date.now(), catchUpActive: true, projects: [project] };
  const w = dom.window;
  w.api = { runScheduleNow: async filePath => { calls.push(filePath); return run(); }, listSchedules: async () => data,
    setScheduleEnabled: async () => ({ ok: true }), readMemory: async () => '' };
  w.activeTab = 'schedules';
  w.formatDate = () => 'today';
  w.ICONS = { schedule: () => '<svg></svg>' };
  const opened = [];
  w.CSS = { escape: value => value };
  for (const name of ['memoryContent', 'memoryViewer', 'placeholder', 'terminalArea', 'statsViewer', 'settingsViewer', 'workFilesViewer', 'jsonlViewer']) w[name] = w.document.createElement('div');
  w.memoryPanel = { open: (...args) => opened.push(args) };
  w.openSession = session => calls.push(session);
  w.loadProjects = async () => { w.cachedAllProjects = [{ projectPath: project.projectPath, sessions: schedule.runs }]; };
  const activityFilename = path.join(__dirname, '../public/session-activity-dom.js');
  const activitySource = fs.readFileSync(activityFilename, 'utf8');
  vm.runInContext(extractFunction(activitySource, 'rowSessionIds'), ctx, { filename: activityFilename,
    lineOffset: activitySource.slice(0, activitySource.indexOf('function rowSessionIds')).split('\n').length - 1 });
  loadAppFunctions(ctx, { functions: ['getExpandedSlugs', 'showScheduleSessions', 'openScheduleRun'], installSpies: false });
  for (const name of ['app-notices.js', 'memory-workfiles-view.js', 'schedules-view.js']) {
    const filename = path.join(__dirname, '../public', name);
    assert.ok(fs.existsSync(filename), 'the Schedules renderer exists');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  w.renderSchedules(data);
  const button = w.document.querySelector('.schedule-run-btn');
  const titles = [];
  new w.MutationObserver(records => titles.push(...records.map(record => record.oldValue), button.title))
    .observe(button, { attributes: true, attributeFilter: ['title'], attributeOldValue: true });
  return { dom, w, project, schedule, data, calls, button, titles, opened };
}

for (const [label, run, reason] of [
  ['backend refusal', () => ({ ok: false, error: 'boom' }), 'boom'],
  ['rejected IPC', () => { throw new Error('offline'); }, 'offline'],
  ['missing result', () => undefined, 'no result'],
]) {
  test(`Run now ${label} leaves a persistent error and restores its button`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup(t, run);
    const icon = h.button.innerHTML;
    h.button.click();
    await new Promise(resolve => setImmediate(resolve));
    const alert = h.w.document.querySelector('[role="alert"]');
    assert.ok(alert, 'a failed launch must leave a visible notice');
    assert.ok(alert.textContent.includes(reason));
    assert.match(alert.textContent, /schedule-nightly\.md/);
    assert.match(alert.textContent, /try Run now again/i);
    assert.equal(alert.dataset.noticeId, 'RunSchedule:/p/schedule-nightly.md');
    assert.equal(h.button.title, 'Run now');
    assert.ok(!h.titles.includes('Launched!'));
    assert.equal(h.button.innerHTML, icon);
    assert.equal(h.button.classList.contains('running'), false);
    assert.equal(h.button.classList.contains('done'), false);
    assert.deepEqual(h.calls, ['/p/schedule-nightly.md']);
    t.mock.timers.tick(20_000);
    assert.ok(alert.isConnected);
  });
}

test('Run now reports success only after ok and clears the error for that file', async t => {
  let ok = false;
  const h = setup(t, () => ({ ok, error: 'boom' }));
  h.button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.w.document.querySelector('[role="alert"]'));
  ok = true;
  h.button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.button.title, 'Launched!');
  assert.equal(h.button.classList.contains('done'), true);
  assert.equal(h.w.document.querySelector('[role="alert"]'), null);
});

test('schedule states, history and missing outcomes are shown without inventing success', async t => {
  const h = setup(t);
  const text = () => h.w.document.getElementById('schedules-content').textContent;
  assert.match(text(), /No recorded run/);
  assert.match(text(), /Next run:.*in 1 min/);
  for (const [change, expected] of [
    [{ enabled: false }, /Disabled/],
    [{ enabled: true, problems: ['no cron'] }, /Never runs: no cron/],
    [{ problems: [], nextRunMs: null }, /No run within a year/],
  ]) { Object.assign(h.schedule, change); h.w.renderSchedules(h.data); assert.match(text(), expected); }
  h.project.archived = true;
  h.w.renderSchedules(h.data);
  assert.match(text(), /Suspended — project archived/);
  h.project.archived = false;
  h.schedule.problems = ['slug shared with schedule-other.md'];
  h.schedule.runs = [
    { sessionId: 'reply', created: '2026-11-08T12:00Z', running: false, replied: true, messageCount: 2, result: null },
    { sessionId: 'seed', created: '2026-11-08T11:00Z', running: false, replied: false, messageCount: 1, result: null },
    { sessionId: 'start', created: '2026-11-08T10:00Z', running: false, replied: false, messageCount: 2, result: null },
    { sessionId: 'live', created: '2026-11-08T09:00Z', running: true, replied: false, result: null },
  ];
  h.w.renderSchedules(h.data);
  assert.match(text(), /slug shared/);
  assert.match(text(), /No result recorded/);
  assert.match(text(), /replied; exit code unknown/);
  assert.match(text(), /refused or not started/);
  assert.match(text(), /started; no reply recorded/);
  assert.match(text(), /Running/);
  assert.doesNotMatch(text(), /Exit 0/);
  h.w.document.querySelector('.schedule-history-run').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[0].sessionId, 'reply');
});

test('unknown projects and unread front matter disable their guarded actions', t => {
  const h = setup(t);
  h.project.known = false;
  h.w.renderSchedules(h.data);
  for (const cls of ['.schedule-run-btn', '.schedule-open-btn']) assert.equal(h.w.document.querySelector(cls).disabled, true, cls);
  h.project.known = true;
  h.schedule.problems = ['front matter not read: save with LF line endings'];
  h.w.renderSchedules(h.data);
  for (const cls of ['.schedule-run-btn', '.schedule-toggle-btn']) assert.equal(h.w.document.querySelector(cls).disabled, true, cls);
  h.schedule.problems = [];
  h.schedule.linked = true;
  h.w.renderSchedules(h.data);
  assert.equal(h.w.document.querySelector('.schedule-toggle-btn').disabled, true);
  assert.equal(h.w.document.querySelector('.schedule-open-btn').disabled, false);
});

test('Open refuses an empty read without opening an editor; toggle refreshes the list', async t => {
  const h = setup(t);
  h.w.document.querySelector('.schedule-open-btn').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.w.document.querySelector('[role="alert"]').textContent, /Could not open/);
  const content = '---\ncron: * * * * *\n---\nPrompt';
  h.w.workFilesViewer.style.display = 'flex';
  h.w.jsonlViewer.style.display = 'flex';
  h.w.api.readMemory = async () => content;
  h.w.document.querySelector('.schedule-open-btn').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.opened, [['schedule-nightly.md', '/p/schedule-nightly.md', content]]);
  assert.equal(h.w.memoryViewer.style.display, 'flex');
  assert.equal(h.w.workFilesViewer.style.display, 'none', 'Open gives the memory editor the main viewer');
  assert.equal(h.w.jsonlViewer.style.display, 'none');
  assert.equal(h.w.document.querySelector('[role="alert"]'), null);
  let toggled;
  h.w.api.setScheduleEnabled = async (...args) => { toggled = args; return { ok: true }; };
  h.w.document.querySelector('.schedule-toggle-btn').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(toggled, ['/p/schedule-nightly.md', false]);
});

test('history follows its local run when registry and transcript project paths differ', async t => {
  const h = setup(t);
  h.project.projectPath = '/alias';
  h.schedule.filePath = '/alias/.claude/commands/schedule-nightly.md';
  const local = { sessionId: 'reply', projectPath: '/real', scheduleSlug: 'nightly' };
  h.schedule.runs = [{ sessionId: 'reply', created: '2026-11-08T12:00Z', replied: true, result: null }];
  h.w.loadProjects = async () => {
    h.w.cachedAllProjects = [
      { projectPath: '/real', remoteAlias: 'vps', sessions: [{ ...local, remoteAlias: 'vps' }] },
      { projectPath: '/real', sessions: [local] },
    ];
  };
  h.w.renderSchedules(h.data);
  const parent = h.w.document.createElement('section');
  parent.className = 'project-group collapsed';
  const group = h.w.document.createElement('div');
  group.className = 'slug-group collapsed';
  group.id = 'schedule-' + encodeURIComponent(JSON.stringify(['', '/real', 'nightly']));
  parent.appendChild(group);
  h.w.document.body.appendChild(parent);
  [...h.w.document.querySelectorAll('#schedules-content button')].find(b => b.textContent === 'Show history in Sessions').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(group.classList.contains('collapsed'), false, 'history expands the transcript project group, including a resolved registry alias');
  assert.equal(parent.classList.contains('collapsed'), false);
  assert.ok(JSON.parse(h.w.sessionStorage.getItem('expandedSlugs')).includes(group.id));
  h.w.document.querySelector('.schedule-history-run').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[0], local, 'local history never opens a remote copy of the same session id');
});

test('history opens a continuation member through its merged local row', async t => {
  const h = setup(t);
  h.project.projectPath = '/alias';
  const merged = { sessionId: 'root', headSessionId: 'head', mergedMemberIds: ['head', 'other'],
    projectPath: '/real', scheduleSlug: 'nightly' };
  h.schedule.runs = [{ sessionId: 'head', created: '2026-11-08T12:00Z', messageCount: 2, replied: true, running: false, result: null }];
  h.w.loadProjects = async () => { h.w.cachedAllProjects = [{ projectPath: '/real', sessions: [merged] }]; };
  h.w.renderSchedules(h.data);
  const parent = h.w.document.createElement('section');
  parent.className = 'project-group collapsed';
  const group = h.w.document.createElement('div');
  group.className = 'slug-group collapsed';
  group.id = 'schedule-' + encodeURIComponent(JSON.stringify(['', '/real', 'nightly']));
  parent.appendChild(group);
  h.w.document.body.appendChild(parent);
  [...h.w.document.querySelectorAll('#schedules-content button')].find(b => b.textContent === 'Show history in Sessions').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(group.classList.contains('collapsed'), false, 'a physical run member expands its merged row project');
  h.w.document.querySelector('.schedule-history-run').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls[0], merged, 'openSession receives the full row and its merged membership for the existing resume guards');
  assert.equal(h.w.document.querySelector('[role="alert"]'), null);
});
