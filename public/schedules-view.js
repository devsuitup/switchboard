'use strict';

window.schedulesTabEnabled = SETTING_DEFAULTS.schedulesTab;

window._applySchedulesTab = enabled => {
  const tab = document.querySelector('.sidebar-tab[data-tab="schedules"]');
  tab.hidden = !enabled;
  tab.disabled = !enabled;
  tab.tabIndex = enabled ? 0 : -1;
  if (window.schedulesTabEnabled === enabled) return;
  window.schedulesTabEnabled = enabled;
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
let schedulesPendingTopFocus = null;
const schedulesActions = new Map();
let schedulesData = null;
let schedulesLoadError = null;
let schedulesInFlight = null;
let scheduleHistoryIds = 0;
const schedulesCollapsed = new Set();

const SCHEDULE_ICONS = {
  add: '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1v8M1 5h8"/></svg>',
  play: '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2.5 1.2 9 5l-6.5 3.8z"/></svg>',
  running: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/></svg>',
  done: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>',
  open: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  remove: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
};

const scheduleHealthNotices = new Map();
let scheduleHealthApplied = null;

function scheduleRetryText(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

function scheduleSuspensionText(health) {
  if (!health?.suspended) return null;
  const retry = health.retryMs ? ` Retrying every ${scheduleRetryText(health.retryMs)}.` : '';
  if (health.reason === 'slow') return `Automatic schedules are paused: the background-run records have not been read yet.${retry}`;
  const where = health.path ? ` at ${health.path}` : '';
  const code = health.code ? ` (${health.code})` : health.message ? ` (${health.message})` : '';
  return `Automatic schedules are paused: the background-run records${where} could not be read${code}. Fix their permissions.${retry}`;
}

function scheduleResultFailureText(health) {
  const failure = health?.resultFailure;
  if (!failure) return null;
  const others = failure.count > 1 ? ` (${failure.count - 1} other result${failure.count > 2 ? 's' : ''} also not recorded)` : '';
  return `A schedule result could not be recorded: ${failure.message}${others}`;
}

function showScheduleHealthNotice(id, message) {
  if (scheduleHealthNotices.get(id) === message) return;
  if (message) scheduleHealthNotices.set(id, message); else scheduleHealthNotices.delete(id);
  if (message) showAppNotice({ id, kind: 'error', message });
  else clearAppNotice(id);
}

function applyScheduleHealth(health) {
  if (Number.isFinite(health?.revision) && Number.isFinite(scheduleHealthApplied?.revision) && health.revision < scheduleHealthApplied.revision) return;
  scheduleHealthApplied = health;
  showScheduleHealthNotice('ScheduleSuspended', scheduleSuspensionText(health));
  showScheduleHealthNotice('ScheduleResultFailure', scheduleResultFailureText(health));
}

window.api?.onScheduleHistoryImported?.(() => queueSchedulesReload());
window.api?.onScheduleHealth?.(health => {
  applyScheduleHealth(health);
  queueSchedulesReload();
});
(async () => {
  try {
    const health = await window.api?.getScheduleHealth?.();
    if (health) applyScheduleHealth(health);
  } catch {}
})();

function setSchedulesVisible(visible) {
  schedulesVisible = visible;
  clearTimeout(schedulesTimer);
  schedulesTimer = null;
  clearTimeout(schedulesReloadTimer);
  schedulesReloadTimer = null;
  clearTimeout(schedulesReloadMaxTimer);
  schedulesReloadMaxTimer = null;
  if (!visible) { schedulesRequest++; schedulesProject = null; schedulesPendingFocus = null; schedulesPendingTopFocus = null; return; }
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
  const container = document.getElementById('schedules-content');
  const focused = document.activeElement;
  const row = focused?.matches('.schedule-retry-btn') ? focused.closest('.schedule-item') : null;
  const top = container && !row ? scheduleTopFocus(container) : null;
  const pending = loadSchedules();
  for (const button of document.querySelectorAll('.schedule-retry-btn')) button.disabled = true;
  if (row) focusScheduleControl(row.dataset.filepath, focused.dataset.scheduleControl);
  else if (top?.control === 'schedule-retry-btn') {
    schedulesPendingTopFocus = top;
    container.tabIndex = -1;
    container.focus({ preventScroll: true });
  }
  return pending;
}

function scheduleTopFocus(container) {
  const focused = document.activeElement;
  if (focused === container) return schedulesPendingTopFocus;
  if (!container.contains(focused) || focused.closest('.schedule-item') || !focused.dataset.scheduleControl) return null;
  return { control: focused.dataset.scheduleControl, projectPath: focused.closest('.schedule-project')?.dataset.projectPath ?? null };
}

function restoreScheduleTopFocus(container, target) {
  schedulesPendingTopFocus = null;
  const match = [...container.querySelectorAll('[data-schedule-control]')].find(el => !el.closest('.schedule-item')
    && el.dataset.scheduleControl === target.control && (el.closest('.schedule-project')?.dataset.projectPath ?? null) === target.projectPath);
  const create = container.querySelector('.schedule-create-btn');
  const next = match && !match.disabled ? match : !match && create && !create.disabled ? create : null;
  if (next) {
    next.focus({ preventScroll: true });
    return;
  }
  if (match) schedulesPendingTopFocus = target;
  container.tabIndex = -1;
  container.focus({ preventScroll: true });
}

function scheduleRetryButton(parent) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'schedule-retry-btn settings-action-btn';
  button.dataset.scheduleControl = 'schedule-retry-btn';
  button.textContent = 'Retry';
  button.addEventListener('click', () => retrySchedules());
  parent.appendChild(button);
  return button;
}

function renderSchedulesLoadError() {
  const container = document.getElementById('schedules-content');
  if (!container || !schedulesLoadError) return;
  const top = scheduleTopFocus(container);
  container.querySelector('.schedule-load-error')?.remove();
  if (!schedulesData) container.replaceChildren();
  const box = document.createElement('div');
  box.className = 'schedule-load-error';
  box.setAttribute('role', 'alert');
  scheduleText(box, 'schedule-problems', schedulesData
    ? `Showing the list last loaded at ${new Date(schedulesData.now).toLocaleTimeString()}; the latest refresh failed: ${schedulesLoadError}.`
    : `Schedules could not be loaded: ${schedulesLoadError}.`);
  scheduleRetryButton(box);
  const create = container.querySelector('.schedule-create-btn');
  if (create) create.closest('.schedules-toolbar').after(box);
  else container.prepend(box);
  for (const button of container.querySelectorAll('.schedule-retry-btn')) button.disabled = false;
  if (top) restoreScheduleTopFocus(container, top);
  else schedulesPendingTopFocus = null;
  restorePendingScheduleFocus();
}

function showSchedules(projectPath) {
  if (!window.schedulesTabEnabled) return;
  schedulesProject = projectPath || null;
  document.querySelector('.sidebar-tab[data-tab="schedules"]')?.click();
  loadSchedules();
}

function scheduleClock(date) {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function scheduleDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000) || 1);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function scheduleDay(date, now) {
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function scheduleYesterday(now) {
  const date = new Date(now);
  date.setDate(date.getDate() - 1);
  return date.toDateString();
}

function scheduleAgo(ms, now) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const minutes = Math.floor((now - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (date.toDateString() === new Date(now).toDateString()) return `${Math.floor(minutes / 60)} h ago`;
  return date.toDateString() === scheduleYesterday(now) ? 'yesterday' : scheduleDay(date, now);
}

function scheduleWhen(ms, now) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const day = date.toDateString() === new Date(now).toDateString() ? 'today'
    : date.toDateString() === scheduleYesterday(now) ? 'yesterday' : `${scheduleDay(date, now)},`;
  return `${day} ${scheduleClock(date)}`;
}

function scheduleRelative(ms, now) {
  const date = new Date(ms);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minutes = Math.max(1, Math.ceil((ms - now) / 60000));
  const clock = scheduleClock(date);
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  return ms - now < 3600000 ? `in ${minutes} min`
    : date.toDateString() === new Date(now).toDateString() ? `today ${clock}`
      : date.toDateString() === tomorrow.toDateString() ? `tomorrow ${clock}`
        : ms <= week.getTime() ? `${date.toLocaleDateString('en', { weekday: 'long' })} ${clock}`
          : `${date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })} ${clock}`;
}

function scheduleTime(ms, now) {
  return `${new Date(ms).toLocaleString()} (${scheduleRelative(ms, now)})`;
}

function scheduleOutcomeLook(run) {
  if (run.running) return { kind: 'running', glyph: '\u25cf', short: 'running' };
  const result = run.result;
  const mark = result?.cleanup || result?.warning ? ' \u26a0\ufe0e' : '';
  const look = (kind, glyph, short) => ({ kind, glyph: glyph + mark, short });
  if (result && !result.unreadable) {
    if (result.outcome === 'timed-out') return look('timeout', '\u231b\ufe0e', 'timed out');
    if (result.outcome === 'stopped' || result.outcome === 'signal') return look('stopped', '\u25a0', 'stopped');
    if (result.outcome === 'job-missing') return look('stopped', '\u25a0', 'job lost');
    if (result.outcome === 'refused') return look('failed', '\u2717', 'refused');
    if (result.outcome === 'spawn-error') return look('failed', '\u2717', 'not started');
    if (result.outcome === 'exited' && Number.isInteger(result.exitCode)) {
      return result.exitCode === 0 ? look('ok', '\u2713', '') : look('failed', '\u2717', `exit ${result.exitCode}`);
    }
  }
  return look('unknown', '?', '');
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
  if (run.imported) return 'Result unknown (imported)' + (run.replied === true ? ' — replied' : run.replied === false ? ' — no reply recorded' : '');
  const hint = run.replied === true ? 'replied; exit code unknown'
    : run.replied === null ? 'Unknown'
      : run.messageCount === 1 ? '(refused or not started, run by another instance, run before results were kept, or Switchboard closed during the run)'
        : 'started; no reply recorded';
  return `No result recorded — ${hint}`;
}

function scheduleHistoryNote(data) {
  const parts = [];
  const history = data.history;
  if (history && ['pending', 'waiting', 'running'].includes(history.state)) parts.push('Importing the runs made before v0.0.90; they appear here as each project is read.');
  if (history?.state === 'failed') parts.push(`The runs made before v0.0.90 could not be imported (${history.error}); Switchboard retries within a few minutes while this tab is open, and at the next launch.`);
  if (history?.unattributed > 0) {
    parts.push(`${history.unattributed} session${history.unattributed === 1 ? ' starts' : 's start'} like a scheduled run but could not be attributed to a schedule reliably, so ${history.unattributed === 1 ? 'it is' : 'they are'} not listed; ${history.unattributed === 1 ? 'it stays' : 'they stay'} in Sessions.`);
  }
  const runs = data.projects.flatMap(project => project.schedules.flatMap(schedule => schedule.runs || []));
  if (runs.some(run => !run.running && !run.result)) parts.push('Runs made before v0.0.104, runs of another instance and runs alive when Switchboard closed have no result recorded.');
  return parts.length ? parts.join(' ') : null;
}

function scheduleText(parent, className, text) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function scheduleSpan(parent, className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function setScheduleHistoryOpen(item, open) {
  item.querySelector('.schedule-last').setAttribute('aria-expanded', String(open));
  item.querySelector('.schedule-history').hidden = !open;
}

function scheduleHistoryOpen(item) {
  return item.querySelector('.schedule-last').getAttribute('aria-expanded') === 'true';
}

function buildScheduleProjectHeader(project, data) {
  const header = document.createElement('div');
  header.className = 'project-header';
  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.className = 'arrow schedule-collapse-btn';
  collapse.dataset.scheduleControl = 'schedule-collapse-btn';
  collapse.textContent = '\u25bc';
  collapse.setAttribute('aria-label', `Schedules of ${project.shortName}`);
  const paint = () => {
    const collapsed = schedulesCollapsed.has(project.projectPath);
    header.classList.toggle('collapsed', collapsed);
    collapse.setAttribute('aria-expanded', String(!collapsed));
  };
  header.appendChild(collapse);
  if (project.remoteAlias) {
    const host = typeof remoteHostLabel === 'function' ? remoteHostLabel(project.remoteAlias) : project.remoteAlias;
    scheduleSpan(header, 'remote-badge', host).title = `Project on ${host}`;
  }
  scheduleSpan(header, 'project-name', project.shortName).title = project.projectPath;
  scheduleSpan(header, 'schedule-count', String(project.schedules.length));
  scheduleSpan(header, 'schedule-header-spacer', '');
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'project-new-btn';
  add.dataset.scheduleControl = 'schedule-new-btn';
  add.innerHTML = SCHEDULE_ICONS.add;
  add.disabled = !!project.archived;
  add.title = project.archived ? 'Unarchive this project to add a schedule' : `New schedule in ${project.shortName}`;
  add.setAttribute('aria-label', add.title);
  add.addEventListener('click', () => openScheduleCreateForm(data.projects, project.projectPath));
  header.appendChild(add);
  header.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button && button !== collapse) return;
    if (!schedulesCollapsed.delete(project.projectPath)) schedulesCollapsed.add(project.projectPath);
    paint();
  });
  paint();
  return header;
}

function scheduleCountText(data) {
  const schedules = data.projects.flatMap(project => project.schedules);
  if (!schedules.length) return '';
  const on = schedules.filter(schedule => schedule.enabled).length;
  const running = schedules.filter(schedule => schedule.runs.some(run => run.running)).length;
  return `${schedules.length} schedule${schedules.length === 1 ? '' : 's'} · ${on} on${running ? ` · ${running} running` : ''}`;
}

function renderSchedules(data) {
  const container = document.getElementById('schedules-content');
  if (!container) return;
  const rows = [...container.querySelectorAll('.schedule-item')];
  const openHistory = new Map(rows.map(row => [row.dataset.filepath, scheduleHistoryOpen(row)]));
  const focused = document.activeElement;
  const focusedRow = focused?.closest('.schedule-item');
  const focusedPath = container.contains(focusedRow) ? focusedRow.dataset.filepath : null;
  const focusedControl = focused?.dataset.scheduleControl || (focusedPath === schedulesPendingFocus?.filePath ? schedulesPendingFocus.control : null);
  const topFocus = focusedPath ? null : scheduleTopFocus(container);
  const projectFocus = schedulesProject;
  schedulesProject = null;
  schedulesPendingTopFocus = null;
  schedulesData = data;
  container.replaceChildren();
  if (projectFocus) schedulesCollapsed.delete(projectFocus);
  const toolbar = document.createElement('div');
  toolbar.className = 'schedules-toolbar';
  scheduleSpan(toolbar, 'schedules-count', scheduleCountText(data));
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'schedule-create-btn';
  create.dataset.scheduleControl = 'schedule-create-btn';
  create.innerHTML = SCHEDULE_ICONS.add;
  scheduleSpan(create, 'schedule-create-label', 'New schedule');
  const creatable = data.projects.some(project => !project.archived);
  create.disabled = !creatable;
  create.addEventListener('click', () => openScheduleCreateForm(data.projects));
  toolbar.appendChild(create);
  container.appendChild(toolbar);
  const prerequisite = !data.projects.length ? 'No registered project. Add a local project from Sessions, then return here.'
    : !creatable ? 'Every registered project is archived. Unarchive a project in Settings → Archived, then return here.' : null;
  if (prerequisite) {
    const hint = scheduleText(container, 'schedule-prerequisite', prerequisite);
    hint.id = 'schedule-create-prerequisite';
    create.setAttribute('aria-describedby', hint.id);
    create.title = prerequisite;
  }
  const historyNote = scheduleHistoryNote(data);
  if (historyNote) scheduleText(container, 'schedule-help schedule-banner', historyNote).setAttribute('role', 'status');
  if (data.health) applyScheduleHealth(data.health);
  const health = data.health ? scheduleHealthApplied : null;
  for (const text of [scheduleSuspensionText(health), scheduleResultFailureText(health)]) {
    if (!text) continue;
    const banner = document.createElement('div');
    banner.className = 'schedule-banner schedule-banner--error schedule-health';
    banner.setAttribute('role', 'alert');
    scheduleText(banner, 'schedule-problems', text);
    container.appendChild(banner);
  }
  let count = 0;
  for (const project of data.projects) {
    if (!project.schedules.length && !project.scanError) continue;
    count += project.schedules.length;
    const group = document.createElement('section');
    group.className = 'project-group schedule-project';
    group.dataset.projectPath = project.projectPath;
    const list = document.createElement('div');
    list.className = 'project-sessions';
    group.append(buildScheduleProjectHeader(project, data), list);
    if (project.scanError) {
      const scan = document.createElement('div');
      scan.className = 'schedule-scan-error';
      scheduleText(scan, 'schedule-problems', `Could not read .claude/commands${project.scanError.code ? ` (${project.scanError.code})` : ''}: ${project.scanError.message}. Its schedules are not listed. Check the folder's permissions and path, then Retry.`);
      scheduleRetryButton(scan);
      list.appendChild(scan);
    }
    for (const schedule of project.schedules) {
      const item = buildScheduleItem(project, schedule, data);
      setScheduleHistoryOpen(item, openHistory.get(schedule.filePath) || false);
      list.appendChild(item);
    }
    container.appendChild(group);
    if (projectFocus === project.projectPath) {
      group.tabIndex = -1;
      group.focus({ preventScroll: true });
      group.scrollIntoView?.({ block: 'start' });
    }
  }
  if (!count && creatable && !data.projects.some(project => project.scanError)) scheduleText(container, 'plans-empty', 'No schedules found. Use New schedule to add one.');
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
  if (!projectFocus && topFocus) restoreScheduleTopFocus(container, topFocus);
  const paths = new Set(data.projects.flatMap(project => project.schedules.map(schedule => schedule.filePath)));
  for (const [filePath, state] of schedulesActions) {
    if (!paths.has(filePath) && state.run !== 'running' && !state.toggling && !state.deleting) schedulesActions.delete(filePath);
  }
}

function openScheduleCreateForm(projects, projectPath = null) {
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
  project.value = (projects.find(entry => !entry.archived && entry.projectPath === projectPath) || projects.find(entry => !entry.archived))?.projectPath || '';
  const focusOpener = () => {
    const group = projectPath && [...document.querySelectorAll('#schedules-content .schedule-project')].find(el => el.dataset.projectPath === projectPath);
    ((group && group.querySelector('.project-new-btn:not(:disabled)')) || document.querySelector('.schedule-create-btn'))?.focus();
  };
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
    focusOpener();
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
      focusOpener();
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
  else if (control) control.focus({ preventScroll: true });
  else {
    const container = document.getElementById('schedules-content');
    const create = container?.querySelector('.schedule-create-btn');
    const next = row?.querySelector('.schedule-actions button:not(:disabled)') || (create && !create.disabled ? create : container);
    if (next === container && container) container.tabIndex = -1;
    next?.focus({ preventScroll: true });
  }
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
    const live = button.dataset.live === 'true' && !state.run;
    const icon = state.run === 'running' || live ? 'running' : state.run === 'done' ? 'done' : 'play';
    button.classList.toggle('live', live);
    if (button.dataset.icon !== icon) {
      button.dataset.icon = icon;
      button.innerHTML = SCHEDULE_ICONS[icon];
    }
    const unavailable = button.dataset.unavailable === 'true';
    button.title = state.run === 'running' ? 'Running...' : state.run === 'done' ? 'Launched!'
      : live && !unavailable ? 'Run now — a run is in progress' : button.dataset.reason;
    button.setAttribute('aria-label', unavailable && !state.run ? `Run now — ${button.title}` : button.title);
    if (focused && button.disabled) focusScheduleControl(filePath, button.dataset.scheduleControl);
  }
  restorePendingScheduleFocus();
}

function schedulePathSegments(value, windows) {
  const segments = [];
  const floor = windows && /^[\\/]{2}/.test(String(value)) ? 3 : 1;
  (windows ? String(value).replace(/\\/g, '/') : String(value)).split('/').forEach((segment, index) => {
    if (segment === '..') { if (segments.length > floor) segments.pop(); }
    else if (segment !== '.' && (segment !== '' || index === 0)) segments.push(segment);
  });
  return segments;
}

function schedulePathLabel(projectPath, filePath) {
  if (!projectPath) return filePath;
  const windows = [projectPath, filePath].some(value => /^([A-Za-z]:|\\\\)/.test(String(value)));
  const same = (a, b) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  const root = schedulePathSegments(projectPath, windows);
  const file = schedulePathSegments(filePath, windows);
  if (file.length <= root.length || !root.every((segment, index) => same(segment, file[index]))) return filePath;
  return file.slice(root.length).join(windows && String(filePath).includes('\\') ? '\\' : '/');
}

function scheduleBadge(parent, kind, text, title) {
  const badge = scheduleSpan(parent, kind === 'bg' ? 'bg-badge' : `schedule-badge schedule-badge--${kind}`, text);
  badge.title = title;
  return badge;
}

function buildScheduleItem(project, schedule, data) {
  const item = document.createElement('article');
  item.className = 'schedule-item';
  item.tabIndex = -1;
  item.dataset.filepath = schedule.filePath;
  const readError = schedule.readError;
  const fatal = schedule.problems.filter(p => !p.startsWith('slug shared with '));
  const suspended = !!data.health && !!scheduleHealthApplied?.suspended;
  const live = schedule.runs.find(run => run.running);
  const [kind, short, state] = project.archived ? ['suspended', 'Suspended — project archived', 'Suspended — project archived']
    : readError ? ['problem', 'Unknown: the file could not be read', 'Unknown: the file could not be read']
      : !schedule.enabled ? ['off', 'Off', 'Disabled']
        : fatal.length ? ['problem', `Never runs: ${fatal.join('; ')}`, `Never runs: ${fatal.join('; ')}`]
          : schedule.nextRunMs === null ? ['problem', 'No run within a year', 'No run within a year']
            : suspended ? ['suspended', 'Paused', `Paused: automatic launches are suspended (next run due ${scheduleTime(schedule.nextRunMs, data.now)})`]
              : ['armed', scheduleRelative(schedule.nextRunMs, data.now), `Next run: ${scheduleTime(schedule.nextRunMs, data.now)}`];
  item.classList.toggle('off', kind === 'off' || kind === 'suspended');
  const row = document.createElement('div');
  row.className = 'schedule-row';
  item.appendChild(row);
  const icon = scheduleSpan(row, `schedule-icon schedule-icon--${live ? 'running' : kind}`, '');
  icon.setAttribute('role', 'img');
  icon.title = live ? 'Running' : { armed: 'On', off: 'Off', problem: 'Never runs or unknown', suspended: 'Suspended' }[kind];
  icon.setAttribute('aria-label', icon.title);
  const summary = document.createElement('div');
  summary.className = 'schedule-summary';
  summary.title = `${schedule.name}\n${schedule.filePath}`;
  row.appendChild(summary);
  if (schedule.runAsBackground && !project.remoteAlias && !project.sandboxed) scheduleBadge(summary, 'bg', 'bg', 'Background session: can be joined while it runs');
  scheduleSpan(summary, 'schedule-name', schedule.name);
  const meta = document.createElement('div');
  meta.className = 'schedule-meta';
  const next = scheduleSpan(meta, `schedule-next ${live ? 'running' : kind}`, live ? `Running · ${scheduleDuration(data.now - Date.parse(live.created))}` : short);
  next.title = live ? `Started ${new Date(live.created).toLocaleString()}; ${state}` : state;
  const cadence = scheduleSpan(meta, 'schedule-cadence', readError || !schedule.cron ? 'Schedule unknown' : schedule.cronText || String(schedule.cron));
  if (!readError && schedule.cron) cadence.title = String(schedule.cron);
  const pills = document.createElement('span');
  pills.className = 'schedule-pills';
  if (schedule.runAsBackground && project.remoteAlias) scheduleBadge(pills, 'muted', 'bg', 'Background option ignored: local schedules only');
  else if (schedule.runAsBackground && project.sandboxed) scheduleBadge(pills, 'muted', 'bg', 'Background unavailable under sandbox: runs headless');
  if (schedule.linked) scheduleBadge(pills, 'linked', 'linked', 'linked file: edit it at its source');
  if (schedule.catchUp) {
    if (!data.catchUpActive) scheduleBadge(pills, 'muted', 'catch-up', 'catch-up off in this instance');
    else if (schedule.catchUpDueMs != null) {
      const due = new Date(schedule.catchUpDueMs);
      scheduleBadge(pills, 'pending', `catch-up ${scheduleClock(due)}`, `Catch-up pending: due ${due.toLocaleString()}`);
    } else scheduleBadge(pills, 'catchup', 'catch-up', 'Catch-up on');
  }
  if (pills.childElementCount) meta.appendChild(pills);
  const problem = text => {
    const el = scheduleText(row, 'schedule-problem', '');
    scheduleSpan(el, 'schedule-problem-text', text);
    return el;
  };
  const actions = document.createElement('div');
  actions.className = 'schedule-actions';
  const unread = !!readError || schedule.problems.some(p => p.startsWith('front matter not read'));
  const unreadReason = readError ? 'the file could not be read' : 'front matter not read';
  const actionState = scheduleActionState(schedule.filePath);
  row.append(actions, meta);
  const listed = !live && kind === 'problem' && fatal.length && !readError ? schedule.problems.filter(p => !fatal.includes(p)) : schedule.problems;
  if (listed.length) problem(listed.join('; '));
  if (readError) scheduleRetryButton(problem(`${readError.message}. Check the file's permissions and path, then Retry.`));
  if (!project.known) problem('not a known project');
  const action = (cls, label, disabled, reason, handler, look, iconName, name = label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${cls} ${look}`;
    btn.dataset.scheduleControl = cls;
    btn.dataset.unavailable = String(disabled);
    btn.dataset.reason = disabled ? reason : label;
    if (iconName) btn.innerHTML = SCHEDULE_ICONS[iconName];
    btn.setAttribute('aria-label', disabled ? `${name} — ${reason}` : name);
    btn.title = disabled ? reason : label;
    btn.disabled = disabled;
    btn.addEventListener('click', handler);
    actions.appendChild(btn);
    return btn;
  };
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
    }, 'schedule-switch', null, 'Enabled');
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(schedule.enabled === true));
  toggle.disabled ||= !!actionState.toggling;
  const play = action('schedule-run-btn', 'Run now', !project.known || unread,
    !project.known ? 'not a known project' : unreadReason, () => runScheduleFromTab(schedule, play), 'schedule-play-btn', 'play');
  play.dataset.live = String(!!live);
  updateScheduleRunButtons(schedule.filePath, play);
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
  }, 'schedule-icon-btn', 'open');
  const remove = action('schedule-delete-btn', 'Delete', schedule.linked,
    'linked file: edit it at its source', () => deleteScheduleFromTab(schedule), 'schedule-icon-btn', 'remove');
  remove.disabled ||= !!actionState.deleting;
  const history = document.createElement('div');
  history.className = 'schedule-history';
  history.id = `schedule-history-${++scheduleHistoryIds}`;
  history.hidden = true;
  const runs = schedule.runs.slice(0, 20);
  const shown = runs.find(run => !run.running) || runs[0];
  const last = document.createElement('button');
  last.type = 'button';
  last.dataset.scheduleControl = 'history-summary';
  last.setAttribute('aria-controls', history.id);
  last.setAttribute('aria-expanded', 'false');
  const look = shown && scheduleOutcomeLook(shown);
  last.className = `schedule-last outcome-${look ? look.kind : 'unknown'}`;
  last.textContent = look ? `${look.glyph} ${[look.short, scheduleAgo(Date.parse(shown.created), data.now)].filter(Boolean).join(' · ')}` : 'no run yet';
  last.title = shown ? `Last run: ${new Date(shown.created).toLocaleString()} — ${scheduleOutcome(shown)}` : 'No recorded run';
  last.setAttribute('aria-label', last.title);
  last.addEventListener('click', () => setScheduleHistoryOpen(item, !scheduleHistoryOpen(item)));
  meta.appendChild(last);
  for (const run of runs) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'schedule-history-run';
    entry.dataset.scheduleControl = `history:${run.sessionId}`;
    const outcome = scheduleOutcome(run);
    entry.title = `${new Date(run.created).toLocaleString()} — ${outcome}`;
    const runLook = scheduleOutcomeLook(run);
    scheduleSpan(entry, 'schedule-run-when', scheduleWhen(Date.parse(run.created), data.now));
    const what = scheduleSpan(entry, `schedule-run-what outcome-${runLook.kind}`, '');
    scheduleSpan(what, 'schedule-run-glyph', `${runLook.glyph} `).setAttribute('aria-hidden', 'true');
    scheduleSpan(what, 'schedule-run-text', run.imported ? outcome.replace(' (imported)', '') : outcome);
    if (run.imported) scheduleSpan(what, 'archived-badge', 'imported');
    entry.addEventListener('click', () => openScheduleRun(project, schedule, run));
    history.appendChild(entry);
  }
  if (!runs.length) scheduleText(history, 'schedule-run-none', 'No recorded run');
  const foot = document.createElement('div');
  foot.className = 'schedule-history-foot';
  scheduleSpan(foot, 'schedule-path', schedulePathLabel(project.projectPath, schedule.filePath)).title = schedule.filePath;
  const sessions = document.createElement('button');
  sessions.type = 'button';
  sessions.className = 'schedule-history-sessions';
  sessions.dataset.scheduleControl = 'sessions';
  sessions.textContent = 'Show in Sessions';
  sessions.title = 'Show history in Sessions';
  sessions.disabled = !!readError;
  sessions.addEventListener('click', () => showScheduleSessions(project.projectPath, schedule.slug, schedule.runs.map(run => run.sessionId)));
  foot.appendChild(sessions);
  history.appendChild(foot);
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
