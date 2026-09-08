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
 */
function createRemoteIndexer(ctx) {
  const log = ctx.log || NOOP_LOG;
  const timers = ctx.timers || { setInterval, clearInterval };
  const sync = ctx.sync || syncMirror;

  let timer = null;
  let inFlight = false;
  let stopped = false;
  const remoteSessions = new Map(); // alias -> sessions array, from the same ssh cycle as the inventory

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

    // A mirror on disk but absent from the cache reports no change; index it once.
    if (ctx.listIndexedFolderKeys) {
      const indexed = new Set();
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
      await ctx.scanFolders({
        projectsDir,
        folderPrefix,
        folders: [...toScan],
      });
    }

    log.info(`[remote:${host.alias}] ${result.fetched} fetched, ${result.unchanged} unchanged, ` +
      `${result.removed} removed, ${result.failed} failed, ${toScan.size} folders indexed`);

    return toScan.size > 0;
  }

  async function refreshNow() {
    if (stopped || inFlight) return { skipped: true };
    const list = hosts();
    publishRoots(list);
    if (list.length === 0) return { skipped: true, hosts: 0 };

    inFlight = true;
    let changed = pruneUnknownAliases(list) > 0;
    const errors = [];
    try {
      for (const host of list) {
        if (stopped) break;
        try {
          if (await refreshHost(host)) changed = true;
        } catch (err) {
          remoteSessions.set(host.alias, []);
          errors.push({ alias: host.alias, error: err.message });
          log.warn(`[remote:${host.alias}] refresh failed: ${err.message}`);
        }
      }
    } finally {
      inFlight = false;
    }

    if (changed && ctx.notify) ctx.notify();
    return { skipped: false, hosts: list.length, changed, errors };
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

  function getRemoteSessions(alias) {
    return remoteSessions.get(alias) || [];
  }

  return { start, stop, dispose, restart, refreshNow, isRunning: () => timer !== null, getRemoteSessions };
}

module.exports = { createRemoteIndexer };
