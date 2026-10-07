// see .ai/contexts/session-cache.md ("Working-set restore: retry until indexing is done")

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');

const PLAN_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'restore-plan.js'), 'utf8');

const SAVED = [
  { sessionId: 'opened', projectPath: '/p', active: true },
  { sessionId: 'sdk-unindexed', projectPath: '/p', active: false },
];

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  const settings = { global: { openWorkingSet: SAVED } };
  dom.window.api = {
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
  };
  vm.runInContext(PLAN_SRC, ctx);
  vm.runInContext(`
    var openSessions = new Map([['opened', { session: { projectPath: '/p' }, closed: false }]]);
    var activeSessionId = 'opened';
    var _persistChain = Promise.resolve();
    var restorePlanner = createRestorePlanner({ savedSet: ${JSON.stringify(SAVED)} });
  `, ctx);
  const fns = loadAppFunctions(ctx, {
    functions: ['persistWorkingSet', 'pendingRestoreEntries'],
    declarations: ['skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent'],
  });
  vm.runInContext(`restoreSavedIndex = new Map(${JSON.stringify(SAVED.map((item, i) => [item.sessionId, i]))});`, ctx);
  return { dom, ctx, settings, ...fns };
}

test('a persist during a cold restore keeps the saved entries not indexed yet', async () => {
  const h = setup();
  vm.runInContext(`restorePlanner.tick({ sessionMap: new Map([['opened', {}]]), openSessions, indexingDone: false });`, h.ctx);
  await h.persistWorkingSet();
  assert.deepEqual(h.settings.global.openWorkingSet.map(i => i.sessionId), ['opened', 'sdk-unindexed']);
  await h.persistWorkingSet();
  assert.deepEqual(h.settings.global.openWorkingSet.map(i => i.sessionId), ['opened', 'sdk-unindexed'],
    'a second persist keeps it too');
  h.dom.window.close();
});

test('entries offered by the restore toast survive a persist until answered', async () => {
  const h = setup();
  vm.runInContext(`restorePlanner.dismiss(); restoreAwaitingConsent = [${JSON.stringify(SAVED[1])}];`, h.ctx);
  await h.persistWorkingSet();
  assert.deepEqual(h.settings.global.openWorkingSet.map(i => i.sessionId), ['opened', 'sdk-unindexed']);
  vm.runInContext('restoreAwaitingConsent = [];', h.ctx);
  await h.persistWorkingSet();
  assert.deepEqual(h.settings.global.openWorkingSet.map(i => i.sessionId), ['opened'],
    'once dismissed, the entry is dropped as before');
  h.dom.window.close();
});
