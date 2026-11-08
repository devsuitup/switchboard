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
  t.after(() => { dom.window.setSchedulesVisible(false); dom.window.close(); });
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
  w.setSchedulesVisible(true);
  return { dom, w, project, schedule, data, calls, get button() { return w.document.querySelector('.schedule-run-btn'); }, titles, opened };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('visible successful launch retains its acknowledgement after the action reload', async t => {
  const h = setup(t);
  h.w.setSchedulesVisible(true);
  await settle();
  h.w.document.querySelector('.schedule-run-btn').click();
  await settle();
  assert.equal(h.w.document.querySelector('.schedule-run-btn').title, 'Launched!', 'visible success survives action reload');
});

test('visible Run now stays in flight across refreshes and shows launch success until its timer expires', async t => {
  let finish;
  const h = setup(t, () => new Promise(resolve => { finish = resolve; }));
  h.w.setSchedulesVisible(true);
  await settle();
  const button = () => h.w.document.querySelector('.schedule-run-btn');
  button().click();
  await h.w.loadSchedules();
  assert.equal(button().disabled, true, 'visible in-flight launch cannot be clicked again');
  assert.equal(button().title, 'Running...');
  assert.equal(button().classList.contains('running'), true);
  button().click();
  assert.equal(h.calls.length, 1);
  finish({ ok: true });
  await settle();
  assert.equal(button().title, 'Launched!', 'visible row retains launch acknowledgement after action reload');
  assert.equal(button().textContent, '\u2713');
  assert.equal(button().disabled, false);
  await h.w.loadSchedules();
  assert.equal(button().classList.contains('done'), true);
  await new Promise(resolve => h.w.setTimeout(resolve, 2100));
  assert.equal(button().title, 'Run now');
  assert.equal(button().classList.contains('done'), false);
});

for (const [label, result] of [['refusal', { ok: false, error: 'refused' }], ['missing reply', undefined]]) {
  test(`visible Run now ${label} restores the current row and leaves the notice`, async t => {
    let finish;
    const h = setup(t, () => new Promise(resolve => { finish = resolve; }));
    h.w.setSchedulesVisible(true);
    await settle();
    h.w.document.querySelector('.schedule-run-btn').click();
    await h.w.loadSchedules();
    assert.equal(h.w.document.querySelector('.schedule-run-btn').disabled, true, 'pending state survives refresh');
    finish(result);
    await settle();
    const button = h.w.document.querySelector('.schedule-run-btn');
    assert.equal(button.disabled, false);
    assert.equal(button.title, 'Run now');
    assert.equal(button.classList.contains('running'), false);
    assert.equal(button.classList.contains('done'), false);
    assert.equal(h.w.document.querySelector('[role="alert"]').dataset.noticeId, 'RunSchedule:/p/schedule-nightly.md');
  });
}

test('visible history stays open across a refresh', async t => {
  const h = setup(t);
  h.w.setSchedulesVisible(true);
  await settle();
  h.w.document.querySelector('details').open = true;
  await h.w.loadSchedules();
  assert.equal(h.w.document.querySelector('details').open, true, 'open history survives refresh');
});

test('a visible pending toggle recovers its current button even if the following reload fails', async t => {
  const h = setup(t);
  await settle();
  let finish;
  h.w.api.setScheduleEnabled = () => new Promise(resolve => { finish = resolve; });
  h.w.document.querySelector('.schedule-toggle-btn').click();
  await h.w.loadSchedules();
  assert.equal(h.w.document.querySelector('.schedule-toggle-btn').disabled, true, 'pending toggle survives refresh');
  h.w.api.listSchedules = async () => { throw new Error('offline'); };
  finish({ ok: true });
  await settle();
  assert.equal(h.w.document.querySelector('.schedule-toggle-btn').disabled, false, 'settled toggle restores the visible control despite reload failure');
});

test('visible focused row controls keep focus across refreshes', async t => {
  const h = setup(t);
  h.schedule.runs = [{ sessionId: 'focused', created: '2026-11-08T12:00Z', replied: true, result: null }];
  h.w.setSchedulesVisible(true);
  await settle();
  for (const selector of ['.schedule-run-btn', '.schedule-toggle-btn', '.schedule-open-btn', 'summary', '.schedule-history-run', 'details button:last-child']) {
    h.w.document.querySelector('details').open = true;
    h.w.document.querySelector(selector).focus();
    await h.w.loadSchedules();
    assert.equal(h.w.document.activeElement, h.w.document.querySelector(selector), `${selector} keeps focus`);
  }
});

test('projects-changed bursts coalesce into one visible schedule reload', async t => {
  const h = setup(t);
  h.w.setSchedulesVisible(false);
  const timers = new Map();
  let timerId = 0;
  h.w.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  h.w.clearTimeout = id => timers.delete(id);
  h.w.setSchedulesVisible(true);
  await settle();
  let calls = 0;
  h.w.api.listSchedules = async () => { calls++; return h.data; };
  const filename = path.join(__dirname, '../public/app.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('let projectsChangedTimer =');
  const end = source.indexOf('\n});', start) + '\n});'.length;
  const changed = connectProjectsChanged(h.w);
  vm.runInContext(source.slice(start, end), h.dom.getInternalVMContext(), { filename,
    lineOffset: source.slice(0, start).split('\n').length - 1 });
  for (let i = 0; i < 8; i++) changed({ cause: ['archive'] });
  await settle();
  assert.equal(calls, 0, 'burst waits for the debounce window');
  const pending = [...timers.values()].filter(timer => timer.delay === 900);
  assert.equal(pending.length, 1, 'one pending debounce timer');
  pending[0].callback();
  await settle();
  assert.equal(calls, 1, 'one list-schedules request per burst');
});

for (const outcome of ['success', 'failure']) {
  test(`pending Run now focus uses its row during refresh and returns after ${outcome}`, async t => {
    let finish;
    const h = setup(t, () => new Promise(resolve => { finish = resolve; }));
    await settle();
    h.button.focus();
    h.button.click();
    await h.w.loadSchedules();
    assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-item'), 'disabled focused control falls back to its row');
    await h.w.loadSchedules();
    finish(outcome === 'success' ? { ok: true } : { ok: false, error: 'refused' });
    await settle();
    assert.equal(h.w.document.activeElement, h.button, 'settled launch restores the pending focus target');
  });
}

test('pending Run now focus yields to a different focused control', async t => {
  let finish;
  const h = setup(t, () => new Promise(resolve => { finish = resolve; }));
  await settle();
  h.button.focus();
  h.button.click();
  await h.w.loadSchedules();
  assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-item'), 'pending launch focuses its row');
  h.w.document.querySelector('.schedule-open-btn').focus();
  finish({ ok: true });
  await settle();
  assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-open-btn'), 'completion does not steal a newer focus choice');
});

function connectProjectsChanged(w) {
  let bridge;
  const listeners = new Map();
  const preload = path.join(__dirname, '../preload.js');
  vm.runInNewContext(fs.readFileSync(preload, 'utf8'), {
    process: { platform: process.platform, argv: [] },
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
        ipcRenderer: { invoke() {}, on: (channel, handler) => listeners.set(channel, handler), send() {}, removeListener() {} } };
    },
  }, { filename: preload });
  w.api.onProjectsChanged = bridge.onProjectsChanged;
  return payload => listeners.get('projects-changed')({}, payload);
}

function projectsChangedHarness(t) {
  const h = setup(t);
  h.w.setSchedulesVisible(false);
  let now = 0;
  let id = 0;
  const timers = new Map();
  h.w.Date.now = () => now;
  h.w.setTimeout = (callback, delay) => { timers.set(++id, { callback, due: now + delay }); return id; };
  h.w.clearTimeout = key => timers.delete(key);
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = next[1].due;
      timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    now = end;
  };
  const filename = path.join(__dirname, '../public/app.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('let projectsChangedTimer =');
  const end = source.indexOf('\n});', start) + '\n});'.length;
  const changed = connectProjectsChanged(h.w);
  vm.runInContext(source.slice(start, end), h.dom.getInternalVMContext(), { filename,
    lineOffset: source.slice(0, start).split('\n').length - 1 });
  h.w.setSchedulesVisible(true);
  return { ...h, changed, advance };
}

test('scan and unrelated projects-changed causes do not rebuild schedules even at the main throttle cadence', async t => {
  const h = projectsChangedHarness(t);
  await settle();
  let calls = 0;
  h.w.api.listSchedules = async () => { calls++; return h.data; };
  for (const cause of ['scan', 'activity', 'entrypoint-backfill', 'title-backfill', 'sdk-reveal', 'bridge-repair', 'remote', 'bg-jobs']) {
    h.changed({ cause: [cause] });
    await h.advance(1500);
  }
  h.changed();
  h.changed({ cause: ['unknown-future-cause'] });
  await h.advance(4000);
  assert.equal(calls, 0, 'scan and unrelated events never request list-schedules');
  for (const cause of ['archive', 'project-added', 'project-deleted', 'project-remap', 'worktree-deleted', 'watcher', 'session-exit', 'session-attach', 'cli-status']) {
    const before = calls;
    h.changed({ cause: ['scan', cause] });
    await h.advance(900);
    assert.equal(calls, before + 1, `${cause} can refresh schedules in a mixed payload`);
  }
});

test('continuous relevant projects-changed burst refreshes within the maximum wait', async t => {
  const h = projectsChangedHarness(t);
  await settle();
  let calls = 0;
  h.w.api.listSchedules = async () => { calls++; return h.data; };
  for (let i = 0; i < 7; i++) {
    h.changed({ cause: ['archive'] });
    await h.advance(600);
  }
  assert.ok(calls >= 1, 'a continuous burst refreshes within 3000 ms');
  assert.ok(calls <= 2, 'burst remains coalesced');
  await h.advance(900);
  assert.equal(calls, 2, 'the trailing burst gets one final refresh');
  h.changed({ cause: ['archive'] });
  h.w.setSchedulesVisible(false);
  await h.advance(4000);
  assert.equal(calls, 2, 'hiding clears both debounce and maximum-wait timers');
});

test('hiding schedules clears a pending project focus request before reopening', async t => {
  const h = setup(t);
  await settle();
  let finish;
  h.w.api.listSchedules = () => new Promise(resolve => { finish = resolve; });
  h.w.showSchedules(h.project.projectPath);
  h.w.setSchedulesVisible(false);
  finish(h.data);
  await settle();
  h.w.api.listSchedules = async () => h.data;
  h.w.setSchedulesVisible(true);
  await settle();
  assert.equal(h.w.document.activeElement, h.w.document.body, 'a hidden tab drops its project focus request');
});

test('a toggle completed while schedules are hidden does not reload until reopening', async t => {
  const h = setup(t);
  await settle();
  let finish;
  h.w.api.setScheduleEnabled = () => new Promise(resolve => { finish = resolve; });
  h.w.document.querySelector('.schedule-toggle-btn').click();
  h.w.setSchedulesVisible(false);
  let calls = 0;
  h.w.api.listSchedules = async () => { calls++; return h.data; };
  finish({ ok: true });
  await settle();
  assert.equal(calls, 0, 'a hidden toggle completion does not reload schedules');
  h.w.setSchedulesVisible(true);
  await settle();
  assert.equal(calls, 1, 'reopening requests fresh schedule state');
});

test('next-run wording uses minutes, today, tomorrow, weekday and date', t => {
  const h = setup(t);
  const now = new Date(2026, 10, 8, 8, 0).getTime();
  for (const [date, expected] of [
    [new Date(2026, 10, 8, 8, 12), /\(in 12 min\)$/],
    [new Date(2026, 10, 8, 9, 0), /\(today 9:00\)$/],
    [new Date(2026, 10, 8, 23, 0), /\(today 23:00\)$/],
    [new Date(2026, 10, 9, 9, 0), /\(tomorrow 9:00\)$/],
    [new Date(2026, 10, 13, 9, 0), /\(Friday 9:00\)$/],
    [new Date(2026, 11, 1, 9, 0), /\(Dec 1, 2026 9:00\)$/],
  ]) assert.match(h.w.scheduleTime(date.getTime(), now), expected);
  h.schedule.cron = '0 9 * * 5';
  h.schedule.cronText = 'weekly on Friday at 9:00';
  h.schedule.nextRunMs = new Date(2026, 10, 13, 9, 0).getTime();
  h.data.now = now;
  h.w.renderSchedules(h.data);
  assert.match(h.w.document.querySelector('.schedule-state').textContent, /Friday 9:00/);
});

test('unknown project refusal is visible in row text', t => {
  const h = setup(t);
  h.project.known = false;
  h.w.renderSchedules(h.data);
  assert.match(h.w.document.querySelector('.schedule-item').textContent, /not a known project/);
});

test('an unmatched project focus request is cleared after rendering', async t => {
  const h = setup(t);
  h.w.showSchedules('/missing');
  h.w.renderSchedules(h.data);
  h.project.projectPath = '/missing';
  h.w.renderSchedules(h.data);
  assert.equal(h.w.document.activeElement, h.w.document.body, 'a stale unmatched request cannot steal focus later');
  await settle();
});

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
  assert.match(h.w.document.querySelector('.schedule-item').textContent, /front matter not read: save with LF line endings/);
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
