// Pure transcript-path -> parent attribution — see .ai/contexts/subagent-observability.md
'use strict';
const WORKFLOW_RUN_RE = /^wf_[a-z0-9-]{6,}$/;

function isWorkflowRunId(id) {
  return typeof id === 'string' && WORKFLOW_RUN_RE.test(id);
}

function classifyTranscriptPath(relative) {
  if (typeof relative !== 'string') return null;
  const parts = relative.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  const filename = parts.at(-1);
  if (!filename.endsWith('.jsonl') || filename === '.jsonl') return null;
  if (parts.length === 1) return { parentSessionId: null, agentId: null, workflowRunId: null };
  const agentId = agentIdFromBasename(filename);
  if (parts.length === 2) return { parentSessionId: parts[0], agentId, workflowRunId: null };
  if (!agentId) return null;
  if (parts.length === 3 && parts[1] === 'subagents') {
    return { parentSessionId: parts[0], agentId, workflowRunId: null };
  }
  if (parts.length === 5 && parts[1] === 'subagents' && parts[2] === 'workflows' && isWorkflowRunId(parts[3])) {
    return { parentSessionId: parts[0], agentId, workflowRunId: parts[3] };
  }
  return null;
}

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
  const classified = classifyTranscriptPath(parts.slice(1).join('/'));
  return classified?.parentSessionId && classified.agentId
    ? { parentSessionId: classified.parentSessionId, agentId: classified.agentId } : null;
}

module.exports = { subagentParentFromParts, agentIdFromBasename, classifyTranscriptPath, isWorkflowRunId };
