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

const PANEL_WIDTH_KEY = 'filePanelWidth';
const DEFAULT_PANEL_WIDTH = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10) || 450;
const MIN_PANEL_WIDTH = 280;

const DIFF_MODE_KEY = 'filePanelDiffMode';
let diffMode = localStorage.getItem(DIFF_MODE_KEY) || 'side-by-side';

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

  // ── Changes mode (issue #251, git-status-sourced, read-only) ──
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
  changesRefreshBtn.className = 'fp-toolbar-btn';
  changesRefreshBtn.textContent = 'Refresh';
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

  changesDiffEl = document.createElement('div');
  changesDiffEl.id = 'changes-diff-view';
  changesDiffEl.style.display = 'none';
  changesContainerEl.appendChild(changesDiffEl);

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
        refreshChanges(sessionId);
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
    if (tab.type === 'diff' && !tab.resolved) {
      window.api.mcpDiffResponse(currentPanelSessionId, tab.diffId, 'reject', null);
    }
    if (tab.type === 'diff' && tab.editorView) {
      tab.editorView.destroy();
      tab.editorView = null;
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
  };

  state.panelVisible = true;

  if (currentPanelSessionId === sessionId) {
    showPanel(state);
    renderPanel(sessionId);
  }
}

function destroyCurrentTab(state) {
  const tab = state.currentTab;
  if (!tab) return;
  if (tab.type === 'diff' && tab.editorView) {
    tab.editorView.destroy();
    tab.editorView = null;
    // Clear stale search/goto-line bar references
    if (diffBodyEl) {
      delete diffBodyEl._cmSearchBar;
      delete diffBodyEl._cmGotoLine;
    }
  }
  if (tab.type === 'file') {
    fpViewerPanel.destroy();
  }
}

async function openFileInPanel(sessionId, filePath) {
  const result = await window.api.readFileForPanel(filePath);
  if (!result.ok) return;
  openFileTab(sessionId, { filePath, content: result.content });
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
  filePanelEl.classList.remove('open');
  filePanelEl.style.width = '0';
  filePanelResizeHandle.style.display = 'none';
  refitActiveTerminal();
}

function switchPanel(sessionId) {
  currentPanelSessionId = sessionId;
  updateMcpIndicator();

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
    destroyCurrentTab(state);
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
    selectedFile: null,
    diffLoading: false,
    diffError: null,
    diffContent: null,
    diffTruncated: false,
    diffUntracked: false,
  };
  state.panelVisible = true;

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
  if (!result || result.ok === false) {
    tab.error = (result && result.error) || 'failed to load changes';
    tab.data = null;
  } else {
    tab.error = null;
    tab.data = result;
  }
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
}

async function openChangesDiff(sessionId, file) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'changes') return;
  const tab = state.currentTab;

  tab.selectedFile = file;
  tab.diffError = null;
  tab.diffContent = null;
  tab.diffTruncated = false;
  tab.diffUntracked = !!file.untracked;

  if (file.untracked) {
    // git diff never reports an untracked file — nothing to fetch.
    tab.diffLoading = false;
    if (currentPanelSessionId === sessionId) renderPanel(sessionId);
    return;
  }

  tab.diffLoading = true;
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);

  const result = await window.api.gitChangesDiff(sessionId, file.path, file.staged);

  const stillState = filePanelState.get(sessionId);
  if (!stillState || stillState.currentTab !== tab || tab.selectedFile !== file) return;

  tab.diffLoading = false;
  if (!result || result.ok === false) {
    tab.diffError = (result && result.error) || 'failed to load diff';
  } else {
    tab.diffContent = result.content;
    tab.diffTruncated = !!result.truncated;
  }
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
}

function closeChangesDiff(sessionId) {
  const state = filePanelState.get(sessionId);
  if (!state || !state.currentTab || state.currentTab.type !== 'changes') return;
  state.currentTab.selectedFile = null;
  state.currentTab.diffContent = null;
  state.currentTab.diffError = null;
  if (currentPanelSessionId === sessionId) renderPanel(sessionId);
}

function renderChangesContent(sessionId, tab) {
  if (tab.selectedFile) {
    changesSummaryEl.style.display = 'none';
    changesListEl.style.display = 'none';
    changesDiffEl.style.display = 'flex';
    renderChangesDiff(sessionId, tab);
    return;
  }
  changesDiffEl.style.display = 'none';
  changesSummaryEl.style.display = 'block';
  changesListEl.style.display = 'block';

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
    err.className = 'changes-error';
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

  changesListEl.innerHTML = '';
  for (const file of files) {
    changesListEl.appendChild(buildChangesFileRow(sessionId, file));
  }
}

function buildChangesFileRow(sessionId, file) {
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

  row.addEventListener('click', () => {
    // prefer the unstaged (worktree) diff when a file has both
    const staged = !!file.staged && !file.unstaged;
    openChangesDiff(sessionId, { path: file.path, staged, untracked: !!file.untracked });
  });
  return row;
}

function renderChangesDiff(sessionId, tab) {
  changesDiffEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'viewer-toolbar';

  const info = document.createElement('div');
  info.className = 'viewer-toolbar-info';
  const titleEl = document.createElement('span');
  titleEl.className = 'viewer-toolbar-title';
  titleEl.textContent = tab.selectedFile.path;
  info.appendChild(titleEl);
  header.appendChild(info);

  const controls = document.createElement('div');
  controls.className = 'viewer-toolbar-controls';
  const backBtn = document.createElement('button');
  backBtn.className = 'fp-toolbar-btn';
  backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => closeChangesDiff(sessionId));
  controls.appendChild(backBtn);
  header.appendChild(controls);

  changesDiffEl.appendChild(header);

  const body = document.createElement('pre');
  body.className = 'changes-diff-body';

  if (tab.diffLoading) {
    body.textContent = 'Loading diff…';
  } else if (tab.diffError) {
    body.textContent = tab.diffError;
    body.classList.add('changes-error');
  } else if (tab.diffUntracked) {
    body.textContent = 'Untracked file — nothing to diff yet.';
  } else if (!tab.diffContent) {
    body.textContent = 'No differences.';
  } else {
    renderDiffLines(body, tab.diffContent);
  }
  changesDiffEl.appendChild(body);

  if (tab.diffTruncated) {
    const note = document.createElement('div');
    note.className = 'changes-diff-truncated';
    note.textContent = 'Diff truncated at 512 KB.';
    changesDiffEl.appendChild(note);
  }
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
