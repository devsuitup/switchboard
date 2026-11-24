'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions, extractFunction } = require('./app-source');

function setup(t, run = () => ({ ok: true }), { render = true, api = {} } = {}) {
  const dom = new JSDOM('<body><div id="app-notices"></div><div id="schedules-content"></div></body>', { runScripts: 'outside-only', url: 'http://localhost' });
  t.after(() => { dom.window.setSchedulesVisible(false); dom.window.close(); });
  const ctx = dom.getInternalVMContext();
  const calls = [];
  const healthListeners = [];
  const project = { projectPath: '/p', shortName: 'p', known: true, archived: false, schedules: [] };
  const schedule = { file: 'schedule-nightly.md', filePath: '/p/schedule-nightly.md', name: 'Nightly', slug: 'nightly', cron: '* * * * *', cronText: 'every min', enabled: true, linked: false, problems: [], nextRunMs: Date.now() + 60000, catchUp: false, runs: [] };
  project.schedules.push(schedule);
  const data = { now: Date.now(), catchUpActive: true, projects: [project] };
  const w = dom.window;
  w.api = { runScheduleNow: async filePath => { calls.push(filePath); return run(); }, listSchedules: async () => data,
    setScheduleEnabled: async () => ({ ok: true }), readMemory: async () => '', onScheduleHealth: listener => { healthListeners.push(listener); }, ...api };
  w.activeTab = 'schedules';
  w.formatDate = () => 'today';
  w.ICONS = { schedule: () => '<svg></svg>' };
  const opened = [];
  w.CSS = { escape: value => value };
  for (const name of ['memoryContent', 'memoryViewer', 'placeholder', 'terminalArea', 'statsViewer', 'settingsViewer', 'jsonlViewer']) w[name] = w.document.createElement('div');
  w.memoryPanel = { open: (...args) => opened.push(args) };
  w.openSession = session => calls.push(session);
  w.loadProjects = async () => { w.cachedAllProjects = [{ projectPath: project.projectPath, sessions: schedule.runs }]; };
  const activityFilename = path.join(__dirname, '../public/session-activity-dom.js');
  const activitySource = fs.readFileSync(activityFilename, 'utf8');
  vm.runInContext(extractFunction(activitySource, 'rowSessionIds'), ctx, { filename: activityFilename,
    lineOffset: activitySource.slice(0, activitySource.indexOf('function rowSessionIds')).split('\n').length - 1 });
  loadAppFunctions(ctx, { functions: ['getExpandedSlugs', 'showScheduleSessions', 'openScheduleRun'], installSpies: false });
  for (const name of ['setting-defaults.js', 'app-notices.js', 'memory-workfiles-view.js', 'schedules-view.js']) {
    const filename = path.join(__dirname, '../public', name);
    assert.ok(fs.existsSync(filename), 'the Schedules renderer exists');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx, { filename });
  }
  w.schedulesTabEnabled = true;
  const emitHealth = health => healthListeners.forEach(listener => listener(health));
  if (!render) return { dom, w, project, schedule, data, calls, emitHealth };
  w.renderSchedules(data);
  const button = w.document.querySelector('.schedule-run-btn');
  const titles = [];
  new w.MutationObserver(records => titles.push(...records.map(record => record.oldValue), button.title))
    .observe(button, { attributes: true, attributeFilter: ['title'], attributeOldValue: true });
  w.setSchedulesVisible(true);
  return { dom, w, project, schedule, data, calls, emitHealth, get button() { return w.document.querySelector('.schedule-run-btn'); }, titles, opened };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('Delete waits for the destructive confirmation naming the file and preserving past runs, then refreshes', async t => {
  const h = setup(t);
  let answer;
  let question;
  const deleted = [];
  h.w.appConfirm = options => { question = options; return new Promise(resolve => { answer = resolve; }); };
  h.w.api.deleteScheduleFile = async filePath => { deleted.push(filePath); h.project.schedules = []; return { ok: true }; };
  const button = h.w.document.querySelector('.schedule-delete-btn');
  assert.ok(button, 'Schedules offers Delete');
  button.focus();
  button.click();
  await settle();
  assert.equal(question.danger, true);
  assert.equal(question.confirmLabel, 'Delete');
  assert.ok(question.message.includes(h.schedule.file));
  assert.match(question.message, /past runs stay in Sessions/i);
  assert.deepEqual(deleted, [], 'nothing is unlinked before confirmation resolves');
  await h.w.loadSchedules();
  assert.equal(h.w.document.querySelector('.schedule-delete-btn').disabled, true, 'pending confirmation survives refresh');
  answer(true);
  await settle();
  assert.deepEqual(deleted, [h.schedule.filePath]);
  assert.equal(h.w.document.querySelector('.schedule-item'), null);
});

for (const [position, count, expected] of [[0, 3, 1], [1, 3, 2], [2, 3, 1], [0, 1, null]]) {
  test(`successful Delete at row ${position + 1} of ${count} moves focus to ${expected === null ? 'the list' : `Delete in row ${expected + 1}`}`, async t => {
    const h = setup(t);
    await settle();
    h.project.schedules = Array.from({ length: count }, (_, index) => ({ ...h.schedule,
      file: `schedule-${index}.md`, filePath: `/p/schedule-${index}.md` }));
    const deleted = h.project.schedules[position].filePath;
    const target = expected === null ? null : h.project.schedules[expected].filePath;
    h.w.appConfirm = async () => true;
    h.w.api.deleteScheduleFile = async filePath => {
      h.project.schedules = h.project.schedules.filter(schedule => schedule.filePath !== filePath);
      return { ok: true };
    };
    h.w.renderSchedules(h.data);
    const button = h.w.document.querySelectorAll('.schedule-delete-btn')[position];
    button.focus();
    button.click();
    await settle();
    const rows = [...h.w.document.querySelectorAll('.schedule-item')];
    assert.equal(rows.some(row => row.dataset.filepath === deleted), false);
    const focused = target === null ? h.w.document.getElementById('schedules-content')
      : rows.find(row => row.dataset.filepath === target).querySelector('.schedule-delete-btn');
    assert.equal(h.w.document.activeElement, focused, 'successful deletion keeps keyboard focus in the schedules list');
  });
}

test('cancelling Delete keeps the schedule and makes the action available again', async t => {
  const h = setup(t);
  let deleted = false;
  h.w.appConfirm = async () => false;
  h.w.api.deleteScheduleFile = async () => { deleted = true; return { ok: true }; };
  const button = h.w.document.querySelector('.schedule-delete-btn');
  assert.ok(button, 'Schedules offers Delete');
  button.click();
  await settle();
  assert.equal(deleted, false);
  assert.equal(h.w.document.querySelector('.schedule-delete-btn').disabled, false);
  assert.ok(h.w.document.querySelector('.schedule-item'));
});

for (const reply of [{ ok: false, error: 'unlink denied' }, undefined, new Error('backend unavailable')]) {
  test(`Delete failure stays visible and restores the action: ${String(reply?.error || reply)}`, async t => {
    const h = setup(t);
    h.w.appConfirm = async () => true;
    h.w.api.deleteScheduleFile = async () => { if (reply instanceof Error) throw reply; return reply; };
    const button = h.w.document.querySelector('.schedule-delete-btn');
    assert.ok(button, 'Schedules offers Delete');
    button.click();
    await settle();
    assert.equal(h.w.document.querySelector('.schedule-delete-btn').disabled, false);
    const notice = h.w.document.querySelector('[role="alert"]');
    assert.ok(notice);
    assert.ok(notice.textContent.includes(h.schedule.file));
    assert.match(notice.textContent, /could not delete/i);
  });
}

test('Delete refuses linked files but remains available for disabled, malformed and unknown-project rows', t => {
  const h = setup(t);
  h.schedule.linked = true;
  h.w.renderSchedules(h.data);
  let button = h.w.document.querySelector('.schedule-delete-btn');
  assert.ok(button, 'Schedules offers Delete');
  assert.equal(button.disabled, true);
  assert.equal(button.title, 'linked file: edit it at its source');
  h.schedule.linked = false;
  h.schedule.enabled = false;
  h.schedule.problems = ['front matter not read'];
  h.project.known = false;
  h.w.renderSchedules(h.data);
  button = h.w.document.querySelector('.schedule-delete-btn');
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.scheduleControl, 'schedule-delete-btn');
  button.focus();
  assert.equal(h.w.document.activeElement, button, 'Delete participates in keyboard focus');
});

for (const [result, expected] of [
  [{ outcome: 'exited', exitCode: 0, failure: null }, /^Exit 0$/],
  [{ outcome: 'exited', exitCode: 1, failure: 'claude-path' }, /Failed: exit 1.*claude not found on the shell PATH.*Check/i],
  [{ outcome: 'exited', exitCode: 2, failure: 'sandbox' }, /Failed: exit 2.*Check Linux bubblewrap/i],
  [{ outcome: 'signal', exitCode: null, signal: 'SIGTERM' }, /^Stopped: SIGTERM$/],
  [{ outcome: 'refused', error: '<archived>' }, /^Refused: <archived>$/],
  [{ outcome: 'spawn-error', error: 'spawn ENOENT' }, /^Failed to start: spawn ENOENT$/],
  [{ unreadable: true }, /^Unknown: result record unreadable$/],
]) {
  test(`recorded schedule outcome is shown faithfully: ${JSON.stringify(result)}`, t => {
    const h = setup(t);
    const run = { sessionId: 'outcome', created: '2026-11-08T12:00Z', replied: true, messageCount: 2, running: false, result };
    assert.match(h.w.scheduleOutcome(run), expected);
    h.schedule.runs = [run];
    h.w.renderSchedules(h.data);
    assert.equal(h.w.document.querySelector('.schedule-history-run > *'), null, 'outcome text must not create markup');
    assert.match(h.w.document.querySelector('.schedule-history-run').textContent.split(' — ').slice(1).join(' — '), expected);
    assert.equal(h.w.scheduleOutcome({ ...run, running: true }), 'Running');
  });
}

test('failure notices and history use the same renderer recovery hint', t => {
  const h = setup(t);
  assert.equal(typeof h.w.scheduleRunFailureHint, 'function', 'shared failure hint must exist');
  const original = h.w.scheduleRunFailureHint;
  const seen = [];
  h.w.scheduleRunFailureHint = failure => { seen.push(failure); return original(failure); };
  for (const [failure, expected] of [
    ['claude-path', /claude not found on the shell PATH/],
    ['sandbox', /Check Linux bubblewrap/], ['exit', /See the log/],
  ]) {
    h.w.showScheduleRunExit({ name: 'Job', sessionId: failure, manual: true, code: 2, failure });
    const hint = original(failure);
    assert.match(hint, expected);
    assert.ok(h.w.document.querySelector(`[data-notice-id="ScheduleRun:${failure}"]`).textContent.includes(hint));
    assert.ok(h.w.scheduleOutcome({ result: { outcome: 'exited', exitCode: 2, failure } }).includes(hint));
  }
  assert.deepEqual(seen, ['claude-path', 'claude-path', 'sandbox', 'sandbox', 'exit', 'exit']);
});

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
  test(`pending toggle focus uses its row immediately and returns after ${outcome}`, async t => {
    const h = setup(t);
    await settle();
    let finish;
    h.w.api.setScheduleEnabled = () => new Promise(resolve => { finish = resolve; });
    const button = () => h.w.document.querySelector('.schedule-toggle-btn');
    button().focus();
    button().click();
    assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-item'), 'pending toggle hands focus to its row immediately');
    await h.w.loadSchedules();
    assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-item'), 'pending toggle retains row focus across refresh');
    finish(outcome === 'success' ? { ok: true } : { ok: false, error: 'refused' });
    await settle();
    assert.equal(button().disabled, false);
    assert.equal(h.w.document.activeElement, button(), 'settled toggle restores focus to its enabled control');
  });
}

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
  for (const cause of ['scan', 'activity', 'entrypoint-backfill', 'title-backfill', 'sdk-reveal', 'bridge-repair', 'remote', 'bg-jobs', 'cli-status']) {
    h.changed({ cause: [cause] });
    await h.advance(1500);
  }
  h.changed();
  h.changed({ cause: ['unknown-future-cause'] });
  await h.advance(4000);
  assert.equal(calls, 0, 'scan and unrelated events never request list-schedules');
  for (const cause of ['archive', 'project-added', 'project-deleted', 'project-remap', 'worktree-deleted', 'watcher', 'session-exit', 'session-attach']) {
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
  h.w.jsonlViewer.style.display = 'flex';
  h.w.api.readMemory = async () => content;
  h.w.document.querySelector('.schedule-open-btn').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.opened, [['schedule-nightly.md', '/p/schedule-nightly.md', content]]);
  assert.equal(h.w.memoryViewer.style.display, 'flex');
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

const scheduleTabText = h => h.w.document.getElementById('schedules-content').textContent;
const listNotice = h => h.w.document.querySelector('#app-notices [data-notice-id="listSchedules"]');

test('empty states tell apart no project, only archived projects and an empty project (#1237)', t => {
  const h = setup(t);
  const apiCalls = [];
  for (const name of Object.keys(h.w.api)) {
    const original = h.w.api[name];
    h.w.api[name] = (...args) => { apiCalls.push(name); return original(...args); };
  }
  const create = () => h.w.document.querySelector('.schedule-create-btn');
  h.w.renderSchedules({ now: Date.now(), catchUpActive: true, projects: [] });
  assert.equal(create().disabled, true);
  assert.match(scheduleTabText(h), /Add a local project from Sessions, then return here/);
  assert.doesNotMatch(scheduleTabText(h), /No schedules found/);
  assert.match(create().title, /Add a local project from Sessions/, 'the disabled action says why');
  h.w.renderSchedules({ now: Date.now(), catchUpActive: true, projects: [{ ...h.project, archived: true, schedules: [] }] });
  assert.equal(create().disabled, true);
  assert.match(scheduleTabText(h), /Unarchive a project in Settings → Archived/);
  assert.doesNotMatch(scheduleTabText(h), /Add a local project|No schedules found/);
  h.w.renderSchedules({ now: Date.now(), catchUpActive: true, projects: [{ ...h.project, schedules: [] }] });
  assert.equal(create().disabled, false);
  assert.match(scheduleTabText(h), /No schedules found\. Use Create schedule to add one\./);
  assert.doesNotMatch(scheduleTabText(h), /Add a local project|Unarchive a project/);
  assert.deepEqual(apiCalls, [], 'guidance neither registers nor runs a project');
});

test('a project whose commands directory cannot be read shows its error and Retry, not No schedules found (#1237)', async t => {
  const h = setup(t);
  await settle();
  const healthy = { ...h.project, projectPath: '/q', shortName: 'q', scanError: null, schedules: [] };
  h.project.schedules = [];
  h.project.scanError = { code: 'EACCES', message: 'permission denied' };
  h.data.projects.push(healthy);
  h.w.renderSchedules(h.data);
  assert.doesNotMatch(scheduleTabText(h), /No schedules found/);
  const group = h.w.document.querySelector('.schedule-project[data-project-path="/p"]');
  assert.ok(group, 'the unreadable project keeps its group');
  assert.match(group.textContent, /EACCES/);
  assert.match(group.textContent, /permissions/);
  let calls = 0;
  h.w.api.listSchedules = async () => { calls++; h.project.scanError = null; h.project.schedules = [h.schedule]; return h.data; };
  group.querySelector('.schedule-retry-btn').click();
  await settle();
  assert.equal(calls, 1);
  assert.ok(h.w.document.querySelector(`.schedule-item[data-filepath="${h.schedule.filePath}"]`), 'Retry lists the definition');
});

test('an unreadable row shows its error, keeps Delete and disables the actions that need its bytes (#1237)', t => {
  const h = setup(t);
  Object.assign(h.schedule, { name: h.schedule.file, slug: null, enabled: null, cron: null, cronText: null, prompt: null, catchUp: null,
    nextRunMs: null, problems: ['could not read the file (EACCES)'], readError: { code: 'EACCES', message: 'permission denied' } });
  h.w.renderSchedules(h.data);
  const item = h.w.document.querySelector('.schedule-item');
  assert.match(item.textContent, /could not be read/i);
  assert.match(item.textContent, /permissions and path/);
  assert.doesNotMatch(item.textContent, /Disabled|null|Next run/);
  for (const cls of ['.schedule-run-btn', '.schedule-toggle-btn', '.schedule-open-btn']) assert.equal(item.querySelector(cls).disabled, true, cls);
  assert.equal(item.querySelector('.schedule-delete-btn').disabled, false, 'Delete keeps its listed-path policy');
  assert.ok(item.querySelector('.schedule-retry-btn'), 'the row offers Retry');
});

test('initial load shows loading, then a navigable error with single-flight Retry that recovers (#1237)', async t => {
  const h = setup(t, undefined, { render: false });
  h.w.api.listSchedules = async () => { throw new Error('offline'); };
  h.w.setSchedulesVisible(true);
  assert.match(scheduleTabText(h), /Loading schedules/);
  await settle();
  const error = h.w.document.querySelector('.schedule-load-error');
  assert.ok(error, 'the failure is shown in the tab');
  assert.match(error.textContent, /offline/);
  assert.ok(listNotice(h), 'the global notice is kept');
  let calls = 0;
  let finish;
  h.w.api.listSchedules = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const retry = () => h.w.document.querySelector('.schedule-load-error .schedule-retry-btn');
  retry().focus();
  assert.equal(h.w.document.activeElement, retry(), 'Retry is reachable from the keyboard');
  retry().click();
  retry().click();
  assert.equal(calls, 1, 'Retry is single-flight');
  assert.equal(retry().disabled, true);
  finish(h.data);
  await settle();
  assert.equal(h.w.document.querySelector('.schedule-load-error'), null);
  assert.equal(listNotice(h), null, 'recovery clears the notice');
  assert.ok(h.w.document.querySelector('.schedule-item'));
});

test('a failed refresh keeps the last rows labelled stale until a reload succeeds (#1237)', async t => {
  const h = setup(t);
  await settle();
  h.w.api.listSchedules = async () => { throw new Error('offline'); };
  await h.w.loadSchedules();
  assert.ok(h.w.document.querySelector('.schedule-item'), 'last rows remain');
  assert.match(h.w.document.querySelector('.schedule-load-error')?.textContent || '', /last loaded.*offline/is);
  assert.ok(listNotice(h));
  h.w.api.listSchedules = async () => h.data;
  await h.w.loadSchedules();
  assert.equal(h.w.document.querySelector('.schedule-load-error'), null);
  assert.equal(listNotice(h), null);
});

test('older and hidden-tab responses cannot replace newer schedules (#1237)', async t => {
  const h = setup(t);
  await settle();
  const pending = [];
  h.w.api.listSchedules = () => new Promise(resolve => pending.push(resolve));
  const older = h.w.loadSchedules();
  const newer = h.w.loadSchedules();
  pending[1]({ ...h.data, projects: [{ ...h.project, schedules: [{ ...h.schedule, name: 'Newer' }] }] });
  await newer;
  pending[0]({ ...h.data, projects: [{ ...h.project, schedules: [{ ...h.schedule, name: 'Older' }] }] });
  await older;
  assert.equal(h.w.document.querySelector('.schedule-name').textContent, 'Newer');
  const hidden = h.w.loadSchedules();
  h.w.setSchedulesVisible(false);
  pending[2]({ ...h.data, projects: [{ ...h.project, schedules: [{ ...h.schedule, name: 'Hidden' }] }] });
  await hidden;
  assert.equal(h.w.document.querySelector('.schedule-name').textContent, 'Newer');
});

const scheduleRows = (h, count) => Array.from({ length: count }, (_, index) => ({ ...h.schedule,
  file: `schedule-${index}.md`, filePath: `/p/schedule-${index}.md` }));

for (const count of [0, 2]) {
  test(`Create schedule keeps keyboard focus across a refresh with ${count} rows (#1238)`, async t => {
    const h = setup(t);
    await settle();
    h.project.schedules = scheduleRows(h, count);
    h.w.renderSchedules(h.data);
    const before = h.w.document.querySelector('.schedule-create-btn');
    before.focus();
    await h.w.loadSchedules();
    const after = h.w.document.querySelector('.schedule-create-btn');
    assert.notEqual(after, before, 'the refresh replaced the button');
    assert.equal(h.w.document.activeElement, after, 'focus moves to the replacement Create schedule');
  });
}

test('a project Retry keeps focus while its folder stays unreadable, then falls back to Create (#1238)', async t => {
  const h = setup(t);
  await settle();
  h.project.schedules = [];
  h.project.scanError = { code: 'EACCES', message: 'permission denied' };
  h.w.renderSchedules(h.data);
  const retry = () => h.w.document.querySelector('.schedule-project[data-project-path="/p"] .schedule-retry-btn');
  const first = retry();
  first.focus();
  first.click();
  await settle();
  assert.notEqual(retry(), first, 'the refresh replaced the Retry button');
  assert.equal(h.w.document.activeElement, retry(), 'focus moves to the replacement project Retry');
  h.project.scanError = null;
  retry().click();
  await settle();
  assert.equal(retry(), null);
  assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-create-btn'), 'a gone Retry hands focus to Create');
});

for (const outcome of ['success', 'failure']) {
  test(`a pending load Retry keeps focus in the tab and lands after ${outcome} (#1238)`, async t => {
    const h = setup(t, undefined, { render: false });
    h.w.api.listSchedules = async () => { throw new Error('offline'); };
    h.w.setSchedulesVisible(true);
    await settle();
    let finish;
    h.w.api.listSchedules = () => new Promise((resolve, reject) => { finish = outcome === 'success' ? () => resolve(h.data) : () => reject(new Error('still offline')); });
    const retry = () => h.w.document.querySelector('.schedule-load-error .schedule-retry-btn');
    retry().focus();
    retry().click();
    const container = h.w.document.getElementById('schedules-content');
    assert.ok(container.contains(h.w.document.activeElement) || h.w.document.activeElement === container, 'a disabled Retry keeps focus inside the tab');
    assert.notEqual(h.w.document.activeElement, retry(), 'focus leaves the disabled Retry');
    finish();
    await settle();
    const expected = outcome === 'success' ? h.w.document.querySelector('.schedule-create-btn') : retry();
    assert.ok(expected);
    assert.equal(h.w.document.activeElement, expected, outcome === 'success' ? 'recovery focuses Create schedule' : 'a repeated failure focuses the new Retry');
  });
}

for (const start of ['create', 'retry']) {
  test(`completion of a pending refresh respects focus moved away from ${start} (#1238)`, async t => {
    const h = setup(t);
    await settle();
    let finish;
    if (start === 'retry') {
      h.w.api.listSchedules = async () => { throw new Error('offline'); };
      await h.w.loadSchedules();
    }
    h.w.api.listSchedules = () => new Promise(resolve => { finish = () => resolve(h.data); });
    if (start === 'create') {
      h.w.document.querySelector('.schedule-create-btn').focus();
      h.w.loadSchedules();
    } else {
      const retry = h.w.document.querySelector('.schedule-load-error .schedule-retry-btn');
      retry.focus();
      retry.click();
    }
    const elsewhere = h.w.document.createElement('button');
    h.w.document.body.appendChild(elsewhere);
    elsewhere.focus();
    finish();
    await settle();
    assert.equal(h.w.document.activeElement, elsewhere, 'the refresh does not steal the newer focus choice');
  });
}

test('a pending row Retry holds focus on its row and returns to the replacement Retry (#1238)', async t => {
  const h = setup(t);
  await settle();
  Object.assign(h.schedule, { readError: { code: 'EACCES', message: 'permission denied' }, problems: ['could not read the file (EACCES)'] });
  h.w.renderSchedules(h.data);
  let finish;
  h.w.api.listSchedules = () => new Promise(resolve => { finish = () => resolve(h.data); });
  const retry = () => h.w.document.querySelector('.schedule-item .schedule-retry-btn');
  const first = retry();
  first.focus();
  first.click();
  assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-item'), 'the disabled row Retry hands focus to its row');
  finish();
  await settle();
  assert.notEqual(retry(), first);
  assert.equal(h.w.document.activeElement, retry(), 'the row Retry regains focus after the refresh');
  Object.assign(h.schedule, { readError: null, problems: [] });
  h.w.api.listSchedules = async () => h.data;
  retry().click();
  await settle();
  assert.equal(retry(), null, 'the recovered row no longer offers Retry');
  const action = h.w.document.querySelector('.schedule-item .schedule-actions button:not(:disabled)');
  assert.ok(action);
  assert.equal(h.w.document.activeElement, action, 'the recovered row hands focus to its first available action');
});

test('a failed row Retry re-enables the row Retry and returns focus to it, unless focus moved (#1238)', async t => {
  const h = setup(t);
  await settle();
  Object.assign(h.schedule, { readError: { code: 'EACCES', message: 'permission denied' }, problems: ['could not read the file (EACCES)'] });
  h.w.renderSchedules(h.data);
  let fail;
  h.w.api.listSchedules = () => new Promise((_, reject) => { fail = () => reject(new Error('offline')); });
  const retry = h.w.document.querySelector('.schedule-item .schedule-retry-btn');
  retry.focus();
  retry.click();
  assert.equal(h.w.document.activeElement, h.w.document.querySelector('.schedule-item'), 'the disabled row Retry hands focus to its row');
  fail();
  await settle();
  assert.equal(retry.disabled, false, 'the kept row Retry can be used again');
  assert.equal(h.w.document.activeElement, retry, 'focus returns to the row Retry');
  h.w.api.listSchedules = () => new Promise((_, reject) => { fail = () => reject(new Error('offline')); });
  retry.click();
  const elsewhere = h.w.document.createElement('button');
  h.w.document.body.appendChild(elsewhere);
  elsewhere.focus();
  fail();
  await settle();
  assert.equal(retry.disabled, false);
  assert.equal(h.w.document.activeElement, elsewhere, 'the failure does not steal the newer focus choice');
});

test('a failed project Retry re-enables the kept Retry and returns focus to it (#1238)', async t => {
  const h = setup(t);
  await settle();
  h.project.schedules = [];
  h.project.scanError = { code: 'EACCES', message: 'permission denied' };
  h.w.renderSchedules(h.data);
  h.w.api.listSchedules = async () => { throw new Error('offline'); };
  const retry = h.w.document.querySelector('.schedule-project[data-project-path="/p"] .schedule-retry-btn');
  retry.focus();
  retry.click();
  await settle();
  assert.equal(retry.disabled, false, 'the kept project Retry can be used again');
  assert.equal(h.w.document.activeElement, retry, 'focus returns to the project Retry');
});

const scheduleScanError = h => {
  h.project.schedules = [];
  h.project.scanError = { code: 'EACCES', message: 'permission denied' };
  h.w.renderSchedules(h.data);
};

for (const outcome of ['success', 'failure', 'hidden failure']) {
  test(`the load error notice stays while its Retry is pending and settles with the reload: ${outcome} (#1237)`, async t => {
    const h = setup(t, undefined, { render: false });
    h.w.api.listSchedules = async () => { throw new Error('offline'); };
    h.w.setSchedulesVisible(true);
    await settle();
    let finish;
    h.w.api.listSchedules = () => new Promise((resolve, reject) => {
      finish = outcome === 'success' ? () => resolve(h.data) : () => reject(new Error('still offline'));
    });
    listNotice(h).querySelector('.app-notice-action').click();
    assert.ok(listNotice(h), 'the notice remains while Retry is pending');
    if (outcome === 'hidden failure') h.w.setSchedulesVisible(false);
    finish();
    await settle();
    if (outcome === 'success') assert.equal(listNotice(h), null, 'a successful reload clears the notice');
    else assert.ok(listNotice(h), 'a failed Retry leaves the notice in place');
  });
}

for (const where of ['project', 'row']) {
  test(`a failed ${where} Retry makes the kept Retry controls usable again (#1237)`, async t => {
    const h = setup(t);
    await settle();
    if (where === 'project') scheduleScanError(h);
    else {
      Object.assign(h.schedule, { readError: { code: 'EACCES', message: 'permission denied' }, problems: ['could not read the file (EACCES)'] });
      h.w.renderSchedules(h.data);
    }
    const kept = h.w.document.querySelector(where === 'project' ? '.schedule-project .schedule-retry-btn' : '.schedule-item .schedule-retry-btn');
    h.w.api.listSchedules = async () => { throw new Error('offline'); };
    kept.click();
    assert.equal(kept.disabled, true, 'Retry is unavailable while its reload is pending');
    await settle();
    assert.equal(kept.disabled, false, 'the kept Retry is available once the reload has failed');
    assert.equal(h.w.document.querySelector('.schedule-load-error .schedule-retry-btn').disabled, false);
  });
}

test('a superseded failed Retry leaves Retry unavailable until the newer reload settles (#1237)', async t => {
  const h = setup(t);
  await settle();
  scheduleScanError(h);
  const pending = [];
  h.w.api.listSchedules = () => new Promise((resolve, reject) => pending.push(reject));
  const kept = h.w.document.querySelector('.schedule-project .schedule-retry-btn');
  kept.click();
  h.w.loadSchedules();
  pending[0](new Error('older failure'));
  await settle();
  assert.equal(kept.disabled, true, 'a stale failure does not reopen Retry while a newer reload is pending');
  pending[1](new Error('newer failure'));
  await settle();
  assert.equal(kept.disabled, false);
});

const SUSPENDED = { suspended: true, reason: 'unreadable', path: '/data/schedule-state/background', code: 'EACCES', message: 'permission denied', since: 1, retryMs: 300000 };

test('a suspended scheduler shows a banner naming the records and marks next runs as paused, until the listing is healthy', async t => {
  const h = setup(t);
  h.data.health = { ...SUSPENDED, resultFailure: null };
  await h.w.loadSchedules();
  const banner = h.w.document.querySelector('#schedules-content .schedule-health');
  assert.ok(banner, 'the Schedules tab shows the suspension');
  assert.equal(banner.getAttribute('role'), 'alert');
  assert.equal(banner.textContent, 'Automatic schedules are paused: the background-run records at /data/schedule-state/background could not be read (EACCES). Fix their permissions. Retrying every 5 min.');
  assert.match(h.w.document.querySelector('.schedule-state').textContent, /^Paused: automatic launches are suspended \(next run due /);
  assert.equal(h.w.document.querySelectorAll('[data-notice-id="ScheduleSuspended"]').length, 1, 'an app notice is shown as well');
  h.data.health = { suspended: false, resultFailure: null };
  await h.w.loadSchedules();
  assert.equal(h.w.document.querySelector('#schedules-content .schedule-health'), null);
  assert.match(h.w.document.querySelector('.schedule-state').textContent, /^Next run: /);
  assert.equal(h.w.document.querySelector('[data-notice-id="ScheduleSuspended"]'), null, 'the notice clears after a successful discovery');
});

test('the suspension reaches the user while the Schedules tab is disabled', t => {
  const h = setup(t, undefined, { render: false });
  h.w.schedulesTabEnabled = false;
  h.emitHealth({ ...SUSPENDED, resultFailure: null });
  const notice = h.w.document.querySelector('[data-notice-id="ScheduleSuspended"]');
  assert.ok(notice, 'an app-level notice is shown without the tab');
  assert.match(notice.textContent, /Automatic schedules are paused: the background-run records at \/data\/schedule-state\/background could not be read \(EACCES\)/);
  h.emitHealth({ ...SUSPENDED, resultFailure: null });
  assert.equal(h.w.document.querySelectorAll('[data-notice-id="ScheduleSuspended"]').length, 1);
  h.emitHealth({ suspended: false, resultFailure: { path: '/r/x.json', code: 'EBADRESULT', message: 'The result file /r/x.json is unreadable; remove or fix it', at: 1 } });
  assert.equal(h.w.document.querySelector('[data-notice-id="ScheduleSuspended"]'), null);
  assert.match(h.w.document.querySelector('[data-notice-id="ScheduleResultFailure"]').textContent, /A schedule result could not be recorded: The result file \/r\/x\.json is unreadable; remove or fix it/);
});

test('an older health snapshot never erases a newer push, from the startup reply or a list reply', async t => {
  let reply, startup;
  const h = setup(t, undefined, { render: false, api: { getScheduleHealth: () => new Promise(resolve => { startup = resolve; }) } });
  h.w.schedulesTabEnabled = false;
  h.emitHealth({ ...SUSPENDED, resultFailure: null, revision: 5 });
  startup({ suspended: false, resultFailure: null, revision: 4 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.w.document.querySelector('[data-notice-id="ScheduleSuspended"]'), 'a stale startup reply must not clear the live suspension notice');
  h.w.schedulesTabEnabled = true;
  h.data.health = { suspended: false, resultFailure: null, revision: 3 };
  h.w.api.listSchedules = () => new Promise(resolve => { reply = resolve; });
  const loading = h.w.loadSchedules();
  reply(h.data);
  await loading;
  assert.ok(h.w.document.querySelector('[data-notice-id="ScheduleSuspended"]'), 'a stale list refresh must not clear the live suspension notice');
  assert.ok(h.w.document.querySelector('#schedules-content .schedule-health'), 'the tab shows the newest health, not the stale one');
  assert.match(h.w.document.querySelector('.schedule-state').textContent, /^Paused/);
  h.emitHealth({ suspended: false, resultFailure: null, revision: 6 });
  assert.equal(h.w.document.querySelector('[data-notice-id="ScheduleSuspended"]'), null, 'a newer healthy push clears it');
});

test('the result notice counts the other unresolved results', t => {
  const h = setup(t, undefined, { render: false });
  h.emitHealth({ suspended: false, resultFailure: { path: '/r/a.json', code: 'EBADRESULT', message: 'The result file /r/a.json is unreadable; remove or fix it', at: 1, count: 3 }, revision: 1 });
  assert.match(h.w.document.querySelector('[data-notice-id="ScheduleResultFailure"] .app-notice-message').textContent, /remove or fix it \(2 other results also not recorded\)$/);
});
