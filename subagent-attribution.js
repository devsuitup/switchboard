// Pure transcript-path -> parent attribution — see .ai/contexts/subagent-observability.md
'use strict';

// basename must be "agent-<id>.jsonl" — see read-session-file.js:enumerateSessionFiles
function agentIdFromBasename(basename) {
  if (typeof basename !== 'string' || !basename.endsWith('.jsonl')) return null;
  const base = basename.slice(0, -'.jsonl'.length);
  const m = base.match(/^agent-(.+)$/);
  return m ? m[1] : null;
}

// parts: [folder, ...rest] — both real layouts, null otherwise; see .ai/contexts/subagent-observability.md
function subagentParentFromParts(parts) {
  if (!Array.isArray(parts) || parts.length < 3) return null;
  const rest = parts.slice(1);
  const agentId = agentIdFromBasename(rest[rest.length - 1]);
  if (!agentId) return null;
  if (rest.length === 3 && rest[1] === 'subagents') {
    return { parentSessionId: rest[0], agentId };
  }
  if (rest.length === 2) {
    return { parentSessionId: rest[0], agentId };
  }
  return null;
}

module.exports = { subagentParentFromParts, agentIdFromBasename };
