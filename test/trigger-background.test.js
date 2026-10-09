'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '400';
process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cliSessionState = require('../cli-session-state');
const { createTriggerContext } = require('../trigger-context');
const { start } = require('../trigger-watcher');

const sessionId = 'e7abbcdc-0000-4000-8000-000000000000';
const jobId = 'e7abbcdc';
const log = { info() {}, warn() {}, error() {}, debug() {} };

function fixture(t, { attached = false, kind = 'bg', alive = true, reused = false, remote = false } = {}) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-i495-')));
  const descriptors = path.join(tmp, 'sessions');
  const projects = path.join(tmp, 'projects');
  const triggers = path.join(tmp, 'triggers');
  fs.mkdirSync(descriptors);
  fs.mkdirSync(path.join(projects, 'project'), { recursive: true });
  fs.mkdirSync(triggers);
  const transcript = path.join(projects, 'project', sessionId + '.jsonl');
  fs.writeFileSync(transcript, '');
  const descriptor = {
    pid: 4242, sessionId, kind, jobId, cwd: tmp, procStart: '111',
    status: 'busy', statusUpdatedAt: Date.now() - 10000,
  };
  const writeDescriptor = (status) => {
    descriptor.status = status;
    descriptor.statusUpdatedAt = Date.now();
    fs.writeFileSync(path.join(descriptors, '4242.json'), JSON.stringify(descriptor));
    cliSessionState.stop();
    cliSessionState.ensureWatching();
  };
  fs.writeFileSync(path.join(descriptors, '4242.json'), JSON.stringify(descriptor));
  const written = [];
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  let onWrite = () => {};
  const session = {
    isAttach: true, attachJobId: jobId, host: null, kind: 'local-pty',
    cwd: tmp, projectFolder: 'project', composerState: { pending: 0, lastInputAt: 0 },
    _cliBusy: false, pty: { pid: process.pid, write(data) {
      written.push(data);
      onWrite(data);
    } },
  };
  const activeSessions = new Map(attached ? [[sessionId, session]] : []);
  cliSessionState.init({
    dir: descriptors, activeSessions, log, onIdle() {}, platform: 'linux',
    isProcessAlive: () => alive, readProcStart: () => reused ? '222' : '111',
  });
  cliSessionState.ensureWatching();
  let remoteLookups = 0;
  const ctx = createTriggerContext({
    activeSessions, log, projectsDir: projects,
    getCliStatus: (id) => cliSessionState.getStatus(id),
    getLiveDescriptor: (id) => cliSessionState.findLiveProcess(id),
    remote: remote ? {
      indexer: { findSessionAliases() { remoteLookups++; return []; } },
      adapter: { send() { assert.fail('an unresolved remote target must not be sent'); } },
      isEnabled: () => true,
    } : undefined,
  });
  const previousDir = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = triggers;
  const keepAlive = setInterval(() => {}, 1000);
  let watcher;
  t.after(() => {
    watcher?.close();
    cliSessionState.stop();
    timers.forEach(clearTimeout);
    clearInterval(keepAlive);
    if (previousDir === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previousDir;
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), tmp);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return {
    ctx, session, written, descriptor, writeDescriptor, later, transcript,
    get remoteLookups() { return remoteLookups; },
    setOnWrite(fn) { onWrite = fn; },
    async trigger(payload) {
      watcher = start(ctx);
      fs.writeFileSync(path.join(triggers, 'i495.json'), JSON.stringify({ sessionId, timeout_ms: 2000, ...payload }));
      const resultPath = path.join(triggers, 'processed', 'i495.result.json');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(resultPath)) {
        assert.ok(Date.now() < deadline, 'the watcher must write a result');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(fs.existsSync(path.join(triggers, 'i495.json')), false);
      return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    },
  };
}

for (const payload of [{ command: 'hello' }, { chain: [{ command: 'hello' }] }]) {
  test(`background refusal: unattached live bg ${payload.chain ? 'chain' : 'command'} names the job and pins the error contract`, async (t) => {
    const f = fixture(t);
    const result = await f.trigger(payload);
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.error, 'background session, not attached here');
    assert.equal(result.jobId, jobId);
    assert.equal(result.sessionId, sessionId);
    assert.deepEqual(f.written, []);
  });
}

for (const [name, options, targetId] of [
  ['unknown', {}, 'unknown-session'],
  ['interactive', { kind: 'interactive' }, sessionId],
  ['dead bg', { alive: false }, sessionId],
  ['reused bg pid', { reused: true }, sessionId],
  ['remote without a socket target', { remote: true }, 'remote-session'],
]) {
  test(`background refusal: ${name} keeps session not found`, async (t) => {
    const f = fixture(t, options);
    const result = await f.trigger({ sessionId: targetId, command: 'hello' });
    assert.equal(result.error, 'session not found');
    assert.equal(result.submitted, 'no');
    assert.equal(result.jobId, undefined);
    assert.deepEqual(f.written, []);
    if (options.remote) assert.ok(f.remoteLookups > 0, 'the real remote context must attempt lookup');
  });
}

test('background context: the live descriptor reader works without an active PTY', async (t) => {
  const f = fixture(t);
  assert.equal(f.ctx.getPtyForSession(sessionId), null);
  assert.equal((await f.ctx.getLiveDescriptor(sessionId)).jobId, jobId);
  assert.equal(await f.ctx.getLiveDescriptor('unknown'), null);
});

test('background attach: a single trigger waits for the bg descriptor then delivers through the attach PTY', async (t) => {
  const f = fixture(t, { attached: true });
  assert.equal(f.ctx.getPtyForSession(sessionId).ptyProcess, f.session.pty);
  assert.deepEqual(f.ctx.getCliStatus(sessionId), {
    status: 'busy', statusUpdatedAt: f.descriptor.statusUpdatedAt,
  });
  f.setOnWrite(data => {
    assert.equal(f.descriptor.status, 'idle', 'readiness must hold writes while the bg descriptor is busy');
    if (data === '\r') f.later(10, () => f.writeDescriptor('busy'));
  });
  f.later(150, () => {
    assert.deepEqual(f.written, [], 'a false OSC busy flag cannot override the bg descriptor');
    f.writeDescriptor('idle');
  });
  const result = await f.trigger({ command: 'hello', wait: 'idle' });
  assert.deepEqual(f.written, ['hello', '\r']);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, 'confirmed');
});

test('background attach: a compact chain reads the bg transcript and holds the next step for descriptor idle', async (t) => {
  const f = fixture(t, { attached: true });
  f.writeDescriptor('idle');
  let compactIdle = false;
  f.setOnWrite(data => {
    if (data === 'resume the work') assert.equal(compactIdle, true, 'the next step must wait for bg descriptor idle');
    if (data !== '\r') return;
    f.writeDescriptor('busy');
    if (f.written.at(-2) === '/compact') {
      fs.appendFileSync(f.transcript, JSON.stringify({
        type: 'system', subtype: 'compact_boundary', timestamp: new Date().toISOString(),
        uuid: 'i495-compact', sessionId, compactMetadata: { trigger: 'manual' },
      }) + '\n');
      f.later(200, () => {
        assert.deepEqual(f.written, ['/compact', '\r']);
        compactIdle = true;
        f.writeDescriptor('idle');
      });
    } else {
      f.later(100, () => f.writeDescriptor('idle'));
    }
  });
  const result = await f.trigger({ chain: [{ command: '/compact' }, { command: 'resume the work' }], wait: 'idle' });
  assert.deepEqual(f.written, ['/compact', '\r', 'resume the work', '\r']);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, 'confirmed');
  assert.equal(result.compaction_observed, true);
  assert.equal(result.steps[0].confirm_source, 'compact_boundary');
  assert.equal(result.steps[1].submitted, 'confirmed');
});
