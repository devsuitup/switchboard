'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');

test('grid loading leaves the sidebar as the sole IPC lifecycle and fallback TTL owner', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  const card = ctx.document.createElement('div');
  card.innerHTML = '<div class="grid-card-dot"></div>';
  ctx.window.registerGridCard('parent-1', card);
  ctx.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1' });
  assert.equal(ctx.window.taskRegistry.agents('parent-1').length, 1);
  assert.equal(card.querySelector('.grid-card-dot').title, 'Background work running · Liveness unknown');
  const now = ctx.window.Date.now();
  ctx.window.Date.now = () => now + 61000;
  ctx.window.updateGridSubagentPills();
  assert.equal(ctx.window.taskRegistry.agents('parent-1').length, 1, 'painting a grid never expires canonical evidence');
  ctx.window.runSubagentTtlTick();
  assert.equal(ctx.window.taskRegistry.agents('parent-1').length, 0, 'shared fallback owner expires it');
  assert.equal(card.querySelector('.grid-card-dot').title, 'Idle · Liveness unknown');
  assert.equal(card.querySelector('.grid-subagent-count'), null);
});

test('loading grid-view does not shadow the sidebar fallback prune function', t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const prune = ctx.window.pruneStaleSubagents;
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  assert.equal(ctx.window.pruneStaleSubagents, prune);
});
