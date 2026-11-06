// permit-spawn.js — see .ai/contexts/trigger-watcher.md, "Versioned actions"
'use strict';

const { launchModeFor } = require('../../../derive-project-path');

function permitLaunchRefusal({ permit, isNew, forkFrom, transcriptExists }) {
  if (!permit) return null;
  return launchModeFor({ isNew, forkFrom, transcriptExists, permitMode: permit.mode }).refuse || null;
}

function liveRefusal(live) {
  if (live.kind === 'bg') return 'background session is not supported';
  if (live.kind === 'schedule') return 'scheduled session is not supported';
  return 'session live elsewhere';
}

async function runPermitSpawn({ permit, permitId, sessionId, bridge, liveV1, resolveClosed, spawn }) {
  const refuse = error => { bridge.noteRefusal?.(permitId, error); return { ok: false, error }; };
  if (permit.mode === 'resume') {
    let live;
    try { live = await liveV1(sessionId, permit.deadline); } catch { live = { known: false }; }
    if (!live || live.known !== true) return refuse('session liveness unavailable');
    if (live.live) return refuse(liveRefusal(live.live));
    const again = resolveClosed(sessionId, permit.deadline);
    if (again.status !== 'found' || again.cwd !== permit.target?.cwd || again.file !== permit.target?.file) {
      return refuse('no readable transcript');
    }
  }
  const gate = bridge.guardedSpawn(permitId, spawn);
  if (!gate.ok) return { ok: false, error: gate.reason };
  return { ok: true, value: gate.value };
}

function sandboxLaunchEnv({ bindEnv, transcriptCwd, encodeProjectPath, triggersDir }) {
  return {
    ...(bindEnv ? { SWITCHBOARD_SANDBOX_BINDS: bindEnv } : {}),
    SWITCHBOARD_SANDBOX_TRIGGERS_DIR: triggersDir,
    ...(transcriptCwd ? { SWITCHBOARD_SANDBOX_PROJECT_FOLDER: encodeProjectPath(transcriptCwd) } : {}),
  };
}

async function launchClaudeProcess({ permit, permitId, sessionId, isNew, forkFrom, transcriptExists, sandbox, ptyEnv, spawn, bridge, liveV1, resolveClosed }) {
  const refusal = permitLaunchRefusal({ permit, isNew, forkFrom, transcriptExists });
  if (refusal) return { ok: false, error: refusal };
  if (sandbox) Object.assign(ptyEnv, sandboxLaunchEnv(sandbox));
  if (!permit) return { ok: true, value: spawn() };
  return runPermitSpawn({ permit, permitId, sessionId, bridge, liveV1, resolveClosed, spawn });
}

module.exports = { permitLaunchRefusal, runPermitSpawn, sandboxLaunchEnv, launchClaudeProcess };
