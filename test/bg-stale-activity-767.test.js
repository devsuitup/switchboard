'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { parseJobState, mergeRoster } = require('../src/main/bg-agents/bg-agents-roster');

const SID = 'aaaaaaaa-1234-4321-abcd-123456789abc';
const JOB = 'abcdef01';
const AT = Date.now() - 10_000;

for (const state of ['working', 'blocked']) {
  for (const route of ['marker', 'identity', 'unique-head']) {
    for (const owned of [false, true]) {
      test(`[767] ${state} ${route} interactive ${owned ? 'owned-PTY' : 'outside-terminal'} keeps normal activity`, t => {
        const h = setupSidebarDom();
        t.after(() => h.destroy());
        h.window.Date.now = () => AT + 10_000;
        const descriptor = { kind: 'interactive', sessionId: SID.toUpperCase(), pid: 12345,
          cwd: '/repo', status: 'waiting', statusUpdatedAt: AT };
        const job = parseJobState(JSON.stringify({ state, sessionId: SID, updatedAt: new Date(AT).toISOString(),
          inFlight: { tasks: 1, kinds: ['agent'] }, fan: [{ id: 'stale-agent', kind: 'agent', startedAt: AT }] }));
        const roster = mergeRoster({ cli: [], jobs: new Map([[JOB, job]]), descriptors: [descriptor], isOwnPid: () => owned });
        assert.equal(roster.find(e => e.id === JOB).hosted, false);
        const row = { sessionId: SID, projectPath: descriptor.cwd, status: descriptor.status,
          statusUpdatedAt: AT, waitingFor: 'Choose a branch', summary: 'Interactive conversation',
          ...(route === 'marker' ? { bgJobId: JOB, bgSessionId: SID } : {}),
          ...(route === 'identity' ? { identityJobId: JOB, identitySessionId: SID } : {}) };
        h.window.sessionMap.set(SID, row);
        if (owned) {
          h.window.activePtyIds.add(SID);
          h.window.openSessions.set(SID, { session: row, attach: false });
          h.window.setActivity(SID, true, 'test');
          h.emitHeadTurn(SID, 'open');
        }
        const render = (session = row) => {
          const item = h.sidebar.buildSessionItem(session);
          h.document.getElementById('sidebar-content').replaceChildren(item);
          return item;
        };
        const before = render({ ...row, bgJobId: undefined, bgSessionId: undefined });
        const expectedTitle = owned ? 'Working · Open here' : before.querySelector('.session-icon').title;
        const expectedStatus = owned ? 'Working' : before.querySelector('.session-status').textContent;
        assert.match(expectedTitle, owned ? /^Working · Open here/ : /Running elsewhere\nCLI status: waiting · Choose a branch/);
        h.evalPublic('agents-view.js');
        h.window.applyAgentsSnapshot({ roster, daemonReachable: true });
        const check = item => {
          assert.equal(item.querySelector('.session-icon').title, expectedTitle, 'stale job must not replace interactive activity');
          assert.equal(item.querySelector('.session-status').textContent, expectedStatus);
          assert.equal(!!item.querySelector('.bg-badge'), route === 'marker');
          const snapshot = h.window.storedActivitySnapshot(SID, row);
          assert.equal(snapshot.liveness, 'alive');
          if (!owned) assert.equal(h.window.backgroundActivityLabel(SID, snapshot, row), null);
        };
        const item = render();
        check(item);
        h.window.applyStateClasses(SID, h.window.storedActivitySnapshot(SID, row));
        check(item);
        h.window.paintSessionIcon(item.querySelector('.session-icon'), SID);
        check(item);
        if (!owned) assert.equal(h.window.selectBackgroundActivity(SID, row).entry, null, 'interactive session does not select stale job tasks');
      });
    }
  }
}

for (const owned of [true, false]) {
  for (const state of ['working', 'blocked']) {
    test(`[767] a waiting interactive session newer than its transcript keeps attention beside a stale ${state} job (${owned ? 'owned-PTY' : 'outside-terminal'}) (#1246)`, t => {
      const h = setupSidebarDom();
      t.after(() => h.destroy());
      const row = { sessionId: SID, projectPath: '/repo', status: 'waiting', statusUpdatedAt: AT,
        waitingFor: 'Choose a branch', summary: 'Interactive question' };
      h.window.sessionMap.set(SID, row);
      h.window.activeSessionId = 'other';
      if (owned) {
        h.window.activePtyIds.add(SID);
        h.window.openSessions.set(SID, { session: row, attach: false });
      }
      const render = () => h.sidebar.renderProjects([makeSampleProject({ projectPath: '/repo', sessions: [row] })], true);
      h.emitHeadTurn(SID, 'open', { revision: 1, lastEntryAt: AT - 1000 });
      if (!owned) h.emitSessionTranscriptActivity({ sessionId: SID, at: AT - 1000 });
      render();
      const attention = () => h.document.getElementById(`si-${SID}`).querySelector('.session-icon').classList.contains('session-icon--attention');
      assert.equal(attention(), true, 'precondition: the waiting descriptor raised attention');
      const descriptor = { kind: 'interactive', sessionId: SID, pid: 12345, cwd: '/repo', status: 'waiting', statusUpdatedAt: AT };
      const job = parseJobState(JSON.stringify({ state, sessionId: SID, updatedAt: new Date(AT - 2000).toISOString() }));
      const roster = mergeRoster({ cli: [], jobs: new Map([[JOB, job]]), descriptors: [descriptor], isOwnPid: () => owned });
      assert.equal(roster.find(e => e.id === JOB).hosted, false);
      Object.assign(row, { bgJobId: JOB, bgSessionId: SID });
      h.evalPublic('agents-view.js');
      h.window.applyAgentsSnapshot({ roster, daemonReachable: true });
      const selected = h.window.selectBackgroundActivity(SID, row);
      if (owned) {
        assert.ok(selected.entry, 'an owned PTY keeps the stale entry selected');
        assert.equal(h.window.backgroundActivityIsForeground(SID, row, selected), true, 'the projection leaves the row foreground');
      } else assert.equal(selected.entry, null, 'outside the terminal the stale entry is not selected');
      for (let i = 0; i < 3; i++) render();
      assert.equal(attention(), true, 'a stale unhosted job must not clear a foreground question');
    });
  }
}

for (const owned of [true, false]) {
  test(`[767] a hosted waiting job keeps attention through every refresh (${owned ? 'owned-PTY' : 'outside-terminal'}) (#1246)`, t => {
    const h = setupSidebarDom();
    t.after(() => h.destroy());
    const id = 'hosted-wait';
    const row = { sessionId: id, status: 'waiting', statusUpdatedAt: 2000 };
    h.window.sessionMap.set(id, row);
    h.window.activeSessionId = 'other';
    if (owned) h.window.activePtyIds.add(id);
    const render = () => h.sidebar.renderProjects([makeSampleProject({ sessions: [row] })], true);
    h.emitHeadTurn(id, 'open', { revision: 1, lastEntryAt: 1000 });
    if (!owned) h.emitSessionTranscriptActivity({ sessionId: id, at: 1000 });
    render();
    h.evalPublic('agents-view.js');
    Object.assign(row, { bgJobId: 'wait-job', bgSessionId: id });
    const roster = [{ id: 'wait-job', sessionId: id, kind: 'background', state: 'blocked', hosted: true, status: 'waiting' }];
    for (let i = 0; i < 5; i++) {
      h.window.applyAgentsSnapshot({ roster, daemonReachable: true });
      assert.equal(h.window.storedActivitySnapshot(id, row).attention, true);
      render();
      assert.equal(h.document.getElementById(`si-${id}`).querySelector('.session-icon').classList.contains('session-icon--attention'), true);
    }
  });
}
