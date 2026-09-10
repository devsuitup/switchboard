// see .ai/contexts/session-cache.md ("Remote hosts")
'use strict';

const fs = require('fs');
const {
  enabledHosts,
  normalizeRefreshMs,
  joinFolderKey,
  parseFolderKey,
  mirrorProjectsDirFor,
  manifestPathFor,
} = require('./remote-hosts');
const { syncMirror } = require('./remote-mirror');

const NOOP_LOG = { info() {}, warn() {}, error() {} };

// see .ai/contexts/session-cache.md ("Remote hosts backoff")
const MAX_BACKOFF_MS = 30 * 60 * 1000;

// see .ai/contexts/session-cache.md ("Remote hosts backoff")
function backoffDelayMs(failures, intervalMs) {
  if (failures <= 0) return 0;
  return Math.min(intervalMs * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
}

/**
 * Periodic mirror + index of every declared SSH host.
 * see .ai/contexts/session-cache.md ("Remote SSH hosts")
 *
 * ctx (everything reaching the outside world is injected):
 *   getHosts()                       -> raw host array from settings
 *   getRefreshMs()                   -> configured interval (floored at 60 s)
 *   dataDir                          -> where <dataDir>/remote/<alias>/ lives
 *   transport                        -> see remote-mirror.js
 *   scanFolders({projectsDir, folderPrefix, folders}) -> Promise
 *   listIndexedFolderKeys()          -> every folder key already in the cache
 *   dropFolder(folderKey)            -> remove a folder from cache + search
 *   setRemoteRoots(Map<alias,dir>)   -> tell the cache where each mirror lives
 *   notify()                         -> push a sidebar refresh
 *   timers                           -> { setInterval, clearInterval } (test seam)
 *   sync                             -> syncMirror override (test seam)
 *   now()                            -> current epoch ms (test seam, defaults to Date.now)
 */
function createRemoteIndexer(ctx) {
  const log = ctx.log || NOOP_LOG;
  const timers = ctx.timers || { setInterval, clearInterval };
  const sync = ctx.sync || syncMirror;
  const now = ctx.now || Date.now;

  let timer = null;
  let inFlight = false;
  let stopped = false;
  const remoteSessions = new Map(); // alias -> sessions array, from the same ssh cycle as the inventory
  const remoteSessionsAt = new Map(); // alias -> epoch ms of the last cycle that did not throw
  const hostBackoff = new Map(); // alias -> { failures, lastError, nextAttemptAt }
  const hostInFlight = new Set();

  function backoffState(alias) {
    let s = hostBackoff.get(alias);
    if (!s) {
      s = { failures: 0, lastError: null, nextAttemptAt: 0 };
      hostBackoff.set(alias, s);
    }
    return s;
  }

  function onHostSuccess(alias) {
    const state = backoffState(alias);
    if (state.failures > 0) {
      log.info(`[remote:${alias}] refresh recovered after ${state.failures} consecutive failure(s)`);
    }
    state.failures = 0;
    state.lastError = null;
    state.nextAttemptAt = 0;
  }

  function onHostFailure(alias, err, intervalMs) {
    const state = backoffState(alias);
    const prevDelay = backoffDelayMs(state.failures, intervalMs);
    state.failures += 1;
    state.lastError = err.message;
    const delay = backoffDelayMs(state.failures, intervalMs);
    state.nextAttemptAt = now() + delay;
    if (delay !== prevDelay) {
      log.warn(`[remote:${alias}] refresh failed (${state.failures}x consecutive): ${err.message}; ` +
        `retrying in ${Math.round(delay / 1000)}s`);
    }
  }

  function getRemoteHostState(alias) {
    const s = hostBackoff.get(alias);
    if (!s) return { consecutiveFailures: 0, lastError: null, nextAttemptAt: 0 };
    return { consecutiveFailures: s.failures, lastError: s.lastError, nextAttemptAt: s.nextAttemptAt };
  }

  function hosts() {
    return enabledHosts(ctx.getHosts ? ctx.getHosts() : []);
  }

  function publishRoots(list) {
    if (!ctx.setRemoteRoots) return;
    const roots = new Map();
    for (const h of list) roots.set(h.alias, mirrorProjectsDirFor(ctx.dataDir, h.alias));
    ctx.setRemoteRoots(roots);
  }

  // Nothing else ever revisits a folder whose alias is no longer declared.
  function pruneUnknownAliases(list) {
    if (!ctx.listIndexedFolderKeys || !ctx.dropFolder) return 0;
    const known = new Set(list.map(h => h.alias));
    let dropped = 0;
    for (const key of ctx.listIndexedFolderKeys()) {
      const { alias } = parseFolderKey(key);
      if (alias === null || known.has(alias)) continue;
      ctx.dropFolder(key);
      dropped++;
    }
    for (const alias of [...remoteSessions.keys()]) {
      if (!known.has(alias)) remoteSessions.delete(alias);
    }
    for (const alias of [...remoteSessionsAt.keys()]) {
      if (!known.has(alias)) remoteSessionsAt.delete(alias);
    }
    for (const alias of [...hostBackoff.keys()]) {
      if (!known.has(alias)) hostBackoff.delete(alias);
    }
    return dropped;
  }

  function mirrorFolders(projectsDir) {
    try {
      return fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);
    } catch {
      return [];
    }
  }

  async function refreshHost(host) {
    const projectsDir = mirrorProjectsDirFor(ctx.dataDir, host.alias);
    const manifestPath = manifestPathFor(ctx.dataDir, host.alias);
    fs.mkdirSync(projectsDir, { recursive: true });

    const result = await sync({
      alias: host.alias,
      transport: ctx.transport,
      projectsDir,
      manifestPath,
      log,
    });

    remoteSessions.set(host.alias, Array.isArray(result.sessions) ? result.sessions : []);

    const folderPrefix = host.alias;
    const toScan = new Set(result.changedFolders);
    const changedFilesByFolder = result.changedFilesByFolder instanceof Map
      ? result.changedFilesByFolder : new Map();

    // A mirror on disk but absent from the cache reports no change; index it once.
    const indexed = new Set();
    if (ctx.listIndexedFolderKeys) {
      for (const key of ctx.listIndexedFolderKeys()) {
        const parsed = parseFolderKey(key);
        if (parsed.alias === host.alias) indexed.add(parsed.folder);
      }
      const present = mirrorFolders(projectsDir);
      for (const folder of present) {
        if (!indexed.has(folder)) toScan.add(folder);
      }
      // And a folder the cache still knows about but the mirror no longer has.
      if (ctx.dropFolder) {
        const presentSet = new Set(present);
        for (const folder of indexed) {
          if (!presentSet.has(folder)) ctx.dropFolder(joinFolderKey(host.alias, folder));
        }
      }
    }

    if (toScan.size > 0 && ctx.scanFolders) {
      // see .ai/contexts/session-cache.md ("Remote hosts file-level rescan")
      const fileSubsets = new Map();
      for (const folder of toScan) {
        if (!indexed.has(folder)) continue;
        const files = changedFilesByFolder.get(folder);
        if (files && files.size > 0) fileSubsets.set(folder, files);
      }
      await ctx.scanFolders({
        projectsDir,
        folderPrefix,
        folders: [...toScan],
        ...(fileSubsets.size > 0 ? { fileSubsets } : {}),
      });
    }

    log.info(`[remote:${host.alias}] ${result.fetched} fetched, ${result.unchanged} unchanged, ` +
      `${result.removed} removed, ${result.failed} failed, ${toScan.size} folders indexed`);

    return toScan.size > 0;
  }

  // see .ai/contexts/session-cache.md ("Remote hosts backoff" — manual reconnect, issue #252)
  async function refreshNow({ force = false } = {}) {
    if (stopped || inFlight) return { skipped: true };
    const list = hosts();
    publishRoots(list);
    if (list.length === 0) return { skipped: true, hosts: 0 };

    inFlight = true;
    let changed = pruneUnknownAliases(list) > 0;
    const errors = [];
    const intervalMs = normalizeRefreshMs(ctx.getRefreshMs ? ctx.getRefreshMs() : undefined);
    try {
      for (const host of list) {
        if (stopped) break;
        if (hostInFlight.has(host.alias)) continue;
        const state = backoffState(host.alias);
        if (force) {
          state.failures = 0;
          state.nextAttemptAt = 0;
        } else if (now() < state.nextAttemptAt) {
          continue; // still backing off: no attempt, no log, no ssh
        }
        try {
          if (await refreshHost(host)) changed = true;
          onHostSuccess(host.alias);
          remoteSessionsAt.set(host.alias, now());
        } catch (err) {
          // A failed cycle keeps the last known descriptors — see
          // .ai/contexts/session-cache.md ("Remote hosts — freshness contract").
          errors.push({ alias: host.alias, error: err.message });
          onHostFailure(host.alias, err, intervalMs);
        }
      }
    } finally {
      inFlight = false;
    }

    if (changed && ctx.notify) ctx.notify();
    return { skipped: false, hosts: list.length, changed, errors };
  }

  // see .ai/contexts/session-cache.md ("Remote hosts — watch channel" and,
  // for `force`, "Remote hosts backoff" — manual reconnect, issue #252)
  async function refreshHostNow(alias, { force = false } = {}) {
    if (stopped || inFlight || hostInFlight.has(alias)) return { skipped: true };
    const host = hosts().find(h => h.alias === alias);
    if (!host) return { skipped: true };
    const state = backoffState(alias);
    if (force) {
      state.failures = 0;
      state.nextAttemptAt = 0;
    } else if (now() < state.nextAttemptAt) {
      return { skipped: true };
    }
    const intervalMs = normalizeRefreshMs(ctx.getRefreshMs ? ctx.getRefreshMs() : undefined);
    hostInFlight.add(alias);
    let changed = false;
    let error = null;
    try {
      changed = await refreshHost(host);
      onHostSuccess(alias);
      remoteSessionsAt.set(alias, now());
    } catch (err) {
      // A failed cycle keeps the last known descriptors — see
      // .ai/contexts/session-cache.md ("Remote hosts — freshness contract").
      onHostFailure(alias, err, intervalMs);
      error = err.message;
    } finally {
      hostInFlight.delete(alias);
    }
    if (changed && ctx.notify) ctx.notify();
    return { skipped: false, changed, error };
  }

  function start() {
    stopped = false;
    const list = hosts();
    publishRoots(list);
    // No host declared: no timer, and the transport is never touched.
    if (list.length === 0) return false;
    pruneUnknownAliases(list);
    const intervalMs = normalizeRefreshMs(ctx.getRefreshMs ? ctx.getRefreshMs() : undefined);
    timer = timers.setInterval(() => { refreshNow().catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    refreshNow().catch(() => {});
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) {
      timers.clearInterval(timer);
      timer = null;
    }
    if (ctx.transport && typeof ctx.transport.cancelInFlight === 'function') ctx.transport.cancelInFlight();
  }

  // Terminal: for application shutdown only, never for restart().
  function dispose() {
    stop();
    if (ctx.transport && typeof ctx.transport.dispose === 'function') ctx.transport.dispose();
  }

  function restart() {
    stop();
    return start();
  }

  // Freshness contract (issue #212) — see .ai/contexts/session-cache.md ("Remote hosts — freshness contract")
  function getRemoteSessions(alias) {
    const backoff = hostBackoff.get(alias);
    return {
      sessions: remoteSessions.get(alias) || [],
      at: remoteSessionsAt.get(alias) || null,
      error: backoff ? backoff.lastError : null,
    };
  }

  return {
    start, stop, dispose, restart, refreshNow, refreshHostNow,
    isRunning: () => timer !== null,
    getRemoteSessions,
    getRemoteHostState,
  };
}

module.exports = { createRemoteIndexer, backoffDelayMs };
