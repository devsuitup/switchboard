const headTurns = new Map();

function applyHeadTurnSnapshot(turn) {
  if (!turn || typeof turn.sessionId !== 'string' || !['open', 'closed', 'unknown'].includes(turn.state) || !Number.isFinite(turn.revision)) return;
  const previous = headTurns.get(turn.sessionId);
  if (previous && previous.revision >= turn.revision) return;
  const ready = turn.state === 'closed' && previous?.state === 'open' && turn.sessionId !== activeSessionId;
  headTurns.set(turn.sessionId, { ...turn, ready: ready || (previous?.ready && turn.state === 'closed') });
  if (previous?.state === turn.state) return;
  applyStateClasses(turn.sessionId, storedActivitySnapshot(turn.sessionId));
  if (typeof agentsViewActive !== 'undefined' && agentsViewActive && typeof renderAgentsView === 'function') renderAgentsView();
}

function headActivitySnapshot(sessionId, snapshot) {
  const s = snapshot || {};
  const turn = headTurns.get(sessionId);
  if (turn && s.attention) turn.ready = false;
  const alive = s.liveness === 'alive' || (typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId));
  return { ...s, headTurn: turn?.state || 'unknown', busy: alive && turn?.state === 'open',
    responseReady: !!turn?.ready, waitingForInput: alive && turn?.state !== 'open',
    liveness: alive ? 'alive' : s.liveness };
}

function taskActivitySnapshot(sessionId, snapshot) {
  if (!window.taskRegistry) return headActivitySnapshot(sessionId, snapshot);
  const agentsBusy = window.taskRegistry.agents(sessionId).length > 0;
  return headActivitySnapshot(sessionId, { ...snapshot, agentsBusy, backgroundWork: window.taskRegistry.background(sessionId) });
}

// DOM projection for session activity, sole writer of the activity classes — see .ai/contexts/session-state.md

function rowSessionIds(session) {
  return [session.sessionId, ...(session.mergedMemberIds || [])];
}

function rowHeadId(session) {
  return session.headSessionId || session.sessionId;
}

function rowOpenId(session) {
  const head = rowHeadId(session);
  return [head, ...(session.mergedMemberIds || []).filter(id => id !== head), session.sessionId].find(id => {
    const entry = openSessions.get(id);
    return entry && !entry.closed;
  });
}

function sessionItemEl(sessionId, container = document) {
  return container.querySelector(`.session-item[data-session-id="${sessionId}"]`)
    || container.querySelector(`.session-item[data-merged-member-ids~="${sessionId}"]`);
}

const localMergedMemberRows = new Map();

function indexLocalMergedMemberRows(projects) {
  localMergedMemberRows.clear();
  for (const project of projects) {
    for (const row of project.sessions) {
      if (row.remoteAlias) continue;
      for (const id of row.mergedMemberIds || []) localMergedMemberRows.set(id, row);
    }
  }
}

function localSessionForStatus(sessionId, session) {
  if (session) return session;
  if (typeof sessionMap === 'undefined') return undefined;
  const current = localMergedMemberRows.get(sessionId);
  if (current) return { sessionId, ...current.mergedMemberStatuses?.[sessionId] };
  const item = sessionItemEl(sessionId);
  const rendered = item && sessionMap.get(item.dataset.sessionId);
  if (rendered?.mergedMemberIds?.includes(sessionId)) {
    return { sessionId, ...rendered.mergedMemberStatuses?.[sessionId] };
  }
  const stored = sessionMap.get(sessionId);
  if (stored) return stored;
  let latest;
  for (const row of sessionMap.values()) {
    if (row.mergedMemberIds?.includes(sessionId)) {
      latest = row;
    }
  }
  if (latest) return { sessionId, ...latest.mergedMemberStatuses?.[sessionId] };
}

function storedActivitySnapshot(sessionId, session) {
  const local = snapshotForLocal(sessionId, session);
  if (typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId)) return taskActivitySnapshot(sessionId, localPtyStates.get(sessionId)?.snapshot());
  const remote = typeof remoteSessionStates !== 'undefined' && remoteSessionStates.get(sessionId)?.snapshot();
  if (remote && !remote.attached) return taskActivitySnapshot(sessionId, remote);
  if (typeof localTranscriptStates !== 'undefined' && localTranscriptStates.has(sessionId)) seedLocalTranscriptDescriptor(sessionId, session);
  const transcript = typeof localTranscriptStates !== 'undefined' && localTranscriptStates.get(sessionId)?.snapshot();
  return taskActivitySnapshot(sessionId, transcript || local);
}

function mergedRowSnapshot(ids, sessionId, snapshot, row) {
  if (ids.length === 1) return snapshot;
  row ||= localMergedMemberRows.get(sessionId) || (typeof sessionMap !== 'undefined' && sessionMap.get(sessionId));
  if (!row) {
    const item = sessionItemEl(sessionId);
    row = item && { sessionId: item.dataset.sessionId, headSessionId: item.dataset.headSessionId };
  }
  const head = row ? rowHeadId(row) : sessionId;
  const snapshots = ids.map(id => id === sessionId ? snapshot : storedActivitySnapshot(id)).filter(Boolean);
  const combined = { ...(head === sessionId ? snapshot : storedActivitySnapshot(head)) };
  for (const field of ['attention', 'agentsBusy', 'backgroundWork']) {
    combined[field] = snapshots.some(s => s[field]);
  }
  if (snapshots.some(s => s.liveness === 'alive')) combined.liveness = 'alive';
  return combined;
}

function setNeedsAttention(el, on) {
  if (el) el.classList.toggle('needs-attention', !!on);
}

function setResponseReady(el, on) {
  if (el) el.classList.toggle('response-ready', !!on);
}

function setCliBusy(el, on) {
  if (el) el.classList.toggle('cli-busy', !!on);
}

function setHasBusyAgents(el, on) {
  if (el) el.classList.toggle('has-busy-agents', !!on);
}

// process-alive-on-its-host signal, independent of attach state — see .ai/contexts/session-state.md
function setIsAlive(el, on) {
  if (el) el.classList.toggle('is-alive', !!on);
}

// the only reader other call sites (grid-view.js, app.js) should use
function isSessionAlive(sessionId) {
  const el = sessionItemEl(sessionId);
  return !!(el && el.classList.contains('is-alive'));
}

// Snapshot-driven projection — the one path for all three kinds — see .ai/contexts/session-state.md ("The local-pty adapter")
function applyStateClasses(sessionId, snapshot) {
  const item = sessionItemEl(sessionId);
  if (!item) return;
  const ids = [item.dataset.sessionId, ...(item.dataset.mergedMemberIds?.split(' ') || [])];
  snapshot = taskActivitySnapshot(sessionId, snapshot);
  snapshot = mergedRowSnapshot(ids, sessionId, snapshot);
  const icon = renderSessionIcon(snapshot);
  // Row classes read snapshot fields directly, not icon.classes — see .ai/contexts/session-state.md ("The local-pty adapter")
  const attention = !!(snapshot && snapshot.attention);
  const ready = !!(snapshot && snapshot.responseReady);
  const busy = !!(snapshot && snapshot.busy);
  const agentsBusy = !!(snapshot && snapshot.agentsBusy);
  const alive = !!(snapshot && snapshot.liveness === 'alive');
  setNeedsAttention(item, attention);
  setResponseReady(item, ready);
  setCliBusy(item, busy);
  setHasBusyAgents(item, agentsBusy);
  setIsAlive(item, alive);
  writeIconSlot(item.querySelector('.session-icon'), icon);
  if (window.ATRACE) window.atrace('class.apply', sessionId, { el: item.id || null, 'needs-attention': attention, 'response-ready': ready, 'cli-busy': busy, 'has-busy-agents': agentsBusy, 'is-alive': alive, fn: 'applyStateClasses', kind: snapshot && snapshot.kind });
}

// One icon slot per row, written here and nowhere else — see .ai/contexts/session-state.md
function writeIconSlot(el, icon) {
  if (!el || !icon) return;
  for (const cls of Array.from(el.classList)) {
    if (cls.indexOf('session-icon--') === 0) el.classList.remove(cls);
  }
  for (const cls of icon.slotClasses) el.classList.add(cls);
  el.title = icon.title || '';
  el.dataset.glyph = icon.glyph || '';
}

// Thin wrapper over the local-pty adapter's own persisted state — see .ai/contexts/session-state.md ("The local-pty adapter")
function snapshotForLocal(sessionId, session) {
  let state = localPtyState(sessionId);
  const sess = localSessionForStatus(sessionId, session);
  if (sess && sess.status !== undefined) {
    // session.status present is itself the liveness signal — see .ai/contexts/cli-session-state.md
    state.apply({ type: 'liveness', value: 'alive' });
    state.apply({ type: 'descriptorStatus', status: sess.status, at: sess.statusUpdatedAt });
  } else if (!sess?.remoteAlias && state.snapshot().liveness === 'alive'
    && !(typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId))) {
    localPtyStates.delete(sessionId);
    state = localPtyState(sessionId);
    state.apply({ type: 'liveness', value: 'unknown' });
  }
  return state.snapshot();
}

// Paints an icon slot from a snapshot held by another adapter — see .ai/contexts/session-state.md ("Descriptor-owned attention")
function paintSessionIconFromSnapshot(el, snapshot) {
  if (!el) return;
  writeIconSlot(el, renderSessionIcon(snapshot));
}

// see .ai/contexts/session-state.md
function paintSessionIcon(el, sessionId, session) {
  if (!el) return;
  const snapshot = storedActivitySnapshot(sessionId, session);
  const item = el.closest('.session-item');
  const row = session || (item && typeof sessionMap !== 'undefined' && sessionMap.get(item.dataset.sessionId)) || { sessionId };
  writeIconSlot(el, renderSessionIcon(mergedRowSnapshot(rowSessionIds(row), sessionId, snapshot, row)));
}
