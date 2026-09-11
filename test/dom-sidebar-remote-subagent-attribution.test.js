// Issue #247 — has-busy-agents for remote parents and local parents without
// a PTY, and parity of the remote subagent label with local. See
// .ai/contexts/subagent-observability.md ("Attribution across sources").

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

test('a remote subagent row shows its agent type label, exactly like a local one', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);
    const row = ctx.document.getElementById('si-sub:r-top-1:agent-1');
    assert.ok(row, 'the remote subagent row must render');
    const pill = row.querySelector('.sidebar-subagent-type');
    assert.equal(pill.textContent, 'explore',
      'buildSubagentItem reads session.subagentType regardless of remoteAlias — no fork exists for remote rows');
    assert.notEqual(pill.textContent, 'sub', 'must not fall back to the generic label when a real type is known');
  } finally {
    ctx.destroy();
  }
});

test('a remote parent gets has-busy-agents from a subagent write, and it survives a full re-render', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);

    // Drive remote-activity-ui.js's event handler directly — a top-level
    // function declared in a classic <script> lands on window, same pattern
    // dom-setup.js already relies on for renderProjects/buildSessionItem.
    assert.equal(typeof ctx.window.onRemoteActivityEvent, 'function',
      'remote-activity-ui.js must expose its event handler on window');
    ctx.window.onRemoteActivityEvent({ alias: 'vps', parentSessionId: 'r-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    let parent = ctx.document.getElementById('si-r-top-1');
    assert.ok(parent.classList.contains('has-busy-agents'), 'the live event lights the parent row');

    // A full re-render must not wipe it: buildSessionItem's setHasBusyAgents
    // call now also consults the remote-ssh adapter's own snapshot via
    // parentHasActiveSubagent() (public/sidebar.js) — see
    // .ai/contexts/subagent-observability.md.
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);
    parent = ctx.document.getElementById('si-r-top-1');
    assert.ok(parent.classList.contains('has-busy-agents'), 'has-busy-agents must survive a full renderProjects() re-render');
  } finally {
    ctx.destroy();
  }
});

test('a local-transcript parent (no PTY in this app) gets has-busy-agents from a subagent write, and it survives a full re-render', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({
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
      ],
    });
    ctx.sidebar.renderProjects([project], true);

    ctx.emitSessionTranscriptActivity({ parentSessionId: 'l-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    let parent = ctx.document.getElementById('si-l-top-1');
    assert.ok(parent.classList.contains('has-busy-agents'), 'the live event lights the parent row');

    ctx.sidebar.renderProjects([project], true);
    parent = ctx.document.getElementById('si-l-top-1');
    assert.ok(parent.classList.contains('has-busy-agents'), 'has-busy-agents must survive a full renderProjects() re-render');
  } finally {
    ctx.destroy();
  }
});
