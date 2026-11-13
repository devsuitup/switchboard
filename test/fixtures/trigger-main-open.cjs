'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const filename = path.resolve(__dirname, '../../main.js');
function fixture(overrides = {}) {
  const map = new Map(); const spawns = []; const marks = [];
  let handler;
  const context = vm.createContext({ require: createRequire(filename), process, path, fs, setTimeout, clearTimeout,
    mainWindow: { webContents: { send() {} } }, activeSessions: map,
    unsavedGuard: { launchAllowed: () => true },
    triggerRendererBridge: { consumePermit: () => null, checkPermit: () => null, markOpened: (id, session) => { marks.push([id, session]); return true; } },
    validateTriggerOpen: async permit => ({ ok: true, cwd: permit.target?.cwd }),
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    getCachedFolder: () => null, isRemoteFolder: () => false, remoteIndexer: { findSessionAlias: () => null },
    resolveSessionRealCwd: () => null, PROJECTS_DIR: path.join(process.cwd(), '.work-files', 'absent'),
    normalizePtySize: () => ({ cols: 80, rows: 24 }),
    getSetting: () => ({}), SETTING_DEFAULTS: {}, resolveShell: () => ({ path: '/bin/bash' }),
    isWslShell: () => false, log: { info() {}, warn() {}, error() {} },
    encodeProjectPath: () => 'folder', sessionTransitions: { snapshotContinuationsBeforeSpawn: async () => null },
    sessionTranscriptExists: () => false, isGitRepo: () => false,
    getHarness: require('../../harnesses').getHarness,
    claudeCommand: (_shell, args, o = {}) => (o.prefix ? o.prefix + ' ' : '') + 'claude ' + args.join(' '), quoteArgvForShell: (_shell, args) => args.join(' '), shellArgs: (_shell, cmd) => [cmd],
    startMcpServer: async () => ({ port: 12345 }), shutdownMcpServer() {},
    cleanPtyEnv: {}, scheduleProjects: () => ({ add: async () => {} }),
    spawnPty: (shell, args, opts) => { const pty = { pid: 100 + spawns.length }; spawns.push({ shell, args, opts, pty }); return pty; },
    trackWindowsPty() {}, createComposerState: () => ({ pending: 0, lastInputAt: 0 }),
    revealIfSdkSession() {}, activityReporter: { sessionStarted() {} },
    cliSessionState: { ensureWatching: () => true, deliveryPtyStart: () => '10' },
    wireSessionPty: session => { session.generation = 1; }, getMcpState: () => null,
    ...overrides,
  });
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("ipcMain.handle('open-terminal'");
  vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), context, { filename });
  const permit = { requestId: 'permit', mode: 'resume', tabKey: ID, requestedSessionId: ID, project: process.cwd(), deadline: Date.now() + 2000,
    target: { cwd: process.cwd() } };
  const authorize = () => { context.triggerRendererBridge.consumePermit = () => permit; context.triggerRendererBridge.checkPermit = () => permit; };
  return { context, map, spawns, marks, permit, authorize, invoke: (...args) => handler(...args),
    open: (requestId = 'permit', isNew = false, options = {}) => handler({}, ID, process.cwd(), isNew, { mcpEmulation: false, ...options }, null, requestId) };
}

module.exports = { fixture, ID,  };
