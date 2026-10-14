const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function childIsActive(ctx, item) {
  const [, parentId, agentId] = item.dataset.sessionId.split(':');
  return ctx.window.isSubagentActive(parentId, agentId);
}

function projectWithLiveSubagent(overrides = {}) {
  return makeSampleProject({
    sessions: [
      {
        sessionId: 's-top-1',
        name: 'main session',
        summary: 'top level 1',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
      },
      {
        sessionId: 'sub:s-top-1:agent-1',
        parentSessionId: 's-top-1',
        agentId: 'agent-1',
        subagentType: 'explore',
        description: 'explore subagent',
        modified: '2026-05-22T09:59:00.000Z',
        messageCount: 1,
      },
    ],
    ...overrides,
  });
}

test('subagent-spawned: child state updates without a green liveness dot', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(item, 'subagent item must be rendered');
    assert.ok(!childIsActive(ctx, item), 'not running before spawn event');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    assert.ok(childIsActive(ctx, item), 'spawn registers the child as active');
    const dot = item.querySelector('.session-icon');
    assert.ok(!dot.classList.contains('running'), 'child has no green liveness dot');
  } finally {
    ctx.destroy();
  }
});

test('subagent-completed: registry activity is removed again', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.ok(childIsActive(ctx, item), 'running after spawn');

    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-1' });
    assert.ok(!childIsActive(ctx, item), 'registry activity removed after completed');
    assert.ok(!item.querySelector('.session-icon').classList.contains('running'), 'dot no longer running');
  } finally {
    ctx.destroy();
  }
});

test('a full sidebar re-render preserves the active child in the registry', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const before = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(childIsActive(ctx, before), 'running before re-render');
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    const after = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(after, 'subagent item still present after re-render');
    assert.ok(childIsActive(ctx, after), 'registry activity survives a full renderProjects() re-render');
  } finally {
    ctx.destroy();
  }
});

test('collapsed parent: registry tracks the child until completion without a caret marker', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.equal(caret.classList.contains('has-running-child'), false);
    assert.ok(caret, 'caret for s-top-1 must exist');
    assert.ok(!caret.classList.contains('expanded'), 'caret starts collapsed by default');
    assert.ok(!ctx.window.parentHasActiveSubagent('s-top-1'), 'no activity before spawn');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.ok(ctx.window.parentHasActiveSubagent('s-top-1'), 'collapsed parent retains registry activity');

    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-1' });
    assert.ok(!ctx.window.parentHasActiveSubagent('s-top-1'), 'activity removed once the child completes');
  } finally {
    ctx.destroy();
  }
});

test('parent registry activity survives a full re-render without a caret marker', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.equal(caret.classList.contains('has-running-child'), false);
    assert.ok(ctx.window.parentHasActiveSubagent('s-top-1'), 'registry activity survives a full renderProjects() re-render');
  } finally {
    ctx.destroy();
  }
});

test('pruneStaleSubagents: a subagent with no subagent-completed for 60s+ is evicted on the next render', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    assert.equal(ctx.document.getElementById('sub-caret-s-top-1').classList.contains('has-running-child'), false);
    assert.ok(ctx.window.parentHasActiveSubagent('s-top-1'), 'activity set right after spawn');

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 61000; // 61s later — past the 60s TTL, no completed event ever arrived

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    assert.equal(ctx.document.getElementById('sub-caret-s-top-1').classList.contains('has-running-child'), false);
    assert.ok(!ctx.window.parentHasActiveSubagent('s-top-1'), 'stale entry pruned — activity cleared after TTL');
    const itemAfter = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(!childIsActive(ctx, itemAfter), 'stale subagent item no longer marked registry activity after TTL');
  } finally {
    ctx.destroy();
  }
});

test('parent item gets has-busy-agents on spawn and loses it when the last subagent completes', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const parent = ctx.document.getElementById('si-s-top-1');
    assert.ok(parent, 'parent session item must be rendered');
    assert.ok(!parent.classList.contains('has-busy-agents'), 'no indicator before spawn');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.ok(parent.classList.contains('has-busy-agents'), 'indicator set on the parent item after spawn');
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-2', subagentType: 'plan' });
    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-1' });
    assert.ok(parent.classList.contains('has-busy-agents'), 'indicator survives while another subagent is still active');

    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-2' });
    assert.ok(!parent.classList.contains('has-busy-agents'), 'indicator removed when the last subagent completes');
  } finally {
    ctx.destroy();
  }
});

test('has-busy-agents survives a full renderProjects() re-render (state, not just the DOM toggle)', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    const parent = ctx.document.getElementById('si-s-top-1');
    assert.ok(parent.classList.contains('has-busy-agents'), 'has-busy-agents re-derived by buildSessionItem on re-render');
  } finally {
    ctx.destroy();
  }
});

test('a session without active subagents never gets has-busy-agents', () => {
  const ctx = setupSidebarDom();
  try {
    const project = projectWithLiveSubagent();
    project.sessions.push({
      sessionId: 's-top-2',
      name: 'bystander session',
      summary: 'no subagents here',
      modified: '2026-05-22T09:58:00.000Z',
      starred: false,
      archived: 0,
      messageCount: 2,
    });
    ctx.sidebar.renderProjects([project], true);

    const bystander = ctx.document.getElementById('si-s-top-2');
    assert.ok(bystander, 'bystander session item must be rendered');
    assert.ok(!bystander.classList.contains('has-busy-agents'), 'no indicator without subagents');
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.ok(!bystander.classList.contains('has-busy-agents'), 'other parents\' spawns do not mark this session');
    assert.ok(ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'), 'the real parent is marked');
  } finally {
    ctx.destroy();
  }
});

test('clearActiveSubagentsFor (parent PTY stopped): indicator, parent activity and child registry activity drop immediately, no TTL wait', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const parent = ctx.document.getElementById('si-s-top-1');
    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.equal(caret.classList.contains('has-running-child'), false);
    const child = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(parent.classList.contains('has-busy-agents'), 'indicator set after spawn');
    assert.ok(ctx.window.parentHasActiveSubagent('s-top-1'), 'parent activity set after spawn');
    assert.ok(childIsActive(ctx, child), 'child running after spawn');
    ctx.window.clearActiveSubagentsFor('s-top-1');

    assert.ok(!parent.classList.contains('has-busy-agents'), 'indicator dropped immediately on PTY stop');
    assert.ok(!ctx.window.parentHasActiveSubagent('s-top-1'), 'parent activity dropped immediately');
    assert.ok(!childIsActive(ctx, child), 'child registry activity dropped immediately');
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);
    assert.ok(!ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'),
      'state purged — indicator stays off across a full re-render');
    ctx.window.clearActiveSubagentsFor('s-top-1');
    ctx.window.clearActiveSubagentsFor('never-seen');
  } finally {
    ctx.destroy();
  }
});

test('a still-alive heartbeat (re-emitted subagent-spawned) refreshes the 60s TTL', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const t0 = ctx.window.Date.now();
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    ctx.window.Date.now = () => t0 + 45000;
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore', _heartbeat: true });
    ctx.window.Date.now = () => t0 + 90000;
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);
    assert.ok(ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'),
      'heartbeat refreshed the last-seen timestamp — a long-running subagent must not be TTL-evicted');
    ctx.window.Date.now = () => t0 + 45000 + 61000;
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);
    assert.ok(!ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'),
      'no heartbeat for 60s+ — TTL prune still evicts silent agents');
  } finally {
    ctx.destroy();
  }
});

test('has-busy-agents is cleared by the 60s TTL prune on the next render', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.ok(ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'), 'set after spawn');

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 61000; // past the 60s TTL, no completed event ever arrived

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);
    assert.ok(!ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'), 'stale entry pruned — indicator cleared after TTL');
  } finally {
    ctx.destroy();
  }
});

test('pruneStaleSubagents: a subagent spawned within the last 60s is NOT evicted', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 30000; // 30s later — still inside the 60s TTL

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.equal(caret.classList.contains('has-running-child'), false);
    assert.ok(ctx.window.parentHasActiveSubagent('s-top-1'), 'still within TTL — activity must survive the render-time prune');
  } finally {
    ctx.destroy();
  }
});

function projectWithThreeSubagents() {
  const project = projectWithLiveSubagent();
  for (const n of [2, 3]) {
    project.sessions.push({
      sessionId: `sub:s-top-1:agent-${n}`,
      parentSessionId: 's-top-1',
      agentId: `agent-${n}`,
      subagentType: 'plan',
      description: `subagent ${n}`,
      modified: '2026-05-22T09:59:00.000Z',
      messageCount: 1,
    });
  }
  return project;
}

test('a heartbeat for an agent absent from the live map does not resurrect it', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(!childIsActive(ctx, item), 'not running to begin with');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore', _heartbeat: true });

    assert.ok(!childIsActive(ctx, item), 'heartbeat for an untracked agent must not mark it running');
    assert.ok(!ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'),
      'and it must not light the parent indicator either');
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);
    assert.ok(!childIsActive(ctx, ctx.document.getElementById('si-sub:s-top-1:agent-1')),
      'still not running after a full re-render');
  } finally {
    ctx.destroy();
  }
});

test('a heartbeat after completion does not bring the agent back', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-1' });

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore', _heartbeat: true });

    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(!childIsActive(ctx, item), 'a late heartbeat must not undo the completion');
  } finally {
    ctx.destroy();
  }
});

test('the observed inversion: once the only live subagent completes, none of the three rows is running', () => {
  const ctx = setupSidebarDom();
  try {
    const project = projectWithThreeSubagents();
    ctx.sidebar.renderProjects([project], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-2', subagentType: 'plan' });
    assert.ok(childIsActive(ctx, ctx.document.getElementById('si-sub:s-top-1:agent-2')),
      'the live one is running');

    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-2' });
    for (const id of ['agent-1', 'agent-2', 'agent-3']) {
      ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: id, subagentType: 'plan', _heartbeat: true });
    }

    ctx.sidebar.renderProjects([projectWithThreeSubagents()], false);

    for (const id of ['agent-1', 'agent-2', 'agent-3']) {
      const el = ctx.document.getElementById(`si-sub:s-top-1:${id}`);
      assert.ok(el, `${id} must be rendered`);
      assert.ok(!childIsActive(ctx, el), `${id} must not be running after the live agent completed`);
    }
    assert.ok(!ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'),
      'parent indicator off — no subagent is working');
  } finally {
    ctx.destroy();
  }
});

test('a real spawn (no _heartbeat) still adds an agent the renderer has never seen', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(childIsActive(ctx, item), 'a genuine spawn still marks the agent running');
    assert.ok(ctx.document.getElementById('si-s-top-1').classList.contains('has-busy-agents'),
      'and still lights the parent indicator');
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-9', subagentType: 'plan', _bootstrap: true });
    assert.ok(ctx.window.isSubagentActive('s-top-1', 'agent-9'), 'bootstrap spawns are tracked like real ones');
  } finally {
    ctx.destroy();
  }
});
