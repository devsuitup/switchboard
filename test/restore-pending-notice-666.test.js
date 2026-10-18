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
