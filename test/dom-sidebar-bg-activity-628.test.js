'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { parseJobState, mergeRoster } = require('../bg-agents-roster');

const SID = 'aaaaaaaa-1234-4321-abcd-123456789abc';
const AT = Date.now() - 10_000;

function roster(state = 'working', kind = 'agent', extra = {}) {
  const job = parseJobState(JSON.stringify({ state, updatedAt: new Date(AT).toISOString(),
    inFlight: { tasks: 0, kinds: [] }, sessionId: SID,
    fan: kind ? [{ id: 'task-1', kind, startedAt: AT - 1000 }] : [], ...extra }));
  return mergeRoster({ cli: [{ id: 'aaaaaaaa', kind: 'background', sessionId: SID, state: 'working', status: 'busy' }],
    jobs: new Map([['aaaaaaaa', job]]), descriptors: [{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: SID,
      status: 'busy', statusUpdatedAt: 1, cwd: '/repo', pid: 10 }] });
}

async function setup(t, entries = roster()) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  let push;
  let subscriptions = 0;
  h.window.api.getBgAgents = async () => ({ roster: entries, daemonReachable: true });
  h.window.api.onBgAgentsChanged = cb => { push = cb; subscriptions++; };
  h.evalPublic('agents-view.js');
  const session = { sessionId: SID, bgJobId: 'aaaaaaaa', status: 'busy', statusUpdatedAt: 1,
    modified: new Date().toISOString(), summary: 'Background conversation' };
  h.window.sessionMap.set(SID, session);
  h.window.refreshSidebar = () => {
    h.document.getElementById('sidebar-content').replaceChildren(h.sidebar.buildSessionItem(session));
  };
  h.window.initAgentsView();
  await Promise.resolve();
  await Promise.resolve();
  h.window.refreshSidebar();
  return { ...h, push: s => push(s), subscriptions: () => subscriptions };
}

for (const [state, kind, head, slot, count] of [
  ['working', 'agent', 'closed', 'agents-busy', 1],
  ['working', 'cron', 'closed', 'agents-busy', 0],
  ['working', 'bash', 'closed', 'agents-busy', 0],
  ['working', 'monitor', 'closed', 'agents-busy', 0],
  ['working', 'agent', 'open', 'busy', 1],
  ['blocked', 'agent', 'open', 'attention', 1],
  ['done', 'agent', 'open', 'stale', 0],
  ['stopped', 'agent', 'open', 'stale', 0],
  ['failed', 'agent', 'open', 'stale', 0],
  ['future-state', null, 'unknown', 'waiting', 0],
]) {
  test(`[628] cold sidebar and Agents: ${state}, ${kind}, head ${head}`, async t => {
    const entries = roster(state, kind);
    const h = await setup(t, entries);
    h.emitHeadTurn(SID, head);
    h.window.refreshSidebar();
    assert.equal(h.read('agentsViewActive'), false);
    assert.equal(h.subscriptions(), 1);
    const row = h.document.querySelector('.session-item');
    assert.equal(row.querySelectorAll('.session-icon').length, 1);
    assert.ok(row.querySelector(`.session-icon--${slot}`), row.innerHTML);
    assert.equal(h.window.taskRegistry.runningAgentCount([SID]), count);
    assert.equal(!!row.querySelector('.session-subagent-count'), count > 0);
    const secondary = row.querySelector('.session-status');
    assert.doesNotMatch(secondary.textContent, /busy|\d+[smhd]/);
    assert.match(secondary.title, /job|unavailable/i);
    const agent = h.window.agentRowIcon(entries[0]);
    assert.equal(agent.slotClass, `session-icon--${slot}`);
    const agentRow = h.document.createElement('div');
    agentRow.innerHTML = h.window.renderAgentRow(entries[0]);
    assert.equal(agentRow.querySelectorAll('.session-icon').length, 1);
    assert.ok(agentRow.querySelector(`.session-icon--${slot}`));
    assert.doesNotMatch(agentRow.querySelector('.agents-row-state').textContent, /busy|idle/);
  });
}

test('[628] pushes refresh same-member activity and retain head/unseen evidence across degraded jobs', async t => {
  const h = await setup(t);
  h.emitHeadTurn(SID, 'closed');
  h.window.noteWrittenActivity(SID);
  const degraded = roster('working', null, { updatedAt: 'invalid' });
  h.push({ roster: degraded, daemonReachable: false });
  let row = h.document.querySelector('.session-item');
  assert.match(row.querySelector('.session-status').textContent, /unavailable/i);
  assert.ok(row.classList.contains('unseen-written-activity'));
  assert.equal(row.classList.contains('cli-busy'), false);
  h.emitHeadTurn(SID, 'open', { revision: 2 });
  assert.ok(row.querySelector('.session-icon--busy'), 'validated head is still usable without a job format');
  h.push({ roster: roster('blocked'), daemonReachable: true });
  row = h.document.querySelector('.session-item');
  assert.ok(row.querySelector('.session-icon--attention'));
  assert.match(row.querySelector('.session-status').textContent, /blocked/i);
  assert.equal(h.subscriptions(), 1);
});

test('[628] a regressing job timestamp degrades activity without reviving descriptor status', async t => {
  const h = await setup(t);
  h.emitHeadTurn(SID, 'closed');
  h.push({ roster: roster('working', 'cron', { updatedAt: new Date(AT - 1000).toISOString() }), daemonReachable: true });
  assert.match(h.document.querySelector('.session-status').textContent, /unavailable/i);
  assert.equal(h.document.querySelector('.session-item').classList.contains('cli-busy'), false);
  h.push({ roster: roster('working', 'cron', { updatedAt: new Date(AT - 500).toISOString() }), daemonReachable: true });
  assert.match(h.document.querySelector('.session-status').textContent, /unavailable/i);
});

test('[628] secondary activity follows head pushes and attached attention without a roster change', async t => {
  const h = await setup(t);
  h.emitHeadTurn(SID, 'closed');
  h.emitHeadTurn(SID, 'open', { revision: 2 });
  assert.match(h.document.querySelector('.session-status').textContent, /Working/);
  h.window.activePtyIds.add(SID);
  h.window.setAttention(SID, true, 'onTerminalNotification');
  assert.ok(h.document.querySelector('.session-icon--attention'));
});

test('[628] bootstrap response cannot overwrite a newer push', async t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  let resolve;
  let push;
  h.window.api.getBgAgents = () => new Promise(r => { resolve = r; });
  h.window.api.onBgAgentsChanged = cb => { push = cb; };
  h.evalPublic('agents-view.js');
  h.window.initAgentsView();
  push({ roster: roster('done'), daemonReachable: true });
  resolve({ roster: roster('working'), daemonReachable: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.window.backgroundActivityEntry(SID).state, 'done');
});

test('[628] detached transcript descriptor idle cannot close a validated head turn', async t => {
  const h = await setup(t, roster('working', null));
  const session = h.window.sessionMap.get(SID);
  session.status = 'idle';
  session.statusUpdatedAt = Date.now() + 1000;
  h.emitSessionTranscriptActivity({ sessionId: SID, at: Date.now() });
  h.emitHeadTurn(SID, 'open', { lastEntryAt: AT });
  assert.ok(h.document.querySelector('.session-icon--busy'));
});

test('[628] learning background identity discards previously seeded descriptor idle hints', async t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const at = Date.now();
  const session = { sessionId: SID, status: 'idle', statusUpdatedAt: at + 1000, modified: new Date(at).toISOString() };
  h.window.sessionMap.set(SID, session);
  h.document.getElementById('sidebar-content').append(h.sidebar.buildSessionItem(session));
  h.emitHeadTurn(SID, 'open', { lastEntryAt: at });
  h.evalPublic('agents-view.js');
  h.window.applyAgentsSnapshot({ roster: roster('working', null), daemonReachable: true });
  h.window.applyStateClasses(SID, h.window.storedActivitySnapshot(SID));
  assert.ok(h.document.querySelector('.session-icon--busy'));
  assert.equal(h.window.agentRowIcon(roster('working', null)[0]).slotClass, 'session-icon--busy');
});

test('[628] an in-flight cron without a fan id stays static without counting an agent', async t => {
  const h = await setup(t, roster('working', null, { inFlight: { tasks: 1, kinds: ['session_cron'] } }));
  h.emitHeadTurn(SID, 'closed');
  assert.ok(h.document.querySelector('.session-icon--agents-busy'));
  assert.equal(h.window.taskRegistry.runningAgentCount([SID]), 0);
  assert.equal(h.document.querySelector('.session-subagent-count'), null);
});
