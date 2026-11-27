'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setupSidebarDom, answerChoiceDialog } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t) {
  const h = setupSidebarDom();
  t.after(h.destroy);
  const w = h.window;
  Object.assign(w, {
    loadProjects: async () => {}, pollActiveSessions() {}, schedulePersistWorkingSet() {},
    setActiveSession(id) { w.activeSessionId = id; }, pendingSessions: new Map(),
    terminalHeaderId: w.document.createElement('span'), terminalHeaderName: w.document.createElement('span'),
  });
  const { rekeySessionTab } = loadAppFunctions(h.context, {
    declarations: ['lastActivityTime', 'sandboxedSessions', 'ptyGenerations', 'pendingOpens', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'openingSessions'],
    functions: ['rekeySessionTab', 'rekeySessionEnvironment'],
  });
  return { ...h, w, rekeySessionTab };
}

test('GIVEN an archive awaiting confirmation WHEN the session is re-keyed and the archive is cancelled THEN the original transcript can be archived again', async t => {
  const { w, context, rekeySessionTab } = fixture(t);
  const session = { sessionId: 'old', name: 'Review session', projectPath: '/repo', folder: '-repo', modified: new Date().toISOString(), archived: 0, messageCount: 1 };
  w.sessionMap.set('old', session);
  w.openSessions.set('old', { session });
  w.activeSessionId = 'elsewhere';
  w.renderProjects([{ projectPath: '/repo', folder: '-repo', sessions: [session] }]);
  const confirmation = deferred();
  const asked = deferred();
  w.planSessionArchive = async () => ({ ok: true, plans: [{ session, plan: { targets: [{ sessionId: 'old', attach: false }], confirmParts: [] } }] });
  w.appConfirm = () => { asked.resolve(); return confirmation.promise; };

  const archiving = w.document.querySelector('.session-archive-btn').onclick({ stopPropagation() {} });
  assert.equal(vm.runInContext("archivingSessionIds.has('old')", context), true);
  await asked.promise;
  rekeySessionTab('old', 'new', 'fork', null, () => {});
  confirmation.resolve(false);
  await archiving;

  const original = { ...session, sessionId: 'old' };
  w.sessionMap.set('old', original);
  w.renderProjects([{ projectPath: '/repo', folder: '-repo', sessions: [original, session] }]);
  assert.equal(w.document.querySelector('[data-session-id=old] .session-archive-btn').disabled, false);
  assert.equal(vm.runInContext("archivingSessionIds.has('old')", context), false);
});

test('GIVEN a project archive stopping a session WHEN the session is re-keyed during the stop THEN the original transcript can be archived again', async t => {
  const { w, context, document, sidebar, rekeySessionTab } = fixture(t);
  const session = { sessionId: 'old', name: 'Review session', summary: 'Review session', projectPath: '/repo', modified: new Date().toISOString(), archived: 0 };
  const project = { projectPath: '/repo', sessions: [session] };
  const stopping = deferred();
  const stopped = deferred();
  w.api = new Proxy({}, {
    get: (_target, method) => method === 'stopSession'
      ? () => { stopping.resolve(); return stopped.promise; }
      : () => Promise.resolve(method === 'getProjectArchivePlan' ? { schedules: [] } : { ok: true }),
  });
  w.sessionMap.set('old', session);
  w.openSessions.set('old', { session });
  w.activePtyIds.add('old');
  w.activeSessionId = 'elsewhere';
  w.cachedAllProjects = [project];
  sidebar.renderProjects([project], true);

  const archiving = document.getElementById('ph-' + sidebar.folderId('/repo')).querySelector('.project-archive-btn').onclick(new w.MouseEvent('click'));
  await answerChoiceDialog({ document }, { confirm: true });
  await stopping.promise;
  assert.equal(vm.runInContext("archivingSessionIds.has('old')", context), true);
  rekeySessionTab('old', 'new', 'fork', null, () => {});
  stopped.resolve({ ok: true });
  await archiving;

  const original = { ...session, sessionId: 'old', archived: 0 };
  w.sessionMap.set('old', original);
  sidebar.renderProjects([{ projectPath: '/repo', sessions: [original] }], true);
  assert.equal(document.querySelector('[data-session-id=old] .session-archive-btn').disabled, false);
  assert.equal(vm.runInContext("archivingSessionIds.has('old')", context), false);
});
