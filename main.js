const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, powerMonitor, screen, session, shell } = require('electron');
const { Worker } = require('worker_threads');
const { performance } = require('node:perf_hooks');
const { createMainLoopMonitor } = require('./main-loop-monitor');
const { execFile, spawn: spawnChild } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
const relaunch = require('./relaunch');
const { acquireInstanceLock, readNoNewPrivs } = require('./linux-startup');

// Dev builds default to a separate SQLite DB so they don't race on
// session_cache with a running installed AppImage. Honors an explicit
// SWITCHBOARD_DATA_DIR env var if set (test sandboxes, agent runs). This MUST
// happen before db.js is required — db.js resolves DATA_DIR at module load.
if (!app.isPackaged && !process.env.SWITCHBOARD_DATA_DIR) {
  process.env.SWITCHBOARD_DATA_DIR = path.join(os.homedir(), '.switchboard-dev');
}

// getFolderIndexMtimeMs moved to session-cache.js
const { appendToOutputBuffer, MAX_BUFFER_SIZE } = require('./output-buffer');
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles, getMcpState } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');

// SWITCHBOARD_DATA_DIR isolates a dev/test instance from the installed app:
// db.js puts switchboard.db under it, and pointing userData there gives the
// instance its own single-instance lock (requestSingleInstanceLock keys on
// userData), so both can run side by side.
if (process.env.SWITCHBOARD_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.SWITCHBOARD_DATA_DIR, 'electron'));
}

log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';
const LOG_DEBUG_ON = log.transports.file.level === 'debug' || log.transports.console.level === 'debug';

// Opt-in activity trace — see docs/activity-trace.md.
const activityTrace = require('./activity-trace');
const { state: TRACE, trace, codePoints, controlOffset, busyDecision, progressDecision } = activityTrace;

const { classifyTitleActivity } = require('./classify-title-activity');
const { windowFrameOptions, applicationMenuTemplate, zoomKey, nextZoomLevel, menuPopupPoint } = require('./window-frame');
const { createUnsavedGuard } = require('./unsaved-guard');
const { inventory, runExitHandoffs } = require('./session-exit');
const { backgroundRefusal } = require('./bg-handoff');
const unsavedGuard = createUnsavedGuard({ ipcMain, quit: attempt => { quitAttemptToken = attempt; app.quit(); },
  inventory: () => exitInventory(), background: (ids, opts) => runExitBackground(ids, opts), externalFlush: () => flushForLogoff(), onAttemptReleased: () => { updateInstalling = false; } });
let exitInventory = () => ({ rows: [], counts: {}, remote: {} });
let runExitBackground = async () => [];
let flushForLogoff = () => Promise.resolve();
const { cleanEnv, scrubSessionEnv } = require('./clean-env');
scrubSessionEnv(process.env);
const { normalizeProjectPath: normalizeArchivedProjectPath } = require('./normalize-project-path');

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction.
const cleanPtyEnv = cleanEnv(process.env);

// Windows: prefer node-pty's bundled ConPTY (conpty.dll + OpenConsole.exe)
// over the OS inbox one. The inbox ConPTY re-renders TUI frames itself and is a
// known source of ghost/duplicated lines and torn rows during Claude Code
// redraws — artifacts that end up in the xterm buffer, so no renderer-side
// repaint can remove them. VS Code ships the same flag for the same reason.
// SWITCHBOARD_NO_CONPTY_DLL=1 reverts to the inbox ConPTY without a rebuild.
function spawnPty(file, args, opts) {
  if (!unsavedGuard.launchAllowed()) throw new Error('Switchboard is closing.');
  if (process.platform === 'win32' && !process.env.SWITCHBOARD_NO_CONPTY_DLL) {
    try {
      return guardPtyInputErrors(pty.spawn(file, args, { ...opts, useConptyDll: true }));
    } catch (err) {
      // e.g. conpty.dll not found next to the binding — inbox ConPTY still works
      log.warn(`[pty] useConptyDll spawn failed, falling back to inbox ConPTY: ${err.message}`);
    }
  }
  return guardPtyInputErrors(pty.spawn(file, args, opts));
}

// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgvForShell } = require('./shell-profiles');
const { startScheduler, scheduleBindRefusals, resolveScheduleSandbox, initialScheduleProjects, scanSchedules, setScheduleEnabled } = require('./schedule-runner');
const { archivePlanForGroups, validArchiveGroups } = require('./archived-projects');
const { encodeProjectPath } = require('./encode-project-path');
const { SETTING_DEFAULTS } = require('./public/setting-defaults');
const { isSensitivePath, isSensitivePathAsync, isAllowedMemoryPath: _isAllowedMemoryPath, resolveAllowedMemoryPath: _resolveAllowedMemoryPath, isKnownProjectRoot: _isKnownProjectRoot } = require('./ipc-path-validator');
const { validatePreLaunchCmd } = require('./pre-launch-cmd-guard');
const { normalizePtySize } = require('./pty-size');
const { makeDeleteSessionGuard } = require('./delete-session-guard');
const { resolveWindowsClaude } = require('./claude-binary');
const { setPtyOpLogger, guardPtyInputErrors, killPty, detachPty, writePty, ptyExitSignalName } = require('./pty-ops');
const { JOB_ID_RE, isHostedJob } = require('./bg-agents-roster');
const { createTerminalResizeHandler } = require('./terminal-resize');
const { createComposerState } = require('./composer-state');
const { handleTerminalInput } = require('./terminal-input');
const { createTriggerContext } = require('./trigger-context');
const { createTmuxAttachAdapter } = require('./remote-attach');
const { loadAttachProfileId } = require('./remote-attach-profile');
const { createRemoteStopAdapter } = require('./remote-stop');
const { attachBlockReason, sendBlockReason, launchBlockReason } = require('./remote-host-profile');
const { createRemoteLaunchAdapter, handleLaunchRequest } = require('./remote-launch');
const { createRemoteSendAdapter, handleSendRequest } = require('./remote-send');
const { createGitChangesRunner, localGitEnv } = require('./git-changes-runner');
const { runToExit } = require('./run-to-exit');
const gitChangesTarget = require('./git-changes-target');
const terminalPathTarget = require('./terminal-path-target');
const { resolvePanelTerminalCwd, isPanelShellSession } = require('./panel-terminal-target');
const { plainTerminalLaunch, ensureInitFiles: ensurePlainTerminalInitFiles } = require('./plain-terminal-shell');
const gitChangesFile = require('./git-changes-file');
const { listSessionTouchedFiles, mainTouchedCache } = require('./session-touched-files');
const { readRemoteTouchedFile } = require('./remote-touched-files');
const { createChangesWatchRegistry } = require('./git-changes-watch');
const { createViewerWatchRegistry } = require('./viewer-file-watch');
const { createMainPanelSaves } = require('./viewer-save-guard');
const { createActivityWatchClient, DEFAULT_BASE_URL: ACTIVITYWATCH_URL } = require('./activitywatch-client');
const { createActivityWatchReporter } = require('./activitywatch-reporter');

setPtyOpLogger(log);


// --- Auto-updater (only in packaged builds) ---
let relaunchExecPath = process.env.APPIMAGE || process.execPath;
let autoUpdater = null;
if (app.isPackaged || process.env.FORCE_UPDATER) {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (process.platform === 'linux') autoUpdater.autoRunAppAfterInstall = false;
  autoUpdater.on('appimage-filename-updated', file => { relaunchExecPath = file; });
  autoUpdater.allowPrerelease = SETTING_DEFAULTS.receiveBetaVersions;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  function sendUpdaterEvent(type, data) {
    log.info(`[updater] ${type}`, data || '');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', type, data);
    }
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => {
    sendUpdaterEvent('update-available', info);
    // With Automatic Updates off there are no scheduled checks, so this event
    // can only come from the user pressing "Check for Updates". electron-updater
    // does not fetch in that case — AppUpdater's downloadPromise is null unless
    // autoDownload — and nothing else calls downloadUpdate(), so a deliberate
    // check would otherwise stall at "found, never downloaded". Install still
    // waits for the user, since autoInstallOnAppQuit is off too.
    if (!autoUpdater.autoDownload) {
      autoUpdater.downloadUpdate().catch(err =>
        log.error('[updater] manual download failed:', err?.message || String(err)));
    }
  });
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('update-not-available', info));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('download-progress', progress));
  autoUpdater.on('update-downloaded', (info) => sendUpdaterEvent('update-downloaded', info));
  require('electron').autoUpdater.on('before-quit-for-update', () => { updateInstalling = true; });
  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err?.message || String(err));
    resetUpdateAttempt();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', 'error', { message: err?.message || String(err) });
    }
  });
}
let mainWindow = null;
let mainErrorWindowReady = false;
const mainErrorHandlers = require('./src/main/app/main-error-handlers').installMainErrorHandlers({
  log,
  notify: notice => {
    if (!mainErrorWindowReady || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
    mainWindow.webContents.send('main-process-error', notice);
    return true;
  },
});
let activityFlushedForQuit = false;
let updateInstalling = false;
let quitAttemptToken = null;
let updateInstallPromise = null;
let updateWaitTimer = null;
function resetUpdateAttempt() {
  const invalidated = unsavedGuard.invalidate('update');
  if (!invalidated && !updateInstalling && !updateInstallPromise) return;
  updateInstalling = false;
  activityFlushedForQuit = false;
  quitAttemptToken = null;
  updateInstallPromise = null;
  if (updateWaitTimer) clearTimeout(updateWaitTimer);
  updateWaitTimer = null;
  if (autoUpdater) autoUpdater.quitAndInstallCalled = false;
}
async function startApplication() {
if (!await acquireInstanceLock(app, { log })) { app.quit(); return; }
const privilegeNotice = readNoNewPrivs({ log });
const bgAgents = require('./bg-agents');
const writer = require('./session-index-writer').createSessionIndexWriter({
  log,
  onSessionsChanged: (...args) => bgAgents.invalidateTranscripts(...args),
});
let bootstrapQuit;
const holdBootstrapQuit = event => {
  event.preventDefault();
  bootstrapQuit ||= boundedBootstrapQuit();
};
async function boundedBootstrapQuit() {
  let timer;
  try {
    await Promise.race([writer.ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('writer bootstrap quit timed out')), 1500);
    })]);
    app.quit();
  } catch (error) { log.error('[startup]', error); app.exit(1); }
  finally { clearTimeout(timer); }
}
app.on('before-quit', holdBootstrapQuit);
await writer.ready;
const {
  isCachePopulated, getAllCached, getCachedByParent, getCachedByFolder, getCachedFolder, getCachedSession,
  getAllFolderMeta, getAllMeta, getSearchFileIds,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, listSettingKeys, isInitialScanComplete,
  getDailyMetrics, getDailyModelTokens, getModelUsage, getTotalCounts,
  DB_PATH, getProjectsRevision,
} = require('./db');
const { setStarred, setArchived, deleteCachedSession, deleteCachedFolder,
  deleteSearchSession, deleteSearchFolder, deleteSearchType, applySearchFileBatch,
  setSetting, deleteSetting, closeDb } = writer;

// see docs/changelog.md ("What's new in the app")
const INSTALL_PREDATES_LAUNCH = getSetting('global') !== null || isInitialScanComplete();

async function sweepContinuationChoices() {
  if (!isInitialScanComplete()) return;
  const topLevelIds = new Set(getAllCached().filter(row => !row.parentSessionId).map(row => row.sessionId));
  for (const key of listSettingKeys('continuationChoice:')) {
    if (!topLevelIds.has(key.slice('continuationChoice:'.length))) await deleteSetting(key);
  }
}

// The trace file sits next to switchboard.db — DB_PATH is the one resolution
// of SWITCHBOARD_DATA_DIR, never re-derived here.
const TRACE_DIR = path.dirname(DB_PATH);
const PLAIN_TERMINAL_INIT_DIR = path.join(path.dirname(DB_PATH), 'shell-init');
activityTrace.init(TRACE_DIR);
activityTrace.setEnabled(
  activityTrace.initialEnabled(process.env, (getSetting('global') || {}).activityTrace)
);
if (TRACE.on) {
  log.info(`[activity-trace] enabled → ${activityTrace.currentFile() || '(failed to open)'}`);
}
const mainLoopMonitor = createMainLoopMonitor({ enabled: () => TRACE.on, trace });

// see .ai/contexts/activitywatch.md
const activityWatchClient = createActivityWatchClient({ fetchFn: fetch, hostname: os.hostname(), log });
const activityReporter = createActivityWatchReporter({
  client: activityWatchClient,
  hostname: os.hostname(),
  idleSeconds: () => { try { return powerMonitor.getSystemIdleTime(); } catch { return 0; } },
});

activityReporter.setEnabled(
  (getSetting('global') || {}).activityReporting ?? SETTING_DEFAULTS.activityReporting
);

// One-shot cleanup: the Plans tab was removed, so nothing indexes or clears
// FTS rows of type 'plan' anymore. Purge any left behind by earlier versions.
const legacySearchCleanup = deleteSearchType('plan').catch(() => {});

// --- Search query worker ---
// Routes 'search' IPC off the main thread so that a slow FTS5 phrase query
// (e.g. a 60-char pasted URL) never blocks the Electron event loop.
// better-sqlite3 is synchronous; on the main thread a slow query stalls ALL
// IPC (terminal data, OSC, sidebar) → visible UI freeze. The worker opens a
// read-only WAL connection which coexists with the writer worker.
//
// A dedicated worker is used instead of the existing scan-projects worker because
// that worker is used for cold-start indexing and may be occupied with a long
// sequential scan when the user types a query.
//
// Protocol logic (correlation IDs, pending map, drain, backoff, circuit-breaker)
// lives in search-worker-client.js so it can be unit-tested without Electron.
const { createSearchWorkerClient } = require('./search-worker-client');

const searchClient = createSearchWorkerClient({
  workerFactory: (dbPath) => new Worker(
    path.join(__dirname, 'workers', 'search-query.js'),
    { workerData: { dbPath } }
  ),
  searchByType,
  log,
  dbPath: DB_PATH,
});

searchClient.startWorker();

/**
 * Send a search query to the worker and return a Promise<results[]>.
 * Falls back to the synchronous searchByType on the main thread if the
 * worker is not yet ready (first-launch race or circuit-breaker open).
 */
const searchViaWorker = searchClient.searchViaWorker;

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Ceiling for a file opened in the viewer panel, mirroring read-work-file.
const PANEL_FILE_MAX_BYTES = 2 * 1024 * 1024;
const TERMINAL_PATH_BATCH_MAX = 64;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
// MAX_BUFFER_SIZE imported from output-buffer.js (single source of truth)

// Active PTY sessions
const activeSessions = new Map();
const closedSessions = new Map();
// see .ai/contexts/touched-files.md ("One route into Touched")
const exitedRemoteSessionIds = new Set();
let stopScheduler;
let flushWindowBounds = async () => {};
let flushProjectsBeforeExit = async () => {};

// Every project root Switchboard currently knows about: live sessions plus
// every indexed project (same enumeration as the get-memories handler).
// Shared by every guard that needs to bound a renderer-supplied path to "a
// project this install actually knows about" — the memory allowlist below,
// and the worktree-path containment check next to WORKTREE_PATH_RE.
function getKnownProjectPaths() {
  const projectPaths = new Set();
  for (const [, s] of activeSessions) {
    if (s.projectPath) projectPaths.add(s.projectPath);
  }
  try {
    const { deriveProjectPath } = require('./derive-project-path');
    if (fs.existsSync(PROJECTS_DIR)) {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '.git') continue;
        const folderPath = path.join(PROJECTS_DIR, d.name);
        const p = deriveProjectPath(folderPath, d.name);
        if (p) projectPaths.add(p);
      }
    }
  } catch {}
  return projectPaths;
}

// Wrapper that plumbs the set of known project roots into isAllowedMemoryPath.
// The Memory panel (get-memories) surfaces CLAUDE.md / agents.md and
// .claude/*.md from EVERY indexed project — not just ones with a live session —
// so the allowlist must cover every known project root, otherwise reading a
// memory file for a project without an open session would be rejected.
function isAllowedMemoryPath(filePath) {
  return _isAllowedMemoryPath(filePath, [...getKnownProjectPaths()]);
}

// Same allowlist, but returns the resolved path to read/write instead of a
// boolean — callers with a filesystem operation to perform must use this and
// operate on the returned value, not on their own path.resolve(filePath).
// See ipc-path-validator.js and resolve-path-on-disk.js.
function resolveAllowedMemoryPath(filePath) {
  return _resolveAllowedMemoryPath(filePath, [...getKnownProjectPaths()]);
}

// Subagent live-tail watchers (watchId → { filePath, parentSessionId, agentId, teardown })
const subagentWatchers = new Map();
let subagentWatcherSeq = 0;

function createWindow() {
  // Restore saved window bounds
  const savedBounds = getSetting('global')?.windowBounds;
  let bounds = { width: 1400, height: 900 };

  let restorePosition = null;
  if (savedBounds && savedBounds.width && savedBounds.height) {
    bounds.width = savedBounds.width;
    bounds.height = savedBounds.height;

    // Only restore position if it's on a visible display
    if (savedBounds.x != null && savedBounds.y != null) {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return savedBounds.x >= b.x - 100 && savedBounds.x < b.x + b.width &&
               savedBounds.y >= b.y - 100 && savedBounds.y < b.y + b.height;
      });
      if (onScreen) {
        restorePosition = { x: savedBounds.x, y: savedBounds.y };
      }
    }
  }

  const appTitle = app.isPackaged ? 'Switchboard' : 'Switchboard (dev)';
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: appTitle,
    ...windowFrameOptions(process.platform),
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // The sandboxed preload cannot require activity-trace.js, so main's
      // resolution of the flag is handed to it instead of parsed twice.
      additionalArguments: TRACE.on ? ['--switchboard-activity-trace'] : [],
    },
  });

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log.error(`[renderer:${level}] ${sourceId}:${line} ${message}`);
  });

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', details => {
    const { url } = details;
    if (url !== mainWindow.webContents.getURL()) {
      details.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  mainWindow.webContents.on('did-navigate', () => { mainErrorWindowReady = false; });
  mainWindow.webContents.on('render-process-gone', () => { mainErrorWindowReady = false; });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    if (privilegeNotice) mainWindow.webContents.send('updater-event', 'startup-notice', privilegeNotice);
    mainWindow.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `);
  });

  unsavedGuard.attach(mainWindow);

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
    const zoom = zoomKey(input, process.platform);
    if (zoom) {
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(nextZoomLevel(mainWindow.webContents.getZoomLevel(), zoom));
    }
  });

  // Renderer-driven fullscreen toggle (F11 lands in xterm, which consumes the
  // keydown before the menu accelerator can fire — the terminal forwards it
  // here instead). Notify the renderer on every change, whatever triggered it
  // (menu click, IPC, OS shortcut), so it can refocus the active terminal —
  // otherwise the focus is lost on the transition and typing goes nowhere.
  const sendFullScreenChanged = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('full-screen-changed', mainWindow.isFullScreen());
  };
  mainWindow.on('enter-full-screen', sendFullScreenChanged);
  mainWindow.on('leave-full-screen', sendFullScreenChanged);

  // Save window bounds on move/resize (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => (async () => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      await writer.patchGlobal({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
    })().catch(err => log.error('[window] bounds save failed:', err.message)), 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  flushWindowBounds = async () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const b = mainWindow.getBounds();
    await writer.patchGlobal({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
  };

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', () => (async () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!appQuitting && !mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      await writer.patchGlobal({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
    }
  })().catch(err => log.error('[window] bounds save on close failed:', err.message)));

  mainWindow.on('closed', () => {
    mainErrorWindowReady = false;
    quitAttemptToken = unsavedGuard.committedToken(mainWindow);
    if (process.platform === 'darwin') { quitAttemptToken = null; unsavedGuard.invalidate(); }
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    for (const [id, session] of activeSessions) {
      closedSessions.set(id, session);
      if (!session.exited) killPty(session, id);
      activeSessions.delete(id);
    }
    changesWatchers.closeAll();
    closeAllFileWatchers();
    unsubscribeBgAgents();
    // Release all subagent file watchers (closes fs.watch handles + clears any
    // debounce timers / polling fallbacks via the stored teardown closure)
    for (const [, entry] of subagentWatchers) {
      try { entry.teardown(); } catch {}
    }
    subagentWatchers.clear();
    mainWindow = null;
  });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(app.name, { onWhatsNew: showWhatsNewFromMenu, onQuit: () => unsavedGuard.requestQuit(mainWindow) })));
}

// --- What's new (see docs/changelog.md) ---

const whatsNew = writer.createWhatsNew({
  currentVersion: app.getVersion(),
  existingInstall: INSTALL_PREDATES_LAUNCH,
  lastSeenDefault: SETTING_DEFAULTS.lastSeenVersion,
  readChangelog: () => fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'),
  log,
});

function showWhatsNewFromMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = whatsNew.forMenu();
  if (payload) mainWindow.webContents.send('show-whats-new', payload);
}

ipcMain.handle('whats-new-startup', async () => await whatsNew.startup());
ipcMain.handle('whats-new-dismissed', async () => await whatsNew.dismissed());

// --- Session cache helpers ---

const { resolveSessionRealCwd, sessionTranscriptExists, isGitRepo } = require('./derive-project-path');
const { resolveRowDeletionTargets } = require('./delete-session-target');

// Session cache → session-cache.js
const sessionCache = require('./session-cache');
writer.initializeCache({
  PROJECTS_DIR,
  activeSessions,
  getLocalDescriptors: () => cliSessionState.getSidebarDescriptors(),
  getLocalJobs: () => bgAgents.getCachedJobs(),
  getMainWindow: () => mainWindow,
  log,
});
const { readSessionFile, readFolderFromFilesystem,
        backfillEntrypoints, backfillCustomTitles, revealIfSdkSession, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker,
        scanFoldersViaWorker, setRemoteRoots, resolveFolderDir, isIndexingFinished } = sessionCache;
// see .ai/contexts/session-cache.md ("Projects query worker")
const { createProjectsWorkerClient } = require('./projects-worker-client');
let projectsReconciledAt = 0;
function projectsSnapshot() {
  const state = {
    activeSessions: [...activeSessions].map(([id, s]) => [id, {
      exited: !!s.exited, isPlainTerminal: !!s.isPlainTerminal, projectPath: s.projectPath,
      _openedAt: s._openedAt, panelFor: s.panelFor,
      isAttach: !!s.isAttach, attachJobId: s.attachJobId, realSessionId: s.realSessionId, cwd: s.cwd, host: s.host,
    }]),
    remoteRoots: [...sessionCache.getRemoteRoots()],
    localDescriptors: cliSessionState.getSidebarDescriptors().map(d => ({
      sessionId: d.sessionId, kind: d.kind, jobId: d.jobId, cwd: d.cwd,
      name: d.name, nameSource: d.nameSource, startedAt: d.startedAt,
    })),
    localJobs: [...bgAgents.getCachedJobs()].map(([id, job]) => [id, { state: job.state, name: job.name, nameSource: job.nameSource, sessionId: job.sessionId, transcriptPath: job.transcriptPath }]),
  };
  const liveVersion = JSON.stringify(state);
  return { ...state, liveVersion, version: getProjectsRevision() + liveVersion,
    writerRevision: typeof getSetting === 'function' ? getSetting('_writer_revision', { fresh: true }) || 0 : undefined };
}
const projectsClient = createProjectsWorkerClient({
  workerFactory: () => new Worker(path.join(__dirname, 'workers', 'projects-query.js'), { workerData: { dbPath: DB_PATH, projectsDir: PROJECTS_DIR } }),
  snapshot: projectsSnapshot,
  apply: async result => {
    const before = projectsSnapshot();
    const acknowledgment = await writer.applyProjectsWorkerEffects(result);
    return acknowledgment?.committedRevision !== undefined ? { committedRevision: acknowledgment.committedRevision }
      : { version: acknowledgment?.version ?? before.version };
  },
  accepted: result => { if (result.reconciled) projectsReconciledAt = Date.now(); },
});

const { resolveJsonlPath, readSubagentMeta } = require('./read-session-file');

// --- Remote SSH hosts (observation only) — see .ai/contexts/session-cache.md ---
const { isRemoteFolder, parseFolderKey, joinFolderKey, enabledHosts, normalizeHosts, normalizeRefreshMs } = require('./remote-hosts');
const { remoteHostLabel } = require('./public/utils');
const { handleEnrolRequest } = require('./remote-enrol');
const REMOTE_READ_ONLY = 'remote sessions are read-only — this build observes them, it does not attach to them';
const { createSshTransport } = require('./remote-transport');
require('./remote-ssh-binary').setResolverLog(log);
const { createRemoteIndexer, refreshRemoteHeadTurns: refreshRemoteHeadTurnsFromCache } = require('./remote-index');
const { createRemoteWatcher } = require('./remote-watch');
const { createRemoteActivityTracker } = require('./remote-activity');
const { createLocalTranscriptTracker } = require('./local-transcript-activity');

const remoteTransport = createSshTransport({ log });
const remoteIndexer = createRemoteIndexer({
  getHosts: () => (getSetting('global') || {}).remoteHosts,
  getRefreshMs: () => (getSetting('global') || {}).remoteRefreshMs,
  dataDir: path.dirname(DB_PATH),
  transport: remoteTransport,
  scanFolders: scanFoldersViaWorker,
  refreshHeadTurns: alias => refreshRemoteHeadTurns(alias),
  listIndexedFolderKeys: () => [...getAllFolderMeta().keys()],
  getCachedByFolder,
  dropFolder: async folderKey => await writer.dropRemoteFolder(folderKey),
  setRemoteRoots,
  notify: () => notifyRendererProjectsChanged('remote'),
  log,
});

// see .ai/contexts/session-cache.md ("Remote hosts — watch channel")
const remoteWatcher = createRemoteWatcher({ log });
let watchedAliases = new Set();
function onRemoteWatchEvent(alias) { remoteIndexer.refreshHostNow(alias).catch(() => {}); }

// see .ai/contexts/session-cache.md ("Remote hosts — busy spinner (issue #242)")
const remoteActivityTracker = createRemoteActivityTracker({
  onActivity: activity => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-activity', activity);
    }
  },
});

function onRemoteWatchActivity(alias, rel) {
  remoteActivityTracker.record(alias, rel);
}

function startWatcherForHost(host) {
  remoteWatcher.start(host.alias, onRemoteWatchEvent, onRemoteWatchActivity);
}

function syncRemoteWatchers() {
  const declared = enabledHosts((getSetting('global') || {}).remoteHosts);
  const wanted = new Set(declared.map(h => h.alias));
  for (const alias of watchedAliases) {
    if (!wanted.has(alias)) remoteWatcher.stop(alias);
  }
  for (const host of declared) {
    if (!remoteWatcher.isRunning(host.alias)) startWatcherForHost(host);
  }
  watchedAliases = wanted;
}

// see .ai/contexts/session-cache.md ("Remote hosts backoff" — manual reconnect, issue #252)
function restartWatcherForAlias(alias) {
  const declared = enabledHosts((getSetting('global') || {}).remoteHosts);
  const host = declared.find(h => h.alias === alias);
  if (!host) return;
  remoteWatcher.stop(alias);
  startWatcherForHost(host);
  watchedAliases.add(alias);
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
const remoteAttachAdapter = createTmuxAttachAdapter({
  profileId: loadAttachProfileId(app.getPath('userData'), log),
  spawnPty: (file, args, ptyOpts) => spawnPty(file, args, { ...ptyOpts, cwd: os.homedir(), env: cleanEnv(process.env, { locale: false }) }),
  log,
});

// see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
const remoteStopAdapter = createRemoteStopAdapter({ log });

// see .ai/contexts/session-cache.md ("Remote hosts — sending a prompt")
const remoteSendAdapter = createRemoteSendAdapter({ log });

// see .ai/contexts/session-cache.md ("Remote hosts — launching a session")
const remoteLaunchAdapter = createRemoteLaunchAdapter({ log, getHosts: () => (getSetting('global') || {}).remoteHosts });

// Joins the sidebar's remote sessions to the indexer's live descriptors so the
// renderer can route a click without ever naming an attach mechanism itself
// — see .ai/contexts/session-cache.md ("Remote hosts — tmux attach").
function annotateRemoteAttachable(projects) {
  const hostInfoByAlias = new Map();
  function hostInfo(alias) {
    if (!hostInfoByAlias.has(alias)) {
      const { sessions, at, error } = remoteIndexer.getRemoteSessions(alias);
      const { nextAttemptAt, consecutiveFailures } = remoteIndexer.getRemoteHostState(alias);
      const profile = remoteIndexer.getRemoteHostProfile(alias);
      hostInfoByAlias.set(alias, { at, error, nextAttemptAt, consecutiveFailures, profile, byId: new Map(sessions.map(d => [d.sessionId, d])) });
    }
    return hostInfoByAlias.get(alias);
  }
  for (const project of projects) {
    if (project.remoteAlias) {
      const info = hostInfo(project.remoteAlias);
      project.remoteHostAt = info.at;
      project.remoteHostError = info.error;
      project.remoteHostNextAttemptAt = info.nextAttemptAt || null;
      project.remoteHostProfile = info.profile;
    }
    for (const session of project.sessions) {
      if (session.remoteAlias) {
        const info = hostInfo(session.remoteAlias);
        const descriptor = info.byId.get(session.sessionId);
        const attachId = [session.headSessionId || session.sessionId, session.sessionId, ...(session.mergedMemberIds || [])]
          .find(id => info.byId.has(id));
        const attachDescriptor = info.byId.get(attachId);
        session.remoteAttachSessionId = attachId || null;
        const hostBlocked = attachBlockReason(info.profile, info.consecutiveFailures);
        const supportsAttach = !!(attachDescriptor && remoteAttachAdapter.supports(attachDescriptor));
        session.remoteAttachable = supportsAttach && !hostBlocked;
        session.remoteAttachBlocked = supportsAttach ? hostBlocked : null;
        session.remoteSendBlocked = sendBlockReason(info.profile);
        session.status = descriptor ? (descriptor.status || null) : null;
        session.statusUpdatedAt = descriptor ? (descriptor.statusUpdatedAt || null) : null;
        session.waitingFor = descriptor ? (descriptor.waitingFor || null) : null;
        session.mergedMemberStatuses = Object.fromEntries((session.mergedMemberIds || []).map(id => {
          const member = info.byId.get(id);
          return [id, member ? {
            status: member.status || null,
            statusUpdatedAt: member.statusUpdatedAt || null,
            waitingFor: typeof member.waitingFor === 'string' && member.waitingFor ? member.waitingFor : null,
          } : null];
        }));
        session.remoteActiveAt = remoteActivityTracker.activeAt(session.remoteAlias, session.sessionId);
        // listed descriptor = live process (ALIVE filter) — see .ai/contexts/session-state.md
        session.remoteDescriptorSeen = !!descriptor;
        session.remoteHostAt = info.at;
        session.remoteMemberDescriptorSeen = Object.fromEntries((session.mergedMemberIds || [])
          .map(id => [id, info.byId.has(id)]));
      } else {
        // Same descriptor vocabulary, read from the local ~/.claude/sessions/<pid>.json
        // instead of a remote host's mirror -- see .ai/contexts/cli-session-state.md
        const local = cliSessionState.getStatus(session.sessionId);
        session.status = local ? local.status : undefined;
        session.statusUpdatedAt = local ? local.statusUpdatedAt : undefined;
        session.waitingFor = local ? local.waitingFor : null;
        session.mergedMemberStatuses = Object.fromEntries((session.mergedMemberIds || [])
          .map(id => [id, cliSessionState.getStatus(id) || null]));
      }
    }
  }
  return projects;
}

// see .ai/contexts/session-cache.md ("Remote hosts — descriptor-only sessions")
function toSidebarPlaceholderSession(ph) {
  return {
    sessionId: ph.sessionId,
    summary: ph.summary,
    firstPrompt: null,
    created: null,
    modified: ph.modified,
    messageCount: 0,
    projectPath: ph.projectPath,
    slug: null,
    aiTitle: null,
    parentSessionId: null,
    agentId: null,
    subagentType: null,
    description: null,
    name: null,
    starred: 0,
    archived: 0,
    remoteAlias: ph.remoteAlias,
    remoteDescriptorSeen: ph.remoteDescriptorSeen,
    status: ph.status,
    statusUpdatedAt: ph.statusUpdatedAt,
    waitingFor: ph.waitingFor,
    placeholder: true,
  };
}

function mergePlaceholderSessions(projects) {
  const placeholders = remoteIndexer.getAllPlaceholderSessions();
  for (const ph of placeholders) {
    const project = projects.find(p => p.remoteAlias === ph.remoteAlias && p.projectPath === ph.projectPath);
    if (project) {
      if (project.sessions.some(s => s.sessionId === ph.sessionId)) continue;
      project.sessions.push(toSidebarPlaceholderSession(ph));
    } else {
      projects.push({
        folder: joinFolderKey(ph.remoteAlias, ph.folder),
        projectPath: ph.projectPath,
        remoteAlias: ph.remoteAlias,
        sessions: [toSidebarPlaceholderSession(ph)],
        missing: false,
      });
    }
  }
  return projects;
}

/** Directory holding a folder key's transcripts, local or mirrored. */
function projectsDirForFolder(folder) {
  return resolveFolderDir(folder);
}

/** resolveJsonlPath for a cache row whose `folder` may carry an alias prefix. */
function resolveSessionJsonlPath(row) {
  const dir = projectsDirForFolder(row && row.folder);
  if (!dir) return null;
  return resolveJsonlPath(dir, { ...row, folder: '.' });
}

// --- IPC: browse-folder ---
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Projects whose schedules may run; see docs/sandbox.md ("Schedules").
function scheduleProjects() {
  return writer.scheduleRegistry(() => initialScheduleProjects(() => listSettingKeys('project:')));
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

async function unarchivedScheduleProjects(projectPath) {
  const { isHiddenRepositoryWorktree } = require('./public/worktree-nesting');
  const target = normalizeArchivedProjectPath(projectPath);
  return (await scheduleProjects().list()).filter(p => {
    const candidate = normalizeArchivedProjectPath(p);
    return candidate === target || isHiddenRepositoryWorktree(candidate, null, [target]);
  });
}

function skipMissedScheduleRuns(projects) {
  try {
    require('./schedule-runner').skipMissedRuns(log, projects, path.join(path.dirname(DB_PATH), 'schedule-state'));
  } catch (err) {
    log.warn('[schedule] Cannot reset the catch-up record after unarchive:', err.message);
  }
}

function isProjectSettingsArchived(projectPath) {
  const hidden = (getSetting('global') || {}).hiddenProjects || [];
  const local = hidden.filter(entry => parseFolderKey(entry).alias === null).map(normalizeArchivedProjectPath);
  const target = normalizeArchivedProjectPath(projectPath);
  return local.includes(target)
    || require('./public/worktree-nesting').isHiddenRepositoryWorktree(target, null, local);
}

// see .ai/contexts/session-cache.md ("Project Archive and Delete")
ipcMain.handle('archive-project-settings', async (_event, projectPath, folderKey) => {
  try {
    const { alias } = folderKey ? parseFolderKey(folderKey) : { alias: null };
    const entry = alias === null ? projectPath : joinFolderKey(alias, projectPath);
    await writer.hideProject(entry, 'archive');
    notifyRendererProjectsChanged('archive');
    return { ok: true, entry };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('unarchive-project', async (_event, entry) => {
  try {
    const global = getSetting('global') || {};
    if (!(global.hiddenProjects || []).includes(entry)) return { error: 'Project is not archived', code: 'NOT_ARCHIVED' };
    if (global.hiddenProjectKinds?.[entry] === 'delete') return { error: 'Project is deleted', code: 'DELETED' };
    const { alias, folder: projectPath } = parseFolderKey(entry);
    const folder = alias === null ? encodeProjectPath(projectPath) : joinFolderKey(alias, encodeProjectPath(projectPath));
    await writer.refreshFolder(folder);
    const kind = global.hiddenProjectKinds?.[entry];
    if (alias === null && kind === undefined && isDirectory(projectPath)) await scheduleProjects().add(projectPath);
    if (alias === null) skipMissedScheduleRuns(await unarchivedScheduleProjects(projectPath));
    await writer.unhideProject(entry, alias, projectPath);
    notifyRendererProjectsChanged('archive');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: add-project ---
ipcMain.handle('add-project', async (_event, projectPath) => {
  try {
    // Validate the path exists and is a directory
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // see .ai/contexts/session-cache.md ("Project Archive and Delete")
    await writer.revealAddedProject(projectPath);

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = require('crypto').randomUUID();
      const seedFile = path.join(folderPath, seedId + '.jsonl');
      const now = new Date().toISOString();
      const line = JSON.stringify({ type: 'user', cwd: projectPath, sessionId: seedId, uuid: require('crypto').randomUUID(), timestamp: now, message: { role: 'user', content: 'New project' } });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Immediately index the new folder so it's in cache before frontend renders
    await writer.refreshFolder(folder);
    notifyRendererProjectsChanged('project-added');
    await scheduleProjects().add(projectPath);

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project ---
ipcMain.handle('remove-project', async (_event, projectPath, folderKey) => {
  try {
    // Add to hidden projects list
    const { alias } = folderKey ? parseFolderKey(folderKey) : { alias: null };
    const hiddenEntry = alias === null ? projectPath : joinFolderKey(alias, projectPath);
    await writer.hideProject(hiddenEntry, 'delete');

    // Clean up DB cache and search index for this folder
    const folder = folderKey || encodeProjectPath(projectPath);
    await deleteCachedFolder(folder);
    await deleteSearchFolder(folder);
    await deleteSetting('project:' + projectPath);
    await scheduleProjects().remove(projectPath);

    notifyRendererProjectsChanged('project-deleted');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: archive a project folder — see .ai/contexts/session-cache.md ("Archived projects") ---
async function projectArchivePlan(groups) {
  return archivePlanForGroups(groups, {
    registered: await scheduleProjects().list(),
    scan: (projectPath) => scanSchedules(log, [projectPath]),
    realpath: fs.realpathSync,
  });
}

function archiveDeps() {
  return {
    isInitialScanComplete,
    seedProjects: () => initialScheduleProjects(() => listSettingKeys('project:')),
    scan: projectPath => scanSchedules(log, [projectPath]),
    realpath: fs.realpathSync,
    setEnabled: setScheduleEnabled,
    mergeProjects: mergePlaceholderSessions,
    activeSessions,
    notify: () => notifyRendererProjectsChanged('archive'),
    now: () => new Date().toISOString(),
  };
}

ipcMain.handle('get-project-archive-plan', async (_event, groups) => {
  if (!isInitialScanComplete()) return { indexing: true };
  return { schedules: await projectArchivePlan(validArchiveGroups(groups)) };
});

ipcMain.handle('archive-project', async (_event, groups, opts) => {
  const res = await writer.archiveProjectFolders(groups, opts, archiveDeps());
  if (res.error) log.warn(`[archive-project] failed: ${res.error} disabled=${(res.disabled || []).length}`);
  else log.info(`[archive-project] disabled=${res.disabled.length} failed=${res.failed.length}`);
  return res;
});

ipcMain.handle('undo-archive-project', async (_event, groups, archivedAt) =>
  await writer.undoArchiveProjectFolders(groups, archivedAt, archiveDeps()));

ipcMain.handle('reenable-project-schedules', async (_event, projectPath, folderKey) =>
  await writer.reenableOfferedSchedules(projectPath, folderKey, archiveDeps()));

ipcMain.handle('dismiss-schedule-reenable-offer', async (_event, projectPath, folderKey) =>
  await writer.dismissReenableOffer(projectPath, folderKey, archiveDeps()));

// --- IPC: remap-project ---

function remapProjectRefusal(oldPath) {
  if (typeof oldPath !== 'string') return 'Invalid arguments';
  const folder = encodeProjectPath(oldPath);
  for (const session of activeSessions.values()) {
    if (!isPanelShellSession(session) && !session.exited && encodeProjectPath(session.projectPath) === folder) {
      return 'Active sessions for this project — stop them first';
    }
  }
  return null;
}

ipcMain.handle('check-remap-project', (_event, oldPath) => {
  const error = remapProjectRefusal(oldPath);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle('remap-project', async (_event, oldPath, newPath) => {
  try {
    // Validate oldPath/newPath are strings (basic sanitisation)
    if (typeof oldPath !== 'string' || typeof newPath !== 'string') {
      return { error: 'Invalid arguments' };
    }

    // Re-check at handler entry: if oldPath came back, no remap is needed
    if (fs.existsSync(oldPath)) {
      return { error: 'Project path now exists — remap no longer needed' };
    }

    // Validate the new path exists and is a directory
    let stat;
    try { stat = fs.lstatSync(newPath); } catch { return { error: 'Path does not exist' }; }
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Find the session folder for the old project path using the same encoding the CLI uses
    const folder = encodeProjectPath(oldPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) return { error: 'No session data found for this project' };

    const refusal = remapProjectRefusal(oldPath);
    if (refusal) return { error: refusal };

    // Rewrite cwd in all session JSONL files (top-level + subagents) so
    // `claude --resume` from CLI also picks up the new path.
    await writer.remapProjectTranscripts({ folder, folderPath, oldPath, newPath });

    // Refresh the folder cache so the new path takes effect in the UI
    await writer.refreshFolder(folder);
    notifyRendererProjectsChanged('project-remap');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: delete-worktree ---
const worktreeDelete = require('./worktree-delete');
// Validated path pattern: <project>/.<segment>/[worktrees/]<name>
// Matches .claude/worktrees/<n>, .claude-worktrees/<n>, .worktrees/<n>
const WORKTREE_PATH_RE = /^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/([^/]+)\/?$/;

// WORKTREE_PATH_RE only checks *shape* (a string that looks like
// <something>/.claude/worktrees/<name>) — match[1] can be any string with
// that suffix stripped, including a directory this install has never heard
// of. Bind it to a project root Switchboard actually knows about before
// letting `git -C <parentRepo> worktree remove` run against it.
function isKnownProjectRoot(candidatePath) {
  return _isKnownProjectRoot(candidatePath, [...getKnownProjectPaths()]);
}

function checkDeleteWorktree(worktreePath) {
  if (typeof worktreePath !== 'string') return { ok: false, error: 'Invalid arguments' };
  const normalizedPath = worktreePath.replace(/\/$/, '');
  const match = normalizedPath.match(WORKTREE_PATH_RE);
  if (!match) return { ok: false, error: 'Path does not match a recognized worktree layout' };
  const parentRepo = match[1];
  if (!isKnownProjectRoot(parentRepo)) return { ok: false, error: 'Parent repository is not a known project' };
  return { ok: true, normalizedPath, parentRepo };
}

ipcMain.handle('check-delete-worktree', (_event, worktreePath) => {
  const result = checkDeleteWorktree(worktreePath);
  return result.ok ? { ok: true } : result;
});

function worktreeGit(args, consume) {
  if (consume) return worktreeDelete.streamGit(args, consume, { spawn: spawnChild, env: localGitEnv() });
  return new Promise((resolve, reject) => {
    execFile('git', args, { env: localGitEnv(), timeout: args.includes('remove') ? 120000 : 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error((stderr || err.message || String(err)).trim()), { code: err.code, killed: err.killed, signal: err.signal }));
      else resolve(stdout);
    });
  });
}

async function worktreeDeletionStatus(normalizedPath, parentRepo) {
  const status = await worktreeDelete.readStatus(normalizedPath, parentRepo, worktreeGit);
  return { ...status, homeDir: os.homedir(),
    sessions: await worktreeDelete.runningSessions(normalizedPath, activeSessions, cliSessionState.getSidebarDescriptors()) };
}

ipcMain.handle('delete-worktree', async (_event, worktreePath, shown) => {
  const check = checkDeleteWorktree(worktreePath);
  if (!check.ok) return check;
  const { normalizedPath, parentRepo } = check;
  try {
    const result = await worktreeDelete.removeWorktree(normalizedPath, parentRepo, shown,
      () => worktreeDeletionStatus(normalizedPath, parentRepo), worktreeGit);
    if (!result.ok) return result;
    const removed = await writer.cleanupWorktree(normalizedPath, log);
    log.info(`[delete-worktree] removed=${normalizedPath} sessions=${removed}`);
    notifyRendererProjectsChanged('worktree-deleted');
    return { ok: true, removed };
  } catch (error) {
    return { ok: false, error: `${error.message} Review the folder and try Delete again; Cancel keeps it on disk.` };
  }
});

// --- IPC: worktree-status ---
ipcMain.handle('worktree-status', async (_event, worktreePath) => {
  const check = checkDeleteWorktree(worktreePath);
  if (!check.ok) return check;
  try {
    return await worktreeDeletionStatus(check.normalizedPath, check.parentRepo);
  } catch (error) {
    return { ok: false, error: `${error.message} Review the folder and try Delete again; Cancel keeps it on disk.` };
  }
});

// --- IPC: get-projects ---
ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});

ipcMain.on('main-error-notices-ready', event => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || event.sender !== mainWindow.webContents) return;
  mainErrorWindowReady = true;
  mainErrorHandlers.flushNotices();
});

ipcMain.handle('open-main-log', async () => {
  try {
    const filePath = log.transports.file.getFile().path;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || isSensitivePath(filePath)) {
      return { ok: false, error: 'Application log path is unavailable or blocked' };
    }
    const error = await shell.openPath(path.resolve(filePath));
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

// --- IPC: open a local file in the OS default app (terminal right-click menu) ---
ipcMain.handle('open-path', (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return;
  const resolved = path.resolve(filePath);
  // Mirror the read/save-file-for-panel guard: never hand a sensitive path
  // (~/.ssh, credentials, etc.) to the OS default opener.
  if (isSensitivePath(resolved)) return;
  return shell.openPath(resolved);
});

// --- IPC: read clipboard (terminal right-click paste; see clipboard-write-text) ---
ipcMain.handle('read-clipboard', () => clipboard.readText());

// --- IPC: clipboard write ---
// The renderer's navigator.clipboard.writeText is gated on focus/user-activation and
// is flaky-to-dead on Linux/Wayland (Ozone). The main-process clipboard has no such
// strings attached, so all terminal copies go through here.
ipcMain.handle('clipboard-write-text', (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

ipcMain.handle('popup-app-menu', (_event, position) => {
  const menu = Menu.getApplicationMenu();
  if (!menu || !mainWindow || mainWindow.isDestroyed()) return false;
  const { x, y } = menuPopupPoint(position, mainWindow.webContents.getZoomFactor());
  menu.popup({ window: mainWindow, x, y });
  return true;
});

ipcMain.handle('toggle-full-screen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});

// --- IPC: does the clipboard hold an image? ---
// A terminal is a text stream, so an image can't ride a text paste. When one is on
// the clipboard the renderer forwards Ctrl+V (0x16) to the PTY instead of doing a
// text paste, so the child — e.g. Claude Code — runs its own native clipboard paste
// and reads the image straight off the system clipboard (the same thing a regular
// terminal does). This just reports whether to take that path.
ipcMain.handle('clipboard-has-image', () => !clipboard.readImage().isEmpty());

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

ipcMain.handle('read-file-for-panel', async (_event, filePath, opts) => {
  try {
    if (opts?.sessionId !== undefined) {
      const target = resolveGitChangesTarget(opts.sessionId);
      if (!target.ok) return target;
      if (target.kind !== 'remote') return { ok: false, error: 'invalid remote session' };
      return await readRemoteTouchedFile({ target, absolutePath: filePath });
    }
    const resolved = path.resolve(filePath);
    if (gitChangesFile.hasGitSegment(filePath) || gitChangesFile.hasGitSegment(fs.realpathSync.native(resolved))) {
      return { ok: false, error: 'the git directory is not editable', reason: 'git-dir' };
    }
    if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
    // A file link in terminal output decides this path, so the size is not
    // ours -- see .ai/contexts/viewer-panel.md, "Bounds".
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: 'not a regular file' };
    if (stat.size > PANEL_FILE_MAX_BYTES) {
      return { ok: false, error: 'file too large to display' };
    }
    const buf = fs.readFileSync(resolved);
    if (buf.includes(0)) return { ok: false, error: 'binary file' };
    const content = gitChangesFile.decodeUtf8(buf);
    if (content === null) return { ok: false, error: 'file is not valid UTF-8', reason: 'encoding' };
    if (opts?.editor) {
      const pair = await gitChangesFile.readTouchedChangesFile({ absolutePath: resolved, maxBytes: PANEL_FILE_MAX_BYTES });
      if (!pair.ok || pair.git) return pair;
      const current = gitChangesFile.toLf(content);
      return { ok: true, git: false, original: current, current, version: gitChangesFile.versionOf(buf), readOnly: !!pair.readOnly };
    }
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

// see .ai/contexts/viewer-panel.md ("Saving over a file that moved")
const panelSaves = createMainPanelSaves({
  getKnownProjectPaths,
  invalidateFtsSignature,
  onError: (err) => console.error('Error saving memory file:', err),
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content, expected, opts) => {
  try {
    if (opts?.sessionId !== undefined) {
      const target = resolveGitChangesTarget(opts.sessionId);
      if (!target.ok) return target;
      if (target.kind === 'remote') return { ok: false, reason: 'remote', error: 'remote files are read-only' };
    }
    if (gitChangesFile.hasGitSegment(filePath) || gitChangesFile.hasGitSegment(fs.realpathSync.native(filePath))) {
      return { ok: false, error: 'the git directory is not editable', reason: 'git-dir' };
    }
    if (fs.lstatSync(filePath).isSymbolicLink()) return { ok: false, error: 'symbolic links are read-only', reason: 'symlink' };
    if (isSensitivePath(path.resolve(filePath))) return { ok: false, error: 'access to sensitive path denied' };
    if (gitChangesFile.decodeUtf8(fs.readFileSync(filePath)) === null) return { ok: false, error: 'file is not valid UTF-8', reason: 'encoding' };
    if (!opts?.git) return panelSaves.saveFileForPanel(filePath, content, expected, { version: opts?.version });
    const result = await gitChangesFile.writeTouchedChangesFile({ absolutePath: filePath, content, version: opts.version, maxBytes: PANEL_FILE_MAX_BYTES });
    if (!result.ok) return result;
    if (/[\\/]\.work-files[\\/]/.test(result.savedPath)) invalidateFtsSignature('work-file', result.savedPath);
    if (result.savedPath.endsWith('.md')) invalidateFtsSignature('memory', result.savedPath);
    return { ok: true, version: result.version };
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'File does not exist' : err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
const fileWatchers = createViewerWatchRegistry({
  send: (resolved) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-changed', resolved);
    }
  },
});

function closeAllFileWatchers() {
  fileWatchers.closeAll();
}

ipcMain.handle('watch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
  return fileWatchers.watch(resolved);
});

ipcMain.handle('unwatch-file', (_event, filePath) => {
  return fileWatchers.unwatch(path.resolve(filePath));
});

// Full re-scan triggered from the UI. Re-reads every jsonl file in the worker
// thread, which is the only path that rebuilds search_fts with the live tail
// of active sessions (refreshFolder uses a header-only read by design — see
// session-cache.js). Concurrent callers share the same in-flight worker via
// populateCacheViaWorker's internal Promise.
ipcMain.handle('rebuild-cache', async () => {
  try {
    await populateCacheViaWorker({ force: true });
    return { ok: true };
  } catch (err) {
    console.error('Error rebuilding cache:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-indexing-state', () => ({ finished: isIndexingFinished() }));

ipcMain.handle('get-projects', async (_event, showArchived) => {
  const started = TRACE.on ? performance.now() : null;
  try {
    const repairFolders = getSetting('bridge_uuid_reindex_folders');
    let repairPending = false;
    if (Array.isArray(repairFolders) && repairFolders.length) {
      const aliases = new Set(normalizeHosts((getSetting('global') || {}).remoteHosts).map(host => host.alias));
      const declared = repairFolders.filter(key => {
        const { alias } = parseFolderKey(key);
        if (alias === null) { repairPending = true; return true; }
        return aliases.has(alias);
      });
      if (declared.length !== repairFolders.length) await writer.completeRepairFolders(repairFolders.filter(folder => !declared.includes(folder)));
    }
    const needsPopulate = !isInitialScanComplete() || (!repairPending && (!isCachePopulated() || !isSearchIndexPopulated()));

    if (needsPopulate) populateCacheViaWorker();
    backfillEntrypoints();
    backfillCustomTitles();
    const result = await projectsClient.request({ reconcile: !needsPopulate && Date.now() - projectsReconciledAt >= 5000, measureBytes: TRACE.on });
    const projection = result.projection ? structuredClone(result.projection) : undefined;
    const assemble = async (projects, archived) => {
      const merged = mergePlaceholderSessions(projects);
      const kept = await writer.applyAndPersistArchived(merged, archived);
      if (projection) {
        const hidden = (getSetting('global') || {}).hiddenProjects || [];
        for (const project of merged) {
          if (kept.some(p => p.projectPath === project.projectPath && (p.remoteAlias || null) === (project.remoteAlias || null))) continue;
          const filterReason = hidden.includes(project.projectPath) || hidden.includes(project.remoteAlias + '::' + project.projectPath)
            ? 'hidden-project' : 'archived';
          for (const row of project.sessions) {
            const facts = row.projectionFacts;
            if (facts) projection.removedInputs[facts.scope + '|' + facts.rootId] = { ...facts.inputs, filterReason };
          }
        }
      }
      return annotateRemoteAttachable(kept);
    };
    const reply = showArchived === 'both'
      ? { defaultProjects: await assemble(result.defaultProjects, false), allProjects: await assemble(result.allProjects, true), projection }
      : await assemble(showArchived ? result.allProjects : result.defaultProjects, !!showArchived);
    if (TRACE.on) {
      if (started !== null) trace('ipc.get-projects', null, { totalMs: performance.now() - started, rows: result.rows, replyBytes: result.replyBytes?.[showArchived === 'both' ? 'both' : showArchived ? 'all' : 'default'] ?? null });
    }
    return reply;
  } catch (err) {
    if (err.code === 'PROJECTS_SNAPSHOT_CONFLICT') {
      notifyRendererProjectsChanged('conflict');
      return { projectsError: { code: err.code, message: 'Projects changed while loading; reload to retry.' } };
    }
    console.error('Error listing projects:', err);
    throw err;
  }
});

// --- IPC: get-stats-from-db ---
// Builds a stats object from session_cache so the heatmap reflects real usage
// including subagent sessions (which claude /stats silently ignores) and
// periods where Claude already rotated the parent JSONL files off disk.
ipcMain.handle('get-stats-from-db', () => {
  try {
    return buildStatsFromDb();
  } catch (err) {
    log.error('Error building stats from DB:', err);
    return null;
  }
});

// Build the full stats object the renderer consumes. Sourced from
// session_metrics (per-(session,date,model) tokens/tool-calls/messages bucketed
// by message timestamp) so tokens, tool calls, and per-model usage are all real
// data — not the hardcoded {} the heatmap-only path used to return.
function buildStatsFromDb() {
  const daily = getDailyMetrics();       // [{date, messageCount, toolCallCount, tokens, sessionCount}]
  const totals = getTotalCounts();
  const lastComputedDate = new Date().toISOString().slice(0, 10);
  return {
    dailyActivity: daily,
    dailyModelTokens: getDailyModelTokens(),
    modelUsage: getModelUsage(),
    totalMessages: totals.totalMessages,
    totalSessions: totals.totalSessions,
    totalToolCalls: totals.totalToolCalls,
    totalTokens: totals.totalTokens,
    firstSessionDate: daily[0]?.date || lastComputedDate,
    lastComputedDate,
  };
}

// --- IPC: refresh-stats (fetch /usage + build stats from DB; /stats PTY removed) ---
ipcMain.handle('refresh-stats', async () => {
  try {
    // /stats PTY call removed — heatmap is now sourced from session_cache via
    // get-stats-from-db. Only /usage is fetched here (rate-limits panel).
    const usage = await fetchAndTransformUsage().catch(() => ({}));

    // Build stats from DB (same as get-stats-from-db) so the caller gets both
    // at once and the renderer can update heatmap + usage in a single round-trip.
    let stats = null;
    try {
      stats = buildStatsFromDb();
    } catch (dbErr) {
      log.error('Error building stats from DB in refresh-stats:', dbErr);
    }

    return { stats, usage: usage || {} };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: {} };
  }
});

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  try {
    return await fetchAndTransformUsage() || {};
  } catch (err) {
    log.error('Error fetching usage:', err);
    return {};
  }
});

// see .ai/contexts/viewer-panel.md (File list workers)
const { createFileListsWorkerClient } = require('./file-lists-worker-client');
const fileListStates = new Map();
const { fileListPathKey } = require('./file-lists-path');
const FILE_LIST_INDEX_MAX_ENTRIES = 50;
const FILE_LIST_INDEX_MAX_BODY_BYTES = 128 * 1024;
const FILE_LIST_MAX_INVALIDATED_PATHS = 256;
for (const kind of ['memory', 'work-file']) {
  fileListStates.set(kind, { epoch: 0, indexed: null, targets: new Map(), paths: new Map(), invalidated: new Set(), invalidateAll: false });
}

function publishFileListPaths(state, ids) {
  state.paths = new Map();
  for (const id of ids) {
    for (const key of [fileListPathKey(id, process.platform), state.targets.get(id)].filter(Boolean)) {
      if (!state.paths.has(key)) state.paths.set(key, new Set());
      state.paths.get(key).add(id);
    }
  }
}

function invalidateFtsSignature(kind, filePath) {
  const state = fileListStates.get(kind);
  if (!state) return;
  const key = filePath ? fileListPathKey(filePath, process.platform) : null;
  const matching = state.paths.get(key) || new Set();
  if (key && matching.size === 0) {
    if (kind === 'work-file') {
      if (!key.includes('/.work-files/')) return;
    } else {
      const root = fileListPathKey(CLAUDE_DIR, process.platform);
      const names = process.platform === 'win32' ? ['claude.md', 'gemini.md', 'agents.md'] : ['CLAUDE.md', 'GEMINI.md', 'agents.md'];
      if (!key.endsWith('.md') || !(key.startsWith(root + '/') || key.includes('/.claude/') || names.includes(key.slice(key.lastIndexOf('/') + 1)))) return;
    }
  }
  state.epoch++;
  if (key && state.indexed && !state.invalidateAll) {
    state.invalidated.add(key);
    if (state.invalidated.size > FILE_LIST_MAX_INVALIDATED_PATHS) {
      state.invalidated.clear();
      state.invalidateAll = true;
    }
  } else if (!key || !state.indexed) {
    state.invalidated.clear();
    state.invalidateAll = true;
  }
  if (!state.indexed) return;
  if (key) for (const id of matching) {
    if (state.indexed.has(id)) state.indexed.set(id, null);
  }
  else for (const file of state.indexed.keys()) state.indexed.set(file, null);
}

function fileListsPolicy(kind) {
  const state = fileListStates.get(kind);
  const hiddenProjects = (getSetting('global') || {}).hiddenProjects || [];
  const activeProjectPaths = kind === 'memory' ? [...activeSessions.values()].map(session => session.projectPath).filter(Boolean) : [];
  return {
    hiddenProjects, activeProjectPaths,
    version: JSON.stringify([state.epoch, hiddenProjects, activeProjectPaths]),
  };
}

function fileListsSnapshot(kind) {
  const state = fileListStates.get(kind);
  if (!state.indexed) {
    state.indexed = new Map(getSearchFileIds(kind).map(id => [id, null]));
    publishFileListPaths(state, state.indexed.keys());
  }
  return {
    ...fileListsPolicy(kind), kind, epoch: state.epoch, indexed: [...state.indexed],
    invalidated: [...state.invalidated], invalidateAll: state.invalidateAll,
  };
}

async function applyFileListIndex(kind, result, valid) {
  if (!valid()) return false;
  const state = fileListStates.get(kind);
  const signatures = new Map(result.manifest);
  const upserts = new Map(result.upserts.map(entry => [entry.id, entry]));
  for (const [id, signature] of signatures) {
    if (state.indexed.get(id) !== signature && !upserts.has(id)) return false;
  }
  if (kind === 'memory') state.targets = new Map(result.manifest.map(([id, signature]) => [id, fileListPathKey(JSON.parse(JSON.parse(signature)[0])[2], process.platform)]));
  publishFileListPaths(state, new Set([...state.indexed.keys(), ...signatures.keys()]));
  const removed = [...new Set([...result.deletes, ...state.indexed.keys()])].filter(id => !signatures.has(id));
  const changes = [...removed.map(id => ({ id })), ...result.upserts.map(entry => ({ entry }))];
  for (let offset = 0; offset < changes.length;) {
    if (!valid()) return false;
    const batch = [];
    let bodyBytes = 0;
    while (offset < changes.length && batch.length < FILE_LIST_INDEX_MAX_ENTRIES) {
      let change = changes[offset];
      let bytes = change.entry ? Buffer.byteLength(change.entry.body || '', 'utf8') : 0;
      if (bytes > FILE_LIST_INDEX_MAX_BODY_BYTES) {
        const buffer = Buffer.from(change.entry.body, 'utf8');
        let end = FILE_LIST_INDEX_MAX_BODY_BYTES;
        while ((buffer[end] & 0xc0) === 0x80) end--;
        change = { entry: { ...change.entry, body: buffer.toString('utf8', 0, end) } };
        bytes = end;
      }
      if (bodyBytes + bytes > FILE_LIST_INDEX_MAX_BODY_BYTES) break;
      batch.push(change);
      bodyBytes += bytes;
      offset++;
    }
    const deletes = batch.filter(change => !change.entry).map(change => change.id);
    const entries = batch.filter(change => change.entry).map(change => change.entry);
    await applySearchFileBatch(kind, deletes, entries);
    for (const id of deletes) {
      state.indexed.delete(id);
      for (const key of [fileListPathKey(id, process.platform), state.targets.get(id)].filter(Boolean)) {
        const ids = state.paths.get(key);
        ids?.delete(id);
        if (ids?.size === 0) state.paths.delete(key);
      }
      state.targets.delete(id);
    }
    for (const entry of entries) state.indexed.set(entry.id, signatures.get(entry.id));
    await new Promise(resolve => setImmediate(resolve));
  }
  if (!valid()) return false;
  state.invalidated.clear();
  state.invalidateAll = false;
  return true;
}

const fileListClients = new Map(['memory', 'work-file'].map(kind => [kind, createFileListsWorkerClient({
  workerFactory: () => new Worker(path.join(__dirname, 'workers', 'file-lists-query.js'), { workerData: { claudeDir: CLAUDE_DIR, projectsDir: PROJECTS_DIR } }),
  snapshot: () => fileListsSnapshot(kind),
  getVersion: () => fileListsPolicy(kind).version,
  apply: async (result, valid) => await applyFileListIndex(kind, result, valid),
  onError: error => log.error(`Error indexing ${kind} files:`, error),
})]));
const fileListsClient = {
  request: ({ kind }) => fileListClients.get(kind).request(),
  shutdown: () => Promise.all([...fileListClients.values()].map(client => client.shutdown())),
};

// --- IPC: get-memories ---
ipcMain.handle('get-memories', async () => {
  const started = TRACE.on ? performance.now() : null;
  const result = await fileListsClient.request({ kind: 'memory' });
  if (TRACE.on) {
    if (started !== null) trace('ipc.get-memories', null, { totalMs: performance.now() - started, entries: result.entries });
  }
  return result.view;
});

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  try {
    const literal = path.resolve(filePath);
    if (!literal.endsWith('.md')) return '';
    // Read on the guard's own resolved path, not on `literal` again — see
    // resolveAllowedMemoryPath's contract.
    const resolved = resolveAllowedMemoryPath(literal);
    if (!resolved) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content, expected) => panelSaves.saveMemory(filePath, content, expected));

// --- IPC: get-work-files ---
ipcMain.handle('get-work-files', async () => {
  const started = TRACE.on ? performance.now() : null;
  const result = await fileListsClient.request({ kind: 'work-file' });
  if (TRACE.on) {
    if (started !== null) trace('ipc.get-work-files', null, { totalMs: performance.now() - started, entries: result.entries });
  }
  return result.view;
});

// --- IPC: read-work-file ---
ipcMain.handle('read-work-file', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    // Security: path must contain /.work-files/ segment
    if (!resolved.includes('/.work-files/') && !resolved.includes('\\.work-files\\')) {
      return '[access denied]';
    }
    if (!fs.existsSync(resolved)) return '';
    const stat = fs.statSync(resolved);
    if (stat.size > 2 * 1024 * 1024) return '[file too large to display]';
    // Detect binary: try reading as utf8; if it fails or contains null bytes, treat as binary
    const buf = fs.readFileSync(resolved);
    if (buf.includes(0)) return '[binary file]';
    return buf.toString('utf8');
  } catch (err) {
    console.error('Error reading work file:', err);
    return '';
  }
});

// --- IPC: delete-work-file ---
ipcMain.handle('delete-work-file', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.includes('/.work-files/') && !resolved.includes('\\.work-files\\')) {
      return { ok: false, error: 'access denied' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: 'not found' };
    fs.unlinkSync(resolved);
    invalidateFtsSignature('work-file', resolved);
    return { ok: true };
  } catch (err) {
    console.error('Error deleting work file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: search ---
// Routed through the search-query worker so that slow FTS5 phrase queries
// (e.g. a 60-char pasted URL) do not block the Electron main event loop.
// The renderer already awaits window.api.search(...) — this change is transparent.
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchViaWorker(type, query, titleOnly);
});

// --- IPC: settings ---
function applyUpdateChannel() {
  if (!autoUpdater) return;
  const settings = getSetting('global') || {};
  const beta = settings.receiveBetaVersions ?? SETTING_DEFAULTS.receiveBetaVersions;
  if (applyUpdateChannel.logged && autoUpdater.allowPrerelease === beta) return;
  autoUpdater.allowPrerelease = beta;
  applyUpdateChannel.logged = true;
  log.info(`[updater] channel: ${beta ? 'beta' : 'stable'}`);
}

ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('get-settings-by-prefix', (_event, prefix) => {
  if (prefix !== 'continuationChoice:') throw new TypeError('Invalid settings prefix');
  return Object.fromEntries(listSettingKeys(prefix).map(key => [key, getSetting(key)]));
});

ipcMain.handle('set-setting', async (_event, key, value) => {
  await setSetting(key, value);
  if (key === 'global') applyUpdateChannel();
  return { ok: true };
});

// --- IPC: remote hosts ---
// Re-reads the declared hosts and pulls straight away, so a host added in
// Settings shows up without waiting a full refresh interval.
ipcMain.handle('remote-hosts-apply', () => {
  try {
    const running = remoteIndexer.restart();
    syncRemoteWatchers();
    return { ok: true, running };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// see .ai/contexts/session-cache.md ("Remote hosts backoff" — manual reconnect, issue #252)
ipcMain.handle('remote-hosts-refresh', async () => {
  try {
    const result = await remoteIndexer.refreshNow({ force: true });
    for (const host of enabledHosts((getSetting('global') || {}).remoteHosts)) {
      restartWatcherForAlias(host.alias);
    }
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// see .ai/contexts/session-cache.md ("Remote hosts — enrolment")
ipcMain.handle('remote-host-enrol-check', (_event, alias) => handleEnrolRequest({ alias }, {
  getHosts: () => (getSetting('global') || {}).remoteHosts,
  isDeclared: (a) => normalizeHosts((getSetting('global') || {}).remoteHosts).some(h => h.alias === a),
  transport: remoteTransport,
}));

ipcMain.handle('remote-host-refresh', async (_event, alias) => {
  try {
    const result = await remoteIndexer.refreshHostNow(alias, { force: true });
    restartWatcherForAlias(alias);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('delete-setting', async (_event, key) => {
  await deleteSetting(key);
  return { ok: true };
});

// --- Scheduled tasks ---
const scheduleIpc = require('./schedule-ipc');

ipcMain.handle('get-shell-profiles', () => {
  // TODO(lint): `_shellProfiles` is scoped inside shell-profiles.js and not
  // reachable from here — this line is a no-op left over from a refactor.
  // Kept as-is for now; tracked separately. See tests/eslint-and-renderer-coverage.
  // eslint-disable-next-line no-undef
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

ipcMain.handle('get-effective-settings', (_event, projectPath) => {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    // Only `undefined` (key never saved at this scope) falls through to the
    // next-broader scope. An explicit `null` — e.g. permissionMode's "Default"
    // choice, which settings-panel.js persists as `value || null` — is a real,
    // deliberate value and must win.
    //
    // This previously also skipped on `!== null`, which made an explicitly
    // saved "Default" indistinguishable from "never configured". Two
    // consequences: a project that narrowed permissionMode back to Default
    // silently kept inheriting the global mode, and any SETTING_DEFAULTS value
    // other than null was unreachable at project scope.
    if (global[key] !== undefined) {
      effective[key] = global[key];
    }
    if (project[key] !== undefined) {
      effective[key] = project[key];
    }
  }
  return effective;
});

// --- IPC: get-active-sessions ---
// see .ai/contexts/ipc-bridge.md "Busy-state reconciliation"
ipcMain.handle('get-active-sessions', () => {
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) active.push({ sessionId, busy: !!session._cliBusy });
  }
  if (TRACE.on) trace('poll.snapshot', null, { count: active.length, entries: active });
  return active;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    // see .ai/contexts/panel-terminal.md
    if (!session.exited && session.isPlainTerminal && !isPanelShellSession(session)) {
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
const { sendToBackground, respawnRoute, createContinuationReader, holdBackgroundExit, cancellationIn } = require('./bg-handoff');

const backgroundHandoffs = new WeakMap();

function readBackgroundHandoffStamp(context) {
  return require('./session-continuations').continuationStamp(fs.statSync(
    path.join(PROJECTS_DIR, context.projectFolder, context.sourceId + '.jsonl'), { bigint: true }));
}

function persistBackgroundHandoff(context) {
  let attempts = backgroundHandoffs.get(context.session);
  if (!attempts) backgroundHandoffs.set(context.session, attempts = new Map());
  const key = JSON.stringify([context.sourceId, context.targetId, context.jobId].map(id => id?.toLowerCase()));
  let state = attempts.get(key);
  if (!state) {
    state = { context: { ...context }, running: null, successful: null, dirty: false, force: false };
    attempts.set(key, state);
    if (context.exitDrain) Promise.resolve(context.exitDrain).then(() => request(true), error => {
      log.warn(`[bg-handoff] ${state.context.sourceId} exit-drain: ${error.message}`, error);
    });
  }
  return request(false);

  function request(force) {
    let stamp;
    try { stamp = JSON.stringify(readBackgroundHandoffStamp(state.context)); }
    catch (error) { log.warn(`[bg-handoff] ${state.context.sourceId} stat: ${error.message}`, error); return Promise.resolve(); }
    if (force) state.force = true;
    if (state.running) {
      if (stamp !== state.start) state.dirty = true;
      return state.running;
    }
    state.running = run().finally(() => { state.running = null; });
    return state.running;
  }

  async function run() {
    do {
      const forced = state.force;
      state.force = false;
      state.dirty = false;
      let stage = 'stat';
      try {
        state.start = JSON.stringify(readBackgroundHandoffStamp(state.context));
        if (!forced && state.start === state.successful) continue;
        stage = 'resolve';
        await sessionCache.resolveSessionContinuations(state.context.sourceId, {
          getSessionLiveElsewhere: id => cliSessionState.liveElsewhereChecked(id, sessionHasPty, ptyPids),
        });
        stage = 'refresh';
        await writer.refreshFolder(state.context.projectFolder, { files: new Set([state.context.sourceId + '.jsonl']) });
        state.successful = state.start;
        notifyRendererProjectsChanged('background-handoff');
      } catch (error) {
        log.warn(`[bg-handoff] ${state.context.sourceId} ${stage}: ${error.message}`, error);
      }
    } while (state.dirty || state.force);
  }
}

async function handleSendToBackground(_event, sessionId) {
  const session = activeSessions.get(sessionId);
  const oldId = session?.realSessionId || sessionId;
  const projectFolder = session?.projectFolder, exitDrain = session?.exitDrain;
  const read = session?.projectFolder
    ? createContinuationReader(path.join(PROJECTS_DIR, session.projectFolder, oldId + '.jsonl'), oldId)
    : async () => null;
  const result = await sendToBackground(sessionId, {
    getSession: id => activeSessions.get(id),
    getStatus: id => cliSessionState.getStatus(id)?.status,
    write: (entry, text) => writePty(entry, text, sessionId),
    tapOutput: (entry, fn) => { const listener = entry.pty.onData(fn); return () => listener.dispose(); },
    readContinuationIds: read,
    readDescriptors: () => cliSessionState.readAllDescriptors(),
    onConfirmed: () => { if (session?.projectFolder) detectSessionTransitions(session.projectFolder); },
    now: Date.now,
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
    waitForChange: ms => new Promise(resolve => {
      let timer;
      const unsubscribe = cliSessionState.onDescriptorsChanged(() => { clearTimeout(timer); unsubscribe(); resolve(); });
      timer = setTimeout(() => { unsubscribe(); resolve(); }, ms);
    }),
    notify: message => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bg-handoff-notice', sessionId, message);
    },
    schedule: (fn, ms) => { const timer = setTimeout(fn, ms); if (typeof timer.unref === 'function') timer.unref(); },
    kill: entry => killPty(entry, sessionId),
    decideRoute: async (id, entry) => {
      const lookup = bgAgents.findRestoreJob(id, undefined, { ignoreUnrelatedInvalid: true });
      if (!lookup.known || !lookup.job) return respawnRoute({ oldId: id, lookup });
      const check = await bgAgents.conversationCheck(lookup.job.id, { workerLiveness: 'all' });
      if (!check.known) return respawnRoute({ oldId: id, lookup, check });
      let owned = { known: true, job: null };
      for (const sid of new Set([id, ...check.sessionIds].map(s => s.toLowerCase()))) {
        owned = bgAgents.liveJobCheck(sid, { workerLiveness: new Map([[lookup.job.id, check.workerLiveness]]) });
        if (!owned.known || owned.job) break;
      }
      const elsewhere = [];
      const elsewhereIds = new Set([id, lookup.job.resumeTarget, ...check.sessionIds].filter(Boolean).map(s => s.toLowerCase()));
      for (const sid of elsewhereIds) elsewhere.push(await cliSessionState.liveElsewhereChecked(sid, () => false, () => [entry.pty.pid]));
      return respawnRoute({ oldId: id, lookup, check, owned, elsewhere });
    },
    respawnJob: job => unsubscribeBgAgents.respawnForHandoff(job, [oldId, job.resumeTarget].filter(Boolean)),
  });
  if (result.ok && !result.respawned && session?.projectFolder) detectSessionTransitions(session.projectFolder);
  if (result.ok && !result.respawned) {
    persistBackgroundHandoff({ session, sourceKey: sessionId, sourceId: oldId,
      targetId: result.sessionId, jobId: result.jobId, projectFolder, exitDrain });
  }
  return result;
}
ipcMain.handle('send-session-to-background', handleSendToBackground);

async function runExitBackgroundBatch(ids, opts) {
  return runExitHandoffs(ids, {
    ...opts,
    send: id => handleSendToBackground(null, id),
    status: id => {
      const record = activeSessions.get(id);
      return record && cliSessionState.getStatus(record.realSessionId || id)?.status;
    },
    now: Date.now,
    waitForChange: (ms, signal) => new Promise(resolve => {
      if (signal.aborted) { resolve(); return; }
      let timer;
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const unsubscribe = cliSessionState.onDescriptorsChanged(done);
      timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    }),
  });
}
runExitBackground = runExitBackgroundBatch;

ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  // see .ai/contexts/bg-agents.md ("Detach")
  if (session.isAttach) {
    if (session.stopRequested) return { ok: true, detached: true };
    session.stopRequested = true;
    detachPty(session, sessionId);
    return { ok: true, detached: true };
  }
  session.stopRequested = true;
  killPty(session, sessionId);
  return { ok: true };
});

const REMOTE_STOP_SYNC_TIMEOUT_MS = 20000;

// --- IPC: remote-stop-session ---
// see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
ipcMain.handle('remote-stop-session', async (_event, payload) => {
  const alias = payload && payload.alias;
  const sessionId = payload && payload.sessionId;
  if (typeof alias !== 'string' || !alias || typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, error: 'invalid request' };
  }
  let remote = remoteIndexer.getRemoteSessions(alias);
  let descriptor = remote.sessions.find(s => s.sessionId === sessionId);
  if (!descriptor && !remote.at) {
    let timer;
    let abandoned = false;
    const attemptsBefore = remoteIndexer.getRemoteHostState(alias).attempts;
    const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), REMOTE_STOP_SYNC_TIMEOUT_MS); });
    const sync = (async () => {
      for (;;) {
        if (remoteIndexer.getRemoteSessions(alias).at || remoteIndexer.getRemoteHostState(alias).attempts > attemptsBefore) return { skipped: false };
        const attempt = await remoteIndexer.refreshHostNow(alias, { force: true });
        if (!(attempt.skipped && attempt.reason === 'in-flight') || abandoned) return attempt;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const refreshed = await Promise.race([sync, timedOut]).finally(() => { abandoned = true; clearTimeout(timer); });
    if (refreshed && (refreshed.reason === 'stopped' || refreshed.reason === 'unknown-host')) {
      return { ok: false, error: 'session not found on that host' };
    }
    remote = remoteIndexer.getRemoteSessions(alias);
    if (!remote.at) {
      const state = remoteIndexer.getRemoteHostState(alias);
      const newError = state.attempts > attemptsBefore && state.lastError;
      if (newError && !state.lastErrorTransport) {
        return { ok: false, error: `${state.lastError}. Archive cannot check this session on ${remoteHostLabel(alias, (getSetting('global') || {}).remoteHosts)} until that is resolved; remove the host in Settings to archive without checking.` };
      }
      if (refreshed && refreshed.timedOut) {
        return { ok: false, hostUnreachable: true, error: `no answer within ${Math.round(REMOTE_STOP_SYNC_TIMEOUT_MS / 1000)}s` };
      }
      return { ok: false, hostUnreachable: true, error: state.attempts > attemptsBefore && state.lastError ? state.lastError : 'not yet synced' };
    }
    descriptor = remote.sessions.find(s => s.sessionId === sessionId);
  }
  if (!descriptor) return { ok: false, error: 'session not found on that host' };

  const result = await remoteStopAdapter.stop(alias, descriptor);
  if (result.ok) {
    remoteIndexer.dropRemoteSession(alias, sessionId);
    // see .ai/contexts/session-state.md ("The two lifecycle verbs: detach and stop")
    notifyRendererProjectsChanged('remote');
    remoteIndexer.refreshHostNow(alias, { force: true }).catch(() => {});
    const attachedSession = activeSessions.get(sessionId);
    if (attachedSession && attachedSession.kind === 'remote-attach' && !attachedSession.exited) {
      attachedSession.stopRequested = true;
      killPty(attachedSession, sessionId);
    }
  }
  return result;
});

// --- IPC: remote-launch-session ---
// see .ai/contexts/session-cache.md ("Remote hosts — launching a session")
ipcMain.handle('remote-launch-session', async (_event, payload) => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  const rawId = payload && payload.sessionId;
  const sessionId = typeof rawId === 'string' ? rawId.toLowerCase() : null;
  if (sessionId && activeSessions.has(sessionId)) return { ok: false, error: 'invalid request' };
  const result = await handleLaunchRequest(payload, {
    hasHost: (alias) => enabledHosts((getSetting('global') || {}).remoteHosts).some(h => h.alias === alias),
    getHosts: () => (getSetting('global') || {}).remoteHosts,
    launchBlockReason: (alias) => launchBlockReason(remoteIndexer.getRemoteHostProfile(alias)),
    adapter: remoteLaunchAdapter,
    attach: (alias, descriptor, size) => remoteAttachAdapter.attach(alias, descriptor, size),
  });
  if (!result.ok) return { ok: false, error: result.error };
  const session = registerRemoteAttachSession(result.descriptor.sessionId, {
    alias: payload.alias, projectPath: result.descriptor.cwd, cwd: result.descriptor.cwd, ptyProcess: result.attachResult.ptyProcess,
    remoteResizeAllowed: result.attachResult.remoteResizeAllowed,
  });
  remoteIndexer.refreshHostNow(payload.alias, { force: true }).catch(() => {});
  return { ok: true, remote: true, remoteResizeAllowed: session.remoteResizeAllowed, generation: session.generation };
});

// --- IPC: remote-send-prompt ---
// see .ai/contexts/session-cache.md ("Remote hosts — sending a prompt")
ipcMain.handle('remote-send-prompt', (_event, payload) => handleSendRequest(payload, {
  getDescriptor: (alias, sessionId) => remoteIndexer.getRemoteSessions(alias).sessions.find(s => s.sessionId === sessionId),
  isAttached: (sessionId) => {
    const attached = activeSessions.get(sessionId);
    return !!(attached && attached.kind === 'remote-attach' && !attached.exited);
  },
  adapter: remoteSendAdapter,
}));

// --- IPC: git-changes-status / git-changes-diff — see .ai/contexts/changes-view.md ---
function gitChangesTargetDeps() {
  return {
    getCachedFolder,
    getCachedSession,
    isRemoteFolder,
    parseFolderKey,
    getRemoteSessions: (alias) => remoteIndexer.getRemoteSessions(alias),
    activeSessions,
    wasRemoteSession: (id) => exitedRemoteSessionIds.has(id),
    resolveSessionRealCwd,
    existsSync: (p) => fs.existsSync(p),
    projectsDir: PROJECTS_DIR,
    readSubagentMeta,
    readSubagentMetaAsync,
    exists: (p) => fs.promises.access(p).then(() => true, () => false),
    gitCommonDir: gitCommonDirOf,
    readDotGit: readDotGitFile,
    listSubagents: (parentId) => getCachedByParent(parentId),
  };
}

async function readSubagentMetaAsync(jsonlPath) {
  try {
    return JSON.parse(await fs.promises.readFile(jsonlPath.replace(/[.]jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function readDotGitFile(worktree) {
  const dotGit = path.join(worktree, '.git');
  try {
    const stat = await fs.promises.lstat(dotGit);
    if (!stat.isFile() || stat.size > 4096) return { file: false, content: '' };
    return { file: true, content: await fs.promises.readFile(dotGit, 'utf8') };
  } catch {
    return null;
  }
}

async function gitCommonDirOf(cwd) {
  const result = await runToExit('git', ['rev-parse', '--git-common-dir'], { cwd, env: localGitEnv(), timeoutMs: 5000, maxBuffer: 65536 });
  if (result.code !== 0) return null;
  const out = result.stdout.toString('utf8').trim();
  return out ? path.resolve(cwd, out) : null;
}

function resolveGitChangesTarget(sessionId, opts) {
  return gitChangesTarget.resolveGitChangesTarget(sessionId, gitChangesTargetDeps(), opts);
}

function gitChangesRunnerFor(target) {
  return target.kind === 'remote'
    ? createGitChangesRunner({ kind: 'remote', cwd: target.cwd, alias: target.alias })
    : createGitChangesRunner({ kind: 'local', cwd: target.cwd, hardened: !!target.subagent });
}

ipcMain.handle('git-changes-status', async (_event, sessionId) => {
  const resolved = resolveGitChangesTarget(sessionId, { allowSubagent: true });
  const target = await gitChangesTarget.checkSubagentRepo(sessionId, resolved, gitChangesTargetDeps());
  if (!target.ok) return target;
  try {
    const result = await gitChangesRunnerFor(resolved).status();
    if (result.ok === false) return result;
    const { worktrees, notScanned } = await gitChangesTarget.listSubagentWorktrees(sessionId, gitChangesTargetDeps());
    if (worktrees.length === 0) return { ...result, kind: resolved.kind };
    const { subagents, omitted } = await gitChangesTarget.collectSubagentChanges(
      worktrees, (cwd) => createGitChangesRunner({ kind: 'local', cwd, hardened: true }));
    if (subagents.length === 0) return { ...result, kind: resolved.kind };
    return { ...result, kind: resolved.kind, subagents, subagentsOmitted: omitted + notScanned };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// filePath is a git pathspec, or an untracked file's --no-index operand — see .ai/contexts/changes-view.md
ipcMain.handle('git-changes-diff', async (_event, sessionId, filePath, staged, untracked) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid path' };
  const resolved = resolveGitChangesTarget(sessionId, { allowSubagent: true });
  const target = await gitChangesTarget.checkSubagentRepo(sessionId, resolved, gitChangesTargetDeps());
  if (!target.ok) return target;
  try {
    return await gitChangesRunnerFor(resolved).diff(filePath, { staged: !!staged, untracked: !!untracked });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// filePath is a repo-relative path, resolved and contained main-side — see .ai/contexts/changes-view.md ("Editing a changed file")
ipcMain.handle('git-changes-file', async (_event, sessionId, filePath, opts) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid path', reason: 'invalid-path' };
  const target = gitChangesFile.requireLocalTarget(resolveGitChangesTarget(sessionId));
  if (!target.ok) return target;
  try {
    return await gitChangesFile.readChangesFile({
      cwd: target.cwd,
      relPath: filePath,
      staged: !!(opts && opts.staged),
      maxBytes: PANEL_FILE_MAX_BYTES,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('git-changes-save', async (_event, sessionId, filePath, content, version) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid path', reason: 'invalid-path' };
  const target = gitChangesFile.requireLocalTarget(resolveGitChangesTarget(sessionId));
  if (!target.ok) return target;
  try {
    const result = await gitChangesFile.writeChangesFile({
      cwd: target.cwd,
      relPath: filePath,
      content,
      version,
      maxBytes: PANEL_FILE_MAX_BYTES,
    });
    if (!result.ok) return result;
    if (result.savedPath.split(/[\\/]/).includes('.work-files')) invalidateFtsSignature('work-file', result.savedPath);
    if (result.savedPath.endsWith('.md')) invalidateFtsSignature('memory', result.savedPath);
    return { ok: true, version: result.version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// see .ai/contexts/changes-view.md ("Saving over a file that moved")
const changesWatchers = createChangesWatchRegistry({
  watchFn: (filePath, handler) => fs.watch(filePath, handler),
  send: (sessionId, relPath) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('git-changes-file-changed', sessionId, relPath);
    }
  },
});

// A path from terminal output is untrusted input — see .ai/contexts/terminal-path-links.md
ipcMain.handle('resolve-terminal-paths', async (_event, sessionId, texts) => {
  if (!Array.isArray(texts)) return [];
  const wanted = texts.slice(0, TERMINAL_PATH_BATCH_MAX);
  const where = terminalPathTarget.resolveTerminalPathsCwd(sessionId, {
    getSession: (id) => activeSessions.get(id),
    resolveTarget: resolveGitChangesTarget,
    resolvePanelCwd: resolvePanelTerminalCwd,
  });
  if (!where.ok) return wanted.map(() => ({ ok: false, reason: where.reason }));
  const deps = {
    isSensitivePath: isSensitivePathAsync,
    stat: (p) => fs.promises.stat(p),
    hasNullByte: terminalPathTarget.fileHasNullByte,
    homedir: () => os.homedir(),
    maxBytes: PANEL_FILE_MAX_BYTES,
  };
  return terminalPathTarget.resolveTerminalPaths(wanted, where.cwd, deps);
});

ipcMain.handle('git-changes-watch', async (_event, sessionId, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid path', reason: 'invalid-path' };
  const target = gitChangesFile.requireLocalTarget(resolveGitChangesTarget(sessionId));
  if (!target.ok) return target;

  const repo = await gitChangesFile.resolveRepoDirs(target.cwd, {});
  if (!repo) return { ok: false, error: 'not a git repository', reason: 'repo' };
  const resolved = gitChangesFile.resolveTargetInsideRepo(repo, filePath, {});
  if (!resolved.ok) return resolved;

  return changesWatchers.watch(sessionId, filePath, resolved.path);
});

ipcMain.handle('git-changes-unwatch', (_event, sessionId, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: true };
  return changesWatchers.unwatch(sessionId, filePath);
});

// see .ai/contexts/touched-files.md
ipcMain.handle('session-touched-files', async (_event, sessionId, options = {}) => {
  try {
    return await listSessionTouchedFiles(sessionId, {
      projectsDir: PROJECTS_DIR,
      dataDir: path.dirname(DB_PATH),
      getCachedFolder,
      isRemoteFolder,
      isSensitive: isSensitivePathAsync,
      diskInfo: options?.diskInfo !== false,
      windowDays: Number.isFinite(options?.windowDays) && options.windowDays >= 1 ? options.windowDays : undefined,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-star', async (_event, sessionId, value) => {
  const starred = await setStarred(getConversationPartIds(sessionId), !!value);
  return { starred };
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', async (_event, sessionId, name) => {
  return await writer.renameSession(getConversationPartIds(sessionId), name);
});

// --- IPC: archive-session ---
ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  const folderDir = projectsDirForFolder(folder);
  if (!folderDir) return { error: 'Session belongs to a host that is no longer declared' };
  const jsonlPath = path.join(folderDir, sessionId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('read-subagent-jsonl', (_event, parentSessionId, agentId) => {
  const row = getCachedSession('sub:' + parentSessionId + ':' + agentId);
  if (!row) return { error: 'Subagent session not found in cache' };
  const jsonlPath = resolveSessionJsonlPath(row);
  if (!jsonlPath) return { error: 'Subagent belongs to a host that is no longer declared' };
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('list-subagents', (_event, parentSessionId) => {
  return getCachedByParent(parentSessionId).map(r => ({
    sessionId: r.sessionId,
    agentId: r.agentId,
    subagentType: r.subagentType,
    description: r.description,
    modified: r.modified,
    messageCount: r.messageCount,
  }));
});

// ── Subagent live-tail watchers ──────────────────────────────────────────────

ipcMain.handle('start-subagent-watch', (_event, parentSessionId, agentId) => {
  const row = getCachedSession('sub:' + parentSessionId + ':' + agentId);
  if (!row) return { error: 'Subagent not found in cache' };
  const filePath = resolveSessionJsonlPath(row);
  if (!filePath) return { error: 'Subagent belongs to a host that is no longer declared' };

  const watchId = ++subagentWatcherSeq;
  let offset = 0;
  // Seek to EOF so we only deliver *new* lines
  try { offset = fs.statSync(filePath).size; } catch {}

  function readNewEntries() {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= offset) return;
      const buf = Buffer.alloc(stat.size - offset);
      const fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      if (bytesRead <= 0) return;
      offset += bytesRead;
      const text = buf.toString('utf8', 0, bytesRead);
      const entries = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
      if (entries.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('subagent-watch-event', { parentSessionId, agentId, entries });
      }
    } catch {}
  }

  // Coalesce rapid JSONL appends into a single incremental read. Mirrors the
  // debounce used by the projects watcher (see startProjectsWatcher) instead of
  // polling stat() once per second per watcher, which pegged the main process at
  // idle when watchers accumulated.
  let debounceTimer = null;
  function scheduleRead() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      readNewEntries();
    }, 300);
  }

  let watcher = null;
  let pollInterval = null;
  try {
    watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType === 'rename') return; // file replaced/removed — ignore
      scheduleRead();
    });
    watcher.on('error', (err) => {
      log.warn(`[subagent-watch] fs.watch error watchId=${watchId}: ${err.message}`);
    });
  } catch (err) {
    // Robustness fallback only when fs.watch can't attach: poll on a long
    // interval (10s) so a failed inotify registration never busy-stats the file.
    log.warn(`[subagent-watch] fs.watch failed watchId=${watchId}, polling fallback: ${err.message}`);
    pollInterval = setInterval(readNewEntries, 10000);
  }

  function teardown() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  subagentWatchers.set(watchId, { filePath, parentSessionId, agentId, teardown });
  log.info(`[subagent-watch] start watchId=${watchId} parent=${parentSessionId} agentId=${agentId}`);
  return { watchId };
});

ipcMain.handle('stop-subagent-watch', (_event, watchId) => {
  const entry = subagentWatchers.get(watchId);
  if (!entry) return { ok: false };
  entry.teardown();
  subagentWatchers.delete(watchId);
  log.info(`[subagent-watch] stop watchId=${watchId}`);
  return { ok: true };
});

// --- IPC: delete-session ---
// Permanently removes a session's transcript from disk. This is the one action
// in the app that destroys user history, so it is deliberately narrow:
//
//  - the id must look like a session id, and is used only as a filename
//    component under PROJECTS_DIR — never joined with caller-supplied paths
//  - the resolved file must still sit inside PROJECTS_DIR after realpath, so a
//    symlinked transcript cannot be used to delete something elsewhere
//  - a session with a live PTY is refused; killing the process and deleting its
//    transcript underneath itself is not something to do implicitly
//
// Subagent transcripts live in a sibling <sessionId>/ directory and are part of
// the same conversation, so they go too — leaving them orphans the tree.
// --- IPC: delete-session-preview ---
// What deleting `sessionId` would remove, so the confirmation dialog can state
// it rather than asking the user to trust a generic warning.
ipcMain.handle('delete-session-preview', async (_event, sessionId) => {
  const id = String(sessionId || '');
  const memberIds = [...getMergedMemberIds(id)];
  const partIds = [...new Set([id, ...memberIds])];
  const refusal = await deleteSessionGuard(id, partIds);
  if (refusal) return { ok: false, error: refusal };
  const resolved = resolveRowDeletionTargets(PROJECTS_DIR, id, memberIds, partId => {
    const folder = getCachedFolder(partId);
    if (isRemoteFolder(folder)) throw new Error(REMOTE_READ_ONLY);
    return folder;
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  let subagents = 0;
  let transcripts;
  try {
    transcripts = resolved.targets.filter(target => fs.statSync(target).isFile()).length;
  } catch (err) {
    return { ok: false, error: `cannot inspect conversation files: ${err.message}` };
  }
  try {
    subagents = partIds.flatMap(partId => (getCachedByParent(partId) || [])
      .filter(r => r.sessionId && r.sessionId !== partId)).length;
  } catch (err) {
    return { ok: false, error: `cannot resolve conversation subagents: ${err.message}` };
  }
  return { ok: true, parts: resolved.parts, partIds, transcripts, subagents };
});

ipcMain.handle('delete-session', async (_event, sessionId, previewPartIds) => {
  const id = String(sessionId || '');
  const memberIds = [...getMergedMemberIds(id)];
  const partIds = [...new Set([id, ...memberIds])];
  const changed = 'the conversation changed while checking; try Delete again';
  const sameParts = ids => Array.isArray(ids) && new Set(ids).size === partIds.length
    && partIds.every(partId => ids.includes(partId));
  if (!sameParts(previewPartIds)) return { ok: false, error: changed };
  const refusal = await deleteSessionGuard(id, partIds);
  if (refusal) return { ok: false, error: refusal };
  if (!sameParts([id, ...getMergedMemberIds(id)])) return { ok: false, error: changed };
  const resolved = resolveRowDeletionTargets(PROJECTS_DIR, id, memberIds, partId => {
    const folder = getCachedFolder(partId);
    if (isRemoteFolder(folder)) throw new Error(REMOTE_READ_ONLY);
    return folder;
  });
  for (const r of resolved.refused) {
    log.warn(`[delete-session] refusing ${r.path} — ${r.reason} (${r.real})`);
  }
  if (!resolved.ok) return { ok: false, error: resolved.error };

  let subagentIds;
  const subagentsByPart = new Map();
  const subagentTargetsByPart = new Map();
  try {
    for (const part of resolved.partTargets) {
      subagentTargetsByPart.set(part.id, part.targets.filter(target => fs.statSync(target).isDirectory()));
    }
  } catch (err) {
    return { ok: false, error: `cannot inspect conversation files: ${err.message}` };
  }
  try {
    for (const partId of partIds) {
      subagentsByPart.set(partId, (getCachedByParent(partId) || [])
        .map(row => row.sessionId).filter(sid => sid && sid !== partId));
    }
    subagentIds = [...subagentsByPart.values()].flat();
  } catch (err) {
    return { ok: false, error: `cannot resolve conversation subagents: ${err.message}` };
  }

  const removed = [];
  let failure;
  const orderedParts = [...resolved.partTargets.filter(part => part.id !== id),
    ...resolved.partTargets.filter(part => part.id === id)];
  for (const part of orderedParts) {
    for (const target of [...part.targets].reverse()) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch (err) {
        log.error(`[delete-session] failed to remove ${target}: ${err.message}`);
        failure = err.message;
        break;
      }
    }
    if (failure) break;
  }

  const isGone = target => {
    try { fs.lstatSync(target); return false; }
    catch (err) { return err.code === 'ENOENT' || err.code === 'ENOTDIR'; }
  };
  const deletedPartIds = orderedParts.filter(part => part.targets.every(isGone)).map(part => part.id);
  const deletedSubagentIds = orderedParts.filter(part => {
    const dirs = subagentTargetsByPart.get(part.id);
    return deletedPartIds.includes(part.id) || (dirs.length > 0 && dirs.every(isGone));
  }).flatMap(part => subagentsByPart.get(part.id));
  const deletedIds = [...new Set([...deletedPartIds, ...deletedSubagentIds])];
  for (const sid of deletedIds) {
    mainTouchedCache.dropSession(sid);
    if (deletedPartIds.includes(sid)) {
      try { await deleteSetting('continuationChoice:' + sid); }
      catch (err) { log.warn(`[delete-session] could not delete continuationChoice:${sid}: ${err.message}`); }
    }
    try { await deleteCachedSession(sid); } catch {}
    try { await deleteSearchSession(sid); } catch {}
  }

  if (failure) {
    const remaining = partIds.filter(partId => !deletedPartIds.includes(partId));
    return { ok: false, removedPartIds: deletedPartIds, error: `Deleted ${deletedPartIds.length} of ${partIds.length} parts; ${failure}. Removed: ${deletedPartIds.join(', ') || 'none'}; remaining: ${remaining.join(', ') || 'none'}. Try Delete again.` };
  }

  if (!removed.length) {
    log.info(`[delete-session] ${id} had no transcript — cleared caches only`);
    return { ok: true, removed: [], subagents: subagentIds.length, placeholder: true };
  }

  log.info(`[delete-session] ${id} removed ${removed.length} path(s), ${subagentIds.length} subagent row(s)`);
  return { ok: true, removed, subagents: subagentIds.length };
});

ipcMain.handle('archive-session', async (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  await setArchived(getConversationPartIds(sessionId), val);
  return { archived: val };
});

// --- Sandbox launch helpers (Linux / bubblewrap) ---
// In the packaged app main.js lives inside app.asar, which bash cannot read
// from — the script is asarUnpacked (see package.json build config). The
// separator-anchored pattern rewrites only the real app.asar path segment,
// not an install directory whose name merely contains "app.asar".
function sandboxScriptPath() {
  return path.join(__dirname, 'scripts', 'claude-sandbox.sh')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

// "Additional Directories" is a comma-separated free-text field. Single parse
// point so the claude `--add-dir` args and the sandbox bind list can never
// disagree about what the user typed.
function parseAddDirs(value) {
  if (!value) return [];
  return String(value).split(',').map(d => d.trim()).filter(Boolean);
}

// SWITCHBOARD_SANDBOX_BINDS is colon-separated (env vars cannot carry NUL), so
// a path that itself contains ':' cannot be transported — the script would
// split it into fragments and never bind the real directory. Newlines are
// rejected for the same reason: they survive the env var but not every shell
// splitter downstream. Drop such paths loudly instead of half-binding them.
function sandboxBindEnv(dirs) {
  const usable = dirs.filter(d => {
    if (d.includes(':')) {
      log.warn(`[sandbox] skipping extra bind — ':' in path is unsupported: ${JSON.stringify(d)}`);
      return false;
    }
    if (/[\r\n]/.test(d)) {
      log.warn(`[sandbox] skipping extra bind — newline in path is unsupported: ${JSON.stringify(d)}`);
      return false;
    }
    return true;
  });
  return usable.length ? usable.join(':') : undefined;
}

// see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
let ptyGenerationCounter = 0;

// see .ai/contexts/session-state.md ("A session main drops")
function wireSessionPty(session, sessionId, ptyProcess) {
  let resolveExitDrain;
  session.exitDrain = new Promise(resolve => { resolveExitDrain = resolve; });
  session.generation = ++ptyGenerationCounter;
  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;
    if (session.backgroundCommandSource) {
      session.backgroundCommandOutput = ((session.backgroundCommandOutput || '') + data).slice(-1024);
      if (cancellationIn(session.backgroundCommandOutput)) {
        session.backgroundCommandSource = null;
        session.backgroundCommandOutput = '';
      }
    }

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from the OSC 0 title — see .ai/contexts/ipc-bridge.md
        if (code === '0') {
          const { busy: isBusy, idle: isIdle, via } = classifyTitleActivity(payload, { allowFallback: !session.isPlainTerminal });
          if (LOG_DEBUG_ON) log.debug(`[OSC 0] session=${currentId} cp=${codePoints(payload, 1)} rule=${via} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (TRACE.on) trace('osc.title', currentId, { cp: codePoints(payload, 3), title: payload.slice(0, 60), busy: isBusy, idle: isIdle, rule: via, was: !!session._cliBusy, decision: busyDecision(isBusy, isIdle, !!session._cliBusy) });
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            if (LOG_DEBUG_ON) log.debug(`[OSC 0] session=${currentId} → BUSY`);
            if (TRACE.on) trace('busy.emit', currentId, { busy: true, via: 'osc0', sent: !!(mainWindow && !mainWindow.isDestroyed()) });
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            if (LOG_DEBUG_ON) log.debug(`[OSC 0] session=${currentId} → IDLE`);
            if (TRACE.on) trace('busy.emit', currentId, { busy: false, via: 'osc0', sent: !!(mainWindow && !mainWindow.isDestroyed()) });
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          if (level === '0') continue; // 4;0 is also used for clearing, making it unreliable as an idle signal
          if (LOG_DEBUG_ON) log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy}`);
          if (TRACE.on) trace('osc.progress', currentId, { level, payload: payload.slice(0, 60), was: !!session._cliBusy, decision: progressDecision(level, !!session._cliBusy) });
          if ((level === '1' || level === '2' || level === '3') && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            if (LOG_DEBUG_ON) log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            if (TRACE.on) trace('busy.emit', currentId, { busy: true, via: 'osc9.4', sent: !!(mainWindow && !mainWindow.isDestroyed()) });
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          }
        } else {
          // Regular notification (attention, permission, etc.)
          log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          if (TRACE.on) trace('osc.notify', currentId, { message: payload.slice(0, 120), sent: !!(mainWindow && !mainWindow.isDestroyed()) });
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal-notification', currentId, payload);
          }
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      appendToOutputBuffer(session, data, MAX_BUFFER_SIZE);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(async ({ exitCode, signal }) => {
    const exitSignal = ptyExitSignalName(signal);
    const stopped = !!session.stopRequested;
    session.exited = true;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;

    const realId = session.realSessionId || sessionId;
    if (TRACE.on) trace('pty.exit', realId, { exitCode, signal: exitSignal, stopped, alsoUnder: realId !== sessionId ? sessionId : null, wasBusy: !!session._cliBusy, sent: !!(mainWindow && !mainWindow.isDestroyed()) });
    const finish = async suppress => {
      try {
      const realId = session.realSessionId || sessionId;
      const releaseReal = !activeSessions.has(realId) || activeSessions.get(realId) === session;
      const releaseOriginal = !activeSessions.has(sessionId) || activeSessions.get(sessionId) === session;
      if (!suppress && releaseReal && !session.isAttach && !session.isPlainTerminal) taskRecords.ownerDied(realId);
      if (!suppress && mainWindow && !mainWindow.isDestroyed() && !appQuitting) {
        mainWindow.webContents.send('process-exited', realId, exitCode, exitSignal, stopped, session.generation);
        if (realId !== sessionId && activeSessions.get(sessionId) === session) {
          mainWindow.webContents.send('process-exited', sessionId, exitCode, exitSignal, stopped, session.generation);
        }
      }
      if (session.kind === 'remote-attach') {
        exitedRemoteSessionIds.add(realId);
        exitedRemoteSessionIds.add(sessionId);
      }
      if (activeSessions.get(realId) === session) activeSessions.delete(realId);
      if (activeSessions.get(sessionId) === session) activeSessions.delete(sessionId);
      if (releaseReal) activityReporter.sessionEnded(realId);
      if (releaseOriginal) activityReporter.sessionEnded(sessionId);
      try {
        const releasedReal = releaseReal && await writer.releaseLiveSession(realId);
        const releasedOriginal = releaseOriginal && await writer.releaseLiveSession(sessionId);
        if (releasedReal || releasedOriginal) notifyRendererProjectsChanged('session-exit');
      } catch (err) {
        log.warn(`[session-cache] releasing kept row of ${realId} failed: ${err.message}`);
      }
      } finally { resolveExitDrain(); }
    };
    if (!holdBackgroundExit(session, finish) && !sessionTransitions.holdContinuationExit(sessionId, session, finish)) await finish(false);
  });
}

function killProcessTree(child) {
  try {
    if (isWindows) spawnChild('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

// Run `claude <argv>` to completion through the login shell -- see .ai/contexts/bg-agents.md ("Running the CLI")
function runClaudeCommand(claudeArgv, { cwd, timeout }) {
  return new Promise((resolve) => {
    const globalSettings = getSetting('global') || {};
    const profile = resolveShell(globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile);
    const shell = profile.path;
    const direct = isWindows && !isWslShell(shell) && !/bash|zsh|fish|^sh$|^nu$/.test(path.basename(shell, path.extname(shell)).toLowerCase());
    const childEnv = { ...cleanPtyEnv, FORCE_COLOR: '0' };
    let program = shell;
    let args;
    let verbatim = false;
    if (direct) {
      const plan = resolveWindowsClaude(claudeArgv, childEnv);
      if (plan.error) { resolve({ code: null, stdout: '', stderr: plan.error }); return; }
      ({ program, args, verbatim } = plan);
    } else {
      args = shellArgs(shell, 'claude ' + quoteArgvForShell(shell, claudeArgv), profile.args || []);
    }
    const killTree = claudeArgv[0] !== '--bg';
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr: err ? `${stderr}${err.message}` : stderr });
    };
    let child;
    try {
      child = spawnChild(program, args, {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, windowsHide: true,
        windowsVerbatimArguments: verbatim, detached: killTree && !isWindows,
      });
    } catch (err) {
      finish(null, err);
      return;
    }
    const timer = setTimeout(() => {
      if (killTree) killProcessTree(child);
      else { try { child.kill('SIGKILL'); } catch {} }
      finish(null, new Error(`claude ${claudeArgv[0]} timed out after ${timeout} ms`));
    }, timeout);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); finish(null, err); });
    child.on('close', (code) => { clearTimeout(timer); finish(code); });
    child.on('exit', (code) => {
      const grace = setTimeout(() => { clearTimeout(timer); finish(code); }, 1000);
      if (typeof grace.unref === 'function') grace.unref();
    });
  });
}

// --- IPC: open-terminal ---
function registerRemoteAttachSession(sessionId, { alias, projectPath, cwd, ptyProcess, remoteResizeAllowed }) {
  const remoteSession = {
    pty: ptyProcess,
    // handle: {write, isAlive} — see .ai/contexts/trigger-watcher.md, "Session handle"
    handle: ptyProcess,
    host: alias, kind: 'remote-attach',
    remoteResizeAllowed: remoteResizeAllowed === true,
    rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    cwd,
    isPlainTerminal: false,
    _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, remoteSession);
  revealIfSdkSession(sessionId);
  wireSessionPty(remoteSession, sessionId, ptyProcess);
  ptyProcess.onResizeAllowed?.(() => {
    if (activeSessions.get(sessionId) !== remoteSession || remoteSession.exited || remoteSession.remoteResizeAllowed) return;
    remoteSession.remoteResizeAllowed = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote-resize-allowed', sessionId);
  });
  return remoteSession;
}

ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions, initialSize) => {
  if (!mainWindow) return { ok: false, error: 'no window' };
  if (!unsavedGuard.launchAllowed()) return { ok: false, error: 'Switchboard is closing.' };

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    if (session.backgrounded && sessionOptions?.type === 'attach') {
      if (!JOB_ID_RE.test(String(sessionOptions.jobId)) || sessionOptions.jobId !== session.backgroundJobId) return { ok: false, error: 'invalid background session id' };
      activeSessions.delete(sessionId);
      if (!session.exited) killPty(session, sessionId);
    } else {
    if (session.backgrounding && session.exited) return { ok: false, error: 'The terminal exited while its background handoff is being checked. Wait for the result, then open the conversation from the sidebar.' };
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      mainWindow.webContents.send('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    return {
      ok: true, reattached: true, attach: !!session.isAttach, sandbox: !!session.sandbox,
      mcpState: session.mcpError ? 'failed' : getMcpState(session.realSessionId || sessionId),
      mcpError: session.mcpError || null,
      remoteResizeAllowed: session.remoteResizeAllowed,
      generation: session.generation,
    };
    }
  }

  // see .ai/contexts/session-cache.md ("Restore on click")
  if (sessionOptions?.reattachOnly) return { ok: false, notLive: true };

  // see .ai/contexts/session-cache.md ("Remote hosts — tmux attach")
  if (!isNew) {
    let cachedFolder = null;
    try { cachedFolder = getCachedFolder(sessionId); } catch {}
    // see .ai/contexts/session-cache.md ("Remote hosts — descriptor-only sessions")
    const alias = isRemoteFolder(cachedFolder)
      ? parseFolderKey(cachedFolder).alias
      : (cachedFolder ? null : remoteIndexer.findSessionAlias(sessionId));
    if (alias) {
      const descriptor = remoteIndexer.getRemoteSessions(alias).sessions.find(s => s.sessionId === sessionId);
      const localPtySize = normalizePtySize(initialSize);
      const attachResult = descriptor
        ? await remoteAttachAdapter.attach(alias, descriptor, localPtySize)
        : { ok: false, error: REMOTE_READ_ONLY };
      if (!attachResult.ok) return { ok: false, error: attachResult.error || REMOTE_READ_ONLY };

      if (!unsavedGuard.launchAllowed()) {
        attachResult.ptyProcess.kill();
        return { ok: false, error: 'Switchboard is closing.' };
      }
      const remoteCwd = (descriptor && typeof descriptor.cwd === 'string') ? descriptor.cwd : null;
      const remoteSession = registerRemoteAttachSession(sessionId, {
        alias, projectPath, cwd: remoteCwd, ptyProcess: attachResult.ptyProcess,
        remoteResizeAllowed: attachResult.remoteResizeAllowed,
      });
      return { ok: true, reattached: false, remote: true, sandbox: false, remoteResizeAllowed: remoteSession.remoteResizeAllowed, generation: remoteSession.generation };
    }
  }

  // For a Claude resume, spawn in the session's real recorded cwd (e.g. its
  // worktree) rather than the possibly-collapsed projectPath — otherwise
  // `claude --resume` can't find the conversation. Forks resume too (they run
  // `claude --resume <forkFrom> --fork-session` despite isNew being true), so
  // they need the fork source's real cwd. Only the spawn side moves:
  // project-level settings stay keyed on the collapsed projectPath, which is
  // also what the renderer header uses to display the shell profile. Genuinely
  // new sessions and plain terminals keep the requested projectPath.
  let spawnCwd = projectPath;
  const resumeSourceId = sessionOptions?.forkFrom
    ? String(sessionOptions.forkFrom)
    : (!isNew ? sessionId : null);
  if (resumeSourceId && sessionOptions?.type !== 'terminal' && sessionOptions?.type !== 'attach') {
    const realCwd = resolveSessionRealCwd(
      PROJECTS_DIR, resumeSourceId, projectPath ? encodeProjectPath(projectPath) : null
    );
    if (realCwd && fs.existsSync(realCwd)) spawnCwd = realCwd;
  }

  // see .ai/contexts/bg-agents.md ("Attach")
  const isAttach = sessionOptions?.type === 'attach';
  let attachJobId = null;
  if (isAttach) {
    if (!JOB_ID_RE.test(String(sessionOptions.jobId))) return { ok: false, error: 'invalid background session id' };
    attachJobId = String(sessionOptions.jobId);
    if (typeof sessionOptions.cwd === 'string' && sessionOptions.cwd) spawnCwd = sessionOptions.cwd;
  }

  // see .ai/contexts/panel-terminal.md ("Main process")
  const panelOwnerId = sessionOptions?.type === 'terminal' && sessionOptions.panelFor
    ? String(sessionOptions.panelFor)
    : null;
  if (panelOwnerId) {
    const panelTarget = resolvePanelTerminalCwd(panelOwnerId, resolveGitChangesTarget);
    if (!panelTarget.ok) return { ok: false, error: panelTarget.error };
    spawnCwd = panelTarget.cwd;
  }

  // Spawn new PTY
  if (!fs.existsSync(spawnCwd)) {
    return { ok: false, error: `project directory no longer exists: ${spawnCwd}` };
  }

  // Spawn at the size the renderer actually measured for the terminal
  // container. Spawning at a fixed 120x30 and only correcting on the first
  // terminal-resize left every session running against a wrong width until
  // then — the shell wrapped its output for 120 columns while xterm displayed
  // another, and TUI cursor moves landed a line off. normalizePtySize falls
  // back to the historical 120x30 when the renderer could not measure.
  const { cols: spawnCols, rows: spawnRows } = normalizePtySize(initialSize);

  const isPlainTerminal = sessionOptions?.type === 'terminal';

  // Resolve shell profile from effective settings
  const effectiveProfileId = (() => {
    const global = getSetting('global') || {};
    const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
    let profileId = SETTING_DEFAULTS.shellProfile;
    if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
    if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
    return profileId;
  })();
  // WSL profiles only work for plain terminals — Claude CLI sessions need the
  // Windows shell because session data lives on the Windows filesystem.
  const requestedProfile = resolveShell(effectiveProfileId);
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(spawnCwd);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let projectFolder = null;
  let continuationSnapshot = null;

  if (!isPlainTerminal) {
    // Snapshot existing .jsonl files before spawning (for new session + fork detection)
    projectFolder = encodeProjectPath(spawnCwd);
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    continuationSnapshot = await sessionTransitions.snapshotContinuationsBeforeSpawn(path.join(claudeProjectDir, sessionId + '.jsonl'), sessionId);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }
  }

  let ptyProcess;
  let mcpServer = null;
  let mcpError = null;
  try {
    if (isPlainTerminal) {
      const launch = plainTerminalLaunch({
        shell,
        args: shellArgs(shell, undefined, shellExtraArgs),
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          CLAUDECODE: '1',
        },
        initDir: ensurePlainTerminalInitFiles(PLAIN_TERMINAL_INIT_DIR, log) ? PLAIN_TERMINAL_INIT_DIR : null,
      });
      ptyProcess = spawnPty(shell, launch.args, {
        name: 'xterm-256color',
        cols: spawnCols,
        rows: spawnRows,
        cwd: isWsl ? os.homedir() : spawnCwd,
        env: launch.env,
      });
      if (launch.typed) {
        setTimeout(() => {
          if (!ptyProcess._isDisposed) {
            try {
              ptyProcess.write(launch.typed);
            } catch {}
          }
        }, 300);
      }
    } else {
      // Build claude command, using array to prevent accidental shell injection
      const claudeArgs = [];
      if (isAttach) {
        claudeArgs.push('attach', attachJobId);
      } else {
        // A sidebar card is not proof the session exists on disk: launchNewSession
        // shows one before claude starts, so a launch that fails immediately (bad
        // flag, missing directory) leaves a card whose transcript was never
        // written. Resuming that id makes claude exit with "No conversation found
        // with session ID", and the banner's advice — re-click to relaunch — could
        // never work because every retry resumed the same missing id. Start it
        // instead, reusing the id the sidebar already shows.
        const startsFresh = isNew
          || (!sessionOptions?.forkFrom && !sessionTranscriptExists(PROJECTS_DIR, sessionId));
        if (!isNew && startsFresh && !sessionOptions?.forkFrom) {
          log.info(`[open-terminal] ${sessionId} has no transcript — starting it instead of resuming`);
        }
        if (sessionOptions?.forkFrom) {
          claudeArgs.push('--resume', String(sessionOptions.forkFrom), '--fork-session');
        } else if (startsFresh) {
          claudeArgs.push('--session-id', String(sessionId));
        } else {
          claudeArgs.push('--resume', String(sessionId));
        }

        if (sessionOptions) {
          if (sessionOptions.dangerouslySkipPermissions) {
            claudeArgs.push('--dangerously-skip-permissions');
          } else if (sessionOptions.permissionMode) {
            claudeArgs.push('--permission-mode', String(sessionOptions.permissionMode));
          }
          // --worktree only applies when STARTING a session — it creates a fresh
          // isolated git worktree. Resuming (isNew === false) must reuse the
          // session's existing directory, so ignore the worktree option on resume
          // regardless of which call site supplied it (sidebar click, schedule
          // creator, fork, …). Otherwise a resume tries to spin up a new worktree
          // and fails to attach.
          if (startsFresh && sessionOptions.worktree && !isGitRepo(spawnCwd)) {
            // Worktree is commonly enabled globally, but plenty of projects are
            // not git repos. Passing --worktree there makes claude refuse to start
            // at all ("Can only use --worktree in a git repository"), which turns
            // one global convenience toggle into a broken project. Drop the flag
            // and run unisolated rather than fail the launch.
            log.warn(`[open-terminal] ${spawnCwd} is not a git repository — launching without --worktree`);
          } else if (startsFresh && sessionOptions.worktree) {
            claudeArgs.push('--worktree');
            if (sessionOptions.worktreeName) {
              claudeArgs.push(String(sessionOptions.worktreeName));
            }
          }
          if (sessionOptions.chrome) {
            claudeArgs.push('--chrome');
          }
          for (const dir of parseAddDirs(sessionOptions.addDirs)) {
            claudeArgs.push('--add-dir', dir);
          }
        }

        if (sessionOptions?.appendSystemPrompt) {
          claudeArgs.push('--append-system-prompt', String(sessionOptions.appendSystemPrompt));
        }
      }

      let claudeCmd = 'claude ' + quoteArgvForShell(shell, claudeArgs);

      // Sandbox: run claude inside a bubblewrap sandbox that only exposes the
      // project directory and Claude's own config/state dirs. Linux only —
      // bwrap has no macOS/Windows equivalent wired up here.
      if (!isAttach && sessionOptions?.sandbox) {
        if (process.platform !== 'linux') {
          return { ok: false, error: 'Sandbox mode requires Linux (bubblewrap)' };
        }
        claudeCmd = quoteArgvForShell(shell, ['bash', sandboxScriptPath()]) + ' ' + quoteArgvForShell(shell, claudeArgs);
      }

      // preLaunchCmd is raw shell by design (e.g. "aws-vault exec profile --")
      // — see pre-launch-cmd-guard.js for what is and isn't blocked and why.
      if (!isAttach && sessionOptions?.preLaunchCmd) {
        const pre = String(sessionOptions.preLaunchCmd);
        const preCheck = validatePreLaunchCmd(pre);
        if (!preCheck.ok) {
          return { ok: false, error: preCheck.error };
        }
        claudeCmd = pre + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (!isAttach && sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await startMcpServer(sessionId, [spawnCwd], mainWindow, log);
          claudeCmd += ' --ide';
        } catch (err) {
          mcpError = err.message;
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      // Anchor the working directory in the command itself. pty.spawn's `cwd`
      // is set below, but it does not survive in practice: the login+interactive
      // shell (`bash -l -i -c`) sources the user's profile first, and anything
      // there that changes directory — or any environment that hands the PTY
      // the app's own cwd — silently relocates claude. It then derives its
      // project folder from the wrong directory and reports "No conversation
      // found with session ID", and with Sandbox on it binds the wrong tree.
      // `&&` so a failed cd aborts rather than running claude somewhere random.
      if (!isWsl && spawnCwd) {
        const base = path.basename(shell).toLowerCase();
        const posixish = base.includes('bash') || base.includes('zsh')
          || base === 'sh' || base === 'dash' || base === 'ksh';
        if (posixish) {
          claudeCmd = quoteArgvForShell(shell, ['cd', spawnCwd]) + ' && ' + claudeCmd;
        }
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      if (mcpServer) {
        ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);
      }
      // see docs/sandbox.md ("Schedules")
      if (projectPath) await scheduleProjects().add(projectPath);
      if (!isAttach && sessionOptions?.sandbox) {
        // Directories the sandboxed claude must still reach beyond the cwd:
        // the project root when resuming inside a worktree (git metadata lives
        // there), and any user-configured Additional Directories.
        const extraBinds = [];
        if (projectPath && projectPath !== spawnCwd) extraBinds.push(projectPath);
        extraBinds.push(...parseAddDirs(sessionOptions.addDirs));
        const bindEnv = sandboxBindEnv(extraBinds);
        if (bindEnv) ptyEnv.SWITCHBOARD_SANDBOX_BINDS = bindEnv;
        const transcriptCwd = spawnCwd || projectPath;
        if (transcriptCwd) ptyEnv.SWITCHBOARD_SANDBOX_PROJECT_FOLDER = encodeProjectPath(transcriptCwd);
      }

      ptyProcess = spawnPty(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: spawnCols,
        rows: spawnRows,
        cwd: isWsl ? os.homedir() : spawnCwd,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    // see .ai/contexts/trigger-watcher.md, "Target guard"
    cwd: spawnCwd,
    projectFolder, knownJsonlFiles, continuationSnapshot,
    isPlainTerminal, panelFor: panelOwnerId, forkFrom: sessionOptions?.forkFrom || null,
    isAttach, attachJobId,
    preLaunch: !isAttach && !!sessionOptions?.preLaunchCmd,
    // Recorded so a reattach can report it too — the renderer badges sandboxed
    // sessions, and a reattached session is still inside the same sandbox.
    sandbox: !!sessionOptions?.sandbox,
    mcpServer, mcpError, _openedAt: Date.now(),
    // see docs/automation.md — the trigger watcher's politeness guard
    composerState: createComposerState(),
    // see .ai/contexts/trigger-watcher.md, "Session handle"
    host: null, kind: 'local-pty',
  };
  activeSessions.set(sessionId, session);
  if (!isPlainTerminal) revealIfSdkSession(sessionId);
  if (isAttach) notifyRendererProjectsChanged('session-attach');
  if (!isPlainTerminal && !panelOwnerId) activityReporter.sessionStarted({ sessionId, project: projectPath });

  // see .ai/contexts/cli-session-state.md
  if (!isPlainTerminal && !cliSessionState.ensureWatching()) {
    const retry = setTimeout(() => cliSessionState.ensureWatching(), 15000);
    if (typeof retry.unref === 'function') retry.unref();
  }

  wireSessionPty(session, sessionId, ptyProcess);

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return {
    ok: true, reattached: false, sandbox: !!sessionOptions?.sandbox,
    mcpState: mcpError ? 'failed' : getMcpState(sessionId),
    mcpError,
    generation: session.generation,
  };
});

// --- IPC: activity-trace (fire-and-forget, opt-in) ---
// Registered unconditionally — see .ai/contexts/ipc-bridge.md "Activity trace".
ipcMain.on('session-projection-changed', (event, record) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || !event.senderFrame || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) return;
    if (!require('./public/session-projection-diagnostics').validateSessionProjectionRecord(record)) return;
    log.info('[session-projection] ' + JSON.stringify({ ...record, at: new Date().toISOString() }));
  } catch {}
});

ipcMain.on('activity-trace', (_event, cat, sid, fields) => {
  trace(typeof cat === 'string' ? cat : 'renderer', sid, fields, 'renderer');
});

// --- IPC: activity-trace control (the Diagnostics panel) ---
// see docs/activity-trace.md "Toggling it at runtime"
const TRACE_FILE_RE = activityTrace.TRACE_FILE_RE;
const TRACE_READ_CAP = 4 * 1024 * 1024;

function listActivityTraceFiles() {
  let names;
  try { names = fs.readdirSync(TRACE_DIR); } catch { return []; }
  const current = activityTrace.currentFile();
  const files = [];
  for (const name of names) {
    if (!TRACE_FILE_RE.test(name)) continue;
    const filePath = path.join(TRACE_DIR, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      files.push({ name, filePath, size: stat.size, modified: stat.mtime.toISOString(), current: filePath === current });
    } catch {}
  }
  files.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
  return files;
}

function resolveTraceFile(filePath) {
  return activityTrace.resolveTraceFilePath(TRACE_DIR, filePath);
}

function activityTraceState() {
  return {
    enabled: TRACE.on,
    dir: TRACE_DIR,
    currentFile: activityTrace.currentFile(),
    fromEnv: activityTrace.envState(process.env) !== null,
  };
}

ipcMain.handle('get-activity-trace-state', () => activityTraceState());

// see .ai/contexts/activitywatch.md ("The IPC surface")
async function activityReportingState() {
  const reachable = activityReporter.enabled ? await activityWatchClient.probe() : null;
  return {
    enabled: activityReporter.enabled,
    destination: 'ActivityWatch',
    url: ACTIVITYWATCH_URL,
    reachable,
    buckets: activityReporter.buckets,
  };
}

ipcMain.handle('get-activity-reporting-state', () => activityReportingState());

ipcMain.handle('set-activity-reporting-enabled', async (_event, enabled) => {
  const on = !!enabled;
  activityReporter.setEnabled(on);
  await writer.patchGlobal({ activityReporting: on });
  log.info(`[activitywatch] reporting ${on ? 'enabled' : 'disabled'} from the UI`);
  return activityReportingState();
});

// see .ai/contexts/activitywatch.md ("The IPC surface")
ipcMain.on('activity-focus', (_event, focus) => {
  if (!focus || typeof focus.sessionId !== 'string' || !focus.sessionId || focus.sessionId.length > 200) {
    activityReporter.focus(null);
    return;
  }
  activityReporter.focus({
    sessionId: focus.sessionId,
    name: typeof focus.name === 'string' ? focus.name.slice(0, 200) : '',
    project: typeof focus.project === 'string' ? focus.project.slice(0, 1024) : '',
  });
});

ipcMain.on('activity-titles', (_event, list) => {
  if (!Array.isArray(list)) return;
  activityReporter.titles(list.slice(0, 500)
    .filter(t => t && typeof t.sessionId === 'string' && t.sessionId && t.sessionId.length <= 200 && typeof t.name === 'string')
    .map(t => ({ sessionId: t.sessionId, name: t.name.slice(0, 200) })));
});

ipcMain.handle('set-activity-trace-enabled', async (_event, enabled) => {
  const on = !!enabled;
  // activityTrace.setEnabled has its own bounded fallback (see
  // docs/activity-trace.md), but this toggle must never hang on it either —
  // belt and suspenders against a stream close that never comes.
  await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.warn('[activity-trace] setEnabled did not call back in time; unblocking the Diagnostics toggle anyway');
      resolve();
    }, 8000);
    activityTrace.setEnabled(on, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
  mainLoopMonitor.sync();
  await writer.patchGlobal({ activityTrace: on });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('activity-trace-state', on);
  log.info(`[activity-trace] ${on ? 'enabled' : 'disabled'} from the UI → ${activityTrace.currentFile() || '(closed)'}`);
  return activityTraceState();
});

ipcMain.handle('list-activity-trace-files', () => listActivityTraceFiles());

ipcMain.handle('read-activity-trace-file', (_event, filePath) => {
  const resolved = resolveTraceFile(filePath);
  if (!resolved) return { ok: false, error: 'not an activity-trace file' };
  try {
    return { ok: true, ...activityTrace.readTraceTail(resolved, TRACE_READ_CAP) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('delete-activity-trace-file', (_event, filePath) => {
  const resolved = resolveTraceFile(filePath);
  if (!resolved) return { ok: false, error: 'not an activity-trace file' };
  if (resolved === activityTrace.currentFile()) return { ok: false, error: 'the trace is writing to this file — turn debug mode off first' };
  try {
    fs.unlinkSync(resolved);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  if (TRACE.on) {
    const chunk = typeof data === 'string' ? data : String(data ?? '');
    const at = controlOffset(chunk);
    trace('pty.input', sessionId, at === -1
      ? { len: chunk.length }
      : { at, cp: codePoints(chunk.slice(at), 10), len: chunk.length });
  }
  handleTerminalInput(activeSessions, sessionId, data, Date.now());
});

// --- IPC: terminal-resize (fire-and-forget) ---
const handleTerminalResize = createTerminalResizeHandler(activeSessions, undefined, (sessionId, phase, cols, rows, ok) => {
  if (TRACE.on) trace('pty.resize', sessionId, { phase, cols, rows, ok });
});
ipcMain.on('terminal-resize', (_event, sessionId, cols, rows, refresh) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    handleTerminalResize(sessionId, cols, rows, refresh);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }
  }
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (_event, sessionId) => {
  exitedRemoteSessionIds.delete(sessionId);
  const session = activeSessions.get(sessionId);
  if (session) {
    session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
});

// Session transitions → session-transitions.js
const { createTaskRecordsClient } = require('./task-records-client');
const taskRecords = createTaskRecordsClient({
  onSnapshot: snapshot => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task-snapshot', snapshot);
  },
  onError: error => log.warn(`[task-records] ${error}`),
  onRekey: (oldId, newId, continued) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task-rekey', { oldId, newId, continued });
  },
});
async function refreshRemoteHeadTurns(hostAlias) {
  await refreshRemoteHeadTurnsFromCache({
    getAllCached, getAllMeta, projectsDirForFolder,
    getRemoteSessions: alias => remoteIndexer.getRemoteSessions(alias),
    readBatch: rows => taskRecords.readBatch(rows),
  }, hostAlias);
}
ipcMain.handle('get-task-snapshots', async () => {
  const live = new Set(cliSessionState.getSidebarDescriptors().map(d => d.sessionId));
  const descriptors = cliSessionState.readAllDescriptors();
  for (const [key, session] of activeSessions) {
    if (!session.exited && !session.isPlainTerminal) live.add(session.realSessionId || key);
  }
  for (const job of bgAgents.getSnapshot().roster) {
    if (job.sessionId && isHostedJob(job, descriptors)) live.add(job.sessionId);
  }
  try {
    await refreshRemoteHeadTurns();
  } catch (err) {
    log.warn(`[task-records] remote head-turn refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let cached = [];
  try {
    cached = getAllCached();
  } catch (err) {
    log.warn(`[task-records] local snapshot cache read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let childCacheWarned = false;
  for (const row of cached) {
    if (row.parentSessionId || !live.has(row.sessionId)) continue;
    const folder = row.folder;
    const dir = folder && !parseFolderKey(folder).alias && projectsDirForFolder(folder);
    if (dir) {
      await taskRecords.read(path.join(dir, row.sessionId + '.jsonl'), row.sessionId);
      let children;
      try {
        children = getCachedByParent(row.sessionId);
      } catch (err) {
        if (!childCacheWarned) {
          log.warn(`[task-records] child snapshot cache read failed: ${err instanceof Error ? err.message : String(err)}`);
          childCacheWarned = true;
        }
        continue;
      }
      for (const child of children) {
        if (child.agentId) await taskRecords.child(resolveJsonlPath(dir, { ...child, folder: '.' }), row.sessionId, child.agentId);
      }
    }
  }
  return taskRecords.snapshots();
});
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({
  PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer,
  onBackgroundConfirmed: context => persistBackgroundHandoff(context),
  hasTaskRecord: (id, agentId) => taskRecords.hasRecord(id, agentId),
  backgroundJobExists: jobId => {
    const job = bgAgents.getCachedJobs().get(jobId);
    return !!job && isHostedJob({ ...job, id: jobId }, cliSessionState.readAllDescriptors());
  },
  rekeyActivity: (fromId, toId, kind) => { activityReporter.rekey(fromId, toId); taskRecords.rekey(fromId, toId, { continued: kind === 'continuation' || kind === 'background' }); },
  rekeyMetadata: (fromId, toId, kind) => kind === 'background' ? writer.rekeySessionMeta(fromId, toId) : undefined,
  getBackgroundTarget: id => {
    const descriptors = cliSessionState.getSidebarDescriptors().filter(d => d.sessionId.toLowerCase() === id.toLowerCase());
    if (descriptors.length) {
      const jobs = new Set(descriptors.filter(d => d.kind === 'bg' && d.jobId).map(d => d.jobId));
      if (jobs.size !== 1 || descriptors.some(d => d.kind !== 'bg')) return null;
      return descriptors[0];
    }
    const liveDescriptors = cliSessionState.readAllDescriptors();
    const jobs = [...bgAgents.getCachedJobs()].filter(([jobId, job]) => job.sessionId?.toLowerCase() === id.toLowerCase()
      && isHostedJob({ ...job, id: jobId }, liveDescriptors));
    return jobs.length === 1 ? { kind: 'bg', jobId: jobs[0][0], sessionId: id } : null;
  },
  clearOwner: (sessionId, ptyPid, options) => cliSessionState.clearOwner(sessionId, ptyPid, options),
  getDescriptorIdentity: snapshot => cliSessionState.getDescriptorIdentity(snapshot),
});
const { detectSessionTransitions } = sessionTransitions;

// see .ai/contexts/cli-session-state.md
const cliSessionState = require('./cli-session-state');
const taskOwnerLiveness = new Map();
cliSessionState.init({
  activeSessions,
  log,
  onOwnerExit: id => { taskOwnerLiveness.delete(id); taskRecords.ownerDied(id); },
  onIdle: (sessionId, session) => {
    sessionTransitions.detectSubagentTransitions(
      sessionId, session, path.join(PROJECTS_DIR, session.projectFolder)
    );
  },
});
cliSessionState.onStatusesChanged(() => {
  sessionTransitions.detectPendingBackgroundContinuations();
  notifyRendererProjectsChanged('cli-status');
  const observed = new Set();
  for (const descriptor of cliSessionState.getSidebarDescriptors()) {
    const id = descriptor.sessionId;
    const identity = JSON.stringify([descriptor.pid, descriptor.startedAt]);
    observed.add(id);
    if (taskOwnerLiveness.get(id) !== identity) {
      taskOwnerLiveness.set(id, identity);
      taskRecords.ownerAlive(id, descriptor.startedAt);
    }
  }
  for (const id of taskOwnerLiveness.keys()) if (!observed.has(id)) taskOwnerLiveness.delete(id);
});

// a session with a live PTY is owned by the OSC path — see .ai/contexts/session-state.md
const ptyPids = cliSessionState.makePtyPids(activeSessions);

function sessionHasPty(sessionId) {
  for (const [key, session] of activeSessions) {
    if (!session || session.exited) continue;
    if ((session.realSessionId || key) === sessionId) return true;
  }
  return false;
}
const localTranscriptTracker = createLocalTranscriptTracker({
  hasPty: sessionHasPty,
  projectsDir: PROJECTS_DIR,
  onTranscript: (file, id, agentId) => {
    if (sessionHasPty(id) || cliSessionState.getStatus(id) || bgAgents.getSnapshot().roster.some(job => job.sessionId === id && isHostedJob(job, cliSessionState.readAllDescriptors()))) {
      if (agentId) {
        const folder = path.relative(PROJECTS_DIR, file).split(path.sep)[0];
        taskRecords.read(path.join(PROJECTS_DIR, folder, id + '.jsonl'), id).then(() => taskRecords.child(file, id, agentId));
      } else taskRecords.read(file, id);
    }
  },
  onActivity: (activity) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session-transcript-activity', activity);
    }
  },
});

// see .ai/contexts/cli-session-state.md ("Live elsewhere")
ipcMain.handle('session-live-elsewhere', (_event, sessionId) => cliSessionState.liveElsewhere(sessionId, sessionHasPty, ptyPids));
ipcMain.handle('session-continuations', (_event, sessionId) => sessionCache.resolveSessionContinuations(sessionId, {
  getSessionLiveElsewhere: id => cliSessionState.liveElsewhereChecked(id, sessionHasPty, ptyPids),
}));
ipcMain.handle('sessions-live-elsewhere', (_event, sessionIds) => cliSessionState.liveElsewhereMany(sessionIds, sessionHasPty, ptyPids));

// see .ai/contexts/bg-agents.md
bgAgents.init({
  log,
  runClaude: runClaudeCommand,
  cliSessionState,
  resolveTranscriptPath: (sessionId) => {
    const folder = getCachedFolder(sessionId);
    const dir = folder && projectsDirForFolder(folder);
    return dir ? path.join(dir, sessionId + '.jsonl') : null;
  },
  makeIsOwnPid: () => cliSessionState.ownProcessFilter(ptyPids),
  dispatchSettings: (cwd) => {
    const project = getSetting('project:' + path.resolve(cwd)) || {};
    const global = getSetting('global') || {};
    const preLaunchCmd = project.preLaunchCmd !== undefined ? project.preLaunchCmd
      : (global.preLaunchCmd !== undefined ? global.preLaunchCmd : SETTING_DEFAULTS.preLaunchCmd);
    return { sandbox: resolveScheduleSandbox(cwd, getSetting, SETTING_DEFAULTS.sandbox), preLaunchCmd };
  },
  isAttachedHere: (jobId) => {
    for (const session of activeSessions.values()) {
      if (session && !session.exited && session.isAttach && session.attachJobId === jobId) return true;
    }
    return false;
  },
});
const unsubscribeBgAgents = require('./bg-agents-ipc').init({ ipcMain, bgAgents, getMainWindow: () => mainWindow, log,
  activeSessions, cliSessionState, sessionHasPty, ptyPids, getSetting: key => getSetting(key) });
bgAgents.onJobsChanged(() => notifyRendererProjectsChanged('bg-jobs'));
bgAgents.onJobsChanged(() => {
  sessionTransitions.detectPendingBackgroundContinuations();
});
const taskJobOwners = new Map();
const unsubscribeTaskJobs = bgAgents.onChange(({ roster }) => {
  const present = new Set(roster.map(job => job.id));
  for (const [jobId, sessionId] of taskJobOwners) if (!present.has(jobId)) {
    taskRecords.job(sessionId, null, { jobId });
    taskJobOwners.delete(jobId);
  }
  for (const job of roster) {
    if (job.sessionId && job.id) {
      const previous = taskJobOwners.get(job.id);
      if (previous && previous !== job.sessionId) taskRecords.job(previous, null, { jobId: job.id });
      taskJobOwners.set(job.id, job.sessionId);
      taskRecords.job(job.sessionId, job.taskEvidence, { jobId: job.id });
    }
  }
});
function getConversationPartIds(id) {
  const rows = getAllCached();
  const canonicalId = rows.find(row => row.sessionId.toLowerCase() === String(id).toLowerCase())?.sessionId
    || cliSessionState.getSidebarDescriptors().find(row => row.sessionId.toLowerCase() === String(id).toLowerCase())?.sessionId
    || [...activeSessions].map(([key, session]) => session.realSessionId || key)
      .find(part => part.toLowerCase() === String(id).toLowerCase()) || String(id);
  return [canonicalId, ...sessionCache.conversationMemberIds(rows, canonicalId)];
}

function getMergedMemberIds(id) {
  return getConversationPartIds(id).filter(part => part.toLowerCase() !== String(id || '').toLowerCase());
}

const deleteSessionGuard = makeDeleteSessionGuard({
  activeSessions, bgAgents, cliSessionState, sessionHasPty, ptyPids,
  getMergedMemberIds,
});

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  let flushChain = Promise.resolve();
  if (!fs.existsSync(PROJECTS_DIR)) return;

  // pendingChanges: folder → Set<relativePath> | true.
  //   Set<string>  — only the listed files changed (targeted refresh, fast path)
  //   true         — folder-level event or unknown scope, do a full walk
  // The watcher reports the specific filename, so for the common case of a
  // subagent appending JSONL we can stat one file instead of thousands.
  const pendingChanges = new Map();
  const pendingWorkflowTitles = new Set();
  const workflowTitles = new Map();
  let debounceTimer = null;

  flushProjectsBeforeExit = async () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    await flushChanges();
  };

  function flushChanges() {
    const pending = flushChain.then(applyChanges);
    flushChain = pending.catch(() => {});
    return pending;
  }

  async function applyChanges() {
    debounceTimer = null;
    // Drain pendingChanges into a local copy so events arriving during the
    // synchronous flush land in a fresh batch for the next tick.
    const work = new Map(pendingChanges);
    pendingChanges.clear();

    const snapshots = [...pendingWorkflowTitles];
    pendingWorkflowTitles.clear();
    let changed = false;
    for (const [folder, scope] of work) {
      if (scope === true || !fs.existsSync(path.join(PROJECTS_DIR, folder))) {
        for (const filename of workflowTitles.keys()) {
          if (filename.startsWith(folder + path.sep)) workflowTitles.delete(filename);
        }
      }
    }
    for (const filename of snapshots) {
      try {
        const snapshot = JSON.parse(await fs.promises.readFile(path.join(PROJECTS_DIR, filename), 'utf8'));
        const title = typeof snapshot.workflowName === 'string' && snapshot.workflowName.trim()
          ? snapshot.workflowName.trim() : path.basename(filename, '.json');
        if (workflowTitles.get(filename) !== title) changed = true;
        workflowTitles.set(filename, title);
      } catch (err) {
        if (err.code === 'ENOENT') {
          const runId = path.basename(filename, '.json');
          if (workflowTitles.get(filename) !== runId) changed = true;
          if (fs.existsSync(path.join(PROJECTS_DIR, filename.split(path.sep)[0]))) workflowTitles.set(filename, runId);
        }
      }
    }
    let activityChanged = false;
    for (const [folder, scope] of work) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      let folderChanged;
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        folderChanged = await writer.refreshFolder(folder, scope === true ? undefined : { files: scope });
      } else {
        folderChanged = await writer.dropFolderRows(folder);
      }
      changed = folderChanged === true || changed;
      activityChanged = folderChanged === 'activity' || activityChanged;
    }

    if (changed) {
      notifyRendererProjectsChanged('watcher');
    } else if (activityChanged) {
      notifyRendererProjectsChanged('activity');
    }
  }

  function recordChange(folder, relPath) {
    const existing = pendingChanges.get(folder);
    if (existing === true) return;
    if (relPath === null) {
      pendingChanges.set(folder, true);
      return;
    }
    if (existing instanceof Set) {
      existing.add(relPath);
    } else {
      pendingChanges.set(folder, new Set([relPath]));
    }
  }

  try {
    projectsWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        // Top-level folder add/remove — must re-scan the whole folder
        recordChange(folder, null);
      } else if (basename.endsWith('.jsonl')) {
        // Specific .jsonl changed — targeted refresh on just this file
        const rel = parts.slice(1).join(path.sep);
        recordChange(folder, rel);
        // out-of-band signal for the local-transcript adapter — see .ai/contexts/session-state.md
        localTranscriptTracker.record(parts);
      } else if (parts.length === 4 && parts[2] === 'workflows' && /^wf_[a-z0-9-]{6,}\.json$/.test(basename)) {
        pendingWorkflowTitles.add(filename);
      } else {
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => flushChanges().catch(err => log.error('[projects] watcher refresh failed:', err.message)), 500);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// --- IPC: auto-updater ---
ipcMain.handle('updater-check', () => {
  if (!autoUpdater) return { available: false, dev: true };
  return autoUpdater.checkForUpdates();
});
ipcMain.handle('updater-download', () => {
  if (!autoUpdater) return;
  return autoUpdater.downloadUpdate();
});
ipcMain.handle('updater-install', async () => {
  if (!autoUpdater) return;
  if (updateInstallPromise) return updateInstallPromise;
  if (mainWindow && !await unsavedGuard.confirmQuit(mainWindow)) return;
  if (updateInstallPromise) return updateInstallPromise;
  const installWindow = mainWindow;
  const installToken = installWindow ? unsavedGuard.committedToken(installWindow) : null;
  if (installWindow) quitAttemptToken = installToken;
  const operation = (async () => {
    await drainForUpdate();
    if (installWindow && installToken !== unsavedGuard.committedToken(installWindow)) {
      if (updateInstallPromise === operation) updateInstallPromise = null;
      return;
    }
    try {
      if (process.platform === 'linux') {
        if (!autoUpdater.install(false, false)) {
          resetUpdateAttempt();
          return;
        }
        await relaunch({ execPath: relaunchExecPath, log, notify: notifyRelaunchRequired,
          quit: () => { updateInstalling = true; app.quit(); } });
      } else {
        autoUpdater.quitAndInstall();
        if (process.platform === 'win32' && autoUpdater.quitAndInstallCalled === false) resetUpdateAttempt();
        else if (process.platform === 'darwin' && !updateInstalling) {
          updateWaitTimer = setTimeout(resetUpdateAttempt, 30000);
          updateWaitTimer.unref?.();
        }
      }
    }
    catch (error) {
      resetUpdateAttempt();
      log.error('[updater] install failed:', error);
      throw error;
    }
  })();
  updateInstallPromise = operation;
  return operation;
});

function notifyRelaunchRequired(message) {
  return new Promise(resolve => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) { log.warn('[relaunch]', message); resolve(); return; }
    const finish = () => {
      ipcMain.removeListener('updater-close', onClose);
      win.removeListener('closed', finish);
      resolve();
    };
    const onClose = event => { if (event.sender === win.webContents) finish(); };
    ipcMain.on('updater-close', onClose);
    win.once('closed', finish);
    win.webContents.send('updater-event', 'relaunch-required', { message });
  });
}

// --- App lifecycle ---
// Differentiate the dev build from the released binary in the OS task switcher,
// dock, and About menu by suffixing the app name. No-op in packaged builds.
if (!app.isPackaged) {
  app.setName('Switchboard (dev)');
}

// Prevent a second Electron instance from killing active PTY sessions.
// This happens when the user replaces the AppImage while Switchboard is running:
// the OS spawns the new binary, which would otherwise initialise a second process
// and leave the first one's node-pty sessions orphaned or killed.
// requestSingleInstanceLock ensures only one instance runs at a time. The second
// launch quits immediately; the first brings its window to the front.
{
  // Focus the existing window when a second launch is attempted.
  app.on('second-instance', () => {
    if (updateInstalling) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await legacySearchCleanup;
    // Content Security Policy — restrict what the renderer can load or execute.
    // 'unsafe-inline' for style-src is required because the app sets .style.*
    // properties via JavaScript and style.css uses data: URIs in background-image.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'",
          ],
        },
      });
    });

    buildMenu();
    createWindow();
    startProjectsWatcher();
    // No declared host => no timer and no ssh call. see .ai/contexts/session-cache.md ("Remote SSH hosts")
    remoteIndexer.start();
    syncRemoteWatchers();
    cliSessionState.ensureWatching();
    bgAgents.start();
    // Remove IDE lock files left behind by a crashed instance whose PID was
    // reused (the function only unlinks locks matching our own pid).
    cleanStaleLockFiles(log);
    scheduleIpc.ensureScheduleCreatorCommand();

    // Shared runCommand for cron scheduler and "run now" — takes argv, not a shell string
    const { spawn: cpSpawn } = require('child_process');
    async function runScheduleCommand(claudeArgv, cwd, name, onDone, { manual = false } = {}) {
      const runName = manual ? `Manual run ${name}` : name;
      const globalSettings = getSetting('global') || {};
      if (isProjectSettingsArchived(cwd)) {
        log.info(`[schedule] ${runName} suspended: project is archived`);
        if (onDone) onDone();
        return { ok: false, error: 'Project is archived; unarchive it before running schedules.' };
      }
      const profileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
      const profile = resolveShell(profileId);
      const shell = profile.path;
      // see .ai/contexts/schedule-runner.md
      let cmd = 'claude ' + quoteArgvForShell(shell, claudeArgv);
      const env = { ...cleanPtyEnv, FORCE_COLOR: '0' };

      const sandbox = resolveScheduleSandbox(cwd, getSetting, SETTING_DEFAULTS.sandbox);
      if (sandbox && process.platform !== 'linux') {
        log.error(`[schedule] ${runName}: skipped — sandbox is enabled but requires Linux (bubblewrap)`);
        if (onDone) onDone();
        return { ok: false, error: 'The schedule sandbox requires Linux (bubblewrap). Run it on Linux with bubblewrap, or disable Sandbox in the project or global settings and try Run now again.' };
      }
      if (sandbox) {
        cmd = quoteArgvForShell(shell, ['bash', sandboxScriptPath()]) + ' ' + quoteArgvForShell(shell, claudeArgv);
        const addDirs = [];
        for (let i = 0; i < claudeArgv.length - 1; i++) {
          if (claudeArgv[i] === '--add-dir') addDirs.push(claudeArgv[i + 1]);
        }
        // see docs/sandbox.md ("Schedules")
        const refused = scheduleBindRefusals(addDirs, await scheduleProjects().list(), os.homedir(), cwd);
        if (refused.length) {
          log.error(`[schedule] ${runName}: skipped — add-dirs refused: ${refused.map(r => `${r.dir} (${r.reason})`).join(', ')}`);
          if (onDone) onDone();
          return { ok: false, error: `Sandbox add-dirs refused: ${refused.map(r => `${r.dir} (${r.reason})`).join(', ')}. Remove or change these add-dirs in the schedule file, then try Run now again.` };
        }
        const bindEnv = sandboxBindEnv(addDirs);
        if (bindEnv) env.SWITCHBOARD_SANDBOX_BINDS = bindEnv;
        env.SWITCHBOARD_SANDBOX_PROJECT_FOLDER = encodeProjectPath(cwd);
      }
      const args = shellArgs(shell, cmd, profile.args || []);

      log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
      const spawnFailure = err => ({ ok: false, error: `Could not start the schedule: ${err.message || String(err)}. Check the shell settings and project folder, then try Run now again.` });
      let child;
      try {
        child = cpSpawn(shell, args, {
          cwd,
          stdio: ['ignore', 'ignore', 'pipe'],
          env,
        });
      } catch (err) {
        log.error(`[schedule] ${runName} error:`, err.message);
        if (onDone) onDone();
        return spawnFailure(err);
      }
      cliSessionState.trackScheduleRun(claudeArgv[claudeArgv.indexOf('--resume') + 1], child, cwd, runName);
      // see .ai/contexts/activitywatch.md ("Running")
      const activityId = `schedule:${runName}:${Date.now()}`;
      activityReporter.sessionStarted({ sessionId: activityId, project: cwd, name: `Scheduled: ${runName}` });

      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('exit', (code, signal) => {
        if (stderr.trim()) log.error(`[schedule] ${runName} stderr:\n${stderr.trim()}`);
        log.info(`[schedule] ${runName} finished (exit ${code})`);
        scheduleIpc.reportRunExit(mainWindow, {
          name, projectPath: cwd, sessionId: claudeArgv[claudeArgv.indexOf('--resume') + 1],
          manual, code, signal, sandbox, stderr,
        });
        activityReporter.sessionEnded(activityId);
        if (onDone) onDone();
      });

      return new Promise(resolve => {
        child.once('spawn', () => resolve({ ok: true }));
        child.on('error', (err) => {
          log.error(`[schedule] ${runName} error:`, err.message);
          activityReporter.sessionEnded(activityId);
          if (onDone) onDone();
          resolve(spawnFailure(err));
        });
      });
    }

    scheduleIpc.init(log, runScheduleCommand, isAllowedMemoryPath, isProjectSettingsArchived);
    // Seeded before any session can run, so a sandboxed one cannot plant into the seed.
    await scheduleProjects().list();
    stopScheduler = startScheduler(log, runScheduleCommand, {
      resumeSource: powerMonitor,
      stateDir: path.join(path.dirname(DB_PATH), 'schedule-state'),
      projects: async () => (await scheduleProjects().list()).filter(p => !isProjectSettingsArchived(p)),
    });

    // File-trigger watcher — allows harness scripts to inject input into open
    // PTY sessions by dropping a JSON file in ~/.switchboard/triggers/.
    // I3: wrapped in try/catch so a boot failure here doesn't abort
    // app.whenReady (auto-updater, etc. would otherwise be silently lost).
    try {
      require('./trigger-watcher').start(createTriggerContext({
        activeSessions, log, getCliStatus: (id) => cliSessionState.getStatus(id), projectsDir: PROJECTS_DIR,
        getLiveDescriptor: (id) => cliSessionState.findLiveProcess(id),
        resolveSessionId: (id) => sessionTransitions.currentSessionId(id),
        get remote() {
          const settings = getSetting('global') || {};
          if ((settings.remoteTriggers ?? SETTING_DEFAULTS.remoteTriggers) === true) {
            const aliases = new Set(enabledHosts(settings.remoteHosts).map(host => host.alias));
            return {
              indexer: remoteIndexer,
              adapter: remoteSendAdapter,
              isEnabled: alias => aliases.has(alias),
              maxAgeMs: 2 * normalizeRefreshMs(settings.remoteRefreshMs),
            };
          }
          return undefined;
        },
      }));
    } catch (err) {
      log.error('[trigger-watcher] Failed to start trigger watcher:', err.message);
    }

    // Full cache rebuild on every startup — prunes stale rows for deleted
    // transcripts (sub-agent/workflow runs cleaned up between sessions leave
    // ghost rows in session_cache that show in the sidebar but are
    // inaccessible on open). populateCacheViaWorker runs in a Worker thread
    // and is non-blocking; concurrent callers share the same in-flight
    // Promise so the FTS-recreated path below (if also triggered) is free.
    populateCacheViaWorker().then(sweepContinuationChoices).catch(error => log.warn('[continuation-choices] startup sweep failed:', error));

    // Re-index search if FTS table was recreated (e.g. tokenizer config change).
    // populateCacheViaWorker is already running above; the guard inside it
    // (populatePromise !== null) means this is a no-op on the same tick and
    // returns the shared Promise — no double scan.
    if (searchFtsRecreated) populateCacheViaWorker();

    // Check for updates after launch
    if (autoUpdater) {
      applyUpdateChannel();
      // Read the setting here rather than at the updater's construction: that
      // block runs before db.js is required, so getSetting isn't available yet.
      // Nothing checks for updates before this point, so overriding the flags
      // now is early enough.
      const autoUpdate = (getSetting('global') || {}).autoUpdate !== false;
      autoUpdater.autoDownload = autoUpdate;
      autoUpdater.autoInstallOnAppQuit = autoUpdate;
      if (!autoUpdate) {
        log.info('[updater] automatic updates disabled by setting — not checking');
      } else {
        setTimeout(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 5000);
        // Re-check every 4 hours for long-running sessions
        setInterval(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 4 * 60 * 60 * 1000);
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }); // end app.whenReady
} // end gotSingleInstanceLock else-branch

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { quitAttemptToken = unsavedGuard.committedToken(mainWindow) || quitAttemptToken; app.quit(); }
});

let appQuitting = false;

// see .ai/contexts/session-index-writer.md
let shutdownPromise;
let shutdownComplete = false;
let exitRequested = false;
function exitOnce() {
  if (exitRequested || !shutdownComplete) return;
  exitRequested = true;
  app.exit();
}
let nonDatabaseResourcesStopped = false;
let taskRecordsStopped;
function stopNonDatabaseResources(closeTrace = false) {
  if (nonDatabaseResourcesStopped) return;
  nonDatabaseResourcesStopped = true;
  const cleanup = [
    () => stopScheduler?.(), () => mainLoopMonitor.stop(), () => shutdownAllMcp(),
    () => localTranscriptTracker.dispose(), () => unsubscribeTaskJobs(),
    () => { taskRecordsStopped = Promise.resolve().then(() => taskRecords.dispose()); return taskRecordsStopped; },
    () => { if (projectsWatcher) { projectsWatcher.close(); projectsWatcher = null; } },
    () => cliSessionState.stop(), () => bgAgents.stop(), () => remoteIndexer.dispose(),
    () => remoteWatcher.stopAll(), () => remoteActivityTracker.dispose(),
    ...(closeTrace ? [() => activityTrace.close()] : []),
  ];
  for (const dispose of cleanup) {
    try { Promise.resolve(dispose()).catch(error => log.error('[shutdown] cleanup failed:', error)); }
    catch (error) { log.error('[shutdown] cleanup failed:', error); }
  }
}
async function stopWorkersForExit() {
  let timer;
  const stop = [() => writer.terminate(), () => projectsClient.shutdown(),
    () => fileListsClient.shutdown(), () => searchClient.shutdown(),
    () => sessionCache.shutdownProducers(), () => taskRecordsStopped];
  const stopped = Promise.all(stop.map(fn => Promise.resolve().then(fn))).then(() => true, error => {
    log.error('[shutdown] worker termination failed:', error);
    return new Promise(() => {});
  });
  try {
    return await Promise.race([stopped, new Promise(resolve => {
      timer = setTimeout(() => {
        exitRequested = true;
        log.error('[shutdown] workers did not exit within 250 ms; force-killing own PID');
        process.kill(process.pid, 'SIGKILL');
        resolve(false);
      }, 250);
    })]);
  } finally { clearTimeout(timer); }
}
async function boundedShutdown(drain) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(drain), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('shutdown drain timed out')), 1500);
    })]);
    return null;
  } catch (error) { log.error('[shutdown] drain failed:', error); return error; }
  finally { clearTimeout(timer); }
}
function drainForUpdate() {
  return boundedShutdown(async () => {
    await Promise.all([flushProjectsBeforeExit(), flushWindowBounds(), sessionTransitions.drainMetadataWrites(), activityReporter.flush()]);
    await writer.drain();
  });
}
function shutdownForExit() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = boundedShutdown(() => writer.beginShutdown(async () => {
    appQuitting = true;
    if (TRACE.on) trace('app.quit', null, {});
    stopNonDatabaseResources(updateInstalling);

    const sessions = new Map([...closedSessions, ...activeSessions]);
    const exitDrains = [...sessions.values()].map(session => session.exitDrain).filter(Boolean);
    for (const [id, session] of sessions) {
      if (!session.exited) killPty(session, id);
    }
    await Promise.all(exitDrains);
    await flushProjectsBeforeExit();
    await flushWindowBounds();
    await sessionCache.shutdownProducers();
    await sessionTransitions.drainMetadataWrites();
    for (const [id] of sessions) await writer.releaseLiveSession(id);
    closedSessions.clear();
    if (!activityFlushedForQuit || activityReporter.hasPendingWork) await activityReporter.flush();
    activityReporter.stop();
    activityFlushedForQuit = true;
    await Promise.all([projectsClient.shutdown(), fileListsClient.shutdown(), searchClient.shutdown()]);
    await closeDb();
    activityTrace.close();
  })).then(async error => {
    if (error?.message === 'shutdown drain timed out') log.error('[shutdown] exiting after shutdown drain timed out; unfinished writes may be lost');
    shutdownComplete = await stopWorkersForExit();
  });
  return shutdownPromise;
}

exitInventory = () => inventory(activeSessions, (record, id, status) => backgroundRefusal(record, status ?? cliSessionState.getStatus(record.realSessionId || id)?.status), (record, id) => cliSessionState.getStatus(record.realSessionId || id)?.status);
flushForLogoff = drainForUpdate;
app.removeListener('before-quit', holdBootstrapQuit);
app.on('before-quit', event => {
  if (shutdownComplete) return;
  if (!updateInstalling && unsavedGuard.beforeQuit(event, mainWindow, quitAttemptToken)) return;
  event.preventDefault();
  shutdownForExit().finally(exitOnce);
});
}

startApplication().catch(error => {
  log.error('[startup]', error);
  dialog.showErrorBox('Switchboard could not start', error.message || String(error));
  app.exit(1);
});
