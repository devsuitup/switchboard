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
function createTriggerContext(deps) {
  const { activeSessions, log, isPtyAlive, getCliStatus, getLiveDescriptor, projectsDir } = deps;
  // see .ai/contexts/trigger-watcher.md, "Re-keyed sessions"
  const currentId = deps.resolveSessionId || ((id) => id);
  const liveAliases = new Map();
  const observedPtys = new WeakSet();
  function forgetPty(pty) {
    for (const [id, alias] of liveAliases) if (alias.pty === pty) liveAliases.delete(id);
  }
  const ALIAS_RECHECK_MS = 3000;
  function owningSession(id) {
    let match = null;
    for (const [key, session] of activeSessions) {
      if (session.exited || session.isPlainTerminal || session.host != null || !Number.isInteger(session.pty?.pid)) continue;
      if (deps.clearOwner(id, session.pty.pid) !== 'mine') continue;
      if (match !== null) return null;
      match = { key, session };
    }
    return match;
  }
  function resolve(sessionId) {
    const id = currentId(sessionId);
    if (activeSessions.has(id)) {
      liveAliases.delete(id);
      return id;
    }
    const alias = liveAliases.get(id);
    if (!alias) return id;
    const session = activeSessions.get(alias.key);
    if (session !== alias.session || session.pty !== alias.pty || session.exited
      || !(isPtyAlive ? isPtyAlive(alias.pty) : createLocalSessionHandle(alias.pty).isAlive())) {
      liveAliases.delete(id);
      return id;
    }
    const now = Date.now();
    if (now - alias.checkedAt >= ALIAS_RECHECK_MS) {
      alias.checkedAt = now;
      let owner;
      try { owner = deps.clearOwner(id, alias.pty.pid, { rejectOtherConversation: true }); } catch {}
      if (owner === 'other') {
        liveAliases.delete(id);
        return id;
      }
    }
    return alias.key;
  }
  const ctx = {
    log,
    resolveSessionId: resolve,
    getSessionLockKey(sessionId) {
      const id = resolve(sessionId);
      return activeSessions.get(id) || id;
    },
    verifySessionOwner(sessionId, lockKey, entry) {
      const id = currentId(sessionId);
      const session = activeSessions.get(resolve(sessionId));
      if (session !== lockKey || session.exited || session.pty !== entry.ptyProcess) return false;
      const direct = id === sessionId && activeSessions.get(id) === session
        && (!session.realSessionId || session.realSessionId === id);
      if (session.host != null) return direct && session.handle === entry.handle;
      if (!deps.clearOwner) return direct;
      let owner;
      try { owner = deps.clearOwner(id, session.pty.pid, { rejectOtherConversation: true, directKey: direct }); } catch { return direct; }
      if (owner === 'other') {
        liveAliases.delete(id);
        return false;
      }
      return direct || owner === 'mine';
    },
    getPtyForSession(sessionId) {
      const session = activeSessions.get(resolve(sessionId));
      if (!session || session.exited) return null;
      const handle = (session.host == null)
        ? createLocalSessionHandle(session.pty)
        : session.handle;
      // cwd: see .ai/contexts/trigger-watcher.md, "Target guard"
      return { ptyProcess: session.pty, cwd: session.cwd, handle };
    },
    isSessionBusy(sessionId) {
      const session = activeSessions.get(resolve(sessionId));
      return session ? !!session._cliBusy : false;
    },
    getComposerState(sessionId) {
      const session = activeSessions.get(resolve(sessionId));
      if (!session || session.exited || !session.composerState) return null;
      const { pending, lastInputAt } = session.composerState;
      return { pending, lastInputAt };
    },
  };
  if (isPtyAlive) ctx.isPtyAlive = isPtyAlive;
  if (deps.refreshProcessTable) ctx.refreshProcessTable = () => deps.refreshProcessTable();
  if (getLiveDescriptor && deps.clearOwner) {
    ctx.findPtyForSession = async (sessionId, descriptor) => {
      const direct = ctx.getPtyForSession(sessionId);
      if (direct) return direct;
      const id = currentId(sessionId);
      const live = descriptor || await getLiveDescriptor(id);
      if (!Number.isInteger(live?.pid) || live.pid <= 0) return null;
      const match = owningSession(id);
      if (!match) return null;
      const pty = match.session.pty;
      forgetPty(pty);
      if (!observedPtys.has(pty) && typeof pty.onExit === 'function') {
        observedPtys.add(pty);
        pty.onExit(() => forgetPty(pty));
      }
      liveAliases.set(id, { key: match.key, session: match.session, pty: match.session.pty, checkedAt: Date.now() });
      return ctx.getPtyForSession(sessionId);
    };
  }
  if (getLiveDescriptor) ctx.getLiveDescriptor = (sessionId) => getLiveDescriptor(currentId(sessionId));
  if ('remote' in deps) Object.defineProperty(ctx, 'remote', {
    get() {
      const remote = deps.remote;
      if (!remote) return undefined;
      return {
        lookup(sessionId) {
          const aliases = remote.indexer.findSessionAliases(sessionId, remote.isEnabled);
          if (!aliases.length) return null;
          if (aliases.length > 1) return { aliases };
          const alias = aliases[0];
          const { sessions, at, error } = remote.indexer.getRemoteSessions(alias);
          const descriptor = sessions.find(s => s && s.sessionId === sessionId);
          if (!descriptor) return null;
          return { alias, descriptor, at, error, maxAgeMs: remote.maxAgeMs };
        },
        send(alias, descriptor, text) { return remote.adapter.send(alias, descriptor, text); },
      };
    },
  });
  // see .ai/contexts/trigger-watcher.md, "Transcript fallback while the descriptor stays busy"
  if (projectsDir) {
    const reader = createTranscriptTurnReader();
    const readPaths = new Map();
    ctx.getTranscriptTurn = (sessionId, compactionCursor) => {
      const session = activeSessions.get(resolve(sessionId));
      if (!session || session.exited || session.host != null || !session.projectFolder) return null;
      const requestedId = currentId(sessionId);
      const id = requestedId !== resolve(sessionId) ? requestedId : session.realSessionId || requestedId;
      const filePath = path.join(projectsDir, session.projectFolder, id + '.jsonl');
      const previous = readPaths.get(sessionId);
      if (previous !== undefined && previous !== filePath) reader.forget(previous);
      readPaths.set(sessionId, filePath);
      return reader.read(filePath, compactionCursor);
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
      const session = activeSessions.get(resolve(sessionId));
      if (!session || session.host != null) return undefined;
      return getCliStatus(currentId(sessionId));
    };
  }
  return ctx;
}

module.exports = { createTriggerContext, createLocalSessionHandle };
