'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppFunctions } = require('./app-source');

function setup() {
  const messages = [], ended = [], sessions = new Map();
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
    sessionCache: { releaseLiveSession: () => false },
    notifyRendererProjectsChanged() {},
    log: { warn() {} },
    holdBackgroundExit: (s, finish) => { s.backgroundExit = finish; return true; },
  });
  const { wireSessionPty } = loadAppFunctions(ctx, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(session, 'old', { onData() {}, onExit: fn => { exit = fn; } });
  return { session, messages, sessions, exit, ended };
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
