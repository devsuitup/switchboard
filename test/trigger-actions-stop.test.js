'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { noteUserInput } = require('../src/main/terminals/composer-state');
const { makeWorld, makeClock, makeEnv, makeActions, ID_A } = require('./helpers/trigger-world');

const stopRequest = (extra = {}) => ({ version: 1, action: 'stop', sessionId: ID_A, ...extra });

function setup(overrides = {}) {
  const clock = makeClock();
  const world = makeWorld();
  const session = world.addSession(ID_A);
  const { actions, calls, deps } = makeActions(world, { now: clock.now, sleep: clock.sleep, ...overrides });
  const run = (extra, deadlineMs = 60000) => actions.run(stopRequest(extra), makeEnv(clock.now() + deadlineMs));
  return { clock, world, session, actions, calls, deps, run };
}

test('bare stop of an idle target calls the sidebar backend once and reports closed only after the pinned exit', async () => {
  const stops = [];
  const t = setup({ now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    stopSession: async (key, session) => { stops.push(key); setTimeout(() => { session.exited = true; }, 20); return { ok: true }; } });
  let exitedWhenSettled;
  const pending = t.actions.run(stopRequest(), makeEnv(Date.now() + 5000)).then(result => { exitedWhenSettled = t.session.exited; return result; });
  const done = await pending;
  assert.equal(done.outcome, 'closed');
  assert.equal(done.ok, true);
  assert.equal(done.reason, null);
  assert.equal(done.sessionId, ID_A);
  assert.equal(done.wrote, false);
  assert.equal(done.steps_total, 0);
  assert.equal(exitedWhenSettled, true);
  assert.deepEqual(stops, [ID_A]);
});

test('a kill request that never produces an exit is refused as not confirmed and uncertain', async () => {
  const t = setup({ stopSession: async () => ({ ok: true }) });
  const result = await t.run({}, 500);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'session stop not confirmed');
  assert.equal(result.uncertain, true);
});

test('a backend that cannot initiate the stop is refused as stop failed with its error', async () => {
  const t = setup({ stopSession: async () => ({ ok: false, error: 'not running' }) });
  const result = await t.run();
  assert.equal(result.reason, 'session stop failed');
  assert.equal(result.error, 'not running');
});

test('bare stop refuses every non-idle state without a write or a kill', async () => {
  const cases = [
    ['busy flag', t => { t.session._cliBusy = true; }, 'session busy'],
    ['busy descriptor', t => { t.world.statuses.set(ID_A, { status: 'busy', statusUpdatedAt: Date.now() }); }, 'session busy'],
    ['waiting descriptor', t => { t.world.statuses.set(ID_A, { status: 'waiting', statusUpdatedAt: Date.now() }); }, 'session waiting on a dialog'],
    ['shell descriptor', t => { t.world.statuses.set(ID_A, { status: 'shell', statusUpdatedAt: Date.now() }); }, 'session running a shell command'],
    ['unknown descriptor', t => { t.world.statuses.delete(ID_A); }, 'session state unavailable'],
    ['pending input', t => { noteUserInput(t.session.composerState, 'abc', t.clock.now() - 10000); }, 'session has unsubmitted input'],
    ['unobservable composer', t => { delete t.session.composerState; }, 'session composer unavailable'],
  ];
  for (const [name, arrange, reason] of cases) {
    const t = setup();
    arrange(t);
    const result = await t.run();
    assert.equal(result.reason, reason, name);
    assert.equal(result.outcome, 'refused', name);
    assert.equal(result.submitted, 'no', name);
    assert.deepEqual(t.calls.stop, [], name);
    assert.deepEqual(t.world.writes, [], name);
  }
});

test('busy outranks a pending composer and state reasons outrank composer reasons', async () => {
  const t = setup();
  t.session._cliBusy = true;
  noteUserInput(t.session.composerState, 'abc', t.clock.now());
  assert.equal((await t.run()).reason, 'session busy');
  const u = setup();
  u.world.statuses.set(ID_A, { status: 'waiting', statusUpdatedAt: Date.now() });
  delete u.session.composerState;
  assert.equal((await u.run()).reason, 'session waiting on a dialog');
});

function typeThenDelete(t, at) {
  noteUserInput(t.session.composerState, 'a', at);
  noteUserInput(t.session.composerState, '\x7f', at);
  assert.equal(t.session.composerState.pending, 0);
  assert.equal(t.session.composerState.lastInputAt, at);
}

test('an empty composer inside the quiet window waits for the remaining interval, then stops once', async () => {
  const t = setup();
  const at = t.clock.now();
  typeThenDelete(t, at);
  t.clock.t = at + 100;
  t.deps.sleep = undefined;
  const stops = [];
  const clock = t.clock;
  const { actions } = makeActions(t.world, { now: clock.now, stopSession: async (key, session) => { stops.push(clock.now()); session.exited = true; return { ok: true }; },
    sleep: async ms => { assert.ok(stops.length === 0); clock.t += ms; } });
  const result = await actions.run(stopRequest(), makeEnv(at + 60000));
  assert.equal(result.outcome, 'closed');
  assert.deepEqual(stops, [at + 3000]);
});

test('a deadline before or exactly at the quiet boundary refuses as not quiet and never stops later', async () => {
  for (const deadlineAt of [3000 - 1, 3000]) {
    const t = setup();
    const at = t.clock.now();
    typeThenDelete(t, at);
    t.clock.t = at + 100;
    const result = await t.actions.run(stopRequest(), makeEnv(at + deadlineAt));
    assert.equal(result.reason, 'session input not quiet', String(deadlineAt));
    assert.equal(result.submitted, 'no');
    assert.equal(result.wrote, false);
    assert.equal(result.steps_total, 0);
    assert.equal(result.uncertain, undefined);
    t.clock.t += 10000;
    await t.clock.sleep(0);
    assert.deepEqual(t.calls.stop, []);
    assert.deepEqual(t.world.writes, []);
  }
});

test('admission exactly at the quiet boundary stops immediately', async () => {
  const t = setup();
  const at = t.clock.now();
  typeThenDelete(t, at);
  t.clock.t = at + 3000;
  const result = await t.actions.run(stopRequest(), makeEnv(at + 5000));
  assert.equal(result.outcome, 'closed');
  assert.deepEqual(t.calls.stop, [ID_A]);
});

test('a configured quiet window replaces the default', async () => {
  const t = setup({ helpers: { normalizeCwd: v => v, getQuietMs: () => 250, deliverPrompt: async () => ({ ok: true, evidence: {} }) } });
  const at = t.clock.now();
  typeThenDelete(t, at);
  t.clock.t = at + 249;
  const result = await t.actions.run(stopRequest(), makeEnv(at + 5000));
  assert.equal(result.outcome, 'closed');
  assert.equal(t.clock.now(), at + 250);
});

test('another keystroke while waiting restarts the quiet interval', async () => {
  const t = setup();
  const at = t.clock.now();
  typeThenDelete(t, at);
  let bumped = false;
  const sleep = async ms => {
    t.clock.t += ms;
    if (!bumped && t.clock.now() >= at + 1000) { bumped = true; typeThenDelete(t, t.clock.now()); }
  };
  const { actions, calls } = makeActions(t.world, { now: t.clock.now, sleep });
  const result = await actions.run(stopRequest(), makeEnv(at + 60000));
  assert.equal(result.outcome, 'closed');
  assert.ok(t.clock.now() >= at + 1000 + 3000);
  assert.equal(calls.stop.length, 1);
});

test('composer observability lost or pending text during the quiet wait refuses immediately', async () => {
  for (const [mutate, reason] of [
    [t => { delete t.session.composerState; }, 'session composer unavailable'],
    [t => { noteUserInput(t.session.composerState, 'x', t.clock.now()); }, 'session has unsubmitted input'],
  ]) {
    const t = setup();
    const at = t.clock.now();
    typeThenDelete(t, at);
    const sleep = async ms => { t.clock.t += ms; mutate(t); };
    const { actions, calls } = makeActions(t.world, { now: t.clock.now, sleep });
    const result = await actions.run(stopRequest(), makeEnv(at + 60000));
    assert.equal(result.reason, reason);
    assert.deepEqual(calls.stop, []);
  }
});

test('a busy, waiting or shell transition during the wait uses its state reason and cancels the stop', async () => {
  for (const [status, reason] of [['busy', 'session busy'], ['waiting', 'session waiting on a dialog'], ['shell', 'session running a shell command']]) {
    const t = setup();
    const at = t.clock.now();
    typeThenDelete(t, at);
    const sleep = async ms => { t.clock.t += ms; t.world.statuses.set(ID_A, { status, statusUpdatedAt: t.clock.now() }); };
    const { actions, calls } = makeActions(t.world, { now: t.clock.now, sleep });
    const result = await actions.run(stopRequest(), makeEnv(at + 60000));
    assert.equal(result.reason, reason);
    assert.deepEqual(calls.stop, []);
    t.clock.t += 60000;
    assert.deepEqual(calls.stop, []);
  }
});

test('the guard repeated immediately before the backend re-waits when the composer changed after an eligible sample', async () => {
  const t = setup();
  const at = t.clock.now();
  typeThenDelete(t, at);
  t.clock.t = at + 3000;
  let reads = 0;
  let changedAt;
  const original = t.world.ctx.pinDelivery;
  t.world.ctx.pinDelivery = (...args) => {
    const pinned = original(...args);
    pinned.ctx.getComposerState = () => {
      reads += 1;
      changedAt ??= t.clock.now();
      return reads === 1 ? { pending: 0, lastInputAt: 0 } : { pending: 0, lastInputAt: changedAt };
    };
    return pinned;
  };
  const sleep = async ms => { t.clock.t += ms; };
  const { actions, calls } = makeActions(t.world, { now: t.clock.now, sleep });
  const result = await actions.run(stopRequest(), makeEnv(at + 60000));
  assert.equal(result.outcome, 'closed');
  assert.ok(t.clock.now() >= at + 3000 + 3000, 'the stop waited for a fresh quiet interval');
  assert.equal(calls.stop.length, 1);
});

test('a replaced pinned entry before the backend call is refused as target changed', async () => {
  const t = setup();
  let samples = 0;
  const original = t.world.ctx.pinDelivery;
  t.world.ctx.pinDelivery = (...args) => {
    const pinned = original(...args);
    const check = pinned.ctx.getPtyForSession;
    pinned.ctx.getPtyForSession = (...rest) => { samples += 1; return samples > 2 ? null : check(...rest); };
    return pinned;
  };
  const result = await t.run();
  assert.equal(result.reason, 'session target changed');
  assert.deepEqual(t.calls.stop, []);
});

test('stop of a closed known session is not-found "session not open here", of an unknown one "session not found"', async () => {
  const world = makeWorld();
  const known = makeActions(world, { resolveClosed: async () => ({ status: 'found' }) });
  const knownResult = await known.actions.run(stopRequest(), makeEnv(Date.now() + 5000));
  assert.equal(knownResult.outcome, 'not-found');
  assert.equal(knownResult.reason, 'session not open here');
  const unknown = makeActions(world);
  const unknownResult = await unknown.actions.run(stopRequest(), makeEnv(Date.now() + 5000));
  assert.equal(unknownResult.outcome, 'not-found');
  assert.equal(unknownResult.reason, 'session not found');
  assert.deepEqual(known.calls.ensureOpen, []);
  assert.deepEqual(known.calls.deliver, []);
});

const { arrange } = require('./helpers/trigger-flow');
const flowWrites = events => events.filter(event => event[0] === 'write').map(event => event[2]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function flow(t, options = {}) {
  process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
  process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '2000';
  process.env.SWITCHBOARD_BUSY_FALL_SETTLE_MS = '100';
  process.env.SWITCHBOARD_TRIGGER_QUIET_MS = '0';
  const stops = [];
  const a = arrange(t, { ...options, deps: { stopSession: async (key, session) => { stops.push(key); session.exited = true; return { ok: true }; }, ...options.deps } });
  const session = a.world.addSession(ID_A);
  return { ...a, stops, session };
}

test('stop with a note waits for a busy target, delivers the note once, then stops the same pinned entry', async t => {
  const a = flow(t, { turnMs: 250 });
  a.session._cliBusy = true;
  a.world.statuses.set(ID_A, { status: 'busy', statusUpdatedAt: Date.now() });
  setTimeout(() => { a.session._cliBusy = false; a.world.statuses.set(ID_A, { status: 'idle', statusUpdatedAt: Date.now() }); }, 400);
  const result = await a.submit({ version: 1, action: 'stop', sessionId: ID_A, before: 'save a note', timeout_ms: 8000 });
  assert.equal(result.outcome, 'closed');
  assert.equal(result.reason, null);
  assert.equal(result.steps_total, 1);
  assert.equal(result.wrote, true);
  assert.deepEqual(flowWrites(a.events), ['save a note', '\r']);
  assert.deepEqual(a.stops, [ID_A]);
});

test('a turn that never ends within the deadline prevents the stop and reports the note unfinished', async t => {
  const a = flow(t, { turnMs: 60000 });
  const result = await a.submit({ version: 1, action: 'stop', sessionId: ID_A, before: 'long note', timeout_ms: 1600 });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'note step not finished');
  assert.equal(result.uncertain, true);
  assert.equal(result.delivery.timedOut, true);
  assert.deepEqual(a.stops, []);
  await wait(400);
  assert.deepEqual(a.stops, [], 'no delayed kill');
});

test('an absorbed Enter that never starts a turn leaves the session running', async t => {
  const a = flow(t, { autoTurn: false });
  const result = await a.submit({ version: 1, action: 'stop', sessionId: ID_A, before: 'absorbed', timeout_ms: 1500 });
  assert.equal(result.reason, 'note step not finished');
  assert.equal(result.submitted, 'assumed');
  assert.equal(result.text_written, true);
  assert.equal(result.enter_written, true);
  assert.deepEqual(a.stops, []);
  await wait(300);
  assert.deepEqual(a.stops, []);
});

test('a dialog open at the note readiness gate refuses the note and keeps the process', async t => {
  const a = flow(t);
  a.world.statuses.set(ID_A, { status: 'waiting', statusUpdatedAt: Date.now() });
  const result = await a.submit({ version: 1, action: 'stop', sessionId: ID_A, before: 'x', timeout_ms: 700 });
  assert.equal(result.reason, 'note step not finished');
  assert.match(result.delivery.reason, /dialog open/);
  assert.deepEqual(flowWrites(a.events), []);
  assert.deepEqual(a.stops, []);
});

test('a new turn, a dirty composer or a changed state after the note prevents the kill', async () => {
  for (const [name, mutate, reason] of [
    ['new turn', (world, session) => { session._cliBusy = true; world.statuses.set(ID_A, { status: 'busy', statusUpdatedAt: Date.now() + 10 }); }, 'session busy'],
    ['dialog', world => world.statuses.set(ID_A, { status: 'waiting', statusUpdatedAt: Date.now() }), 'session waiting on a dialog'],
    ['shell', world => world.statuses.set(ID_A, { status: 'shell', statusUpdatedAt: Date.now() }), 'session running a shell command'],
    ['pending input', (world, session) => { session.composerState.pending = 3; }, 'session has unsubmitted input'],
  ]) {
    const world = makeWorld();
    const session = world.addSession(ID_A);
    const { actions, calls } = makeActions(world, {
      helpers: { normalizeCwd: v => v, getQuietMs: () => 0, deliverPrompt: async () => { mutate(world, session); return { ok: true, evidence: { wrote: true }, source: 'descriptor', stamp: Date.now() - 1000 }; } },
    });
    const result = await actions.run(stopRequest({ before: 'note' }), makeEnv(Date.now() + 5000));
    assert.equal(result.reason, reason, name);
    assert.deepEqual(calls.stop, [], name);
    assert.equal(result.wrote, true, name);
  }
});

test('a stale busy descriptor already accounted for by the transcript does not block the stop forever', async () => {
  const world = makeWorld();
  const session = world.addSession(ID_A);
  session._cliBusy = true;
  world.statuses.set(ID_A, { status: 'busy', statusUpdatedAt: 500 });
  const { actions, calls } = makeActions(world, {
    helpers: { normalizeCwd: v => v, getQuietMs: () => 0, deliverPrompt: async () => ({ ok: true, evidence: { wrote: true }, source: 'transcript', stamp: 500 }) },
  });
  const result = await actions.run(stopRequest({ before: 'note' }), makeEnv(Date.now() + 5000));
  assert.equal(result.outcome, 'closed');
  assert.deepEqual(calls.stop, [ID_A]);
});

test('a natural exit after the confirmed note counts as closed without a kill request', async () => {
  const world = makeWorld();
  const session = world.addSession(ID_A);
  const { actions, calls } = makeActions(world, {
    helpers: { normalizeCwd: v => v, getQuietMs: () => 0, deliverPrompt: async () => { session.exited = true; return { ok: true, evidence: { wrote: true }, source: 'descriptor', stamp: 1 }; } },
  });
  const result = await actions.run(stopRequest({ before: 'note' }), makeEnv(Date.now() + 5000));
  assert.equal(result.outcome, 'closed');
  assert.deepEqual(calls.stop, []);
});

test('a note whose delivery ends in session exit does not establish a finished note', async () => {
  const world = makeWorld();
  world.addSession(ID_A);
  const { actions, calls } = makeActions(world, {
    helpers: { normalizeCwd: v => v, getQuietMs: () => 0, deliverPrompt: async () => ({ ok: false, cause: 'refused', reason: 'the session exited while waiting; nothing more was written', evidence: { wrote: true } }) },
  });
  const result = await actions.run(stopRequest({ before: 'note' }), makeEnv(Date.now() + 5000));
  assert.equal(result.reason, 'note step not finished');
  assert.deepEqual(calls.stop, []);
});

test('a stop whose deadline passes while its marker is written is not executed', async () => {
  const clock = makeClock();
  const world = makeWorld();
  world.addSession(ID_A);
  const { actions, calls } = makeActions(world, { now: clock.now, sleep: clock.sleep });
  const deadline = clock.now() + 100;
  const env = makeEnv(deadline, { mark: () => { clock.t = deadline + 1; return true; } });
  const result = await actions.run(stopRequest(), env);
  assert.equal(result.outcome, 'refused');
  assert.deepEqual(calls.stop, []);
});

test('a stop is rechecked after its marker: state that changes while it is written prevents the kill', async () => {
  const world = makeWorld();
  const session = world.addSession(ID_A);
  const { actions, calls } = makeActions(world);
  const env = makeEnv(Date.now() + 5000, { mark: () => { session._cliBusy = true; return true; } });
  const result = await actions.run(stopRequest(), env);
  assert.equal(result.reason, 'session busy');
  assert.deepEqual(calls.stop, []);
});

test('a close committed after admission prevents a bare stop and a note', async () => {
  let closing = false;
  const world = makeWorld({ isClosing: () => closing });
  world.addSession(ID_A);
  const { actions, calls } = makeActions(world);
  const bare = await actions.run(stopRequest(), makeEnv(Date.now() + 5000, { mark: () => { closing = true; return true; } }));
  assert.equal(bare.reason, 'Switchboard is closing.');
  assert.deepEqual(calls.stop, []);
  closing = false;
  const noted = makeActions(world, { helpers: { normalizeCwd: v => v, getQuietMs: () => 0, deliverPrompt: async () => { closing = true; return { ok: true, evidence: {}, source: 'descriptor', stamp: 1 }; } } });
  const result = await noted.actions.run(stopRequest({ before: 'n' }), makeEnv(Date.now() + 5000));
  assert.equal(result.reason, 'Switchboard is closing.');
  assert.deepEqual(noted.calls.stop, []);
});

test('a close committed after dispatch stops the prompt before any byte is written', async t => {
  let closing = false;
  const a = arrange(t, { world: { isClosing: () => closing } });
  a.hooks.beforeAck = async () => { closing = true; };
  a.world.addSession(ID_A);
  const result = await a.submit({ version: 1, action: 'open', sessionId: ID_A, prompt: 'after closing' });
  assert.equal(result.reason, 'Switchboard is closing.');
  assert.deepEqual(flowWrites(a.events), []);
});
