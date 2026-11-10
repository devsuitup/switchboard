'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppFunctions } = require('./app-source');
const { createSessionStatus } = require('../src/main/triggers/session-status');
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
function rig() {
  let data, exit, clock = 100;
  const pty = { pid: 42, onData: fn => { data = fn; }, onExit: fn => { exit = fn; } };
  const session = { pty, kind: 'local-pty' }, sessions = new Map([[id, session]]);
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ Date: Clock, ptyGenerationCounter: 0, TRACE: {}, LOG_DEBUG_ON: false,
    classifyTitleActivity: text => ({ idle: text === 'idle', busy: text === 'busy' }), mainWindow: null,
    appendToOutputBuffer() {}, MAX_BUFFER_SIZE: 1024, log: { info() {}, warn() {} },
    ptyExitSignalName: () => null, shutdownMcpServer() {}, activeSessions: sessions,
    taskRecords: { ownerDied() {} }, activityReporter: { sessionEnded() {} }, writer: { releaseLiveSession: async () => false },
    holdBackgroundExit: () => false, sessionTransitions: { holdContinuationExit: () => false },
  });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(session, id, pty);
  return { session, sessions, pty, wire: () => wireSessionPty(session, id, pty), data: text => data(text), exit: () => exit({ exitCode: 0 }), time: at => { clock = at; } };
}
test('shipped wire records repeated OSC observations and ignores replaced generations', () => {
  const h = rig(); h.data('\x1b]0;idle\x07');
  assert.equal(h.session._statusOsc?.idleAt, 100, 'initial idle must record its original event time');
  h.time(200); h.data('\x1b]0;idle\x07'); assert.equal(h.session._statusOsc.idleAt, 200);
  h.time(300); h.data('\x1b]0;busy\x07'); assert.equal(h.session._statusOsc.busyAt, 300);
  h.time(400); h.data('\x1b]0;busy\x07'); assert.equal(h.session._statusOsc.busyAt, 400);
  h.session.generation++; h.time(500); h.data('\x1b]0;idle\x07'); assert.equal(h.session._statusOsc.idleAt, 200);
});
test('shipped finish preserves proved tree death before map removal and status consumes it', async () => {
  const h = rig(); h.pty.statusTreeExit = Promise.resolve({ ended: true, observedAt: 50 });
  await assert.doesNotReject(h.exit(), 'verified tree observation must survive the finish callback');
  assert.equal(h.sessions.has(id), false);
  assert.equal(h.sessions.statusExits?.get(id)?.at, 50, 'kernel evidence survives removal');
  const service = createSessionStatus({ activeSessions: h.sessions, exits: h.sessions.statusExits,
    getKnown: () => ({ sessionId: id }), probe: async () => ({ known: true, live: null }) });
  assert.equal((await service.gather(id)).state, 'exited');
});
test('raw exit, attach exit and a replaced generation do not invent tree death', async () => {
  for (const variant of ['raw', 'attach', 'replaced']) {
    const h = rig();
    if (variant !== 'raw') h.pty.statusTreeExit = Promise.resolve({ ended: true, observedAt: 50 });
    if (variant === 'attach') h.session.isAttach = true;
    if (variant === 'replaced') h.session.generation++;
    await h.exit(); assert.equal(h.sessions.statusExits?.has(id) || false, false);
    if (variant === 'replaced') assert.equal(h.session.exited, undefined);
  }
});
test('new PTY generation invalidates older death evidence, including during a pending old exit observation', async () => {
  const h = rig(); h.sessions.statusExits = new Map([[id, { confirmed: true, generation: 0, at: 50 }]]);
  h.wire();
  assert.equal(h.sessions.statusExits.has(id), false, 'a new generation invalidates old exit proof');
  let release;
  h.pty.statusTreeExit = new Promise(resolve => { release = resolve; });
  const finishing = h.exit(); h.session.generation++; h.session.pty = { pid: 43 }; h.session.exited = false;
  release({ ended: true, observedAt: 60 }); await finishing;
  assert.equal(h.sessions.get(id), h.session, 'awaiting old tree proof must never remove a replacement generation');
});
test('launch and source-extraction anchors remain available without loading main', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  for (const anchor of ['const { cleanEnv', 'const cleanPtyEnv =', "ipcMain.handle('open-terminal'", 'function runClaudeCommand(', 'function runScheduleCommand(']) assert.ok(source.includes(anchor));
});
