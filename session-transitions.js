const path = require('path');
const fs = require('fs');
const { readSubagentMeta, classifyUserText, workflowRunDirectories } = require('./read-session-file');
const { classifyTranscriptPath } = require('./subagent-attribution');
const { scanContinuationIndex } = require('./session-continuations');
const { state: TRACE, trace } = require('./src/main/shared/activity-trace');
const { SUBAGENT_LIVE_TTL_MS } = require('./public/subagent-timing');
const { releaseWindowsPty } = require('./pty-ops');

/**
 * Fork detection for active PTY sessions.
 * Call init(ctx) once with shared context.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log, rekeyMcpServer, rekeyActivity, clearOwner, getDescriptorIdentity, setTimeoutFn, hasTaskRecord, getBackgroundTarget, rekeyMetadata, backgroundJobExists;
let onBackgroundConfirmed;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  rekeyMcpServer = ctx.rekeyMcpServer;
  rekeyActivity = ctx.rekeyActivity || (() => {});
  clearOwner = ctx.clearOwner || (() => 'pending');
  getDescriptorIdentity = ctx.getDescriptorIdentity || (() => null);
  setTimeoutFn = ctx.setTimeout || setTimeout;
  hasTaskRecord = ctx.hasTaskRecord || (() => false);
  getBackgroundTarget = ctx.getBackgroundTarget || (() => null);
  rekeyMetadata = ctx.rekeyMetadata || (() => {});
  backgroundJobExists = ctx.backgroundJobExists || (() => false);
  onBackgroundConfirmed = ctx.onBackgroundConfirmed || (() => {});
  rekeyed.clear();
  signalsCache.clear();
  for (const timer of recheckTimers.values()) clearTimeout(timer);
  recheckTimers.clear();
}

// see .ai/contexts/cli-session-state.md ("Owner of a /clear transcript")
const rekeyed = new Map();

function isLive(sessionId) {
  const session = activeSessions && activeSessions.get(sessionId);
  return !!session && !session.exited;
}

/** The id a session is keyed under now, following the re-keys of forks and /clear. */
const CLEAR_COMMANDS = new Set(['/clear', '/reset', '/new']);

const normalizeSessionId = id => typeof id === 'string' ? id.toLowerCase() : id;

function isClearCommand(command) {
  return typeof command === 'string' && CLEAR_COMMANDS.has(command.trim().split(/\s+/)[0]);
}

function logOwnerOnce(session, file, line) {
  const logged = session._ownerLogged || (session._ownerLogged = new Map());
  if (logged.get(file) === line) return;
  logged.set(file, line);
  log.info(line);
}

function currentSessionId(sessionId) {
  const key = normalizeSessionId(sessionId);
  const liveKeys = [...(activeSessions || [])].filter(([id, session]) => normalizeSessionId(id) === key && session && !session.exited);
  if (liveKeys.length) {
    rekeyed.delete(key);
    return liveKeys.length === 1 ? liveKeys[0][0] : key;
  }
  const target = rekeyed.get(key);
  if (target === undefined) return key;
  const live = [...(activeSessions || [])].some(([id, session]) => normalizeSessionId(id) === target && session && !session.exited);
  if (!live) {
    rekeyed.delete(key);
    return key;
  }
  const targetKeys = [...activeSessions].filter(([id, session]) => normalizeSessionId(id) === target && session && !session.exited);
  return targetKeys.length === 1 ? targetKeys[0][0] : target;
}

function recordRekey(oldId, newId) {
  oldId = normalizeSessionId(oldId);
  newId = normalizeSessionId(newId);
  for (const [from, to] of rekeyed) if (to === oldId) rekeyed.set(from, newId);
  rekeyed.set(oldId, newId);
}

const recheckTimers = new Map();
const RECHECK_MS = 1000;

function scheduleRecheck(folder, ms = RECHECK_MS) {
  if (recheckTimers.has(folder)) return;
  const timer = setTimeoutFn(() => {
    recheckTimers.delete(folder);
    detectSessionTransitions(folder);
  }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  recheckTimers.set(folder, timer);
}

// --- Subagent spawn / completion detection ---

// see .ai/contexts/subagent-observability.md
const SETTLE_TICK_MS = 5000;
const STABLE_MS = 30000;
const MAX_STABLE_MS = 300000;
const STABLE_LADDER_MS = [STABLE_MS, 120000, MAX_STABLE_MS];
let settleTimer = null;

function nextStableMs(current) {
  const i = STABLE_LADDER_MS.indexOf(current || STABLE_MS);
  if (i < 0 || i + 1 >= STABLE_LADDER_MS.length) return MAX_STABLE_MS;
  return STABLE_LADDER_MS[i + 1];
}

function hasUnsettledSubagents(session) {
  if (!session.knownSubagents) return false;
  for (const known of session.knownSubagents.values()) {
    if (known._cliTask) continue;
    if (!known.completed || known._recheckStart) return true;
  }
  return false;
}

function armSubagentSettleTick(session) {
  if (settleTimer || !hasUnsettledSubagents(session)) return;
  settleTimer = setTimeout(runSubagentSettleTick, SETTLE_TICK_MS);
  if (typeof settleTimer.unref === 'function') settleTimer.unref();
}

function runSubagentSettleTick() {
  settleTimer = null;
  if (!activeSessions) return;
  for (const [sessionId, session] of [...activeSessions]) {
    if (session.exited || session.isPlainTerminal || !session.projectFolder) continue;
    if (!hasUnsettledSubagents(session)) continue;
    detectSubagentTransitions(
      session.realSessionId || sessionId,
      session,
      path.join(PROJECTS_DIR, session.projectFolder)
    );
  }
}

/** Walk <folder>/<sessionId>/subagents/ and detect new or completed subagent files.
 *  Mutates session.knownSubagents (Map<agentId, { mtimeMs, completed }>).
 *  Emits IPC 'subagent-spawned' and 'subagent-completed' via mainWindow. */
function detectSubagentTransitions(sessionId, session, folderPath) {
  const subagentsDir = path.join(folderPath, sessionId, 'subagents');

  // --- Hot-path cache: avoid readdirSync + N×statSync when dir is quiet ---
  // With 1000+ subagents, the full scan blocks the main thread ~70 ms per
  // flush. We cache the dir's mtime; when it hasn't changed, no new files
  // could have appeared, so we skip readdirSync AND statSync for unknown
  // files. Known-active entries still get statSync for the stability timer.
  //
  // Session-local state:
  //   _prevDirMtime  — subagentsDir mtime at the last readdirSync
  //   _subFileList   — .jsonl file list from that scan
  let dirMtime;
  try {
    dirMtime = fs.statSync(subagentsDir).mtimeMs;
  } catch {
    return; // directory doesn't exist yet — normal
  }

  const isBootstrap = !session.knownSubagents;
  const runDirs = workflowRunDirectories(subagentsDir);
  const workflowStamp = runDirs.map(dir => {
    try { return [dir, fs.statSync(dir).mtimeMs]; } catch { return [dir, null]; }
  });
  const workflowsChanged = JSON.stringify(workflowStamp) !== session._workflowStamp;

  // dirChanged: true when dir mtime moved or we have no prior scan yet.
  // Also true when the prior scan returned 0 files: the dir mtime may not
  // advance within the same filesystem-clock tick on fast writes, so we
  // must rescan until we see at least one file to avoid missing arrivals.
  const prevFileList = session._subFileList;
  const dirChanged = isBootstrap
    || workflowsChanged
    || session._prevDirMtime !== dirMtime
    || !prevFileList
    || prevFileList.length === 0;

  let files;
  if (dirChanged) {
    try {
      files = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
      for (const dir of runDirs) {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.relative(subagentsDir, path.join(dir, entry.name)));
          }
        } catch {}
      }
      files = files.filter(file => classifyTranscriptPath(path.join(sessionId, 'subagents', file))?.agentId);
    } catch {
      return;
    }
    session._prevDirMtime = dirMtime;
    session._workflowStamp = JSON.stringify(workflowStamp);
    session._subFileList = files;
  } else {
    // Dir mtime unchanged and we saw files before — reuse cached list; no
    // new files can have appeared.
    files = prevFileList;
  }

  // First walk for this session: pre-populate knownSubagents with every
  // existing file silently so we don't flood the renderer with spawn/complete
  // events for agents that already finished before Switchboard started watching.
  // No file present at this point can belong to a live agent, whatever its
  // mtime — see .ai/contexts/subagent-observability.md
  if (isBootstrap) {
    session.knownSubagents = new Map();
  }

  const mainWindow = getMainWindow();
  const now = Date.now();
  const FRESH_SIGHTING_MS = 60000; // post-bootstrap: first sighting counts as live if newer than this
  const LIVE_RECHECK_MS = 300000; // an agent completed by the stability timer stays falsifiable this long
  // Re-emit subagent-spawned (idempotent on the renderer side — it just
  // refreshes the entry's last-seen timestamp) at most every HEARTBEAT_MS
  // while an agent's file keeps growing. Without this, the renderer's 60s
  // liveness TTL evicts any subagent that runs longer than a minute — the
  // common case — and the parent's indicator goes dark while the agent is
  // still working. A file that stops growing needs no heartbeat: it either
  // completes via the 30s stability timer (subagent-completed) or, if the
  // parent PTY died first, the renderer TTL prunes it — both under 60s of
  // silence, so the orphan behavior is unchanged.
  const HEARTBEAT_MS = 20000;
  let historyCount, newestAgeMs;
  if (TRACE.on && isBootstrap) { historyCount = 0; newestAgeMs = null; }

  for (const file of files) {
    const classified = classifyTranscriptPath(path.join(sessionId, 'subagents', file));
    if (!classified?.agentId) continue;
    const agentId = classified.agentId;
    if (hasTaskRecord(sessionId, agentId)) {
      const entry = session.knownSubagents.get(agentId);
      if (entry) entry._cliTask = true;
      continue;
    }
    const filePath = path.join(subagentsDir, file);

    const known = session.knownSubagents.get(agentId);

    // Completed and settled — nothing more to do, skip statSync. An entry
    // still carrying a recheck window is the exception: it was only assumed
    // finished, and growth would disprove that.
    if (known && known.completed && !known._recheckStart) continue;

    // Dir unchanged → no new entries can exist; skip statSync for unknown files.
    if (!known && !dirChanged) continue;

    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const mtimeMs = stat.mtimeMs;

    if (!known) {
      // A file that cannot be live is recorded as finished, silently. At
      // bootstrap that covers every file: Switchboard owns the PTYs, so
      // nothing it spawned outlived the previous process. Afterwards only a
      // stale mtime says so, and the sighting may simply be late.
      //
      // Either way the verdict stays reversible while the file could
      // conceivably be alive — a recheck window rehabilitates it if it grows.
      // Only a plainly historical file seen at bootstrap is frozen outright,
      // which is what keeps startup free of a per-file statSync.
      // See .ai/contexts/subagent-observability.md
      const isFresh = (now - mtimeMs) < FRESH_SIGHTING_MS;
      const looksAlive = !isBootstrap && isFresh;
      if (!looksAlive) {
        const recheck = !isBootstrap || isFresh;
        session.knownSubagents.set(agentId, {
          mtimeMs,
          completed: true,
          _completedAt: now,
          subagentType: null,
          description: null,
          _lastHeartbeatAt: now,
          _recheckStart: recheck ? now : null,
        });
        if (TRACE.on) {
          const ageMs = now - mtimeMs;
          if (isBootstrap && !recheck) {
            historyCount++;
            newestAgeMs = newestAgeMs === null ? ageMs : Math.min(newestAgeMs, ageMs);
          } else if (isBootstrap) {
            trace('subagent.bootstrap-candidate', sessionId, { agentId, ageMs, recheck, source: 'transcript-mtime', confidence: 'inferred' });
          } else {
            trace('subagent.assumed-finished', sessionId, { agentId, ageMs, bootstrap: false, recheck, source: 'transcript-mtime', confidence: 'inferred' });
          }
        }
        continue;
      }

      // First sighting of a live file — always post-bootstrap, so a genuine spawn.
      const meta = readSubagentMeta(filePath) || {};
      session.knownSubagents.set(agentId, {
        mtimeMs,
        completed: false,
        _completedAt: null,
        subagentType: meta.agentType || null,
        description: meta.description || null,
        _lastHeartbeatAt: now,
      });
      log.info(`[subagent-spawn] parent=${sessionId} agentId=${agentId} type=${meta.agentType || 'unknown'}`);
      if (TRACE.on) trace('subagent.spawned', sessionId, { agentId, kind: 'spawn', subagentType: meta.agentType || null, ageMs: now - mtimeMs, source: 'transcript-mtime', confidence: 'inferred', sent: !!(mainWindow && !mainWindow.isDestroyed()) });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('subagent-spawned', {
          parentSessionId: sessionId,
          agentId,
          subagentType: meta.agentType || null,
          description: meta.description || null,
        });
      }
    } else if (known.completed) {
      // Inside the recheck window of an assumed-finished entry. A file that
      // grows is alive: undo the assumption and emit the withheld spawn.
      if (mtimeMs !== known.mtimeMs) {
        const meta = readSubagentMeta(filePath) || {};
        if (TRACE.on) trace('subagent.rehabilitated', sessionId, { agentId, withheldForMs: now - known._recheckStart, subagentType: meta.agentType || null, source: 'transcript-mtime', confidence: 'inferred', sent: !!(mainWindow && !mainWindow.isDestroyed()) });
        known.mtimeMs = mtimeMs;
        known.completed = false;
        known._completedAt = null;
        if (known._recheckMs) known._stableMs = nextStableMs(known._stableMs);
        known._recheckStart = null;
        known._recheckMs = null;
        known._stableStart = null;
        known.subagentType = meta.agentType || null;
        known.description = meta.description || null;
        known._lastHeartbeatAt = now;
        log.info(`[subagent-spawn-late] parent=${sessionId} agentId=${agentId} type=${meta.agentType || 'unknown'}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('subagent-spawned', {
            parentSessionId: sessionId,
            agentId,
            subagentType: meta.agentType || null,
            description: meta.description || null,
          });
        }
      } else if (now - known._recheckStart >= (known._recheckMs || STABLE_MS)) {
        // Observed motionless for a full stability window — settled.
        known._recheckStart = null;
        known._recheckMs = null;
      }
    } else {
      if (mtimeMs !== known.mtimeMs) {
        // File is still being written — update mtime, reset stability clock
        known.mtimeMs = mtimeMs;
        known._stableStart = null;
        // Still-alive heartbeat (throttled) — see HEARTBEAT_MS above.
        const unseenForMs = now - (known._lastHeartbeatAt || 0);
        if (unseenForMs >= HEARTBEAT_MS && mainWindow && !mainWindow.isDestroyed()) {
          // see .ai/contexts/subagent-observability.md
          const stale = unseenForMs >= SUBAGENT_LIVE_TTL_MS;
          known._lastHeartbeatAt = now;
          if (TRACE.on) trace('subagent.spawned', sessionId, { agentId, kind: stale ? 'reannounce' : 'heartbeat', subagentType: known.subagentType || null, source: 'transcript-mtime', confidence: 'inferred', sent: true });
          mainWindow.webContents.send('subagent-spawned', {
            parentSessionId: sessionId,
            agentId,
            subagentType: known.subagentType || null,
            description: known.description || null,
            ...(stale ? {} : { _heartbeat: true }),
          });
        }
      } else {
        // mtime stable — start or continue stability timer
        if (!known._stableStart) {
          known._stableStart = now;
        } else if (now - known._stableStart >= (known._stableMs || STABLE_MS)) {
          known.completed = true;
          known._completedAt = now;
          known._recheckStart = now;
          known._recheckMs = LIVE_RECHECK_MS;
          log.info(`[subagent-complete] parent=${sessionId} agentId=${agentId}`);
          if (TRACE.on) trace('subagent.completed', sessionId, { agentId, stableForMs: now - known._stableStart, reason: 'mtime-stable', source: 'transcript-mtime', confidence: 'inferred', sent: !!(mainWindow && !mainWindow.isDestroyed()) });
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('subagent-completed', {
              parentSessionId: sessionId,
              agentId,
            });
          }
        }
      }
    }
  }

  // GC: forget an entry only once its file has left the disk, which bounds the
  // map by the directory's own size. See .ai/contexts/subagent-observability.md
  if (dirChanged && session.knownSubagents.size > files.length) {
    const onDisk = new Set();
    for (const file of files) {
      const classified = classifyTranscriptPath(path.join(sessionId, 'subagents', file));
      if (classified?.agentId) onDisk.add(classified.agentId);
    }
    for (const agentId of session.knownSubagents.keys()) {
      if (!onDisk.has(agentId)) session.knownSubagents.delete(agentId);
    }
  }

  if (TRACE.on && isBootstrap) trace('subagent.history-summary', sessionId, { historyCount, newestAgeMs, source: 'transcript-mtime', confidence: 'historical' });
  armSubagentSettleTick(session);
}

// --- Fork detection ---

/** Read first few lines of a new .jsonl to extract signals.
 *  Skips file-history-snapshot lines which can be very large (tens of KB)
 *  and reads up to 512KB to find the first user/assistant entry. */
const signalsCache = new Map();
const SIGNALS_CACHE_MAX = 256;

function readNewSessionSignals(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  const cached = stat && signalsCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.signals;
  const signals = readSignalsFromDisk(filePath, stat ? Math.min(stat.size, 524288) : 524288);
  if (stat) {
    if (signalsCache.size >= SIGNALS_CACHE_MAX) signalsCache.clear();
    signalsCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, signals });
  }
  return signals;
}

function readSignalsFromDisk(filePath, length) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    const lines = head.split('\n').filter(Boolean);
    let forkedFrom = null;
    let slug = null;
    let parentSessionId = null;
    let hasSnapshots = false;
    let cleared = false;
    let hasTurn = false;
    for (const line of lines) {
      const entry = JSON.parse(line);
      // Skip snapshot lines — they carry no fork/session signals
      if (entry.type === 'file-history-snapshot') { hasSnapshots = true; continue; }
      if (entry.forkedFrom) forkedFrom = entry.forkedFrom.sessionId;
      if (entry.slug && !slug) slug = entry.slug;
      // --fork-session copies messages with original sessionId
      if (entry.sessionId && !parentSessionId) parentSessionId = entry.sessionId;
      if (entry.type === 'user') {
        const text = typeof entry.message?.content === 'string' ? entry.message.content : '';
        const kind = classifyUserText(text);
        // see .ai/contexts/cli-session-state.md ("Owner of a /clear transcript")
        if (kind.kind === 'skip') continue;
        cleared = kind.kind === 'command' && isClearCommand(kind.text);
      }
      // Stop after finding a user or assistant message
      if (entry.type === 'user' || entry.type === 'assistant') { hasTurn = true; break; }
    }
    return { forkedFrom, slug, parentSessionId, hasSnapshots, cleared, hasTurn };
  } catch {
    return { forkedFrom: null, slug: null, parentSessionId: null, hasSnapshots: false, cleared: false, hasTurn: false };
  }
}

const CLEAR_OWNER_WAIT_MS = 60000;
const STALE_EMPTY_MS = 3600000;

function ageMs(filePath) {
  try { return Date.now() - fs.statSync(filePath).mtimeMs; } catch { return Infinity; }
}

function isFresh(filePath) {
  return ageMs(filePath) < CLEAR_OWNER_WAIT_MS;
}

// see .ai/contexts/session-state.md ("Proven continuation re-key")
const metadataWrites = new Set();
function transitionReason(session, sourceId, targetId, kind, jobId, reason, metadataCopied = false, error) {
  const key = JSON.stringify([sourceId, targetId, kind, jobId].map(value => typeof value === 'string' ? value.toLowerCase() : value));
  const diagnostics = session._transitionDiagnostics || (session._transitionDiagnostics = new Map());
  let reasons = diagnostics.get(key);
  if (!reasons) diagnostics.set(key, reasons = new Set());
  if (!error && reasons.has(reason)) return;
  reasons.add(reason);
  const message = `[session-transition] ${sourceId} → ${targetId} (${kind}) jobId=${jobId || 'none'} ${reason} metadataCopied=${metadataCopied}`;
  if (error) log?.error?.(message, error.message, error);
  else log?.info?.(message);
}

function backgroundProofMatches(context) {
  const { session, sourceId, targetId, jobId, projectFolder } = context;
  let fresh;
  try { fresh = freshContinuationIndex(session, sourceId, path.join(PROJECTS_DIR, projectFolder, sourceId + '.jsonl')); } catch {}
  const target = getBackgroundTarget(targetId);
  return backgroundCommandMatches(session, sourceId) && fresh?.complete && !fresh.unresolved
    && fresh.ids.length === 1 && normalizeSessionId(fresh.ids[0]) === normalizeSessionId(targetId)
    && target?.kind === 'bg' && normalizeSessionId(target.jobId) === normalizeSessionId(jobId);
}

function rekeySession(sessionId, newId, session, currentFiles, kind, background) {
  const sourceId = session.realSessionId || sessionId;
  const jobId = background?.jobId;
  const report = (reason, copied, error) => transitionReason(session, sourceId, newId, kind, jobId, reason, copied, error);
  if (session._metadataRekey) { report('metadata-pending', !!session._backgroundRekey?.copied); return; }
  let attempt;
  if (background) {
    const tuple = JSON.stringify([sourceId, newId, jobId].map(normalizeSessionId));
    attempt = session._backgroundRekey;
    if (attempt?.tuple !== tuple) {
      attempt = { tuple, copied: false, confirmed: false, context: { session, sourceKey: sessionId, sourceId,
        targetId: newId, jobId, projectFolder: session.projectFolder, exitDrain: session.exitDrain } };
      session._backgroundRekey = attempt;
    }
    if (!attempt.confirmed) {
      attempt.confirmed = true;
      try {
        Promise.resolve(onBackgroundConfirmed(attempt.context)).catch(error => report('confirmation-failed', attempt.copied, error));
      } catch (error) { report('confirmation-failed', attempt.copied, error); }
    }
  }
  const complete = () => {
    if (attempt) attempt.copied = true;
    let reason;
    if (activeSessions.get(sessionId) !== session) reason = 'source-replaced';
    else if (normalizeSessionId(session.realSessionId || sessionId) !== normalizeSessionId(sourceId)) reason = 'source-id-changed';
    else if (isLive(newId)) reason = 'target-live';
    else if (session.stopRequested) reason = 'source-stopped';
    else if (background && !backgroundProofMatches(attempt.context)) reason = 'background-proof-changed';
    else if (background && !backgroundJobExists(jobId)) reason = 'background-job-gone';
    if (reason) { report(reason, true); return; }
    publishRekey(sessionId, newId, session, currentFiles, kind, background);
    delete session._backgroundRekey;
  };
  try {
    if (attempt?.copied) { complete(); return; }
    const acknowledgment = rekeyMetadata(background ? sourceId : sessionId, newId, kind);
    if (acknowledgment?.then) {
      const pending = Promise.resolve(acknowledgment).then(complete)
        .catch(error => { report('metadata-failed', false, error); })
        .finally(() => {
          if (session._metadataRekey === pending) delete session._metadataRekey;
          if (activeSessions.get(sessionId) !== session && session._backgroundRekey === attempt) delete session._backgroundRekey;
          metadataWrites.delete(pending);
        });
      session._metadataRekey = pending;
      metadataWrites.add(pending);
      return;
    }
    if (background) complete();
    else publishRekey(sessionId, newId, session, currentFiles, kind, background);
  } catch (error) { report('metadata-failed', false, error); }
}

async function drainMetadataWrites() { await Promise.all([...metadataWrites]); }

function publishRekey(sessionId, newId, session, currentFiles, kind, background) {
  log.info(`[session-transition] ${sessionId} → ${newId} (${kind})`);
  session.knownJsonlFiles = new Set(currentFiles);
  session.realSessionId = newId;
  session.knownSubagents = null;
  session._prevDirMtime = undefined;
  session._subFileList = null;
  session._continuation = null;
  session.continuationSnapshot = snapshotContinuations(path.join(PROJECTS_DIR, session.projectFolder, newId + '.jsonl'), newId);
  session.backgroundCommandSource = null;
  session._pendingBackgroundContinuation = false;
  activeSessions.delete(sessionId);
  activeSessions.set(newId, session);
  recordRekey(sessionId, newId);
  rekeyMcpServer(sessionId, newId);
  rekeyActivity(sessionId, newId, kind);
  const mainWindow = getMainWindow();
  if (background) { session.backgrounded = true; session.backgroundJobId = background.jobId; void releaseWindowsPty(session.pty); }
  if (TRACE.on) trace('session.forked', sessionId, { newId, kind, jobId: background?.jobId || null, wasBusy: !!session._cliBusy, sent: !!(mainWindow && !mainWindow.isDestroyed()) });
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (background) mainWindow.webContents.send('session-forked', sessionId, newId, kind, background);
    else mainWindow.webContents.send('session-forked', sessionId, newId, kind);
  }
  if (background && session._continuationExit) session._continuationExit(true);
}

// see .ai/contexts/session-state.md ("Proven continuation re-key")
function detectContinuation(sessionId, session, folderPath, currentFiles, descriptorIdentity, descriptorSnapshot, backgroundOnly = false) {
  const sourceId = session.realSessionId || sessionId;
  const sourceFile = path.join(folderPath, sourceId + '.jsonl');
  let cached = session._continuation;
  if (!cached || cached.sourceId !== sourceId) cached = session._continuation = { sourceId, index: null, other: new Map() };
  let index;
  try {
    cached.index = scanContinuationIndex(sourceFile, sourceId, cached.index);
    index = JSON.parse(cached.index);
  } catch { return false; }
  if (!index.complete && (index.bytes < index.size || isFresh(sourceFile))) scheduleRecheck(session.projectFolder);
  const targets = new Set(index.ids);
  let fresh;
  try { fresh = freshContinuationIndex(session, sourceId, sourceFile); } catch {}
  const authorized = backgroundCommandMatches(session, sourceId);
  session._pendingBackgroundContinuation = !!(authorized && fresh && (!fresh.complete || (!fresh.unresolved && fresh.ids.length === 1)));
  if (session.exited && session._continuationExit && fresh?.complete && (fresh.unresolved || fresh.ids.length !== 1)) {
    session._continuationExit(false);
    return false;
  }
  if (authorized && fresh?.complete && !fresh.unresolved && fresh.ids.length === 1 && !session.isAttach && (!session.backgrounding || session.backgrounded)) {
    const newId = fresh.ids[0];
    if (normalizeSessionId(newId) !== normalizeSessionId(sourceId)) {
      const background = getBackgroundTarget(newId);
      if (background?.kind === 'bg' && background.jobId && backgroundJobExists(background.jobId)) {
        rekeySession(sessionId, newId, session, currentFiles, 'background', background);
        return !isLive(newId) || activeSessions.get(newId) === session;
      }
      transitionReason(session, sourceId, newId, 'background', background?.jobId,
        background?.kind === 'bg' && background.jobId ? 'background-job-pending' : 'background-proof-pending');
    }
  }
  if (session.exited || backgroundOnly) return false;
  for (const target of cached.other.keys()) if (!targets.has(target)) cached.other.delete(target);
  let identity;
  for (const newId of targets) {
    if (newId === sourceId || !currentFiles.includes(newId + '.jsonl') || isLive(newId)) continue;
    const file = path.join(folderPath, newId + '.jsonl');
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    try { identity ??= descriptorIdentity(); } catch { continue; }
    const previous = cached.other.get(newId);
    if (identity != null && previous && previous.mtimeMs === mtimeMs && previous.identity === identity) continue;
    let owner;
    try { owner = clearOwner(newId, session.pty && session.pty.pid, { closestWriter: true, descriptorSnapshot }); } catch { continue; }
    if (owner === 'mine') {
      rekeySession(sessionId, newId, session, currentFiles, 'continuation');
      return true;
    }
    const waiting = (owner === 'pending' || owner === 'absent') && isFresh(file);
    if (owner === 'other' || (owner === 'absent' && !waiting) || owner === 'unsupported') cached.other.set(newId, { mtimeMs, identity });
    else cached.other.delete(newId);
    if (waiting) scheduleRecheck(session.projectFolder);
  }
  return false;
}

function holdContinuationExit(sessionId, session, finish) {
  if (session.isPlainTerminal || session.isAttach || session.stopRequested || !session.projectFolder) return false;
  if (session.backgrounded) { finish(true); return true; }
  const sourceId = session.realSessionId || sessionId;
  if (!backgroundCommandMatches(session, sourceId)) return false;
  let index;
  try {
    const previous = session._continuation?.sourceId === sourceId ? session._continuation : { sourceId, index: null, other: new Map() };
    previous.index = scanContinuationIndex(path.join(PROJECTS_DIR, session.projectFolder, sourceId + '.jsonl'), sourceId, previous.index);
    session._continuation = previous;
    const file = path.join(PROJECTS_DIR, session.projectFolder, sourceId + '.jsonl');
    do { index = freshContinuationIndex(session, sourceId, file); } while (index && index.bytes < index.size);
  }
  catch { return false; }
  if (!index || index.unresolved || index.ids.length !== 1 || index.ids[0] === sourceId) return false;
  const timer = setTimeoutFn(() => {
    delete session._continuationExit;
    finish(false);
  }, 15000);
  if (timer?.unref) timer.unref();
  session._continuationExit = suppress => {
    clearTimeout(timer);
    delete session._continuationExit;
    finish(suppress);
  };
  detectSessionTransitions(session.projectFolder);
  return true;
}

/** Detect fork and /clear transitions for active PTY sessions in a folder */
function detectSessionTransitions(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  let currentFiles;
  try {
    currentFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }
  let descriptorIdentity;
  const descriptorSnapshot = {};
  const readIdentity = () => (descriptorIdentity ??= getDescriptorIdentity(descriptorSnapshot));

  for (const [sessionId, session] of [...activeSessions]) {
    // Run subagent detection for all non-exited, non-terminal sessions in this folder
    if (!session.exited && !session.isPlainTerminal && session.projectFolder === folder) {
      const effectiveSessionId = session.realSessionId || sessionId;
      detectSubagentTransitions(effectiveSessionId, session, folderPath);
    }

    if (!session.isPlainTerminal && session.knownJsonlFiles && session.projectFolder === folder
      && detectContinuation(sessionId, session, folderPath, currentFiles, readIdentity, descriptorSnapshot)) continue;

    if (session.exited || session.isPlainTerminal || !session.knownJsonlFiles || session.projectFolder !== folder) {
      if (!session.exited && !session.isPlainTerminal && session.forkFrom) {
        log.info(`[fork-detect] skipped session=${sessionId} forkFrom=${session.forkFrom||'none'} reason=${session.exited ? 'exited' : session.isPlainTerminal ? 'terminal' : !session.knownJsonlFiles ? 'noKnown' : 'folderMismatch('+session.projectFolder+' vs '+folder+')'}`);
      }
      continue;
    }

    const newFiles = currentFiles.filter(f => !session.knownJsonlFiles.has(f));

    if (newFiles.length > 0) log.debug(`[detect] session=${sessionId} forkFrom=${session.forkFrom||'none'} folder=${folder} newFiles=${newFiles.length} knownCount=${session.knownJsonlFiles.size} currentCount=${currentFiles.length}`);

    if (newFiles.length === 0) continue;

    const emptyFiles = new Set(); // files with no signals yet (still being written)
    let recheck = false;

    for (const newFile of newFiles) {
      const newFilePath = path.join(folderPath, newFile);
      const newId = path.basename(newFile, '.jsonl');
      const signals = readNewSessionSignals(newFilePath);

      // File exists but has no parseable content yet — skip and retry next cycle
      // But if the file's mtime is older than 1 hour, treat it as stale and archive it
      if (!signals.forkedFrom && !signals.parentSessionId && !signals.slug) {
        if (signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
          log.info(`[detect] session=${sessionId} snapshot-only file=${newId} while awaiting a fork`);
        } else {
          const stale = ageMs(newFilePath) > STALE_EMPTY_MS;
          if (stale) {
            log.info(`[detect] session=${sessionId} archiving stale empty file=${newId}`);
          } else {
            emptyFiles.add(newFile);
            if (isFresh(newFilePath)) recheck = true;
          }
          continue;
        }
      }

      if (session.forkFrom) {
        log.info(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=${session.forkFrom}`);
      } else {
        log.debug(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=none`);
      }

      let matched = false;

      // Fork: forkedFrom.sessionId matches this active PTY or the session it was forked from
      if (signals.forkedFrom === sessionId || (session.forkFrom && signals.forkedFrom === session.forkFrom)) {
        matched = true;
      }
      // --fork-session: new file's parentSessionId matches the forkFrom source,
      // and the new file's name (newId) differs from both our PTY id and the source
      if (!matched && session.forkFrom && signals.parentSessionId === session.forkFrom && newId !== session.forkFrom) {
        matched = true;
      }
      const awaitingFork = Boolean(session.forkFrom && !session.realSessionId);
      let pendingOwner = false;
      // see .ai/contexts/cli-session-state.md ("Owner of a /clear transcript")
      if (!matched && awaitingFork && signals.hasSnapshots && !signals.hasTurn) {
        const owner = clearOwner(newId, session.pty && session.pty.pid);
        if (owner === 'mine') matched = true;
        else pendingOwner = owner === 'pending';
        logOwnerOnce(session, newFile, `[detect] session=${sessionId} snapshot-only fork file=${newId} owner=${owner} matched=${matched}`);
      }
      if (!matched && signals.cleared && !awaitingFork && newId !== (session.realSessionId || sessionId)) {
        const owner = clearOwner(newId, session.pty && session.pty.pid);
        if (owner === 'mine') {
          matched = true;
        } else if (owner === 'pending' && isFresh(newFilePath)) {
          emptyFiles.add(newFile);
          recheck = true;
        }
        logOwnerOnce(session, newFile, `[detect] session=${sessionId} /clear file=${newId} owner=${owner} matched=${matched}`);
      }

      if (!matched && !signals.hasTurn && newId !== (session.realSessionId || sessionId) && ageMs(newFilePath) <= STALE_EMPTY_MS) {
        emptyFiles.add(newFile);
        if (isFresh(newFilePath) && (pendingOwner || !awaitingFork)) recheck = true;
      }

      if (session.forkFrom && !matched && !(session._noMatchLogged || (session._noMatchLogged = new Set())).has(newFile)) {
        session._noMatchLogged.add(newFile);
        log.info(`[detect] session=${sessionId} NO MATCH for newFile=${newId} forkFrom=${session.forkFrom} parentSessionId=${signals.parentSessionId||'null'} forkedFrom=${signals.forkedFrom||'null'}`);
      }

      if (matched) {
        rekeySession(sessionId, newId, session, currentFiles, signals.cleared && !awaitingFork ? 'clear' : 'fork');
        break; // Only one transition per session per flush
      }
    }

    // Update known files, but exclude empty ones so they get rechecked next cycle
    const updated = new Set(currentFiles);
    for (const f of emptyFiles) updated.delete(f);
    session.knownJsonlFiles = updated;
    if (recheck) scheduleRecheck(folder);
  }
}


function snapshotContinuations(file, sourceId) {
  let index, serialized;
  try {
    do {
      serialized = scanContinuationIndex(file, sourceId, serialized);
      index = JSON.parse(serialized);
    } while (index.bytes < index.size);
    return continuationSnapshot(index, sourceId);
  } catch (err) {
    return err.code === 'ENOENT' ? { sourceId, bytes: 0, ids: [], freshIndex: null } : null;
  }
}

function continuationSnapshot(index, sourceId) {
  const pending = Buffer.from(index.pending || '', 'base64');
  const freshIndex = JSON.stringify({ ...index, ids: [], sealedIds: [], pending: '', invalid: false,
    unresolved: false, skipLine: !!pending.length || index.skipLine, complete: true });
  return { sourceId, bytes: index.bytes, ids: index.ids.map(normalizeSessionId), freshIndex };
}

async function snapshotContinuationsBeforeSpawn(file, sourceId) {
  let index, serialized;
  try {
    do {
      serialized = scanContinuationIndex(file, sourceId, serialized);
      index = JSON.parse(serialized);
      if (index.bytes < index.size) await new Promise(resolve => setImmediate(resolve));
    } while (index.bytes < index.size);
    return continuationSnapshot(index, sourceId);
  } catch (err) {
    return err.code === 'ENOENT' ? { sourceId, bytes: 0, ids: [], freshIndex: null } : null;
  }
}

function freshContinuationIndex(session, sourceId, file) {
  const snapshot = session.continuationSnapshot;
  if (!snapshot || normalizeSessionId(snapshot.sourceId) !== normalizeSessionId(sourceId)) return null;
  const cached = session._continuation;
  const stat = fs.statSync(file);
  if (stat.size < snapshot.bytes) return null;
  let previous = cached.freshIndex || snapshot.freshIndex;
  const fd = fs.openSync(file, 'r');
  const tailAt = position => {
    const tail = Buffer.alloc(Math.min(64, position));
    const bytes = fs.readSync(fd, tail, 0, tail.length, position - tail.length);
    return bytes === tail.length ? tail.toString('hex') : null;
  };
  try {
    if (snapshot.bytes && tailAt(snapshot.bytes) !== JSON.parse(snapshot.freshIndex).tail) return null;
    if (previous) {
      let candidate = JSON.parse(previous);
      if (candidate.bytes > stat.size || candidate.size > stat.size || candidate.tail !== tailAt(candidate.bytes)) {
        candidate = snapshot.freshIndex ? JSON.parse(snapshot.freshIndex) : null;
      }
      if (candidate) candidate.mtime = stat.mtime.toISOString();
      previous = candidate ? JSON.stringify(candidate) : null;
    }
  } finally { fs.closeSync(fd); }
  cached.freshIndex = scanContinuationIndex(file, sourceId, previous);
  const index = JSON.parse(cached.freshIndex);
  if (index.size < snapshot.bytes) return null;
  return { ...index, ids: index.ids.filter(id => !snapshot.ids.includes(normalizeSessionId(id))) };
}

function backgroundCommandMatches(session, sourceId) {
  return session.backgrounded || normalizeSessionId(session.backgroundCommandSource) === normalizeSessionId(sourceId);
}

function detectPendingBackgroundContinuations() {
  for (const [sessionId, session] of [...activeSessions]) {
    if (!session._pendingBackgroundContinuation || session.isAttach || session.isPlainTerminal || !session.projectFolder) continue;
    const folderPath = path.join(PROJECTS_DIR, session.projectFolder);
    detectContinuation(sessionId, session, folderPath, [...session.knownJsonlFiles], () => null, {}, true);
  }
}

module.exports = { drainMetadataWrites, init, detectSessionTransitions, detectSubagentTransitions, detectPendingBackgroundContinuations, snapshotContinuations, snapshotContinuationsBeforeSpawn, holdContinuationExit, currentSessionId, isClearCommand, normalizeSessionId };
