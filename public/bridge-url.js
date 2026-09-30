'use strict';

// see .ai/contexts/session-cache.md
const BRIDGE_ID_RE = /^(?:cse|session)_([A-Za-z0-9]+)$/;

function bridgeSessionUrl(bridgeSessionId) {
  if (typeof bridgeSessionId !== 'string') return null;
  const m = BRIDGE_ID_RE.exec(bridgeSessionId);
  return m ? 'https://claude.ai/code/session_' + m[1] : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bridgeSessionUrl };
}
