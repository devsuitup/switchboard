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
