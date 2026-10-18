'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');

async function pendingRestore(t) {
  const h = setup(t, { old: ['new', 'unindexed'], new: [], unindexed: [] });
  h.rows.delete('unindexed');
  loadAppFunctions(h.ctx, { functions: ['markRestoreIndexingDone', 'tickRestorePlanner'] });
  h.dom.window.loadProjects = async () => {};
  await h.restore();
  assert.ok(h.dom.window.document.querySelector('[data-notice-id="Restore:pending"]'));
  assert.deepEqual(h.spawned, []);
  return h;
}

test('manual open during indexing moves the cancelled restore retry into a persistent notice', async t => {
  const h = await pendingRestore(t);
  await h.app.openSession(h.rows.get('new'));
  assert.equal(vm.runInContext('continuationRetryCancelled', h.ctx), true);
  await h.ctx.markRestoreIndexingDone();
  const alert = h.dom.window.document.querySelector('[data-notice-id="Restore:batch"][role="alert"]');
  assert.ok(alert, 'the cancelled retry must leave a visible restore notice');
  assert.match(alert.textContent, /old/);
  assert.match(alert.textContent, /cancelled/i);
  assert.match(alert.textContent, /Open it from the sidebar to retry restoring/);
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:pending"]'), null);
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  await h.app.persistWorkingSet();
  assert.ok(h.settings().openWorkingSet.some(item => item.sessionId === 'old'));
});

test('failed final index reload moves the pending restore into a persistent notice', async t => {
  const h = await pendingRestore(t);
  h.dom.window.loadProjects = async () => { throw new Error('index unavailable'); };
  await h.ctx.markRestoreIndexingDone();
  const alert = h.dom.window.document.querySelector('[role="alert"]');
  assert.ok(alert, 'a failed reload must leave a visible restore notice');
  assert.match(alert.textContent, /old/);
  assert.match(alert.textContent, /reload/i);
  assert.match(alert.textContent, /Open it from the sidebar to retry restoring/);
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:pending"]'), null);
});

test('the pending notice remains until the indexing retry finishes opening its terminal', async t => {
  const h = await pendingRestore(t);
  fs.unlinkSync(path.join(h.root, h.folder, 'unindexed.jsonl'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const opening = new Promise(resolve => { entered = resolve; });
  const openTerminal = h.dom.window.api.openTerminal;
  h.dom.window.api.openTerminal = async (...args) => {
    entered();
    await gate;
    return openTerminal(...args);
  };
  const retry = h.ctx.markRestoreIndexingDone();
  await opening;
  try {
    assert.ok(h.dom.window.document.querySelector('[data-notice-id="Restore:pending"]'), 'pending stays visible during the retry');
  } finally { release(); await retry; }
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:pending"]'), null);
  assert.equal(h.dom.window.document.querySelector('[role="alert"]'), null);
});

test('indexing finishing during restore still reports a later cancelled continuation retry', async t => {
  const h = setup(t, { old: ['new', 'unindexed'], new: [], unindexed: [] });
  h.rows.delete('unindexed');
  loadAppFunctions(h.ctx, { functions: ['markRestoreIndexingDone', 'tickRestorePlanner'] });
  h.dom.window.loadProjects = async () => {};
  h.dom.window.api.getSessionsLiveElsewhere = async () => {
    await h.ctx.markRestoreIndexingDone();
    vm.runInContext('continuationRetryCancelled = true', h.ctx);
    return {};
  };
  await h.restore();
  const alert = h.dom.window.document.querySelector('[data-notice-id="Restore:batch"][role="alert"]');
  assert.ok(alert, 'a retry cancelled after indexing finishes must leave a persistent notice');
  assert.match(alert.textContent, /old/);
  assert.match(alert.textContent, /cancelled/);
  assert.match(alert.textContent, /Open it from the sidebar to retry restoring/);
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:pending"]'), null);
  assert.deepEqual(h.spawned, []);
  assert.ok(h.settings().openWorkingSet.some(item => item.sessionId === 'old'));
});

test('a thrown continuation retry reports only entries still held and not open', async t => {
  const h = setup(t, { old: [], second: [], third: [] });
  const saved = ['old', 'second', 'third'].map(sessionId => ({ sessionId, projectPath: h.root }));
  loadAppFunctions(h.ctx, { functions: ['markRestoreIndexingDone', 'tickRestorePlanner'] });
  h.dom.window.loadProjects = async () => {};
  h.dom.window.api.getSessionContinuations = async () => ({ candidates: [], unresolved: true, waitingForIndex: true });
  await h.app.runRestore(saved);
  h.dom.window.api.getSessionContinuations = async () => ({ candidates: [], unresolved: false });
  const openSession = h.ctx.openSession;
  h.ctx.openSession = async (session, ...args) => {
    if (session.sessionId === 'second') {
      vm.runInContext("openSessions.set('third', { session: sessionMap.get('third') })", h.ctx);
      throw new Error('retry interrupted');
    }
    return openSession(session, ...args);
  };
  await assert.rejects(h.ctx.markRestoreIndexingDone(), /retry interrupted/);
  const alert = h.dom.window.document.querySelector('[data-notice-id="Restore:batch"][role="alert"]');
  assert.ok(alert, 'the remaining held entry must be reported after a thrown retry');
  assert.match(alert.textContent, /second/);
  assert.match(alert.textContent, /retry interrupted/);
  assert.match(alert.textContent, /Open it from the sidebar to retry restoring/);
  assert.doesNotMatch(alert.textContent, /old|third/);
  assert.deepEqual(h.spawned.map(call => call.id), ['old']);
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:pending"]'), null);
});

test('waiting for indexing notice disappears when no continuation entry remains held', async t => {
  const h = await pendingRestore(t);
  vm.runInContext("skippedWorkingSetEntries.set('old', { item: { sessionId: 'old' }, index: 0 })", h.ctx);
  await h.ctx.markRestoreIndexingDone();
  assert.equal(h.dom.window.document.querySelector('[data-notice-id="Restore:pending"]'), null);
  assert.equal(h.dom.window.document.querySelector('[role="alert"]'), null);
  assert.deepEqual(h.spawned, []);
});
