'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const os = require('node:os');
const { fixture, ID } = require('./fixtures/trigger-stop.cjs');

test('bare stop calls the shared sidebar backend once and reports closed only after pinned exit', async t => {
  const f = fixture(t); f.start(); await f.flush();
  assert.equal(f.kills(), 1, 'idle stop must initiate the normal local backend');
  assert.equal(f.done(), false, 'requesting kill is not a confirmed exit');
  assert.equal(f.markers.at(-1).phase, 'stop-requested');
  f.session.exited = true;
  const r = await f.finish();
  assert.equal(r.outcome, 'closed'); assert.equal(r.ok, true);
  assert.equal(r.wrote, false); assert.equal(r.submitted, 'no'); assert.equal(r.steps_total, 0);
  assert.deepEqual(f.events.slice(-3).map(e => e[0]), ['result', 'release-mutex', 'release-fifo']);
  assert.deepEqual(f.writes, []);
});

for (const [status, busy, reason] of [['idle', true, 'session busy'], ['busy', false, 'session busy'],
  ['waiting', false, 'session waiting on a dialog'], ['shell', false, 'session running a shell command'],
  ['unknown', false, 'session state unavailable'], [null, false, 'session state unavailable']]) {
  test(`bare stop refuses ${status}/${busy} before composer eligibility`, async t => {
    const f = fixture(t); f.setStatus(status); f.session._cliBusy = busy; f.input('pending');
    f.start(); const r = await f.finish();
    assert.equal(r.reason, reason); assert.equal(f.kills(), 0); assert.deepEqual(f.writes, []);
  });
}

for (const lostDuringWait of [false, true]) for (const pending of [false, true]) {
  test(`bare stop immediately refuses ${pending ? 'pending' : 'unobservable'} composer ${lostDuringWait ? 'during wait' : 'at admission'}`, async t => {
    const f = fixture(t); f.input('x\x7f');
    if (lostDuringWait) { f.start(); await f.flush(); assert.equal(f.kills(), 0); }
    if (pending) f.input('x'); else f.session.composerState = null;
    if (!lostDuringWait) f.start();
    const r = await f.finish(); assert.equal(r.reason, pending ? 'session has unsubmitted input' : 'session composer unavailable');
    assert.equal(f.kills(), 0); assert.deepEqual(f.writes, []);
  });
}

for (const timeout of [49, 50, 80]) {
  test(`type/delete quiet boundary with deadline ${timeout}ms never permits late stop`, async t => {
    const f = fixture(t, { timeout }); f.input('x\x7f'); f.start(); await f.flush();
    await f.tick(49); assert.equal(f.kills(), 0, 'empty composer still needs the quiet interval');
    await f.tick(1);
    if (timeout > 50) {
      assert.equal(f.kills(), 1, 'equality satisfies quiet only before deadline');
      assert.equal(f.done(), false); f.session.exited = true;
      assert.equal((await f.finish()).outcome, 'closed');
    } else {
      const r = await f.finish(); assert.equal(r.reason, 'session input not quiet');
      assert.equal(r.uncertain, undefined); assert.equal(r.wrote, false); assert.equal(r.steps_total, 0);
      await f.tick(1000); assert.equal(f.kills(), 0);
    }
  });
}

test('quiet interval restarts after type/delete and honors nondefault configuration at admission equality', async t => {
  const f = fixture(t); process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '75'; f.input('x\x7f');
  await f.tick(75); f.start(); await f.flush(); assert.equal(f.kills(), 1);
  f.session.exited = true; assert.equal((await f.finish()).outcome, 'closed');
});

test('type/delete during quiet wait restarts the same deadline', async t => {
  const f = fixture(t); f.input('x\x7f'); f.start(); await f.flush();
  await f.tick(30); f.input('y\x7f'); await f.tick(20); assert.equal(f.kills(), 0);
  await f.tick(30); assert.equal(f.kills(), 1); f.session.exited = true;
  assert.equal((await f.finish()).outcome, 'closed');
});

for (const state of ['busy', 'waiting', 'shell', 'unknown']) {
  test(`new ${state} during quiet wait cancels bare stop`, async t => {
    const f = fixture(t); f.input('x\x7f'); f.start(); await f.flush(); f.setStatus(state);
    const r = await f.finish(); assert.equal(r.reason, state === 'busy' ? 'session busy' : state === 'waiting' ? 'session waiting on a dialog'
      : state === 'shell' ? 'session running a shell command' : 'session state unavailable');
    await f.tick(1000); assert.equal(f.kills(), 0);
  });
}

for (const change of ['generation', 'pty', 'object', 'writer']) {
  test(`a changed ${change} is never retargeted`, async t => {
    const f = fixture(t); f.input('x\x7f'); f.start(); await f.flush();
    if (change === 'generation') f.session.generation++;
    if (change === 'pty') f.session.pty = { ...f.session.pty };
    if (change === 'object') f.map.set(ID, { ...f.session });
    if (change === 'writer') f.writer('writer-2');
    const r = await f.finish(); assert.equal(r.reason, 'session target changed'); assert.equal(f.kills(), 0);
  });
}

test('kill without exit times out as unconfirmed, preserving uncertainty', async t => {
  const f = fixture(t, { timeout: 60 }); f.start(); const r = await f.finish();
  assert.equal(r.reason, 'session stop not confirmed'); assert.equal(r.uncertain, true); assert.equal(f.kills(), 1);
  assert.equal(r.wrote, false); assert.equal(r.steps_total, 0);
});

test('before on a busy target waits, delivers one note and holds stop until completed turn', async t => {
  const f = fixture(t); f.setStatus('busy'); f.session._cliBusy = true;
  f.start({ before: 'Save a note' }); await f.flush(); assert.deepEqual(f.writes, []); assert.equal(f.kills(), 0);
  await f.tick(20); f.setStatus('idle'); f.session._cliBusy = false;
  for (let i = 0; i < 15 && !f.writes.includes('\r'); i++) await f.tick(10);
  assert.deepEqual(f.writes, ['Save a note', '\r'], 'the final note must use one shared delivery');
  await f.tick(30); assert.equal(f.kills(), 0, 'submission alone cannot stop a still-running note');
  f.session._cliBusy = false; f.setStatus('idle');
  for (let i = 0; i < 40 && !f.kills(); i++) await f.tick(10);
  assert.equal(f.kills(), 1); f.session.exited = true;
  const r = await f.finish(); assert.equal(r.outcome, 'closed'); assert.equal(r.steps_total, 1);
  assert.equal(r.delivery.final_turn.source, 'descriptor'); assert.equal(r.wrote, true);
});

for (const mode of ['no rise', 'held busy', 'dialog', 'interference', 'deadline']) {
  test(`before ${mode} never stops now or after its refused result`, async t => {
    const f = fixture(t, { timeout: mode === 'no rise' ? 600 : 180 });
    if (mode === 'dialog') f.setStatus('waiting');
    if (mode === 'interference') f.input('draft');
    if (mode === 'no rise') f.session.pty.write = text => { f.writes.push(text); };
    if (mode === 'deadline') f.execution.deadline = Date.now() + 5;
    f.start({ before: 'Save a note' }); const r = await f.finish();
    assert.equal(r.reason, 'note step not finished'); assert.ok(r.delivery, 'underlying delivery diagnostics survive');
    assert.equal(f.kills(), 0); await f.tick(1000); assert.equal(f.kills(), 0);
  });
}

test('application closing cancels a bare quiet wait', async t => {
  const f = fixture(t); f.input('x\x7f'); f.start(); await f.flush(); f.close();
  assert.equal((await f.finish()).reason, 'Switchboard is closing.'); assert.equal(f.kills(), 0);
});

for (const field of ['host', 'isAttach', 'backgrounding', 'backgrounded', 'isPlainTerminal']) {
  test(`stop refuses ${field} without a write or kill`, async t => {
    const f = fixture(t); f.session[field] = field === 'host' ? 'remote' : true; f.start();
    assert.equal((await f.finish()).reason, field === 'host' ? 'remote sessions are not supported'
      : field === 'isPlainTerminal' ? 'plain terminal sessions are not supported' : 'background session is not supported');
    assert.equal(f.kills(), 0); assert.deepEqual(f.writes, []);
  });
}

test('sandbox bare stop without namespace proof refuses state', async t => {
  const f = fixture(t); f.session.sandbox = true; f.proof(false); f.start();
  assert.equal((await f.finish()).reason, 'session state unavailable'); assert.equal(f.kills(), 0);
});

for (const mutation of ['pending', 'unobservable', 'empty recent', 'busy']) {
  test(`final bare-stop guard rechecks ${mutation} introduced after an eligible sample`, async t => {
    const f = fixture(t); let changed = false;
    const save = f.execution.saveMarker;
    f.execution.saveMarker = value => {
      save(value);
      if (value.phase === 'claimed' && !changed) {
        changed = true;
        if (mutation === 'pending') f.input('draft');
        if (mutation === 'unobservable') f.session.composerState = null;
        if (mutation === 'empty recent') f.input('x\x7f');
        if (mutation === 'busy') f.setStatus('busy');
      }
    };
    f.start(); await f.flush(); assert.equal(f.kills(), 0, 'a previous free sample cannot authorize termination');
    if (mutation === 'empty recent') {
      await f.tick(49); assert.equal(f.kills(), 0); await f.tick(1); assert.equal(f.kills(), 1);
      f.session.exited = true; assert.equal((await f.finish()).outcome, 'closed');
    } else {
      const r = await f.finish(); assert.equal(r.reason, mutation === 'pending' ? 'session has unsubmitted input'
        : mutation === 'busy' ? 'session busy' : 'session composer unavailable');
      assert.equal(f.kills(), 0);
    }
  });
}

for (const change of ['busy', 'shell', 'waiting', 'input', 'generation', 'natural exit']) {
  test(`after the note completes ${change} is checked on the same target`, async t => {
    const f = fixture(t, { onEnter: () => {
      setTimeout(() => { f.session._cliBusy = false; f.setStatus('idle'); }, 10);
    } });
    const save = f.execution.saveMarker;
    f.execution.saveMarker = value => {
      save(value);
      if (value.phase !== 'note-delivered') return;
      if (['busy', 'shell', 'waiting'].includes(change)) f.setStatus(change);
      if (change === 'input') f.input('draft');
      if (change === 'generation') f.session.generation++;
      if (change === 'natural exit') { f.session.exited = true; f.map.delete(ID); }
    };
    f.start({ before: 'Save a note' }); const r = await f.finish();
    assert.equal(change === 'natural exit' ? r.outcome : r.reason,
      change === 'natural exit' ? 'closed' : change === 'input' ? 'session has unsubmitted input' : change === 'generation' ? 'session target changed'
        : change === 'busy' ? 'session busy' : change === 'shell' ? 'session running a shell command' : 'session waiting on a dialog');
    assert.equal(f.kills(), 0); assert.deepEqual(f.writes, ['Save a note', '\r']);
  });
}

for (const scenario of ['unknown', 'closed', 'remote', 'schedule', 'background', 'external', 'unavailable']) {
  test(`stop on ${scenario} without an eligible PTY never opens a target`, async t => {
    const f = fixture(t); f.map.clear();
    f.lifecycle.resolveTarget = () => { throw new Error('stop must not resolve an opener'); };
    if (scenario === 'closed') f.lifecycle.getCachedSession = () => ({ sessionId: ID });
    if (scenario === 'remote') f.lifecycle.remoteTarget = () => true;
    if (['schedule', 'background', 'external'].includes(scenario)) f.lifecycle.liveElsewhere = () => ({ known: true,
      live: { kind: scenario === 'background' ? 'bg' : scenario === 'external' ? 'interactive' : 'schedule' } });
    if (scenario === 'unavailable') f.lifecycle.liveElsewhere = () => ({ known: false });
    f.start(); const r = await f.finish();
    const reason = { unknown: 'session not found', closed: 'session not open here', remote: 'remote sessions are not supported',
      schedule: 'scheduled session is not supported', background: 'background session is not supported', external: 'session live elsewhere', unavailable: 'session liveness unavailable' };
    assert.equal(r.reason, reason[scenario]);
    if (['closed', 'unknown'].includes(scenario)) assert.equal(r.outcome, 'not-found');
    assert.equal(f.kills(), 0); assert.deepEqual(f.writes, []);
  });
}

for (const failure of ['marker', 'backend']) {
  test(`${failure} failure refuses without claiming closed`, async t => {
    const f = fixture(t);
    if (failure === 'marker') f.execution.saveMarker = () => { throw new Error('disk'); };
    else f.lifecycle.stop = () => ({ ok: false, error: 'kill denied' });
    f.start(); const r = await f.finish();
    assert.equal(r.reason, failure === 'marker' ? 'action state could not be saved' : 'session stop failed');
    assert.equal(r.error, failure === 'marker' ? 'disk' : 'kill denied'); assert.equal(f.kills(), 0);
  });
}

test('the sidebar IPC and trigger lifecycle use the same normal-session stop backend', () => {
  const filename = path.resolve(__dirname, '../main.js'); const source = fs.readFileSync(filename, 'utf8');
  const session = { pty: {}, generation: 7 }; let handler; const kills = [];
  const context = vm.createContext({ require: createRequire(filename), activeSessions: new Map([[ID, session]]),
    ipcMain: { handle: (_name, fn) => { handler = fn; } }, killPty: (entry, key) => { kills.push([entry, key]); return false; }, detachPty() {} });
  const begin = source.indexOf("ipcMain.handle('stop-session'");
  vm.runInContext(source.slice(begin, source.indexOf('\n});', begin) + 4), context, { filename });
  const failed = handler({}, ID);
  assert.equal(failed.ok, true, 'the sidebar preserves its successful IPC reply even when kill reports false');
  assert.equal(session.stopRequested, false, 'a genuine failed request must not label a later natural exit Stopped');
  assert.equal(kills.length, 1);
  assert.match(source.slice(source.indexOf('function triggerLifecycleDeps'), source.indexOf('async function validateTriggerOpen')),
    /stopLocalSession\(session, tabKey, killPty\)/);
});

test('a pending real kill is successful for a second trigger stop without another kill', async t => {
  const { killPty } = require('../src/main/terminals/pty-ops');
  const { stopLocalSession } = require('../src/main/terminals/stop-session');
  const f = fixture(t); let calls = 0;
  f.session.pty.kill = () => { calls++; };
  assert.equal(stopLocalSession(f.session, ID, killPty).ok, true);
  f.lifecycle.stop = (session, key) => stopLocalSession(session, key, killPty);
  f.start(); await f.flush();
  assert.equal(f.done(), false, 'a pending kill must wait for pinned exit, not refuse');
  f.session.exited = true;
  assert.equal((await f.finish()).outcome, 'closed'); assert.equal(calls, 1);
});

for (const kind of ['false', 'throw']) {
  test(`genuine first kill ${kind} clears Stop attribution before a natural exit`, async t => {
    const { stopLocalSession } = require('../src/main/terminals/stop-session');
    const { processExitLabel } = require('../public/process-exit');
    const f = fixture(t);
    f.lifecycle.stop = (session, key) => stopLocalSession(session, key, () => {
      if (kind === 'throw') throw new Error('dead PTY');
      return false;
    });
    f.start(); assert.equal((await f.finish()).reason, 'session stop failed');
    assert.equal(processExitLabel({ exitCode: 0, stopped: !!f.session.stopRequested }), 'Exited (code 0)',
      'a rejected kill must not turn a later natural exit into Stopped');
  });
}

for (const status of ['busy', 'shell']) {
  test(`OSC completion waits for stale ${status} descriptor to become idle without a second note`, async t => {
    const f = fixture(t, { onEnter: () => {
      const stamp = Date.now();
      setTimeout(() => { f.session._cliBusy = false; f.setStatus(status, stamp); }, 10);
      setTimeout(() => { f.setStatus('idle'); }, 400);
    }, onKill: session => { session.exited = true; } });
    f.start({ before: 'Save a note' });
    for (let i = 0; i < 30; i++) await f.tick(10);
    assert.equal(f.done(), false, 'stale descriptor activity is not a new turn');
    assert.equal(f.kills(), 0, 'wait for descriptor or transcript confirmation');
    const r = await f.finish();
    assert.equal(r.outcome, 'closed', JSON.stringify(r)); assert.equal(r.delivery.final_turn.source, 'busy_flag');
    assert.equal(f.kills(), 1); assert.deepEqual(f.writes, ['Save a note', '\r']);
  });
}

test('stop before readiness deadline reports the unfinished note without writing', async t => {
  const f = fixture(t, { timeout: 60 });
  f.lifecycle.broker.waitForReady = () => new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'renderer not ready' }), 60));
  f.start({ before: 'Save a note' });
  const r = await f.finish();
  assert.equal(r.reason, 'note step not finished'); assert.equal(f.kills(), 0); assert.deepEqual(f.writes, []);
});

for (const newer of ['busy stamp', 'busy rise', 'no update', 'equal stamp']) {
  test(`OSC completed note with ${newer} rechecks the same descriptor before stop`, async t => {
    const f = fixture(t, { onEnter: () => {
      setTimeout(() => { f.session._cliBusy = false; }, 10);
    } });
    const save = f.execution.saveMarker;
    f.execution.saveMarker = value => {
      save(value);
      if (value.phase !== 'note-delivered') return;
      if (newer === 'busy stamp') f.setStatus('busy', Date.now() + 1);
      if (newer === 'busy rise') f.session._cliBusy = true;
      if (newer === 'equal stamp') f.setStatus('busy', value.delivery.final_turn.completedAt);
    };
    f.start({ before: 'Save a note' }); const r = await f.finish();
    assert.equal(r.reason, newer === 'no update' || newer === 'equal stamp' ? 'note step not finished' : 'session busy');
    assert.equal(f.kills(), 0); assert.deepEqual(f.writes, ['Save a note', '\r']);
  });
}

test('natural exit during a bare quiet wait closes the pinned target without a kill', async t => {
  const f = fixture(t); f.input('x\x7f'); f.start(); await f.flush();
  f.session.exited = true; f.map.delete(ID);
  const r = await f.finish();
  assert.equal(r.outcome, 'closed'); assert.equal(f.kills(), 0); assert.deepEqual(f.writes, []);
});

for (const newer of ['turn', 'busy flag', 'none']) {
  test(newer === 'none' ? 'transcript completion publishes durable JSON evidence before stop'
    : `transcript completion cannot authorize stop after a newer ${newer}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-note-turn-'));
    const file = path.join(dir, ID + '.jsonl');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { createTranscriptTurnReader } = require('../transcript-turn'); const reader = createTranscriptTurnReader();
    const write = entries => {
      fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      fs.utimesSync(file, new Date(Date.now()), new Date(Date.now()));
    };
    const f = fixture(t, { onEnter: () => {
      const enterAt = Date.now();
      write([{ type: 'user', timestamp: new Date(enterAt).toISOString(), message: { content: 'Save a note' } },
        { type: 'assistant', timestamp: new Date(enterAt + 1).toISOString(), message: { content: [], stop_reason: 'end_turn' } },
        { type: 'system', subtype: 'turn_duration', timestamp: new Date(enterAt + 1).toISOString() }]);
      f.session._cliBusy = false;
    }, onKill: session => { session.exited = true; } });
    f.ctx.getTranscriptTurn = () => reader.read(file);
    const save = f.execution.saveMarker;
    const durable = [];
    f.execution.saveMarker = value => {
      durable.push(JSON.parse(JSON.stringify(value)));
      save(value); if (value.phase !== 'note-delivered') return;
      if (newer === 'turn') write([{ type: 'user', timestamp: new Date(Date.now()).toISOString(), message: { content: 'another task' } }]);
      else if (newer === 'busy flag') f.session._cliBusy = true;
    };
    f.start({ before: 'Save a note' }); const r = await f.finish();
    assert.equal(r.delivery?.final_turn?.source, 'transcript', 'the real own-entry and closed-turn fallback must complete the note');
    if (newer === 'none') {
      assert.equal(r.outcome, 'closed', 'completed transcript note must publish serializable action state');
      assert.equal(f.kills(), 1); assert.doesNotThrow(() => JSON.stringify(r));
      assert.equal(typeof durable.at(-1).delivery.final_turn.transcriptIdentity.dev, 'string');
      assert.equal(typeof durable.at(-1).delivery.final_turn.transcriptIdentity.ino, 'string');
    } else {
      assert.equal(r.reason, 'session busy', 'completion evidence must be revalidated before stopping new activity');
      assert.equal(f.kills(), 0);
    }
  });
}

for (const before of [undefined, 'Save a final note']) {
  test(`file trigger ${before ? 'with note' : 'bare'} stops through the real watcher and broker without a renderer command`, async t => {
    const { EventEmitter } = require('node:events');
    const { createTriggerContext } = require('../src/main/triggers/trigger-context');
    const { createTriggerRendererBridge } = require('../src/main/triggers/trigger-renderer-bridge');
    const { start } = require('../src/main/triggers/trigger-watcher');
    const { stopLocalSession } = require('../src/main/terminals/stop-session');
    const { createComposerState } = require('../src/main/terminals/composer-state');
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-file-stop-')));
    const env = { SWITCHBOARD_TRIGGERS_DIR: dir, SWITCHBOARD_TRIGGER_QUIET_MS: '1', SWITCHBOARD_BUSY_FALL_SETTLE_MS: '1', SWITCHBOARD_SUBMIT_ENTER_DELAY_MS: '1' };
    const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
    const writes = [], sends = [], kills = [];
    const output = path.join(dir, 'processed', '21234567-89ab-cdef-0123-456789abcdef.result.json');
    let status = { status: 'idle', statusUpdatedAt: Date.now() - 100 };
    const session = { generation: 7, cwd: dir, composerState: createComposerState(), pty: { pid: process.pid, write(text) {
      writes.push(text);
      if (text === '\r') {
        session._cliBusy = true; status = { status: 'busy', statusUpdatedAt: Date.now() };
        setTimeout(() => { session._cliBusy = false; status = { status: 'idle', statusUpdatedAt: Date.now() }; }, 20);
      }
    } } };
    const map = new Map([[ID, session]]); const handlers = new Map();
    const ipc = new EventEmitter(); ipc.handle = (name, fn) => handlers.set(name, fn); ipc.removeHandler = name => handlers.delete(name);
    const wc = new EventEmitter(); wc.mainFrame = {}; wc.isDestroyed = () => false; wc.send = (...args) => sends.push(args);
    const win = new EventEmitter(); win.webContents = wc; win.isDestroyed = () => false;
    const broker = createTriggerRendererBridge({ ipcMain: ipc, getWindow: () => win, getSession: id => map.get(id), launchAllowed: () => true });
    broker.attach(win); handlers.get('trigger-actions-ready')({ sender: wc, senderFrame: wc.mainFrame });
    const lifecycle = { activeSessions: map, launchAllowed: () => true, broker, stop: (target, key) => stopLocalSession(target, key, () => {
      kills.push(target); assert.equal(fs.existsSync(output), false, 'closed cannot be published by the kill request');
      const marker = JSON.parse(fs.readFileSync(output.replace('.result.json', '.action.json'), 'utf8'));
      assert.equal(marker.sessionId, ID); assert.equal(marker.tabKey, ID);
      setTimeout(() => { session.exited = true; map.delete(ID); }, 40); return true;
    }) };
    const ctx = createTriggerContext({ activeSessions: map, lifecycle, isPtyAlive: () => !session.exited,
      getCliStatus: () => status, log: { info() {}, warn() {}, error() {} },
      cliSessionState: { deliveryPtyStart: () => '10', observeTabWriter: () => ({ writer: { ...status, sessionId: ID }, identity: 'writer' }) } });
    const watcher = start(ctx);
    t.after(() => {
      watcher.close(); broker.dispose();
      for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const input = path.join(dir, '21234567-89ab-cdef-0123-456789abcdef.json');
    fs.writeFileSync(input + '.tmp', JSON.stringify({ version: 1, action: 'stop', sessionId: ID, expectedCwd: dir, timeout_ms: 1500, ...(before ? { before } : {}) }));
    fs.renameSync(input + '.tmp', input);
    const limit = Date.now() + 2500;
    while (!fs.existsSync(output) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fs.existsSync(output), true, 'real file dispatch must publish its result');
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(result.outcome, 'closed', JSON.stringify(result)); assert.equal(result.steps_total, before ? 1 : 0);
    assert.equal(kills.length, 1); assert.equal(kills[0], session); assert.deepEqual(sends, []);
    assert.deepEqual(writes, before ? [before, '\r'] : []); assert.equal(fs.existsSync(input), false);
    assert.equal(fs.existsSync(output.replace('.result.json', '.action.json')), false);
    const bytes = fs.readFileSync(output, 'utf8'); fs.writeFileSync(input, JSON.stringify({ version: 1, action: 'stop', sessionId: ID, before: 'Never replay' }));
    for (let i = 0; i < 50 && fs.existsSync(input); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fs.existsSync(input), false); assert.equal(fs.readFileSync(output, 'utf8'), bytes); assert.equal(kills.length, 1);
    assert.deepEqual(writes, before ? [before, '\r'] : []);
  });
}

for (const before of [undefined, 'Save a note']) {
  test(`expectedCwd mismatch refuses before ${before ? 'note delivery' : 'bare stop'}`, async t => {
    const f = fixture(t); f.start({ expectedCwd: path.resolve('other-project'), ...(before ? { before } : {}) });
    assert.equal((await f.finish()).reason, "expectedCwd does not match this session's actual cwd");
    assert.equal(f.kills(), 0); assert.deepEqual(f.writes, []);
  });
}

test('renderer reload between note text and Enter suppresses Enter and stop', async t => {
  const f = fixture(t); let available = true;
  f.lifecycle.broker.waitForReady = async () => ({ ok: true,
    validate: () => available ? { ok: true } : { ok: false, reason: 'renderer unavailable' } });
  f.session.pty.write = text => { f.writes.push(text); available = false; };
  f.start({ before: 'Save a note' }); const r = await f.finish();
  assert.equal(r.reason, 'note step not finished');
  assert.equal(r.delivery?.reason, 'renderer unavailable', 'lost renderer readiness cancels the next note byte');
  assert.deepEqual(f.writes, ['Save a note']); assert.equal(f.kills(), 0);
});

test('closing after note Enter preserves uncertain submission and never requests a kill', async t => {
  const f = fixture(t, { onEnter: () => f.close() });
  f.start({ before: 'Save a note' }); const r = await f.finish();
  assert.equal(r.reason, 'Switchboard is closing.'); assert.equal(r.enter_written, true);
  assert.equal(r.uncertain, true, 'closing can interrupt a note whose Enter already took effect');
  assert.equal(f.kills(), 0); await f.tick(1000); assert.equal(f.kills(), 0);
});

test('a fresh installation without a transcript directory still reports unknown stop as not-found', async t => {
  const f = fixture(t); f.map.clear();
  f.lifecycle.projectsDir = path.join(os.tmpdir(), 'no-such-stop-projects-' + process.pid);
  f.start(); const r = await f.finish();
  assert.equal(r.outcome, 'not-found'); assert.equal(r.reason, 'session not found'); assert.equal(f.kills(), 0);
});
