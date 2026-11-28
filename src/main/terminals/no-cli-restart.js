// see .ai/contexts/session-state.md ("Restored sessions without a CLI")
'use strict';

const { isComposerEmpty } = require('./composer-state');
const { tryAcquireTabInput } = require('./tab-input-lock');

const NO_CLI_RESTART_QUIET_MS = 10000;

function createNoCliRestart({ sessions, getStatus, getMcpState, liveElsewhereChecked, stop, now = Date.now }) {
  const restarted = new Set();
  const key = sessionId => String(sessionId).toLowerCase();

  function refusal(session, sessionId) {
    if (!session || session.exited) return 'not-running';
    if (session.isAttach || session.isPlainTerminal || session.kind !== 'local-pty') return 'not-eligible';
    if (restarted.has(key(sessionId))) return 'spent';
    if (!isComposerEmpty(session.composerState)) return 'input-pending';
    const realId = session.realSessionId || sessionId;
    const status = getStatus(realId);
    if (status === 'busy' || status === 'waiting') return 'turn-open';
    if (getMcpState(realId) === 'connected') return 'connected';
    return null;
  }

  function quietRefusal(session) {
    const last = Math.max(session.composerState?.lastInputAt || 0, session.lastPtyInputAt || 0);
    return now() - last < NO_CLI_RESTART_QUIET_MS ? 'recent-input' : null;
  }

  async function restart(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'not-running' };
    const session = sessions.get(sessionId);
    const before = refusal(session, sessionId) || quietRefusal(session);
    if (before) return { ok: false, reason: before };
    const unlock = tryAcquireTabInput(session);
    if (!unlock) return { ok: false, reason: 'input-locked' };
    try {
      const inputSeq = session.inputSeq || 0;
      let live;
      try { live = await liveElsewhereChecked(session.realSessionId || sessionId); } catch { live = null; }
      if (!live || live.known !== true) return { ok: false, reason: 'live-unknown' };
      if (live.live) return { ok: false, reason: 'live-elsewhere' };
      if (sessions.get(sessionId) !== session) return { ok: false, reason: 'changed' };
      if ((session.inputSeq || 0) !== inputSeq) return { ok: false, reason: 'input-during-attempt' };
      const after = refusal(session, sessionId) || quietRefusal(session);
      if (after) return { ok: false, reason: after };
      restarted.add(key(sessionId));
      stop(session, sessionId);
      return { ok: true };
    } finally {
      unlock();
    }
  }

  return { restart, spent: sessionId => restarted.has(key(sessionId)) };
}

module.exports = { createNoCliRestart, NO_CLI_RESTART_QUIET_MS };
