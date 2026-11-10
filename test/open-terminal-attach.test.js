// test/open-terminal-attach.test.js — main.js boots Electron, so these are source-level pins; see .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MAIN_FILENAME = path.join(__dirname, '..', 'main.js');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

function launchFixture() {
  const handlers = new Map(), spawned = [];
  const root = path.resolve(__dirname, '..');
  const context = {
    require: require('node:module').createRequire(MAIN_FILENAME), fs, path, os: require('node:os'), process,
    mainWindow: {}, unsavedGuard: { launchAllowed: () => true }, activeSessions: new Map(),
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    getCachedFolder: () => null, isRemoteFolder: () => false, remoteIndexer: { findSessionAlias: () => null },
    resolveSessionRealCwd: () => root, PROJECTS_DIR: path.join(root, '.work-files', 'gate-transcripts'),
    encodeProjectPath: require('../encode-project-path').encodeProjectPath,
    normalizePtySize: require('../src/main/terminals/pty-size').normalizePtySize,
    getSetting: () => ({}), SETTING_DEFAULTS: { shellProfile: 'test' },
    resolveShell: () => ({ path: '/bin/bash' }), isWslShell: () => false,
    log: { info() {}, warn() {}, error() {} },
    sessionTransitions: { snapshotContinuationsBeforeSpawn: async () => null },
    sessionTranscriptExists: () => true, getHarness: require('../harnesses').getHarness,
    quoteArgvForShell: (_shell, args) => args.join(' '), shellArgs: (_shell, cmd) => [cmd],
    cleanPtyEnv: {}, scheduleProjects: () => ({ add: async () => {} }),
    activityReporter: { sessionStarted() {} },
    cliSessionState: { ensureWatching: () => true },
    spawnPty: (...args) => { spawned.push(args); return { pid: 4242 }; }, trackWindowsPty() {},
    createComposerState: require('../src/main/terminals/composer-state').createComposerState,
    revealIfSdkSession() {}, notifyRendererProjectsChanged() {}, wireSessionPty() {}, getMcpState: () => null,
  };
  const start = MAIN.indexOf("ipcMain.handle('open-terminal'");
  vm.runInNewContext(MAIN.slice(start, MAIN.indexOf('\n});', start) + 4), context, {
    filename: MAIN_FILENAME, lineOffset: MAIN.slice(0, start).split('\n').length - 1,
  });
  return { root, context, spawned, open: (id, project, isNew, options) => handlers.get('open-terminal')(null, id, project, isNew, { mcpEmulation: false, ...options }) };
}

for (const [mode, isNew, options] of [['new', true, {}], ['resume', false, {}], ['fork', true, { forkFrom: 'source' }]]) {
  test(`held project refuses open-terminal ${mode} and release restores the launch`, async t => {
    const h = launchFixture();
    const { projectOperationGate } = require('../src/main/shared/project-operation-gate');
    const held = projectOperationGate.hold(h.root);
    t.after(() => held.release());
    const refused = await h.open(mode, h.root, isNew, options);
    assert.equal(refused.ok, false, `held project must refuse open-terminal ${mode}`);
    assert.match(refused.error, /project.*operation|being deleted/i);
    assert.equal(h.spawned.length, 0);
    held.release();
    const result = await h.open(mode, h.root, isNew, options);
    assert.equal(result.ok, true, result.error);
    assert.equal(h.spawned.length, 1);
  });
}

test('open-terminal keeps an admitted asynchronous launch reserved until the PTY is registered', async t => {
  const h = launchFixture();
  let finishSnapshot;
  h.context.sessionTransitions.snapshotContinuationsBeforeSpawn = () => new Promise(resolve => { finishSnapshot = resolve; });
  const pending = h.open('pending', h.root, true, {});
  assert.equal(typeof finishSnapshot, 'function');
  const { projectOperationGate } = require('../src/main/shared/project-operation-gate');
  const held = projectOperationGate.hold(h.root);
  t.after(() => held.release());
  let ready = false;
  held.ready.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false, 'hold must wait for open-terminal asynchronous preparation');
  assert.equal((await h.open('late', h.root, true, {})).ok, false);
  assert.equal(h.spawned.length, 0);
  finishSnapshot(null);
  assert.equal((await pending).ok, true);
  await held.ready;
  assert.equal(h.context.activeSessions.has('pending'), true);
});

test('background handoff is registered and the local record retains pre-launch eligibility', () => {
  assert.match(MAIN, /ipcMain\.handle\('send-session-to-background'/);
  assert.match(MAIN, /preLaunch: !isAttach && !!sessionOptions\?\.preLaunchCmd/);
  assert.match(PRELOAD, /sendSessionToBackground:.*invoke\('send-session-to-background'/);
});

test('a held physical exit cannot be reported as a live reattach during handoff', () => {
  const idx = MAIN.indexOf("ipcMain.handle('open-terminal'");
  assert.match(MAIN.slice(idx, idx + 900), /if \(session\.backgrounding && session\.exited\) return \{ ok: false/);
});

test('open-terminal builds `claude attach <id>` for an attach session and never a --resume', () => {
  assert.match(MAIN, /const isAttach = sessionOptions\?\.type === 'attach';/);
  assert.match(MAIN, /claudeArgs\.push\('attach', attachJobId\);/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.sandbox\)/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.preLaunchCmd\)/);
  assert.match(MAIN, /if \(!isAttach && sessionOptions\?\.mcpEmulation !== false\)/);
  assert.match(MAIN, /isAttach, attachJobId,/, 'the session record must carry both fields');
});

test('a reattach reports whether the live session is an attach, and the renderer keeps it on the tab', () => {
  assert.match(MAIN, /ok: true, reattached: true, attach: !!session\.isAttach,/);
  const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = APP.indexOf('async function openSessionNow(');
  const body = APP.slice(start, APP.indexOf('\nasync function ', start + 10));
  const openIdx = body.indexOf('await window.api.openTerminal(sessionId');
  assert.ok(openIdx > 0);
  assert.match(body.slice(openIdx), /if \(result\.reattached\) entry\.attach = !!result\.attach;/);
});

test('an attach job id is validated against the eight-hex shape before anything is spawned', () => {
  assert.match(MAIN, /JOB_ID_RE\.test\(String\(sessionOptions\.jobId\)\)/);
});

test('stop-session detaches an attach session instead of killing it', () => {
  const idx = MAIN.indexOf("ipcMain.handle('stop-session'");
  const body = MAIN.slice(idx, idx + 600);
  assert.match(body, /if \(session\.isAttach\)/);
  assert.match(body, /detachPty\(session, sessionId\)/);
  assert.match(body, /detached: true/);
});

test('window close releases the Agents subscriber and app quit stops the job watchers', async () => {
  const idx = MAIN.indexOf("mainWindow.on('closed'");
  const end = MAIN.indexOf('\n  });', idx) + '\n  });'.length;
  let closed, _beforeQuit, unsubscribed = 0, stopped = 0;
  const context = {
    managedBrowser: { stopForQuit() {} },
    mainWindow: { on: (_name, callback) => { closed = callback; } },
    activeSessions: new Map(), closedSessions: new Map(), changesWatchers: { closeAll() {} }, closeAllFileWatchers() {},
    transcriptFollower: require('../src/main/viewer/transcript-follower').createTranscriptFollower(),
    subagentWatchers: new Map(), unsubscribeBgAgents: () => { unsubscribed++; },
    unsubscribeTaskJobs() {}, taskRecords: { dispose() {} },
    bgAgents: { stop: () => { stopped++; } },
    app: { on: (_name, callback) => { _beforeQuit = callback; } },
    unsavedGuard: { beforeQuit: () => false, committedToken: () => null, invalidate() {} }, activityFlushedForQuit: false,
    activityReporter: { hasPendingWork: false, stop() {} }, mainLoopMonitor: { stop() {} },
    TRACE: { on: false }, activityTrace: { close() {} }, shutdownAllMcp() {},
    localTranscriptTracker: { dispose() {} }, remoteActivityTracker: { dispose() {} }, projectsWatcher: null,
    cliSessionState: { stop() {} }, remoteIndexer: { dispose() {} }, remoteWatcher: { stopAll() {} },
    appQuitting: false, updateInstalling: false, quitAttemptToken: null, process: { platform: 'win32' },
  };
  vm.runInNewContext(MAIN.slice(idx, end), context, { filename: MAIN_FILENAME, lineOffset: MAIN.slice(0, idx).split('\n').length - 1 });
  closed();
  assert.equal(unsubscribed, 1);
  assert.equal(stopped, 0, 'closing the window keeps the jobs cache active');
  context.stopScheduler = () => {};
  context.flushProjectsBeforeExit = context.flushWindowBounds = async () => {};
  context.sessionCache = { shutdownProducers: async () => {} };
  context.sessionTransitions = { drainMetadataWrites: async () => {} };
  context.activityReporter.flush = async () => {};
  context.projectsClient = context.fileListsClient = context.searchClient = { shutdown: async () => {} };
  context.closeDb = async () => {};
  context.writer = { beginShutdown: drain => drain(), terminate: async () => {} };
  context.Promise = Promise;
  context.setTimeout = setTimeout;
  context.clearTimeout = clearTimeout;
  const quitStart = MAIN.indexOf('let shutdownPromise;');
  const quitEnd = MAIN.indexOf("app.removeListener('before-quit', holdBootstrapQuit);", quitStart);
  vm.runInNewContext(MAIN.slice(quitStart, quitEnd) + '\nshutdownForExit();', context, { filename: MAIN_FILENAME, lineOffset: MAIN.slice(0, quitStart).split('\n').length - 1 });
  await context.shutdownForExit();
  assert.equal(stopped, 1, 'app quit releases the job watchers');
});

test('preload exposes the four agents-view entries', () => {
  for (const name of ['getBgAgents', 'bgAgentVerb', 'dispatchBgAgent', 'onBgAgentsChanged']) {
    assert.ok(PRELOAD.includes(name + ':'), `${name} missing from preload.js`);
  }
  assert.match(PRELOAD, /ipcRenderer\.on\('bg-agents-changed'/);
});

test('registering an attach PTY notifies the sidebar even without a transcript or descriptor event', () => {
  const start = MAIN.indexOf('  activeSessions.set(sessionId, session);');
  const end = MAIN.indexOf('  if (!isPlainTerminal && !panelOwnerId)', start);
  assert.ok(start >= 0 && end > start);
  const active = new Map();
  let notifications = 0;
  const register = (sessionId, session, isAttach) => vm.runInNewContext(MAIN.slice(start, end), {
    activeSessions: active, sessionId, session, isAttach, isPlainTerminal: false,
    revealIfSdkSession() {}, notifyRendererProjectsChanged() { notifications++; },
  }, { filename: MAIN_FILENAME, lineOffset: MAIN.slice(0, start).split('\n').length - 1 });
  register('bg-head', { isAttach: true }, true);
  assert.equal(active.has('bg-head'), true);
  assert.equal(notifications, 1);
  register('ordinary', {}, false);
  assert.equal(notifications, 1);
});
