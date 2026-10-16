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
  'CLAUDE_JOB_DIR',
  'AI_AGENT',
  'CLAUDE_EFFORT',
  'CLAUDE_ENV_FILE',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'TRACEPARENT',
  'TRACESTATE',
]);

function scrubSessionEnv(env) {
  for (const key of Object.keys(env)) {
    if (SESSION_MARKERS.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(scrubSessionEnv({ ...env })).filter(([k]) =>
      !k.startsWith('ELECTRON_') &&
      !k.startsWith('GOOGLE_API_KEY') &&
      k !== 'NODE_OPTIONS' &&
      k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
      k !== 'WT_SESSION'
    )
  );
}

module.exports = { cleanEnv, scrubSessionEnv, SESSION_MARKERS };
