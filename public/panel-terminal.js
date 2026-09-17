// Panel shell: a terminal region below the right-hand panel's content, running
// in the owning session's own resolved working directory.
// see .ai/contexts/panel-terminal.md

const panelTerminals = new Map(); // ownerSessionId → { panelSessionId, error }

const PANEL_TERMINAL_HEIGHT_KEY = 'panelTerminalHeight';
const DEFAULT_PANEL_TERMINAL_HEIGHT = 220;
const MIN_PANEL_TERMINAL_HEIGHT = 80;
const MIN_PANEL_CONTENT_HEIGHT = 120;

let panelTerminalContentEl = null;
let panelTerminalRegionEl = null;
let panelTerminalHandleEl = null;
let panelTerminalMessageEl = null;
let panelTerminalToggleBtn = null;
let panelTerminalOwnerId = null; // the session the panel is currently showing

function panelTerminalSessionId(ownerSessionId) {
  return 'panel:' + ownerSessionId;
}

function panelTerminalIsOpen(sessionId) {
  return !!sessionId && panelTerminals.has(sessionId);
}

function storedPanelTerminalHeight() {
  const stored = parseInt(localStorage.getItem(PANEL_TERMINAL_HEIGHT_KEY), 10);
  return Number.isFinite(stored) ? Math.max(MIN_PANEL_TERMINAL_HEIGHT, stored) : DEFAULT_PANEL_TERMINAL_HEIGHT;
}

function clampPanelTerminalHeight(height, contentHeight) {
  const wanted = Math.max(MIN_PANEL_TERMINAL_HEIGHT, Math.round(height));
  if (!(contentHeight > 0)) return wanted;
  return Math.min(wanted, Math.max(MIN_PANEL_TERMINAL_HEIGHT, contentHeight - MIN_PANEL_CONTENT_HEIGHT));
}

// ── Region construction ─────────────────────────────────────────────

function initPanelTerminal(contentEl) {
  if (!contentEl || panelTerminalRegionEl) return;
  panelTerminalContentEl = contentEl;

  panelTerminalHandleEl = document.createElement('div');
  panelTerminalHandleEl.id = 'panel-terminal-handle';
  contentEl.appendChild(panelTerminalHandleEl);

  panelTerminalRegionEl = document.createElement('div');
  panelTerminalRegionEl.id = 'panel-terminal-region';
  panelTerminalRegionEl.style.height = storedPanelTerminalHeight() + 'px';
  contentEl.appendChild(panelTerminalRegionEl);

  panelTerminalMessageEl = document.createElement('div');
  panelTerminalMessageEl.id = 'panel-terminal-message';
  panelTerminalMessageEl.style.display = 'none';
  panelTerminalRegionEl.appendChild(panelTerminalMessageEl);

  setupPanelTerminalSplitter();
  addPanelTerminalToggle();
  hidePanelTerminalRegion();
}

function addPanelTerminalToggle() {
  const controls = document.getElementById('terminal-header-controls');
  if (!controls) return;

  panelTerminalToggleBtn = document.createElement('button');
  panelTerminalToggleBtn.id = 'panel-terminal-toggle-btn';
  panelTerminalToggleBtn.className = 'fp-toolbar-btn';
  panelTerminalToggleBtn.textContent = 'Shell';
  panelTerminalToggleBtn.title = 'Open a shell in this session\'s working directory';
  panelTerminalToggleBtn.addEventListener('click', () => {
    if (panelTerminalOwnerId) togglePanelTerminal(panelTerminalOwnerId);
  });

  const stopBtn = document.getElementById('terminal-stop-btn');
  if (stopBtn) {
    controls.insertBefore(panelTerminalToggleBtn, stopBtn);
  } else {
    controls.appendChild(panelTerminalToggleBtn);
  }
}

function updatePanelTerminalToggle() {
  if (!panelTerminalToggleBtn) return;
  panelTerminalToggleBtn.classList.toggle('active', panelTerminalIsOpen(panelTerminalOwnerId));
}

// ── Height ──────────────────────────────────────────────────────────

function currentPanelTerminalHeight() {
  const styled = parseInt(panelTerminalRegionEl.style.height, 10);
  return Number.isFinite(styled) ? styled : storedPanelTerminalHeight();
}

function setPanelTerminalHeight(height) {
  const contentHeight = panelTerminalContentEl ? panelTerminalContentEl.clientHeight : 0;
  panelTerminalRegionEl.style.height = clampPanelTerminalHeight(height, contentHeight) + 'px';
}

function setupPanelTerminalSplitter() {
  createSplitter(panelTerminalHandleEl, {
    axis: 'y',
    getSize: () => panelTerminalRegionEl.offsetHeight || currentPanelTerminalHeight(),
    onDrag: (startSize, delta) => setPanelTerminalHeight(startSize - delta),
    onCommit: () => {
      localStorage.setItem(PANEL_TERMINAL_HEIGHT_KEY, String(currentPanelTerminalHeight()));
      refitPanelTerminal();
    },
  });
}

function refitPanelTerminal() {
  const state = panelTerminals.get(panelTerminalOwnerId);
  if (!state) return;
  const entry = openSessions.get(state.panelSessionId);
  if (entry) safeFit(entry);
}

// ── Region visibility ───────────────────────────────────────────────

function showPanelTerminalRegion() {
  panelTerminalRegionEl.classList.add('open');
  panelTerminalHandleEl.classList.add('open');
}

function hidePanelTerminalRegion() {
  panelTerminalRegionEl.classList.remove('open');
  panelTerminalHandleEl.classList.remove('open');
}

function showPanelTerminalMessage(text) {
  showPanelTerminalRegion();
  panelTerminalMessageEl.textContent = text;
  panelTerminalMessageEl.style.display = 'block';
}

function mountPanelTerminal(ownerSessionId) {
  const state = panelTerminals.get(ownerSessionId);
  if (!state) return;
  if (state.error) { showPanelTerminalMessage(state.error); return; }
  const entry = openSessions.get(state.panelSessionId);
  if (!entry) return;
  showPanelTerminalRegion();
  panelTerminalMessageEl.style.display = 'none';
  replayHiddenBuffer(state.panelSessionId);
  entry.element.classList.add('visible');
  entry.panelMounted = true;
  fitAndScroll(entry);
}

function unmountPanelTerminal(state) {
  const entry = openSessions.get(state.panelSessionId);
  if (!entry) return;
  entry.element.classList.remove('visible');
  entry.panelMounted = false;
}

// Called by switchPanel: the panel now shows sessionId, or nothing.
function syncPanelTerminal(sessionId) {
  panelTerminalOwnerId = sessionId || null;
  if (!panelTerminalRegionEl) return;
  for (const [ownerId, state] of panelTerminals) {
    if (ownerId !== panelTerminalOwnerId) unmountPanelTerminal(state);
  }
  updatePanelTerminalToggle();
  if (!panelTerminalIsOpen(panelTerminalOwnerId)) {
    hidePanelTerminalRegion();
    return;
  }
  mountPanelTerminal(panelTerminalOwnerId);
}

// ── Lifecycle ───────────────────────────────────────────────────────

function togglePanelTerminal(ownerSessionId) {
  if (!ownerSessionId) return;
  if (panelTerminals.has(ownerSessionId)) {
    closePanelTerminal(ownerSessionId);
    return;
  }
  return openPanelTerminal(ownerSessionId);
}

async function openPanelTerminal(ownerSessionId) {
  if (!panelTerminalRegionEl || panelTerminals.has(ownerSessionId)) return;
  const panelSessionId = panelTerminalSessionId(ownerSessionId);
  const state = { panelSessionId, error: null };
  panelTerminals.set(ownerSessionId, state);
  if (typeof switchPanel === 'function') switchPanel(ownerSessionId);

  let entry = openSessions.get(panelSessionId);
  if (entry && entry.closed) {
    destroySession(panelSessionId);
    entry = null;
  }
  if (!entry) {
    const owner = (typeof sessionMap !== 'undefined' && sessionMap.get(ownerSessionId)) || null;
    const projectPath = owner ? owner.projectPath : null;
    const session = { sessionId: panelSessionId, projectPath, summary: 'Shell', type: 'terminal' };
    entry = createTerminalEntry(session, { mount: panelTerminalRegionEl, panel: true });
    mountPanelTerminal(ownerSessionId);

    const result = await window.api.openTerminal(
      panelSessionId, projectPath, true, { type: 'terminal', panelFor: ownerSessionId }, entry.initialSize,
    );
    if (panelTerminals.get(ownerSessionId) !== state) return; // closed while spawning
    if (!result || !result.ok) {
      destroySession(panelSessionId);
      state.error = (result && result.error) || 'could not start a shell for this session';
      if (panelTerminalOwnerId === ownerSessionId) showPanelTerminalMessage(state.error);
      return;
    }
    syncPtySizeAfterOpen(entry);
    if (typeof pollActiveSessions === 'function') pollActiveSessions();
  }
  if (panelTerminalOwnerId === ownerSessionId) mountPanelTerminal(ownerSessionId);
}

function closePanelTerminal(ownerSessionId) {
  const state = panelTerminals.get(ownerSessionId);
  if (!state) return;
  panelTerminals.delete(ownerSessionId);
  stopPanelShell(state.panelSessionId);
  if (typeof switchPanel === 'function') switchPanel(panelTerminalOwnerId);
  else syncPanelTerminal(panelTerminalOwnerId);
}

// Called from destroySession.
function destroyPanelTerminalFor(ownerSessionId) {
  const state = panelTerminals.get(ownerSessionId);
  if (!state) return;
  panelTerminals.delete(ownerSessionId);
  stopPanelShell(state.panelSessionId);
  syncPanelTerminal(panelTerminalOwnerId);
}

function stopPanelShell(panelSessionId) {
  try { Promise.resolve(window.api.stopSession(panelSessionId)).catch(() => {}); } catch {}
  if (openSessions.has(panelSessionId)) destroySession(panelSessionId);
}
