/**
 * file-panel.js — Renderer-side file/diff side panel for Switchboard.
 *
 * Manages a collapsible panel to the right of the terminal that shows
 * files and diffs received from the MCP bridge.
 *
 * Files open in the Touched tab (touched-files-view.js) and the Changes tab.
 * For diffs: uses its own MergeView rendering with accept/reject.
 *
 * Globals expected: window.api,
 *   window.createMergeViewer, window.createUnifiedMergeViewer,
 *   window.createViewerToolbar, openSessions (from app.js)
 */

/* exported openTouchedEditor */

// ── Per-Session State ───────────────────────────────────────────────

const filePanelState = new Map();

// ── DOM References ──────────────────────────────────────────────────

let filePanelEl = null;
let filePanelContentEl = null;
let filePanelResizeHandle = null;
let terminalSplitEl = null;
let currentPanelSessionId = null;
let panelBackBtn = null;

// Diff-specific DOM
let diffToolbarEl = null;
let diffBodyEl = null;
let diffActionsEl = null;
let diffToggleBtn = null;

// Changes-specific DOM (issue #251)
let changesContainerEl = null;
let changesSummaryEl = null;
let changesListEl = null;
let changesDiffEl = null;
let changesToggleBtn = null;
let changesDiffTitleEl = null;
let changesDiffModeBtn = null;
let changesDiffFormatBtn = null;
let changesDiffSaveBtn = null;
let changesDiffReloadBtn = null;
let changesDiffNoticeEl = null;
let changesDiffHostEl = null;
let changesDiffPreviewEl = null;
let changesPreviewTab = null;
let changesListSplitterEl = null;

// Row ceiling for the Changes list — see .ai/contexts/changes-view.md ("Untracked files")
const MAX_CHANGES_ROWS = 500;
const MAX_SUBAGENT_GROUP_ROWS = 100;

const CHANGES_LIST_HEIGHT_KEY = 'changesListHeight';
const DEFAULT_CHANGES_LIST_HEIGHT = 200;
const TOUCHED_LIST_RATIO_KEY = 'touchedListRatio';
const DEFAULT_TOUCHED_LIST_RATIO = 0.4;
let touchedListRatio = readStoredTouchedListRatio();
const TOUCHED_MARKDOWN_FORMATTED_KEY = 'touchedMarkdownFormatted';
const DEFAULT_TOUCHED_MARKDOWN_FORMATTED = true;
// see .ai/contexts/changes-view.md ("The list and the editor")
const MIN_CHANGES_LIST_HEIGHT = 96;
const MIN_CHANGES_EDITOR_HEIGHT = 120;
let changesListDesiredHeight = readStoredChangesListHeight();

// see .ai/contexts/changes-view.md ("Not a repository")
const NOT_A_REPO_REASON = 'not-a-repo';
const NOT_A_REPO_TEXT = 'This directory is not a git repository.';

const PANEL_WIDTH_KEY = 'filePanelWidth';
const DEFAULT_PANEL_WIDTH = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10) || 450;
const MIN_PANEL_WIDTH = 280;

const DIFF_MODE_KEY = 'filePanelDiffMode';
let diffMode = localStorage.getItem(DIFF_MODE_KEY) || 'side-by-side';

const CHANGES_STATE_NAMES = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'Untracked' };
const CHANGES_DIFF_MODE_KEY = 'changesDiffMode';
const CHANGES_DIFF_MODES = ['side-by-side', 'inline', 'plain'];
const CHANGES_DIFF_MODE_LABELS = { 'side-by-side': 'Side-by-side diff', inline: 'Inline diff', plain: 'Plain editor, no diff' };
// see .ai/contexts/changes-view.md ("The list and the editor")
let changesDiffMode = CHANGES_DIFF_MODES.includes(localStorage.getItem(CHANGES_DIFF_MODE_KEY))
  ? localStorage.getItem(CHANGES_DIFF_MODE_KEY)
  : 'inline';

// see .ai/contexts/changes-view.md ("Look and feel")
const FP_STROKE_ICON = (paths) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const FP_ICONS = {
  save: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M433.941 129.941l-83.882-83.882A48 48 0 0 0 316.118 32H48C21.49 32 0 53.49 0 80v352c0 26.51 21.49 48 48 48h352c26.51 0 48-21.49 48-48V163.882a48 48 0 0 0-14.059-33.941zM272 80v80H144V80h128zm122 352H54a6 6 0 0 1-6-6V86a6 6 0 0 1 6-6h42v104c0 13.255 10.745 24 24 24h176c13.255 0 24-10.745 24-24V83.882l78.243 78.243a6 6 0 0 1 1.757 4.243V426a6 6 0 0 1-6 6zM224 232c-48.523 0-88 39.477-88 88s39.477 88 88 88 88-39.477 88-88-39.477-88-88-88zm0 128c-22.056 0-40-17.944-40-40s17.944-40 40-40 40 17.944 40 40-17.944 40-40 40z"></path></svg>',
  close: '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>',
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  reload: FP_STROKE_ICON('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  'side-by-side': FP_STROKE_ICON('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  inline: FP_STROKE_ICON('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>'),
  plain: FP_STROKE_ICON('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>'),
  formatted: FP_STROKE_ICON('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
};
// ── Initialization ──────────────────────────────────────────────────

function initFilePanel() {
  const terminalArea = document.getElementById('terminal-area');
  const terminalsEl = document.getElementById('terminals');
  if (!terminalArea || !terminalsEl) return;

  // Create the split container
  terminalSplitEl = document.createElement('div');
  terminalSplitEl.id = 'terminal-split';

  terminalArea.removeChild(terminalsEl);
  terminalSplitEl.appendChild(terminalsEl);

  // Create resize handle
  filePanelResizeHandle = document.createElement('div');
  filePanelResizeHandle.id = 'file-panel-resize-handle';
  terminalSplitEl.appendChild(filePanelResizeHandle);

  // Create the file panel
  filePanelEl = document.createElement('div');
  filePanelEl.id = 'file-panel';

  filePanelContentEl = document.createElement('div');
  filePanelContentEl.id = 'file-panel-content';
  filePanelEl.appendChild(filePanelContentEl);

  panelBackBtn = document.createElement('button');
  panelBackBtn.id = 'file-panel-back-btn';
  panelBackBtn.className = 'viewer-toolbar-btn fp-toolbar-btn';
  panelBackBtn.textContent = '← Back to list';
  panelBackBtn.style.display = 'none';
  panelBackBtn.addEventListener('click', returnToPanelList);
  filePanelContentEl.appendChild(panelBackBtn);
  filePanelContentEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !event.target.closest('#changes-diff-view')) return;
    if (event.defaultPrevented || event.isComposing) return;
    if (event.target.closest('.cm-panels, .cm-search, .cm-tooltip')) return;
    if (event.target.closest('input, textarea') && !event.target.closest('.cm-content')) return;
    if (returnToPanelList()) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (unloadApproved || !collectUnsavedFileTabs().length) return;
    event.preventDefault();
    event.returnValue = false;
  });
  if (window.api.onUnsavedCheck) {
    window.api.onUnsavedCheck(async (id) => {
      window.api.unsavedCheckAck(id);
      let proceed = true;
      try { proceed = await askAboutUnsavedEdits(); } catch (err) { console.error('[unsaved-check]', err); }
      window.api.unsavedCheckResult(id, proceed);
    });
  }

  // ── Diff-specific UI ──
  const diffContainer = document.createElement('div');
  diffContainer.id = 'file-panel-diff';
  diffContainer.style.display = 'none';
  filePanelContentEl.appendChild(diffContainer);

  // Diff toolbar
  diffToolbarEl = document.createElement('div');
  diffToolbarEl.className = 'viewer-toolbar';

  const diffInfo = document.createElement('div');
  diffInfo.className = 'viewer-toolbar-info';
  diffInfo.innerHTML = '<span class="viewer-toolbar-title" id="diff-title"></span><span class="viewer-toolbar-path" id="diff-path"></span>';
  diffToolbarEl.appendChild(diffInfo);

  const diffControls = document.createElement('div');
  diffControls.className = 'viewer-toolbar-controls';

  diffToggleBtn = document.createElement('button');
  diffToggleBtn.className = 'icon-btn';
  diffToggleBtn.id = 'diff-mode-btn';
  updateDiffModeButton();
  diffToggleBtn.addEventListener('click', handleDiffModeToggle);
  diffControls.appendChild(diffToggleBtn);

  const diffSaveBtn = document.createElement('button');
  diffSaveBtn.className = 'icon-btn fp-save-btn';
  diffSaveBtn.title = 'Save changes';
  diffSaveBtn.innerHTML = FP_ICONS.save;
  diffSaveBtn.addEventListener('click', handleDiffSave);
  diffControls.appendChild(diffSaveBtn);

  const diffCloseBtn = document.createElement('button');
  diffCloseBtn.className = 'icon-btn fp-close-btn';
  diffCloseBtn.innerHTML = FP_ICONS.close;
  diffCloseBtn.title = 'Close panel';
  diffCloseBtn.addEventListener('click', handleClose);
  diffControls.appendChild(diffCloseBtn);

  diffToolbarEl.appendChild(diffControls);
  diffContainer.appendChild(diffToolbarEl);

  diffBodyEl = document.createElement('div');
  diffBodyEl.id = 'file-panel-body';
  diffContainer.appendChild(diffBodyEl);

  diffActionsEl = document.createElement('div');
  diffActionsEl.id = 'file-panel-actions';
  diffActionsEl.style.display = 'none';
  diffContainer.appendChild(diffActionsEl);

  // ── Changes mode (issue #251, git-status-sourced) ──
  changesContainerEl = document.createElement('div');
  changesContainerEl.id = 'file-panel-changes';
  changesContainerEl.style.display = 'none';
  filePanelContentEl.appendChild(changesContainerEl);

  const changesToolbarEl = document.createElement('div');
  changesToolbarEl.className = 'viewer-toolbar';

  const changesInfo = document.createElement('div');
  changesInfo.className = 'viewer-toolbar-info';
  const changesTitleEl = document.createElement('span');
  changesTitleEl.className = 'viewer-toolbar-title';
  changesTitleEl.textContent = 'Changes';
  const changesBranchInfoEl = document.createElement('span');
  changesBranchInfoEl.className = 'viewer-toolbar-path';
  changesBranchInfoEl.id = 'changes-branch-info';
  changesInfo.appendChild(changesTitleEl);
  changesInfo.appendChild(changesBranchInfoEl);
  changesToolbarEl.appendChild(changesInfo);

  const changesControls = document.createElement('div');
  changesControls.className = 'viewer-toolbar-controls';

  const changesRefreshBtn = document.createElement('button');
  changesRefreshBtn.className = 'icon-btn';
  changesRefreshBtn.id = 'changes-refresh-btn';
  changesRefreshBtn.title = 'Refresh the file list';
  changesRefreshBtn.setAttribute('aria-label', changesRefreshBtn.title);
  changesRefreshBtn.innerHTML = FP_ICONS.refresh;
  changesRefreshBtn.addEventListener('click', () => {
    if (currentPanelSessionId) refreshChanges(currentPanelSessionId);
  });
  changesControls.appendChild(changesRefreshBtn);

  const changesCloseBtn = document.createElement('button');
  changesCloseBtn.className = 'icon-btn fp-close-btn';
  changesCloseBtn.innerHTML = FP_ICONS.close;
  changesCloseBtn.title = 'Close panel';
  changesCloseBtn.addEventListener('click', handleClose);
  changesControls.appendChild(changesCloseBtn);

  changesToolbarEl.appendChild(changesControls);
  changesContainerEl.appendChild(changesToolbarEl);

  changesSummaryEl = document.createElement('div');
  changesSummaryEl.id = 'changes-summary';
  changesContainerEl.appendChild(changesSummaryEl);

  changesListEl = document.createElement('div');
  changesListEl.id = 'changes-list';
  changesContainerEl.appendChild(changesListEl);

  changesListSplitterEl = document.createElement('div');
  changesListSplitterEl.id = 'changes-list-splitter';
  changesListSplitterEl.style.display = 'none';
  changesContainerEl.appendChild(changesListSplitterEl);

  changesDiffEl = document.createElement('div');
  changesDiffEl.id = 'changes-diff-view';
  changesDiffEl.style.display = 'none';
  changesContainerEl.appendChild(changesDiffEl);

  buildChangesDiffChrome();
  // Shell region below every tab type — see .ai/contexts/panel-terminal.md
  if (typeof initPanelTerminal === 'function') initPanelTerminal(filePanelContentEl);

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  wireIpcListeners();
  setupPanelResizeHandle();
  addMcpToggle();
  addChangesToggle();
  if (typeof initTouchedView === 'function') initTouchedView(filePanelContentEl);
  setupChangesListSplitter();

  // see .ai/contexts/changes-view.md ("Refresh triggers")
  if (typeof onSessionIdle === 'function') {
    onSessionIdle((sessionId) => {
      const state = filePanelState.get(sessionId);
      if (state && state.currentTab && state.currentTab.type === 'changes' && !state.currentTab.returnList) {
        Promise.resolve(refreshChanges(sessionId)).catch(() => {});
      }
    });
  }
}

// ── Handlers ────────────────────────────────────────────────────────

function handleClose() {
  if (!currentPanelSessionId) return;
  const state = getSessionState(currentPanelSessionId);
  const tab = state.currentTab;
  let pending = null;

  if (tab) {
    if (!confirmDiscardChangesEdits(tab)) return;
    if (tab.type === 'diff' && !tab.resolved) {
      window.api.mcpDiffResponse(currentPanelSessionId, tab.diffId, 'reject', null);
    }
    if (tab.type === 'diff') {
      pending = state.pendingTouchedOpen || null;
      state.pendingTouchedOpen = null;
    }
    if (tab.type === 'diff' && tab.editorView) {
      tab.editorView.destroy();
      tab.editorView = null;
    }
    if (tab.type === 'changes') {
      unwatchChangesFile(currentPanelSessionId, tab);
      destroyChangesEditor(tab);
    }
    state.currentTab = null;
  }

  endCurrentTab(currentPanelSessionId, state, { pending });
}

function returnToPanelList() {
  if (!currentPanelSessionId) return false;
  const state = getSessionState(currentPanelSessionId);
  const tab = state.currentTab;
  if (tab?.type === 'changes' && tab.selectedFile && !tab.returnList) {
    closeChangesDiff(currentPanelSessionId);
    return !tab.selectedFile;
  }
  if (!tab?.returnList) return false;
  if (!confirmDiscardChangesEdits(tab)) return false;
  const previous = tab.returnList;
  destroyCurrentTab(state, { stash: false });
  state.currentTab = previous;
  renderPanel(currentPanelSessionId);
  return true;
}

function snapshotPanelList(list, tab) {
  if (list?._owner === tab) tab.listScrollTop = list.scrollTop;
}

function restorePanelListScroll(list, tab) {
  if (tab.listScrollTop == null) return;
  list.scrollTop = tab.listScrollTop;
  tab.listScrollTop = null;
}

function reusePanelList(list, summary, tab, signature, detail = null) {
  const previous = list._owner;
  if (previous && previous !== tab) {
    previous.listView = {
      signature: list._signature,
      nodes: [...list.childNodes],
      summaryNodes: [...summary.childNodes],
      detail: detail?.textContent,
      scrollTop: previous.listScrollTop ?? list.scrollTop,
    };
  }
  const same = values => values && signature.every((value, i) => value === values[i]);
  if (previous === tab && same(list._signature)) return true;
  list._owner = tab;
  list._signature = signature;
  if (previous !== tab && same(tab.listView?.signature)) {
    list.replaceChildren(...tab.listView.nodes);
    summary.replaceChildren(...tab.listView.summaryNodes);
    if (detail) detail.textContent = tab.listView.detail || '';
    list.scrollTop = tab.listView.scrollTop;
    tab.listView = null;
    return true;
  }
  return false;
}

async function handleDiffSave() {
  const state = currentPanelSessionId ? getSessionState(currentPanelSessionId) : null;
  const tab = state?.currentTab;
  if (!tab || tab.type !== 'diff' || !tab.editorView || !tab.filePath) return;
  await saveDiffTab(tab);
}

function updateDiffSaveButton(tab) {
  const btn = diffToolbarEl && diffToolbarEl.querySelector('.fp-save-btn');
  if (!btn) return;
  btn.disabled = !!tab.resolved;
  btn.title = tab.resolved ? 'This diff has been answered — Save is off until the session closes it' : 'Save changes';
}

// see .ai/contexts/viewer-panel.md ("Saving over a file that moved")
async function saveDiffTab(tab) {
  if (tab.resolved || !tab.editorView) return;
  if (tab.saving) {
    tab.saveQueued = true;
    return;
  }

  let content;
  if (tab._diffMode === 'inline') {
    content = tab.editorView.state.doc.toString();
  } else if (tab.editorView.b) {
    content = tab.editorView.b.state.doc.toString();
  }
  if (content == null) return;

  tab.saving = true;
  let saved = false;
  try {
    let result = await window.api.saveFileForPanel(tab.filePath, content, tab.diskBaseline);
    while (result && result.reason === 'stale' && typeof result.disk === 'string'
      && typeof window.confirm === 'function'
      && window.confirm('This file changed on disk since the diff opened. Overwrite it with your edits?')) {
      tab.diskBaseline = result.disk;
      result = await window.api.saveFileForPanel(tab.filePath, content, tab.diskBaseline);
    }
    if (result && result.ok) {
      saved = true;
      tab.diskBaseline = content.replace(/\r\n?/g, '\n');
      const btn = diffToolbarEl.querySelector('.fp-save-btn');
      if (btn) flashButtonText(btn, 'Saved!');
    } else if (result && result.reason !== 'stale' && typeof window.alert === 'function') {
      window.alert(`Save failed: ${result.error || 'unknown error'}`);
    }
  } catch (err) {
    if (typeof window.alert === 'function') window.alert(`Save failed: ${(err && err.message) || 'unknown error'}`);
  } finally {
    tab.saving = false;
    const queued = tab.saveQueued;
    tab.saveQueued = false;
    if (queued && saved) saveDiffTab(tab);
  }
}

function updateDiffModeButton() {
  const next = diffMode === 'inline' ? 'side-by-side' : 'inline';
  setModeButton(diffToggleBtn, diffMode, next);
}

// see .ai/contexts/changes-view.md ("Look and feel")
function setModeButton(btn, mode, next) {
  if (btn.dataset.mode !== mode) btn.innerHTML = FP_ICONS[mode];
  btn.dataset.mode = mode;
  const label = `${CHANGES_DIFF_MODE_LABELS[mode]} — click for ${CHANGES_DIFF_MODE_LABELS[next].toLowerCase()}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function handleDiffModeToggle() {
  diffMode = diffMode === 'inline' ? 'side-by-side' : 'inline';
  localStorage.setItem(DIFF_MODE_KEY, diffMode);
  updateDiffModeButton();

  if (currentPanelSessionId) {
    const state = getSessionState(currentPanelSessionId);
    const tab = state.currentTab;
    if (tab && tab.type === 'diff') {
      if (tab.editorView) { tab.editorView.destroy(); tab.editorView = null; }
      renderTabContent(currentPanelSessionId, tab);
    }
  }
}

// ── IPC Wiring ──────────────────────────────────────────────────────

function wireIpcListeners() {
  window.api.onMcpOpenDiff((sessionId, diffId, data) => {
    openDiffTab(sessionId, diffId, data);
  });

  window.api.onMcpOpenFile((sessionId, data) => {
    if (typeof openTouchedPath === 'function') openTouchedPath(sessionId, data.filePath, { origin: 'mcp' });
  });

  window.api.onMcpCloseAllDiffs((sessionId) => {
    closeAllDiffs(sessionId);
  });

  window.api.onMcpCloseTab((sessionId, diffId) => {
    closeDiffByDiffId(sessionId, diffId);
  });

  if (window.api.onMcpStatus) {
    window.api.onMcpStatus((sessionId, mcpState) => {
      setSessionMcpState(sessionId, mcpState);
    });
  }

  if (window.api.onFileChanged) {
    window.api.onFileChanged((filePath) => {
      for (const [sessionId, state] of filePanelState) {
        const tab = state.currentTab;
        if (tab?.absolutePath && filePathKey(tab.absolutePath) === filePathKey(filePath) && !tab.saving) {
          syncOpenChangesFile(sessionId, tab).catch(() => {});
        }
      }
    });
  }
  if (window.api.onGitChangesFileChanged) {
    window.api.onGitChangesFileChanged((sessionId, filePath) => {
      handleChangesFileChanged(sessionId, filePath);
    });
  }
}

// ── Session State Helpers ───────────────────────────────────────────

function getSessionState(sessionId) {
  if (!filePanelState.has(sessionId)) {
    filePanelState.set(sessionId, {
      currentTab: null,
      panelVisible: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
      mcpState: 'off',
      mcpDetail: '',
    });
  }
  return filePanelState.get(sessionId);
}

function setSessionMcpState(sessionId, mcpState, detail) {
  const state = getSessionState(sessionId);
  state.mcpState = mcpState || 'off';
  state.mcpDetail = detail || '';
  if (currentPanelSessionId === sessionId) updateMcpIndicator();
}

function rekeyFilePanelState(oldId, newId) {
  const state = filePanelState.get(oldId);
  if (state) {
    filePanelState.delete(oldId);
    filePanelState.set(newId, state);
  }
}

// ── Tab Operations ──────────────────────────────────────────────────

function openDiffTab(sessionId, diffId, data) {
  const state = getSessionState(sessionId);

  // Destroy previous
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'diff',
    label: data.tabName || basename(data.oldFilePath),
    filePath: data.oldFilePath,
    diffId,
    oldContent: data.oldContent,
    newContent: data.newContent,
    diskBaseline: typeof data.oldContent === 'string' ? data.oldContent.replace(/\r\n?/g, '\n') : null,
    resolved: false,
    editorView: null,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function fileTabHasUnsavedEdits(tab) {
  if (tab.type === 'touched-stash') return tab.content !== tab.savedContent;
  return hasUnsavedChangesEdits(tab);
}

// see .ai/contexts/touched-files.md ("Stashed edits")
function filePathKey(filePath) {
  const platform = window.api && window.api.platform;
  let key = String(filePath);
  if (platform === 'win32') key = key.replace(/\\/g, '/').toLowerCase();
  return key;
}

// see .ai/contexts/viewer-panel.md ("Unsaved edits on quit, reload and close")
let unloadApproved = false;
let unsavedPrompt = null;

function collectUnsavedFileTabs() {
  const found = [];
  for (const state of filePanelState.values()) {
    const tabs = [];
    if (state.currentTab?.absolutePath) tabs.push(state.currentTab);
    if (state.touchedStashes) tabs.push(...state.touchedStashes.values());
    for (const tab of tabs) if (fileTabHasUnsavedEdits(tab)) found.push(tab);
  }
  return found;
}

async function saveTouchedStash(entry) {
  const result = await window.api.saveFileForPanel(entry.filePath, entry.content, entry.savedContent, { git: entry.gitFile, version: entry.version });
  if (result && result.ok) {
    const key = filePathKey(entry.filePath);
    for (const state of filePanelState.values()) {
      if (state.touchedStashes?.get(key) === entry) state.touchedStashes.delete(key);
    }
    return null;
  }
  if (result && result.reason === 'stale') return 'not saved: it changed on disk since you opened it';
  return `not saved: ${(result && result.error) || 'unknown error'}`;
}

async function saveUnsavedFileTab(tab) {
  if (tab.type === 'touched-stash') return saveTouchedStash(tab);
  const owner = [...filePanelState].find(([, state]) => state.currentTab === tab);
  if (owner) await handleChangesSave(owner[0]);
  return hasUnsavedChangesEdits(tab) ? 'not saved: it changed on disk, or could not be written' : null;
}

function showUnsavedEditsDialog(tabs) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog';
    dialog.id = 'unsaved-edits-dialog';
    dialog.setAttribute('role', 'alertdialog');

    const title = document.createElement('h3');
    title.textContent = 'Unsaved file edits';
    dialog.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'add-project-hint';
    hint.textContent = 'These files have edits that are not saved. Discarding loses them.';
    dialog.appendChild(hint);

    const labels = heldTabLabels(tabs);
    const list = document.createElement('ul');
    tabs.forEach((tab, i) => {
      const li = document.createElement('li');
      li.textContent = labels[i];
      li.title = tab.filePath;
      list.appendChild(li);
    });
    dialog.appendChild(list);

    const errorEl = document.createElement('div');
    errorEl.className = 'add-project-error';
    dialog.appendChild(errorEl);

    const actions = document.createElement('div');
    actions.className = 'add-project-actions';
    const makeBtn = (id, cls, text) => {
      const btn = document.createElement('button');
      btn.id = id;
      btn.className = cls;
      btn.textContent = text;
      actions.appendChild(btn);
      return btn;
    };
    const cancelBtn = makeBtn('unsaved-cancel', 'add-project-cancel-btn', 'Cancel');
    const discardBtn = makeBtn('unsaved-discard', 'add-project-cancel-btn', 'Discard');
    const saveBtn = makeBtn('unsaved-save', 'add-project-add-btn', tabs.length > 1 ? 'Save all' : 'Save');
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    saveBtn.focus();

    function finish(proceed) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(proceed);
    }
    function onKey(e) {
      if (e.key === 'Escape') finish(false);
    }
    document.addEventListener('keydown', onKey);

    cancelBtn.onclick = () => finish(false);
    discardBtn.onclick = () => finish(true);
    saveBtn.onclick = async () => {
      for (const btn of [cancelBtn, discardBtn, saveBtn]) btn.disabled = true;
      const failures = [];
      for (let i = 0; i < tabs.length; i++) {
        if (!fileTabHasUnsavedEdits(tabs[i])) continue;
        let reason;
        try { reason = await saveUnsavedFileTab(tabs[i]); } catch (err) { reason = `not saved: ${(err && err.message) || 'unknown error'}`; }
        if (reason) failures.push(`${labels[i]} ${reason}`);
      }
      if (!failures.length) {
        finish(true);
        return;
      }
      errorEl.textContent = failures.join('. ');
      errorEl.style.display = 'block';
      for (const btn of [cancelBtn, discardBtn, saveBtn]) btn.disabled = false;
    };
  });
}

function askAboutUnsavedEdits() {
  if (unsavedPrompt) return unsavedPrompt;
  const tabs = collectUnsavedFileTabs();
  if (!tabs.length) return Promise.resolve(true);
  unsavedPrompt = showUnsavedEditsDialog(tabs).then((proceed) => {
    unsavedPrompt = null;
    if (proceed) {
      unloadApproved = true;
      setTimeout(() => { unloadApproved = false; }, 10000);
    }
    return proceed;
  });
  return unsavedPrompt;
}

// see .ai/contexts/viewer-panel.md ("An open that arrives over a diff")
function endCurrentTab(sessionId, state, { pending = null, restoreStash = false } = {}) {
  state.panelVisible = false;
  if (currentPanelSessionId === sessionId) hidePanel();
  if (pending) openTouchedPath(sessionId, pending.filePath, { line: pending.line, origin: pending.origin, replay: true });
  else if (restoreStash && state.touchedStashes?.size) openTouchedTab(sessionId);
}

// see .ai/contexts/changes-view.md ("A dirty buffer is never overwritten, and never lied to")
function stashChangesEdits(state, tab) {
  if (!tab || tab.type !== 'changes' || !tab.selectedFile) return;
  const content = readChangesEditorContent(tab);
  if (content == null || content === tab.savedContent) return;
  const entry = {
    file: tab.selectedFile,
    content,
    original: tab.original,
    savedContent: tab.savedContent,
    version: tab.version,
    returnList: tab.returnList,
    absolutePath: tab.absolutePath,
    gitFile: tab.gitFile,
    noDiff: tab.noDiff,
  };
  if (!tab.returnList) {
    state.changesStash = entry;
    return;
  }
  // see .ai/contexts/touched-files.md ("Stashed edits")
  if (!state.touchedStashes) state.touchedStashes = new Map();
  const key = filePathKey(tab.absolutePath);
  state.touchedStashes.set(key, { ...entry, type: 'touched-stash', filePath: tab.absolutePath });
}

function takeChangesStash(state, listType, key) {
  if (listType !== 'touched') {
    const stash = state.changesStash;
    state.changesStash = null;
    return stash;
  }
  const stashes = state.touchedStashes;
  const wanted = key ?? (stashes ? [...stashes.keys()].at(-1) : undefined);
  const stash = stashes?.get(wanted) || null;
  if (stash) stashes.delete(wanted);
  return stash;
}

function restoreChangesEdits(sessionId, state, tab, listType = 'changes', { key, returnList, line } = {}) {
  const stash = takeChangesStash(state, listType, key);
  if (!stash) return false;

  tab.returnList = returnList || stash.returnList;
  tab.absolutePath = stash.absolutePath;
  tab.filePath = stash.absolutePath;
  tab.formatted = touchedOpensFormatted(stash.absolutePath) && !line;
  tab.pendingLine = line || null;
  tab.gitFile = stash.gitFile;
  tab.noDiff = stash.noDiff;
  tab.selectedFile = stash.file;
  tab.editable = true;
  tab.original = stash.original;
  tab.current = stash.content;
  tab.savedContent = stash.savedContent;
  tab.version = stash.version;
  tab.restoredEdits = true;
  tab.diffLoading = false;
  watchChangesFile(sessionId, tab, stash.file.path);
  return true;
}

function destroyCurrentTab(state, { stash = true } = {}) {
  const tab = state.currentTab;
  if (!tab) return;
  if (stash) stashChangesEdits(state, tab);
  if (tab.type === 'diff') state.pendingTouchedOpen = null;
  if (tab.type === 'diff' && tab.editorView) {
    tab.editorView.destroy();
    tab.editorView = null;
    // Clear stale search/goto-line bar references
    if (diffBodyEl) {
      delete diffBodyEl._cmSearchBar;
      delete diffBodyEl._cmGotoLine;
    }
  }
  if (tab.type === 'changes') {
    unwatchChangesFile(currentPanelSessionId, tab);
    destroyChangesEditor(tab);
  }
}

// see .ai/contexts/touched-files.md ("One route into Touched") and .ai/contexts/terminal-path-links.md
function openFileInPanel(sessionId, filePath, opts = {}) {
  const line = Number.isInteger(opts.line) && opts.line > 0 ? opts.line : null;
  if (typeof openTouchedPath === 'function') return openTouchedPath(sessionId, filePath, { line, origin: 'link' });
}

function closeAllDiffs(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state) return;

  if (state.currentTab?.type === 'diff') endDiffTab(sessionId, state, { restoreStash: true });
}

function closeDiffByDiffId(sessionId, diffId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab) return;
  if (state.currentTab.type !== 'diff' || state.currentTab.diffId !== diffId) return;

  state.currentTab.resolved = true;
  endDiffTab(sessionId, state, { restoreStash: true });
}

// see .ai/contexts/viewer-panel.md ("An open that arrives over a diff")
function endDiffTab(sessionId, state, { restoreStash }) {
  const pending = state.pendingTouchedOpen || null;
  state.pendingTouchedOpen = null;
  destroyCurrentTab(state);
  state.currentTab = null;
  endCurrentTab(sessionId, state, { pending, restoreStash });
}

// ── Panel Show/Hide ─────────────────────────────────────────────────

function showPanel(state) {
  if (!filePanelEl) return;
  filePanelEl.classList.add('open');
  filePanelEl.style.width = (state.panelWidth || DEFAULT_PANEL_WIDTH) + 'px';
  filePanelResizeHandle.style.display = 'block';
  refitActiveTerminal();
}

function hidePanel() {
  if (!filePanelEl) return;
  // The shell region keeps the panel open with no tab — see .ai/contexts/panel-terminal.md
  if (typeof panelTerminalIsOpen === 'function' && panelTerminalIsOpen(currentPanelSessionId)) {
    renderTabContent(currentPanelSessionId, null);
    showPanel(getSessionState(currentPanelSessionId));
    return;
  }
  setHeaderToggle(changesToggleBtn, false);
  if (typeof hideTouchedView === 'function') hideTouchedView();
  filePanelEl.classList.remove('open');
  filePanelEl.style.width = '0';
  filePanelResizeHandle.style.display = 'none';
  refitActiveTerminal();
}

function switchPanel(sessionId) {
  currentPanelSessionId = sessionId;
  updateMcpIndicator();
  if (typeof syncPanelTerminal === 'function') syncPanelTerminal(sessionId);

  if (!sessionId) {
    hidePanel();
    return;
  }

  const state = getSessionState(sessionId);

  if (state.panelVisible && state.currentTab) {
    showPanel(state);
    renderPanel(sessionId);
  } else {
    hidePanel();
  }
}

function updateMcpIndicator() {
  if (!mcpIndicatorEl) return;
  if (!currentPanelSessionId) {
    mcpIndicatorEl.style.display = 'none';
    return;
  }
  const state = filePanelState.get(currentPanelSessionId);
  const mcpState = state ? state.mcpState : 'off';
  const look = MCP_INDICATOR_STATES[mcpState];
  if (!look) {
    mcpIndicatorEl.style.display = 'none';
    return;
  }
  mcpIndicatorEl.textContent = look.text;
  mcpIndicatorEl.title = look.title + (mcpState === 'failed' && state.mcpDetail ? ` (${state.mcpDetail})` : '');
  mcpIndicatorEl.style.display = '';
}

// ── Panel Rendering ─────────────────────────────────────────────────

function renderPanel(sessionId) {
  if (!filePanelEl || currentPanelSessionId !== sessionId) return;

  const state = getSessionState(sessionId);
  if (!state) return;

  renderTabContent(sessionId, state.currentTab);
}

function renderTabContent(sessionId, tab) {
  const diffContainer = document.getElementById('file-panel-diff');
  panelBackBtn.style.display = tab && tab.returnList?.type !== 'touched' && (tab.returnList || (tab.type === 'changes' && tab.selectedFile)) ? '' : 'none';
  // see .ai/contexts/panel-terminal.md ("Layout")
  if (typeof setPanelTerminalShellOnly === 'function') setPanelTerminalShellOnly(!tab);

  setHeaderToggle(changesToggleBtn, !!tab && tab.type === 'changes' && !tab.returnList);
  if (typeof renderTouchedTab === 'function') renderTouchedTab(sessionId, tab);

  if (!tab) {
    diffContainer.style.display = 'none';
    changesContainerEl.style.display = 'none';
    return;
  }

  if (tab.type === 'changes') {
    diffContainer.style.display = 'none';
    changesContainerEl.style.display = tab.returnList?.type === 'touched' ? 'none' : 'flex';
    renderChangesContent(sessionId, tab);
  } else if (tab.type === 'touched') {
    diffContainer.style.display = 'none';
    changesContainerEl.style.display = 'none';
  } else {
    // MCP diff mode
    changesContainerEl.style.display = 'none';
    diffContainer.style.display = 'flex';
    renderDiffContent(sessionId, tab);
  }
}

function renderDiffContent(sessionId, tab) {
  diffBodyEl.innerHTML = '';

  // Update diff toolbar info
  const titleEl = diffToolbarEl.querySelector('#diff-title');
  const pathEl = diffToolbarEl.querySelector('#diff-path');
  if (titleEl) titleEl.textContent = tab.label;
  if (pathEl) window.setViewerPath(pathEl, tab.filePath || '');

  updateDiffSaveButton(tab);

  // Accept/reject buttons are rendered synchronously so the UI appears
  // immediately; the diff viewer itself is deferred until the bundle loads.
  if (!tab.resolved) {
    diffActionsEl.style.display = 'flex';
    diffActionsEl.innerHTML = '';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'file-panel-accept-btn';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => handleDiffAction(sessionId, tab, 'accept'));

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'file-panel-reject-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => handleDiffAction(sessionId, tab, 'reject'));

    diffActionsEl.appendChild(acceptBtn);
    diffActionsEl.appendChild(rejectBtn);
  } else {
    diffActionsEl.style.display = 'none';
  }

  // Defer merge-viewer creation until codemirror-bundle.js is available.
  window.loadCodeMirrorBundle().then(() => {
    if (tab.resolved) return;  // tab was accepted/rejected before bundle loaded
    if (!tab.editorView) {
      if (diffMode === 'inline') {
        tab.editorView = window.createUnifiedMergeViewer(
          diffBodyEl, tab.oldContent, tab.newContent, tab.filePath,
        );
        tab._diffMode = 'inline';
      } else {
        tab.editorView = window.createMergeViewer(
          diffBodyEl, tab.oldContent, tab.newContent, tab.filePath,
        );
        tab._diffMode = 'side-by-side';
      }
      tab.editorView.dom.addEventListener('click', () => tab.editorView.dom.focus());
    } else {
      diffBodyEl.appendChild(tab.editorView.dom);
    }
  }).catch((err) => {
    console.error('[file-panel] Failed to load codemirror-bundle:', err);
  });
}

// ── Diff Actions ────────────────────────────────────────────────────

function handleDiffAction(sessionId, tab, action) {
  if (tab.resolved) return;
  tab.resolved = true;
  updateDiffSaveButton(tab);

  if (action === 'accept') {
    let editedContent = null;
    if (tab.editorView) {
      if (tab._diffMode === 'inline') {
        editedContent = tab.editorView.state.doc.toString();
      } else if (tab.editorView.b) {
        editedContent = tab.editorView.b.state.doc.toString();
      }
    }

    if (editedContent && editedContent !== tab.newContent) {
      window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept-edited', editedContent);
    } else {
      window.api.mcpDiffResponse(sessionId, tab.diffId, 'accept', null);
    }
  } else {
    window.api.mcpDiffResponse(sessionId, tab.diffId, 'reject', null);
  }

  diffActionsEl.style.display = 'none';
  const state = getSessionState(sessionId);
  if (state.currentTab === tab && state.pendingTouchedOpen) endDiffTab(sessionId, state, { restoreStash: true });
}

// ── Changes Mode — see .ai/contexts/changes-view.md ──────────────────

function toggleChangesTab(sessionId) {
  const state = getSessionState(sessionId);
  if (state.currentTab && state.currentTab.type === 'changes' && !state.currentTab.returnList) {
    if (!confirmDiscardChangesEdits(state.currentTab)) return;
    destroyCurrentTab(state, { stash: false });
    state.currentTab = null;
    endCurrentTab(sessionId, state);
    return;
  }
  return openChangesTab(sessionId);
}

function createChangesTab() {
  return {
    type: 'changes',
    label: 'Changes',
    loading: true,
    error: null,
    data: null,
    remote: false,
    selectedFile: null,
    diffLoading: false,
    diffError: null,
    diffContent: null,
    diffTruncated: false,
    editable: false,
    original: null,
    current: null,
    savedContent: null,
    editorView: null,
    editorKey: null,
    editorMode: null,
    editorPending: null,
    version: null,
    restoredEdits: false,
    watchedPath: null,
    fallbackReason: null,
    fileError: null,
    saveError: null,
    saving: false,
    externalChange: false,
    notARepo: false,
  };
}

function openChangesTab(sessionId) {
  const state = getSessionState(sessionId);
  destroyCurrentTab(state);
  state.currentTab = createChangesTab();
  state.panelVisible = true;
  restoreChangesEdits(sessionId, state, state.currentTab);

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
  return refreshChanges(sessionId);
}

function openTouchedEditor(sessionId, absolutePath, pair, returnList, { line = null } = {}) {
  const state = getSessionState(sessionId);
  if (currentPanelSessionId === sessionId) snapshotPanelList(document.getElementById('touched-list'), returnList);
  destroyCurrentTab(state, { stash: false });
  const tab = createChangesTab();
  tab.returnList = returnList;
  tab.label = 'Touched files';
  tab.absolutePath = absolutePath;
  tab.filePath = absolutePath;
  tab.selectedFile = { path: absolutePath };
  tab.loading = false;
  tab.formatted = touchedOpensFormatted(absolutePath) && !line;
  tab.pendingLine = line;
  applyChangesPair(tab, pair);
  state.currentTab = tab;
  state.panelVisible = true;
  watchChangesFile(sessionId, tab, absolutePath);
  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function applyChangesPair(tab, pair) {
  tab.diffLoading = false;
  tab.editable = true;
  tab.readOnly = !!pair.readOnly;
  if (pair.kind === 'remote') tab.remote = true;
  tab.original = pair.original;
  tab.current = pair.current;
  tab.savedContent = pair.current;
  tab.version = pair.version;
  if (tab.absolutePath) {
    tab.gitFile = pair.git;
    tab.noDiff = !pair.git || pair.original === pair.current;
  }
}

async function readChangesPair(sessionId, tab, file) {
  try {
    return tab.absolutePath
      ? await window.api.readFileForPanel(tab.absolutePath, { editor: true, ...(tab.remote ? { sessionId } : {}) })
      : await window.api.gitChangesFile(sessionId, file.path, { staged: !!file.staged });
  } catch (err) {
    return { ok: false, error: err?.message || 'this file could not be read' };
  }
}

async function refreshChanges(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'changes') return;
  const tab = state.currentTab;
  if (tab.absolutePath) return syncOpenChangesFile(sessionId, tab);

  tab.loading = true;
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);

  const result = await window.api.gitChangesStatus(sessionId);

  // tab may have been closed/replaced while the IPC round-trip was in flight
  const stillState = filePanelState.get(sessionId);
  if (!stillState || stillState.currentTab !== tab) return;

  tab.loading = false;
  if (result && result.reason === NOT_A_REPO_REASON) {
    tab.notARepo = true;
    tab.error = NOT_A_REPO_TEXT;
    tab.data = null;
  } else if (!result || result.ok === false) {
    tab.notARepo = false;
    tab.error = (result && result.error) || 'failed to load changes';
    tab.data = null;
  } else {
    tab.notARepo = false;
    tab.error = null;
    tab.data = result;
    tab.remote = result.kind === 'remote';
  }
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
  return syncOpenChangesFile(sessionId, tab).catch(() => {});
}

// A refresh may never replace what the user is typing into — see .ai/contexts/changes-view.md
async function syncOpenChangesFile(sessionId, tab) {
  if (!tab.selectedFile || !tab.editable) return;

  if (!isChangesBufferDirty(tab)) repointSelectedFile(tab);

  const file = tab.selectedFile;
  const result = await readChangesPair(sessionId, tab, file);

  const stillState = filePanelState.get(sessionId);
  if (!stillState || stillState.currentTab !== tab || tab.selectedFile !== file) return;

  if (!result || result.ok === false) {
    tab.fileError = (result && result.error) || 'this file could not be read';
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }
  tab.fileError = null;

  if (isChangesBufferDirty(tab)) {
    tab.externalChange = tab.absolutePath && !tab.gitFile
      ? result.current !== tab.savedContent
      : result.version !== tab.version;
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }

  tab.version = result.version;
  tab.externalChange = false;
  if (result.current === tab.current && result.original === tab.original && !!result.readOnly === !!tab.readOnly) {
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }

  applyChangesPair(tab, result);
  destroyChangesEditor(tab);
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
}

function repointSelectedFile(tab) {
  if (!tab.selectedFile || !tab.data || !Array.isArray(tab.data.files)) return;
  const record = tab.data.files.find((f) => f.path === tab.selectedFile.path);
  if (!record) return;
  tab.selectedFile = {
    path: record.path,
    staged: !!record.staged && !record.unstaged,
    untracked: !!record.untracked,
  };
}

function handleChangesFileChanged(sessionId, filePath) {
  const state = filePanelState.get(sessionId);
  const tab = state && state.currentTab;
  if (!tab || tab.type !== 'changes' || !tab.editable || !tab.selectedFile) return;
  if (tab.selectedFile.path !== filePath || tab.saving) return;
  return syncOpenChangesFile(sessionId, tab).catch(() => {});
}

function watchChangesFile(sessionId, tab, filePath) {
  unwatchChangesFile(sessionId, tab);
  if (tab.remote) return;
  tab.watchedPath = filePath;
  const watch = tab.absolutePath ? window.api.watchFile : window.api.gitChangesWatch;
  if (watch) Promise.resolve(tab.absolutePath ? watch(filePath) : watch(sessionId, filePath)).catch(() => {});
}

function unwatchChangesFile(sessionId, tab) {
  if (!tab.watchedPath) return;
  const unwatch = tab.absolutePath ? window.api.unwatchFile : window.api.gitChangesUnwatch;
  if (unwatch) Promise.resolve(tab.absolutePath ? unwatch(tab.watchedPath) : unwatch(sessionId, tab.watchedPath)).catch(() => {});
  tab.watchedPath = null;
}

async function openChangesDiff(sessionId, file) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'changes') return;
  const tab = state.currentTab;

  if (tab.selectedFile && !isSelectedChangesRow(tab, file) && !confirmDiscardChangesEdits(tab)) return;

  if (!tab.selectedFile && currentPanelSessionId === sessionId) snapshotPanelList(changesListEl, tab);
  tab.selectedFile = file;
  tab.listSelection = file;
  tab.diffError = null;
  tab.diffContent = null;
  tab.diffTruncated = false;
  const dataAtRequest = tab.data;
  tab.editable = false;
  tab.original = null;
  tab.current = null;
  tab.savedContent = null;
  tab.version = null;
  tab.fallbackReason = null;
  tab.fileError = null;
  tab.saveError = null;
  tab.saving = false;
  tab.externalChange = false;
  destroyChangesEditor(tab);
  unwatchChangesFile(sessionId, tab);

  tab.diffLoading = true;
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);

  const ipcId = file.subSessionId || sessionId;
  if (file.subSessionId) {
    tab.fallbackReason = 'subagent worktree';
  } else if (!tab.remote) {
    const pair = await readChangesPair(sessionId, tab, file);

    const pairState = filePanelState.get(sessionId);
    if (!pairState || pairState.currentTab !== tab || tab.selectedFile !== file) return;

    if (pair && pair.ok) {
      applyChangesPair(tab, pair);
      watchChangesFile(sessionId, tab, file.path);
      if (file.untracked) applyUntrackedCounts(tab, dataAtRequest, file.path, countAddedLines(pair.current), 0);
      if (currentPanelSessionId === sessionId) renderPanel(sessionId);
      return;
    }
    tab.fallbackReason = describeFallback(pair);
  }

  const result = await window.api.gitChangesDiff(ipcId, file.path, file.staged, file.untracked);

  const stillState = filePanelState.get(sessionId);
  if (!stillState || stillState.currentTab !== tab || tab.selectedFile !== file) return;

  tab.diffLoading = false;
  if (!result || result.ok === false) {
    tab.diffError = (result && result.error) || 'failed to load diff';
  } else {
    tab.diffContent = result.content;
    tab.diffTruncated = !!result.truncated;
    if (file.untracked && !file.subSessionId) applyUntrackedCounts(tab, dataAtRequest, file.path, result.added, result.deleted, result.countStatus);
  }
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
}

function describeFallback(pair) {
  if (!pair) return 'this file could not be opened for editing';
  if (pair.reason === 'binary') return 'binary file';
  if (pair.reason === 'too-large') return 'file too large to edit';
  if (pair.reason === 'encoding') return 'not UTF-8 text';
  if (pair.reason === 'mixed-eol') return 'mixed line endings';
  if (pair.reason === 'symlink') return 'symbolic link';
  if (pair.reason === 'hardlink') return 'hard link';
  return pair.error || 'this file could not be opened for editing';
}

function countAddedLines(content) {
  if (!content) return 0;
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// An opened untracked file refines the count status gave it — see .ai/contexts/changes-view.md ("Untracked line counts")
function applyUntrackedCounts(tab, expectedData, filePath, added, deleted, countStatus) {
  if (typeof added !== 'number' && typeof countStatus !== 'string') return;
  if (!tab.data || tab.data !== expectedData || !Array.isArray(tab.data.files)) return;
  const record = tab.data.files.find((f) => f.path === filePath && f.untracked);
  if (!record) return;

  if (typeof added === 'number') {
    record.added = added;
    record.deleted = typeof deleted === 'number' ? deleted : 0;
    record.countStatus = null;
  } else if (typeof record.added !== 'number') {
    record.countStatus = countStatus;
  }

  let totalAdded = 0;
  let totalDeleted = 0;
  let uncounted = 0;
  for (const f of tab.data.files) {
    if (typeof f.added === 'number') totalAdded += f.added;
    if (typeof f.deleted === 'number') totalDeleted += f.deleted;
    if (typeof f.added !== 'number') uncounted += 1;
  }
  tab.data.totals = { ...tab.data.totals, added: totalAdded, deleted: totalDeleted, uncounted };
  tab.listRevision = (tab.listRevision || 0) + 1;
}

function closeChangesDiff(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'changes') return;
  const tab = state.currentTab;
  if (tab.returnList) {
    if (currentPanelSessionId === sessionId) returnToPanelList();
    return;
  }
  if (!confirmDiscardChangesEdits(tab)) return;
  unwatchChangesFile(sessionId, tab);
  destroyChangesEditor(tab);
  tab.selectedFile = null;
  tab.restoredEdits = false;
  tab.diffContent = null;
  tab.diffError = null;
  tab.editable = false;
  tab.original = null;
  tab.current = null;
  tab.savedContent = null;
  tab.version = null;
  tab.fallbackReason = null;
  tab.fileError = null;
  tab.saveError = null;
  tab.saving = false;
  tab.externalChange = false;
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
}

function hasUnsavedChangesEdits(tab) {
  return !!tab && tab.type === 'changes' && isChangesBufferDirty(tab);
}

// Asks, and does nothing else.
function confirmDiscardChangesEdits(tab) {
  if (!hasUnsavedChangesEdits(tab)) return true;
  if (typeof window.confirm !== 'function') return true;
  return window.confirm('This file has unsaved edits. Discard them?');
}

function renderChangesContent(sessionId, tab) {
  if (tab.returnList) {
    renderPanelListLayout(true);
    renderChangesDiff(sessionId, tab);
    return;
  }
  const editorOpen = !!tab.selectedFile;
  changesSummaryEl.style.display = 'block';
  changesListEl.style.display = 'block';
  renderPanelListLayout(editorOpen);

  renderChangesList(sessionId, tab);
  if (editorOpen) renderChangesDiff(sessionId, tab);
  else restorePanelListScroll(changesListEl, tab);
}

function renderChangesList(sessionId, tab) {
  const signature = [tab.data, tab.loading, tab.error, tab.listRevision];
  const branchInfoEl = document.getElementById('changes-branch-info');
  if (reusePanelList(changesListEl, changesSummaryEl, tab, signature, branchInfoEl)) {
    updateChangesListSelection(tab);
    return;
  }

  if (tab.loading && !tab.data) {
    changesSummaryEl.textContent = 'Loading changes…';
    changesListEl.innerHTML = '';
    if (branchInfoEl) branchInfoEl.textContent = '';
    return;
  }
  if (tab.error) {
    changesSummaryEl.textContent = '';
    changesListEl.innerHTML = '';
    const err = document.createElement('div');
    err.className = tab.notARepo ? 'changes-note' : 'changes-error';
    err.textContent = tab.error;
    changesListEl.appendChild(err);
    if (branchInfoEl) branchInfoEl.textContent = '';
    return;
  }

  const data = tab.data;
  if (!data) return;
  const { branch, files, totals } = data;

  const subagentGroups = Array.isArray(data.subagents) ? data.subagents : [];
  const noChangesText = subagentGroups.length > 0 ? 'No changes in the session directory' : 'No changes';
  changesSummaryEl.textContent = totals.files === 0
    ? noChangesText
    : `${totals.files} file${totals.files === 1 ? '' : 's'} changed +${totals.added} −${totals.deleted}` + describeUncounted(totals.uncounted);

  if (branchInfoEl) {
    const parts = [];
    if (branch.head) parts.push(branch.head);
    if (branch.ahead) parts.push('↑' + branch.ahead);
    if (branch.behind) parts.push('↓' + branch.behind);
    branchInfoEl.textContent = parts.join(' ');
  }

  if (data.untrackedCollapsed) {
    const note = document.createElement('div');
    note.className = 'changes-degraded-note';
    note.textContent = 'Too many untracked files to list — untracked entries are collapsed into their directories.';
    changesSummaryEl.appendChild(note);
  }

  changesListEl.innerHTML = '';
  const shown = files.length > MAX_CHANGES_ROWS ? files.slice(0, MAX_CHANGES_ROWS) : files;
  for (const file of shown) {
    changesListEl.appendChild(buildChangesFileRow(sessionId, tab, file));
  }
  if (shown.length < files.length) {
    const more = document.createElement('div');
    more.className = 'changes-more-note';
    more.textContent = `+${files.length - shown.length} more files not shown`;
    changesListEl.appendChild(more);
  }

  for (const group of subagentGroups) appendSubagentChangesGroup(sessionId, tab, group);
  if (subagentGroups.length > 0 && data.subagentsOmitted > 0) {
    const more = document.createElement('div');
    more.className = 'changes-more-note';
    more.textContent = `+${data.subagentsOmitted} more subagent worktrees not shown`;
    changesListEl.appendChild(more);
  }
  updateChangesListSelection(tab);
}

function updateChangesListSelection(tab) {
  const selected = tab.selectedFile || tab.listSelection;
  for (const row of changesListEl.querySelectorAll('.changes-file-row')) {
    row.classList.toggle('selected', !!selected && row.dataset.path === selected.path
      && (row.dataset.subagent || null) === (selected.subSessionId || null));
  }
}

// see .ai/contexts/changes-view.md ("Subagent worktrees")
function appendSubagentChangesGroup(sessionId, tab, group) {
  if (!group || typeof group.sessionId !== 'string' || !Array.isArray(group.files) || group.files.length === 0) return;
  const header = document.createElement('div');
  header.className = 'changes-subagent-header';
  const parts = [String(group.label || group.agentId || 'subagent')];
  if (group.branch && group.branch.head) parts.push(group.branch.head);
  header.textContent = parts.join(' · ');
  changesListEl.appendChild(header);

  const shown = group.files.length > MAX_SUBAGENT_GROUP_ROWS ? group.files.slice(0, MAX_SUBAGENT_GROUP_ROWS) : group.files;
  for (const file of shown) {
    changesListEl.appendChild(buildChangesFileRow(sessionId, tab, file, group.sessionId));
  }
  if (shown.length < group.files.length) {
    const more = document.createElement('div');
    more.className = 'changes-more-note';
    more.textContent = `+${group.files.length - shown.length} more files not shown`;
    changesListEl.appendChild(more);
  }
}

// A row with no count says why — see .ai/contexts/changes-view.md ("Untracked line counts")
const COUNT_STATUS_MARKERS = {
  binary: { label: 'binary', title: 'Binary file: no line count' },
  'too-large': { label: 'too large', title: 'Over 1 MiB: too large to count' },
  'over-cap': { label: 'not counted', title: 'Not counted up front (past the first 500 new files, 8 MiB read, or the time limit); opening the file counts it' },
  'on-open': { label: 'count on open', title: 'Remote session: the line count comes when the file is opened' },
  collapsed: { label: 'directory', title: 'Too many untracked files to list: this entry stands for a whole directory, whose files are not counted' },
  unavailable: { label: 'no count', title: 'This file could not be read for a line count' },
};

function describeUncounted(uncounted) {
  if (!uncounted) return '';
  return ` (${uncounted} file${uncounted === 1 ? '' : 's'} not counted)`;
}

function buildChangesFileRow(sessionId, tab, file, subSessionId = null) {
  const row = document.createElement('div');
  row.className = 'changes-file-row';
  row.dataset.path = file.path;
  if (subSessionId) row.dataset.subagent = subSessionId;

  const state = document.createElement('span');
  state.className = 'changes-file-state changes-state-' + (file.state || '?').toLowerCase();
  state.textContent = file.state || '?';
  state.title = CHANGES_STATE_NAMES[file.state] || 'Changed';
  row.appendChild(state);

  const pathEl = document.createElement('span');
  pathEl.className = 'changes-file-path';
  pathEl.textContent = (file.renamed && file.origPath) ? `${file.origPath} → ${file.path}` : file.path;
  row.appendChild(pathEl);

  const counts = document.createElement('span');
  counts.className = 'changes-file-counts';
  if (typeof file.added === 'number' || typeof file.deleted === 'number') {
    const added = document.createElement('span');
    added.className = 'changes-added';
    added.textContent = '+' + (file.added || 0);
    const deleted = document.createElement('span');
    deleted.className = 'changes-deleted';
    deleted.textContent = '−' + (file.deleted || 0);
    counts.appendChild(added);
    counts.appendChild(deleted);
  } else {
    const marker = COUNT_STATUS_MARKERS[file.countStatus] || COUNT_STATUS_MARKERS.unavailable;
    const note = document.createElement('span');
    note.className = 'changes-count-note';
    note.dataset.countStatus = file.countStatus || 'unavailable';
    note.textContent = marker.label;
    note.title = marker.title;
    counts.appendChild(note);
  }
  row.appendChild(counts);

  const identity = { path: file.path, subSessionId };
  if (isSelectedChangesRow(tab, identity)) row.classList.add('selected');

  row.addEventListener('click', () => {
    // prefer the unstaged (worktree) diff when a file has both
    const staged = !!file.staged && !file.unstaged;
    openChangesDiff(sessionId, { path: file.path, staged, untracked: !!file.untracked, subSessionId });
  });
  return row;
}

function readStoredChangesListHeight() {
  const stored = parseInt(localStorage.getItem(CHANGES_LIST_HEIGHT_KEY), 10);
  return Number.isFinite(stored) ? Math.max(MIN_CHANGES_LIST_HEIGHT, stored) : DEFAULT_CHANGES_LIST_HEIGHT;
}

// see .ai/contexts/changes-view.md ("The list and the editor")
function clampChangesListHeight(height, available) {
  const wanted = Math.max(MIN_CHANGES_LIST_HEIGHT, Math.round(height));
  if (!available) return wanted;
  const ceiling = available - MIN_CHANGES_EDITOR_HEIGHT;
  return Math.min(wanted, Math.max(MIN_CHANGES_LIST_HEIGHT, ceiling));
}

function applyChangesListHeight() {
  const layout = currentPanelListLayout();
  const available = panelListAvailableHeight(layout);
  const desired = layout.touched ? available * touchedListRatio : changesListDesiredHeight;
  layout.list.style.height = clampChangesListHeight(desired, available) + 'px';
}

function readStoredTouchedListRatio() {
  try {
    const value = Number(localStorage.getItem(TOUCHED_LIST_RATIO_KEY));
    if (value > 0 && value < 1) return value;
  } catch {}
  return DEFAULT_TOUCHED_LIST_RATIO;
}

function currentPanelListLayout() {
  const tab = filePanelState.get(currentPanelSessionId)?.currentTab;
  const touched = tab?.type === 'touched' || tab?.returnList?.type === 'touched';
  return {
    touched,
    container: touched ? document.getElementById('file-panel-touched') : changesContainerEl,
    summary: touched ? document.getElementById('touched-summary') : changesSummaryEl,
    list: touched ? document.getElementById('touched-list') : changesListEl,
  };
}

function panelListAvailableHeight(layout) {
  const margins = layout.touched ? [layout.list, layout.summary].reduce((sum, el) => {
    const style = getComputedStyle(el);
    return sum + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  }, 0) : 0;
  return Math.max(0, layout.container.clientHeight - layout.summary.offsetHeight
    - margins - (layout.touched ? layout.container.querySelector('.viewer-toolbar').offsetHeight + changesListSplitterEl.offsetHeight : 0));
}

function renderPanelListLayout(editorOpen) {
  const layout = currentPanelListLayout();
  if (changesDiffEl.parentElement !== layout.container) {
    layout.container.append(changesListSplitterEl, changesDiffEl);
  }
  changesListSplitterEl.style.display = editorOpen ? 'block' : 'none';
  changesDiffEl.style.display = editorOpen ? 'flex' : 'none';
  layout.list.classList.toggle('changes-list-split', editorOpen);
  if (editorOpen) applyChangesListHeight();
  else layout.list.style.height = '';
}

function setupChangesListSplitter() {
  if (typeof createSplitter !== 'function') return;
  createSplitter(changesListSplitterEl, {
    axis: 'y',
    getSize: () => {
      const layout = currentPanelListLayout();
      return layout.list.offsetHeight || parseFloat(layout.list.style.height) || changesListDesiredHeight;
    },
    onDrag: (startSize, delta) => {
      const layout = currentPanelListLayout();
      const available = panelListAvailableHeight(layout);
      if (layout.touched) {
        if (available) touchedListRatio = Math.min(0.95, clampChangesListHeight(startSize + delta, available) / available);
      } else changesListDesiredHeight = Math.max(MIN_CHANGES_LIST_HEIGHT, Math.round(startSize + delta));
      applyChangesListHeight();
    },
    onCommit: () => {
      try {
        const touched = currentPanelListLayout().touched;
        localStorage.setItem(touched ? TOUCHED_LIST_RATIO_KEY : CHANGES_LIST_HEIGHT_KEY, String(touched ? touchedListRatio : changesListDesiredHeight));
      } catch {}
    },
  });
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      const tab = filePanelState.get(currentPanelSessionId)?.currentTab;
      if (tab?.selectedFile) applyChangesListHeight();
    });
    observer.observe(filePanelContentEl);
    const touched = document.getElementById('file-panel-touched');
    if (touched) observer.observe(touched);
    observer.observe(changesContainerEl);
  }
}

// Built once: a render must never tear the open editor down — see .ai/contexts/changes-view.md
function buildChangesDiffChrome() {
  const header = document.createElement('div');
  header.className = 'viewer-toolbar';

  const info = document.createElement('div');
  info.className = 'viewer-toolbar-info';
  changesDiffTitleEl = document.createElement('span');
  changesDiffTitleEl.className = 'viewer-toolbar-title';
  changesDiffTitleEl.id = 'changes-diff-path';
  info.appendChild(changesDiffTitleEl);
  header.appendChild(info);

  const controls = document.createElement('div');
  controls.className = 'viewer-toolbar-controls';

  const closeEditorBtn = document.createElement('button');
  closeEditorBtn.className = 'icon-btn fp-close-btn';
  closeEditorBtn.id = 'changes-diff-close-btn';
  closeEditorBtn.innerHTML = FP_ICONS.close;
  closeEditorBtn.title = 'Close the editor and keep the file list';
  closeEditorBtn.setAttribute('aria-label', closeEditorBtn.title);
  closeEditorBtn.addEventListener('click', () => {
    if (currentPanelSessionId) closeChangesDiff(currentPanelSessionId);
  });
  controls.appendChild(closeEditorBtn);

  changesDiffFormatBtn = document.createElement('button');
  changesDiffFormatBtn.className = 'icon-btn';
  changesDiffFormatBtn.id = 'changes-diff-format-btn';
  changesDiffFormatBtn.innerHTML = FP_ICONS.formatted;
  changesDiffFormatBtn.addEventListener('click', handleChangesFormatToggle);
  controls.appendChild(changesDiffFormatBtn);

  changesDiffModeBtn = document.createElement('button');
  changesDiffModeBtn.className = 'icon-btn';
  changesDiffModeBtn.id = 'changes-diff-mode-btn';
  changesDiffModeBtn.addEventListener('click', handleChangesDiffModeToggle);
  controls.appendChild(changesDiffModeBtn);

  changesDiffReloadBtn = document.createElement('button');
  changesDiffReloadBtn.className = 'icon-btn';
  changesDiffReloadBtn.id = 'changes-diff-reload-btn';
  changesDiffReloadBtn.innerHTML = FP_ICONS.reload;
  changesDiffReloadBtn.title = 'Re-read this file from disk';
  changesDiffReloadBtn.setAttribute('aria-label', changesDiffReloadBtn.title);
  changesDiffReloadBtn.addEventListener('click', () => {
    if (currentPanelSessionId) reloadChangesFile(currentPanelSessionId);
  });
  controls.appendChild(changesDiffReloadBtn);

  changesDiffSaveBtn = document.createElement('button');
  changesDiffSaveBtn.className = 'icon-btn fp-save-btn';
  changesDiffSaveBtn.id = 'changes-diff-save-btn';
  changesDiffSaveBtn.innerHTML = FP_ICONS.save;
  changesDiffSaveBtn.title = 'Save this file (Ctrl/Cmd+S)';
  changesDiffSaveBtn.setAttribute('aria-label', changesDiffSaveBtn.title);
  changesDiffSaveBtn.addEventListener('click', () => {
    if (currentPanelSessionId) handleChangesSave(currentPanelSessionId);
  });
  controls.appendChild(changesDiffSaveBtn);

  header.appendChild(controls);
  changesDiffEl.appendChild(header);

  changesDiffNoticeEl = document.createElement('div');
  changesDiffNoticeEl.id = 'changes-diff-notice';
  changesDiffNoticeEl.style.display = 'none';
  changesDiffEl.appendChild(changesDiffNoticeEl);

  changesDiffHostEl = document.createElement('div');
  changesDiffHostEl.id = 'changes-diff-host';
  changesDiffEl.appendChild(changesDiffHostEl);

  changesDiffPreviewEl = document.createElement('div');
  changesDiffPreviewEl.id = 'changes-diff-preview';
  changesDiffPreviewEl.className = 'markdown-preview';
  changesDiffPreviewEl.tabIndex = 0;
  changesDiffPreviewEl.style.display = 'none';
  changesDiffEl.appendChild(changesDiffPreviewEl);

  changesDiffEl.addEventListener('cm-save', () => {
    if (currentPanelSessionId) handleChangesSave(currentPanelSessionId);
  });
}

function renderChangesDiff(sessionId, tab) {
  window.setViewerPath(changesDiffTitleEl, tab.selectedFile.path);

  const markdown = isMarkdownPath(tab.absolutePath);
  const formatted = markdown && !!tab.formatted;
  changesDiffFormatBtn.style.display = markdown ? '' : 'none';
  changesDiffFormatBtn.setAttribute('aria-pressed', String(formatted));
  changesDiffFormatBtn.title = formatted ? 'Formatted — click for the source' : 'Source — click for formatted';
  changesDiffFormatBtn.setAttribute('aria-label', changesDiffFormatBtn.title);
  changesDiffHostEl.style.display = formatted ? 'none' : '';
  changesDiffPreviewEl.style.display = formatted ? '' : 'none';
  if (formatted) renderChangesPreview(sessionId, tab);

  changesDiffModeBtn.style.display = tab.editable && !tab.noDiff && !formatted ? '' : 'none';
  const nextMode = CHANGES_DIFF_MODES[(CHANGES_DIFF_MODES.indexOf(changesDiffMode) + 1) % CHANGES_DIFF_MODES.length];
  setModeButton(changesDiffModeBtn, changesDiffMode, nextMode);
  changesDiffSaveBtn.style.display = tab.editable && !tab.readOnly ? '' : 'none';
  updateChangesSaveButton(sessionId, tab);
  changesDiffReloadBtn.style.display = tab.editable ? '' : 'none';

  renderChangesNotice(tab);

  if (tab.editable) {
    ensureChangesEditor(sessionId, tab);
    return;
  }

  destroyChangesEditor(tab);
  const body = document.createElement('pre');
  body.className = 'changes-diff-body';

  if (tab.diffLoading) {
    body.textContent = 'Loading diff…';
  } else if (tab.diffError) {
    body.textContent = tab.diffError;
    body.classList.add('changes-error');
  } else if (!tab.diffContent) {
    body.textContent = 'No differences.';
  } else {
    renderDiffLines(body, tab.diffContent);
  }

  changesDiffHostEl.innerHTML = '';
  changesDiffHostEl.appendChild(body);
}

// see .ai/contexts/touched-files.md ("Markdown, formatted")
function renderChangesPreview(sessionId, tab) {
  window.loadCodeMirrorBundle().then(() => {
    if (filePanelState.get(sessionId)?.currentTab !== tab) return;
    renderMarkdownPreview(changesDiffPreviewEl, readChangesEditorContent(tab) ?? tab.current);
    if (changesPreviewTab !== tab) {
      changesPreviewTab = tab;
      changesDiffPreviewEl.scrollTop = 0;
    }
  }).catch((err) => {
    console.error('[file-panel] Failed to load codemirror-bundle:', err);
  });
}

function readStoredTouchedMarkdownFormatted() {
  try {
    const value = localStorage.getItem(TOUCHED_MARKDOWN_FORMATTED_KEY);
    if (value != null) return value !== 'false';
  } catch {}
  return DEFAULT_TOUCHED_MARKDOWN_FORMATTED;
}

function touchedOpensFormatted(absolutePath) {
  return isMarkdownPath(absolutePath) && readStoredTouchedMarkdownFormatted();
}

function handleChangesFormatToggle() {
  const tab = filePanelState.get(currentPanelSessionId)?.currentTab;
  if (!tab) return;
  tab.formatted = !tab.formatted;
  try { localStorage.setItem(TOUCHED_MARKDOWN_FORMATTED_KEY, String(tab.formatted)); } catch {}
  renderPanel(currentPanelSessionId);
  if (tab.formatted) changesDiffPreviewEl.focus();
}

// see .ai/contexts/changes-view.md ("A dirty buffer is never overwritten, and never lied to")
function updateChangesSaveButton(sessionId, tab) {
  const state = filePanelState.get(sessionId);
  if (!state || state.currentTab !== tab) return;
  changesDiffSaveBtn.disabled = !!tab.readOnly || !!tab.saving || !isChangesBufferDirty(tab);
  changesDiffSaveBtn.classList.toggle('active', !changesDiffSaveBtn.disabled);
}

function renderChangesNotice(tab) {
  const notes = [];
  const listFailed = !!tab.error && !tab.notARepo;
  const alarming = !!(tab.saveError || tab.fileError || listFailed || tab.externalChange || tab.restoredEdits);
  if (tab.remote) notes.push('Remote session — read-only.');
  if (tab.readOnly && !tab.remote) notes.push('Symbolic link — read-only.');
  if (tab.fallbackReason) notes.push(`${tab.fallbackReason} — showing the diff read-only.`);
  if (tab.diffTruncated) notes.push('Diff truncated at 512 KB.');
  if (tab.restoredEdits) notes.push('Unsaved edits kept from when the session opened something else in this panel have been restored.');
  if (tab.externalChange) notes.push('This file changed on disk since you opened it — reload before saving, or your edits will not be accepted.');
  if (tab.fileError) notes.push(`This file can no longer be read: ${tab.fileError}`);
  if (tab.notARepo) notes.push(NOT_A_REPO_TEXT);
  else if (tab.error) notes.push(`The file list could not be refreshed: ${tab.error}`);
  if (tab.saveError) notes.push(`Save failed: ${tab.saveError}`);

  changesDiffNoticeEl.textContent = notes.join(' ');
  changesDiffNoticeEl.style.display = notes.length ? '' : 'none';
  changesDiffNoticeEl.classList.toggle('changes-error', alarming);
  changesDiffNoticeEl.classList.toggle('changes-diff-truncated', !alarming);
}

// see .ai/contexts/changes-view.md ("The render path is not a teardown")
function ensureChangesEditor(sessionId, tab) {
  const key = changesEditorKey(tab);
  const mode = tab.noDiff ? 'plain' : changesDiffMode;
  if (tab.editorView && tab.editorKey === key && tab.editorMode === mode) {
    mountChangesEditor(tab.editorView.dom);
    consumeChangesPendingLine(tab);
    return;
  }
  const token = JSON.stringify([key, mode]);
  if (tab.editorPending === token) return;

  destroyChangesEditor(tab);
  changesDiffHostEl.innerHTML = '';

  tab.editorPending = token;

  window.loadCodeMirrorBundle().then(() => {
    const state = filePanelState.get(sessionId);
    if (!state || state.currentTab !== tab || tab.editorPending !== token) return;
    tab.editorPending = null;
    if (!tab.selectedFile || !tab.editable) return;

    const filename = tab.selectedFile.path;
    const onChange = () => updateChangesSaveButton(sessionId, tab);
    if (tab.readOnly && (!tab.remote || mode === 'plain')) {
      tab.editorView = window.createReadOnlyViewer(changesDiffHostEl, tab.current, filename);
    } else if (mode === 'plain') {
      tab.editorView = window.createEditableViewer(changesDiffHostEl, tab.current, filename, { onChange });
    } else if (mode === 'inline') {
      // mergeControls: false — this panel is not a git client, see .ai/contexts/changes-view.md
      tab.editorView = window.createUnifiedMergeViewer(changesDiffHostEl, tab.original, tab.current, filename, { mergeControls: false, onChange, readOnly: !!tab.readOnly });
    } else {
      tab.editorView = window.createMergeViewer(changesDiffHostEl, tab.original, tab.current, filename, { onChange, readOnly: !!tab.readOnly });
    }
    tab.editorKey = key;
    tab.editorMode = mode;
    updateChangesSaveButton(sessionId, tab);
    consumeChangesPendingLine(tab);
  }).catch((err) => {
    tab.editorPending = null;
    console.error('[file-panel] Failed to load codemirror-bundle:', err);
  });
}

// see .ai/contexts/terminal-path-links.md ("`path:line` and `path:line:col`")
function consumeChangesPendingLine(tab) {
  if (!tab.pendingLine || !tab.editorView || !window.cmRevealLine) return;
  const line = tab.pendingLine;
  tab.pendingLine = null;
  window.cmRevealLine(tab.editorView, line);
}

// see .ai/contexts/changes-view.md ("A dirty buffer is never overwritten, and never lied to")
function mountChangesEditor(dom) {
  for (const child of Array.from(changesDiffHostEl.children)) {
    if (child !== dom) changesDiffHostEl.removeChild(child);
  }
  if (dom.parentNode !== changesDiffHostEl) changesDiffHostEl.appendChild(dom);
}

function isSelectedChangesRow(tab, file) {
  const selected = tab && tab.selectedFile;
  return !!selected && selected.path === file.path && (selected.subSessionId || null) === (file.subSessionId || null);
}

function changesEditorKey(tab) {
  const file = tab.selectedFile;
  return file ? JSON.stringify([file.path, !!file.staged]) : '';
}

function destroyChangesEditor(tab) {
  tab.editorPending = null;
  if (!tab.editorView) return;
  try { tab.editorView.destroy(); } catch {}
  tab.editorView = null;
  tab.editorKey = null;
  tab.editorMode = null;
  if (changesDiffHostEl) {
    delete changesDiffHostEl._cmSearchBar;
    delete changesDiffHostEl._cmGotoLine;
  }
}

// see .ai/contexts/changes-view.md ("A dirty buffer is never overwritten")
function readChangesEditorContent(tab) {
  const view = tab.editorView;
  if (!view) return null;
  if (tab.editorMode === 'side-by-side') {
    return view.b ? view.b.state.doc.toString() : null;
  }
  return view.state ? view.state.doc.toString() : null;
}

function isChangesBufferDirty(tab) {
  const content = readChangesEditorContent(tab);
  return content != null && content !== tab.savedContent;
}

function handleChangesDiffModeToggle() {
  const next = (CHANGES_DIFF_MODES.indexOf(changesDiffMode) + 1) % CHANGES_DIFF_MODES.length;
  changesDiffMode = CHANGES_DIFF_MODES[next];
  localStorage.setItem(CHANGES_DIFF_MODE_KEY, changesDiffMode);

  if (!currentPanelSessionId) return;
  const state = filePanelState.get(currentPanelSessionId);
  const tab = state && state.currentTab;
  if (!tab || tab.type !== 'changes') return;

  const pending = readChangesEditorContent(tab);
  if (pending != null) tab.current = pending;
  destroyChangesEditor(tab);
  renderPanel(currentPanelSessionId);
}

async function handleChangesSave(sessionId) {
  const state = filePanelState.get(sessionId);
  const tab = state && state.currentTab;
  if (!tab || tab.type !== 'changes' || !tab.editable || tab.readOnly || !tab.selectedFile || tab.saving) return;
  if (!isChangesBufferDirty(tab)) return;

  const content = readChangesEditorContent(tab);
  if (content == null) return;

  const file = tab.selectedFile;
  tab.saving = true;
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);

  let result;
  try {
    result = tab.absolutePath
      ? await window.api.saveFileForPanel(tab.absolutePath, content, tab.savedContent, { git: tab.gitFile, version: tab.version })
      : await window.api.gitChangesSave(sessionId, file.path, content, tab.version);
  } catch (err) {
    result = { ok: false, error: (err && err.message) || 'the save could not be sent' };
  } finally {
    tab.saving = false;
  }

  const stillState = filePanelState.get(sessionId);
  if (!stillState || stillState.currentTab !== tab || tab.selectedFile !== file) {
    return;
  }

  if (!result || result.ok === false) {
    tab.saveError = (result && result.error) || 'failed to save';
    if (result && result.reason === 'stale') tab.externalChange = true;
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }

  tab.saveError = null;
  tab.externalChange = false;
  tab.current = content;
  tab.savedContent = content;
  if (result.version) tab.version = result.version;
  if (typeof window.flashButtonText === 'function') window.flashButtonText(changesDiffSaveBtn, 'Saved!');

  await refreshChanges(sessionId);

  const afterState = filePanelState.get(sessionId);
  if (!afterState || afterState.currentTab !== tab) return;
  if (!tab.selectedFile || tab.selectedFile.path !== file.path) return;
  // see .ai/contexts/changes-view.md ("A dirty buffer is never overwritten, and never lied to")
  if (file.untracked) {
    applyUntrackedCounts(tab, tab.data, file.path, countAddedLines(content), 0);
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
  }
}

async function reloadChangesFile(sessionId) {
  const state = filePanelState.get(sessionId);
  const tab = state && state.currentTab;
  if (!tab || tab.type !== 'changes' || !tab.editable || !tab.selectedFile) return;
  if (!confirmDiscardChangesEdits(tab)) return;

  const file = tab.selectedFile;
  const result = await readChangesPair(sessionId, tab, file);

  const stillState = filePanelState.get(sessionId);
  if (!stillState || stillState.currentTab !== tab || tab.selectedFile !== file) return;

  if (!result || result.ok === false) {
    tab.fileError = (result && result.error) || 'this file could not be read';
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }

  tab.fileError = null;
  tab.externalChange = false;
  tab.saveError = null;
  applyChangesPair(tab, result);
  tab.version = result.version;
  watchChangesFile(sessionId, tab, file.path);
  destroyChangesEditor(tab);
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
}

// see .ai/contexts/changes-view.md ("why not ViewerPanel for the diff")
function renderDiffLines(container, text) {
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) {
    const div = document.createElement('div');
    div.className = 'changes-diff-line ' + classifyDiffLine(line);
    div.textContent = line;
    frag.appendChild(div);
  }
  container.appendChild(frag);
}

function classifyDiffLine(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'changes-diff-file-header';
  if (line.startsWith('@@')) return 'changes-diff-hunk';
  if (line.startsWith('+')) return 'changes-diff-add';
  if (line.startsWith('-')) return 'changes-diff-del';
  return 'changes-diff-ctx';
}

// ── IDE Emulation Indicator ─────────────────────────────────────────

let mcpIndicatorEl = null;

const MCP_INDICATOR_STATES = {
  connected: { text: 'IDE Emulation', title: 'IDE Emulation is active: the CLI is connected. Go to Global Settings to disable.' },
  listening: { text: 'IDE Emulation: waiting for CLI', title: 'IDE Emulation server is listening but the CLI is not connected, so file opens will not reach Switchboard.' },
  failed: { text: 'IDE Emulation: failed', title: 'IDE Emulation could not start for this session; it runs without it.' },
};

function addMcpToggle() {
  mcpIndicatorEl = document.createElement('span');
  mcpIndicatorEl.id = 'ide-emulation-indicator';
  mcpIndicatorEl.title = 'IDE Emulation is active. Go to Global Settings to disable.';
  mcpIndicatorEl.textContent = 'IDE Emulation';
  mcpIndicatorEl.style.display = 'none';
  placeHeaderControl(mcpIndicatorEl);
}

// Terminal header entry point for Changes mode — see .ai/contexts/changes-view.md
function addChangesToggle() {
  changesToggleBtn = createHeaderToggle({
    id: 'changes-toggle-btn',
    label: 'Changes',
    title: 'Show working tree changes for this session',
    icon: 'changes',
    onClick: () => {
      if (currentPanelSessionId) toggleChangesTab(currentPanelSessionId);
    },
  });
}

// ── Resize Handle ───────────────────────────────────────────────────

function setupPanelResizeHandle() {
  if (!filePanelResizeHandle) return;

  let startX = 0;
  let startWidth = 0;

  function onMouseDown(e) {
    e.preventDefault();
    startX = e.clientX;
    startWidth = filePanelEl.offsetWidth;
    filePanelResizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    const delta = startX - e.clientX;
    const newWidth = Math.max(MIN_PANEL_WIDTH, startWidth + delta);
    filePanelEl.style.width = newWidth + 'px';
  }

  function onMouseUp() {
    filePanelResizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    const w = filePanelEl.offsetWidth;
    localStorage.setItem(PANEL_WIDTH_KEY, w);
    if (currentPanelSessionId) {
      const state = getSessionState(currentPanelSessionId);
      state.panelWidth = w;
    }

    refitActiveTerminal();
  }

  filePanelResizeHandle.addEventListener('mousedown', onMouseDown);
}

// ── Terminal Refit ──────────────────────────────────────────────────

function refitActiveTerminal() {
  requestAnimationFrame(() => {
    if (typeof openSessions !== 'undefined' && currentPanelSessionId) {
      const entry = openSessions.get(currentPanelSessionId);
      if (entry && entry.fitAddon) {
        try { safeFit(entry); } catch {}
      }
    }
  });
}

// ── Utility ─────────────────────────────────────────────────────────

function heldTabLabels(tabs) {
  const parts = tabs.map((tab) => String(tab.filePath).replace(/\\/g, '/').split('/'));
  const depth = tabs.map(() => 1);
  const longest = Math.max(...parts.map((p) => p.length));
  let labels = [];
  for (let round = 0; round < longest; round++) {
    labels = parts.map((p, i) => p.slice(-depth[i]).join('/'));
    const clashes = labels.map((label, i) => labels.some((other, j) => j !== i && other === label));
    if (!clashes.includes(true)) break;
    clashes.forEach((clash, i) => { if (clash) depth[i] += 1; });
  }
  return labels;
}

function basename(filePath) {
  if (!filePath) return 'untitled';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'untitled';
}
