// touched-files-view.js — the "Touched" tab of the file panel — see .ai/contexts/touched-files.md
/* exported initTouchedView, renderTouchedTab, hideTouchedView */

let touchedContainerEl = null;
let touchedSummaryEl = null;
let touchedListEl = null;
let touchedToggleBtn = null;

const TOUCHED_COVERAGE_TEXT = "Lists only the files this session's file tools (Edit, Write, MultiEdit, NotebookEdit) touched, subagents included. "
  + 'Files changed through Bash commands, scripts or other tools are not listed: this is not the complete set of files the session changed. '
  + 'Changes shows what differs in the working tree.';

const TOUCHED_WINDOW_DAYS = 1;
const TOUCHED_WINDOW_STEP_DAYS = 10;
const TOUCHED_DAY_MS = 24 * 60 * 60 * 1000;
const TOUCHED_RELATIVE_THRESHOLD_MS = TOUCHED_DAY_MS;
const TOUCHED_MINUTE_MS = 60 * 1000;

function formatTouchedTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return 'Time unknown';
  const age = Math.max(0, now - timestamp);
  if (age >= TOUCHED_RELATIVE_THRESHOLD_MS) return new Date(timestamp).toLocaleString();
  if (age < TOUCHED_MINUTE_MS) return 'Just now';
  if (age < 60 * TOUCHED_MINUTE_MS) return `${Math.floor(age / TOUCHED_MINUTE_MS)} min ago`;
  return `${Math.floor(age / (60 * TOUCHED_MINUTE_MS))} hr ago`;
}

const TOUCHED_STATE_LABELS = {
  present: 'present',
  gone: 'gone',
  refused: 'refused',
  unreadable: 'unreadable',
  'not-file': 'not a file',
};

const TOUCHED_STATE_TITLES = {
  present: 'On disk now. Click to open it in the file viewer.',
  gone: 'This file no longer exists on disk.',
  refused: 'Not opened: this path is in a protected location.',
  unreadable: 'Could not be read from disk.',
  'not-file': 'Not a regular file.',
};

const TOUCHED_UNRESOLVED_REASONS = {
  'relative-no-cwd': "relative path, and the session's working directory could not be verified",
  invalid: 'not a usable path',
  'control-character': 'contains a control character',
  'home-relative': 'starts with ~, not resolved',
  'unsupported-form': 'network or device path, not followed',
  'drive-relative': 'drive-relative path, not resolved',
  'rooted-no-drive': 'no drive letter, not resolved',
};

function initTouchedView(parentEl) {
  touchedContainerEl = document.createElement('div');
  touchedContainerEl.id = 'file-panel-touched';
  touchedContainerEl.style.display = 'none';
  parentEl.appendChild(touchedContainerEl);

  const toolbar = document.createElement('div');
  toolbar.className = 'viewer-toolbar';
  const info = document.createElement('div');
  info.className = 'viewer-toolbar-info';
  const title = document.createElement('span');
  title.className = 'viewer-toolbar-title';
  title.textContent = 'Touched files';
  info.appendChild(title);
  toolbar.appendChild(info);

  const controls = document.createElement('div');
  controls.className = 'viewer-toolbar-controls';
  const sort = document.createElement('select');
  sort.id = 'touched-sort';
  sort.setAttribute('aria-label', 'Sort touched files');
  for (const [value, label] of [['time', 'Last touch'], ['path', 'Path']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    sort.appendChild(option);
  }
  sort.addEventListener('change', () => {
    const tab = filePanelState.get(currentPanelSessionId)?.currentTab;
    if (tab?.type !== 'touched') return;
    tab.sort = sort.value;
    renderTouchedContent(currentPanelSessionId, tab);
  });
  controls.appendChild(sort);
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'icon-btn';
  refreshBtn.id = 'touched-refresh-btn';
  refreshBtn.title = 'Read the transcripts again';
  refreshBtn.setAttribute('aria-label', refreshBtn.title);
  refreshBtn.innerHTML = FP_ICONS.refresh;
  refreshBtn.addEventListener('click', () => {
    if (currentPanelSessionId) refreshTouched(currentPanelSessionId);
  });
  controls.appendChild(refreshBtn);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'icon-btn fp-close-btn';
  closeBtn.innerHTML = FP_ICONS.close;
  closeBtn.title = 'Close panel';
  closeBtn.addEventListener('click', handleClose);
  controls.appendChild(closeBtn);
  toolbar.appendChild(controls);
  touchedContainerEl.appendChild(toolbar);

  const coverage = document.createElement('div');
  coverage.id = 'touched-coverage';
  coverage.textContent = TOUCHED_COVERAGE_TEXT;
  touchedContainerEl.appendChild(coverage);

  touchedSummaryEl = document.createElement('div');
  touchedSummaryEl.id = 'touched-summary';
  touchedContainerEl.appendChild(touchedSummaryEl);

  touchedListEl = document.createElement('div');
  touchedListEl.id = 'touched-list';
  touchedContainerEl.appendChild(touchedListEl);

  touchedToggleBtn = createHeaderToggle({
    id: 'touched-toggle-btn',
    label: 'Touched',
    title: "Show the files this session's file tools touched",
    icon: 'touched',
    onClick: () => {
      if (currentPanelSessionId) toggleTouchedTab(currentPanelSessionId);
    },
  });
}

function hideTouchedView() {
  if (touchedContainerEl) touchedContainerEl.style.display = 'none';
  setHeaderToggle(touchedToggleBtn, false);
}

function renderTouchedTab(sessionId, tab) {
  if (!touchedContainerEl) return;
  const shown = !!tab && tab.type === 'touched';
  touchedContainerEl.style.display = shown ? 'flex' : 'none';
  setHeaderToggle(touchedToggleBtn, shown);
  if (shown) {
    renderTouchedContent(sessionId, tab);
    window.restorePanelListScroll(touchedListEl, tab);
  }
}

function toggleTouchedTab(sessionId) {
  const state = getSessionState(sessionId);
  if (state.currentTab && state.currentTab.type === 'touched') {
    state.currentTab = null;
    endCurrentTab(sessionId, state);
    return;
  }
  return openTouchedTab(sessionId);
}

function openTouchedTab(sessionId) {
  const state = getSessionState(sessionId);
  destroyCurrentTab(state);
  state.currentTab = {
    type: 'touched',
    label: 'Touched files',
    loading: true,
    error: null,
    data: null,
    openError: null,
    opening: false,
    windowDays: TOUCHED_WINDOW_DAYS,
    windowStart: Date.now() - TOUCHED_WINDOW_DAYS * TOUCHED_DAY_MS,
    sort: 'time',
  };
  state.panelVisible = true;
  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
  return refreshTouched(sessionId);
}

async function refreshTouched(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'touched') return;
  const tab = state.currentTab;

  tab.loading = true;
  tab.openError = null;
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);

  let result;
  try {
    result = await window.api.sessionTouchedFiles(sessionId, { windowDays: tab.windowDays });
  } catch (err) {
    result = { ok: false, error: (err && err.message) || 'failed to read the transcripts' };
  }

  tab.loading = false;
  if (!result || result.ok === false) {
    tab.error = (result && result.error) || 'failed to read the transcripts';
    tab.data = null;
  } else {
    tab.error = null;
    tab.data = result;
    if (Number.isFinite(result.windowStart)) tab.windowStart = result.windowStart;
  }
  if (currentPanelSessionId === sessionId && state.currentTab === tab) renderPanel(sessionId);
}

async function openTouchedFile(sessionId, tab, filePath) {
  if (tab.opening) return;
  tab.opening = true;
  let result;
  try {
    result = await window.api.readFileForPanel(filePath);
  } catch (err) {
    result = { ok: false, error: (err && err.message) || 'could not read the file' };
  }
  tab.opening = false;
  const state = filePanelState.get(sessionId);
  if (!state || state.currentTab !== tab) return;
  if (!result || !result.ok) {
    tab.openError = `${filePath}: ${(result && result.error) || 'could not read the file'}`;
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }
  tab.selection = filePath;
  for (const row of touchedListEl.querySelectorAll('.touched-file-row')) row.classList.toggle('selected', row.dataset.path === filePath);
  openFileTab(sessionId, { filePath, content: result.content, returnList: tab });
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function touchedSummaryText(tab) {
  if (tab.loading && !tab.data) return 'Reading the transcripts…';
  if (tab.error) return tab.error;
  const data = tab.data;
  if (!data) return '';
  const files = data.files || [];
  const total = files.length + (data.omitted || 0);
  const parts = [];
  if (total === 0 && (data.unresolved || []).length === 0) {
    parts.push('No files touched by the file tools');
  } else {
    parts.push(`${plural(total, 'file', 'files')} touched`);
  }
  const coverage = data.coverage || {};
  if (coverage.subagents > 0) parts.push(`including ${plural(coverage.subagents, 'subagent', 'subagents')}`);
  if (data.omitted > 0) parts.push(`+${data.omitted} more not shown`);
  if (coverage.malformedLines > 0) parts.push(`${plural(coverage.malformedLines, 'unreadable line', 'unreadable lines')} skipped`);
  if (coverage.skippedLines > 0) parts.push(`${plural(coverage.skippedLines, 'oversized line', 'oversized lines')} skipped`);
  if (coverage.truncated) parts.push('read only part of a very large transcript');
  return parts.join(' · ');
}

function appendTouchedMeta(rowEl, entry) {
  const meta = document.createElement('span');
  meta.className = 'touched-file-meta';
  const tools = Array.isArray(entry.tools) ? entry.tools.join(', ') : '';
  const sources = Array.isArray(entry.sources) ? entry.sources.join(' · ') : '';
  meta.textContent = [tools, entry.count > 1 ? `×${entry.count}` : '', sources].filter(Boolean).join('  ');
  rowEl.appendChild(meta);
}

function buildTouchedFileRow(sessionId, tab, file) {
  const rowEl = document.createElement('div');
  rowEl.className = 'touched-file-row';
  rowEl.dataset.path = file.path;
  const openable = file.openable === true && file.state === 'present';
  if (openable) rowEl.classList.add('touched-openable');
  rowEl.title = TOUCHED_STATE_TITLES[file.state] || 'State unknown.';
  if (Number.isFinite(file.diskMtime)) rowEl.title += ' Modified: ' + new Date(file.diskMtime).toLocaleString();
  rowEl.classList.toggle('selected', tab.selection === file.path);

  const stateEl = document.createElement('span');
  stateEl.className = 'touched-file-state touched-state-' + String(file.state).replace(/[^a-z-]/g, '');
  stateEl.textContent = TOUCHED_STATE_LABELS[file.state] || 'unknown';
  rowEl.appendChild(stateEl);

  const pathEl = document.createElement('span');
  pathEl.className = 'touched-file-path';
  pathEl.textContent = file.path;
  rowEl.appendChild(pathEl);
  const when = document.createElement('span');
  when.className = 'touched-file-time';
  when.textContent = formatTouchedTime(file.lastTouched);
  rowEl.appendChild(when);
  appendTouchedMeta(rowEl, file);

  if (openable) rowEl.addEventListener('click', () => openTouchedFile(sessionId, tab, file.path));
  return rowEl;
}

function buildTouchedUnresolvedRow(entry) {
  const rowEl = document.createElement('div');
  rowEl.className = 'touched-unresolved-row';
  rowEl.title = 'Not resolved to a file, so it cannot be opened.';

  const pathEl = document.createElement('span');
  pathEl.className = 'touched-file-path';
  pathEl.textContent = entry.raw;
  rowEl.appendChild(pathEl);

  const reason = document.createElement('span');
  reason.className = 'touched-file-state touched-state-unresolved';
  reason.textContent = TOUCHED_UNRESOLVED_REASONS[entry.reason] || 'not resolved';
  rowEl.appendChild(reason);
  appendTouchedMeta(rowEl, entry);
  return rowEl;
}

function renderTouchedContent(sessionId, tab) {
  const signature = [tab.data, tab.loading, tab.error, tab.openError, tab.sort, tab.windowStart];
  document.getElementById('touched-sort').value = tab.sort;
  if (window.reusePanelList(touchedListEl, touchedSummaryEl, tab, signature)) return;
  touchedSummaryEl.textContent = touchedSummaryText(tab);
  if (tab.openError) {
    const err = document.createElement('div');
    err.className = 'changes-error';
    err.textContent = tab.openError;
    touchedSummaryEl.appendChild(err);
  }

  touchedListEl.innerHTML = '';
  const data = tab.data;
  if (!data) return;
  const cachedFiles = data.cachedFiles || data.files || [];
  const visible = cachedFiles.filter(f => f.lastTouched == null || f.lastTouched >= tab.windowStart);
  visible.sort(tab.sort === 'path'
    ? (a, b) => a.path.localeCompare(b.path)
    : (a, b) => (b.lastTouched ?? -Infinity) - (a.lastTouched ?? -Infinity) || a.path.localeCompare(b.path));
  for (const file of visible) touchedListEl.appendChild(buildTouchedFileRow(sessionId, tab, file));
  const hidden = cachedFiles.length - visible.length + (data.cachedFiles ? 0 : (data.olderFiles || 0));
  if (hidden > 0) touchedSummaryEl.appendChild(document.createTextNode(` · ${plural(hidden, 'older file', 'older files')} hidden`));
  if (data.hasOlder) touchedSummaryEl.appendChild(document.createTextNode(' · Older files not counted yet'));
  const unresolved = (data.cachedUnresolved || data.unresolved || []).filter(f => f.lastTouched == null || f.lastTouched >= tab.windowStart);
  if (unresolved.length > 0) {
    const header = document.createElement('div');
    header.className = 'changes-subagent-header';
    header.textContent = 'Not resolved to a file';
    touchedListEl.appendChild(header);
    for (const entry of unresolved) touchedListEl.appendChild(buildTouchedUnresolvedRow(entry));
  }
  if (hidden > 0 || data.hasOlder) {
    const more = document.createElement('button');
    more.id = 'touched-more-btn';
    more.className = 'viewer-toolbar-btn';
    more.textContent = `Show ${TOUCHED_WINDOW_STEP_DAYS} more days`;
    more.addEventListener('click', () => extendTouchedWindow(sessionId, tab));
    touchedListEl.appendChild(more);
  }
}

function extendTouchedWindow(sessionId, tab) {
  if (tab.loading || filePanelState.get(sessionId)?.currentTab !== tab) return;
  tab.windowDays += TOUCHED_WINDOW_STEP_DAYS;
  tab.windowStart -= TOUCHED_WINDOW_STEP_DAYS * TOUCHED_DAY_MS;
  const older = [tab.data?.nextOlderTimestamp, ...(tab.data?.cachedFiles || tab.data?.files || []).map(f => f.lastTouched), ...(tab.data?.cachedUnresolved || []).map(f => f.lastTouched)]
    .filter(value => Number.isFinite(value) && value < tab.windowStart + TOUCHED_WINDOW_STEP_DAYS * TOUCHED_DAY_MS);
  const newestOlder = older.length ? Math.max(...older) : null;
  if (newestOlder != null && newestOlder < tab.windowStart) {
    const anchor = tab.windowStart + tab.windowDays * TOUCHED_DAY_MS;
    tab.windowDays = Math.ceil((anchor - newestOlder) / TOUCHED_DAY_MS);
    tab.windowStart = anchor - tab.windowDays * TOUCHED_DAY_MS;
  }
  const loaded = tab.data?.loadedWindowStart;
  if (tab.data?.hasOlder && (loaded == null || tab.windowStart < loaded)) return refreshTouched(sessionId);
  renderTouchedContent(sessionId, tab);
}
