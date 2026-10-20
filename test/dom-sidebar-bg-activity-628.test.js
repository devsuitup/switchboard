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
    jobs: new Map([['aaaaaaaa', job]]), descriptors: state === 'done' ? [] : [{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: SID,
      status: 'busy', statusUpdatedAt: 1, cwd: '/repo', pid: 10 }] });
}

async function setup(t, entries = roster(), active = false) {
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
  if (active) h.window.activePtyIds.add(SID);
  let sidebarRenders = 0;
  h.window.refreshSidebar = () => {
    sidebarRenders++;
    h.document.getElementById('sidebar-content').replaceChildren(h.sidebar.buildSessionItem(session));
  };
  h.window.initAgentsView();
  await Promise.resolve();
  await Promise.resolve();
  h.window.refreshSidebar();
  return { ...h, push: s => push(s), subscriptions: () => subscriptions, sidebarRenders: () => sidebarRenders };
}

for (const [state, kind, head, hosted, valid, text, activity, foreground = false] of [
  ['working', null, 'open', true, true, '', 'Working'],
  ['working', 'agent', 'closed', true, true, '', 'Background work running'],
  ['working', null, 'closed', true, true, '', 'Waiting for input'],
  ['blocked', null, 'closed', true, true, 'Blocked', 'Waiting for input'],
  ['blocked', null, 'closed', true, false, 'Blocked', 'Waiting for input'],
  ['done', null, 'closed', true, true, 'Idle', 'Waiting for input'],
  ['done', null, 'closed', false, true, 'Job done', 'Not running'],
  ['stopped', null, 'closed', false, true, 'Job stopped', 'Not running'],
  ['failed', null, 'closed', false, true, 'Job failed', 'Not running'],
  ['working', null, 'open', true, false, 'Activity unavailable', 'Working'],
  ['done', null, 'open', false, true, 'Working', 'Working', true],
  ['done', null, 'closed', false, true, 'Idle', 'Idle', true],
  ['failed', null, 'open', false, true, 'Working', 'Working', true],
  ['failed', null, 'closed', false, true, 'Idle', 'Idle', true],
]) {
  test(`[702] ${state}/${activity} (valid: ${valid}, foreground: ${foreground}) keeps the same concise status and icon detail on render and live update`, async t => {
    const entries = roster(state, kind);
    entries[0].hosted = hosted;
    entries[0].taskEvidence.valid = valid;
    const h = await setup(t, entries, foreground);
    h.emitHeadTurn(SID, head);
    h.window.refreshSidebar();
    const check = () => {
      const row = h.document.querySelector('.session-item');
      const status = row.querySelector('.session-status');
      const icon = row.querySelector('.session-icon');
      assert.equal(status.textContent, text);
      assert.equal(status.title, '');
      const source = valid ? `Job updated ${new Date(AT).toLocaleString()} (job metadata)` : 'Job activity unavailable';
      assert.equal(icon.title, foreground ? activity : `${activity} · job ${state}\n${source}`);
      assert.equal(icon.getAttribute('aria-label'), foreground ? activity : activity + (text ? ` · ${text}` : ''));
    };
    check();
    h.window.applyStateClasses(SID, h.window.storedActivitySnapshot(SID));
    check();
    h.window.paintSessionIcon(h.document.querySelector('.session-icon'), SID);
    check();
  });
}

test('[702] live updates replace the working tooltip and clear a previous exceptional status', async t => {
  const h = await setup(t, roster('blocked', null));
  assert.equal(h.document.querySelector('.session-status').textContent, 'Blocked');
  h.push({ roster: roster('working', 'agent', { updatedAt: new Date(AT + 1).toISOString() }), daemonReachable: true });
  h.emitHeadTurn(SID, 'closed');
  assert.equal(h.document.querySelector('.session-status').textContent, '');
  const icon = h.document.querySelector('.session-icon');
  assert.match(icon.title, /^Background work running · job working/);
  h.emitHeadTurn(SID, 'open', { revision: 2 });
  assert.match(icon.title, /^Working · job working/);
  assert.doesNotMatch(icon.title, /Blocked|Needs your attention|Background work running/);
  assert.equal(icon.getAttribute('aria-label'), 'Working');
});

test('[702] missing job metadata retains known head activity in the icon tooltip', async t => {
  const h = await setup(t, []);
  h.emitHeadTurn(SID, 'open');
  const check = () => {
    const icon = h.document.querySelector('.session-icon');
    assert.equal(h.document.querySelector('.session-status').textContent, 'Activity unavailable');
    assert.equal(icon.title, 'Working\nJob activity unavailable');
    assert.equal(icon.getAttribute('aria-label'), 'Working · Activity unavailable');
  };
  check();
  h.window.refreshSidebar();
  check();
  h.window.paintSessionIcon(h.document.querySelector('.session-icon'), SID);
  check();
});

for (const valid of [true, false]) {
  test(`[702b] a working job keeps Needs attention on render and live update until attention clears (valid: ${valid})`, async t => {
    const entries = roster('working', null);
    entries[0].taskEvidence.valid = valid;
    const h = await setup(t, entries, true);
    h.emitHeadTurn(SID, 'open');
    h.window.setAttention(SID, true, 'onTerminalNotification');
    const check = () => {
      const row = h.document.querySelector('.session-item');
      const icon = row.querySelector('.session-icon');
      assert.equal(row.querySelector('.session-status').textContent, 'Needs attention');
      assert.ok(icon.classList.contains('session-icon--attention'));
      if (valid) assert.match(icon.title, /^Needs your attention · job working\nJob updated /);
      else assert.equal(icon.title, 'Needs your attention · job working\nJob activity unavailable');
      assert.equal(icon.getAttribute('aria-label'), 'Needs your attention · Needs attention');
    };
    check();
    h.window.refreshSidebar();
    check();
    h.window.applyStateClasses(SID, h.window.storedActivitySnapshot(SID));
    check();
    h.window.paintSessionIcon(h.document.querySelector('.session-icon'), SID);
    check();
    h.window.setAttention(SID, false, 'onTerminalNotification');
    assert.equal(h.document.querySelector('.session-status').textContent, valid ? '' : 'Activity unavailable');
    assert.equal(h.document.querySelector('.session-icon').getAttribute('aria-label'), valid ? 'Working' : 'Working · Activity unavailable');
    h.window.activeSessionId = SID;
    h.emitHeadTurn(SID, 'closed', { revision: 2 });
    assert.equal(h.document.querySelector('.session-status').textContent, valid ? '' : 'Activity unavailable');
    assert.equal(h.document.querySelector('.session-icon').getAttribute('aria-label'), valid ? 'Waiting for input' : 'Waiting for input · Activity unavailable');
  });
}

test('[702b] remote attention owns the icon title when it overrides local background activity', async t => {
  const h = await setup(t, roster('working', null));
  h.emitHeadTurn(SID, 'open');
  const remote = h.window.createSessionState('remote-ssh');
  remote.apply({ type: 'liveness', value: 'alive' });
  remote.apply({ type: 'attention', active: true });
  h.remoteSessionStates.set(SID, remote);
  h.window.refreshSidebar();
  const icon = h.document.querySelector('.session-icon');
  assert.ok(icon.classList.contains('session-icon--attention'));
  assert.equal(icon.title, 'Needs your attention');
  assert.equal(icon.getAttribute('aria-label'), 'Needs your attention');
});

for (const [state, kind, head, slot, label] of [
  ['working', null, 'closed', 'idle', 'Idle'],
  ['blocked', null, 'closed', 'waiting', 'Waiting for input'],
  ['working', 'agent', 'closed', 'agents-busy', 'Background work running'],
  ['working', 'agent', 'open', 'busy', 'Working'],
]) {
  for (const surface of ['sidebar', 'Agents']) {
    test(`[628c] attached ${state} job with ${kind || 'no task'} and ${head} head keeps job activity in ${surface}`, async t => {
      const entries = roster(state, kind);
      const oldStatusAt = Date.now() - 3_600_000;
      Object.assign(entries[0], { attachedHere: true, status: 'busy', statusUpdatedAt: oldStatusAt });
      const h = await setup(t, entries, true);
      h.window.sessionMap.get(SID).statusUpdatedAt = oldStatusAt;
      h.emitHeadTurn(SID, head);
      if (surface === 'sidebar') {
        const check = () => {
          const row = h.document.querySelector('.session-item');
          assert.equal(row.querySelectorAll('.session-icon').length, 1);
          assert.ok(row.querySelector(`.session-icon--${slot}`), row.innerHTML);
          const status = row.querySelector('.session-status');
          assert.equal(status.textContent, state === 'blocked' ? 'Blocked' : '');
          assert.doesNotMatch(status.textContent, /busy|idle|ago|\d+[smhd]/i);
          assert.equal(status.title, '');
          assert.equal(row.querySelector('.session-icon').title,
            `${label} · job ${state}\nJob updated ${new Date(AT).toLocaleString()} (job metadata)`);
        };
        check();
        h.window.refreshSidebar();
        check();
      } else {
        const row = h.document.createElement('div');
        row.innerHTML = h.window.renderAgentRow(entries[0]);
        assert.equal(row.querySelectorAll('.session-icon').length, 1);
        const icon = row.querySelector(`.session-icon--${slot}`);
        assert.ok(icon, row.innerHTML);
        assert.equal(icon.title, state === 'blocked'
          ? h.document.querySelector('.session-item .session-icon').title : label);
        if (state === 'blocked') assert.equal(icon.dataset.glyph, '○');
        const status = row.querySelector('.agents-row-state');
        assert.match(status.textContent, new RegExp(state === 'working' ? 'Active' : 'Blocked'));
        assert.doesNotMatch(status.textContent, /busy|idle|ago|\d+[smhd]/i);
      }
    });
  }
}

for (const state of ['done', 'stopped', 'failed']) {
  for (const surface of ['sidebar', 'Agents']) {
    for (const own of [false, true]) {
      test(`[654] attached tab survives ${state} with the final job state in ${surface} (own descriptor: ${own})`, async t => {
        const entries = roster('working', null);
        entries[0].attachedHere = true;
        const h = await setup(t, entries, true);
        h.window.openSessions.set(SID, { session: { sessionId: SID }, attach: true });
        h.window.sessionMap.get(SID).statusUpdatedAt = Date.now() - 3_600_000;
        h.emitHeadTurn(SID, 'closed');
        const finished = roster(state, null);
        Object.assign(finished[0], { attachedHere: true, conversationOwn: own,
          status: 'busy', statusUpdatedAt: Date.now() - 3_600_000 });
        h.push({ roster: finished, daemonReachable: true });
        const check = () => {
          const row = surface === 'sidebar' ? h.document.querySelector('.session-item') : h.document.createElement('div');
          if (surface === 'Agents') row.innerHTML = h.window.renderAgentRow(finished[0]);
          const status = row.querySelector(surface === 'sidebar' ? '.session-status' : '.agents-row-state');
          if (surface === 'sidebar') assert.equal(status.textContent, `Job ${state}`);
          assert.doesNotMatch(status.textContent, /busy|idle|ago|\d+\s*[smhd]/i);
          assert.doesNotMatch(status.title, /ago|\d+\s*[smhd]\b/i);
          assert.equal(row.querySelectorAll('.session-icon').length, 1);
          assert.ok(row.querySelector('.session-icon--stale'), row.innerHTML);
          assert.equal(row.querySelector('.session-icon--waiting'), null);
          assert.ok(h.window.activePtyIds.has(SID));
          if (surface === 'Agents') {
            assert.match(status.textContent, new RegExp(state, 'i'));
            assert.equal(row.querySelector('.agents-row-age').textContent, '');
          }
        };
        check();
        h.emitHeadTurn(SID, 'closed', { revision: 2 });
        check();
        h.window.refreshSidebar();
        check();
      });
    }
  }
}

for (const active of [false, true]) {
  test(`[654] background identity without a roster never displays descriptor status or age (PTY: ${active})`, async t => {
    const h = await setup(t, [], active);
    h.window.sessionMap.get(SID).statusUpdatedAt = Date.now() - 3_600_000;
    h.window.refreshSidebar();
    const check = () => {
      const status = h.document.querySelector('.session-status');
      assert.equal(status.textContent, 'Activity unavailable');
      assert.equal(status.title, '');
      assert.match(h.document.querySelector('.session-icon').title, /Job activity unavailable/);
    };
    check();
    h.emitHeadTurn(SID, 'open');
    check();
    h.window.refreshSidebar();
    check();
  });
}

test('[654] a merged background row without a roster ignores its head descriptor on incremental updates', async t => {
  const h = await setup(t, [], true);
  const session = h.window.sessionMap.get(SID);
  const head = 'bbbbbbbb-1234-4321-abcd-123456789abc';
  Object.assign(session, { headSessionId: head, mergedMemberIds: [head],
    mergedMemberStatuses: { [head]: { status: 'busy', statusUpdatedAt: Date.now() - 3_600_000 } } });
  h.window.activePtyIds.add(head);
  h.window.refreshSidebar();
  const check = () => {
    const status = h.document.querySelector('.session-status');
    assert.equal(status.textContent, 'Activity unavailable');
    assert.equal(status.title, '');
    assert.match(h.document.querySelector('.session-icon').title, /Job activity unavailable/);
  };
  check();
  h.emitHeadTurn(head, 'open');
  check();
  h.window.refreshSidebar();
  check();
});

test('[654] foreground activity ignores a retained background descriptor even with roster-only identity', async t => {
  const entries = roster('done');
  entries[0].conversationOwn = true;
  const h = await setup(t, entries, true);
  const session = h.window.sessionMap.get(SID);
  delete session.bgJobId;
  session.status = 'idle';
  session.statusUpdatedAt = Date.now() - 3_600_000;
  h.emitHeadTurn(SID, 'open');
  const check = () => {
    const row = h.document.querySelector('.session-item');
    assert.ok(row.querySelector('.session-icon--busy'));
    assert.equal(row.querySelector('.session-status').textContent, 'Working');
    assert.equal(row.querySelector('.session-status').title, '');
  };
  check();
  h.window.refreshSidebar();
  check();
});

for (const state of ['done', 'stopped', 'failed']) {
  for (const own of [false, true]) {
    test(`[628b] a ${state} job cannot override a resumed local PTY (own descriptor: ${own})`, async t => {
      const entries = mergeRoster({ cli: null, jobs: new Map([['aaaaaaaa', parseJobState(JSON.stringify({
        state, sessionId: SID, updatedAt: new Date(AT).toISOString(), fan: [],
        inFlight: { tasks: 0, kinds: [] },
      }))]]), descriptors: own ? [{ kind: 'interactive', sessionId: SID, pid: 42, status: 'busy' }] : [],
      isOwnPid: pid => pid === 42 });
      if (own) assert.equal(entries[0].conversationOwn, true);
      const h = await setup(t, entries, true);
      h.window.openSessions.set(SID, { session: { sessionId: SID }, attach: false });
      h.emitHeadTurn(SID, 'closed');
      assert.equal(h.document.querySelector('.session-status').textContent, 'Idle');
      assert.ok(h.document.querySelector('.session-icon--idle'));
      assert.equal(h.window.agentRowIcon(entries[0]).slotClass, 'session-icon--idle');
      h.emitHeadTurn(SID, 'open', { revision: 2 });
      h.window.refreshSidebar();
      const row = h.document.querySelector('.session-item');
      assert.ok(row.querySelector('.session-icon--busy'), row.innerHTML);
      assert.ok(row.classList.contains('is-alive'));
      assert.equal(row.querySelector('.session-status').textContent, 'Working');
      assert.doesNotMatch(row.querySelector('.session-status').textContent, /job|unavailable/i);
      const agentIcon = h.window.agentRowIcon(entries[0]);
      assert.equal(agentIcon.slotClass, 'session-icon--busy');
      assert.equal(agentIcon.live, true);
    });
  }
}

test('[628b] a finished job held by our process leaves the conversation projection unchanged without a PTY id', async t => {
  const entries = roster('done');
  entries[0].conversationOwn = true;
  const h = await setup(t, entries);
  h.emitHeadTurn(SID, 'open');
  const snapshot = { headTurn: 'open', liveness: 'alive', busy: true };
  assert.deepEqual(h.window.backgroundActivitySnapshot(SID, snapshot), snapshot);
  assert.equal(h.window.backgroundActivityLabel(SID, snapshot).text, 'Working');
  assert.equal(h.document.querySelector('.session-status').textContent, 'Working');
  const agentIcon = h.window.agentRowIcon(entries[0]);
  assert.equal(agentIcon.slotClass, 'session-icon--busy');
  assert.equal(agentIcon.live, true);
});

test('[628b] resuming a finished conversation restores its status on an incremental head update', async t => {
  const h = await setup(t, roster('done'));
  assert.equal(h.document.querySelector('.session-status').textContent, 'Job done');
  h.window.activePtyIds.add(SID);
  h.emitHeadTurn(SID, 'open');
  const row = h.document.querySelector('.session-item');
  assert.ok(row.querySelector('.session-icon--busy'));
  assert.ok(row.classList.contains('is-alive'));
  assert.equal(row.querySelector('.session-status').textContent, 'Working');
  assert.equal(row.querySelector('.session-status').title, '');
});

test('[628b] metadata-only pushes avoid sidebar rebuilds while activity changes still repaint', async t => {
  const h = await setup(t);
  const before = h.sidebarRenders();
  const entries = roster();
  Object.assign(entries[0], { tokens: 500, tempo: 'fast', detail: 'updated', fan: [{ id: 'display-only' }] });
  h.push({ roster: entries, daemonReachable: true });
  assert.equal(h.sidebarRenders(), before);
  h.push({ roster: roster('blocked'), daemonReachable: true });
  assert.equal(h.sidebarRenders(), before + 1);
  assert.ok(h.document.querySelector('.session-icon--waiting'));
  h.push({ roster: [], daemonReachable: true });
  assert.equal(h.sidebarRenders(), before + 2);
});

for (const state of ['done', 'stopped', 'failed']) {
  test(`[628b] ${state} labels name the lifecycle once and show local job time`, async t => {
    const h = await setup(t, roster(state));
    const secondary = h.document.querySelector('.session-status');
    assert.equal(secondary.textContent, `Job ${state}`);
    assert.equal(secondary.title, '');
    assert.equal(h.document.querySelector('.session-icon').title,
      `Not running · job ${state}\nJob updated ${new Date(AT).toLocaleString()} (job metadata)`);
  });
}

for (const [state, kind, head, slot, count] of [
  ['working', 'agent', 'closed', 'agents-busy', 1],
  ['working', 'cron', 'closed', 'agents-busy', 0],
  ['working', 'bash', 'closed', 'agents-busy', 0],
  ['working', 'monitor', 'closed', 'agents-busy', 0],
  ['working', 'agent', 'open', 'busy', 1],
  ['blocked', 'agent', 'open', 'waiting', 1],
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
    assert.equal(secondary.title, '');
    assert.match(row.querySelector('.session-icon').title, /job|unavailable/i);
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
  assert.ok(row.querySelector('.session-icon--waiting'));
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
  assert.equal(h.document.querySelector('.session-status').textContent, '');
  assert.match(h.document.querySelector('.session-icon').title, /Working · job working/);
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

test('hosted done with conversation ownership cannot revive foreground head activity', async t => {
  const entries = roster('done', null);
  Object.assign(entries[0], { hosted: true, conversationOwn: true });
  const h = await setup(t, entries);
  h.emitHeadTurn(SID, 'open');
  assert.equal(h.window.backgroundActivityIsForeground(SID), false);
  const snapshot = h.window.backgroundActivitySnapshot(SID, { headTurn: 'open', liveness: 'alive', busy: true });
  assert.equal(snapshot.headTurn, 'closed');
  assert.equal(snapshot.busy, false);
  assert.ok(h.document.querySelector('.session-icon--waiting'));
  assert.equal(h.window.agentRowIcon(entries[0]).slotClass, 'session-icon--waiting');
});

for (const hosted of [true, false]) {
  test(`done hosted=${hosted} shows ${hosted ? 'Idle' : 'Done'} in sidebar and Agents`, async t => {
    const entries = roster('done', null);
    entries[0].hosted = hosted;
    const h = await setup(t, entries);
    assert.equal(h.document.querySelector('.session-status').textContent, hosted ? 'Idle' : 'Job done');
    const row = h.document.createElement('div');
    row.innerHTML = h.window.renderAgentRow(entries[0]);
    assert.equal(row.querySelector('.agents-row-state').textContent.trim().split(/\s+/).at(-1), hosted ? 'Idle' : 'Done');
  });
}

test('[628] an in-flight cron without a fan id stays static without counting an agent', async t => {
  const h = await setup(t, roster('working', null, { inFlight: { tasks: 1, kinds: ['session_cron'] } }));
  h.emitHeadTurn(SID, 'closed');
  assert.ok(h.document.querySelector('.session-icon--agents-busy'));
  assert.equal(h.window.taskRegistry.runningAgentCount([SID]), 0);
  assert.equal(h.document.querySelector('.session-subagent-count'), null);
});
