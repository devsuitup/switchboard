// Issue #285 — a running subagent's own row never got the green `.running`
// dot when its activity came from the remote watch channel or the
// local-transcript adapter, even after a full sidebar rebuild. Both adapters
// received `agentId` in their payload already (public/remote-activity.js,
// local-transcript-activity.js) but only fed the parent's own agentsBusy
// field. See .ai/contexts/subagent-observability.md ("Attribution across
// sources") and .ai/contexts/session-state.md.
//
// B2 (the DOM-id lookup) was investigated separately and does not reproduce
// for a real subagent row: buildSubagentItem ids the row 'si-' + session.
// sessionId, and every subagent session.sessionId in session_cache is built
// via subagentSessionId(parent, agentId) = 'sub:'+parent+':'+agentId
// (read-session-file.js), for local, remote-mirrored and legacy-layout rows
// alike — byte-identical to subagentDomId(parent, agentId) =
// 'si-sub:'+parent+':'+agentId. test/dom-sidebar-subagent-running.test.js
// already pins the local IPC path landing .running with no rebuild; test 4
// below re-confirms it in this file for completeness.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function projectWithRemoteSubagent() {
  return makeSampleProject({
    remoteAlias: 'vps',
    sessions: [
      {
        sessionId: 'r-top-1',
        remoteAlias: 'vps',
        name: 'remote main session',
        summary: 'remote top level',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
      },
      {
        sessionId: 'sub:r-top-1:agent-1',
        parentSessionId: 'r-top-1',
        agentId: 'agent-1',
        remoteAlias: 'vps',
        subagentType: 'explore',
        description: 'explore subagent',
        modified: '2026-05-22T09:59:00.000Z',
        messageCount: 1,
      },
    ],
  });
}

function projectWithLocalTranscriptSubagent() {
  return makeSampleProject({
    sessions: [
      {
        sessionId: 'l-top-1',
        name: 'local main session, no PTY',
        summary: 'local top level',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
      },
      {
        sessionId: 'sub:l-top-1:agent-1',
        parentSessionId: 'l-top-1',
        agentId: 'agent-1',
        subagentType: 'explore',
        description: 'explore subagent',
        modified: '2026-05-22T09:59:00.000Z',
        messageCount: 1,
      },
    ],
  });
}

function projectWithLocalSubagent() {
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
  });
}

test('a remote subagent watch event sets .running on the child row without a full rebuild', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);
    const item = ctx.document.getElementById('si-sub:r-top-1:agent-1');
    assert.ok(item, 'remote subagent item must be rendered');
    assert.ok(!item.classList.contains('running'), 'not running before the event');

    assert.equal(typeof ctx.window.onRemoteActivityEvent, 'function');
    ctx.window.onRemoteActivityEvent({ alias: 'vps', parentSessionId: 'r-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    assert.ok(item.classList.contains('running'), '.running set on the remote subagent item after the watch event, no rebuild needed');
    const dot = item.querySelector('.session-icon');
    assert.ok(dot.classList.contains('running'), '.running set on the dot too');

    // The parent's own icon slot must still reflect the remote-ssh adapter's
    // own snapshot (agentsBusy), not get overwritten by a local-pty snapshot —
    // see .ai/contexts/subagent-observability.md.
    const parent = ctx.document.getElementById('si-r-top-1');
    assert.ok(parent.classList.contains('has-busy-agents'), 'parent still shows has-busy-agents');
    assert.ok(parent.querySelector('.session-icon').classList.contains('session-icon--agents-busy'),
      'parent icon slot still resolves to the agents-busy rung, not reset by the child update');
  } finally {
    ctx.destroy();
  }
});

test('a local-transcript subagent activity event sets .running on the child row without a full rebuild', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLocalTranscriptSubagent()], true);
    const item = ctx.document.getElementById('si-sub:l-top-1:agent-1');
    assert.ok(item, 'local-transcript subagent item must be rendered');
    assert.ok(!item.classList.contains('running'), 'not running before the event');

    ctx.emitSessionTranscriptActivity({ parentSessionId: 'l-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    assert.ok(item.classList.contains('running'), '.running set on the local-transcript subagent item, no rebuild needed');
    assert.ok(item.querySelector('.session-icon').classList.contains('running'), '.running set on the dot too');
  } finally {
    ctx.destroy();
  }
});

test('decay: a remote subagent stops being reported and the TTL prune clears .running', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);
    ctx.window.onRemoteActivityEvent({ alias: 'vps', parentSessionId: 'r-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    const item = ctx.document.getElementById('si-sub:r-top-1:agent-1');
    assert.ok(item.classList.contains('running'), 'running right after the event');

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 61000; // past the 60s TTL shared with the local IPC path

    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], false);

    const after = ctx.document.getElementById('si-sub:r-top-1:agent-1');
    assert.ok(!after.classList.contains('running'), '.running cleared by the same TTL prune used for local subagents');
  } finally {
    ctx.destroy();
  }
});

test('local IPC subagent-spawned still sets .running on the child row immediately (no rebuild)', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLocalSubagent()], true);
    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(!item.classList.contains('running'), 'not running before spawn');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    assert.ok(item.classList.contains('running'), '.running set immediately — subagentDomId matches the rendered row id');
  } finally {
    ctx.destroy();
  }
});
