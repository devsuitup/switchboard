'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runExitHandoffs, EXIT_BUSY_WAIT_MS } = require('../session-exit');
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(ids = ['a']) {
  assert.equal(typeof runExitHandoffs, 'function', 'the exit batch must be available');
  let time = 0;
  const states = new Map(ids.map(id => [id, 'busy']));
  const sends = [], waits = [], progress = [], releases = new Map();
  const controller = new AbortController();
  const deps = {
    status: id => states.get(id), now: () => time, signal: controller.signal,
    progress: event => progress.push(event),
    waitForChange: ms => new Promise(resolve => waits.push({ ms, resolve })),
    send: id => { sends.push(id); return new Promise(resolve => releases.set(id, resolve)); },
  };
  const wake = async (ms = 0) => {
    time += ms;
    for (const wait of waits.splice(0)) wait.resolve();
    await tick();
  };
  return { deps, states, sends, waits, progress, controller, releases, wake };
}

test('C3 parallel rows start before either handoff resolves', async () => {
  const h = setup(['a', 'b']);
  h.states.set('a', 'idle'); h.states.set('b', 'idle');
  const pending = runExitHandoffs(['a', 'b'], h.deps);
  assert.deepEqual(h.sends, ['a', 'b']);
  h.releases.get('b')({ ok: true, sessionId: 'new-b' });
  h.releases.get('a')({ ok: true, sessionId: 'new-a' });
  assert.deepEqual(await pending, [{ id: 'a', ok: true, sessionId: 'new-a' }, { id: 'b', ok: true, sessionId: 'new-b' }]);
});

test('C3 busy rows send once only after becoming idle', async () => {
  const h = setup();
  const pending = runExitHandoffs(['a'], h.deps);
  assert.deepEqual(h.sends, []);
  assert.deepEqual(h.progress, [{ id: 'a', phase: 'waiting' }]);
  assert.ok(h.waits.every(w => w.ms <= 1000));
  h.states.set('a', 'idle'); await h.wake();
  assert.deepEqual(h.sends, ['a']);
  h.releases.get('a')({ ok: true });
  assert.equal((await pending)[0].ok, true);
  assert.ok(h.progress.some(e => e.phase === 'moving'));
});

for (const [status, code] of [['waiting', 'needs-answer'], ['shell', 'shell'], [undefined, 'refused']]) {
  test(`C3 busy to ${status} fails immediately before a write`, async () => {
    const h = setup();
    const pending = runExitHandoffs(['a'], h.deps);
    h.states.set('a', status); await h.wake();
    let result;
    pending.then(value => { result = value; }); await tick();
    assert.equal(result?.[0].code, code, 'failure must not wait for the busy bound');
    assert.deepEqual(h.sends, []);
  });
}

test('C3 the default busy bound is ten minutes and expiry never writes', async () => {
  const h = setup();
  assert.equal(EXIT_BUSY_WAIT_MS, 600000);
  const pending = runExitHandoffs(['a'], h.deps);
  await h.wake(599999);
  assert.deepEqual(h.sends, []);
  assert.equal(h.waits[0].ms, 1);
  await h.wake(1);
  let result; pending.then(value => { result = value; }); await tick();
  assert.equal(result?.[0].code, 'busy-timeout');
  assert.deepEqual(h.sends, []);
});

test('C3 an injectable busy bound expires before an idle write', async () => {
  const h = setup();
  const pending = runExitHandoffs(['a'], { ...h.deps, busyBoundMs: 5 });
  h.states.set('a', 'idle'); await h.wake(5);
  let result; pending.then(value => { result = value; }); await tick();
  assert.equal(result?.[0].code, 'busy-timeout');
  assert.deepEqual(h.sends, []);
});

test('C3 user cancellation wakes busy waits immediately without a write', async () => {
  const h = setup();
  const pending = runExitHandoffs(['a'], h.deps);
  h.controller.abort();
  let result; pending.then(value => { result = value; }); await tick();
  assert.equal(result?.[0].code, 'cancelled');
  assert.deepEqual(h.sends, []);
});

test('C3 a signal already aborted prevents even an idle write', async () => {
  const h = setup(); h.states.set('a', 'idle'); h.controller.abort();
  const pending = runExitHandoffs(['a'], h.deps);
  assert.deepEqual(h.sends, []);
  const result = await pending;
  assert.equal(result[0].code, 'cancelled');
  assert.deepEqual(h.sends, []);
});

test('C3 user cancellation after a write still collects its confirmation', async () => {
  const h = setup(); h.states.set('a', 'idle');
  const pending = runExitHandoffs(['a'], h.deps);
  h.controller.abort(); await tick();
  h.releases.get('a')({ ok: true, sessionId: 'new' });
  assert.deepEqual(await pending, [{ id: 'a', ok: true, sessionId: 'new' }]);
});

test('C3 external abort returns confirmed, pending and unwritten rows immediately', async () => {
  const h = setup(['a', 'b', 'c']); h.states.set('a', 'idle'); h.states.set('b', 'idle');
  const pending = runExitHandoffs(['a', 'b', 'c'], h.deps);
  h.releases.get('a')({ ok: true, sessionId: 'new-a' }); await tick();
  h.controller.abort({ external: true });
  let result; pending.then(value => { result = value; }); await tick();
  assert.deepEqual(result, [
    { id: 'a', ok: true, sessionId: 'new-a' }, { id: 'b', ok: false, code: 'pending' }, { id: 'c', ok: false, code: 'cancelled' },
  ]);
  const progress = [...h.progress];
  h.releases.get('b')({ ok: true }); await tick();
  assert.deepEqual(h.progress, progress, 'late progress is suppressed after external exit');
  assert.equal(result[1].code, 'pending', 'late results cannot rewrite the resolved snapshot');
});

test('C3 B2 a pre-write failure cancels the other busy row before its bound', async () => {
  const h = setup(['a', 'b']);
  const pending = runExitHandoffs(['a', 'b'], h.deps);
  h.states.set('a', 'waiting'); await h.wake();
  let result; pending.then(value => { result = value; }); await tick();
  assert.deepEqual(result?.map(row => row.code), ['needs-answer', 'cancelled']);
  assert.deepEqual(h.sends, []);
});

test('C3 B2 written rows finish after another row fails before writing', async () => {
  const h = setup(['a', 'b']); h.states.set('a', 'idle');
  const pending = runExitHandoffs(['a', 'b'], h.deps);
  h.states.set('b', 'shell'); await h.wake();
  let finished = false; pending.then(() => { finished = true; }); await tick();
  assert.equal(finished, false);
  h.releases.get('a')({ ok: true });
  assert.deepEqual(await pending, [{ id: 'a', ok: true }, { id: 'b', ok: false, code: 'shell' }]);
});

test('C3 failures after a write leave other busy rows eligible', async () => {
  const h = setup(['a', 'b']); h.states.set('a', 'idle');
  const pending = runExitHandoffs(['a', 'b'], h.deps);
  h.releases.get('a')({ ok: false, code: 'write-failed' }); await tick();
  h.states.set('b', 'idle'); await h.wake();
  assert.deepEqual(h.sends, ['a', 'b']);
  h.releases.get('b')({ ok: true });
  assert.deepEqual((await pending).map(row => row.ok), [false, true]);
});

test('C3 B2 a refused send cancels unwritten rows because the primitive wrote nothing', async () => {
  const h = setup(['a', 'b']); h.states.set('a', 'idle');
  const pending = runExitHandoffs(['a', 'b'], h.deps);
  h.releases.get('a')({ ok: false, code: 'refused', error: 'Unsent text' });
  let result; pending.then(value => { result = value; }); await tick();
  assert.deepEqual(result?.map(row => row.code), ['refused', 'cancelled']);
  assert.deepEqual(h.sends, ['a']);
});


test('S2-T10 GUARD respawn-failed counts as started and leaves an unwritten row eligible', async () => {
  const h = setup(['a', 'b']); h.states.set('a', 'idle');
  const pending = runExitHandoffs(['a', 'b'], h.deps);
  h.releases.get('a')({ ok: false, code: 'respawn-failed' }); await tick();
  h.states.set('b', 'idle'); await h.wake();
  assert.deepEqual(h.sends, ['a', 'b']);
  h.releases.get('b')({ ok: true });
  assert.deepEqual((await pending).map(row => row.code || row.ok), ['respawn-failed', true]);
});
