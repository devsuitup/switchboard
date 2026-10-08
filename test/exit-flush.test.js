'use strict';

// see docs/session-restore.md ("Closing the app")

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
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
    declarations: ['restoringWorkingSet', 'persistWorkingSetTimer', '_persistChain', 'exitingApp', 'exitingAppTimer',
      'persistSkippedWhileExiting', 'savedWorkingSetRead', 'EXIT_FLUSH_GRACE_MS', 'restorePlanner', 'restoreSavedIndex',
      'restoreAwaitingConsent', 'restoreInFlight'],
    functions: ['persistWorkingSet', 'pendingRestoreEntries', 'schedulePersistWorkingSet', 'flushStateForExit'],
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'restore-plan.js'), 'utf8'), context);
  vm.runInContext('savedWorkingSetRead = true', context);
  const open = (id) => context.openSessions.set(id, { session: { sessionId: id, projectPath: '/p' }, closed: false });
  const runTimers = () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); };
  const run = (code) => vm.runInContext(code, context);
  const saved = (ids) => {
    context.savedSet = ids.map((sessionId) => ({ sessionId, projectPath: '/p', active: false }));
    store.global.openWorkingSet = context.savedSet;
    run('restoreSavedIndex = new Map(savedSet.map((item, index) => [item.sessionId, index]))');
  };
  return { ...fns, context, store, writes, timers, open, runTimers, run, saved };
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

test('an exit before the saved set is read writes nothing', async () => {
  const t = setup();
  t.store.global.openWorkingSet = [{ sessionId: 'a' }, { sessionId: 'b' }];
  t.run('savedWorkingSetRead = false');
  await t.flushStateForExit();
  assert.equal(t.writes.length, 0);
  assert.equal(t.store.global.openWorkingSet.length, 2);
});

test('an exit during a cold index keeps the saved sessions the index has not reached', async () => {
  const t = setup();
  t.saved(['a', 'b']);
  t.run('restorePlanner = createRestorePlanner({ savedSet })');
  await t.flushStateForExit();
  assert.deepEqual(t.writes, [['a', 'b']]);
});

test('an exit before the Restore prompt is answered keeps the sessions it offers', async () => {
  const t = setup();
  t.saved(['a', 'b']);
  t.run('restoreAwaitingConsent = savedSet.slice()');
  await t.flushStateForExit();
  assert.deepEqual(t.writes, [['a', 'b']]);
});

test('an exit during a restore keeps the sessions not started yet and leaves out one stopped', async () => {
  const t = setup();
  t.saved(['a', 'b', 'c']);
  t.run('restoringWorkingSet = true; restoreInFlight.set("c", savedSet[2])');
  t.open('a');
  t.open('b');
  t.context.openSessions.get('b').closed = true;
  await t.flushStateForExit();
  assert.deepEqual(t.writes, [['a', 'c']]);
});

test('a save asked during the grace period of an exit that did not happen is written when it ends', async () => {
  const t = setup();
  t.open('a');
  await t.flushStateForExit();
  t.open('b');
  t.schedulePersistWorkingSet();
  t.runTimers();
  await t.run('_persistChain');
  assert.deepEqual(t.writes, [['a'], ['a', 'b']]);

  const quiet = setup();
  quiet.open('a');
  await quiet.flushStateForExit();
  quiet.runTimers();
  await quiet.run('_persistChain');
  assert.deepEqual(quiet.writes, [['a']], 'nothing asked, nothing written again');
});
