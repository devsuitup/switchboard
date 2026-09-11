// Session activity state — busy / response-ready / attention.
// See .ai/contexts/ipc-bridge.md "Busy-state reconciliation" and
// .ai/contexts/session-state.md (DOM projection split out to
// session-activity-dom.js).

const attentionSessions = new Set(); // sessions needing user action (OSC 9)
const responseReadySessions = new Set(); // Claude finished, user hasn't looked (terminal state)
const sessionBusyState = new Map(); // sessionId → boolean (currently active)

// Monotonic transition counter, plus its value at each session's last change.
let activitySeq = 0;
const activitySeqBySession = new Map();

function currentActivitySeq() {
  return activitySeq;
}

// Called from updateRunningIndicators() when a session leaves activePtyIds,
// next to the purge of the three collections above.
function forgetActivitySeq(sessionId) {
  if (window.ATRACE) window.atrace('store.mutate', sessionId, { map: 'activitySeqBySession', op: 'delete', from: activitySeqBySession.get(sessionId) ?? null, to: null, fn: 'forgetActivitySeq' });
  activitySeqBySession.delete(sessionId);
}

// Purge outside the active/idle transition (e.g. PTY gone); the only writer of the three collections besides setActivity/rekeyActivityState.
function purgeActivityFor(sessionId, via) {
  if (window.ATRACE) window.atrace('store.purge', sessionId, { reason: via, busy: sessionBusyState.get(sessionId) ?? null, ready: responseReadySessions.has(sessionId), attention: attentionSessions.has(sessionId), fn: 'purgeActivityFor' });
  attentionSessions.delete(sessionId);
  responseReadySessions.delete(sessionId);
  sessionBusyState.delete(sessionId);
  forgetActivitySeq(sessionId);
  setNeedsAttention(sessionItemEl(sessionId), false);
  applyActivityClasses(sessionId);
}

// Central activity dispatcher. `via` is trace-only — see docs/activity-trace.md.
// opts.armReady=false: going idle must not arm response-ready — see .ai/contexts/session-cache.md ("Remote hosts — busy spinner")
function setActivity(sessionId, active, via, opts) {
  const armReady = !(opts && opts.armReady === false);
  if (active) {
    if (window.ATRACE && responseReadySessions.has(sessionId)) window.atrace('store.mutate', sessionId, { map: 'responseReadySessions', op: 'delete', from: true, to: false, fn: 'setActivity', via });
    responseReadySessions.delete(sessionId);
  } else if (responseReadySessions.has(sessionId)) {
    if (window.ATRACE) window.atrace('store.skip', sessionId, { map: 'sessionBusyState', reason: 'response-ready-holds-idle', fn: 'setActivity', via });
    return;
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);
  activitySeq += 1;
  activitySeqBySession.set(sessionId, activitySeq);
  if (window.ATRACE) window.atrace('store.mutate', sessionId, { map: 'sessionBusyState', op: 'set', from: wasActive, to: active, actSeq: activitySeq, fn: 'setActivity', via });

  if (wasActive && !active && sessionId !== activeSessionId && armReady) {
    if (window.ATRACE) window.atrace('store.mutate', sessionId, { map: 'responseReadySessions', op: 'add', from: false, to: true, fn: 'setActivity', via });
    responseReadySessions.add(sessionId);
  }

  applyActivityClasses(sessionId);
}

function clearUnread(sessionId) {
  if (window.ATRACE && responseReadySessions.has(sessionId)) window.atrace('store.mutate', sessionId, { map: 'responseReadySessions', op: 'delete', from: true, to: false, fn: 'clearUnread' });
  responseReadySessions.delete(sessionId);
  applyActivityClasses(sessionId);
}

// Carry the activity state across a session-detected / session-forked re-key.
function rekeyActivityState(oldId, newId) {
  if (oldId === newId) return;
  if (window.ATRACE) window.atrace('store.rekey', newId, { from: oldId, busy: sessionBusyState.get(oldId) ?? null, ready: responseReadySessions.has(oldId), attention: attentionSessions.has(oldId), fn: 'rekeyActivityState' });
  const oldItem = sessionItemEl(oldId);
  setCliBusy(oldItem, false);
  setResponseReady(oldItem, false);
  setNeedsAttention(oldItem, false);

  if (sessionBusyState.has(oldId)) {
    sessionBusyState.set(newId, sessionBusyState.get(oldId));
    sessionBusyState.delete(oldId);
  }
  if (responseReadySessions.delete(oldId)) responseReadySessions.add(newId);
  if (attentionSessions.delete(oldId)) {
    attentionSessions.add(newId);
    setNeedsAttention(sessionItemEl(newId), true);
  }
  const seq = activitySeqBySession.get(oldId);
  if (seq !== undefined) {
    activitySeqBySession.delete(oldId);
    activitySeqBySession.set(newId, seq);
  }

  applyActivityClasses(newId);
}

// Realign against the backend snapshot from get-active-sessions.
// `sinceSeq` is currentActivitySeq() as read before the IPC call.
function reconcileBusyState(entries, sinceSeq) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry.sessionId !== 'string') continue;
    const { sessionId } = entry;
    if (typeof sinceSeq === 'number' && (activitySeqBySession.get(sessionId) || 0) > sinceSeq) {
      if (window.ATRACE) window.atrace('reconcile.skip', sessionId, { reason: 'raced-since-poll', backend: entry.busy === true, sinceSeq, sessionSeq: activitySeqBySession.get(sessionId) || 0 });
      continue;
    }
    if (entry.busy === true) {
      if (sessionBusyState.get(sessionId) !== true || responseReadySessions.has(sessionId)) {
        if (window.ATRACE) window.atrace('reconcile.apply', sessionId, { backend: true, local: sessionBusyState.get(sessionId) ?? null, ready: responseReadySessions.has(sessionId) });
        setActivity(sessionId, true, 'reconcileBusyState');
      } else if (window.ATRACE) {
        window.atrace('reconcile.noop', sessionId, { backend: true, local: true });
      }
    } else if (sessionBusyState.get(sessionId) === true) {
      if (window.ATRACE) window.atrace('reconcile.apply', sessionId, { backend: false, local: true, ready: responseReadySessions.has(sessionId) });
      setActivity(sessionId, false, 'reconcileBusyState');
    } else if (window.ATRACE) {
      window.atrace('reconcile.noop', sessionId, { backend: false, local: sessionBusyState.get(sessionId) ?? null });
    }
  }
}
