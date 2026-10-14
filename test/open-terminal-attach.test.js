// test/open-terminal-attach.test.js — main.js boots Electron, so these are source-level pins; see .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

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

test('window close releases the Agents subscriber and app quit stops the job watchers', () => {
  const idx = MAIN.indexOf("mainWindow.on('closed'");
  const end = MAIN.indexOf('\n  });', idx) + '\n  });'.length;
  const vm = require('node:vm');
  let closed, beforeQuit, unsubscribed = 0, stopped = 0;
  const context = {
    mainWindow: { on: (_name, callback) => { closed = callback; } },
    activeSessions: new Map(), changesWatchers: { closeAll() {} }, closeAllFileWatchers() {},
    subagentWatchers: new Map(), unsubscribeBgAgents: () => { unsubscribed++; },
    bgAgents: { stop: () => { stopped++; } },
    app: { on: (_name, callback) => { beforeQuit = callback; } },
    unsavedGuard: { beforeQuit: () => false }, activityFlushedForQuit: false,
    activityReporter: { hasPendingWork: false, stop() {} }, mainLoopMonitor: { stop() {} },
    TRACE: { on: false }, activityTrace: { close() {} }, shutdownAllMcp() {},
    localTranscriptTracker: { dispose() {} }, remoteActivityTracker: { dispose() {} }, projectsWatcher: null,
    cliSessionState: { stop() {} }, remoteIndexer: { dispose() {} }, remoteWatcher: { stopAll() {} },
    appQuitting: false,
  };
  vm.runInNewContext(MAIN.slice(idx, end), context);
  closed();
  assert.equal(unsubscribed, 1);
  assert.equal(stopped, 0, 'closing the window keeps the jobs cache active');
  const quitStart = MAIN.indexOf("app.on('before-quit'");
  const quitEnd = MAIN.indexOf('\n});', quitStart) + '\n});'.length;
  vm.runInNewContext(MAIN.slice(quitStart, quitEnd), context);
  beforeQuit({});
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
  const register = new Function('activeSessions', 'sessionId', 'session', 'isAttach', 'isPlainTerminal',
    'revealIfSdkSession', 'notifyRendererProjectsChanged', MAIN.slice(start, end));
  const active = new Map();
  let notifications = 0;
  register(active, 'bg-head', { isAttach: true }, true, false, () => {}, () => { notifications++; });
  assert.equal(active.has('bg-head'), true);
  assert.equal(notifications, 1);
  register(active, 'ordinary', {}, false, false, () => {}, () => { notifications++; });
  assert.equal(notifications, 1);
});
