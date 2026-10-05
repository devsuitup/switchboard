'use strict';

// see docs/session-restore.md ("Closing the app")

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadAppFunctions } = require('./app-source');

function setup() {
  const store = { global: { windowBounds: { x: 1 } } };
  const writes = [];
  const timers = new Map();
  let nextTimer = 1;
  const context = vm.createContext({
    console,
    Promise,
    openSessions: new Map(),
    activeSessionId: null,
    skippedWorkingSetEntries: new Map(),
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    window: {
      api: {
        getSetting: async (key) => JSON.parse(JSON.stringify(store[key] || null)),
        setSetting: async (key, value) => { store[key] = JSON.parse(JSON.stringify(value)); writes.push(JSON.parse(JSON.stringify(value.openWorkingSet.map((e) => e.sessionId)))); },
      },
    },
  });
  const fns = loadAppFunctions(context, {
    declarations: ['restoringWorkingSet', 'persistWorkingSetTimer', '_persistChain', 'exitingApp', 'exitingAppTimer', 'EXIT_FLUSH_GRACE_MS'],
    functions: ['persistWorkingSet', 'schedulePersistWorkingSet', 'flushStateForExit'],
  });
  const open = (id) => context.openSessions.set(id, { session: { sessionId: id, projectPath: '/p' }, closed: false });
  const runTimers = () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); };
  return { ...fns, context, store, writes, timers, open, runTimers };
}

test('a confirmed exit writes the open set at once instead of leaving it on the debounce', async () => {
  const t = setup();
  t.open('a');
  t.open('b');
  t.schedulePersistWorkingSet();
  assert.equal(t.writes.length, 0, 'still debounced');

  await t.flushStateForExit();
  assert.deepEqual(t.writes, [['a', 'b']]);
  assert.deepEqual(t.store.global.windowBounds, { x: 1 }, 'other global keys are kept');
});

test('sessions killed by the shutdown cannot overwrite the saved set with an empty one', async () => {
  const t = setup();
  t.open('a');
  await t.flushStateForExit();

  t.context.openSessions.get('a').closed = true;
  t.schedulePersistWorkingSet();
  await t.persistWorkingSet();
  assert.deepEqual(t.writes, [['a']]);
  assert.deepEqual(t.store.global.openWorkingSet.map((e) => e.sessionId), ['a']);
});

test('an exit that does not happen gives persistence back after the grace period', async () => {
  const t = setup();
  t.open('a');
  await t.flushStateForExit();
  t.runTimers();

  t.open('b');
  await t.persistWorkingSet();
  assert.deepEqual(t.writes, [['a'], ['a', 'b']]);
});

test('an exit during a restore keeps the set saved by the previous run', async () => {
  const t = setup();
  t.store.global.openWorkingSet = [{ sessionId: 'a' }, { sessionId: 'b' }];
  vm.runInContext('restoringWorkingSet = true', t.context);
  t.open('a');
  await t.flushStateForExit();
  assert.equal(t.writes.length, 0);
  assert.equal(t.store.global.openWorkingSet.length, 2);
});
