// --- Session Grid Overview ---
// No reparenting — terminals stay in #terminals. We wrap each terminal container
// with an in-place card overlay (header/footer) and switch #terminals to grid layout.
//
// Depends on globals from app.js: openSessions, activeSessionId, sessionMap, activePtyIds,
// sortedOrder, sidebarContent, terminalsEl, gridViewActive, gridViewer, gridViewerCount,
// placeholder, terminalHeader, statsViewer, memoryViewer, settingsViewer,
// jsonlViewer, terminalArea, isMac
// Depends on: cleanDisplayName, formatDate (utils.js), fitAndScroll, showSession (terminal-manager.js)

let gridCards = new Map(); // sessionId → card wrapper element
const gridCardsByMember = new Map();
const gridCardMemberKeys = new Map();
let gridFocusedSessionId = null;

// Grouping is the historical layout, so an unset preference means "grouped".
let gridGroupByProject = localStorage.getItem('gridGroupByProject') !== '0';

function forgetGridCardMembers(sessionId) {
  for (const id of gridCardMemberKeys.get(sessionId) || []) {
    const cards = gridCardsByMember.get(id);
    cards?.delete(sessionId);
    if (!cards?.size) gridCardsByMember.delete(id);
  }
  gridCardMemberKeys.delete(sessionId);
}

function gridCardRow(sessionId) {
  const openedSession = openSessions.get(sessionId)?.session;
  const session = sessionMap.get(sessionId) || openedSession || { sessionId };
  const item = sessionItemEl(sessionId);
  const mergedRow = typeof localMergedMemberRows !== 'undefined' && localMergedMemberRows.get(sessionId);
  const ids = [...new Set(rowSessionIds({ sessionId, mergedMemberIds: [
    item?.dataset.sessionId,
    mergedRow?.sessionId,
    ...(item?.dataset.mergedMemberIds?.split(' ') || []),
    ...(mergedRow?.mergedMemberIds || []),
    ...(session.mergedMemberIds || []),
    ...(openedSession?.mergedMemberIds || []),
  ] }).filter(Boolean))];
  const status = mergedRow ? mergedRow.mergedMemberStatuses?.[sessionId] : session;
  return { ...session, ...mergedRow, sessionId, status: status?.status, statusUpdatedAt: status?.statusUpdatedAt,
    headSessionId: item?.dataset.headSessionId || mergedRow?.headSessionId || session.headSessionId,
    mergedMemberIds: ids.filter(id => id !== sessionId) };
}

function indexGridCardMembers(sessionId, row) {
  forgetGridCardMembers(sessionId);
  const keys = new Set(rowSessionIds(row).flatMap(id => [id, window.taskRegistry?.resolve(id) || id]));
  gridCardMemberKeys.set(sessionId, keys);
  for (const id of keys) {
    if (!gridCardsByMember.has(id)) gridCardsByMember.set(id, new Set());
    gridCardsByMember.get(id).add(sessionId);
  }
}

function registerGridCard(sessionId, card) {
  gridCards.set(sessionId, card);
  indexGridCardMembers(sessionId, gridCardRow(sessionId));
}

function refreshGridCardMembers() {
  for (const sessionId of gridCards.keys()) indexGridCardMembers(sessionId, gridCardRow(sessionId));
}

function updateGridSubagentPills(parentSessionId) {
  const sessionIds = parentSessionId
    ? new Set([...(gridCardsByMember.get(parentSessionId) || []),
      ...(gridCardsByMember.get(window.taskRegistry?.resolve(parentSessionId)) || [])])
    : gridCards.keys();
  for (const sessionId of sessionIds) {
    const card = gridCards.get(sessionId);
    const row = gridCardRow(sessionId);
    indexGridCardMembers(sessionId, row);
    updateGridCardActivity(sessionId, card, row);
    const count = window.taskRegistry?.runningAgentCount(rowSessionIds(row)) || 0;
    let text = card.querySelector('.grid-subagent-count');
    if (!count) {
      text?.remove();
      continue;
    }
    if (!text) {
      text = document.createElement('div');
      text.className = 'grid-subagent-count';
      const header = card.querySelector('.grid-card-header');
      if (header) header.after(text);
      else card.prepend(text);
    }
    text.textContent = `${count} subagent${count === 1 ? '' : 's'} running`;
    text.setAttribute('aria-label', text.textContent);
  }
}

function updateGridCardActivity(sessionId, card, row) {
  const snapshot = mergedRowSnapshot(rowSessionIds(row), sessionId, storedActivitySnapshot(sessionId, row), row);
  const running = activePtyIds.has(sessionId);
  const dot = card.querySelector('.grid-card-dot');
  const head = rowHeadId(row);
  const selection = typeof selectBackgroundActivity === 'function' ? selectBackgroundActivity(head, row) : null;
  const label = typeof backgroundActivityEntry === 'function' && backgroundActivityEntry(head, row, selection)?.state === 'blocked'
    && backgroundActivityLabel(head, snapshot, row, selection);
  paintSessionIconFromSnapshot(dot, snapshot, label?.title, label?.text, undefined, row);
  dot?.classList.toggle('running', running);
  setHasBusyAgents(card, snapshot.agentsBusy);
  setNeedsAttention(card, snapshot.attention);
  setUnseenWrittenActivity(card, snapshot.unseenWrittenActivity);
  const exit = lastSessionExit(sessionId);
  const footer = card.querySelector('.grid-card-footer');
  if (footer?.children[0]) footer.children[0].textContent = lifecycleLabel({
    ptyHere: running, attach: openSessions.get(sessionId)?.attach,
    job: selection?.entry, remoteAlias: row.remoteAlias, liveness: snapshot.liveness, exit,
    dormant: typeof dormantWorkingSet !== 'undefined' && dormantWorkingSet.has(sessionId),
  });
  const stopBtn = card.querySelector('.grid-card-stop-btn');
  if (stopBtn) stopBtn.style.display = (running || isSessionAlive(sessionId)) ? '' : 'none';
  const detachBtn = card.querySelector('.grid-card-detach-btn');
  const entry = openSessions.get(sessionId);
  if (detachBtn) {
    detachBtn.style.display = running && entry && !entry.closed && (entry.attach || entry.session?.remoteAlias) ? '' : 'none';
    detachBtn.title = entry?.session?.remoteAlias ? `Detach (the session keeps running on ${remoteHostLabel(entry.session.remoteAlias)})` : 'Detach (the session keeps running)';
    detachBtn.setAttribute('aria-label', detachBtn.title);
  }
}

function wrapInGridCard(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  if (!session || !entry) return;

  // The session may have accumulated a hidden buffer while it was hidden in
  // single view (see appendToHiddenAccumulator in terminal-manager.js) —
  // replay it now, in one atomic write, before the card becomes visible.
  replayHiddenBuffer(sessionId);

  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary) || sessionId;
  const shortProject = shortProjectPath(session.projectPath);

  // Create card wrapper
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.dataset.sessionId = sessionId;
  card.rekeySessionId = newId => { sessionId = newId; card.dataset.sessionId = newId; };

  // Header
  const header = document.createElement('div');
  header.className = 'grid-card-header';
  const dot = document.createElement('span');
  dot.className = 'grid-card-dot session-icon';
  header.appendChild(dot);
  const name = document.createElement('span');
  name.className = 'grid-card-name';
  name.textContent = displayName;
  header.appendChild(name);
  const project = document.createElement('span');
  project.className = 'grid-card-project';
  project.textContent = shortProject;
  header.appendChild(project);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'grid-card-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.setAttribute('aria-label', stopBtn.title);
  stopBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';
  // is-alive: process alive on its host though unattached — see .ai/contexts/session-state.md
  stopBtn.style.display = (activePtyIds.has(sessionId) || isSessionAlive(sessionId)) ? '' : 'none';
  stopBtn.onclick = (e) => {
    e.stopPropagation();
    confirmAndStopSession(sessionId, stopBtn);
  };
  header.appendChild(stopBtn);

  const detachBtn = document.createElement('button');
  detachBtn.className = 'grid-card-detach-btn';
  detachBtn.title = session.remoteAlias ? `Detach (the session keeps running on ${remoteHostLabel(session.remoteAlias)})` : 'Detach (the session keeps running)';
  detachBtn.setAttribute('aria-label', detachBtn.title);
  detachBtn.innerHTML = ICONS.detach(12);
  detachBtn.style.display = activePtyIds.has(sessionId) && !entry.closed && (entry.attach || entry.session?.remoteAlias) ? '' : 'none';
  detachBtn.onclick = (e) => {
    e.stopPropagation();
    detachSession(sessionId, detachBtn);
  };
  header.appendChild(detachBtn);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'grid-card-footer';
  const statusSpan = document.createElement('span');
  const timeSpan = document.createElement('span');
  timeSpan.textContent = formatDate(new Date(session.modified));
  footer.appendChild(statusSpan);
  footer.appendChild(timeSpan);

  // Build the card DOM
  card.appendChild(header);
  entry.element.classList.add('visible', 'grid-mode');
  card.appendChild(entry.element);
  card.appendChild(footer);

  // Insert card into the correct project group in the grid
  if (gridViewActive && gridGroupByProject) {
    const pp = session.projectPath || '';
    // Find or create the project heading for this session
    let targetHeading = null;
    for (const h of terminalsEl.querySelectorAll('.grid-project-heading')) {
      if (h.dataset.projectPath === pp) { targetHeading = h; break; }
    }
    if (!targetHeading) {
      targetHeading = document.createElement('div');
      targetHeading.className = 'grid-project-heading';
      targetHeading.dataset.projectPath = pp;
      targetHeading.textContent = pp ? shortProjectPath(pp) : 'Other';
      // Insert heading in sortedOrder position
      const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
      const myIdx = orderIndex.get(pp);
      let inserted = false;
      if (myIdx !== undefined) {
        for (const h of terminalsEl.querySelectorAll('.grid-project-heading')) {
          const hIdx = orderIndex.get(h.dataset.projectPath);
          if (hIdx !== undefined && hIdx > myIdx) {
            terminalsEl.insertBefore(targetHeading, h);
            inserted = true;
            break;
          }
        }
      }
      if (!inserted) terminalsEl.appendChild(targetHeading);
    }
    // Insert card after the heading and any existing cards in this group
    // (find next heading or end of container)
    let insertBefore = targetHeading.nextSibling;
    while (insertBefore && !insertBefore.classList.contains('grid-project-heading')) {
      insertBefore = insertBefore.nextSibling;
    }
    terminalsEl.insertBefore(card, insertBefore);
  } else {
    // Flat grid, or not in grid view at all — no heading to slot under.
    terminalsEl.appendChild(card);
  }

  // Click header or footer to focus
  header.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    focusGridCard(sessionId);
  });
  // Double-click header to switch to full terminal view
  header.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    gridFocusedSessionId = sessionId;
    toggleGridView();
  });
  footer.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    focusGridCard(sessionId);
  });

  // Clicking/focusing the terminal area also selects the card
  entry.element.addEventListener('focusin', () => {
    if (gridViewActive && gridFocusedSessionId !== sessionId) {
      focusGridCard(sessionId);
    }
  });

  registerGridCard(sessionId, card);
  if (gridCardObserver) gridCardObserver.observe(card);
  // Set initial status from the single source of truth
  updateRunningIndicators();

  updateGridSubagentPills(sessionId);
}

function unwrapGridCards() {
  for (const [sid, card] of gridCards) {
    if (gridCardObserver) gridCardObserver.unobserve(card);
    const entry = openSessions.get(sid);
    if (entry) {
      entry.element.classList.remove('grid-mode', 'visible');
      // Move terminal container back out of the card, before the card
      card.parentNode.insertBefore(entry.element, card);
    }
    card.remove();
  }
  gridCards.clear();
  gridCardsByMember.clear();
  gridCardMemberKeys.clear();
  // Remove project headings inserted by showGridView
  terminalsEl.querySelectorAll('.grid-project-heading').forEach(el => el.remove());
}

function rekeyGridCard(oldId, newId) {
  const card = gridCards.get(oldId);
  if (card) {
    forgetGridCardMembers(oldId);
    gridCards.delete(oldId);
    card.rekeySessionId(newId);
    registerGridCard(newId, card);
  }
  if (gridFocusedSessionId === oldId) gridFocusedSessionId = newId;
}
window.rekeyGridCard = rekeyGridCard;

function focusGridCard(sessionId) {
  const previousSessionId = gridFocusedSessionId;
  gridFocusedSessionId = sessionId;
  setActiveSession(sessionId);
  clearNotifications(sessionId, 0);
  lruTouch(sessionId);
  // Update sidebar active highlight
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const sidebarItem = sessionItemEl(sessionId);
  if (sidebarItem) sidebarItem.classList.add('active');
  // Update visual focus
  document.querySelectorAll('.grid-card').forEach(c => c.classList.remove('focused'));
  const card = gridCards.get(sessionId);
  if (card) {
    card.classList.add('focused');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const entry = openSessions.get(sessionId);
  if (entry) {
    entry.terminal.focus();
    if (typeof markTerminalOutputSeen === 'function') markTerminalOutputSeen(entry);
  }
  refreshRemoteTerminalOnReturn(sessionId, previousSessionId);
}

// Wraps one card per open session in sidebar order, emitting a project heading
// on each project change when grouping is on.
function layoutGridCards(openSet) {
  // see .ai/contexts/panel-terminal.md
  document.querySelectorAll('.terminal-container:not(.panel-terminal)').forEach(el => el.classList.remove('visible'));
  const sessionIds = [];
  const sidebarItems = sidebarContent.querySelectorAll('.session-item[data-session-id]');
  let currentProjectPath = null;
  for (const item of sidebarItems) {
    const ids = rowSessionIds({ sessionId: item.dataset.sessionId, mergedMemberIds: item.dataset.mergedMemberIds?.split(' ') });
    const openIds = ids.filter(id => openSet.has(id));
    if (!openIds.length) continue;
    const session = sessionMap.get(item.dataset.sessionId);
    const projectPath = session ? session.projectPath : null;
    if (gridGroupByProject && projectPath && projectPath !== currentProjectPath) {
      currentProjectPath = projectPath;
      const heading = document.createElement('div');
      heading.className = 'grid-project-heading';
      heading.dataset.projectPath = projectPath;
      heading.textContent = shortProjectPath(projectPath);
      terminalsEl.appendChild(heading);
    }
    for (const sid of openIds) {
      wrapInGridCard(sid);
      sessionIds.push(sid);
    }
  }
  return sessionIds;
}

function openGridSessionIds() {
  const openSet = new Set();
  for (const [sid, entry] of openSessions) {
    if (!entry.closed) openSet.add(sid);
  }
  return openSet;
}

function setGridGroupByProject(on) {
  gridGroupByProject = !!on;
  localStorage.setItem('gridGroupByProject', gridGroupByProject ? '1' : '0');
  syncGridGroupToggleBtn();
  if (!gridViewActive) return;

  const restoreId = gridFocusedSessionId || activeSessionId;
  unwrapGridCards();
  const sessionIds = layoutGridCards(openGridSessionIds());
  if (typeof syncToolBar === 'function') syncToolBar();
  for (const sid of sessionIds) {
    const entry = openSessions.get(sid);
    if (entry) fitAndScroll(entry);
  }
  const toFocus = sessionIds.includes(restoreId) ? restoreId : sessionIds[0];
  if (toFocus) focusGridCard(toFocus);
}

function syncGridGroupToggleBtn() {
  const btn = document.getElementById('grid-group-toggle-btn');
  if (!btn) return;
  btn.classList.toggle('active', gridGroupByProject);
  btn.setAttribute('aria-pressed', gridGroupByProject ? 'true' : 'false');
}

function initGridGroupToggle() {
  const btn = document.getElementById('grid-group-toggle-btn');
  if (!btn) return;
  btn.addEventListener('click', () => setGridGroupByProject(!gridGroupByProject));
  syncGridGroupToggleBtn();
}

function showGridView() {
  gridViewActive = true;
  localStorage.setItem('gridViewActive', '1');
  placeholder.style.display = 'none';
  terminalHeader.style.display = 'none';

  // Hide other viewers but keep terminal-area visible
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  jsonlViewer.messageSearch?.close(false);
  if (typeof hideAgentsView === 'function') hideAgentsView({ restore: false });
  terminalArea.style.display = '';

  // Switch #terminals to grid layout
  terminalsEl.classList.add('grid-layout');

  const sessionIds = layoutGridCards(openGridSessionIds());
  if (typeof syncToolBar === 'function') syncToolBar();

  // Show grid header bar with session count
  gridViewer.style.display = 'block';
  syncGridGroupToggleBtn();
  gridViewerCount.textContent = sessionIds.length + ' session' + (sessionIds.length !== 1 ? 's' : '');

  const btn = document.getElementById('grid-toggle-btn');
  if (btn) btn.classList.add('active');

  // see .ai/contexts/terminal-refresh.md
  for (const sid of sessionIds) {
    const entry = openSessions.get(sid);
    if (entry) {
      entry.terminal.options.scrollback = SCROLLBACK_GRID;
    }
  }
  refitOpenTerminals();
  // Focus active or first (deferred so fitAndScroll's rAF runs first)
  requestAnimationFrame(() => {
    const toFocus = activeSessionId && sessionIds.includes(activeSessionId) ? activeSessionId : sessionIds[0];
    if (toFocus) focusGridCard(toFocus);
  });
}

function updateGridColumns() {
  if (!gridViewActive) return;
  const width = terminalsEl.clientWidth;
  const minCardWidth = 560;
  const gap = 14;
  const fitCols = Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
  const cardCount = terminalsEl.querySelectorAll('.grid-card').length;
  const cols = Math.max(1, Math.min(fitCols, cardCount || 1));
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

// Virtualize WebGL on grid cards: only on-screen cards keep a GL context.
// Off-screen cards drop to xterm's DOM renderer (suspendTerminalWebgl) and
// get the context back when scrolled into view. This both frees GPU memory
// and keeps the total context count under Chromium's ~16-per-process cap on
// large grids.
let gridCardObserver = null;

// Remove a session's grid card and release its observer registration. Called
// from destroySession (terminal-manager.js) — without the unobserve, the
// IntersectionObserver keeps a strong ref to the detached card node, leaking
// one element per LRU eviction while the grid stays open.
function destroyGridCard(sessionId) {
  const card = gridCards.get(sessionId);
  if (!card) return false;
  if (gridCardObserver) gridCardObserver.unobserve(card);
  card.remove();
  forgetGridCardMembers(sessionId);
  gridCards.delete(sessionId);
  if (typeof syncToolBar === 'function') syncToolBar();
  return true;
}

// initGridObservers is called from app.js after DOM refs are ready
function initGridObservers() {
  new ResizeObserver(updateGridColumns).observe(terminalsEl);
  new MutationObserver(updateGridColumns).observe(terminalsEl, { childList: true });
  if (typeof IntersectionObserver !== 'undefined') {
    gridCardObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const sid = e.target.dataset.sessionId;
        if (!sid) continue;
        e.target.dataset.outputVisible = String(e.isIntersecting && e.intersectionRatio >= 0.99);
        if (!e.isIntersecting || e.intersectionRatio === 0) e.target.dataset.refitVisible = 'false';
        if (e.isIntersecting) {
          if (gridViewActive) {
            if (e.intersectionRatio > 0 && e.target.dataset.refitVisible !== 'true') {
              refitVisibleGridTerminal(openSessions.get(sid));
            }
          } else {
            restoreTerminalWebgl(sid);
          }
          if (typeof markTerminalOutputSeen === 'function') markTerminalOutputSeen(openSessions.get(sid));
        } else {
          suspendTerminalWebgl(sid);
        }
      }
    }, { threshold: [0, Number.EPSILON, 0.99] });
  }
}

function hideGridView() {
  gridViewActive = false;
  localStorage.setItem('gridViewActive', '0');
  // Restore the full scrollback budget for every session, not just the one
  // about to be focused — background sessions keep producing output after the
  // grid closes and would otherwise stay silently capped at the thumbnail
  // budget until individually shown.
  //
  // Also suspend every session's WebGL context on the way out: grid mode may
  // have restored several (every on-screen card — see gridCardObserver), but
  // single view only ever shows one. toggleGridView calls showSession()
  // synchronously right after this, which reloads the addon for whichever
  // session it reveals — so this never leaves the user looking at a
  // DOM-rendered terminal, and never leaves more than one GL context alive.
  for (const [sid, entry] of openSessions) {
    if (!entry.closed) entry.terminal.options.scrollback = SCROLLBACK_SINGLE;
    // see .ai/contexts/panel-terminal.md
    if (entry.panelMounted) continue;
    suspendTerminalWebgl(sid);
  }
  unwrapGridCards();
  terminalsEl.classList.remove('grid-layout');
  terminalsEl.style.gridTemplateColumns = '';
  gridViewer.style.display = 'none';
  const btn = document.getElementById('grid-toggle-btn');
  if (btn) btn.classList.remove('active');
}

function toggleGridView() {
  if (gridViewActive) {
    const restoreId = gridFocusedSessionId || activeSessionId;
    hideGridView();
    gridFocusedSessionId = null;
    if (restoreId && openSessions.has(restoreId)) {
      showSession(restoreId);
    } else {
      placeholder.style.display = '';
    }
  } else {
    terminalHeader.style.display = 'none';
    showGridView();
  }
}

// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow) ---

// Returns ordered list of open (non-closed) session IDs matching sidebar order.
function getOrderedOpenSessionIds({ includeDormant = false } = {}) {
  const items = sidebarContent.querySelectorAll('.session-item[data-session-id]');
  const ids = [];
  for (const item of items) {
    for (const sid of rowSessionIds({ sessionId: item.dataset.sessionId, mergedMemberIds: item.dataset.mergedMemberIds?.split(' ') })) {
      const entry = openSessions.get(sid);
      if ((entry && !entry.closed) || (includeDormant && isDormantSession(sid))) ids.push(sid);
    }
  }
  return ids;
}

function navigateSession(direction, { repeat = false } = {}) {
  // see .ai/contexts/session-cache.md ("Restore on click")
  const ids = getOrderedOpenSessionIds({ includeDormant: !gridViewActive && !repeat });
  const current = gridViewActive ? gridFocusedSessionId : activeSessionId;
  const idx = ids.indexOf(current);
  let next;
  if (idx === -1) {
    next = ids[0];
  } else {
    next = ids[(idx + direction + ids.length) % ids.length];
  }
  if (ids.length === 0 || !next) return;
  if (gridViewActive) {
    focusGridCard(next);
  } else if (isDormantSession(next) && indexedRowOf(next)) {
    const row = indexedRowOf(next);
    openSession(rowOpenId(row) ? row : indexedSessionById(next)).catch(err => console.error('[navigateSession]', err));
  } else {
    showSession(next);
  }
}

// Navigate the grid in 2D by visual position using bounding rects.
// Project headings break the simple index math, so we use actual screen positions.
function navigateGrid(direction) {
  if (!gridViewActive) return;
  const cards = [...terminalsEl.querySelectorAll('.grid-card')];
  if (cards.length === 0) return;
  const currentCard = gridCards.get(gridFocusedSessionId || activeSessionId);
  if (!currentCard || !cards.includes(currentCard)) {
    for (const [sid, card] of gridCards) {
      if (card === cards[0]) { focusGridCard(sid); return; }
    }
    return;
  }
  const cur = currentCard.getBoundingClientRect();
  const curCx = cur.left + cur.width / 2;
  const curCy = cur.top + cur.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const card of cards) {
    if (card === currentCard) continue;
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Filter by direction
    const dx = cx - curCx;
    const dy = cy - curCy;
    let valid = false;
    switch (direction) {
      case 'left':  valid = dx < -10; break;
      case 'right': valid = dx > 10; break;
      case 'up':    valid = dy < -10; break;
      case 'down':  valid = dy > 10; break;
    }
    if (!valid) continue;
    // For left/right prefer same row (small dy), for up/down prefer same column (small dx)
    let dist;
    if (direction === 'left' || direction === 'right') {
      dist = Math.abs(dy) * 3 + Math.abs(dx);
    } else {
      dist = Math.abs(dx) * 3 + Math.abs(dy);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = card;
    }
  }
  if (!best) return;
  for (const [sid, card] of gridCards) {
    if (card === best) { focusGridCard(sid); return; }
  }
}

// Live session-navigation key bindings (re-bindable via global settings).
// Defaults until the stored `global.shortcuts` setting is applied at startup.
let appShortcuts = normalizeShortcuts(null);
function setAppShortcuts(stored) {
  appShortcuts = normalizeShortcuts(stored);
  if (typeof syncToolBar === 'function') syncToolBar();
}

// Returns true if the key combo is a session nav shortcut (used by xterm to block without acting)
function isSessionNavKey(e) {
  return isSessionNavShortcut(e, isMac, appShortcuts);
}

function handleSessionNavKey(e) {
  // Prev/next session (default Cmd/Ctrl+Shift+[ / ])
  if (matchShortcut('sessionNavBrackets', e, isMac, appShortcuts)) {
    e.preventDefault();
    if (e.type === 'keydown') navigateSession(e.code === 'BracketLeft' ? -1 : 1, { repeat: e.repeat });
    return true;
  }

  // Arrow nav (default Cmd/Ctrl+Shift+Arrow) — grid view: 2D navigation; single view: cycle sessions
  if (matchShortcut('sessionNavArrows', e, isMac, appShortcuts)) {
    e.preventDefault();
    if (e.type === 'keydown') {
      if (gridViewActive) {
        const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        navigateGrid(dirMap[e.key]);
      } else {
        const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
        navigateSession(dir, { repeat: e.repeat });
      }
    }
    return true;
  }

  return false;
}
