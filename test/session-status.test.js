'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rig, mutate, sha } = require('./fixtures/session-request-watcher.cjs');
const openStore = require('./fixtures/conversation-store.cjs');
const { createJournal } = require('./fixtures/session-request-journal.cjs');
const file = path.join(__dirname, '../src/main/triggers/session-status.js');
const status = fs.existsSync(file) ? require(file) : {};
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const from = '20000000-0000-4000-8000-000000000001';
const payload = { version: 1, type: 'session-status', requestId: id, from, sessionId: id };
function gather(options = {}) {
  assert.equal(typeof status.createSessionStatus, 'function', 'main status gatherer must exist');
  const session = { generation: 1, pty: { pid: 42 }, statusPtyStart: '100', startedAt: 10, ...options.session };
  const sessions = new Map([[id, session], [from, { generation: 2, pty: { pid: 43 } }]]);
  sessions.statusGenerations = new Map([[id, session.generation], [from, 2]]);
  const service = status.createSessionStatus({ activeSessions: sessions, now: () => 1000,
    getKnown: () => ({ sessionId: id }), readHead: async () => ({ state: 'closed', observedAt: 30, lastEntryAt: 20 }), ...options, sessions: undefined });
  return { service, session, sessions };
}
test('owned descriptorless PTY with closed head is idle with original proof time', async () => {
  const { service } = gather();
  const result = await service.gather(id);
  assert.equal(result.state, 'idle'); assert.equal(result.liveness, 'alive');
  assert.equal(result.evidence, 'owned-pty'); assert.equal(result.pid, 42);
  assert.equal(result.evidence_at, new Date(30).toISOString());
});
test('open head wins shell and preserves the head evidence timestamp', async () => {
  const h = gather({ observeOwned: () => ({ writer: { status: 'shell', statusUpdatedAt: 50 } }),
    readHead: async () => ({ state: 'open', observedAt: 30, lastEntryAt: 20 }) });
  const result = await h.service.gather(id);
  assert.equal(result.detail, 'open-turn'); assert.equal(result.evidence_at, new Date(30).toISOString());
});
for (const [name, options, expected] of [
  ['PTY only', { readHead: async () => null }, ['unknown', 'head-unknown']],
  ['open head', { readHead: async () => ({ state: 'open', observedAt: 30, lastEntryAt: 20 }) }, ['busy', 'open-turn']],
  ['blocking dialog', { observeOwned: () => ({ writer: { status: 'waiting', waitingFor: 'permission', statusUpdatedAt: 50 } }) }, ['waiting', 'blocking-dialog']],
  ['waiting for input is not blocking', { observeOwned: () => ({ writer: { status: 'idle', waitingFor: 'input', statusUpdatedAt: 50 } }) }, ['idle', 'prompt']],
  ['shell', { observeOwned: () => ({ writer: { status: 'shell', statusUpdatedAt: 50 } }), readHead: async () => null }, ['busy', 'shell']],
  ['later OSC idle closes old open', { session: { _statusOsc: { generation: 1, idleAt: 50 } }, readHead: async () => ({ state: 'open', observedAt: 30, lastEntryAt: 20 }) }, ['idle', 'prompt']],
  ['new open beats old idle', { session: { _statusOsc: { generation: 1, idleAt: 50 } }, readHead: async () => ({ state: 'open', observedAt: 70, lastEntryAt: 60 }) }, ['busy', 'open-turn']],
  ['busy rise defeats stale idle', { session: { _statusOsc: { generation: 1, idleAt: 50, busyAt: 60 } }, readHead: async () => ({ state: 'open', observedAt: 30, lastEntryAt: 20 }) }, ['busy', 'open-turn']],
]) test(name, async () => {
  const { service } = gather(options), result = await service.gather(id);
  assert.deepEqual([result.state, result.detail], expected);
});
test('production generation and PTY pins are rechecked after a head await', async () => {
  for (const replace of [s => s.generation++, s => { s.pty = { pid: 42 }; }]) {
    const h = gather({ readHead: async () => { replace(h.session); return { state: 'closed' }; } });
    const result = await h.service.gather(id);
    assert.equal(result.state, 'unknown'); assert.equal(result.pid, null); assert.equal(result.evidence, 'none');
  }
});
for (const missing of [null, { uncertain: true }, { uncertain: true, writer: { pid: 99 } }]) {
  test(`M2: unavailable descriptor reread retains owned PTY liveness: ${JSON.stringify(missing)}`, async () => {
    let reads = 0;
    const h = gather({ observeOwned: () => ++reads === 1
      ? { writer: { pid: 42, procStart: '30', status: 'waiting', waitingFor: 'permission' } } : missing });
    const result = await h.service.gather(id);
    assert.deepEqual([result.state, result.liveness, result.evidence, result.descriptorStatus],
      ['idle', 'alive', 'owned-pty', null], 'missing descriptor must drop only its evidence');
  });
}
test('descriptor with matching bg job supplies job evidence when hosted verification is unavailable', async () => {
  const h = gather({ hosted: () => ({ id: 'job1', verified: false, live: false }),
    probe: async () => ({ known: true, live: { kind: 'bg', pid: 60, procStart: '30', jobId: 'job1' } }) });
  h.sessions.delete(id);
  const result = await h.service.gather(id);
  assert.deepEqual([result.state, result.liveness, result.evidence, result.jobId], ['idle', 'alive', 'background-job', 'job1']);
});
test('STATUS-PROBE-UNBOUNDED: one absolute 2000ms deadline, late probe cannot rewrite result', async () => {
  let now = 0, resolveProbe, settled = false;
  const timers = new Map();
  const advance = at => { now = at; for (const [token, timer] of timers) if (timer.at <= now) { timers.delete(token); timer.fn(); } };
  const h = gather({ now: () => now, platform: 'win32', session: { exited: true },
    probe: () => new Promise(resolve => { resolveProbe = resolve; }),
    schedule(fn, ms) { const token = {}; timers.set(token, { fn, at: now + ms }); return token; }, cancel(token) { timers.delete(token); },
    readHead: async () => ({ state: 'closed', observedAt: 10 }),
  });
  const pending = h.service.gather(id).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  advance(2000); await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(settled, true, 'status must have returned by the single 2000ms deadline'); }
  finally { if (!settled) advance(5000); }
  const result = await pending;
  assert.equal(result.liveness, 'unknown'); assert.equal(result.evidence_at, null); assert.equal(result.pid, null);
  assert.equal(result.headTurn, 'closed');
  const bytes = JSON.stringify(result); now = 5000; resolveProbe({ known: true, live: { pid: 42 } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(JSON.stringify(result), bytes);
});
test('not found has exact null ownership fields; known unsupported provider remains known', async () => {
  const h = gather({ getKnown: () => null }); h.sessions.delete(id);
  const result = await h.service.gather(id);
  assert.equal(result.detail, 'not-found'); assert.equal(result.sessionId, null);
  for (const key of ['pid', 'jobId', 'evidence_at', 'descriptorStatus']) assert.equal(result[key], null);
  const other = gather({ getKnown: () => ({ sessionId: id, cli: 'other' }) }); other.sessions.delete(id);
  assert.equal((await other.service.gather(id)).sessionId, id);
});
test('competing verified descriptors retain the known target id and ambiguous detail without a cache row', async () => {
  const h = gather({ getKnown: () => null, probe: async () => ({ known: false, ambiguous: true }) }); h.sessions.delete(id);
  const result = await h.service.gather(id);
  assert.equal(result.sessionId, id); assert.equal(result.detail, 'ambiguous'); assert.equal(result.evidence, 'none');
});

for (const [name, live, evidence] of [
  ['descriptor', { pid: 50, rawPid: 50, procStart: '30', namespace: 'host', statusUpdatedAt: 40 }, 'descriptor'],
  ['sandbox descriptor', { pid: 50, rawPid: 3, procStart: '30', namespace: 'box', statusUpdatedAt: 40 }, 'sandbox-mapped-descriptor'],
]) test(`verified ${name} is a known target without a cache row`, async () => {
  const h = gather({ getKnown: () => null, probe: async () => ({ known: true, live }) }); h.sessions.delete(id);
  const result = await h.service.gather(id);
  assert.equal(result.sessionId, id); assert.equal(result.liveness, 'alive'); assert.equal(result.evidence, evidence);
});
test('descriptor namespace changed across a head await is ambiguous even with same PID and start', async () => {
  let namespace = 'box1';
  const h = gather({ observeOwned: () => ({ writer: { pid: 50, procStart: '30', namespace, status: 'idle' } }),
    readHead: async () => { namespace = 'box2'; return { state: 'closed', observedAt: 30 }; } });
  const result = await h.service.gather(id);
  assert.equal(result.detail, 'ambiguous'); assert.equal(result.liveness, 'unknown'); assert.equal(result.pid, null);
});
test('verified tree death normalizes dead/confirmedExit/ptyHere together; successor overrides old exit', async () => {
  const exits = new Map([[id, { confirmed: true, generation: 1, at: 35 }]]);
  const dead = gather({ exits, probe: async () => ({ known: true, live: null }) }); dead.sessions.delete(id);
  const result = await dead.service.gather(id);
  assert.equal(result.state, 'exited'); assert.equal(result.liveness, 'dead'); assert.equal(result.evidence, 'confirmed-exit');
  assert.equal(result.evidence_at, new Date(35).toISOString());
  const live = gather({ exits }); assert.equal((await live.service.gather(id)).state, 'idle');
  const descriptor = gather({ exits, probe: async () => ({ known: true, live: { pid: 60, procStart: '40', namespace: 'new' } }) }); descriptor.sessions.delete(id);
  assert.equal((await descriptor.service.gather(id)).liveness, 'alive', 'a live descriptor successor defeats old tree death');
});
test('an unverified possible hosted successor prevents an old exit proof from becoming confirmed death', async () => {
  const h = gather({ exits: new Map([[id, { confirmed: true, at: 35 }]]),
    hosted: () => ({ id: 'job1', verified: false, live: false }), probe: async () => ({ known: true, live: null }) });
  h.sessions.delete(id);
  const result = await h.service.gather(id);
  assert.equal(result.state, 'unknown'); assert.equal(result.evidence, 'none'); assert.equal(result.liveness, 'unknown');
});
for (const state of ['done', 'working', 'blocked']) test(`verified hosted ${state} job keeps independent liveness`, async () => {
  const h = gather({ session: { isAttach: true }, hosted: () => ({ verified: true, live: true, id: 'job1', pid: 60, observedAt: 50,
    descriptor: { status: state === 'blocked' ? 'waiting' : null, waitingFor: state === 'blocked' ? 'job' : null, statusUpdatedAt: 50 } }),
    readHead: async () => state === 'working' ? null : { state: 'closed', observedAt: 30 } });
  const result = await h.service.gather(id);
  assert.equal(result.liveness, 'alive'); assert.equal(result.evidence, 'background-job'); assert.equal(result.jobId, 'job1');
  assert.equal(result.state, state === 'blocked' ? 'waiting' : state === 'working' ? 'unknown' : 'idle');
});
test('attach exit during the head read cannot erase a separately verified live hosted job', async () => {
  const h = gather({ session: { isAttach: true }, hosted: () => ({ verified: true, live: true, id: 'job1', pid: 60, observedAt: 50 }),
    readHead: async () => { h.session.exited = true; return { state: 'closed', observedAt: 30 }; } });
  const result = await h.service.gather(id);
  assert.equal(result.liveness, 'alive'); assert.equal(result.state, 'idle'); assert.equal(result.evidence, 'background-job');
});
test('a hosted job identity change during head read is ambiguous rather than reusing its PID', async () => {
  let namespace = 'box1';
  const h = gather({ session: { isAttach: true }, hosted: () => ({ verified: true, live: true, id: 'job1', pid: 60, procStart: '100', namespace, observedAt: 50 }),
    readHead: async () => { namespace = 'box2'; return { state: 'closed', observedAt: 30 }; } });
  const result = await h.service.gather(id);
  assert.equal(result.detail, 'ambiguous'); assert.equal(result.pid, null); assert.equal(result.jobId, null);
});
test('foreign provider proof is not treated as Claude and unattested hosted rows do not prove live', async () => {
  const h = gather({ getKnown: () => ({ sessionId: id, cli: 'codex' }), probe: async () => ({ known: true, live: { pid: 60 } }),
    hosted: () => ({ verified: false, live: true }) }); h.sessions.delete(id);
  assert.equal((await h.service.gather(id)).liveness, 'unknown');
});

test('stalled head reader preserves owned PTY proof even when descriptor observation expires', async () => {
  let now = 0, timer;
  const h = gather({ now: () => now, readHead: () => new Promise(() => {}),
    observeOwned: () => now < 2000 ? { writer: { pid: 42, status: 'idle', procStart: '30' } } : { uncertain: true },
    schedule: fn => { timer = fn; return 1; }, cancel() {},
  });
  const pending = h.service.gather(id); await new Promise(resolve => setImmediate(resolve));
  now = 2000; timer(); const result = await pending;
  assert.equal(result.liveness, 'alive', 'reader timeout cannot erase independently owned current PTY proof');
  assert.equal(result.state, 'unknown'); assert.equal(result.detail, 'head-unknown'); assert.equal(result.evidence, 'owned-pty');
});
test('owned status does not initiate a Windows table probe when the existing table is stale', async () => {
  const { createTriggerContext } = require('../src/main/triggers/trigger-context');
  const activeSessions = new Map([[id, { generation: 1, pty: { pid: 42 }, startedAt: 10 }]]);
  let observations = 0;
  const context = createTriggerContext({ activeSessions, log: {}, statusSources: { readHead: async () => ({ state: 'closed', observedAt: 20 }) },
    cliSessionState: { deliveryProcessTableFresh: () => false, observeTabWriter() { observations++; return null; } } });
  const result = await context.sessionStatus.gather(id);
  assert.equal(result.state, 'idle');
  if (process.platform === 'win32') assert.equal(observations, 0, 'owned PTY status must not initiate a global Windows refresh');
});
test('real typed uppercase publication replays after author closes with zero extra gathers', async t => {
  let gathers = 0, authorOpen = true, authorChecks = 0, state = 'idle';
  const r = await rig(t, { stem: id.toUpperCase(), payload, ctx: { sessionStatus: {
    author: () => { authorChecks++; return authorOpen; }, gather: async () => { gathers++; return { state, detail: 'prompt', liveness: 'alive', headTurn: 'closed', sessionId: id }; },
  } } });
  const output = path.join(r.processed, id.toUpperCase() + '.result.json');
  assert.ok(fs.existsSync(output), 'typed result must be published');
  const first = fs.readFileSync(output), result = JSON.parse(first);
  assert.equal(result.type, 'session-status'); assert.equal(result.ok, true); assert.equal(result.state, 'idle');
  assert.equal(r.effects(), 0); assert.equal(gathers, 1);
  authorOpen = false; state = 'busy'; fs.unlinkSync(output); fs.writeFileSync(r.input, r.body);
  await r.notify();
  assert.equal(gathers, 1, 'exact replay must never gather after author closure');
  assert.equal(authorChecks, 1, 'exact replay precedes current author validation');
  assert.deepEqual(fs.readFileSync(output), first);
  assert.ok(fs.readdirSync(r.processed).includes(id.toUpperCase() + '.result.json'));
  fs.unlinkSync(output); fs.writeFileSync(r.input, r.body); fs.utimesSync(r.input, new Date(0), new Date(0)); await r.notify();
  assert.deepEqual(fs.readFileSync(output), first); assert.equal(gathers, 1); assert.equal(authorChecks, 1);
  fs.writeFileSync(path.join(r.dir, id + '.json'), JSON.stringify({ version: 1, action: 'stop', sessionId: id }));
  await r.notify(id + '.json');
  assert.deepEqual(fs.readFileSync(output), first); assert.equal(r.effects(), 0);
  assert.ok(fs.readdirSync(r.processed).some(n => n.endsWith('.request')));
});
test('exact raw replay preserves an earlier action-family result before new typed classification', async t => {
  const journal = createJournal(), raw = Buffer.from(JSON.stringify(payload));
  const original = Buffer.from('{"prior":"unsupported-action"}\n');
  await mutate(journal, 'claimSessionResultNamespace', { stemKey: id, actualStem: id, family: 'action',
    suppliedHash: null, rawHash: sha(raw), resultBytes: original });
  let gathers = 0;
  const r = await rig(t, { stem: id.toUpperCase(), raw, journal, ctx: { sessionStatus: {
    author: () => false, gather: async () => { gathers++; return {}; },
  } } });
  const output = path.join(r.processed, id + '.result.json');
  assert.ok(fs.existsSync(output), 'a saved raw-identity result must replay across a later family classification');
  assert.deepEqual(fs.readFileSync(output), original);
  assert.deepEqual(fs.readdirSync(r.processed), [id + '.result.json']);
  assert.equal(fs.existsSync(r.input), false); assert.equal(gathers, 0); assert.equal(r.effects(), 0);
});
for (const fail of ['write', 'rename']) test(`typed ${fail} failure retains input then replays committed bytes`, async t => {
  let gathers = 0;
  const r = await rig(t, { stem: id, payload, fail, ctx: { sessionStatus: { author: () => true, gather: async () => { gathers++; return { state: 'idle', sessionId: id }; } } } });
  assert.ok(fs.existsSync(r.input), 'failed publication must retain the original input');
  assert.deepEqual(fs.readFileSync(r.input), r.body);
  assert.equal(fs.existsSync(path.join(r.processed, id + '.result.json')), false);
  r.control.fail = null; await r.retry();
  assert.equal(gathers, 1); assert.equal(fs.existsSync(r.input), false);
});
test('typed open-session refusal is journalled forever without lifecycle effects', async t => {
  const r = await rig(t, { stem: id, payload: { version: 1, type: 'open-session', requestId: id, from, kind: 'child', project: process.cwd(), prompt: 'Hello' } });
  const output = path.join(r.processed, id + '.result.json');
  assert.ok(fs.existsSync(output)); const bytes = fs.readFileSync(output), result = JSON.parse(bytes);
  assert.equal(result.reason, 'unsupported trigger type'); assert.equal(result.error, 'invalid request');
  assert.equal(result.type, 'open-session'); assert.equal(result.text_written, false); assert.equal(result.submitted, 'no');
  assert.equal(r.effects(), 0); fs.unlinkSync(output); fs.writeFileSync(r.input, r.body); await r.notify();
  assert.deepEqual(fs.readFileSync(output), bytes); assert.equal(r.effects(), 0);
});
test('side-quest unsupported refusal replays a case-normalized forkFrom without a conflict', async t => {
  const request = { version: 1, type: 'open-session', requestId: id, from, kind: 'side-quest', project: process.cwd(), prompt: 'Report.', forkFrom: id.toUpperCase() };
  const r = await rig(t, { stem: id, payload: request });
  const output = path.join(r.processed, id + '.result.json'); assert.ok(fs.existsSync(output));
  const bytes = fs.readFileSync(output);
  fs.writeFileSync(r.input, JSON.stringify({ ...request, forkFrom: id })); await r.notify();
  assert.deepEqual(fs.readFileSync(output), bytes); assert.equal(r.effects(), 0);
  assert.equal(fs.readdirSync(r.processed).some(name => name.includes('.conflict-')), false, 'UUID spelling is the same supplied request');
});

test('typed lost consume ACK retains input, then ordered replay publishes without gathering again', async t => {
  let gathers = 0;
  const r = await rig(t, { stem: id, payload, ackError: 'recordConsumedSessionStatusRequest', ctx: { sessionStatus: {
    author: () => true, gather: async () => { gathers++; return { state: 'idle', sessionId: id }; },
  } } });
  assert.deepEqual(fs.readFileSync(r.input), r.body);
  assert.equal(fs.existsSync(path.join(r.processed, id + '.result.json')), false);
  r.control.ackError = null; await r.retry();
  assert.equal(gathers, 1); assert.equal(fs.existsSync(r.input), false); assert.equal(r.effects(), 0);
});
test('typed conflicting request gets a complete immutable status refusal envelope', async t => {
  const r = await rig(t, { stem: id, payload: { version: 1, action: 'stop', sessionId: id } });
  fs.writeFileSync(r.input, JSON.stringify(payload)); await r.notify();
  const name = fs.readdirSync(r.processed).find(n => n.includes('.conflict-') && n.endsWith('.result.json'));
  assert.ok(name); const result = JSON.parse(fs.readFileSync(path.join(r.processed, name)));
  assert.equal(result.type, 'session-status'); assert.equal(result.reason, 'requestId already used for a different request');
  assert.equal(result.requestedSessionId, id); assert.equal(result.evidence, 'none'); assert.equal(result.pid, null);
});
test('typed unexpected gather failure has a bounded public envelope without raw exception text', async t => {
  const r = await rig(t, { stem: id, payload, ctx: { sessionStatus: { author: () => true, gather: async () => { throw new Error('secret fixture'); } } } });
  const result = JSON.parse(fs.readFileSync(path.join(r.processed, id + '.result.json')));
  assert.equal(result.type, 'session-status'); assert.equal(result.error, 'internal error'); assert.equal(result.reason, 'session request failed');
  assert.equal(result.submitted, 'no'); assert.equal(Object.hasOwn(result, 'wrote'), false);
});
test('a new stale typed request is not admitted and never gathers or touches a PTY', async t => {
  let gathers = 0;
  const r = await rig(t, { stem: id, payload, stale: true, ctx: { sessionStatus: { author: () => true, gather: async () => { gathers++; return {}; } } } });
  const result = JSON.parse(fs.readFileSync(path.join(r.processed, id + '.result.json')));
  assert.equal(result.type, 'session-status'); assert.equal(result.error, 'not admitted');
  assert.equal(result.reason, 'trigger exceeds staleness limit'); assert.equal(result.requestedSessionId, id);
  assert.equal(gathers, 0); assert.equal(r.effects(), 0);
});
for (const mode of ['truncated', 'oversize']) test(`an unowned ${mode} typed request has the complete undetermined refusal envelope`, async t => {
  const raw = mode === 'truncated' ? Buffer.from(JSON.stringify(payload).slice(0, -1))
    : Buffer.from(JSON.stringify({ ...payload, extra: 'x'.repeat(65536) }));
  const r = await rig(t, { stem: id, raw });
  const output = path.join(r.processed, id + '.result.json'); assert.ok(fs.existsSync(output));
  const result = JSON.parse(fs.readFileSync(output));
  assert.equal(result.liveness, 'unknown'); assert.equal(result.state, 'unknown'); assert.equal(result.type, null);
  assert.equal(result.requestId, null); assert.equal(result.requestedSessionId, null); assert.equal(result.submitted, 'no');
  assert.equal(result.reason, mode === 'truncated' ? 'invalid JSON' : 'trigger too large (max 64 KB)');
  assert.equal(r.effects(), 0); assert.equal(Object.hasOwn(result, 'wrote'), false);
});

for (const incoming of ['legacy', 'action', 'malformed', 'stale', 'oversize', 'typed']) for (const sameCase of [true, false]) {
  test(`real typed owner rejects ${incoming} conflict, sameCase=${sameCase}`, async t => {
    const r = await rig(t, { stem: id.toUpperCase(), payload, ctx: { sessionStatus: {
      author: () => true, gather: async () => ({ state: 'idle', sessionId: id }),
    } } });
    const ownerPath = path.join(r.processed, id.toUpperCase() + '.result.json');
    assert.ok(fs.existsSync(ownerPath)); const bytes = fs.readFileSync(ownerPath);
    const stem = sameCase ? id.toUpperCase() : id, input = path.join(r.dir, stem + '.json');
    const raw = incoming === 'malformed' ? Buffer.from('{bad') : incoming === 'oversize' ? Buffer.alloc(100000, 120)
      : Buffer.from(JSON.stringify(incoming === 'action' ? { version: 1, action: 'stop', sessionId: id }
        : incoming === 'typed' ? { ...payload, sessionId: from } : { sessionId: id, command: 'hello' }));
    fs.writeFileSync(input, raw); if (incoming === 'stale') fs.utimesSync(input, new Date(0), new Date(0));
    await r.notify(stem + '.json');
    if (incoming === 'malformed') { await new Promise(resolve => setTimeout(resolve, 70)); await r.settle(); }
    assert.deepEqual(fs.readFileSync(ownerPath), bytes); assert.equal(r.effects(), 0);
    assert.ok(fs.readdirSync(r.processed).includes(id.toUpperCase() + '.result.json'));
    const archive = fs.readdirSync(r.processed).find(name => name.endsWith('.request'));
    assert.ok(archive, 'conflicting raw input is archived'); assert.deepEqual(fs.readFileSync(path.join(r.processed, archive)), raw);
  });
}
test('typed unexpected parent flush failure retains visible committed bytes and input', async t => {
  let fail = true, gathers = 0;
  const r = await rig(t, { stem: id, payload, fs: { openSync(file, ...args) {
    if (fail && path.basename(file) === 'processed') throw Object.assign(new Error('parent failure'), { code: 'EIO' });
    return fs.openSync(file, ...args);
  } }, ctx: { sessionStatus: { author: () => true, gather: async () => { gathers++; return { state: 'idle', sessionId: id }; } } } });
  const output = path.join(r.processed, id + '.result.json');
  assert.ok(fs.existsSync(output)); assert.ok(fs.existsSync(r.input));
  const bytes = fs.readFileSync(output); assert.deepEqual(fs.readFileSync(r.input), r.body);
  fail = false; await r.retry(); assert.deepEqual(fs.readFileSync(output), bytes); assert.equal(gathers, 1);
});
test('typed replay survives writer store reopen and processed deletion after author closes', {
  skip: !openStore.supported && 'native SQLite ABI differs; node:sqlite requires Node 22',
}, async t => {
  let db = openStore(); t.after(() => db.closeDb());
  const journal = createJournal(db), query = journal.querySessionRequestOutcome;
  let delayed = false;
  journal.querySessionRequestOutcome = async input => {
    if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 80)); }
    return query(input);
  };
  const r = await rig(t, { stem: id, payload, journal,
    until: ({ processed, input }) => fs.existsSync(path.join(processed, id + '.result.json')) && !fs.existsSync(input),
    ctx: { sessionStatus: {
    author: () => true, gather: async () => ({ state: 'idle', sessionId: id }),
  } } });
  const output = path.join(r.processed, id + '.result.json'); assert.ok(fs.existsSync(output));
  const bytes = fs.readFileSync(output); fs.unlinkSync(output); db.closeDb(); db = openStore();
  let gathers = 0;
  const next = await rig(t, { stem: id, payload, stale: true, journal: createJournal(db),
    until: ({ processed, input }) => fs.existsSync(path.join(processed, id + '.result.json')) && !fs.existsSync(input),
    ctx: { sessionStatus: {
    author: () => false, gather: async () => { gathers++; return { state: 'busy' }; },
  } } });
  assert.deepEqual(fs.readFileSync(path.join(next.processed, id + '.result.json')), bytes); assert.equal(gathers, 0);
});
