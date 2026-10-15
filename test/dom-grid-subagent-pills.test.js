'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [{ sessionId: 'parent-1', modified: new Date().toISOString() }] })], true);
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  const card = ctx.document.createElement('div');
  ctx.read('gridCards').set('parent-1', card);
  const spawn = payload => ctx.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', ...payload });
  const agents = () => ctx.window.taskRegistry.agents('parent-1');
  return { ctx, card, spawn, agents };
}

test('subagent-spawned: canonical IPC owner reads the payload alone without presenting an inferred count', t => {
  const { card, spawn, agents } = setup(t);
  spawn();
  assert.equal(agents().length, 1);
  assert.equal(card.querySelector('.grid-subagent-pills, .grid-subagent-pill, .grid-subagent-count'), null);
});

test('subagent-completed: canonical IPC owner clears fallback activity in the grid', t => {
  const { ctx, card, spawn, agents } = setup(t);
  spawn();
  assert.equal(agents().length, 1);
  ctx.emitSubagentCompleted({ parentSessionId: 'parent-1', agentId: 'agent-1' });
  assert.equal(agents().length, 0);
  assert.equal(card.querySelector('.grid-subagent-pills, .grid-subagent-count'), null);
});

test('a heartbeat for an untracked agent does not create grid activity', t => {
  const { card, spawn, agents } = setup(t);
  spawn({ _heartbeat: true });
  assert.equal(agents().length, 0);
  assert.equal(card.querySelector('.grid-subagent-pills, .grid-subagent-count'), null);
});

test('a tracked heartbeat refreshes the shared fallback liveness stamp', t => {
  const { ctx, spawn } = setup(t);
  spawn();
  const stamps = () => [...ctx.window.taskRegistry.agentView.get('parent-1').get('agent-1').values()];
  const first = Math.max(...stamps());
  ctx.window.Date.now = () => first + 40000;
  spawn({ _heartbeat: true });
  assert.ok(Math.max(...stamps()) > first);
});
