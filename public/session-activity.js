// Session activity state — the local-pty adapter — see .ai/contexts/session-state.md ("The local-pty adapter")
const localPtyStates = new Map();

function localPtyState(sessionId) {
  let state = localPtyStates.get(sessionId);
  if (!state) {
    state = createSessionState('local-pty');
    localPtyStates.set(sessionId, state);
  }
  return state;
}

function projectLocalPtyState(sessionId) {
  applyStateClasses(sessionId, localPtyState(sessionId).snapshot());
}

// Map-/Set-like views over localPtyStates, for readers not yet migrated onto the adapter — see .ai/contexts/session-state.md ("The local-pty adapter")
const sessionBusyState = {
  get(sessionId) {
    const s = localPtyStates.get(sessionId);
    return s ? s.snapshot().busy : undefined;
  },
  has(sessionId) { return localPtyStates.has(sessionId); },
  set(sessionId, val) {
    localPtyState(sessionId).apply({ type: 'busy', active: !!val, armReady: false });
    return this;
  },
  delete(sessionId) { return localPtyStates.delete(sessionId); },
  get size() { return localPtyStates.size; },
};

const responseReadySessions = {
  has(sessionId) {
    const s = localPtyStates.get(sessionId);
    return !!s && s.snapshot().responseReady === true;
  },
  add(sessionId) {
    localPtyState(sessionId).apply({ type: 'busy', active: false, armReady: true });
    return this;
  },
  delete(sessionId) {
    if (!localPtyStates.has(sessionId)) return false;
    localPtyState(sessionId).apply({ type: 'clearUnread' });
    return true;
  },
};

const attentionSessions = {
  has(sessionId) {
    const s = localPtyStates.get(sessionId);
    return !!s && s.snapshot().attention === true;
  },
  add(sessionId) {
    localPtyState(sessionId).apply({ type: 'attention', active: true });
    return this;
  },
  delete(sessionId) {
    if (!localPtyStates.has(sessionId)) return false;
    localPtyState(sessionId).apply({ type: 'attention', active: false });
    return true;
  },
};

// see .ai/contexts/changes-view.md ("Refresh triggers")
const idleListeners = new Set();
function onSessionIdle(cb) {
  idleListeners.add(cb);
  return () => idleListeners.delete(cb);
}
function notifySessionIdle(sessionId) {
  for (const cb of idleListeners) {
    try { cb(sessionId); } catch {}
  }
}

// Monotonic transition counter, plus its value at each session's last change.
let activitySeq = 0;
const activitySeqBySession = new Map();

function currentActivitySeq() {
  return activitySeq;
}

// Called from updateRunningIndicators() alongside the purge of the local-pty state above.
function forgetActivitySeq(sessionId) {
  if (window.ATRACE) window.atrace('store.mutate', sessionId, { map: 'activitySeqBySession', op: 'delete', from: activitySeqBySession.get(sessionId) ?? null, to: null, fn: 'forgetActivitySeq' });
  activitySeqBySession.delete(sessionId);
}

// Drops the whole per-session state; repaints from a throwaway blank state, not localPtyState(), which would re-vivify an entry — see .ai/contexts/session-state.md ("The local-pty adapter")
function purgeActivityFor(sessionId, via) {
  const before = localPtyStates.get(sessionId);
  const beforeSnap = before ? before.snapshot() : null;
  if (window.ATRACE) window.atrace('store.purge', sessionId, { reason: via, busy: beforeSnap ? beforeSnap.busy : null, ready: beforeSnap ? beforeSnap.responseReady : false, attention: beforeSnap ? beforeSnap.attention : false, fn: 'purgeActivityFor' });
  localPtyStates.delete(sessionId);
  forgetActivitySeq(sessionId);
  applyStateClasses(sessionId, createSessionState('local-pty').snapshot());
}

// Central activity dispatcher. `via` is trace-only — see docs/activity-trace.md.
// opts.armReady=false: going idle must not arm response-ready — see .ai/contexts/session-cache.md ("Remote hosts — busy spinner")
function setActivity(sessionId, active, via, opts) {
  const armReady = !(opts && opts.armReady === false);
  const state = localPtyState(sessionId);
  const before = state.snapshot();

  // response-ready-holds-idle: a duplicate/late idle signal is not a transition — see .ai/contexts/session-state.md
  if (!active && before.responseReady) {
    if (window.ATRACE) window.atrace('store.skip', sessionId, { map: 'sessionBusyState', reason: 'response-ready-holds-idle', fn: 'setActivity', via });
    return;
  }

  if (window.ATRACE && active && before.responseReady) {
    window.atrace('store.mutate', sessionId, { map: 'responseReadySessions', op: 'delete', from: true, to: false, fn: 'setActivity', via });
  }

  // armReady is computed here, not in apply() — see .ai/contexts/session-state.md ("The local-pty adapter")
  const wasBusy = before.busy;
  const effectiveArmReady = active ? armReady : (wasBusy && armReady && sessionId !== activeSessionId);

  state.apply({ type: 'busy', active, armReady: effectiveArmReady });
  const after = state.snapshot();

  activitySeq += 1;
  activitySeqBySession.set(sessionId, activitySeq);
  if (window.ATRACE) window.atrace('store.mutate', sessionId, { map: 'sessionBusyState', op: 'set', from: wasBusy, to: after.busy, actSeq: activitySeq, fn: 'setActivity', via });

  if (window.ATRACE && wasBusy && !active && after.responseReady) {
    window.atrace('store.mutate', sessionId, { map: 'responseReadySessions', op: 'add', from: false, to: true, fn: 'setActivity', via });
  }

  projectLocalPtyState(sessionId);
  // Fire only on a genuine busy->idle edge — see .ai/contexts/changes-view.md ("Refresh triggers").
  if (wasBusy && !active) notifySessionIdle(sessionId);
}

function clearUnread(sessionId, via) {
  const state = localPtyState(sessionId);
  if (window.ATRACE && state.snapshot().responseReady) window.atrace('store.mutate', sessionId, { map: 'responseReadySessions', op: 'delete', from: true, to: false, fn: 'clearUnread', via });
  state.apply({ type: 'clearUnread' });
  projectLocalPtyState(sessionId);
}

// OSC 9 "needs attention" — supersedes and consumes response-ready, see .ai/contexts/session-state.md ("The local-pty adapter")
function setAttention(sessionId, on, via) {
  const state = localPtyState(sessionId);
  const before = state.snapshot();
  if (window.ATRACE && before.attention !== !!on) window.atrace('store.mutate', sessionId, { map: 'attentionSessions', op: on ? 'add' : 'delete', from: before.attention, to: !!on, fn: 'setAttention', via });
  state.apply({ type: 'attention', active: !!on });
  projectLocalPtyState(sessionId);
}

// Mirrors activeSubagentsByParent into the adapter's own agentsBusy — see .ai/contexts/session-state.md ("The local-pty adapter")
function syncLocalPtyAgentsBusy(sessionId, active) {
  const state = localPtyState(sessionId);
  if (state.snapshot().agentsBusy === !!active) return;
  state.apply(active ? { type: 'subagentSpawned' } : { type: 'subagentCompleted', stillActive: false });
}

// Carry the activity state across a session-detected / session-forked re-key.
function rekeyActivityState(oldId, newId) {
  if (oldId === newId) return;
  const state = localPtyStates.get(oldId);
  if (window.ATRACE) {
    const snap = state ? state.snapshot() : null;
    window.atrace('store.rekey', newId, { from: oldId, busy: snap ? snap.busy : null, ready: snap ? snap.responseReady : false, attention: snap ? snap.attention : false, fn: 'rekeyActivityState' });
  }
  const oldItem = sessionItemEl(oldId);
  setCliBusy(oldItem, false);
  setResponseReady(oldItem, false);
  setNeedsAttention(oldItem, false);

  if (state) {
    localPtyStates.delete(oldId);
    localPtyStates.set(newId, state);
  }

  const seq = activitySeqBySession.get(oldId);
  if (seq !== undefined) {
    activitySeqBySession.delete(oldId);
    activitySeqBySession.set(newId, seq);
  }

  projectLocalPtyState(newId);
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
