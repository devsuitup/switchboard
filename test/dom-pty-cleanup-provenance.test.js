'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t, rows = [{ sessionId: 'external' }, { sessionId: 'X' }, { sessionId: 'Y' }]) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  Object.assign(ctx.window, {
    gridCards: new Map(),
    gridViewActive: false,
    skippedWorkingSetEntries: new Map(),
    renderDefaultStatus() {},
    noteSessionExit() {},
    lastSessionExit() { return {}; },
    schedulePersistWorkingSet() {},
    pollActiveSessions() {},
  });
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: rows.map(row => ({
    name: row.sessionId, modified: new Date().toISOString(), ...row,
  })) })], true);
  for (const row of rows) ctx.window.sessionMap.set(row.sessionId, row);
  const app = loadAppFunctions(ctx.context, {
    declarations: ['_lastPtySignature'],
    functions: ['updateRunningIndicators', 'applyProcessExit'],
  });
  return {
    ...ctx,
    ...app,
    tracked(parent, agent = 'agent') { return ctx.window.isSubagentActive(parent, agent); },
    row(parent) { return ctx.document.getElementById('si-' + parent); },
    transcript(parent, agent = 'agent') {
      ctx.emitSessionTranscriptActivity({ kind: 'subagent', parentSessionId: parent, agentId: agent, at: Date.now() });
    },
    ipc(parent, agent = 'agent') { ctx.emitSubagentSpawned({ parentSessionId: parent, agentId: agent }); },
    refresh(ids) { ctx.window.activePtyIds = new Set(ids); app.updateRunningIndicators(); },
  };
}

test('opening and closing X preserves external transcript agents and Y, then clears only X', t => {
  const h = setup(t);
  h.transcript('external');
  h.refresh(['Y']);
  assert.ok(h.tracked('external'), 'opening an unrelated PTY preserves external agents');
  h.ipc('Y');
  h.refresh(['X', 'Y']);
  h.ipc('X');
  h.refresh(['Y']);
  h.refresh(['Y']);
  assert.ok(h.tracked('external'));
  assert.ok(h.row('external').classList.contains('has-busy-agents'));
  assert.ok(h.tracked('Y'));
  assert.equal(h.tracked('X'), false);
});

test('releasing X removes its IPC contribution while preserving the same agent from a transcript', t => {
  const h = setup(t);
  h.transcript('X');
  h.refresh(['X']);
  h.ipc('X');
  h.refresh([]);
  assert.ok(h.tracked('X'), 'the transcript contribution survives the PTY release');
  assert.ok(h.row('X').classList.contains('has-busy-agents'));
  assert.equal(h.sessionBusyState.has('X'), false, 'the PTY adapter itself is purged');
});

test('an IPC completion preserves overlapping transcript and remote-watch evidence for the same agent', t => {
  const h = setup(t);
  h.transcript('X');
  h.window.noteSubagentActivity('X', 'agent', 'remote-watch');
  h.ipc('X');
  h.emitSubagentCompleted({ parentSessionId: 'X', agentId: 'agent' });
  assert.ok(h.tracked('X'));
  assert.ok(h.row('X').classList.contains('has-busy-agents'));
});

for (const { source, entryAfterSpawn } of [
  { source: 'local', entryAfterSpawn: 'attached' },
  { source: 'local', entryAfterSpawn: 'removed' },
  { source: 'attached', entryAfterSpawn: 'removed' },
]) {
  test(`a ${source} IPC heartbeat survives when the open entry is ${entryAfterSpawn}, then completion clears it`, t => {
    const h = setup(t);
    const originalNow = h.window.Date.now;
    const now = originalNow();
    t.after(() => { h.window.Date.now = originalNow; });
    h.window.Date.now = () => now;
    h.window.openSessions.set('X', { attach: source === 'attached' });
    h.ipc('X');
    if (entryAfterSpawn === 'attached') h.window.openSessions.get('X').attach = true;
    else h.window.openSessions.delete('X');
    h.window.Date.now = () => now + 50000;
    h.emitSubagentSpawned({ parentSessionId: 'X', agentId: 'agent', _heartbeat: true });
    h.window.Date.now = () => now + 61000;
    h.window.runSubagentTtlTick();
    assert.ok(h.tracked('X'), 'the watcher heartbeat keeps the agent alive beyond its spawn TTL');
    assert.ok(h.row('X').classList.contains('has-busy-agents'));
    h.emitSubagentCompleted({ parentSessionId: 'X', agentId: 'agent' });
    assert.equal(h.tracked('X'), false, 'watcher completion clears the original IPC contribution');
    assert.equal(h.row('X').classList.contains('has-busy-agents'), false);
  });
}

test('watcher completion releases both IPC sources and preserves transcript evidence', t => {
  const h = setup(t);
  h.transcript('X');
  h.ipc('X');
  h.window.openSessions.set('X', { attach: true });
  h.ipc('X');
  h.emitSubagentCompleted({ parentSessionId: 'X', agentId: 'agent' });
  assert.ok(h.tracked('X'), 'the independent transcript contribution remains');
  h.window.clearActiveSubagentsFor('X', 'local-transcript');
  assert.equal(h.tracked('X'), false, 'neither IPC source survives completion');
});

test('a new PTY takes over transcript state before its row is rendered', t => {
  const h = setup(t);
  h.emitSessionTranscriptActivity({ sessionId: 'X', at: Date.now() });
  h.transcript('X');
  const row = h.row('X');
  row.remove();
  h.refresh(['X']);
  assert.equal(h.read("localTranscriptStates.has('X')"), false, 'PTY ownership changes without a rendered row');
  assert.equal(h.read("localTranscriptDecayTimers.has('X')"), false);
  assert.equal(h.read("localTranscriptAgentsDecayTimers.has('X')"), false);
  h.document.body.append(row);
  h.refresh(['X']);
  h.setActivity('X', false, 'pty-idle', { armReady: false });
  h.window.decayLocalTranscriptBusy('X');
  h.window.decayLocalTranscriptAgentsBusy('X');
  assert.equal(row.classList.contains('cli-busy'), false, 'a late transcript decay cannot override PTY idle');
});

test('a confirmed X process exit clears X IPC agents but preserves unrelated external and Y activity', t => {
  const h = setup(t);
  h.refresh(['X', 'Y']);
  h.transcript('external');
  h.ipc('X');
  h.ipc('Y');
  h.setActivity('X', true, 'test');
  h.window.setAttention('X', true, 'test');
  h.applyProcessExit('X', 0, null, false);
  assert.equal(h.tracked('X'), false);
  assert.equal(h.sessionBusyState.has('X'), false);
  assert.equal(h.attentionSessions.has('X'), false);
  assert.ok(h.tracked('external'));
  assert.ok(h.tracked('Y'));
});

test('remote detachment preserves remote task evidence and liveness', t => {
  const h = setup(t, [{ sessionId: 'remote', remoteAlias: 'vps', remoteDescriptorSeen: true }]);
  h.window.onRemoteActivityEvent({ alias: 'vps', kind: 'subagent', parentSessionId: 'remote', agentId: 'agent' });
  h.refresh(['remote']);
  h.refresh([]);
  assert.ok(h.tracked('remote'));
  assert.ok(h.row('remote').classList.contains('has-busy-agents'));
  assert.ok(h.row('remote').classList.contains('is-alive'));
});

test('a daemon attach transport exit preserves its agent evidence', t => {
  const h = setup(t, [{ sessionId: 'daemon', status: 'idle', statusUpdatedAt: Date.now() }]);
  h.window.openSessions.set('daemon', { attach: true, session: { sessionId: 'daemon' }, terminal: { write() {} } });
  h.refresh(['daemon']);
  h.ipc('daemon');
  h.applyProcessExit('daemon', 0, null, false);
  assert.ok(h.tracked('daemon'), 'an attach transport exit is not the agent process exiting');
  assert.ok(h.row('daemon').classList.contains('has-busy-agents'));
});

test('daemon detachment preserves provenance after terminal teardown removes the open entry', t => {
  const h = setup(t, [{ sessionId: 'daemon' }]);
  h.window.openSessions.set('daemon', { attach: true });
  h.refresh(['daemon']);
  h.ipc('daemon');
  h.window.openSessions.delete('daemon');
  h.refresh([]);
  h.applyProcessExit('daemon', 0, null, false);
  assert.ok(h.tracked('daemon'));
  assert.ok(h.row('daemon').classList.contains('has-busy-agents'));
});

test('a merged row preserves its unattached transcript member when its attached member stops', t => {
  const h = setup(t, [{ sessionId: 'head', mergedMemberIds: ['attached', 'external'] }]);
  h.transcript('external');
  h.refresh(['attached']);
  assert.ok(h.tracked('external'), 'opening one merged member preserves its external sibling');
  h.ipc('attached');
  h.refresh([]);
  assert.equal(h.tracked('attached'), false);
  assert.ok(h.tracked('external'));
  assert.ok(h.row('head').classList.contains('has-busy-agents'));
});

test('a PTY release also cleans its owned agents when its row is not rendered', t => {
  const h = setup(t);
  h.refresh(['X']);
  h.ipc('X');
  h.row('X').remove();
  h.refresh([]);
  assert.equal(h.tracked('X'), false);
});

test('rekeying a PTY preserves agent provenance at its new identity', t => {
  const h = setup(t);
  h.transcript('X');
  h.ipc('X');
  h.window.rekeyActivityState('X', 'Y');
  assert.equal(h.tracked('X'), false);
  assert.ok(h.tracked('Y'));
  h.window.dropLocalPtySession('Y', 'process-exited');
  assert.ok(h.tracked('Y'), 'the moved transcript contribution remains after IPC cleanup');
});

test('rekeying an IPC-owned agent keeps its new row busy and leaves no old PTY state', t => {
  const h = setup(t);
  h.setActivity('X', true, 'test');
  h.ipc('X');
  h.window.rekeyActivityState('X', 'Y');
  assert.equal(h.sessionBusyState.has('X'), false);
  assert.ok(h.read("localPtyStates.get('Y').snapshot().agentsBusy"));
  h.window.dropLocalPtySession('Y', 'process-exited');
  assert.equal(h.tracked('Y'), false);
});

test('a removed IPC source cannot be resurrected by a late heartbeat after external evidence expires', t => {
  const h = setup(t);
  const now = h.window.Date.now();
  h.transcript('X');
  h.window.Date.now = () => now + 30000;
  h.ipc('X');
  h.window.dropLocalPtySession('X', 'process-exited');
  h.window.Date.now = () => now + 61000;
  h.emitSubagentSpawned({ parentSessionId: 'X', agentId: 'agent', _heartbeat: true });
  h.window.runSubagentTtlTick();
  assert.equal(h.tracked('X'), false);
});
