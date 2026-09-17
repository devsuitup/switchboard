// panel-terminal-target.js — cwd resolution for the panel shell — see .ai/contexts/panel-terminal.md

'use strict';

const REMOTE_REFUSAL = 'a remote session cannot host a panel shell';
const UNRESOLVED = 'could not resolve a working directory for this session';

// resolveTarget: (sessionId) => the resolveGitChangesTarget result for the
// session that owns the panel, i.e. {ok, kind, cwd} or {ok:false, error}.
function resolvePanelTerminalCwd(ownerSessionId, resolveTarget) {
  if (typeof ownerSessionId !== 'string' || ownerSessionId === '') {
    return { ok: false, error: 'invalid panel owner session id' };
  }
  const target = resolveTarget(ownerSessionId);
  if (!target || target.ok !== true) {
    return { ok: false, error: (target && target.error) || UNRESOLVED };
  }
  if (target.kind !== 'local') return { ok: false, error: REMOTE_REFUSAL };
  if (typeof target.cwd !== 'string' || target.cwd === '') {
    return { ok: false, error: UNRESOLVED };
  }
  return { ok: true, cwd: target.cwd };
}

module.exports = { resolvePanelTerminalCwd, REMOTE_REFUSAL };
