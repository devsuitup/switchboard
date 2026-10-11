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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/resume-guard.js'), 'utf8'), ctx);
  const settings = { global: { openWorkingSet: SAVED } };
  dom.window.api = {
    getSessionContinuations: async () => ({ candidates: [], unresolved: false, continued: false }),
    getSetting: async (key) => JSON.parse(JSON.stringify(settings[key] || null)),
    setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
  };
  vm.runInContext(PLAN_SRC, ctx);
  vm.runInContext(`
    var openSessions = new Map([['opened', { session: { projectPath: '/p' }, closed: false }]]);
    var sessionMap = new Map();
    var activeSessionId = 'opened';
    var _persistChain = Promise.resolve();
    var RESTORE_STAGGER_MS = 0;
    var restorePlanner = createRestorePlanner({ savedSet: ${JSON.stringify(SAVED)} });
    var liveCheckRelease = [];
    function liveElsewhereMany() { return new Promise(resolve => liveCheckRelease.push(() => resolve({}))); }
    async function openSession(s) {
      openSessions.set(s.sessionId, { session: { projectPath: s.projectPath }, closed: false });
      return true;
    }
    function showLiveElsewhereNotice() {}
    function showSession() {}
  `, ctx);
  const fns = loadAppFunctions(ctx, {
    functions: ['persistWorkingSet', 'pendingRestoreEntries', 'runRestore'],
    declarations: ['skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'restoreIndexingDone', 'exitingApp', 'persistSkippedWhileExiting'],
  });
  vm.runInContext(`restoreSavedIndex = new Map(${JSON.stringify(SAVED.map((item, i) => [item.sessionId, i]))});`, ctx);
  const stored = () => settings.global.openWorkingSet.map(i => i.sessionId);
  const releaseLiveChecks = () => vm.runInContext('liveCheckRelease.splice(0).forEach(release => release());', ctx);
  return { dom, ctx, stored, releaseLiveChecks, ...fns };
}

function dispatchToRestore(h) {
  vm.runInContext(`sessionMap.set('opened', {}); sessionMap.set('sdk-unindexed', { sessionId: 'sdk-unindexed', projectPath: '/p' });`, h.ctx);
  const plan = vm.runInContext('restorePlanner.tick({ sessionMap, openSessions, indexingDone: false })', h.ctx);
  assert.equal(plan.action, 'restore');
  return plan.candidates;
}

test('a persist during a cold restore keeps the saved entries not indexed yet', async () => {
  const h = setup();
  vm.runInContext(`restorePlanner.tick({ sessionMap: new Map([['opened', {}]]), openSessions, indexingDone: false });`, h.ctx);
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened', 'sdk-unindexed']);
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened', 'sdk-unindexed'], 'a second persist keeps it too');
  h.dom.window.close();
});

test('entries offered by the restore toast survive a persist until answered', async () => {
  const h = setup();
  vm.runInContext(`restorePlanner.dismiss(); restoreAwaitingConsent = [${JSON.stringify(SAVED[1])}];`, h.ctx);
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened', 'sdk-unindexed']);
  vm.runInContext('restoreAwaitingConsent = [];', h.ctx);
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened'], 'once dismissed, the entry is dropped as before');
  h.dom.window.close();
});

test('a persist while the restore checks the candidates keeps them, and they are opened after', async () => {
  const h = setup();
  const restoring = h.runRestore(dispatchToRestore(h));
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened', 'sdk-unindexed'], 'dispatched to runRestore, not yet opened or skipped');
  h.releaseLiveChecks();
  await restoring;
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened', 'sdk-unindexed']);
  assert.ok(vm.runInContext(`openSessions.has('sdk-unindexed') && restoreInFlight.size === 0`, h.ctx));
  h.dom.window.close();
});

test('a candidate opened by hand during the check, then closed, is not kept in the working set', async () => {
  const h = setup();
  const restoring = h.runRestore(dispatchToRestore(h));
  vm.runInContext(`openSessions.set('sdk-unindexed', { session: { projectPath: '/p' }, closed: false });`, h.ctx);
  h.releaseLiveChecks();
  await restoring;
  vm.runInContext(`openSessions.delete('sdk-unindexed');`, h.ctx);
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened']);
  assert.equal(vm.runInContext('restoreInFlight.size', h.ctx), 0);
  h.dom.window.close();
});

test('a restore that fails part-way leaves nothing in flight', async () => {
  const h = setup();
  vm.runInContext(`openSession = async () => { throw new Error('pty spawn failed'); };`, h.ctx);
  const restoring = h.runRestore(dispatchToRestore(h));
  h.releaseLiveChecks();
  await assert.rejects(restoring, /pty spawn failed/);
  assert.equal(vm.runInContext('restoreInFlight.size', h.ctx), 0);
  h.dom.window.close();
});

test('two overlapping restores keep the candidate stored until one of them opens it', async () => {
  const h = setup();
  const candidates = dispatchToRestore(h);
  const first = h.runRestore(candidates);
  const second = h.runRestore(candidates);
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened', 'sdk-unindexed']);
  h.releaseLiveChecks();
  await Promise.all([first, second]);
  await h.persistWorkingSet();
  assert.deepEqual(h.stored(), ['opened', 'sdk-unindexed']);
  h.dom.window.close();
});
