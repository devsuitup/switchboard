'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const transitions = require('../session-transitions');
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
  return { session, sessions, pty, events, wire: (next = session, target = pty, key = id) => wireSessionPty(next, key, target), data: text => data(text),
    exit: () => { const pending = exits.map(fn => fn({ exitCode: 0 })); return Promise.all(pending); }, time: at => { clock = at; } };
}

test('FIX4 rekey carries the wired generation through real fork detection to confirmed exit', async t => {
  const h = rig(), nextId = '20000000-0000-4000-8000-000000000001';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-status-rekey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = 'project'; fs.mkdirSync(path.join(dir, folder));
  Object.assign(h.session, { projectFolder: folder, knownJsonlFiles: new Set(), knownSubagents: new Map() });
  transitions.init({ PROJECTS_DIR: dir, activeSessions: h.sessions,
    getMainWindow: () => null, log: { info() {}, warn() {}, debug() {}, error() {} },
    rekeyMcpServer() {}, setTimeout: () => ({ unref() {} }) });
  fs.writeFileSync(path.join(dir, folder, nextId + '.jsonl'), JSON.stringify({ type: 'user', forkedFrom: { sessionId: id } }) + '\n');
  transitions.detectSessionTransitions(folder);
  assert.equal(h.sessions.get(nextId), h.session, 'real detection must publish the rekey');
  h.pty.statusTreeExit = Promise.resolve({ ended: true, observedAt: 50 });
  await h.exit();
  await new Promise(resolve => setImmediate(resolve));
  const service = createSessionStatus({ activeSessions: h.sessions, exits: h.sessions.statusExits,
    getKnown: sessionId => ({ sessionId }), probe: async () => ({ known: true, live: null }) });
  const result = await service.gather(nextId);
  assert.equal(result.state, 'exited', 'rekeyed exit must retain its wired generation');
  assert.equal(result.evidence, 'confirmed-exit');
  assert.equal(h.sessions.statusGenerations.has(id), false, 'old identity must release its generation');
  h.sessions.statusExits.set(id, { confirmed: true, generation: h.session.generation, at: 50 });
  assert.equal((await service.gather(id)).evidence, 'none', 'discarded identity cannot authorize an old proof');
});

test('FIX4 generations are bounded by live sessions and retained exit proofs', async () => {
  const h = rig();
  await h.exit();
  assert.equal(h.sessions.statusGenerations.size, 0, 'raw exit must discard its generation');
  let firstProof;
  for (let i = 0; i < 300; i++) {
    const key = `closed-${i}`;
    let exit;
    const pty = { pid: 43 + i, statusTreeExit: Promise.resolve({ ended: true, observedAt: 50 }),
      onData() {}, onExit(fn) { exit = fn; } };
    const session = { kind: 'local-pty', pty };
    h.sessions.set(key, session); h.wire(session, pty, key);
    await exit({ exitCode: 0 });
    await new Promise(resolve => setImmediate(resolve));
    if (!i) firstProof = h.sessions.statusExits.get(key);
  }
  assert.ok(h.sessions.statusExits.size <= 256, 'exit proof retention must be bounded');
  assert.equal(h.sessions.statusGenerations.size, h.sessions.statusExits.size, 'evicted proofs must release their generations');
  assert.equal(h.sessions.statusGenerations.has('closed-0'), false);
  h.sessions.statusExits.set('closed-0', firstProof);
  const service = createSessionStatus({ activeSessions: h.sessions, exits: h.sessions.statusExits,
    getKnown: sessionId => ({ sessionId }), probe: async () => ({ known: true, live: null }) });
  assert.equal((await service.gather('closed-0')).evidence, 'none', 'pruning must not allow stale proof reuse');
});

test('F2: old observation after a reopened id exits cannot prove the new generation dead', async () => {
  const h = rig(); let resolveOld, exitNew;
  h.pty.statusTreeExit = new Promise(resolve => { resolveOld = resolve; });
  const finishing = h.exit();
  try {
    assert.equal(h.sessions.has(id), false, 'old exit cleanup must finish before its observation');
    const nextPty = { pid: 43, onData() {}, onExit(fn) { exitNew = fn; } };
    const next = { kind: 'local-pty', pty: nextPty };
    h.sessions.set(id, next); h.wire(next, nextPty);
    assert.notEqual(next.generation, h.session.generation);
    await exitNew({ exitCode: 0 });
    assert.equal(h.sessions.has(id), false, 'the reopened generation has also finished');
    resolveOld({ ended: true, observedAt: 50 });
    await finishing;
    await new Promise(resolve => setImmediate(resolve));
    const service = createSessionStatus({ activeSessions: h.sessions, exits: h.sessions.statusExits,
      getKnown: () => ({ sessionId: id }), probe: async () => ({ known: true, live: null }) });
    const result = await service.gather(id);
    assert.equal(result.state, 'unknown', 'an old observation must not prove the reopened generation dead');
    assert.equal(result.evidence, 'none');
    assert.equal(result.evidence_at, null);
  } finally { resolveOld(null); await finishing; }
});
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
