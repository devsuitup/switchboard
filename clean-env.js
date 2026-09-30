// Environment handed to spawned children: see .ai/contexts/ipc-bridge.md ("Clean child environment")
'use strict';

const SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
]);

function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) =>
      !k.startsWith('ELECTRON_') &&
      !k.startsWith('GOOGLE_API_KEY') &&
      k !== 'NODE_OPTIONS' &&
      k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
      k !== 'WT_SESSION' &&
      !SESSION_MARKERS.has(k)
    )
  );
}

module.exports = { cleanEnv, SESSION_MARKERS };
