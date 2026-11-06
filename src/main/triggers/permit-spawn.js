// permit-spawn.js — see .ai/contexts/trigger-watcher.md, "Versioned actions"
'use strict';

const { launchModeFor } = require('../../../derive-project-path');

function permitLaunchRefusal({ permit, isNew, forkFrom, transcriptExists }) {
  if (!permit) return null;
  return launchModeFor({ isNew, forkFrom, transcriptExists, permitMode: permit.mode }).refuse || null;
}

async function runPermitSpawn({ permit, permitId, sessionId, bridge, liveV1, resolveClosed, spawn }) {
  if (permit.mode === 'resume') {
    let live;
    try { live = await liveV1(sessionId); } catch { live = { known: false }; }
    if (!live || live.known !== true) return { ok: false, error: 'session liveness unavailable' };
    if (live.live) return { ok: false, error: 'session live elsewhere' };
    const again = resolveClosed(sessionId);
    if (again.status !== 'found' || again.cwd !== permit.target?.cwd || again.file !== permit.target?.file) {
      return { ok: false, error: 'no readable transcript' };
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

module.exports = { permitLaunchRefusal, runPermitSpawn, sandboxLaunchEnv };
