// touched-files-view.js — the "Touched" tab of the file panel — see .ai/contexts/touched-files.md

let touchedContainerEl = null;
let touchedSummaryEl = null;
let touchedListEl = null;
let touchedToggleBtn = null;

const TOUCHED_COVERAGE_TEXT = "Lists only the files this session's file tools (Edit, Write, MultiEdit, NotebookEdit) touched, subagents included. "
  + 'Files changed through Bash commands, scripts or other tools are not listed: this is not the complete set of files the session changed. '
  + 'Changes shows what differs in the working tree.';

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
  if (shown) renderTouchedContent(sessionId, tab);
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
    result = await window.api.sessionTouchedFiles(sessionId);
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
  }
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
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
  openFileTab(sessionId, { filePath, content: result.content });
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

  const stateEl = document.createElement('span');
  stateEl.className = 'touched-file-state touched-state-' + String(file.state).replace(/[^a-z-]/g, '');
  stateEl.textContent = TOUCHED_STATE_LABELS[file.state] || 'unknown';
  rowEl.appendChild(stateEl);

  const pathEl = document.createElement('span');
  pathEl.className = 'touched-file-path';
  pathEl.textContent = file.path;
  rowEl.appendChild(pathEl);
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
  for (const file of data.files || []) touchedListEl.appendChild(buildTouchedFileRow(sessionId, tab, file));
  const unresolved = data.unresolved || [];
  if (unresolved.length > 0) {
    const header = document.createElement('div');
    header.className = 'changes-subagent-header';
    header.textContent = 'Not resolved to a file';
    touchedListEl.appendChild(header);
    for (const entry of unresolved) touchedListEl.appendChild(buildTouchedUnresolvedRow(entry));
  }
}
