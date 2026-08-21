// Regression coverage for issue #131 — grid-view.js's initSubagentListeners()
// registered its IPC callbacks as (event, data) => {...}, but preload.js
// invokes subagent listeners with a single payload argument (see
// preload.js:82-83). `data` was therefore always undefined, activeSubagents
// never populated, and the grid-card subagent pills never rendered.
//
// This suite drives the real subagent-spawned/subagent-completed callbacks
// grid-view.js registers, via the dom-setup.js emit helpers (same pattern
// setupSidebarDom uses, added for grid-view.js by #131):
//
//   1. spawn → a pill renders on the parent session's grid card
//   2. complete → the pill (and the pill row once empty) is removed

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupGridViewDom } = require('./dom-setup');

// Registers a minimal open session + card so wrapInGridCard() can build the
// grid-card DOM the pill row attaches to.
function openSession(ctx, sessionId, overrides = {}) {
  const element = ctx.document.createElement('div');
  ctx.window.openSessions.set(sessionId, { closed: false, element, terminal: { focus: () => {} } });
  ctx.window.sessionMap.set(sessionId, {
    sessionId,
    name: 'parent session',
    projectPath: '/home/dev/proj',
    modified: '2026-05-22T10:00:00.000Z',
    ...overrides,
  });
  ctx.gridView.wrapInGridCard(sessionId);
  return ctx.document.querySelector(`.grid-card[data-session-id="${sessionId}"]`);
}

test('subagent-spawned: a pill renders on the parent grid card', () => {
  const ctx = setupGridViewDom();
  try {
    const card = openSession(ctx, 'parent-1');
    assert.ok(card, 'grid card must be created for the open session');
    assert.equal(card.querySelectorAll('.grid-subagent-pill').length, 0, 'no pill before the spawn event');

    ctx.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore' });

    const pills = card.querySelectorAll('.grid-subagent-pill');
    assert.equal(pills.length, 1, 'pill appears after subagent-spawned');
    assert.equal(pills[0].title, 'explore', 'pill carries the subagent type');
  } finally {
    ctx.destroy();
  }
});

test('subagent-completed: the pill (and empty pill row) are removed', () => {
  const ctx = setupGridViewDom();
  try {
    const card = openSession(ctx, 'parent-1');
    ctx.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.equal(card.querySelectorAll('.grid-subagent-pill').length, 1, 'pill present after spawn');

    ctx.emitSubagentCompleted({ parentSessionId: 'parent-1', agentId: 'agent-1' });

    assert.equal(card.querySelectorAll('.grid-subagent-pill').length, 0, 'pill removed after subagent-completed');
    assert.ok(!card.querySelector('.grid-subagent-pills'), 'empty pill row is dropped, not left as a dangling wrapper');
  } finally {
    ctx.destroy();
  }
});

test('multiple subagents on the same parent each get their own pill', () => {
  const ctx = setupGridViewDom();
  try {
    const card = openSession(ctx, 'parent-1');

    ctx.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore' });
    ctx.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-2', subagentType: 'implement' });

    assert.equal(card.querySelectorAll('.grid-subagent-pill').length, 2, 'both subagents render a pill');

    ctx.emitSubagentCompleted({ parentSessionId: 'parent-1', agentId: 'agent-1' });

    assert.equal(card.querySelectorAll('.grid-subagent-pill').length, 1, 'completing one subagent leaves the other pill');
  } finally {
    ctx.destroy();
  }
});

test('a subagent-spawned event for a parent with no open grid card is a silent no-op', () => {
  const ctx = setupGridViewDom();
  try {
    // No card registered for 'unknown-parent' — must not throw.
    assert.doesNotThrow(() => {
      ctx.emitSubagentSpawned({ parentSessionId: 'unknown-parent', agentId: 'agent-1', subagentType: 'explore' });
    });
  } finally {
    ctx.destroy();
  }
});
