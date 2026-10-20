const headTurns = new Map();

function outputSurfaceVisible(element) {
  if (!element?.isConnected || document.hidden || document.visibilityState !== 'visible') return false;
  for (let parent = element; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (parent.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function markTerminalOutputSeen(entry) {
  if (!entry?.terminal) return;
  const sessionId = entry.session.sessionId;
  if (!writtenActivitySnapshot(sessionId).unseenWrittenActivity || !entry.element.classList.contains('visible')) return;
  const buffer = entry.terminal.buffer.active;
  if (buffer.viewportY < buffer.baseY) return;
  const card = entry.element.closest('.grid-card');
  if (typeof gridViewActive !== 'undefined' && gridViewActive) {
    if (card?.dataset.outputVisible !== 'true') return;
  } else if (sessionId !== activeSessionId) return;
  if (!outputSurfaceVisible(entry.element)) return;
  const buffered = typeof terminalWriteBuffers !== 'undefined' && terminalWriteBuffers.get(sessionId)?.chunks.length;
  const hidden = typeof hiddenAccumulators !== 'undefined' && hiddenAccumulators.get(sessionId)?.raw.length;
  if (!buffered && !hidden && !entry.pendingWrittenRenders) {
    entry.renderedWrittenWatermark = Math.max(entry.renderedWrittenWatermark || 0, entry.digestWrittenWatermark || 0);
  }
  const watermark = entry.renderedWrittenWatermark ?? 0;
  if (watermark <= writtenActivitySnapshot(sessionId).seenWrittenWatermark) return;
  markWrittenActivitySeen(sessionId, watermark);
}

function markTranscriptOutputSeen(sessionId, body, watermark) {
  if (!outputSurfaceVisible(body) || body.scrollTop + body.clientHeight < body.scrollHeight - 1) return;
  markWrittenActivitySeen(sessionId, watermark);
}

function markVisibleOutputSeen() {
  if (typeof openSessions !== 'undefined') for (const entry of openSessions.values()) markTerminalOutputSeen(entry);
  if (typeof jsonlViewerBody !== 'undefined' && outputSurfaceVisible(jsonlViewerBody)) jsonlViewerBody.onscroll?.();
}

window.addEventListener('focus', markVisibleOutputSeen);
document.addEventListener('visibilitychange', markVisibleOutputSeen);

function applyHeadTurnSnapshot(turn) {
  if (!turn || typeof turn.sessionId !== 'string' || !['open', 'closed', 'unknown'].includes(turn.state) || !Number.isFinite(turn.revision)) return;
  const previous = headTurns.get(turn.sessionId);
  if (previous && previous.revision >= turn.revision) return;
  if (typeof turn.writtenOutput === 'string' && previous?.writtenOutput !== undefined && turn.writtenOutput !== previous.writtenOutput) {
    const watermark = noteWrittenActivity(turn.sessionId);
    const entry = typeof openSessions !== 'undefined' && openSessions.get(turn.sessionId);
    if (entry) {
      entry.digestWrittenWatermark = watermark;
      markTerminalOutputSeen(entry);
    }
  }
  const ready = turn.state === 'closed' && previous?.state === 'open' && turn.sessionId !== activeSessionId;
  const changed = !previous || previous.state !== turn.state || previous.lastEntryAt !== turn.lastEntryAt;
  const observedAt = changed ? Date.now() : previous.observedAt;
  const ended = turn.state === 'closed' && (!!previous?.endArmed || !!previous?.ended);
  if (turn.state === 'unknown' && previous && previous.state !== 'unknown') forgetObservedTurnEnd(turn.sessionId);
  headTurns.set(turn.sessionId, { ...turn, observedAt, ready: ready || (previous?.ready && turn.state === 'closed'), ended, endArmed: turn.state === 'open' });
  if (previous && changed) {
    for (const states of [typeof localPtyStates !== 'undefined' && localPtyStates,
      typeof localTranscriptStates !== 'undefined' && localTranscriptStates,
      typeof remoteSessionStates !== 'undefined' && remoteSessionStates]) {
      if (states) states.get(turn.sessionId)?.apply({ type: 'transcriptTouched', at: observedAt, source: 'head-turn' });
    }
  }
  applyStateClasses(turn.sessionId, storedActivitySnapshot(turn.sessionId));
  if (typeof agentsViewActive !== 'undefined' && agentsViewActive && typeof renderAgentsView === 'function') renderAgentsView();
}

function headActivitySnapshot(sessionId, snapshot, row, selection) {
  const s = snapshot || {};
  const turn = headTurns.get(sessionId);
  const ptyHere = typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId);
  const alive = s.liveness === 'alive' || ptyHere;
  const background = typeof backgroundActivityEntry === 'function' && backgroundActivityEntry(sessionId, row, selection)
    || s.backgroundJob;
  const promptHint = s.promptHint && (!background || Number.isFinite(s.promptHintAt));
  const idleNewer = !background && Number.isFinite(s.idleHintAt) && Number.isFinite(turn?.lastEntryAt) && s.idleHintAt > turn.lastEntryAt
    || turn?.state === 'open' && Number.isFinite(s.promptHintAt) && Number.isFinite(turn?.observedAt) && s.promptHintAt > turn.observedAt;
  const headTurn = idleNewer || (promptHint && (!turn || turn.state === 'unknown')) ? 'closed' : turn?.state || 'unknown';
  return { ...s, ...writtenActivitySnapshot(sessionId), headTurn, busy: alive && headTurn === 'open',
    responseReady: !s.attention && !!turn?.ready, waitingForInput: alive && headTurn !== 'open' && (!ptyHere || !!s.waitingForInput || !!turn?.ended),
    liveness: alive ? 'alive' : s.liveness };
}

function taskActivitySnapshot(sessionId, snapshot, row, selection) {
  selection ||= typeof selectBackgroundActivity === 'function' ? selectBackgroundActivity(sessionId, row) : null;
  const tasks = window.taskRegistry;
  const result = headActivitySnapshot(sessionId, tasks ? { ...snapshot,
    agentsBusy: tasks.agents(sessionId, selection ? selection.entry?.id || null : undefined).length > 0,
    backgroundWork: tasks.background(sessionId, selection ? selection.entry?.id || null : undefined) } : snapshot, row, selection);
  return typeof backgroundActivitySnapshot === 'function' ? backgroundActivitySnapshot(sessionId, result, row, selection) : result;
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

function localActivityRow(sessionId, row) {
  const current = row || localMergedMemberRows.get(sessionId) || (typeof sessionMap !== 'undefined' && sessionMap.get(sessionId));
  if (current) return current;
  const item = sessionItemEl(sessionId);
  return item && typeof sessionMap !== 'undefined' && sessionMap.get(item.dataset.sessionId);
}

function indexLocalMergedMemberRows(projects) {
  localMergedMemberRows.clear();
  for (const project of projects) {
    for (const row of project.sessions) {
      if (row.remoteAlias) continue;
      for (const id of row.mergedMemberIds || []) localMergedMemberRows.set(id, row);
    }
  }
  if (typeof refreshGridCardMembers === 'function') refreshGridCardMembers();
}

function localSessionForStatus(sessionId, session) {
  if (session) {
    if (session.sessionId !== sessionId && session.mergedMemberIds?.includes(sessionId)) {
      const status = session.mergedMemberStatuses?.[sessionId];
      return { ...session, sessionId, status: status?.status, statusUpdatedAt: status?.statusUpdatedAt,
        waitingFor: status?.waitingFor ?? null };
    }
    return session;
  }
  if (typeof sessionMap === 'undefined') return undefined;
  const current = localMergedMemberRows.get(sessionId);
  if (current) return { sessionId, ...current.mergedMemberStatuses?.[sessionId] };
  const item = sessionItemEl(sessionId);
  const rendered = item && sessionMap.get(item.dataset.sessionId);
  if (rendered?.mergedMemberIds?.includes(sessionId)) {
    return { sessionId, remoteAlias: rendered.remoteAlias, ...rendered.mergedMemberStatuses?.[sessionId] };
  }
  const stored = sessionMap.get(sessionId);
  if (stored) return stored;
  let latest;
  for (const row of sessionMap.values()) {
    if (row.mergedMemberIds?.includes(sessionId)) {
      latest = row;
    }
  }
  if (latest) return { sessionId, remoteAlias: latest.remoteAlias, ...latest.mergedMemberStatuses?.[sessionId] };
}

function storedActivitySnapshot(sessionId, session, selection) {
  const row = session || (typeof selectBackgroundActivity === 'function' ? localActivityRow(sessionId) : null);
  const local = snapshotForLocal(sessionId, session, selection);
  if (typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId)) return taskActivitySnapshot(sessionId, local, row, selection);
  const remote = typeof remoteSessionStates !== 'undefined' && remoteSessionStates.get(sessionId)?.snapshot();
  if (remote && !remote.attached) return taskActivitySnapshot(sessionId, remote, row, selection);
  if (typeof localTranscriptStates !== 'undefined' && localTranscriptStates.has(sessionId)) seedLocalTranscriptDescriptor(sessionId, session, selection);
  const transcript = typeof localTranscriptStates !== 'undefined' && localTranscriptStates.get(sessionId)?.snapshot();
  return taskActivitySnapshot(sessionId, transcript ? (local.backgroundJob ? { ...transcript, backgroundJob: true } : transcript) : local, row, selection);
}

function mergedRowSnapshot(ids, sessionId, snapshot, row) {
  if (ids.length === 1) return snapshot;
  row ||= localMergedMemberRows.get(sessionId) || (typeof sessionMap !== 'undefined' && sessionMap.get(sessionId));
  if (!row) {
    const item = sessionItemEl(sessionId);
    row = item && { sessionId: item.dataset.sessionId, headSessionId: item.dataset.headSessionId };
  }
  const head = row ? rowHeadId(row) : sessionId;
  const snapshots = ids.map(id => id === sessionId ? snapshot : storedActivitySnapshot(id, row)).filter(Boolean);
  const combined = { ...(head === sessionId ? snapshot : storedActivitySnapshot(head, row)) };
  for (const field of ['attention', 'agentsBusy', 'backgroundWork']) {
    combined[field] = snapshots.some(s => s[field]);
  }
  if (snapshots.some(s => s.liveness === 'alive')) combined.liveness = 'alive';
  const ptyIds = typeof activePtyIds === 'undefined' ? [] : ids.filter(id => activePtyIds.has(id));
  if (ptyIds.length && !ptyIds.includes(head)) {
    combined.waitingForInput = combined.headTurn !== 'open'
      && ptyIds.some(id => !!(id === sessionId ? snapshot : storedActivitySnapshot(id, row))?.waitingForInput);
  }
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

function setUnseenWrittenActivity(el, on) {
  if (el) el.classList.toggle('unseen-written-activity', !!on);
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
  if (snapshot?.attention && typeof clearHeadUnread === 'function') clearHeadUnread(sessionId);
  const item = sessionItemEl(sessionId);
  if (!item) {
    if (typeof updateGridSubagentPills === 'function') updateGridSubagentPills(sessionId);
    return;
  }
  const ids = [item.dataset.sessionId, ...(item.dataset.mergedMemberIds?.split(' ') || [])];
  const row = typeof selectBackgroundActivity === 'function' ? localActivityRow(item.dataset.sessionId) : undefined;
  snapshot = taskActivitySnapshot(sessionId, snapshot, row);
  snapshot = mergedRowSnapshot(ids, sessionId, snapshot, row);
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
  setUnseenWrittenActivity(item, snapshot?.unseenWrittenActivity);
  const label = typeof backgroundActivityLabel === 'function'
    && backgroundActivityLabel(item.dataset.headSessionId || item.dataset.sessionId, snapshot,
      typeof sessionMap !== 'undefined' && sessionMap.get(item.dataset.sessionId));
  const session = !label && localSessionForStatus(item.dataset.headSessionId || item.dataset.sessionId, row);
  writeIconSlot(item.querySelector('.session-icon'), icon, label?.title, label?.text, session);
  const status = item.querySelector('.session-status');
  if (label && status) {
    status.textContent = label.text;
    status.title = '';
  } else if (status && typeof backgroundActivityIsForeground === 'function'
    && backgroundActivityIsForeground(item.dataset.headSessionId || item.dataset.sessionId)) {
    const age = formatStatusAge(session?.statusUpdatedAt);
    const why = session?.status === 'waiting' ? session.waitingFor : '';
    status.textContent = session?.status ? [why, age].filter(Boolean).join(' · ') : '';
    status.title = '';
  }
  if (typeof updateGridSubagentPills === 'function') updateGridSubagentPills(sessionId);
  if (window.ATRACE) window.atrace('class.apply', sessionId, { el: item.id || null, 'needs-attention': attention, 'response-ready': ready, 'cli-busy': busy, 'has-busy-agents': agentsBusy, 'is-alive': alive, fn: 'applyStateClasses', kind: snapshot && snapshot.kind });
}

// One icon slot per row, written here and nowhere else — see .ai/contexts/session-state.md
function writeIconSlot(el, icon, title, text, session) {
  if (!el || !icon) return;
  for (const cls of Array.from(el.classList)) {
    if (cls.indexOf('session-icon--') === 0) el.classList.remove(cls);
  }
  for (const cls of icon.slotClasses) el.classList.add(cls);
  el.title = title || icon.title || '';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', (icon.title || 'Idle') + (text && text !== icon.title ? ` · ${text}` : ''));
  if (session?.status) {
    const why = session.status === 'waiting' ? session.waitingFor : '';
    const detail = 'CLI status: ' + [session.status, why].filter(Boolean).join(' · ');
    el.title += '\n' + detail;
    el.setAttribute('aria-label', el.getAttribute('aria-label') + ' · ' + detail);
  }
  el.dataset.glyph = icon.glyph || '';
}

// Thin wrapper over the local-pty adapter's own persisted state — see .ai/contexts/session-state.md ("The local-pty adapter")
function snapshotForLocal(sessionId, session, selection) {
  let state = localPtyState(sessionId);
  const sess = localSessionForStatus(sessionId, session);
  if (sess?.remoteAlias) return state.snapshot();
  const targetHere = !sess?.headSessionId || sess.headSessionId === sessionId;
  const background = targetHere && (sess?.bgJobId || typeof backgroundActivityEntry === 'function' && backgroundActivityEntry(sessionId, localActivityRow(sessionId, session), selection));
  if (sess && sess.status !== undefined) {
    // session.status present is itself the liveness signal — see .ai/contexts/cli-session-state.md
    state.apply({ type: 'liveness', value: 'alive' });
    if (!background) state.apply({ type: 'descriptorStatus', status: sess.status, at: sess.statusUpdatedAt });
  } else if (!sess?.remoteAlias && state.snapshot().liveness === 'alive'
    && !(typeof activePtyIds !== 'undefined' && activePtyIds.has(sessionId))) {
    localPtyStates.delete(sessionId);
    state = localPtyState(sessionId);
    state.apply({ type: 'liveness', value: 'unknown' });
  }
  return background ? { ...state.snapshot(), backgroundJob: true } : state.snapshot();
}

// Paints an icon slot from a snapshot held by another adapter — see .ai/contexts/session-state.md ("Descriptor-owned attention")
function paintSessionIconFromSnapshot(el, snapshot, title, text, session) {
  if (!el) return;
  writeIconSlot(el, renderSessionIcon(snapshot), title, text, session);
}

// see .ai/contexts/session-state.md
function paintSessionIcon(el, sessionId, session) {
  if (!el) return;
  const snapshot = storedActivitySnapshot(sessionId, session);
  const item = el.closest('.session-item');
  const row = session || (item && typeof sessionMap !== 'undefined' && sessionMap.get(item.dataset.sessionId)) || { sessionId };
  const projected = mergedRowSnapshot(rowSessionIds(row), sessionId, snapshot, row);
  const label = typeof backgroundActivityLabel === 'function' && backgroundActivityLabel(rowHeadId(row), projected, row);
  writeIconSlot(el, renderSessionIcon(projected), label?.title, label?.text,
    !label && !row.parentSessionId && localSessionForStatus(rowHeadId(row), row));
}
