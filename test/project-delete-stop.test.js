'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRemoteStopAdapter } = require('../src/main/remote/remote-stop');

function clock() {
  let time = Date.now(), next = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(fn, ms) { const id = ++next; timers.set(id, { at: time + ms, fn }); return id; },
    cancel: id => timers.delete(id),
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    },
    timers,
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(kinds = ['pty']) {
  const file = path.join(__dirname, '../src/main/projects/project-delete-stop.js');
  assert.ok(fs.existsSync(file), 'production stop adapter must exist');
  const { createProjectDeleteStop } = require(file);
  const time = clock(), effects = [], bindings = new Map(), owners = [], sessions = new Map();
  const targets = kinds.map((kind, i) => {
    const id = `target-${i}`, sessionId = `part-${i}`;
    const identity = { pid: 100 + i, procStart: `start-${i}`, generation: i + 1 };
    if (kind === 'remote') Object.assign(identity, { alias: 'vps', procStart: '123', sessionId: '11111111-1111-1111-1111-111111111111', bootId: '22222222-2222-2222-2222-222222222222' });
    const target = { id, kind, conversationId: 'conversation', sessionIds: [sessionId], identity,
      ...(kind === 'job' ? { jobId: `job-${i}` } : {}), sessionKey: id };
    const session = { kind: 'local-pty', generation: identity.generation, statusPtyStart: identity.procStart,
      pty: { pid: identity.pid }, exitDrain: Promise.resolve() };
    sessions.set(id, session);
    bindings.set(id, { ...target, identity: { ...identity }, supported: true, session,
      descriptor: { ...identity }, attachments: [] });
    owners.push({ id, identity: { ...identity }, treeState: 'live' });
    return target;
  });
  const request = { project: { alias: null, projectPath: 'C:/project' }, targets,
    conversations: [{ id: 'conversation', sessionIds: targets.flatMap(t => t.sessionIds) }], stopBackgroundJobs: true };
  const die = id => { owners.find(o => o.id === id).treeState = 'dead'; };
  const ports = { ...time, platform: 'win32', activeSessions: sessions,
    readTarget: async target => bindings.get(target.id),
    readConversation: async () => ({ known: true, complete: true, owners: structuredClone(owners) }),
    getScheduleRunSnapshot: () => [],
    stopPtyWithEvidence: async (session, id) => {
      effects.push(`stop:${id}`); die(id);
      return { ended: true, generation: session.generation, pid: session.pty.pid, observedAt: time.now() };
    },
    bg: {
      checkStop: async () => ({ ok: true, ended: false, workerLiveness: 'live' }),
      runStop: async (jobId, options) => {
        const target = targets.find(t => t.jobId === jobId);
        effects.push(`job:${jobId}`); die(target.id);
        return { ok: true, ended: true, jobId, sessionIds: options.sessionIds, observedAt: time.now() };
      },
    },
    remote: { stop: async (alias, descriptor, options) => {
      const target = targets.find(t => t.identity.pid === descriptor.pid);
      effects.push(`remote:${target.id}`); die(target.id);
      return { ok: true, ended: true, scope: 'process', identity: options.identity, observedAt: time.now() };
    } },
    detach: async binding => { effects.push(`detach:${binding.sessionKey}`); return true; },
  };
  return { time, effects, bindings, owners, sessions, targets, request, die, ports,
    adapter: () => createProjectDeleteStop(ports) };
}

async function execute(f) {
  const adapter = f.adapter(), prepared = await adapter.preflight(f.request);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  return { adapter, prepared, result: await adapter.stop(prepared) };
}

test('all bindings preflight before sequential stops and whole conversation verification', async () => {
  const f = fixture(['pty', 'job', 'remote']);
  const read = f.ports.readTarget;
  f.ports.readTarget = async target => { f.effects.push(`read:${target.id}`); return read(target); };
  const { result } = await execute(f);
  assert.equal(result.ok, true);
  assert.equal(result.stopped.length, 3);
  for (const target of f.targets) assert.ok(f.effects.indexOf(`read:${target.id}`) < f.effects.indexOf('stop:target-0'));
  assert.equal(f.time.timers.size, 0);
});

for (const mode of ['kill ACK', 'never exiting tree', 'protected child', 'exited flag', 'missing active session']) {
  test(`${mode} does not establish death; later targets are skipped`, async () => {
    const f = fixture(['pty', 'pty']);
    f.ports.stopPtyWithEvidence = async (session, id) => {
      f.effects.push(`stop:${id}`);
      if (mode === 'exited flag') session.exited = true;
      if (mode === 'missing active session') f.sessions.delete(id);
      if (mode === 'never exiting tree') return new Promise(() => {});
      if (mode === 'kill ACK') return { ok: true, generation: session.generation, pid: session.pty.pid };
      return { ok: true, ended: mode === 'protected child', generation: session.generation, pid: session.pty.pid };
    };
    const pending = execute(f);
    if (mode === 'never exiting tree') { await flush(); f.time.advance(15000); }
    const { result } = await pending;
    assert.equal(result.failed[0].code, mode === 'never exiting tree' ? 'STOP_TIMEOUT'
      : mode === 'protected child' ? 'CONVERSATION_CHANGED' : 'STOP_UNKNOWN');
    assert.equal(result.ok, false, 'kill ACK is not death');
    assert.equal(result.stopped.length, 0);
    assert.equal(result.failed.length, mode === 'protected child' ? 2 : 1);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(f.effects, ['stop:target-0']);
  });
}

for (const field of ['generation', 'pid', 'procStart', 'object']) test(`replacement ${field} invalidates captured consent before stop`, async () => {
  const f = fixture(), a = f.adapter(), prepared = await a.preflight(f.request);
  assert.equal(prepared.ok, true);
  const b = f.bindings.get('target-0');
  if (field === 'object') { b.session = { ...b.session }; f.sessions.set('target-0', b.session); }
  else b.identity[field] = field === 'procStart' ? 'replacement' : 999;
  const result = await a.stop(prepared);
  assert.equal(result.ok, false, 'replacement must invalidate consent');
  assert.deepEqual(f.effects, [], 'replacement must never be signalled');
});

test('unsupported last target refuses every target before mutation', async () => {
  const f = fixture(['pty', 'pty']); f.bindings.get('target-1').supported = false;
  const result = await f.adapter().preflight(f.request);
  assert.equal(result.ok, false); assert.equal(result.failed[0].id, 'target-1');
  assert.deepEqual(f.effects, []);
});

test('non-Windows PTY refuses before stop', async () => {
  const f = fixture(); f.ports.platform = 'linux';
  assert.equal((await f.adapter().preflight(f.request)).ok, false);
  assert.deepEqual(f.effects, []);
});

test('no attach tab is required for a guarded background job', async () => {
  const f = fixture(['job']); f.sessions.clear();
  const { result } = await execute(f);
  assert.equal(result.ok, true); assert.deepEqual(f.effects, ['job:job-0']);
});

test('job done with live worker never detaches the attach PTY', async () => {
  const f = fixture(['job']);
  const b = f.bindings.get('target-0'); b.attachments = [{ sessionKey: 'target-0', session: b.session }];
  f.ports.bg.runStop = async () => ({ ok: true, state: 'done', ended: false });
  const { result } = await execute(f);
  assert.equal(result.ok, false, 'detach is not a job stop');
  assert.deepEqual(f.effects, [], 'live worker must prevent detach');
});

test('job death precedes pinned attachment detach', async () => {
  const f = fixture(['job']); const b = f.bindings.get('target-0');
  b.attachments = [{ sessionKey: 'target-0', session: b.session }];
  const { result } = await execute(f);
  assert.equal(result.ok, true); assert.deepEqual(f.effects, ['job:job-0', 'detach:target-0']);
});

test('same conversation with multiple parts/jobs is refused by guarded continuation check before effects', async () => {
  const f = fixture(['job', 'job']);
  f.ports.bg.checkStop = async () => ({ ok: false, ended: false, error: 'conversation has another or unknown continuation job' });
  assert.equal((await f.adapter().preflight(f.request)).ok, false);
  assert.deepEqual(f.effects, []);
});

test('missing background consent refuses before any local stop', async () => {
  const f = fixture(['pty', 'job']); f.request.stopBackgroundJobs = false;
  const result = await f.adapter().preflight(f.request);
  assert.equal(result.ok, false); assert.equal(result.failed[0].code, 'BACKGROUND_CONSENT');
  assert.deepEqual(f.effects, []);
});

for (const mode of ['TERM ACK', 'KILL ACK', 'unreachable', 'reused PID']) test(`remote ${mode} cannot close local SSH attachment`, async () => {
  const f = fixture(['remote']); const b = f.bindings.get('target-0');
  b.attachments = [{ sessionKey: 'target-0', session: b.session }];
  f.ports.remote.stop = async () => ({ ok: mode.includes('ACK'), ended: false, error: mode });
  const { result } = await execute(f);
  assert.equal(result.ok, false); assert.deepEqual(f.effects, []);
});

test('remote process death with a live descendant is insufficient for detach', async () => {
  const f = fixture(['remote']); const b = f.bindings.get('target-0');
  b.attachments = [{ sessionKey: 'target-0', session: b.session }];
  f.ports.remote.stop = async (_a, _d, options) => ({ ok: true, ended: true, scope: 'process', identity: options.identity });
  const { result } = await execute(f);
  assert.equal(result.ok, false); assert.deepEqual(f.effects, []);
});

test('non-PTY continuation owners and successors invalidate whole conversation proof', async () => {
  const f = fixture(); const original = f.ports.stopPtyWithEvidence;
  f.ports.stopPtyWithEvidence = async (...args) => {
    const result = await original(...args);
    f.owners.push({ id: 'successor', identity: { pid: 900, procStart: 'new' }, treeState: 'live' });
    return result;
  };
  const { result } = await execute(f);
  assert.equal(result.ok, false); assert.equal(result.failed.length, 2);
  assert.equal(result.failed[0].scope, 'batch');
  assert.equal(result.failed[1].id, 'target-0');
});

test('live headless schedule snapshot is a named blocking target before mutation', async () => {
  const f = fixture(); f.ports.getScheduleRunSnapshot = () => [
    { sessionId: 'headless', cwd: 'C:/project', scheduleName: 'nightly', pid: 700, startedAt: 1 },
  ];
  const result = await f.adapter().preflight(f.request);
  assert.equal(result.ok, false); assert.equal(result.failed[0].id, 'headless');
  assert.equal(result.failed[0].code, 'HEADLESS_SCHEDULE'); assert.deepEqual(f.effects, []);
});

test('future schedule job requires exact schedule claim job conversation correlation and consent', async () => {
  const f = fixture(['job']); const target = f.targets[0];
  Object.assign(target, { scheduleId: 'nightly', claimId: 'claim-1' });
  Object.assign(f.bindings.get(target.id), { scheduleId: 'nightly', claimId: 'claim-1' });
  f.ports.getScheduleRunSnapshot = () => [{ sessionId: 'part-0', cwd: 'C:/project', scheduleName: 'nightly',
    claimId: 'claim-1', jobId: 'job-0' }];
  const { result } = await execute(f); assert.equal(result.ok, true);
  f.request.stopBackgroundJobs = false;
  assert.equal((await f.adapter().preflight(f.request)).ok, false);
  f.request.stopBackgroundJobs = true; target.claimId = 'different';
  assert.equal((await f.adapter().preflight(f.request)).ok, false);
});

test('late exit cannot turn a timed-out unknown effect into stopped or trigger another stop', async () => {
  const f = fixture(['pty', 'pty']); let resolve;
  f.ports.stopPtyWithEvidence = () => new Promise(r => { resolve = r; });
  const a = f.adapter(), p = await a.preflight(f.request), pending = a.stop(p);
  await flush(); f.time.advance(15000); await flush();
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.failed[0].code, 'STOP_TIMEOUT');
  assert.equal(result.failed[0].unknown, true); assert.equal(result.skipped.length, 1);
  resolve({ ended: true, generation: 1, pid: 100 }); await flush();
  assert.equal(result.stopped.length, 0); assert.equal(f.time.timers.size, 0);
  assert.equal((await a.stop(p)).ok, false, 'a consumed batch cannot be replayed');
});

test('one absolute batch deadline includes preflight and all target budgets', async () => {
  const f = fixture(['pty', 'pty', 'pty', 'pty', 'pty']);
  const original = f.ports.stopPtyWithEvidence, deadlines = [];
  f.ports.stopPtyWithEvidence = async (session, id, options) => {
    deadlines.push(options.deadline); f.time.advance(14000); return original(session, id, options);
  };
  const start = f.time.now(), { result } = await execute(f);
  assert.equal(result.ok, false); assert.equal(result.stopped.length, 4);
  assert.equal(deadlines.at(-1), start + 60000); assert.equal(f.time.timers.size, 0);
});

test('refused PTY stop re-reads late natural tree proof and drains exit housekeeping', async () => {
  const f = fixture(); let drain;
  f.bindings.get('target-0').session.exitDrain = new Promise(r => { drain = r; });
  f.ports.stopPtyWithEvidence = async session => {
    session.exited = true; f.die('target-0');
    session.pty.statusTreeExit = Promise.resolve({ ended: true, observedAt: f.time.now() });
    return { ended: false, code: 'IDENTITY', generation: 1, pid: 100 };
  };
  const a = f.adapter(), p = await a.preflight(f.request); let settled = false;
  const pending = a.stop(p).then(r => { settled = true; return r; });
  await flush(); assert.equal(settled, false); drain();
  assert.equal((await pending).ok, true);
});

test('independent verify observes a successor even after successful stop', async () => {
  const f = fixture(); const { adapter, prepared, result } = await execute(f);
  assert.equal(result.ok, true);
  f.owners[0].identity.pid++;
  assert.equal((await adapter.verify(prepared)).ok, false);
});

test('strict remote TERM observations reserve more than 5 seconds plus a round trip for KILL', async () => {
  const time = clock(), phases = [];
  const identity = { alias: 'vps', pid: 42, procStart: '123',
    sessionId: '11111111-1111-1111-1111-111111111111', bootId: '22222222-2222-2222-2222-222222222222' };
  const adapter = createRemoteStopAdapter({ ...time, runRemoteCommand: async (_alias, command, options) => {
    const payload = JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64').toString());
    phases.push({ phase: payload.phase, timeout: options.timeoutMs });
    time.advance(1500);
    const marker = payload.phase !== 'observe' ? 'STOP_SIGNALLED' : phases.some(p => p.phase === 'KILL') ? 'STOP_ENDED' : 'STOP_LIVE';
    return { code: 0, stdout: `${marker} 42 123 ${identity.sessionId} ${identity.bootId}` };
  } });
  const pending = adapter.stop('vps', identity, { strict: true, identity, deadline: time.now() + 15000 });
  let done = false; pending.finally(() => { done = true; });
  for (let i = 0; i < 60 && !done; i++) { await flush(); time.advance(50); }
  assert.ok(phases.some(p => p.phase === 'KILL'), 'KILL must remain reachable after slow TERM observations');
  assert.ok(phases.find(p => p.phase === 'KILL').timeout > 6200, 'KILL keeps connect allowance plus one round trip');
  assert.equal((await pending).ended, true); assert.equal(time.timers.size, 0);
});

for (const missing of ['runStop', 'detach', 'exitDrain']) test(`missing ${missing} capability refuses the whole batch before mutation`, async () => {
  const f = fixture(['pty', 'job']);
  if (missing === 'runStop') delete f.ports.bg.runStop;
  if (missing === 'exitDrain') delete f.bindings.get('target-0').session.exitDrain;
  if (missing === 'detach') {
    const b = f.bindings.get('target-1');
    b.attachments = [{ sessionKey: b.sessionKey, session: b.session }];
    delete f.ports.detach;
  }
  assert.equal((await f.adapter().preflight(f.request)).ok, false, 'unsupported capability must refuse in preflight');
  assert.deepEqual(f.effects, []);
});

test('invalid remote start identity refuses before an earlier local stop', async () => {
  const f = fixture(['pty', 'remote']);
  f.targets[1].identity.procStart = 'invalid';
  f.bindings.get('target-1').identity.procStart = 'invalid';
  f.bindings.get('target-1').descriptor.procStart = 'invalid';
  f.owners[1].identity.procStart = 'invalid';
  assert.equal((await f.adapter().preflight(f.request)).ok, false, 'invalid strict remote identity must refuse in preflight');
  assert.deepEqual(f.effects, []);
});

test('generation changes during final conversation read cannot reach the signal port', async () => {
  const f = fixture(), a = f.adapter(), p = await a.preflight(f.request);
  const read = f.ports.readConversation;
  f.ports.readConversation = async (...args) => {
    f.bindings.get('target-0').session.generation++;
    return read(...args);
  };
  assert.equal((await a.stop(p)).ok, false);
  assert.deepEqual(f.effects, [], 'replacement generation must never reach a signal port');
});

test('successful seam proof still requires independent tree death', async () => {
  const f = fixture();
  f.ports.stopPtyWithEvidence = async session => ({ ended: true, generation: session.generation, pid: session.pty.pid });
  const { result } = await execute(f);
  assert.equal(result.ok, false);
  assert.equal(result.stopped.length, 0);
});

test('missing stopped binding retains evidence but missing live binding refuses', async () => {
  const f = fixture(['pty', 'pty']); const stop = f.ports.stopPtyWithEvidence;
  f.ports.stopPtyWithEvidence = async (...args) => {
    const proof = await stop(...args);
    f.bindings.delete(args[1]); f.sessions.delete(args[1]);
    return proof;
  };
  const { result } = await execute(f);
  assert.equal(result.ok, true, 'positively stopped identities survive normal registry removal');
  const other = fixture(), a = other.adapter(), p = await a.preflight(other.request);
  other.bindings.clear(); other.sessions.clear();
  assert.equal((await a.stop(p)).ok, false);
  assert.deepEqual(other.effects, []);
});

test('uncontrolled non-PTY continuation blocks preflight before mutation', async () => {
  const f = fixture();
  f.owners.push({ id: 'continuation', identity: { pid: 201, procStart: '102' }, treeState: 'live' });
  assert.equal((await f.adapter().preflight(f.request)).ok, false);
  assert.deepEqual(f.effects, []);
});
for (const ended of [true, false]) test(`adapter composes the production PTY seam with helper empty=${ended}`, async () => {
  const f = fixture(), b = f.bindings.get('target-0'), calls = [];
  const { trackWindowsPty } = require('../src/main/terminals/pty-ops');
  let exit;
  b.session.pty._agent = {};
  b.session.pty.onExit = fn => { exit = fn; };
  b.session.pty.kill = () => { calls.push('kill'); b.session.pty._agent.exitCode = 0; exit(); };
  await trackWindowsPty(b.session.pty, { platform: 'win32', jobs: {
    assign: async () => { calls.push('assign'); return true; },
    terminateWithEvidence: async () => { calls.push('terminate'); if (ended) f.die(b.id); return { ended }; },
    release: async () => { calls.push('release'); return true; },
  } });
  delete f.ports.stopPtyWithEvidence;
  const { result } = await execute(f);
  assert.equal(result.ok, ended);
  assert.deepEqual(calls, ['assign', 'kill', 'terminate']);
  assert.equal(f.time.timers.size, 0);
});

test('adapter composes actual background init guards for a job without an attach tab', async () => {
  const f = fixture(['job']), b = f.bindings.get('target-0');
  f.targets[0].jobId = b.jobId = 'aaaaaaaa';
  delete b.session; f.sessions.clear();
  const { init } = require('../src/main/bg-agents/bg-agents-ipc');
  const checks = [];
  f.ports.bg = init({ ...f.time, ipcMain: { handle() {} }, activeSessions: f.sessions,
    getMainWindow: () => null, log: { warn() {} },
    cliSessionState: { liveElsewhereChecked: async () => ({ known: true, live: null }) },
    bgAgents: {
      conversationCheck: async (_id, options) => {
        checks.push(options.workerLiveness);
        return { known: true, sessionIds: ['part-0'], state: 'done', workerLiveness: f.owners[0].treeState };
      },
      continuationJobCheck: async () => ({ known: true, job: null }),
      liveJobCheck: () => ({ known: true, job: null }),
      runVerb: async (verb, id) => { f.effects.push(`${verb}:${id}`); f.die(b.id); return { ok: true }; },
    },
  });
  const { result } = await execute(f);
  assert.equal(result.ok, true);
  assert.deepEqual(f.effects, ['stop:aaaaaaaa']);
  assert.ok(checks.length >= 3 && checks.every(value => value === 'all'));
  assert.equal(f.time.timers.size, 0);
});

test('adapter composes strict remote proof before closing the SSH attachment', async () => {
  const f = fixture(['remote']), b = f.bindings.get('target-0');
  b.attachments = [{ sessionKey: b.sessionKey, session: b.session }];
  f.ports.remote = createRemoteStopAdapter({ ...f.time, runRemoteCommand: async (_alias, command) => {
    const payload = JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64').toString());
    f.effects.push(payload.phase);
    if (payload.phase === 'observe') f.die(b.id);
    const marker = payload.phase === 'observe' ? 'STOP_ENDED' : 'STOP_SIGNALLED';
    return { code: 0, stdout: `${marker} ${payload.pid} ${payload.procStart} ${payload.sessionId} ${payload.bootId}` };
  } });
  const { result } = await execute(f);
  assert.equal(result.ok, true);
  assert.deepEqual(f.effects, ['TERM', 'observe', 'detach:target-0']);
  assert.equal(f.time.timers.size, 0);
});
for (const kind of ['job', 'remote']) for (const removal of ['attachment', 'binding', 'both']) {
  test(kind + ' truthful reader accepts removed ' + removal + ' after death', async () => {
    const f = fixture([kind]), b = f.bindings.get('target-0');
    b.attachments = [{ sessionKey: b.sessionKey, session: b.session }];
    const stop = kind === 'job' ? f.ports.bg.runStop : f.ports.remote.stop;
    const finish = async (...args) => {
      const proof = await stop(...args);
      if (removal !== 'attachment') f.bindings.delete(b.id);
      return proof;
    };
    if (kind === 'job') f.ports.bg.runStop = finish;
    else f.ports.remote.stop = finish;
    f.ports.detach = async attachment => {
      f.effects.push('detach:' + attachment.sessionKey);
      f.sessions.delete(attachment.sessionKey);
      attachment.session.pty = null;
      if (removal !== 'binding') b.attachments = [];
      return true;
    };
    const { adapter, prepared, result } = await execute(f);
    assert.equal(result.ok, true, 'normal attachment removal preserves proven stop');
    assert.equal((await adapter.verify(prepared)).ok, true);
    assert.equal(f.effects.filter(e => e.startsWith('detach:')).length, 1);
  });
}

for (const code of ['STOP_IDENTITY', 'CONVERSATION_CHANGED', 'DETACH_FAILED', 'EXIT_DRAIN_UNKNOWN']) {
  test('post-proof ' + code + ' retains proven-dead effect', async () => {
    const f = fixture(code === 'DETACH_FAILED' ? ['job', 'pty'] : ['pty', 'pty']);
    const b = f.bindings.get('target-0');
    if (code === 'DETACH_FAILED') {
      b.attachments = [{ sessionKey: b.sessionKey, session: b.session }];
      f.ports.detach = async () => false;
    } else {
      const stop = f.ports.stopPtyWithEvidence;
      f.ports.stopPtyWithEvidence = async (...args) => {
        const proof = await stop(...args);
        if (code === 'STOP_IDENTITY') b.identity.pid++;
        if (code === 'CONVERSATION_CHANGED') f.owners[0].treeState = 'live';
        if (code === 'EXIT_DRAIN_UNKNOWN') delete b.session.exitDrain;
        return proof;
      };
    }
    const { result } = await execute(f);
    const failed = result.failed.find(e => e.kind);
    assert.equal(failed.code, code);
    assert.equal(failed.effect, 'proven-dead', 'positive stop proof must survive post-check failure');
    assert.equal(failed.unknown, true, 'failure must not imply known absence of an effect');
    assert.deepEqual(result.skipped.map(t => t.id), ['target-1']);
  });
}

test('throw after invoking stop retains attempted effect', async () => {
  const f = fixture();
  f.ports.stopPtyWithEvidence = async () => { throw Object.assign(new Error('transport lost'), { code: 'TRANSPORT' }); };
  const { result } = await execute(f);
  assert.equal(result.failed[0].effect, 'attempted', 'invoked stop has an uncertain effect');
  assert.equal(result.failed[0].unknown, true);
});

for (const projectPath of [undefined, '', '   ', 42]) test('invalid project path ' + JSON.stringify(projectPath) + ' refuses preflight', async () => {
  const f = fixture(); f.request.project.projectPath = projectPath;
  f.ports.getScheduleRunSnapshot = () => [{ sessionId: 'headless', cwd: 'C:/project', scheduleName: 'nightly' }];
  const result = await f.adapter().preflight(f.request);
  assert.equal(result.ok, false, 'invalid project path must refuse before effects');
  assert.equal(result.failed[0].code, 'STOP_INPUT');
  assert.deepEqual(f.effects, []);
});

function assertTargetAccounting(result, targets) {
  const entries = [...result.stopped, ...result.failed, ...result.skipped].filter(e => e.kind);
  assert.deepEqual(entries.map(e => e.id).sort(), targets.map(t => t.id).sort(), 'each target occurs exactly once');
}

for (const code of ['CONVERSATION_UNKNOWN', 'CONVERSATION_UNCONTROLLED', 'HEADLESS_SCHEDULE']) {
  test('preflight ' + code + ' has its own refusal and skips every target', async () => {
    const f = fixture(['pty', 'job']);
    if (code === 'CONVERSATION_UNKNOWN') f.ports.readConversation = async () => ({ known: false });
    if (code === 'CONVERSATION_UNCONTROLLED') f.owners.push({ id: 'outsider', identity: { pid: 900, procStart: '900' }, treeState: 'live' });
    if (code === 'HEADLESS_SCHEDULE') f.ports.getScheduleRunSnapshot = () => [{ sessionId: 'headless', cwd: 'C:/project' }];
    const result = await f.adapter().preflight(f.request);
    assert.equal(result.failed[0].code, code);
    assert.equal(result.failed[0].kind, undefined, 'batch refusal is not attributed to the last target');
    assert.deepEqual(result.skipped.map(t => t.id), ['target-0', 'target-1']);
    assertTargetAccounting(result, f.targets);
  });
}

test('headless schedule appearing between stops accounts for every target', async () => {
  const f = fixture(['pty', 'pty']);
  f.ports.getScheduleRunSnapshot = () => f.owners[0].treeState === 'dead'
    ? [{ sessionId: 'headless', cwd: 'C:/project' }] : [];
  const { result } = await execute(f);
  assertTargetAccounting(result, f.targets);
  assert.equal(result.failed[0].code, 'HEADLESS_SCHEDULE');
  assert.equal(result.failed[0].kind, undefined);
  assert.deepEqual(result.skipped.map(t => t.id), ['target-1']);
  assert.deepEqual(f.effects, ['stop:target-0']);
});

test('caller mutation during preflight cannot widen background consent', async () => {
  const f = fixture(['pty', 'job']); f.request.stopBackgroundJobs = false;
  const read = f.ports.readTarget;
  f.ports.readTarget = async target => { f.request.stopBackgroundJobs = true; return read(target); };
  const result = await f.adapter().preflight(f.request);
  assert.equal(result.ok, false, 'captured consent cannot be widened by the caller');
  assert.equal(result.failed[0].code, 'BACKGROUND_CONSENT');
  assert.deepEqual(f.effects, []);
});

test('caller mutation after preflight cannot widen captured schedule consent', async () => {
  const f = fixture(); f.request.stopBackgroundJobs = false;
  const a = f.adapter(), p = await a.preflight(f.request);
  f.request.stopBackgroundJobs = true;
  f.ports.getScheduleRunSnapshot = () => [{ sessionId: 'headless', cwd: 'C:/project' }];
  const result = await a.stop(p);
  assert.equal(result.ok, false);
  assert.deepEqual(f.effects, []);
});

for (const kind of ['job', 'remote']) test(kind + ' attachment removed during death is not detached twice', async () => {
  const f = fixture([kind]), b = f.bindings.get('target-0');
  b.attachments = [{ sessionKey: b.sessionKey, session: b.session }];
  const stop = kind === 'job' ? f.ports.bg.runStop : f.ports.remote.stop;
  const finish = async (...args) => {
    const proof = await stop(...args);
    f.sessions.delete(b.sessionKey); b.attachments = []; b.session.pty = null;
    return proof;
  };
  if (kind === 'job') f.ports.bg.runStop = finish;
  else f.ports.remote.stop = finish;
  const { result } = await execute(f);
  assert.equal(result.ok, true, 'already removed attachment does not invalidate death evidence');
  assert.equal(f.effects.some(e => e.startsWith('detach:')), false, 'already detached attachment must not be closed again');
});
