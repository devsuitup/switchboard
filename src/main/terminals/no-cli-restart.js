// see .ai/contexts/session-state.md ("Restored sessions without a CLI")
'use strict';

const { isComposerEmpty } = require('./composer-state');

function createNoCliRestart({ sessions, getStatus, getMcpState, liveElsewhereChecked, stop }) {
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

  async function restart(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'not-running' };
    const session = sessions.get(sessionId);
    const before = refusal(session, sessionId);
    if (before) return { ok: false, reason: before };
    let live;
    try { live = await liveElsewhereChecked(session.realSessionId || sessionId); } catch { live = null; }
    if (!live || live.known !== true) return { ok: false, reason: 'live-unknown' };
    if (live.live) return { ok: false, reason: 'live-elsewhere' };
    if (sessions.get(sessionId) !== session) return { ok: false, reason: 'changed' };
    const now = refusal(session, sessionId);
    if (now) return { ok: false, reason: now };
    restarted.add(key(sessionId));
    stop(session, sessionId);
    return { ok: true };
  }

  return { restart, spent: sessionId => restarted.has(key(sessionId)) };
}

module.exports = { createNoCliRestart };
