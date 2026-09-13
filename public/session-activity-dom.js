// DOM projection for session activity, sole writer of the activity classes — see .ai/contexts/session-state.md

function sessionItemEl(sessionId) {
  return document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
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
  const icon = renderSessionIcon(snapshot);
  const attention = icon.classes.includes('needs-attention');
  const ready = icon.classes.includes('response-ready');
  const busy = icon.classes.includes('cli-busy');
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
  const state = localPtyState(sessionId);
  const sess = session || (typeof sessionMap !== 'undefined' && sessionMap.get(sessionId));
  if (sess && sess.status !== undefined) {
    // session.status present is itself the liveness signal — see .ai/contexts/cli-session-state.md
    state.apply({ type: 'liveness', value: 'alive' });
    state.apply({ type: 'descriptorStatus', status: sess.status, at: sess.statusUpdatedAt });
  }
  return state.snapshot();
}

// Paints a local-pty row's icon slot — see .ai/contexts/session-state.md
function paintSessionIcon(el, sessionId, session) {
  if (!el) return;
  writeIconSlot(el, renderSessionIcon(snapshotForLocal(sessionId, session)));
}
