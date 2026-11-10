'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppFunctions } = require('./app-source');
const { createSessionStatus } = require('../src/main/triggers/session-status');
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
function rig(beforeWire = () => {}) {
  let data, clock = 100;
  const exits = [], events = [];
  const pty = { pid: 42, onData: fn => { data = fn; }, onExit: fn => { exits.push(fn); } };
  const session = { pty, kind: 'local-pty' }, sessions = new Map([[id, session]]);
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ Date: Clock, ptyGenerationCounter: 0, TRACE: {}, LOG_DEBUG_ON: false,
    classifyTitleActivity: text => ({ idle: text === 'idle', busy: text === 'busy' }), appQuitting: false,
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } },
    appendToOutputBuffer() {}, MAX_BUFFER_SIZE: 1024, log: { info() {}, warn() {} },
    ptyExitSignalName: () => null, shutdownMcpServer() {}, activeSessions: sessions,
    taskRecords: { ownerDied: key => events.push(['ownerDied', key]) },
    activityReporter: { sessionEnded: key => events.push(['sessionEnded', key]) },
    writer: { releaseLiveSession: async key => { events.push(['releaseLiveSession', key]); return false; } },
    holdBackgroundExit: () => false, sessionTransitions: { holdContinuationExit: () => false },
  });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  beforeWire(pty);
  wireSessionPty(session, id, pty);
  return { session, sessions, pty, events, wire: () => wireSessionPty(session, id, pty), data: text => data(text),
    exit: () => { const pending = exits.map(fn => fn({ exitCode: 0 })); return Promise.all(pending); }, time: at => { clock = at; } };
}
test('M1: an unready Windows helper cannot delay process-exited or activeSessions deletion', async () => {
  const { EventEmitter } = require('node:events');
  const { createWindowsJobHelper } = require('../src/main/terminals/windows-job-helper');
  const { trackWindowsPty } = require('../src/main/terminals/pty-ops');
  const child = new EventEmitter(), lines = [];
  child.stdin = Object.assign(new EventEmitter(), { write: line => lines.push(line) });
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const jobs = createWindowsJobHelper({ spawn: () => child, startupMs: 15000 });
  let assignment;
  const h = rig(pty => { assignment = trackWindowsPty(pty, { platform: 'win32', jobs }); });
  const finishing = h.exit();
  try {
    assert.equal(h.sessions.has(id), false, 'exit cleanup must remove the session synchronously before helper readiness');
    assert.ok(h.events.some(e => e[0] === 'process-exited'), 'process-exited must be synchronous');
    assert.equal(await assignment, false, 'queued assignment must be cancelled');
    child.stdout.emit('data', 'ready\n');
    assert.deepEqual(lines, [], 'cancelled assignment and observation must never reach the helper');
    await finishing;
    assert.equal(h.pty.statusTreeExit, undefined, 'an unassigned job supplies no exit proof');
    const status = createSessionStatus({ activeSessions: h.sessions, exits: h.sessions.statusExits,
      getKnown: () => ({ sessionId: id }), probe: async () => ({ known: true, live: null }) });
    assert.equal((await status.gather(id)).state, 'unknown', 'raw PTY exit cannot become confirmed death');
  } finally { child.emit('exit'); }
});
test('M3: rekey during pending observation skips only the proof and still completes cleanup', async () => {
  const h = rig(); let resolve;
  h.pty.statusTreeExit = new Promise(done => { resolve = done; });
  const finishing = h.exit();
  h.session.realSessionId = '20000000-0000-4000-8000-000000000001';
  resolve({ ended: true, observedAt: 50 }); await finishing;
  assert.equal(h.sessions.has(id), false, 'a rekey must never skip exit cleanup');
  for (const name of ['ownerDied', 'process-exited', 'sessionEnded', 'releaseLiveSession']) {
    assert.ok(h.events.some(e => e[0] === name), `${name} must run despite the changed identity`);
  }
  assert.equal(h.sessions.statusExits?.size || 0, 0, 'changed identity must not retain a proof');
});
test('M1: a pending tree observation cannot delay synchronous exit cleanup', async () => {
  let resolve;
  const h = rig(); h.pty.statusTreeExit = new Promise(done => { resolve = done; });
  const finishing = h.exit();
  try {
    assert.equal(h.sessions.has(id), false, 'observation must never delay cleanup');
    assert.ok(h.events.some(e => e[0] === 'process-exited'), 'observation must never delay process-exited');
  } finally { resolve(null); await finishing; }
});
test('shipped wire records repeated OSC observations and ignores replaced generations', () => {
  const h = rig(); h.data('\x1b]0;idle\x07');
  assert.equal(h.session._statusOsc?.idleAt, 100, 'initial idle must record its original event time');
  h.time(200); h.data('\x1b]0;idle\x07'); assert.equal(h.session._statusOsc.idleAt, 200);
  h.time(300); h.data('\x1b]0;busy\x07'); assert.equal(h.session._statusOsc.busyAt, 300);
  h.time(400); h.data('\x1b]0;busy\x07'); assert.equal(h.session._statusOsc.busyAt, 400);
  h.session.generation++; h.time(500); h.data('\x1b]0;idle\x07'); assert.equal(h.session._statusOsc.idleAt, 200);
});
test('shipped finish retains asynchronous tree proof after synchronous cleanup and status consumes it', async () => {
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
  h.sessions.set(id, h.session);
  release({ ended: true, observedAt: 60 }); await finishing;
  assert.equal(h.sessions.get(id), h.session, 'awaiting old tree proof must never remove a replacement generation');
});
test('launch and source-extraction anchors remain available without loading main', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  for (const anchor of ['const { cleanEnv', 'const cleanPtyEnv =', "ipcMain.handle('open-terminal'", 'function runClaudeCommand(', 'function runScheduleCommand(']) assert.ok(source.includes(anchor));
});
test('m4: ordinary spawns retain the v1 capture condition and have a separate status pin', () => {
  const filename = path.join(__dirname, '../main.js'), source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('  const session = {', source.indexOf('if (!isAttach) void trackWindowsPty'));
  const declaration = source.slice(start, source.indexOf('\n  };', start) + 5);
  for (const triggerPermit of [null, {}]) {
    const context = vm.createContext({ triggerPermit, ptyProcess: { pid: 42 },
      cliSessionState: { deliveryPtyStart: () => 'start' }, launchMode: null, resumeSourceId: null, launchStartedAt: 1,
      projectPath: '', spawnCwd: '', projectFolder: '', knownJsonlFiles: new Set(), continuationSnapshot: null,
      isPlainTerminal: false, panelOwnerId: null, sessionOptions: {}, isAttach: false, attachJobId: null,
      mcpServer: null, mcpError: null, createComposerState: () => ({}) });
    vm.runInContext(declaration, context, { filename });
    const session = vm.runInContext('session', context, { filename });
    assert.equal(Object.hasOwn(session, 'hostPtyStart'), !!triggerPermit, 'v1 pin capture remains trigger-only');
    assert.equal(session.statusPtyStart, 'start', 'status owns its independent spawn pin');
  }
});
