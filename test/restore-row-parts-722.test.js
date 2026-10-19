'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cache = require('../session-cache');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');

function rolledRow(t, graph, savedId, { bridge = false } = {}) {
  const h = setup(t, graph, { savedEntries: [{ sessionId: savedId, projectPath: 'saved-project', active: true }] });
  h.saved[0].projectPath = h.root;
  for (const row of h.rows.values()) {
    row.modified = `2026-10-19T12:00:0${{ root: 0, mirror: 0, middle: 1, head: 2 }[row.sessionId] || 0}Z`;
  }
  if (bridge) {
    h.rows.get('root').bridgeSessionId = 'bridge';
    Object.assign(h.rows.get('mirror'), { bridgeSessionId: 'bridge', mergedIntoSessionId: 'root' });
  }
  cache.init({ PROJECTS_DIR: h.root, db: { ...h.db, getAllCached: () => [...h.rows.values()] },
    activeSessions: new Map(), getMainWindow: () => null, log: console });
  const projects = cache.buildProjectsFromCache(false);
  h.ctx.sessionMap.clear();
  for (const project of projects) {
    for (const row of project.sessions) h.ctx.sessionMap.set(row.sessionId, row);
  }
  loadAppFunctions(h.ctx, { functions: ['rowHeadSession'], sourcePath: path.join(__dirname, '../public/sidebar.js') });
  return { ...h, projects };
}

for (const savedId of ['root', 'middle', 'head']) {
  test(`#722 restore of a rolled linear row keeps saved ${savedId} without a continuation choice`, async t => {
    const h = rolledRow(t, { root: ['middle'], middle: ['head'], head: [] }, savedId);
    const [row] = h.projects[0].sessions;
    assert.equal(h.projects[0].sessions.length, 1);
    assert.equal(row.sessionId, 'root');
    assert.equal(row.headSessionId, 'head');
    assert.deepEqual(row.mergedMemberIds, ['head', 'middle']);
    await h.restore();
    assert.equal(h.dom.window.document.querySelector('#app-notices [role="alert"]'), null);
    assert.deepEqual(h.spawned.map(call => call.id), [savedId]);
    assert.deepEqual(h.prompts, []);
    assert.deepEqual(h.settings().openWorkingSet, [{ sessionId: savedId, projectPath: h.root, active: true }]);
    const restored = h.ctx.openSessions.get(savedId).session;
    assert.equal(restored.headSessionId, 'head');
  });
}

test('#722 restore ignores an edge into the same bridge group on a rolled row', async t => {
  const h = rolledRow(t, { root: ['mirror', 'middle'], mirror: [], middle: ['head'], head: [] }, 'root', { bridge: true });
  assert.equal(h.projects[0].sessions.length, 1);
  assert.deepEqual(new Set(h.projects[0].sessions[0].mergedMemberIds), new Set(['mirror', 'middle', 'head']));
  await h.restore();
  assert.equal(h.dom.window.document.querySelector('#app-notices [role="alert"]'), null);
  assert.deepEqual(h.spawned.map(call => call.id), ['root']);
  assert.deepEqual(h.prompts, []);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'root');
});

test('#722 restore keeps a real branch held for a continuation choice', async t => {
  const h = rolledRow(t, { root: ['mirror', 'left', 'right'], mirror: [], left: [], right: [] }, 'root', { bridge: true });
  assert.equal(h.projects[0].sessions.length, 3);
  assert.deepEqual(h.projects[0].sessions.find(row => row.sessionId === 'root').mergedMemberIds, ['mirror']);
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
  assert.match(h.dom.window.document.querySelector('#app-notices [role="alert"]')?.textContent, /continuation choice is needed/i);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'root');
});

test('#722 restore of a row without parts still follows its sole continuation', async t => {
  const h = setup(t, { old: ['new'], new: [] });
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['new']);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.settings().openWorkingSet, [{ sessionId: 'new', projectPath: h.root, active: true }]);
});

test('#722 restore holds an unindexed target and retries with the completed rolled row', async t => {
  const h = rolledRow(t, { root: ['middle'], middle: ['head'], head: [] }, 'root');
  const head = h.rows.get('head');
  h.rows.delete('head');
  await h.restore();
  assert.deepEqual(h.spawned, []);
  assert.deepEqual(h.prompts, []);
  assert.match(h.dom.window.document.querySelector('#app-notices').textContent, /indexing/i);
  assert.equal(h.settings().openWorkingSet[0].sessionId, 'root');
  h.rows.set('head', head);
  await h.restore();
  assert.deepEqual(h.spawned.map(call => call.id), ['root']);
  assert.deepEqual(h.prompts, []);
});
