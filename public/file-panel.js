/**
 * file-panel.js — Renderer-side file/diff side panel for Switchboard.
 *
 * Manages a collapsible panel to the right of the terminal that shows
 * files and diffs received from the MCP bridge.
 *
 * For files: delegates to a ViewerPanel instance (shared component).
 * For diffs: uses its own MergeView rendering with accept/reject.
 *
 * Globals expected: window.api, window.ViewerPanel,
 *   window.createMergeViewer, window.createUnifiedMergeViewer,
 *   window.createViewerToolbar, openSessions (from app.js)
 */

// ── Per-Session State ───────────────────────────────────────────────

const filePanelState = new Map();

// ── DOM References ──────────────────────────────────────────────────

let filePanelEl = null;
let filePanelContentEl = null;  // container for ViewerPanel or diff content
let filePanelResizeHandle = null;
let terminalSplitEl = null;
let currentPanelSessionId = null;

// ViewerPanel instance for file-type tabs
let fpViewerPanel = null;

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
let changesDiffSaveBtn = null;
let changesDiffReloadBtn = null;
let changesDiffNoticeEl = null;
let changesDiffHostEl = null;
let changesListSplitterEl = null;

// Row ceiling for the Changes list — see .ai/contexts/changes-view.md ("Untracked files")
const MAX_CHANGES_ROWS = 500;

const CHANGES_LIST_HEIGHT_KEY = 'changesListHeight';
const DEFAULT_CHANGES_LIST_HEIGHT = 200;
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

const CHANGES_DIFF_MODE_KEY = 'changesDiffMode';
const CHANGES_DIFF_MODES = ['side-by-side', 'inline', 'plain'];
const CHANGES_DIFF_MODE_LABELS = { 'side-by-side': 'Side-by-side', inline: 'Inline', plain: 'Plain' };
// see .ai/contexts/changes-view.md ("The list and the editor")
let changesDiffMode = CHANGES_DIFF_MODES.includes(localStorage.getItem(CHANGES_DIFF_MODE_KEY))
  ? localStorage.getItem(CHANGES_DIFF_MODE_KEY)
  : 'inline';

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

  // Content container — holds either ViewerPanel or diff UI
  filePanelContentEl = document.createElement('div');
  filePanelContentEl.id = 'file-panel-content';
  filePanelEl.appendChild(filePanelContentEl);

  // ── ViewerPanel for file-type tabs ──
  const vpContainer = document.createElement('div');
  vpContainer.id = 'file-panel-viewer';
  vpContainer.style.display = 'none';
  filePanelContentEl.appendChild(vpContainer);

  fpViewerPanel = new ViewerPanel(vpContainer, {
    language: 'auto',
    onSave: (filePath, content) => window.api.saveFileForPanel(filePath, content),
    onClose: handleClose,
  });

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
  diffToggleBtn.className = 'fp-toolbar-btn';
  diffToggleBtn.textContent = diffMode === 'inline' ? 'Side-by-Side' : 'Inline';
  diffToggleBtn.title = diffMode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';
  diffToggleBtn.addEventListener('click', handleDiffModeToggle);
  diffControls.appendChild(diffToggleBtn);

  const diffSaveBtn = document.createElement('button');
  diffSaveBtn.className = 'fp-toolbar-btn fp-save-btn fp-icon-btn';
  diffSaveBtn.title = 'Save changes';
  diffSaveBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M433.941 129.941l-83.882-83.882A48 48 0 0 0 316.118 32H48C21.49 32 0 53.49 0 80v352c0 26.51 21.49 48 48 48h352c26.51 0 48-21.49 48-48V163.882a48 48 0 0 0-14.059-33.941zM272 80v80H144V80h128zm122 352H54a6 6 0 0 1-6-6V86a6 6 0 0 1 6-6h42v104c0 13.255 10.745 24 24 24h176c13.255 0 24-10.745 24-24V83.882l78.243 78.243a6 6 0 0 1 1.757 4.243V426a6 6 0 0 1-6 6zM224 232c-48.523 0-88 39.477-88 88s39.477 88 88 88 88-39.477 88-88-39.477-88-88-88zm0 128c-22.056 0-40-17.944-40-40s17.944-40 40-40 40 17.944 40 40-17.944 40-40 40z"></path></svg>';
  diffSaveBtn.addEventListener('click', handleDiffSave);
  diffControls.appendChild(diffSaveBtn);

  const diffCloseBtn = document.createElement('button');
  diffCloseBtn.className = 'fp-toolbar-btn fp-close-btn fp-icon-btn';
  diffCloseBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>';
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
  changesRefreshBtn.className = 'fp-toolbar-btn fp-icon-btn';
  changesRefreshBtn.id = 'changes-refresh-btn';
  changesRefreshBtn.title = 'Refresh the file list';
  changesRefreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
  changesRefreshBtn.addEventListener('click', () => {
    if (currentPanelSessionId) refreshChanges(currentPanelSessionId);
  });
  changesControls.appendChild(changesRefreshBtn);

  const changesCloseBtn = document.createElement('button');
  changesCloseBtn.className = 'fp-toolbar-btn fp-close-btn fp-icon-btn';
  changesCloseBtn.innerHTML = '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 512 512" width="14" height="14" xmlns="http://www.w3.org/2000/svg"><path d="M400 145.49 366.51 112 256 222.51 145.49 112 112 145.49 222.51 256 112 366.51 145.49 400 256 289.49 366.51 400 400 366.51 289.49 256 400 145.49z"></path></svg>';
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
  setupChangesListSplitter();
  // Shell region below every tab type — see .ai/contexts/panel-terminal.md
  if (typeof initPanelTerminal === 'function') initPanelTerminal(filePanelContentEl);

  terminalSplitEl.appendChild(filePanelEl);
  terminalArea.appendChild(terminalSplitEl);

  wireIpcListeners();
  setupPanelResizeHandle();
  addMcpToggle();
  addChangesToggle();

  // see .ai/contexts/changes-view.md ("Refresh triggers")
  if (typeof onSessionIdle === 'function') {
    onSessionIdle((sessionId) => {
      const state = filePanelState.get(sessionId);
      if (state && state.currentTab && state.currentTab.type === 'changes') {
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

  if (tab) {
    if (!confirmDiscardChangesEdits(tab)) return;
    if (tab.type === 'diff' && !tab.resolved) {
      window.api.mcpDiffResponse(currentPanelSessionId, tab.diffId, 'reject', null);
    }
    if (tab.type === 'diff' && tab.editorView) {
      tab.editorView.destroy();
      tab.editorView = null;
    }
    if (tab.type === 'changes') {
      unwatchChangesFile(currentPanelSessionId, tab);
      destroyChangesEditor(tab);
    }
    if (tab.type === 'file') {
      fpViewerPanel.destroy();
    }
    state.currentTab = null;
  }

  state.panelVisible = false;
  hidePanel();
}

async function handleDiffSave() {
  const state = currentPanelSessionId ? getSessionState(currentPanelSessionId) : null;
  const tab = state?.currentTab;
  if (!tab || tab.type !== 'diff' || !tab.editorView || !tab.filePath) return;

  let content;
  if (tab._diffMode === 'inline') {
    content = tab.editorView.state.doc.toString();
  } else if (tab.editorView.b) {
    content = tab.editorView.b.state.doc.toString();
  }
  if (content == null) return;

  const result = await window.api.saveFileForPanel(tab.filePath, content);
  if (result.ok) {
    const btn = diffToolbarEl.querySelector('.fp-save-btn');
    if (btn) flashButtonText(btn, 'Saved!');
  }
}

function handleDiffModeToggle() {
  diffMode = diffMode === 'inline' ? 'side-by-side' : 'inline';
  localStorage.setItem(DIFF_MODE_KEY, diffMode);
  diffToggleBtn.textContent = diffMode === 'inline' ? 'Side-by-Side' : 'Inline';
  diffToggleBtn.title = diffMode === 'inline' ? 'Switch to side-by-side diff' : 'Switch to inline diff';

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
    openFileTab(sessionId, data);
  });

  window.api.onMcpCloseAllDiffs((sessionId) => {
    closeAllDiffs(sessionId);
  });

  window.api.onMcpCloseTab((sessionId, diffId) => {
    closeDiffByDiffId(sessionId, diffId);
  });

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
      mcpActive: false,
    });
  }
  return filePanelState.get(sessionId);
}

function setSessionMcpActive(sessionId, active) {
  const state = getSessionState(sessionId);
  state.mcpActive = active;
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
    resolved: false,
    editorView: null,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function openFileTab(sessionId, data) {
  const state = getSessionState(sessionId);

  // Destroy previous
  destroyCurrentTab(state);

  state.currentTab = {
    type: 'file',
    label: basename(data.filePath),
    filePath: data.filePath,
    content: data.content,
    pendingLine: Number.isInteger(data.line) && data.line > 0 ? data.line : null,
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

// see .ai/contexts/changes-view.md ("A dirty buffer is never overwritten, and never lied to")
function stashChangesEdits(state, tab) {
  if (!tab || tab.type !== 'changes' || !tab.selectedFile) return;
  const content = readChangesEditorContent(tab);
  if (content == null || content === tab.savedContent) return;
  state.changesStash = {
    file: tab.selectedFile,
    content,
    original: tab.original,
    savedContent: tab.savedContent,
    version: tab.version,
  };
}

function restoreChangesEdits(sessionId, state, tab) {
  const stash = state.changesStash;
  if (!stash) return false;
  state.changesStash = null;

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
  if (tab.type === 'file') {
    fpViewerPanel.destroy();
  }
}

// see .ai/contexts/changes-view.md ("File links") and .ai/contexts/terminal-path-links.md
async function openFileInPanel(sessionId, filePath, opts = {}) {
  const line = Number.isInteger(opts.line) && opts.line > 0 ? opts.line : null;
  const row = await locateChangesRow(sessionId, filePath);
  if (row) return openChangesTabAt(sessionId, row, line);

  const result = await window.api.readFileForPanel(filePath);
  if (!result.ok) return;
  openFileTab(sessionId, { filePath, content: result.content, line });
}

async function locateChangesRow(sessionId, filePath) {
  if (!window.api.gitChangesLocate) return null;
  let located;
  try {
    located = await window.api.gitChangesLocate(sessionId, filePath);
  } catch {
    return null;
  }
  if (!located || !located.ok || !located.changed) return null;
  return { path: located.relPath, staged: !!located.staged, untracked: !!located.untracked };
}

async function openChangesTabAt(sessionId, file, line = null) {
  const tab = getSessionState(sessionId).currentTab;
  if (!tab || tab.type !== 'changes') await openChangesTab(sessionId);
  // openChangesDiff owns the discard question for every route into it.
  return openChangesDiff(sessionId, file, line);
}

function closeAllDiffs(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state) return;

  if (state.currentTab?.type === 'diff') {
    destroyCurrentTab(state);
    state.currentTab = null;
    state.panelVisible = false;
    if (currentPanelSessionId === sessionId) hidePanel();
  }
}

function closeDiffByDiffId(sessionId, diffId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab) return;
  if (state.currentTab.type !== 'diff' || state.currentTab.diffId !== diffId) return;

  state.currentTab.resolved = true;
  destroyCurrentTab(state);
  state.currentTab = null;
  state.panelVisible = false;
  if (currentPanelSessionId === sessionId) hidePanel();
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
  mcpIndicatorEl.style.display = (state && state.mcpActive) ? '' : 'none';
}

// ── Panel Rendering ─────────────────────────────────────────────────

function renderPanel(sessionId) {
  if (!filePanelEl || currentPanelSessionId !== sessionId) return;

  const state = getSessionState(sessionId);
  if (!state) return;

  renderTabContent(sessionId, state.currentTab);
}

function renderTabContent(sessionId, tab) {
  const vpContainer = document.getElementById('file-panel-viewer');
  const diffContainer = document.getElementById('file-panel-diff');
  // see .ai/contexts/panel-terminal.md ("Layout")
  if (typeof setPanelTerminalShellOnly === 'function') setPanelTerminalShellOnly(!tab);

  if (!tab) {
    vpContainer.style.display = 'none';
    diffContainer.style.display = 'none';
    changesContainerEl.style.display = 'none';
    return;
  }

  if (tab.type === 'file') {
    // Use ViewerPanel
    diffContainer.style.display = 'none';
    changesContainerEl.style.display = 'none';
    vpContainer.style.display = 'flex';
    fpViewerPanel.open(tab.label, tab.filePath, tab.content);
    if (tab.pendingLine) {
      fpViewerPanel.revealLine(tab.pendingLine);
      tab.pendingLine = null;
    }
  } else if (tab.type === 'changes') {
    vpContainer.style.display = 'none';
    diffContainer.style.display = 'none';
    changesContainerEl.style.display = 'flex';
    renderChangesContent(sessionId, tab);
  } else {
    // MCP diff mode
    vpContainer.style.display = 'none';
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
  if (pathEl) pathEl.textContent = tab.filePath || '';

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
}

// ── Changes Mode — see .ai/contexts/changes-view.md ──────────────────

function toggleChangesTab(sessionId) {
  const state = getSessionState(sessionId);
  if (state.currentTab && state.currentTab.type === 'changes') {
    if (!confirmDiscardChangesEdits(state.currentTab)) return;
    destroyCurrentTab(state, { stash: false });
    state.currentTab = null;
    state.panelVisible = false;
    if (currentPanelSessionId === sessionId) hidePanel();
    return;
  }
  return openChangesTab(sessionId);
}

function openChangesTab(sessionId) {
  const state = getSessionState(sessionId);
  destroyCurrentTab(state);
  state.currentTab = {
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
  state.panelVisible = true;
  restoreChangesEdits(sessionId, state, state.currentTab);

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
  return refreshChanges(sessionId);
}

async function refreshChanges(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'changes') return;
  const tab = state.currentTab;

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
  const result = await window.api.gitChangesFile(sessionId, file.path, { staged: !!file.staged });

  const stillState = filePanelState.get(sessionId);
  if (!stillState || stillState.currentTab !== tab || tab.selectedFile !== file) return;

  if (!result || result.ok === false) {
    tab.fileError = (result && result.error) || 'this file could not be read';
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }
  tab.fileError = null;

  if (isChangesBufferDirty(tab)) {
    tab.externalChange = result.version !== tab.version;
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }

  tab.version = result.version;
  tab.externalChange = false;
  if (result.current === tab.current && result.original === tab.original) {
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }

  tab.original = result.original;
  tab.current = result.current;
  tab.savedContent = result.current;
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
  tab.watchedPath = filePath;
  const watch = window.api.gitChangesWatch;
  if (watch) Promise.resolve(watch(sessionId, filePath)).catch(() => {});
}

function unwatchChangesFile(sessionId, tab) {
  if (!tab.watchedPath) return;
  const unwatch = window.api.gitChangesUnwatch;
  if (unwatch) Promise.resolve(unwatch(sessionId, tab.watchedPath)).catch(() => {});
  tab.watchedPath = null;
}

async function openChangesDiff(sessionId, file, line = null) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'changes') return;
  const tab = state.currentTab;

  if (tab.selectedFile && !isSelectedChangesRow(tab, file) && !confirmDiscardChangesEdits(tab)) return;

  tab.pendingLine = Number.isInteger(line) && line > 0 ? line : null;
  tab.selectedFile = file;
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

  if (!tab.remote) {
    const pair = await window.api.gitChangesFile(sessionId, file.path, { staged: !!file.staged });

    const pairState = filePanelState.get(sessionId);
    if (!pairState || pairState.currentTab !== tab || tab.selectedFile !== file) return;

    if (pair && pair.ok) {
      tab.diffLoading = false;
      tab.editable = true;
      tab.original = pair.original;
      tab.current = pair.current;
      tab.savedContent = pair.current;
      tab.version = pair.version;
      watchChangesFile(sessionId, tab, file.path);
      if (file.untracked) applyUntrackedCounts(tab, dataAtRequest, file.path, countAddedLines(pair.current), 0);
      if (currentPanelSessionId === sessionId) renderPanel(sessionId);
      return;
    }
    tab.fallbackReason = describeFallback(pair);
  }

  const result = await window.api.gitChangesDiff(sessionId, file.path, file.staged, file.untracked);

  const stillState = filePanelState.get(sessionId);
  if (!stillState || stillState.currentTab !== tab || tab.selectedFile !== file) return;

  tab.diffLoading = false;
  if (!result || result.ok === false) {
    tab.diffError = (result && result.error) || 'failed to load diff';
  } else {
    tab.diffContent = result.content;
    tab.diffTruncated = !!result.truncated;
    if (file.untracked) applyUntrackedCounts(tab, dataAtRequest, file.path, result.added, result.deleted);
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

// Untracked counts arrive with the diff, not with status — see .ai/contexts/changes-view.md
function applyUntrackedCounts(tab, expectedData, filePath, added, deleted) {
  if (typeof added !== 'number') return;
  if (!tab.data || tab.data !== expectedData || !Array.isArray(tab.data.files)) return;
  const record = tab.data.files.find((f) => f.path === filePath);
  if (!record) return;

  record.added = added;
  record.deleted = typeof deleted === 'number' ? deleted : 0;

  let totalAdded = 0;
  let totalDeleted = 0;
  for (const f of tab.data.files) {
    if (typeof f.added === 'number') totalAdded += f.added;
    if (typeof f.deleted === 'number') totalDeleted += f.deleted;
  }
  tab.data.totals = { ...tab.data.totals, added: totalAdded, deleted: totalDeleted };
}

function closeChangesDiff(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'changes') return;
  const tab = state.currentTab;
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
  const editorOpen = !!tab.selectedFile;
  changesSummaryEl.style.display = 'block';
  changesListEl.style.display = 'block';
  changesListSplitterEl.style.display = editorOpen ? 'block' : 'none';
  changesDiffEl.style.display = editorOpen ? 'flex' : 'none';
  changesListEl.classList.toggle('changes-list-split', editorOpen);
  if (editorOpen) applyChangesListHeight();
  else changesListEl.style.height = '';

  renderChangesList(sessionId, tab);
  if (editorOpen) renderChangesDiff(sessionId, tab);
}

function renderChangesList(sessionId, tab) {
  const branchInfoEl = document.getElementById('changes-branch-info');

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

  changesSummaryEl.textContent = totals.files === 0
    ? 'No changes'
    : `${totals.files} file${totals.files === 1 ? '' : 's'} changed +${totals.added} −${totals.deleted}`;

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
}

function buildChangesFileRow(sessionId, tab, file) {
  const row = document.createElement('div');
  row.className = 'changes-file-row';
  row.dataset.path = file.path;

  const state = document.createElement('span');
  state.className = 'changes-file-state changes-state-' + (file.state || '?').toLowerCase();
  state.textContent = file.state || '?';
  row.appendChild(state);

  const pathEl = document.createElement('span');
  pathEl.className = 'changes-file-path';
  pathEl.textContent = (file.renamed && file.origPath) ? `${file.origPath} → ${file.path}` : file.path;
  row.appendChild(pathEl);

  if (typeof file.added === 'number' || typeof file.deleted === 'number') {
    const counts = document.createElement('span');
    counts.className = 'changes-file-counts';
    const added = document.createElement('span');
    added.className = 'changes-added';
    added.textContent = '+' + (file.added || 0);
    const deleted = document.createElement('span');
    deleted.className = 'changes-deleted';
    deleted.textContent = '−' + (file.deleted || 0);
    counts.appendChild(added);
    counts.appendChild(deleted);
    row.appendChild(counts);
  }

  if (isSelectedChangesRow(tab, file)) row.classList.add('selected');

  row.addEventListener('click', () => {
    // prefer the unstaged (worktree) diff when a file has both
    const staged = !!file.staged && !file.unstaged;
    openChangesDiff(sessionId, { path: file.path, staged, untracked: !!file.untracked });
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
  if (!changesListEl || !changesContainerEl) return;
  const available = changesContainerEl.clientHeight - changesSummaryEl.offsetHeight;
  changesListEl.style.height = clampChangesListHeight(changesListDesiredHeight, available) + 'px';
}

function setupChangesListSplitter() {
  if (typeof createSplitter !== 'function') return;
  createSplitter(changesListSplitterEl, {
    axis: 'y',
    getSize: () => changesListEl.offsetHeight || changesListDesiredHeight,
    onDrag: (startSize, delta) => {
      changesListDesiredHeight = Math.max(MIN_CHANGES_LIST_HEIGHT, Math.round(startSize + delta));
      applyChangesListHeight();
    },
    onCommit: () => localStorage.setItem(CHANGES_LIST_HEIGHT_KEY, String(changesListDesiredHeight)),
  });
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
  closeEditorBtn.className = 'fp-toolbar-btn';
  closeEditorBtn.id = 'changes-diff-close-btn';
  closeEditorBtn.textContent = 'Close';
  closeEditorBtn.title = 'Close the editor and keep the file list';
  closeEditorBtn.addEventListener('click', () => {
    if (currentPanelSessionId) closeChangesDiff(currentPanelSessionId);
  });
  controls.appendChild(closeEditorBtn);

  changesDiffModeBtn = document.createElement('button');
  changesDiffModeBtn.className = 'fp-toolbar-btn';
  changesDiffModeBtn.id = 'changes-diff-mode-btn';
  changesDiffModeBtn.addEventListener('click', handleChangesDiffModeToggle);
  controls.appendChild(changesDiffModeBtn);

  changesDiffReloadBtn = document.createElement('button');
  changesDiffReloadBtn.className = 'fp-toolbar-btn';
  changesDiffReloadBtn.id = 'changes-diff-reload-btn';
  changesDiffReloadBtn.textContent = 'Reload';
  changesDiffReloadBtn.title = 'Re-read this file from disk';
  changesDiffReloadBtn.addEventListener('click', () => {
    if (currentPanelSessionId) reloadChangesFile(currentPanelSessionId);
  });
  controls.appendChild(changesDiffReloadBtn);

  changesDiffSaveBtn = document.createElement('button');
  changesDiffSaveBtn.className = 'fp-toolbar-btn fp-save-btn';
  changesDiffSaveBtn.id = 'changes-diff-save-btn';
  changesDiffSaveBtn.textContent = 'Save';
  changesDiffSaveBtn.title = 'Save this file (Ctrl/Cmd+S)';
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

  changesDiffEl.addEventListener('cm-save', () => {
    if (currentPanelSessionId) handleChangesSave(currentPanelSessionId);
  });
}

function renderChangesDiff(sessionId, tab) {
  changesDiffTitleEl.textContent = tab.selectedFile.path;

  changesDiffModeBtn.style.display = tab.editable ? '' : 'none';
  changesDiffModeBtn.textContent = CHANGES_DIFF_MODE_LABELS[changesDiffMode];
  changesDiffModeBtn.title = 'Diff view mode — click to cycle';
  changesDiffSaveBtn.style.display = tab.editable ? '' : 'none';
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

// see .ai/contexts/changes-view.md ("A dirty buffer is never overwritten, and never lied to")
function updateChangesSaveButton(sessionId, tab) {
  const state = filePanelState.get(sessionId);
  if (!state || state.currentTab !== tab) return;
  changesDiffSaveBtn.disabled = !!tab.saving || !isChangesBufferDirty(tab);
}

function renderChangesNotice(tab) {
  const notes = [];
  const listFailed = !!tab.error && !tab.notARepo;
  const alarming = !!(tab.saveError || tab.fileError || listFailed || tab.externalChange || tab.restoredEdits);
  if (tab.remote) notes.push('Remote session — read-only.');
  if (tab.fallbackReason) notes.push(`${tab.fallbackReason} — showing the diff read-only.`);
  if (tab.pendingLine && !tab.editable && !tab.diffLoading) notes.push(`Line ${tab.pendingLine} was not reached — a read-only diff has no line to jump to.`);
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
  if (tab.editorView && tab.editorKey === key && tab.editorMode === changesDiffMode) {
    mountChangesEditor(tab.editorView.dom);
    consumeChangesPendingLine(tab);
    return;
  }
  const token = JSON.stringify([key, changesDiffMode]);
  if (tab.editorPending === token) return;

  destroyChangesEditor(tab);
  changesDiffHostEl.innerHTML = '';

  const mode = changesDiffMode;
  tab.editorPending = token;

  window.loadCodeMirrorBundle().then(() => {
    const state = filePanelState.get(sessionId);
    if (!state || state.currentTab !== tab || tab.editorPending !== token) return;
    tab.editorPending = null;
    if (!tab.selectedFile || !tab.editable) return;

    const filename = tab.selectedFile.path;
    const onChange = () => updateChangesSaveButton(sessionId, tab);
    if (mode === 'plain') {
      tab.editorView = window.createEditableViewer(changesDiffHostEl, tab.current, filename, { onChange });
    } else if (mode === 'inline') {
      // mergeControls: false — this panel is not a git client, see .ai/contexts/changes-view.md
      tab.editorView = window.createUnifiedMergeViewer(changesDiffHostEl, tab.original, tab.current, filename, { mergeControls: false, onChange });
    } else {
      tab.editorView = window.createMergeViewer(changesDiffHostEl, tab.original, tab.current, filename, { onChange });
    }
    tab.editorKey = key;
    tab.editorMode = mode;
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
  return !!selected && selected.path === file.path;
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
  if (!tab || tab.type !== 'changes' || !tab.editable || !tab.selectedFile || tab.saving) return;
  if (!isChangesBufferDirty(tab)) return;

  const content = readChangesEditorContent(tab);
  if (content == null) return;

  const file = tab.selectedFile;
  tab.saving = true;
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);

  let result;
  try {
    result = await window.api.gitChangesSave(sessionId, file.path, content, tab.version);
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
  const result = await window.api.gitChangesFile(sessionId, file.path, { staged: !!file.staged });

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
  tab.original = result.original;
  tab.current = result.current;
  tab.savedContent = result.current;
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

function addMcpToggle() {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  mcpIndicatorEl = document.createElement('span');
  mcpIndicatorEl.className = 'mcp-toggle enabled';
  mcpIndicatorEl.title = 'IDE Emulation is active. Go to Global Settings to disable.';
  mcpIndicatorEl.textContent = 'IDE Emulation';
  mcpIndicatorEl.style.display = 'none';

  const stopBtn = document.getElementById('terminal-stop-btn');
  if (stopBtn) {
    controls.insertBefore(mcpIndicatorEl, stopBtn);
  } else {
    controls.appendChild(mcpIndicatorEl);
  }
}

// Terminal header entry point for Changes mode — see .ai/contexts/changes-view.md
function addChangesToggle() {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  changesToggleBtn = document.createElement('button');
  changesToggleBtn.id = 'changes-toggle-btn';
  changesToggleBtn.className = 'fp-toolbar-btn';
  changesToggleBtn.textContent = 'Changes';
  changesToggleBtn.title = 'Show working tree changes for this session';
  changesToggleBtn.addEventListener('click', () => {
    if (currentPanelSessionId) toggleChangesTab(currentPanelSessionId);
  });

  const stopBtn = document.getElementById('terminal-stop-btn');
  if (stopBtn) {
    controls.insertBefore(changesToggleBtn, stopBtn);
  } else {
    controls.appendChild(changesToggleBtn);
  }
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
        try { entry.fitAddon.fit(); } catch {}
      }
    }
  });
}

// ── Utility ─────────────────────────────────────────────────────────

function basename(filePath) {
  if (!filePath) return 'untitled';
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'untitled';
}
