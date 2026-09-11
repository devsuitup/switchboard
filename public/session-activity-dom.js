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

// local-pty only for now — see session-state.md "migration status".
function computeBusyReadyClasses(sessionId) {
  const busy = sessionBusyState.get(sessionId) === true;
  const ready = !busy && responseReadySessions.has(sessionId);
  const state = createSessionState('local-pty');
  if (busy) state.apply({ type: 'busy', active: true });
  else if (ready) state.apply({ type: 'busy', active: false, armReady: true });
  return renderSessionIcon(state.snapshot()).classes;
}

// The only writer of .cli-busy and .response-ready — they are mutually exclusive.
function applyActivityClassesToElement(item, sessionId) {
  if (!item) return;
  const classes = computeBusyReadyClasses(sessionId);
  const ready = classes.includes('response-ready');
  const busy = classes.includes('cli-busy');
  setResponseReady(item, ready);
  setCliBusy(item, busy);
  if (window.ATRACE) window.atrace('class.apply', sessionId, { el: item.id || null, 'response-ready': ready, 'cli-busy': busy, fn: 'applyActivityClasses' });
}

function applyActivityClasses(sessionId) {
  applyActivityClassesToElement(sessionItemEl(sessionId), sessionId);
}

// Snapshot-driven projection for adapter-owned state — see .ai/contexts/session-state.md
function applyStateClasses(sessionId, snapshot) {
  const item = sessionItemEl(sessionId);
  if (!item) return;
  const classes = renderSessionIcon(snapshot).classes;
  const ready = classes.includes('response-ready');
  const busy = classes.includes('cli-busy');
  setResponseReady(item, ready);
  setCliBusy(item, busy);
  if (window.ATRACE) window.atrace('class.apply', sessionId, { el: item.id || null, 'response-ready': ready, 'cli-busy': busy, fn: 'applyStateClasses', kind: snapshot && snapshot.kind });
}
