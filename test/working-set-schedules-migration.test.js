'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { loadAppFunctions } = require('./app-source');
const { createWriterCommands } = require('../session-index-commands');
const migration = require('../src/main/schedules/schedules-tab-migration');

const workerFile = path.join(__dirname, '../workers/session-index-writer.js');

function writerStore(global) {
  let stored = structuredClone(global);
  const db = { getSetting: () => structuredClone(stored), setSetting: (_key, value) => { stored = structuredClone(value); } };
  const source = fs.readFileSync(workerFile, 'utf8');
  const node = espree.parse(source, { ecmaVersion: 'latest', range: true }).body
    .find(entry => entry.type === 'FunctionDeclaration' && entry.id.name === 'targetUnits');
  const worker = vm.createContext({ db, commands: createWriterCommands(db), rawCommands: new Set(['setSetting']),
    assertHarnessSettings: require('../harnesses').assertHarnessSettings });
  vm.runInContext(source.slice(...node.range), worker, { filename: workerFile });
  const run = (name, args) => {
    worker.unitArgs = [name, args];
    return vm.runInContext('targetUnits(...unitArgs).next().value()', worker, { filename: workerFile });
  };
  return { db, run, get stored() { return stored; } };
}

function renderer(store, onFirstCall) {
  let called = false;
  const first = () => { if (!called) { called = true; onFirstCall(); } };
  const w = {
    exitingApp: false, openSessions: new Map(), pendingSessions: new Map(), skippedWorkingSetEntries: new Map(),
    dormantWorkingSet: new Map(), activeSessionId: null, pendingRestoreEntries: () => [], queueMicrotask, console,
    api: {
      getSetting: async () => { const snapshot = store.db.getSetting('global'); first(); return snapshot; },
      setSetting: async (key, value) => { first(); store.run('setSetting', [key, value]); },
      mergeGlobalSettings: async (patch, remove) => { first(); store.run('mergeGlobal', [patch, remove]); },
    },
  };
  w.window = w;
  const context = vm.createContext(w);
  loadAppFunctions(context, { functions: ['persistWorkingSet'], declarations: ['_persistChain'] });
  return context;
}

test('a working-set flush racing the migration keeps the migrated default and its marker (#1239)', async () => {
  const store = writerStore({ schedulesTab: false, theme: 'dark' });
  const context = renderer(store, () => assert.equal(migration.migrateSchedulesTabDefault(store.db), 'turned-on'));
  await vm.runInContext('persistWorkingSet({ checked: true })', context);
  assert.deepEqual(store.stored.openWorkingSet, [], 'the working set is written');
  assert.equal(store.stored.theme, 'dark');
  assert.equal(store.stored.schedulesTabDefaultMigrated, true);
  assert.equal(store.stored.schedulesTab ?? true, true, 'the flush does not bring back the inherited off');
  assert.equal(migration.migrateSchedulesTabDefault(store.db), 'none');
});

test('a working-set flush after an explicit off leaves that off alone (#1239)', async () => {
  const store = writerStore({ schedulesTab: false, schedulesTabDefaultMigrated: true });
  const context = renderer(store, () => {});
  await vm.runInContext('persistWorkingSet({ checked: true })', context);
  assert.deepEqual(store.stored, { schedulesTab: false, schedulesTabDefaultMigrated: true, openWorkingSet: [] });
});
