// Issue #247 — has-busy-agents for remote parents and local parents without
// a PTY, and parity of the remote subagent label with local. See
// .ai/contexts/subagent-observability.md ("Attribution across sources").

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalTranscriptTracker } = require('../local-transcript-activity');
const { createRemoteActivityTracker } = require('../remote-activity');

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

for (const source of ['local', 'remote']) {
  test(`${source} tracker delivers all three identities into the shared registry and source-scoped completion removes each separately`, async t => {
    const ctx = setupSidebarDom();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-delivery-622-'));
    const parentSessionId = '11111111-1111-4111-8111-111111111111';
    const agentIds = ['A', 'B', 'C'];
    const activitySource = source === 'local' ? 'local-transcript' : 'remote-watch';
    const remote = source === 'remote' ? { remoteAlias: 'vps' } : {};
    const project = makeSampleProject({ ...remote, sessions: [
      { sessionId: parentSessionId, ...remote, modified: '2026-05-22T10:00:00Z' },
      ...agentIds.map(agentId => ({ sessionId: `sub:${parentSessionId}:${agentId}`,
        parentSessionId, agentId, ...remote, modified: '2026-05-22T10:00:00Z' })),
    ] });
    ctx.sidebar.renderProjects([project], true);
    let delivered = 0;
    const onRemote = event => { delivered++; ctx.window.onRemoteActivityEvent(event); };
    const tracker = source === 'local'
      ? createLocalTranscriptTracker({ projectsDir: root, now: () => 1_000_000,
        onActivity: event => ctx.emitSessionTranscriptActivity(event) })
      : createRemoteActivityTracker({ now: () => 1_000_000,
        onActivity: onRemote });
    t.after(() => {
      tracker.dispose?.();
      ctx.destroy();
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    for (const agentId of agentIds) {
      const parts = ['folder', parentSessionId, 'subagents', `agent-${agentId}.jsonl`];
      if (source === 'local') {
        const file = path.join(root, ...parts);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'old\n');
        fs.utimesSync(file, 100, 100);
        await tracker.record(parts);
        fs.appendFileSync(file, 'new\n');
        await tracker.record(parts);
      } else {
        const before = delivered;
        const event = tracker.record('vps', parts.join('/'));
        if (event && delivered === before) onRemote(event);
      }
    }
    const active = () => Array.from(ctx.read(`activeSubagentsByParent.get('${parentSessionId}')?.keys() || []`));
    assert.deepEqual(active(), agentIds);
    for (let i = 0; i < agentIds.length; i++) {
      const agentId = agentIds[i];
      const sources = () => Array.from(ctx.read(`activeSubagentsByParent.get('${parentSessionId}')?.get('${agentId}')?.keys() || []`));
      ctx.emitSubagentCompleted({ parentSessionId, agentId });
      assert.deepEqual(active(), agentIds.slice(i), 'IPC completion preserves tracker-only identities');
      ctx.emitSubagentSpawned({ parentSessionId, agentId });
      assert.deepEqual(sources(), [activitySource, 'local-ipc']);
      ctx.emitSubagentCompleted({ parentSessionId, agentId });
      assert.deepEqual(sources(), [activitySource], 'IPC completion removes only its own contribution');
      assert.deepEqual(active(), agentIds.slice(i), 'tracker evidence survives overlapping IPC completion');
      ctx.window.releaseSubagentSource(parentSessionId, agentId, activitySource, 'test');
      assert.deepEqual(active(), agentIds.slice(i + 1), 'source release removes only its agent, independently of heartbeat throttle');
    }
  });
}
