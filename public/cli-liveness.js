// see docs/session-restore.md ("A restored session whose CLI never connects")
'use strict';

const CLI_LIVENESS_NO_CLI_MS = 60000;
const CLI_LIVENESS_RESTART_TIMEOUT_MS = 300000;

function createCliLiveness({ setTimer = setTimeout, clearTimer = clearTimeout, isOnline = () => true,
  onChange = () => {}, restart = async () => false,
  noCliMs = CLI_LIVENESS_NO_CLI_MS, restartTimeoutMs = CLI_LIVENESS_RESTART_TIMEOUT_MS } = {}) {
  const sessions = new Map();
  const restarted = new Set();
  const noCli = state => !!state && (state.phase === 'no-cli' || state.phase === 'restarting');

  function stopTimer(state) {
    if (state.timer != null) clearTimer(state.timer);
    state.timer = null;
  }

  function replace(sessionId, next) {
    const previous = sessions.get(sessionId);
    if (previous) stopTimer(previous);
    if (next) sessions.set(sessionId, next);
    else sessions.delete(sessionId);
    if (noCli(previous) !== noCli(next)) onChange(sessionId);
  }

  function expect(sessionId, { restartSpent = false } = {}) {
    if (restartSpent) restarted.add(sessionId);
    replace(sessionId, { phase: 'expected', timer: null, offlineSeen: false });
  }

  function settle(sessionId) {
    if (sessions.get(sessionId)?.phase === 'expected') sessions.delete(sessionId);
  }

  function forget(sessionId) {
    const state = sessions.get(sessionId);
    if (!state || state.phase === 'restarting') return;
    replace(sessionId, null);
  }

  function mcpState(sessionId, value) {
    const state = sessions.get(sessionId);
    if (!state || state.phase === 'restarting' && value !== 'connected') return;
    if (value !== 'listening') {
      replace(sessionId, null);
      return;
    }
    if (state.phase !== 'expected') return;
    state.phase = 'waiting';
    state.offlineSeen = !isOnline();
    state.timer = setTimer(() => declareNoCli(sessionId, state), noCliMs);
  }

  function declareNoCli(sessionId, state) {
    if (sessions.get(sessionId) !== state || state.phase !== 'waiting') return;
    state.timer = null;
    state.phase = 'no-cli';
    onChange(sessionId);
    if (restarted.has(sessionId)) return;
    if (state.offlineSeen && isOnline()) {
      attemptRestart(sessionId, state);
      return;
    }
    state.timer = setTimer(() => attemptRestart(sessionId, state), restartTimeoutMs);
  }

  function attemptRestart(sessionId, state) {
    if (sessions.get(sessionId) !== state || state.phase !== 'no-cli' || restarted.has(sessionId)) return;
    stopTimer(state);
    restarted.add(sessionId);
    state.phase = 'restarting';
    Promise.resolve().then(() => restart(sessionId)).catch(() => false).then(() => {
      if (sessions.get(sessionId) === state && state.phase === 'restarting') state.phase = 'no-cli';
    });
  }

  function offline() {
    for (const state of sessions.values()) {
      if (state.phase === 'waiting' || state.phase === 'no-cli') state.offlineSeen = true;
    }
  }

  function online() {
    for (const [sessionId, state] of [...sessions]) {
      if (state.phase === 'no-cli') attemptRestart(sessionId, state);
    }
  }

  function status(sessionId) {
    const state = sessions.get(sessionId);
    return { noCli: noCli(state), restartPending: noCli(state) && !restarted.has(sessionId) };
  }

  return {
    expect, settle, mcpState, exited: forget, online, offline, status,
    isNoCli: sessionId => noCli(sessions.get(sessionId)),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createCliLiveness, CLI_LIVENESS_NO_CLI_MS, CLI_LIVENESS_RESTART_TIMEOUT_MS };
}
