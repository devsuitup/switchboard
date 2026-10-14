const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function childIsActive(ctx, item) {
  const [, parentId, agentId] = item.dataset.sessionId.split(':');
  return ctx.window.isSubagentActive(parentId, agentId);
}

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

test('a remote subagent watch event registers child activity without a full rebuild', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);
    const item = ctx.document.getElementById('si-sub:r-top-1:agent-1');
    assert.ok(item, 'remote subagent item must be rendered');
    assert.ok(!childIsActive(ctx, item), 'not running before the event');

    assert.equal(typeof ctx.window.onRemoteActivityEvent, 'function');
    ctx.window.onRemoteActivityEvent({ alias: 'vps', parentSessionId: 'r-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    assert.ok(childIsActive(ctx, item), 'remote watch registers the child as active');
    const dot = item.querySelector('.session-icon');
    assert.ok(!dot.classList.contains('running'), 'child has no green liveness dot');
    const parent = ctx.document.getElementById('si-r-top-1');
    assert.ok(parent.classList.contains('has-busy-agents'), 'parent still shows has-busy-agents');
    assert.ok(parent.querySelector('.session-icon').classList.contains('session-icon--agents-busy'),
      'parent icon slot still resolves to the agents-busy rung, not reset by the child update');
  } finally {
    ctx.destroy();
  }
});

test('a local-transcript subagent activity event registers child activity without a full rebuild', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLocalTranscriptSubagent()], true);
    const item = ctx.document.getElementById('si-sub:l-top-1:agent-1');
    assert.ok(item, 'local-transcript subagent item must be rendered');
    assert.ok(!childIsActive(ctx, item), 'not running before the event');

    ctx.emitSessionTranscriptActivity({ parentSessionId: 'l-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    assert.ok(childIsActive(ctx, item), 'transcript activity registers the child as active');
    assert.ok(!item.querySelector('.session-icon').classList.contains('running'), 'child has no green liveness dot');
  } finally {
    ctx.destroy();
  }
});

test('decay: the TTL prune clears silent remote subagent registry activity', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);
    ctx.window.onRemoteActivityEvent({ alias: 'vps', parentSessionId: 'r-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    const item = ctx.document.getElementById('si-sub:r-top-1:agent-1');
    assert.ok(childIsActive(ctx, item), 'running right after the event');

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 61000; // past the 60s TTL shared with the local IPC path

    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], false);

    const after = ctx.document.getElementById('si-sub:r-top-1:agent-1');
    assert.ok(!childIsActive(ctx, after), 'registry activity cleared by the same TTL prune used for local subagents');
  } finally {
    ctx.destroy();
  }
});

test('local IPC subagent-spawned registers child activity immediately without a rebuild', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLocalSubagent()], true);
    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(!childIsActive(ctx, item), 'not running before spawn');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    assert.ok(childIsActive(ctx, item), 'local IPC registers the child as active');
  } finally {
    ctx.destroy();
  }
});

test('(5) an attached remote parent gets its icon repainted by a local subagent-spawned IPC, immediately', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({
      remoteAlias: 'vps',
      sessions: [{
        sessionId: 'r-attached-1',
        remoteAlias: 'vps',
        name: 'attached remote session',
        summary: 'attached',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
      }],
    });
    ctx.sidebar.renderProjects([project], true);
    ctx.window.setRemoteAttached('r-attached-1', true);
    ctx.setActivity('r-attached-1', false, 'seed');

    ctx.emitSubagentSpawned({ parentSessionId: 'r-attached-1', agentId: 'agent-1' });

    const icon = ctx.document.getElementById('si-r-attached-1').querySelector('.session-icon');
    assert.ok(icon.classList.contains('session-icon--agents-busy'),
      'attached row is local-pty owned — its icon slot must repaint immediately, no rebuild');
  } finally {
    ctx.destroy();
  }
});

test('(6) an unattached remote parent icon, once painted by the remote adapter, survives a local subagent-spawned IPC', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({
      remoteAlias: 'vps',
      sessions: [{
        sessionId: 'r-unattached-1',
        remoteAlias: 'vps',
        name: 'unattached remote session',
        summary: 'unattached',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
      }],
    });
    ctx.sidebar.renderProjects([project], true);
    ctx.window.onRemoteActivityEvent({ alias: 'vps', parentSessionId: 'r-unattached-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
    const icon = ctx.document.getElementById('si-r-unattached-1').querySelector('.session-icon');
    assert.ok(icon.classList.contains('session-icon--agents-busy'), 'precondition: remote adapter painted agents-busy');
    ctx.emitSubagentSpawned({ parentSessionId: 'r-unattached-1', agentId: 'agent-2' });

    assert.ok(icon.classList.contains('session-icon--agents-busy'),
      'unattached remote row stays owned by the remote-ssh adapter — the local-pty repaint must not run');
  } finally {
    ctx.destroy();
  }
});

test('(7) recv.subagent-spawned tags source:"local-ipc", exactly once', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLocalSubagent()], true);
    const sent = [];
    ctx.window.ATRACE = true;
    ctx.window.atrace = (cat, sid, fields) => sent.push({ cat, sid, fields });

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1' });

    const events = sent.filter(e => e.cat === 'recv.subagent-spawned');
    assert.equal(events.length, 1, 'not traced twice now that the handler no longer traces its own copy');
    assert.equal(events[0].fields.source, 'local-ipc');
  } finally {
    ctx.destroy();
  }
});

test('(8) recv.subagent-spawned tags source:"remote-watch"', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);
    const sent = [];
    ctx.window.ATRACE = true;
    ctx.window.atrace = (cat, sid, fields) => sent.push({ cat, sid, fields });

    ctx.window.onRemoteActivityEvent({ alias: 'vps', parentSessionId: 'r-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    const events = sent.filter(e => e.cat === 'recv.subagent-spawned');
    assert.equal(events.length, 1);
    assert.equal(events[0].fields.source, 'remote-watch');
  } finally {
    ctx.destroy();
  }
});

test('(9) recv.subagent-spawned tags source:"local-transcript"', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLocalTranscriptSubagent()], true);
    const sent = [];
    ctx.window.ATRACE = true;
    ctx.window.atrace = (cat, sid, fields) => sent.push({ cat, sid, fields });

    ctx.emitSessionTranscriptActivity({ parentSessionId: 'l-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });

    const events = sent.filter(e => e.cat === 'recv.subagent-spawned');
    assert.equal(events.length, 1);
    assert.equal(events[0].fields.source, 'local-transcript');
  } finally {
    ctx.destroy();
  }
});

test('(10) recv.subagent-completed via:"ipc" for the direct completed IPC', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLocalSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1' });
    const sent = [];
    ctx.window.ATRACE = true;
    ctx.window.atrace = (cat, sid, fields) => sent.push({ cat, sid, fields });

    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-1' });

    const ev = sent.find(e => e.cat === 'recv.subagent-completed');
    assert.ok(ev);
    assert.equal(ev.fields.via, 'ipc');
  } finally {
    ctx.destroy();
  }
});

test('(11) recv.subagent-completed via:"parent-cleared" from clearActiveSubagentsFor', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLocalSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1' });
    const sent = [];
    ctx.window.ATRACE = true;
    ctx.window.atrace = (cat, sid, fields) => sent.push({ cat, sid, fields });

    ctx.window.clearActiveSubagentsFor('s-top-1');

    const ev = sent.find(e => e.cat === 'recv.subagent-completed');
    assert.ok(ev);
    assert.equal(ev.fields.via, 'parent-cleared');
  } finally {
    ctx.destroy();
  }
});

test('(12) recv.subagent-completed via:"ttl" — the only completion remote-watch ever gets', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], true);
    ctx.window.onRemoteActivityEvent({ alias: 'vps', parentSessionId: 'r-top-1', agentId: 'agent-1', at: Date.now(), kind: 'subagent' });
    const sent = [];
    ctx.window.ATRACE = true;
    ctx.window.atrace = (cat, sid, fields) => sent.push({ cat, sid, fields });

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 61000; // past the 60s TTL
    ctx.sidebar.renderProjects([projectWithRemoteSubagent()], false);

    const ev = sent.find(e => e.cat === 'recv.subagent-completed');
    assert.ok(ev, 'the TTL prune traces the completion since remote-watch never sends one itself');
    assert.equal(ev.fields.via, 'ttl');
  } finally {
    ctx.destroy();
  }
});
