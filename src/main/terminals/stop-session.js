'use strict';

function stopLocalSession(session, sessionId, kill) {
  if (!session || session.exited) return { ok: false, error: 'not running' };
  if (session.isAttach) return { ok: false, error: 'attach requires detach' };
  session.stopRequested = true;
  try {
    if (kill(session, sessionId) === false) return { ok: false, error: 'termination could not be requested' };
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
}

module.exports = { stopLocalSession };
