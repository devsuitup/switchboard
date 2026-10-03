// trigger-context.js — see .ai/contexts/trigger-watcher.md
'use strict';

const path = require('path');

const { createTranscriptTurnReader } = require('./transcript-turn');

// Local session handle — see .ai/contexts/trigger-watcher.md, "Session handle".
function createLocalSessionHandle(ptyProcess) {
  return {
    write(data) { ptyProcess.write(data); },
    isAlive() {
      if (!ptyProcess || typeof ptyProcess.pid !== 'number') return false;
      try {
        process.kill(ptyProcess.pid, 0);
        return true;
      } catch (e) {
        return e.code === 'EPERM';
      }
    },
  };
}

/**
 * Build the `ctx` object trigger-watcher's `start(ctx)` expects.
 *
 * @param {object} deps
 * @param {Map} deps.activeSessions
 * @param {object} deps.log  electron-log compatible logger
 * @param {function} [deps.isPtyAlive]  (ptyProcess) => boolean
 * @param {function} [deps.getCliStatus]  (sessionId) => { status, statusUpdatedAt } | undefined
 * @param {string} [deps.projectsDir]  root of the CLI's transcript folders (~/.claude/projects)
 * @returns {object} ctx
 */
function createTriggerContext({ activeSessions, log, isPtyAlive, getCliStatus, projectsDir }) {
  const ctx = {
    log,
    getPtyForSession(sessionId) {
      const session = activeSessions.get(sessionId);
      if (!session || session.exited) return null;
      const handle = (session.host == null)
        ? createLocalSessionHandle(session.pty)
        : session.handle;
      // cwd: see .ai/contexts/trigger-watcher.md, "Target guard"
      return { ptyProcess: session.pty, cwd: session.cwd, handle };
    },
    isSessionBusy(sessionId) {
      const session = activeSessions.get(sessionId);
      return session ? !!session._cliBusy : false;
    },
    getComposerState(sessionId) {
      const session = activeSessions.get(sessionId);
      if (!session || session.exited || !session.composerState) return null;
      const { pending, lastInputAt } = session.composerState;
      return { pending, lastInputAt };
    },
  };
  if (isPtyAlive) ctx.isPtyAlive = isPtyAlive;
  // see .ai/contexts/trigger-watcher.md, "Transcript fallback while the descriptor stays busy"
  if (projectsDir) {
    const reader = createTranscriptTurnReader();
    const readPaths = new Map();
    ctx.getTranscriptTurn = (sessionId) => {
      const session = activeSessions.get(sessionId);
      if (!session || session.exited || session.host != null || !session.projectFolder) return null;
      const id = session.realSessionId || sessionId;
      const filePath = path.join(projectsDir, session.projectFolder, id + '.jsonl');
      readPaths.set(sessionId, filePath);
      return reader.read(filePath);
    };
    ctx.forgetTranscriptTurn = (sessionId) => {
      const filePath = readPaths.get(sessionId);
      if (filePath === undefined) return;
      readPaths.delete(sessionId);
      reader.forget(filePath);
    };
  }
  if (getCliStatus) {
    ctx.getCliStatus = (sessionId) => {
      const session = activeSessions.get(sessionId);
      if (!session || session.host != null) return undefined;
      return getCliStatus(sessionId);
    };
  }
  return ctx;
}

module.exports = { createTriggerContext, createLocalSessionHandle };
