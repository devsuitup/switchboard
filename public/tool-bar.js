// see .ai/contexts/tool-bar.md
'use strict';

const TOOL_BAR = Object.freeze([
  Object.freeze({ id: 'changes-toggle-btn', label: 'Changes', title: 'Show working tree changes for this session', icon: 'changes', shortcut: 'changesToggle' }),
  Object.freeze({ id: 'diff-toggle-btn', label: 'Diff', title: 'Show the change proposed by Claude', icon: 'diff', shortcut: 'diffToggle' }),
  Object.freeze({ id: 'touched-toggle-btn', label: 'Touched', title: "Show the files this session's file tools touched", icon: 'touched', shortcut: 'touchedToggle' }),
  Object.freeze({ id: 'panel-terminal-toggle-btn', label: 'Shell', title: "Open a shell in this session's working directory", icon: 'shell', shortcut: 'shellToggle' }),
]);

const createToolToggle = typeof module !== 'undefined' && module.exports ? require('./header-controls').createHeaderToggle : createHeaderToggle;
let toolBarEl = null;
let toolBarLastOwner = null;

function toolBarOwner() {
  const area = document.getElementById('terminal-area');
  if (!currentPanelSessionId || typeof openSessions === 'undefined' || !openSessions.has(currentPanelSessionId) || !area || area.style.display === 'none') return null;
  if (typeof gridViewActive !== 'undefined' && gridViewActive && !gridCards.has(currentPanelSessionId)) return null;
  return currentPanelSessionId;
}

function initToolBar(split) {
  if (toolBarEl) return;
  toolBarEl = document.createElement('div');
  toolBarEl.id = 'tool-bar';
  toolBarEl.setAttribute('role', 'toolbar');
  toolBarEl.setAttribute('aria-orientation', 'vertical');
  toolBarEl.setAttribute('aria-label', 'Session tools');
  split.append(toolBarEl);
  for (const spec of TOOL_BAR) createToolToggle({ ...spec, onClick: () => activateTool(spec.shortcut) });
  toolBarEl.addEventListener('focusin', e => {
    if (e.target.parentElement !== toolBarEl) return;
    for (const btn of toolBarEl.children) btn.tabIndex = btn === e.target ? 0 : -1;
  });
  toolBarEl.addEventListener('keydown', e => {
    const buttons = enabledToolButtons();
    if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next].focus();
  });
  new MutationObserver(syncToolBar).observe(document.getElementById('terminal-area'), { attributes: true, attributeFilter: ['style'] });
  syncToolBar();
}

function enabledToolButtons() {
  return toolBarEl ? [...toolBarEl.children].filter(btn => !btn.hidden && !btn.disabled) : [];
}

function syncToolBar() {
  if (!toolBarEl) return;
  const main = document.getElementById('main');
  const area = document.getElementById('terminal-area');
  main?.classList.toggle('terminal-area-shown', !!area && area.style.display !== 'none');
  main?.classList.toggle('file-panel-open', !!document.getElementById('file-panel')?.classList.contains('open'));
  const owner = toolBarOwner();
  const state = owner ? filePanelState.get(owner) : null;
  const tab = state?.currentTab;
  const active = document.activeElement;
  const hadFocus = toolBarEl.contains(active);
  const pressed = {
    changesToggle: tab?.type === 'changes' && !tab.returnList,
    diffToggle: tab?.type === 'diff',
    touchedToggle: tab?.type === 'touched' || tab?.returnList?.type === 'touched',
    shellToggle: owner && typeof panelTerminalIsOpen === 'function' && panelTerminalIsOpen(owner),
  };
  for (const spec of TOOL_BAR) {
    const btn = document.getElementById(spec.id);
    btn.disabled = !owner;
    btn.setAttribute('aria-disabled', String(!owner));
    setHeaderToggle(btn, !!owner && pressed[spec.shortcut]);
    btn.title = spec.title + ' (' + formatBinding(spec.shortcut, isMac, appShortcuts) + ')';
    if (spec.shortcut === 'diffToggle') {
      btn.hidden = !(tab?.type === 'diff' || state?.parkedDiffs.size);
      if (state?.parkedDiffs.size) {
        btn.dataset.badge = 'pending';
        btn.setAttribute('aria-description', 'Claude is waiting for your answer');
      } else {
        delete btn.dataset.badge;
        btn.removeAttribute('aria-description');
      }
    }
  }
  const enabled = enabledToolButtons();
  const focusTarget = enabled.includes(active) ? active : enabled.find(btn => btn.tabIndex === 0) || enabled[0];
  for (const btn of toolBarEl.children) btn.tabIndex = btn === focusTarget ? 0 : -1;
  if (hadFocus && !enabled.includes(active)) {
    if (focusTarget) enabled[0].focus();
    else {
      const entry = typeof openSessions !== 'undefined' ? openSessions.get(toolBarLastOwner) : null;
      if (entry) entry.terminal.focus();
      else {
        active.blur();
        document.querySelector('#terminals .terminal-container.visible .xterm-helper-textarea')?.focus();
      }
    }
  }
  if (owner) toolBarLastOwner = owner;
}

function activateTool(action) {
  const owner = toolBarOwner();
  if (!owner) return false;
  if (action === 'diffToggle') {
    const state = filePanelState.get(owner);
    if (state?.currentTab?.type !== 'diff' && !state?.parkedDiffs.size) return false;
    showPendingDiff(owner);
  } else if (action === 'changesToggle') toggleChangesTab(owner);
  else if (action === 'touchedToggle') toggleTouchedTab(owner);
  else if (action === 'shellToggle') togglePanelTerminal(owner);
  else return false;
  return true;
}

function handleToolShortcut(e) {
  if (e._handled || !toolBarOwner()) return false;
  const spec = TOOL_BAR.find(c => matchShortcut(c.shortcut, e, isMac, appShortcuts));
  if (!spec) return false;
  if (spec.shortcut === 'diffToggle') {
    const state = filePanelState.get(toolBarOwner());
    if (state?.currentTab?.type !== 'diff' && !state?.parkedDiffs.size) return false;
  }
  if (e.type === 'keydown') {
    e._handled = true;
    e.preventDefault();
    activateTool(spec.shortcut);
  }
  return true;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { TOOL_BAR, createToolToggle };
