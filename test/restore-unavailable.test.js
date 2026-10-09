// A saved session whose transcript never reaches the index (issue #376): the
// restore gives up once indexing is over, clears the "Finishing indexing"
// toast and names the session. See .ai/contexts/session-cache.md
// ("Working-set restore").

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createRestorePlanner } = require('../public/restore-plan');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');
const APP_SRC = read('app.js');

function functionSource(src, name) {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} not found`);
  const body = src.indexOf(') {', start) + 2;
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const SAVED = [
  { sessionId: 'ok', projectPath: '/p', active: false },
  { sessionId: 'ghost', projectPath: '/p', active: true },
];
const sm = (ids) => new Map(ids.map((id) => [id, { sessionId: id }]));
const tick = (planner, ids, indexingDone) => planner.tick({
  sessionMap: sm(ids), openSessions: new Map(), indexingDone, sessionOpenedOutsideRestore: false,
});

test('planner, auto: indexing done with a saved id never indexed -> it is reported as unavailable', () => {
  const planner = createRestorePlanner({ savedSet: SAVED });
  let plan = tick(planner, ['ok'], false);
  assert.equal(plan.action, 'restore');
  assert.deepEqual(plan.candidates.map((i) => i.sessionId), ['ok']);
  plan = tick(planner, ['ok'], true);
  assert.equal(plan.action, 'nothing');
  assert.deepEqual(plan.unavailable.map((i) => i.sessionId), ['ghost']);
  assert.deepEqual(tick(planner, ['ok'], true).unavailable, [], 'reported once');
});

test('planner, ask: indexing done -> restores what indexed and reports the rest', () => {
  const planner = createRestorePlanner({ savedSet: SAVED, askOnce: true });
  assert.equal(tick(planner, ['ok'], false).action, 'wait');
  const plan = tick(planner, ['ok'], true);
  assert.equal(plan.action, 'restore');
  assert.deepEqual(plan.candidates.map((i) => i.sessionId), ['ok']);
  assert.deepEqual(plan.unavailable.map((i) => i.sessionId), ['ghost']);
});

test('planner, ask: indexing done and nothing indexed -> nothing, all reported', () => {
  const planner = createRestorePlanner({ savedSet: SAVED, askOnce: true });
  const plan = tick(planner, [], true);
  assert.equal(plan.action, 'nothing');
  assert.deepEqual(plan.unavailable.map((i) => i.sessionId), ['ok', 'ghost']);
});

test('planner: a wait or a complete restore reports nothing unavailable', () => {
  const planner = createRestorePlanner({ savedSet: SAVED });
  assert.deepEqual(tick(planner, [], false).unavailable, []);
  assert.deepEqual(tick(planner, ['ok', 'ghost'], false).unavailable, []);
});

function setupTick({ mode, indexed, late = [], preplanned = true, finished = false }) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  dom.window.api = {
    getSetting: async () => ({ restoreOnStartup: mode, openWorkingSet: SAVED }),
    getIndexingState: async () => ({ finished }),
  };
  vm.runInContext(read('utils.js'), ctx);
  vm.runInContext(read('restore-plan.js'), ctx);
  vm.runInContext(`
    var openSessions = new Map();
    var sessionMap = new Map(${JSON.stringify(indexed.map((id) => [id, { sessionId: id, name: 'name-' + id }]))});
    var restorePlanner = ${preplanned ? `createRestorePlanner({ savedSet: ${JSON.stringify(SAVED)}, askOnce: ${mode === 'ask'} })` : 'null'};
    var restoreSavedIndex = new Map();
    var skippedWorkingSetEntries = new Map();
    var SETTING_DEFAULTS = { restoreOnStartup: 'off' };
    var loadProjects = async () => { for (const id of ${JSON.stringify(late)}) sessionMap.set(id, { sessionId: id, name: 'name-' + id }); };
    var restoreMode = ${JSON.stringify(mode)};
    var restoreIndexingDone = false;
    var sessionOpenedOutsideRestore = false;
    var restoringWorkingSet = false;
    var LIVE_ELSEWHERE_NOTICE_MS = 60000;
    var restored = [];
    async function runRestore(list) { restored.push(...list.map((i) => i.sessionId)); }
    function persistWorkingSet() {}
  `, ctx);
  for (const name of ['tickRestorePlanner', 'showColdCacheNotice', 'showRestoreNotice', 'showNotRestoredNotice', 'markRestoreIndexingDone', 'restoreWorkingSet']) {
    if (APP_SRC.includes(`function ${name}(`)) vm.runInContext(functionSource(APP_SRC, name), ctx);
  }
  return { dom, ctx, doc: dom.window.document };
}

test('ask mode: a saved session never indexed -> after indexing the toast is gone and the session is named', async () => {
  const h = setupTick({ mode: 'ask', indexed: ['ok'] });
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.ok(h.doc.getElementById('restore-cold-toast'), 'waiting toast while indexing');

  vm.runInContext('restoreIndexingDone = true;', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);

  assert.equal(h.doc.getElementById('restore-cold-toast'), null, 'the waiting toast is cleared');
  assert.ok(h.doc.getElementById('restore-toast'), 'the normal session is still offered');
  const notice = h.doc.getElementById('restore-unavailable-toast');
  assert.ok(notice, 'the missing session is reported');
  assert.match(notice.textContent, /name-ghost|ghost/);
  h.dom.window.close();
});

test('auto mode: a saved session never indexed -> the normal one restores, the other is reported', async () => {
  const h = setupTick({ mode: 'auto', indexed: ['ok'] });
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.deepEqual([...vm.runInContext('restored', h.ctx)], ['ok']);

  vm.runInContext('restoreIndexingDone = true;', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.match(h.doc.getElementById('restore-unavailable-toast').textContent, /ghost/);
  h.dom.window.close();
});

test('a saved session that is indexed after all is restored, not reported', async () => {
  const h = setupTick({ mode: 'auto', indexed: ['ok', 'ghost'] });
  vm.runInContext('restoreIndexingDone = true;', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.deepEqual([...vm.runInContext('restored', h.ctx)].sort(), ['ghost', 'ok']);
  assert.equal(h.doc.getElementById('restore-unavailable-toast'), null);
  h.dom.window.close();
});

test('indexing ends with a session only in the last batch: it is reloaded and restored, not reported', async () => {
  const h = setupTick({ mode: 'auto', indexed: ['ok'], late: ['ghost'] });
  await vm.runInContext('markRestoreIndexingDone()', h.ctx);
  assert.deepEqual([...vm.runInContext('restored', h.ctx)].sort(), ['ghost', 'ok']);
  assert.equal(h.doc.getElementById('restore-unavailable-toast'), null);
  h.dom.window.close();
});

test('indexing-finished with no planner, or a settled one, does not reload the projects', async () => {
  const h = setupTick({ mode: 'auto', indexed: ['ok', 'ghost'], preplanned: false });
  vm.runInContext('var loads = 0; loadProjects = async () => { loads++; };', h.ctx);
  await vm.runInContext('markRestoreIndexingDone()', h.ctx);
  assert.equal(vm.runInContext('loads', h.ctx), 0, 'no planner');
  assert.equal(vm.runInContext('restoreIndexingDone', h.ctx), true);

  vm.runInContext(`restorePlanner = createRestorePlanner({ savedSet: [] });`, h.ctx);
  await vm.runInContext('markRestoreIndexingDone()', h.ctx);
  assert.equal(vm.runInContext('loads', h.ctx), 0, 'settled planner');
  h.dom.window.close();
});

test('a reload that keeps failing leaves the sessions unreported and the planner waiting', async () => {
  const h = setupTick({ mode: 'ask', indexed: ['ok'] });
  vm.runInContext('var loads = 0; loadProjects = async () => { loads++; throw new Error("ipc"); };', h.ctx);
  await vm.runInContext('markRestoreIndexingDone()', h.ctx);
  assert.equal(vm.runInContext('loads', h.ctx), 2, 'retried once');
  assert.equal(h.doc.getElementById('restore-unavailable-toast'), null);
  assert.equal(vm.runInContext('restorePlanner.isSettled()', h.ctx), false);

  vm.runInContext('loadProjects = async () => {};', h.ctx);
  await vm.runInContext('markRestoreIndexingDone()', h.ctx);
  assert.ok(h.doc.getElementById('restore-unavailable-toast'), 'the next event settles it');
  h.dom.window.close();
});

test('indexing already finished when the planner starts (event missed): restore settles without any event', async () => {
  const h = setupTick({ mode: 'ask', indexed: ['ok'], preplanned: false, finished: true });
  await vm.runInContext('restoreWorkingSet()', h.ctx);
  assert.equal(h.doc.getElementById('restore-cold-toast'), null);
  assert.ok(h.doc.getElementById('restore-toast'));
  assert.match(h.doc.getElementById('restore-unavailable-toast').textContent, /ghost/);
  h.dom.window.close();
});

test('indexing still running when the planner starts: the waiting toast stays', async () => {
  const h = setupTick({ mode: 'ask', indexed: ['ok'], preplanned: false, finished: false });
  await vm.runInContext('restoreWorkingSet()', h.ctx);
  assert.ok(h.doc.getElementById('restore-cold-toast'));
  h.dom.window.close();
});

test('notice says the session is not in the index', async () => {
  const h = setupTick({ mode: 'auto', indexed: ['ok'] });
  vm.runInContext('restoreIndexingDone = true;', h.ctx);
  await vm.runInContext('tickRestorePlanner()', h.ctx);
  assert.match(h.doc.getElementById('restore-unavailable-toast').textContent, /not in the index/);
  h.dom.window.close();
});

test('wiring: the renderer listens for the end of every indexing run, not only the first-run one', () => {
  assert.match(APP_SRC, /window\.api\.onIndexingFinished\(/);
  const body = functionSource(APP_SRC, 'markRestoreIndexingDone');
  assert.match(body, /restoreIndexingDone\s*=\s*true/);
  assert.match(body, /loadProjects\(\)/);
  assert.match(body, /tickRestorePlanner\(\)/);
  assert.match(APP_SRC, /getIndexingState\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), /ipcMain\.handle\('get-indexing-state'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), /'indexing-finished'/);
});
