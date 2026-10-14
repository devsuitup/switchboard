'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppFunctions } = require('./app-source');

function setup() {
  const messages = [], ended = [], dead = [], sessions = new Map();
  let exit;
  const session = { realSessionId: 'old', backgrounding: true, kind: 'local-pty' };
  sessions.set('old', session);
  const ctx = vm.createContext({
    ptyGenerationCounter: 0,
    TRACE: { on: false },
    ptyExitSignalName: () => null,
    shutdownMcpServer() {},
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } },
    appQuitting: false,
    activeSessions: sessions,
    exitedRemoteSessionIds: new Set(),
    activityReporter: { sessionEnded: id => ended.push(id) },
    taskRecords: { ownerDied: id => dead.push(id) },
    sessionCache: { releaseLiveSession: () => false },
    notifyRendererProjectsChanged() {},
    log: { warn() {} },
    holdBackgroundExit: (s, finish) => { s.backgroundExit = finish; return true; },
  });
  const { wireSessionPty } = loadAppFunctions(ctx, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(session, 'old', { onData() {}, onExit: fn => { exit = fn; } });
  return { session, messages, sessions, exit, ended, dead };
}

test('M1: shipped PTY exit wiring holds process-exited until handoff settles', () => {
  const h = setup();
  h.exit({ exitCode: 0 });
  assert.equal(h.session.exited, true);
  assert.deepEqual(h.messages, []);
  assert.equal(typeof h.session.backgroundExit, 'function');
  h.session.backgroundExit(true);
  assert.deepEqual(h.messages, []);
  assert.equal(h.sessions.has('old'), false);
});

test('M2: a failed handoff releases ordinary exit once and does not remove a replacement session', () => {
  const h = setup();
  h.exit({ exitCode: 1 });
  assert.deepEqual(h.messages, []);
  const replacement = {};
  h.sessions.set('old', replacement);
  h.session.backgroundExit(false);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0][0], 'process-exited');
  assert.equal(h.sessions.get('old'), replacement);
  assert.deepEqual(h.ended, []);
});

test('the interactive exit does not terminate the tasks of a confirmed background continuation', () => {
  const h = setup();
  h.exit({ exitCode: 0 });
  assert.deepEqual(h.dead, []);
  h.session.realSessionId = 'bg';
  h.sessions.delete('old');
  h.sessions.set('bg', h.session);
  h.session.backgroundExit(true);
  assert.deepEqual(h.dead, []);
  assert.equal(h.sessions.has('bg'), false);
});

function ipcSetup(t, { status = 'idle' } = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bg-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'folder'));
  const transcript = path.join(root, 'folder', 'OLD.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'hello' } }) + '\n');
  const writes = [], kills = [], listeners = new Set(), statusAsked = [], taps = [];
  let descriptors = [];
  const session = { kind: 'local-pty', realSessionId: 'OLD', projectFolder: 'folder', composerState: require('../composer-state').createComposerState(), pty: { onData: fn => { const tap = { fn, disposed: false, dispose() { tap.disposed = true; } }; taps.push(tap); return tap; } } };
  const ctx = vm.createContext({
    setTimeout, clearTimeout, Date, Promise, path, PROJECTS_DIR: root,
    detectSessionTransitions() {},
    activeSessions: new Map([['tab', session]]),
    mainWindow: { isDestroyed: () => false, webContents: { send() {} } },
    writePty: (entry, text) => {
      writes.push(text);
      if (text === '\r') {
        fs.appendFileSync(transcript, JSON.stringify({ type: 'continued-in', sessionId: 'OLD', continuedInSessionId: 'new' }) + '\n');
        setTimeout(() => { descriptors = [{ kind: 'bg', sessionId: 'new', jobId: '1234abcd', cwd: '/bg' }]; for (const fn of [...listeners]) fn(); }, 10);
      }
      return true;
    },
    killPty: entry => { kills.push(entry); },
    cliSessionState: {
      getStatus: id => { statusAsked.push(id); return descriptors.length ? null : { status, waitingFor: null }; },
      readAllDescriptors: () => descriptors,
      onDescriptorsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    ...require('../bg-handoff'),
  });
  const { handleSendToBackground } = loadAppFunctions(ctx, { functions: ['handleSendToBackground'], sourcePath: path.join(__dirname, '../main.js') });
  return { handleSendToBackground, session, writes, kills, listeners, statusAsked, taps };
}

test('M3: the shipped IPC handler maps CLI status, reads the tab transcript and wakes on descriptor changes', async t => {
  const h = ipcSetup(t);
  const started = Date.now();
  const result = await h.handleSendToBackground({}, 'tab');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, oldSessionId: 'tab', jobId: '1234abcd', sessionId: 'new', cwd: '/bg' });
  assert.deepEqual(h.writes, ['/bg', '\r']);
  assert.ok(Date.now() - started < 5000);
  assert.equal(h.statusAsked.every(id => id === 'OLD'), true);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.taps.length, 1);
  assert.equal(h.taps[0].disposed, true);
});

test('M4: the shipped IPC handler refuses a waiting CLI status object before any write', async t => {
  const h = ipcSetup(t, { status: 'waiting' });
  const result = await h.handleSendToBackground({}, 'tab');
  assert.equal(result.code, 'refused');
  assert.deepEqual(h.writes, []);
});
