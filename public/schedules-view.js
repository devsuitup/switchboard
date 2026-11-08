'use strict';

let schedulesVisible = false;
let schedulesTimer = null;
let schedulesRequest = 0;
let schedulesProject = null;
let schedulesReloadTimer = null;
const schedulesActions = new Map();

function setSchedulesVisible(visible) {
  schedulesVisible = visible;
  clearTimeout(schedulesTimer);
  schedulesTimer = null;
  clearTimeout(schedulesReloadTimer);
  schedulesReloadTimer = null;
  if (!visible) { schedulesRequest++; return; }
  loadSchedules();
  scheduleSchedulesRefresh();
}

function queueSchedulesReload() {
  if (!schedulesVisible) return;
  clearTimeout(schedulesReloadTimer);
  schedulesReloadTimer = setTimeout(() => {
    schedulesReloadTimer = null;
    if (schedulesVisible) loadSchedules();
  }, 900);
}

function scheduleSchedulesRefresh() {
  if (!schedulesVisible) return;
  schedulesTimer = setTimeout(() => {
    if (!document.hidden) loadSchedules();
    scheduleSchedulesRefresh();
  }, 60000 - Date.now() % 60000);
}

async function loadSchedules() {
  clearTimeout(schedulesReloadTimer);
  schedulesReloadTimer = null;
  const request = ++schedulesRequest;
  try {
    const data = await window.api.listSchedules();
    if (request !== schedulesRequest) return;
    renderSchedules(data);
    clearAppNotice('listSchedules');
  } catch (error) {
    if (request !== schedulesRequest) return;
    showAppNotice({ id: 'listSchedules', kind: 'error', message: `Schedules could not be loaded: ${error?.message || error}. Reopen the Schedules tab to retry.` });
  }
}

function showSchedules(projectPath) {
  schedulesProject = projectPath || null;
  document.querySelector('.sidebar-tab[data-tab="schedules"]')?.click();
  loadSchedules();
}

function scheduleTime(ms, now) {
  const date = new Date(ms);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minutes = Math.max(1, Math.ceil((ms - now) / 60000));
  const clock = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  const relative = ms - now < 3600000 ? `in ${minutes} min`
    : date.toDateString() === new Date(now).toDateString() ? `today ${clock}`
      : date.toDateString() === tomorrow.toDateString() ? `tomorrow ${clock}`
        : ms <= week.getTime() ? `${date.toLocaleDateString('en', { weekday: 'long' })} ${clock}`
          : `${date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })} ${clock}`;
  return `${date.toLocaleString()} (${relative})`;
}

function scheduleOutcome(run) {
  if (run.running) return 'Running';
  const hint = run.replied === true ? 'replied; exit code unknown'
    : run.replied === null ? 'Unknown'
      : run.messageCount === 1 ? '(refused or not started, run by another instance, run before results were kept, or Switchboard closed during the run)'
        : 'started; no reply recorded';
  return `No result recorded — ${hint}`;
}

function scheduleText(parent, className, text) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function renderSchedules(data) {
  const container = document.getElementById('schedules-content');
  if (!container) return;
  const rows = [...container.querySelectorAll('.schedule-item')];
  const openHistory = new Map(rows.map(row => [row.dataset.filepath, row.querySelector('details').open]));
  const focused = document.activeElement;
  const focusedRow = focused?.closest('.schedule-item');
  const focusedPath = container.contains(focusedRow) ? focusedRow.dataset.filepath : null;
  const focusedControl = focused?.dataset.scheduleControl;
  const projectFocus = schedulesProject;
  schedulesProject = null;
  container.replaceChildren();
  scheduleText(container, 'schedule-help', 'Runs before v0.0.90 carry no schedule marker and are not listed. Runs before results were kept, runs of another instance and runs alive when Switchboard closes have no result recorded.');
  let count = 0;
  for (const project of data.projects) {
    if (!project.schedules.length) continue;
    count += project.schedules.length;
    const group = document.createElement('section');
    group.className = 'schedule-project';
    group.dataset.projectPath = project.projectPath;
    scheduleText(group, 'schedule-project-title', project.shortName);
    scheduleText(group, 'schedule-path', project.projectPath);
    for (const schedule of project.schedules) {
      const item = buildScheduleItem(project, schedule, data);
      item.querySelector('details').open = openHistory.get(schedule.filePath) || false;
      group.appendChild(item);
    }
    container.appendChild(group);
    if (projectFocus === project.projectPath) {
      group.tabIndex = -1;
      group.focus({ preventScroll: true });
      group.scrollIntoView?.({ block: 'start' });
    }
  }
  if (!count) scheduleText(container, 'plans-empty', 'No schedules found.');
  if (!projectFocus && focusedPath && focusedControl) {
    const row = [...container.querySelectorAll('.schedule-item')].find(item => item.dataset.filepath === focusedPath);
    [...(row?.querySelectorAll('[data-schedule-control]') || [])]
      .find(control => control.dataset.scheduleControl === focusedControl)?.focus({ preventScroll: true });
  }
  const paths = new Set(data.projects.flatMap(project => project.schedules.map(schedule => schedule.filePath)));
  for (const [filePath, state] of schedulesActions) {
    if (!paths.has(filePath) && state.run !== 'running' && !state.toggling) schedulesActions.delete(filePath);
  }
}

function scheduleActionState(filePath) {
  if (!schedulesActions.has(filePath)) schedulesActions.set(filePath, {});
  return schedulesActions.get(filePath);
}

function updateScheduleRunButtons(filePath, original) {
  const state = scheduleActionState(filePath);
  const buttons = new Set([...document.querySelectorAll('.schedule-run-btn')]
    .filter(button => button.closest('.schedule-item').dataset.filepath === filePath));
  if (original) buttons.add(original);
  for (const button of buttons) {
    button.disabled = button.dataset.unavailable === 'true' || state.run === 'running';
    button.classList.toggle('running', state.run === 'running');
    button.classList.toggle('done', state.run === 'done');
    button.textContent = state.run === 'running' ? 'Running...' : state.run === 'done' ? '\u2713' : 'Run now';
    button.title = state.run === 'running' ? 'Running...' : state.run === 'done' ? 'Launched!' : button.dataset.reason;
  }
}

function buildScheduleItem(project, schedule, data) {
  const item = document.createElement('article');
  item.className = 'schedule-item';
  item.dataset.filepath = schedule.filePath;
  scheduleText(item, 'schedule-name', schedule.name);
  scheduleText(item, 'schedule-path', schedule.filePath);
  scheduleText(item, 'schedule-cron', `${schedule.cronText} · ${schedule.cron}`);
  const fatal = schedule.problems.filter(p => !p.startsWith('slug shared with '));
  const state = project.archived ? 'Suspended — project archived'
    : !schedule.enabled ? 'Disabled'
      : fatal.length ? `Never runs: ${fatal.join('; ')}`
        : schedule.nextRunMs === null ? 'No run within a year'
          : `Next run: ${scheduleTime(schedule.nextRunMs, data.now)}`;
  scheduleText(item, 'schedule-state', state);
  if (schedule.problems.length) scheduleText(item, 'schedule-problems', schedule.problems.join('; '));
  if (schedule.linked) scheduleText(item, 'schedule-problems', 'linked file: edit it at its source');
  if (schedule.catchUp) {
    scheduleText(item, 'schedule-catch-up', !data.catchUpActive ? 'catch-up off in this instance'
      : schedule.catchUpDueMs != null ? `Catch-up pending: due ${new Date(schedule.catchUpDueMs).toLocaleString()}` : 'Catch-up on');
  }
  const actions = document.createElement('div');
  actions.className = 'schedule-actions';
  const unread = schedule.problems.some(p => p.startsWith('front matter not read'));
  const actionState = scheduleActionState(schedule.filePath);
  if (!project.known) scheduleText(item, 'schedule-problems', 'not a known project');
  const action = (cls, label, disabled, reason, handler) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cls;
    btn.dataset.scheduleControl = cls;
    btn.dataset.unavailable = String(disabled);
    btn.dataset.reason = disabled ? reason : label;
    btn.textContent = label;
    btn.title = disabled ? reason : label;
    btn.disabled = disabled;
    btn.addEventListener('click', handler);
    actions.appendChild(btn);
    return btn;
  };
  const play = action('schedule-run-btn', 'Run now', !project.known || unread,
    !project.known ? 'not a known project' : 'front matter not read', () => runScheduleFromTab(schedule, play));
  updateScheduleRunButtons(schedule.filePath, play);
  const toggle = action('schedule-toggle-btn', schedule.enabled ? 'Turn off' : 'Turn on', schedule.linked || unread,
    schedule.linked ? 'linked file: edit it at its source' : 'front matter not read', async event => {
      const btn = event.currentTarget;
      if (actionState.toggling) return;
      actionState.toggling = true;
      btn.disabled = true;
      const id = `SetSchedule:${schedule.filePath}`;
      try {
        const result = await window.api.setScheduleEnabled(schedule.filePath, !schedule.enabled);
        if (!result?.ok) throw new Error(result?.error || 'The backend returned no result');
        clearAppNotice(id);
      } catch (error) {
        showAppNotice({ id, kind: 'error', message: `Could not change "${schedule.file}": ${error?.message || error}. Check the schedule file and retry in the Schedules tab.` });
      } finally {
        actionState.toggling = false;
        btn.disabled = false;
        for (const current of document.querySelectorAll('.schedule-toggle-btn')) {
          if (current.closest('.schedule-item').dataset.filepath === schedule.filePath) current.disabled = current.dataset.unavailable === 'true';
        }
        await loadSchedules();
      }
    });
  toggle.disabled ||= !!actionState.toggling;
  action('schedule-open-btn', 'Open', !project.known, 'not a known project', async () => {
    const id = `OpenSchedule:${schedule.filePath}`;
    try {
      const content = await window.api.readMemory(schedule.filePath);
      if (typeof content !== 'string' || !content) throw new Error('The schedule could not be read or its path is not allowed');
      await openScheduleMemory(schedule, content);
      clearAppNotice(id);
      await loadSchedules();
    } catch (error) {
      showAppNotice({ id, kind: 'error', message: `Could not open "${schedule.file}": ${error?.message || error}. Check the file and retry Open.` });
    }
  });
  item.appendChild(actions);
  const history = document.createElement('details');
  const summary = document.createElement('summary');
  summary.dataset.scheduleControl = 'history-summary';
  const runs = schedule.runs.slice(0, 20);
  summary.textContent = runs.length ? `Last run: ${new Date(runs[0].created).toLocaleString()} — ${scheduleOutcome(runs[0])}` : 'No recorded run';
  history.appendChild(summary);
  for (const run of runs) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'schedule-history-run';
    row.dataset.scheduleControl = `history:${run.sessionId}`;
    row.textContent = `${new Date(run.created).toLocaleString()} — ${scheduleOutcome(run)}`;
    row.addEventListener('click', () => openScheduleRun(project, schedule, run));
    history.appendChild(row);
  }
  const sessions = document.createElement('button');
  sessions.type = 'button';
  sessions.dataset.scheduleControl = 'sessions';
  sessions.textContent = 'Show history in Sessions';
  sessions.addEventListener('click', () => showScheduleSessions(project.projectPath, schedule.slug, schedule.runs.map(run => run.sessionId)));
  history.appendChild(sessions);
  item.appendChild(history);
  return item;
}

async function runScheduleFromTab(schedule, button) {
  const state = scheduleActionState(schedule.filePath);
  if (state.run === 'running') return;
  const token = {};
  state.token = token;
  state.run = 'running';
  const id = `RunSchedule:${schedule.filePath}`;
  updateScheduleRunButtons(schedule.filePath, button);
  try {
    const result = await window.api.runScheduleNow(schedule.filePath);
    if (!result?.ok) throw new Error(result?.error || 'The backend returned no result');
    clearAppNotice(id);
    state.run = 'done';
    setTimeout(() => {
      if (state.token !== token) return;
      state.run = null;
      updateScheduleRunButtons(schedule.filePath, button);
    }, 2000);
  } catch (error) {
    state.run = null;
    showAppNotice({ id, kind: 'error', message: `Could not run "${schedule.file}": ${error?.message || error || 'The backend is unavailable'}. Check the schedule file, then try Run now again.` });
  } finally {
    updateScheduleRunButtons(schedule.filePath, button);
    if (schedulesVisible) await loadSchedules();
  }
}
