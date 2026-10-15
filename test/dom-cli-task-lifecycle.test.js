'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { createTaskRegistry } = require('../public/task-registry');
const fixture = require('./fixtures/cli-tasks-2.1.296.json');

function primary(h) {
  const registry = createTaskRegistry({ onChange: snapshot => h.emitTaskSnapshot(snapshot) });
  for (const entry of [fixture.use, fixture.launch]) registry.ingest('parent-1', entry);
  registry.correlateAgent('parent-1', 'agent-1', fixture.childMeta);
  registry.ownerAlive('parent-1');
  return registry;
}

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [
    { sessionId: 'parent-1', name: 'Parent', modified: new Date().toISOString() },
    { sessionId: 'sub:parent-1:agent-1', parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore', modified: new Date().toISOString() },
  ] })], true);
  return ctx;
}

test('an explicit CLI launch survives ten minutes of silence in the shared renderer registry', t => {
  const h = setup(t);
  let at = Date.now();
  h.window.Date.now = () => at;
  primary(h);
  for (const elapsed of [30001, 60001, 120001, 300001, 600001]) {
    at += elapsed;
    h.window.runSubagentTtlTick();
    assert.ok(h.window.isSubagentActive('parent-1', 'agent-1'), 'primary tasks cannot expire from silence');
  }
});

test('CLI completion clears overlapping fallback evidence immediately and rejects late growth', t => {
  const h = setup(t);
  const registry = primary(h);
  h.window.noteSubagentActivity('parent-1', 'agent-1', 'local-transcript');
  const completion = structuredClone(fixture.notification);
  completion.message.content = completion.message.content.replaceAll(fixture.agentId, 'agent-1');
  registry.ingest('parent-1', completion);
  assert.equal(h.window.isSubagentActive('parent-1', 'agent-1'), false, 'terminal records override fallback evidence');
  h.window.noteSubagentActivity('parent-1', 'agent-1', 'local-transcript');
  h.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', _heartbeat: true });
  assert.equal(h.window.isSubagentActive('parent-1', 'agent-1'), false, 'late growth cannot resurrect a completed task');
});

test('subagent IPC cannot claim CLI primary evidence or complete a primary task', t => {
  const h = setup(t);
  h.evalPublic('shortcuts.js');
  h.evalPublic('grid-view.js');
  h.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', source: 'cli-task' });
  assert.equal(h.window.taskRegistry.primary('parent-1', 'agent-1'), false);
  primary(h);
  h.emitSubagentCompleted({ parentSessionId: 'parent-1', agentId: 'agent-1', source: 'cli-task' });
  assert.equal(h.window.taskRegistry.primary('parent-1', 'agent-1'), true);
});

test('grid attach fallback records attached-ipc and refreshes the existing IPC source on heartbeat', t => {
  const h = setup(t);
  h.evalPublic('shortcuts.js');
  h.evalPublic('grid-view.js');
  h.read("openSessions.set('parent-1', { attach: true })");
  h.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1' });
  const sources = h.window.taskRegistry.agents('parent-1')[0].sources;
  assert.equal(sources.has('attached-ipc'), true);
  assert.equal(sources.has('local-ipc'), false);
  h.read("openSessions.delete('parent-1')");
  h.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', _heartbeat: true });
  assert.equal(sources.has('local-ipc'), false);
});

test('missing CLI records retain the sixty-second fallback TTL', t => {
  const h = setup(t);
  let at = Date.now();
  h.window.Date.now = () => at;
  h.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1' });
  at += 60001;
  h.window.runSubagentTtlTick();
  assert.equal(h.window.isSubagentActive('parent-1', 'agent-1'), false);
});

test('primary snapshots keep the adapter glyph and sidebar/grid counts consistent beyond all decays', t => {
  const h = setup(t);
  h.evalPublic('shortcuts.js');
  h.evalPublic('grid-view.js');
  const card = h.document.createElement('div');
  h.document.body.appendChild(card);
  h.window.__taskCard = card;
  h.read("registerGridCard('parent-1', __taskCard)");
  h.emitSessionTranscriptActivity({ sessionId: 'parent-1', at: Date.now() });
  h.window.decayLocalTranscriptBusy('parent-1');
  h.window.taskRegistry.applySnapshot({ parentSessionId: 'parent-1', revision: 1, known: true, tasks: [{ id: 'agent-1', kind: 'agent', terminal: false, at: 1 }] });
  h.window.decayLocalTranscriptAgentsBusy('parent-1');
  h.window.runSubagentTtlTick();
  assert.ok(h.document.getElementById('si-parent-1').classList.contains('has-busy-agents'));
  assert.equal(h.document.getElementById('si-parent-1').querySelector('.session-subagent-count').textContent, '1 subagent running');
  assert.equal(h.document.getElementById('si-sub:parent-1:agent-1').classList.contains('running'), false);
  assert.equal(card.querySelector('.grid-subagent-count').textContent, '1 subagent running');
  h.emitSessionTranscriptActivity({ kind: 'subagent', parentSessionId: 'parent-1', agentId: 'agent-1', at: Date.now() });
  h.window.taskRegistry.applySnapshot({ parentSessionId: 'parent-1', revision: 2, known: true, tasks: [{ id: 'agent-1', kind: 'agent', terminal: true, at: 2 }] });
  assert.equal(h.document.getElementById('si-parent-1').classList.contains('has-busy-agents'), false);
  assert.equal(h.document.getElementById('si-parent-1').querySelector('.session-subagent-count'), null);
  assert.equal(h.document.getElementById('si-sub:parent-1:agent-1').classList.contains('running'), false);
  assert.equal(card.querySelector('.grid-subagent-count'), null);
});
