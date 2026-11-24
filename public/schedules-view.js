'use strict';

window.schedulesTabEnabled = SETTING_DEFAULTS.schedulesTab;

window._applySchedulesTab = enabled => {
  if (window.schedulesTabEnabled === enabled) return;
  window.schedulesTabEnabled = enabled;
  const tab = document.querySelector('.sidebar-tab[data-tab="schedules"]');
  tab.hidden = !enabled;
  tab.disabled = !enabled;
  tab.tabIndex = enabled ? 0 : -1;
  if (!enabled) {
    setSchedulesVisible(false);
    if (activeTab === 'schedules') document.querySelector('.sidebar-tab[data-tab="sessions"]').click();
  }
  if (activeTab === 'memory') loadMemories();
  if (typeof refreshSidebar === 'function') refreshSidebar();
};

let schedulesVisible = false;
let schedulesTimer = null;
let schedulesRequest = 0;
let schedulesProject = null;
let schedulesReloadTimer = null;
let schedulesReloadMaxTimer = null;
let schedulesPendingFocus = null;
const schedulesActions = new Map();
let schedulesData = null;
let schedulesLoadError = null;
let schedulesInFlight = null;

function setSchedulesVisible(visible) {
  schedulesVisible = visible;
  clearTimeout(schedulesTimer);
  schedulesTimer = null;
  clearTimeout(schedulesReloadTimer);
  schedulesReloadTimer = null;
  clearTimeout(schedulesReloadMaxTimer);
  schedulesReloadMaxTimer = null;
  if (!visible) { schedulesRequest++; schedulesProject = null; schedulesPendingFocus = null; return; }
  if (!schedulesData && !schedulesLoadError) {
    const container = document.getElementById('schedules-content');
    container?.replaceChildren();
    if (container) scheduleText(container, 'plans-empty', 'Loading schedules…').setAttribute('role', 'status');
  }
  loadSchedules();
  scheduleSchedulesRefresh();
}

function queueSchedulesReload() {
  if (!schedulesVisible) return;
  clearTimeout(schedulesReloadTimer);
  const reload = () => {
    if (schedulesVisible) loadSchedules();
  };
  schedulesReloadTimer = setTimeout(reload, 900);
  if (schedulesReloadMaxTimer === null) schedulesReloadMaxTimer = setTimeout(reload, 3000);
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
  clearTimeout(schedulesReloadMaxTimer);
  schedulesReloadMaxTimer = null;
  const request = ++schedulesRequest;
  const load = (async () => {
    try {
      const data = await window.api.listSchedules();
      if (request !== schedulesRequest) return;
      schedulesLoadError = null;
      renderSchedules(data);
      clearAppNotice('listSchedules');
    } catch (error) {
      if (request !== schedulesRequest) return;
      schedulesLoadError = String(error?.message || error);
      renderSchedulesLoadError();
      showAppNotice({ id: 'listSchedules', kind: 'error', message: `Schedules could not be loaded: ${schedulesLoadError}. Use Retry in the Schedules tab.`,
        actionLabel: 'Retry', dismissOnAction: false, onAction: () => { document.querySelector('.sidebar-tab[data-tab="schedules"]')?.click(); retrySchedules(); } });
    } finally {
      if (schedulesInFlight === load) schedulesInFlight = null;
    }
  })();
  schedulesInFlight = load;
  return load;
}

function retrySchedules() {
  if (schedulesInFlight) return schedulesInFlight;
  const pending = loadSchedules();
  for (const button of document.querySelectorAll('.schedule-retry-btn')) button.disabled = true;
  return pending;
}

function scheduleRetryButton(parent) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'schedule-retry-btn';
  button.dataset.scheduleControl = 'schedule-retry-btn';
  button.textContent = 'Retry';
  button.addEventListener('click', () => retrySchedules());
  parent.appendChild(button);
  return button;
}

function renderSchedulesLoadError() {
  const container = document.getElementById('schedules-content');
  if (!container || !schedulesLoadError) return;
  const focused = container.querySelector('.schedule-load-error')?.contains(document.activeElement);
  container.querySelector('.schedule-load-error')?.remove();
  if (!schedulesData) container.replaceChildren();
  const box = document.createElement('div');
  box.className = 'schedule-load-error';
  box.setAttribute('role', 'alert');
  scheduleText(box, 'schedule-problems', schedulesData
    ? `Showing the list last loaded at ${new Date(schedulesData.now).toLocaleTimeString()}; the latest refresh failed: ${schedulesLoadError}.`
    : `Schedules could not be loaded: ${schedulesLoadError}.`);
  const retry = scheduleRetryButton(box);
  const create = container.querySelector('.schedule-create-btn');
  if (create) create.after(box);
  else container.prepend(box);
  for (const button of container.querySelectorAll('.schedule-retry-btn')) button.disabled = false;
  if (focused) retry.focus({ preventScroll: true });
}

function showSchedules(projectPath) {
  if (!window.schedulesTabEnabled) return;
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
  const result = run.result;
  if (result) {
    if (result.unreadable) return 'Unknown: result record unreadable';
    const extra = [result.cleanup, result.warning].filter(Boolean).map(text => ' — ' + text).join('');
    if (result.outcome === 'timed-out') return `Timed out${extra}`;
    if (result.outcome === 'stopped') return `Stopped before it finished${extra}`;
    if (result.outcome === 'job-missing') return `Background job disappeared${extra}`;
    if (result.outcome === 'refused') return `Refused: ${result.error}`;
    if (result.outcome === 'spawn-error') return `Failed to start: ${result.error}`;
    if (result.outcome === 'signal') return `Stopped: ${result.signal}`;
    if (result.outcome === 'exited' && Number.isInteger(result.exitCode)) {
      if (result.exitCode === 0) return `Exit 0${extra}`;
      const hint = scheduleRunFailureHint(result.failure);
      return `Failed: exit ${result.exitCode} — ${hint}${extra}`;
    }
    return 'Unknown: result record unreadable';
  }
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
  const focusedControl = focused?.dataset.scheduleControl || (focusedPath === schedulesPendingFocus?.filePath ? schedulesPendingFocus.control : null);
  const projectFocus = schedulesProject;
  schedulesProject = null;
  schedulesData = data;
  container.replaceChildren();
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'schedule-create-btn';
  create.textContent = 'Create schedule';
  const creatable = data.projects.some(project => !project.archived);
  create.disabled = !creatable;
  create.addEventListener('click', () => openScheduleCreateForm(data.projects));
  container.appendChild(create);
  const prerequisite = !data.projects.length ? 'No registered project. Add a local project from Sessions, then return here.'
    : !creatable ? 'Every registered project is archived. Unarchive a project in Settings → Archived, then return here.' : null;
  if (prerequisite) {
    const hint = scheduleText(container, 'schedule-prerequisite', prerequisite);
    hint.id = 'schedule-create-prerequisite';
    create.setAttribute('aria-describedby', hint.id);
    create.title = prerequisite;
  }
  scheduleText(container, 'schedule-help', 'Runs before v0.0.90 carry no schedule marker and are not listed. Runs before results were kept, runs of another instance and runs alive when Switchboard closes have no result recorded.');
  let count = 0;
  for (const project of data.projects) {
    if (!project.schedules.length && !project.scanError) continue;
    count += project.schedules.length;
    const group = document.createElement('section');
    group.className = 'schedule-project';
    group.dataset.projectPath = project.projectPath;
    scheduleText(group, 'schedule-project-title', project.shortName);
    scheduleText(group, 'schedule-path', project.projectPath);
    if (project.scanError) {
      const scan = document.createElement('div');
      scan.className = 'schedule-scan-error';
      scheduleText(scan, 'schedule-problems', `Could not read .claude/commands${project.scanError.code ? ` (${project.scanError.code})` : ''}: ${project.scanError.message}. Its schedules are not listed. Check the folder's permissions and path, then Retry.`);
      scheduleRetryButton(scan);
      group.appendChild(scan);
    }
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
  if (!count && creatable && !data.projects.some(project => project.scanError)) scheduleText(container, 'plans-empty', 'No schedules found. Use Create schedule to add one.');
  if (!projectFocus && focusedPath && focusedControl) {
    const currentRows = [...container.querySelectorAll('.schedule-item')];
    const target = currentRows.find(row => row.dataset.filepath === focusedPath)
      || currentRows[Math.min(rows.indexOf(focusedRow), currentRows.length - 1)];
    if (target) focusScheduleControl(target.dataset.filepath, focusedControl);
    else {
      schedulesPendingFocus = null;
      container.tabIndex = -1;
      container.focus({ preventScroll: true });
    }
  } else schedulesPendingFocus = null;
  const paths = new Set(data.projects.flatMap(project => project.schedules.map(schedule => schedule.filePath)));
  for (const [filePath, state] of schedulesActions) {
    if (!paths.has(filePath) && state.run !== 'running' && !state.toggling && !state.deleting) schedulesActions.delete(filePath);
  }
}

function openScheduleCreateForm(projects) {
  if (document.querySelector('.schedule-create-form')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const form = document.createElement('form');
  form.className = 'modal-dialog schedule-create-form';
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  form.setAttribute('aria-labelledby', 'schedule-create-title');
  const title = scheduleText(form, 'modal-title', 'Create schedule');
  title.id = 'schedule-create-title';
  const controls = new Map();
  const errors = new Map();
  const add = (name, label, kind = 'input', type = 'text') => {
    const row = document.createElement('div');
    row.className = 'schedule-form-field';
    const caption = document.createElement('label');
    caption.htmlFor = `schedule-create-${name}`;
    caption.textContent = label;
    const control = document.createElement(kind);
    if (type !== 'checkbox') control.className = kind === 'select' ? 'settings-select' : 'settings-input';
    control.name = name;
    control.id = caption.htmlFor;
    if (kind === 'input') control.type = type;
    const error = document.createElement('div');
    error.className = 'schedule-field-error';
    error.id = `${control.id}-error`;
    error.setAttribute('aria-live', 'polite');
    control.setAttribute('aria-describedby', error.id);
    row.append(caption, control, error);
    form.appendChild(row);
    controls.set(name, control);
    errors.set(name, error);
    return control;
  };
  const project = add('projectPath', 'Project', 'select');
  for (const entry of projects) {
    const option = document.createElement('option');
    option.value = entry.projectPath;
    option.textContent = `${entry.shortName} — ${entry.projectPath}${entry.archived ? ' (archived; unarchive it first)' : ''}`;
    option.disabled = entry.archived;
    project.appendChild(option);
  }
  project.value = projects.find(entry => !entry.archived)?.projectPath || '';
  add('name', 'Name');
  add('slug', 'Slug (lowercase letters, digits and hyphens; at most 64 characters)');
  add('cron', 'Cron (5 fields, machine local time)');
  add('enabled', 'Enabled', 'input', 'checkbox').checked = true;
  add('catch-up', 'Catch up once when a run was missed', 'input', 'checkbox');
  const background = add('run-as-background', 'Run as a background session (can be joined while it runs)', 'input', 'checkbox');
  const updateBackground = () => {
    const selected = projects.find(entry => entry.projectPath === project.value);
    const reason = selected?.remoteAlias ? 'Background schedules are local only.' : selected?.sandboxed ? 'Background sessions cannot run under the sandbox wrapper.' : '';
    background.disabled = !!reason;
    if (reason) background.checked = false;
    errors.get('run-as-background').textContent = reason;
  };
  project.addEventListener('change', updateBackground);
  updateBackground();
  add('prompt', 'Prompt', 'textarea');
  const mode = add('cli.permission-mode', 'Permission mode', 'select');
  for (const entry of PERMISSION_MODES) {
    const option = document.createElement('option');
    option.value = entry.value || '';
    option.textContent = entry.value === null ? 'Default (auto)' : entry.label;
    mode.appendChild(option);
  }
  add('cli.allowed-tools', 'Allowed tools (comma-separated; blank uses runner defaults)');
  add('cli.model', 'Model (optional)');
  add('cli.max-budget-usd', 'Maximum budget in USD (optional)');
  add('cli.append-system-prompt', 'Append system prompt (one line, optional)');
  add('cli.add-dirs', 'Additional directories (one per line; no commas)', 'textarea');
  const error = scheduleText(form, 'schedule-field-error', '');
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Create';
  actions.append(cancel, submit);
  form.appendChild(actions);
  overlay.appendChild(form);
  document.body.appendChild(overlay);
  let busy = false;
  const close = () => {
    if (busy) return;
    overlay.remove();
    unregister();
    document.querySelector('.schedule-create-btn')?.focus();
  };
  const unregister = registerModal({ overlay, cancel: close, enter: event => event.target.matches('input') });
  cancel.addEventListener('click', close);
  project.focus();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    for (const [name, control] of controls) {
      control.removeAttribute('aria-invalid');
      errors.get(name).textContent = '';
      control.disabled = true;
    }
    submit.disabled = cancel.disabled = true;
    error.textContent = '';
    const value = name => controls.get(name).value;
    const fields = { name: value('name'), slug: value('slug'), cron: value('cron'), prompt: value('prompt'),
      enabled: controls.get('enabled').checked, 'catch-up': controls.get('catch-up').checked, 'run-as-background': background.checked, cli: {} };
    for (const key of ['permission-mode', 'allowed-tools', 'model', 'max-budget-usd', 'append-system-prompt']) {
      if (value(`cli.${key}`).trim()) fields.cli[key] = value(`cli.${key}`);
    }
    fields.cli['add-dirs'] = value('cli.add-dirs').split(/\r?\n/).map(dir => dir.trim()).filter(Boolean);
    let result;
    try { result = await window.api.createScheduleFile(value('projectPath'), fields); }
    catch (failure) { result = { ok: false, error: failure?.message || String(failure) }; }
    busy = false;
    for (const control of controls.values()) control.disabled = false;
    updateBackground();
    submit.disabled = cancel.disabled = false;
    if (result?.ok) {
      close();
      await loadSchedules();
      document.querySelector('.schedule-create-btn')?.focus();
    } else {
      const control = controls.get(result?.field);
      (errors.get(result?.field) || error).textContent = result?.error || 'The backend returned no result. Try Create again.';
      if (control) { control.setAttribute('aria-invalid', 'true'); control.focus(); }
      else submit.focus();
    }
  });
}

function focusScheduleControl(filePath, controlName) {
  const row = [...document.querySelectorAll('#schedules-content .schedule-item')].find(item => item.dataset.filepath === filePath);
  const control = [...(row?.querySelectorAll('[data-schedule-control]') || [])].find(el => el.dataset.scheduleControl === controlName);
  schedulesPendingFocus = control?.disabled ? { filePath, control: controlName } : null;
  if (control?.disabled) row.focus({ preventScroll: true });
  else control?.focus({ preventScroll: true });
}

function restorePendingScheduleFocus() {
  if (!schedulesPendingFocus) return;
  const { filePath, control } = schedulesPendingFocus;
  const focused = document.activeElement;
  if (focused?.matches('.schedule-item') && focused.dataset.filepath === filePath) focusScheduleControl(filePath, control);
  else schedulesPendingFocus = null;
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
    const focused = document.activeElement === button;
    button.disabled = button.dataset.unavailable === 'true' || state.run === 'running';
    button.classList.toggle('running', state.run === 'running');
    button.classList.toggle('done', state.run === 'done');
    button.textContent = state.run === 'running' ? 'Running...' : state.run === 'done' ? '\u2713' : 'Run now';
    button.title = state.run === 'running' ? 'Running...' : state.run === 'done' ? 'Launched!' : button.dataset.reason;
    if (focused && button.disabled) focusScheduleControl(filePath, button.dataset.scheduleControl);
  }
  restorePendingScheduleFocus();
}

function buildScheduleItem(project, schedule, data) {
  const item = document.createElement('article');
  item.className = 'schedule-item';
  item.tabIndex = -1;
  item.dataset.filepath = schedule.filePath;
  scheduleText(item, 'schedule-name', schedule.name);
  scheduleText(item, 'schedule-path', schedule.filePath);
  const readError = schedule.readError;
  scheduleText(item, 'schedule-cron', readError ? 'Schedule unknown' : `${schedule.cronText} · ${schedule.cron}`);
  const fatal = schedule.problems.filter(p => !p.startsWith('slug shared with '));
  const state = project.archived ? 'Suspended — project archived'
    : readError ? 'Unknown: the file could not be read'
      : !schedule.enabled ? 'Disabled'
        : fatal.length ? `Never runs: ${fatal.join('; ')}`
          : schedule.nextRunMs === null ? 'No run within a year'
            : `Next run: ${scheduleTime(schedule.nextRunMs, data.now)}`;
  scheduleText(item, 'schedule-state', state);
  if (schedule.runAsBackground) scheduleText(item, 'schedule-state', project.remoteAlias ? 'Background option ignored: local schedules only'
    : project.sandboxed ? 'Background unavailable under sandbox: runs headless' : 'Background session: can be joined while it runs');
  if (schedule.problems.length) scheduleText(item, 'schedule-problems', schedule.problems.join('; '));
  if (readError) scheduleText(item, 'schedule-problems', `${readError.message}. Check the file's permissions and path, then Retry.`);
  if (schedule.linked) scheduleText(item, 'schedule-problems', 'linked file: edit it at its source');
  if (schedule.catchUp) {
    scheduleText(item, 'schedule-catch-up', !data.catchUpActive ? 'catch-up off in this instance'
      : schedule.catchUpDueMs != null ? `Catch-up pending: due ${new Date(schedule.catchUpDueMs).toLocaleString()}` : 'Catch-up on');
  }
  const actions = document.createElement('div');
  actions.className = 'schedule-actions';
  const unread = !!readError || schedule.problems.some(p => p.startsWith('front matter not read'));
  const unreadReason = readError ? 'the file could not be read' : 'front matter not read';
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
    !project.known ? 'not a known project' : unreadReason, () => runScheduleFromTab(schedule, play));
  updateScheduleRunButtons(schedule.filePath, play);
  const toggle = action('schedule-toggle-btn', schedule.enabled === null ? 'Turn on or off' : schedule.enabled ? 'Turn off' : 'Turn on', schedule.linked || unread,
    schedule.linked ? 'linked file: edit it at its source' : unreadReason, async event => {
      const btn = event.currentTarget;
      if (actionState.toggling) return;
      actionState.toggling = true;
      const focused = document.activeElement === btn;
      btn.disabled = true;
      if (focused) focusScheduleControl(schedule.filePath, btn.dataset.scheduleControl);
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
        restorePendingScheduleFocus();
        if (schedulesVisible) await loadSchedules();
      }
    });
  toggle.disabled ||= !!actionState.toggling;
  action('schedule-open-btn', 'Open', !project.known || !!readError, !project.known ? 'not a known project' : unreadReason, async () => {
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
  const remove = action('schedule-delete-btn', 'Delete', schedule.linked,
    'linked file: edit it at its source', () => deleteScheduleFromTab(schedule));
  remove.disabled ||= !!actionState.deleting;
  if (readError) scheduleRetryButton(actions);
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
  sessions.disabled = !!readError;
  sessions.addEventListener('click', () => showScheduleSessions(project.projectPath, schedule.slug, schedule.runs.map(run => run.sessionId)));
  history.appendChild(sessions);
  item.appendChild(history);
  return item;
}

async function deleteScheduleFromTab(schedule) {
  const state = scheduleActionState(schedule.filePath);
  if (state.deleting) return;
  state.deleting = true;
  const update = () => {
    for (const button of document.querySelectorAll('.schedule-delete-btn')) {
      if (button.closest('.schedule-item').dataset.filepath === schedule.filePath) {
        const focused = document.activeElement === button;
        button.disabled = button.dataset.unavailable === 'true' || state.deleting;
        if (focused && button.disabled) focusScheduleControl(schedule.filePath, button.dataset.scheduleControl);
      }
    }
    restorePendingScheduleFocus();
  };
  update();
  const id = `DeleteSchedule:${schedule.filePath}`;
  try {
    if (!await appConfirm({ title: 'Delete schedule',
      message: `Delete "${schedule.file}"? Past runs stay in Sessions.`, confirmLabel: 'Delete', danger: true })) return;
    const result = await window.api.deleteScheduleFile(schedule.filePath);
    if (!result?.ok) throw new Error(result?.error || 'The backend returned no result');
    clearAppNotice(id);
  } catch (error) {
    showAppNotice({ id, kind: 'error', message: `Could not delete "${schedule.file}": ${error?.message || error}. Check the file and retry Delete in the Schedules tab.` });
  } finally {
    state.deleting = false;
    update();
    if (schedulesVisible) await loadSchedules();
  }
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
