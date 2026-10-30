'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t, overrides = {}) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const w = h.window;
  const row = { sessionId: 'A', headSessionId: 'C', mergedMemberIds: ['B', 'C'],
    projectPath: '/project', summary: 'Conversation', modified: new Date().toISOString(), ...overrides };
  w.sessionMap.set('A', row);
  w.sessionMap.set('B', { ...row, sessionId: 'B', mergedMemberIds: [] });
  w.cachedProjects = [makeSampleProject({ projectPath: '/project', sessions: [row] })];
  w.cachedAllProjects = w.cachedProjects;
  const calls = [];
  Object.assign(w, { gridViewActive: true, refreshSidebar() {}, replayHiddenBuffer() {},
    terminalsEl: h.document.getElementById('terminals'), refreshAgentsRoster() {}, updateRunningIndicators() {} });
  w.appConfirm = async question => { calls.push(['confirm', JSON.parse(JSON.stringify(question))]); return true; };
  w.api.stopSession = async id => { calls.push(['stop', id]); return { ok: true }; };
  w.api.remoteStopSession = async (alias, id) => { calls.push(['remote', alias, id]); return { ok: true }; };
  w.api.bgAgentLiveJob = async () => ({ known: true, job: null });
  w.api.checkBgAgentVerb = async (...args) => { calls.push(['check', ...args]); return { ok: true }; };
  w.api.bgAgentVerb = async (...args) => { calls.push(['job', ...args]); return { ok: true }; };
  loadAppFunctions(h.context, { functions: ['confirmAndStopSession'] });
  const addTab = (id, options = {}) => {
    w.activePtyIds.add(id);
    w.openSessions.set(id, { session: { ...row, sessionId: id, mergedMemberIds: [] },
      closed: false, element: h.document.createElement('div'), terminal: { write() {} }, ...options });
  };
  const render = () => h.sidebar.renderProjects(w.cachedProjects, true);
  return { ...h, w, row, calls, addTab, render };
}

async function stopFrom(h, surface) {
  h.render();
  let pending;
  const stop = h.w.confirmAndStopSession;
  h.w.confirmAndStopSession = (...args) => (pending = stop(...args));
  if (surface === 'row') {
    h.document.querySelector('#si-A .session-stop-btn').onclick({ stopPropagation() {} });
  } else if (surface === 'card') {
    h.evalPublic('shortcuts.js');
    h.evalPublic('grid-view.js');
    h.w.wrapInGridCard('B');
    h.document.querySelector('.grid-card-stop-btn').click();
  } else {
    h.w.activeSessionId = 'B';
    h.w.terminalStopBtn = h.document.createElement('button');
    const filename = path.join(__dirname, '../public/app.js');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf("terminalStopBtn.addEventListener('click',");
    const end = source.indexOf('\n});', start) + '\n});'.length;
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end), h.context, { filename });
    h.w.terminalStopBtn.click();
  }
  assert.ok(pending, `${surface} must invoke the shared Stop executor`);
  await pending;
}

for (const surface of ['row', 'header', 'card']) {
  test(`${surface} Stop stops all live conversation parts including a background job`, async t => {
    const h = setup(t);
    h.addTab('A');
    h.addTab('B');
    h.w.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'C' ? { id: 'abcdef12' } : null });
    await stopFrom(h, surface);
    assert.deepEqual(h.calls.map(call => call[0]), ['check', 'confirm', 'stop', 'stop', 'job']);
    assert.deepEqual(h.calls.filter(call => call[0] === 'stop'), [['stop', 'A'], ['stop', 'B']]);
    assert.deepEqual(h.calls.at(-1), ['job', 'stop', 'abcdef12']);
    assert.match(h.calls[1][1].message, /Stop 3 parts/);
    assert.match(h.calls[1][1].message, /Part C: background job abcdef12; its process ends/);
    assert.equal(h.calls[1][1].danger, true);
  });

  test(`${surface} Stop retains live-elsewhere and unknown-job refusals in its confirmation`, async t => {
    const h = setup(t);
    h.addTab('B');
    h.w.storedActivitySnapshot = id => ({ liveness: id === 'A' ? 'alive' : 'dead' });
    h.w.api.bgAgentLiveJob = async id => id === 'C'
      ? { known: false, reason: 'ownership unreadable' } : { known: true, job: null };
    await stopFrom(h, surface);
    assert.match(h.calls[0][1].message, /Part A: a process outside this window keeps running/);
    assert.match(h.calls[0][1].message, /Part C: cannot tell whether a background job is running this part \(ownership unreadable\)/);
    assert.deepEqual(h.calls.filter(call => call[0] === 'stop'), [['stop', 'B']]);
  });

  test(`${surface} attached-member Stop keeps the root local and checks the member job`, async t => {
    const h = setup(t);
    h.addTab('A');
    h.addTab('B', { attach: true, attachJobId: 'abcdef12' });
    h.w.api.bgAgentLiveJob = async id => ({ known: true, job: id === 'B' ? { id: 'abcdef12' } : null });
    await stopFrom(h, surface);
    assert.deepEqual(h.calls.filter(call => call[0] === 'stop'), [['stop', 'A'], ['stop', 'B']]);
    assert.deepEqual(h.calls.filter(call => call[0] === 'job'), [['job', 'stop', 'abcdef12']]);
    assert.match(h.calls.find(call => call[0] === 'confirm')[1].message, /Stop 2 parts/);
  });

  test(`${surface} remote Stop uses the host route for every part`, async t => {
    const h = setup(t, { remoteAlias: 'vps', remoteAttachable: true, remoteDescriptorSeen: true });
    h.addTab('B');
    await stopFrom(h, surface);
    const question = h.calls.find(call => call[0] === 'confirm')[1];
    assert.match(question.message, /Stop 3 parts/);
    assert.deepEqual(h.calls.filter(call => call[0] === 'remote'),
      [['remote', 'vps', 'A'], ['remote', 'vps', 'B'], ['remote', 'vps', 'C']]);
  });

  test(`${surface} cancellation leaves all conversation processes running`, async t => {
    const h = setup(t);
    h.addTab('A');
    h.addTab('B');
    h.w.appConfirm = async question => { h.calls.push(['confirm', question]); return false; };
    await stopFrom(h, surface);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0][1].message, /Stop 2 parts/);
    assert.deepEqual([...h.w.activePtyIds], ['A', 'B']);
  });
}

test('opening a row with an older dormant member resumes its newest head', async t => {
  const h = setup(t);
  h.evalPublic('resume-guard.js');
  const opened = [];
  Object.assign(h.w, { sessionOpenedOutsideRestore: false, showSession() {}, schedulePersistWorkingSet() {},
    createTerminalEntry: () => ({ initialSize: {}, terminal: { write() {} } }),
    forgetSessionExit() {}, beginPtyOpen() {}, settlePtyOpen() {}, syncPtySizeAfterOpen() {},
    setSessionSandboxed() {}, resolveDefaultSessionOptions: async () => ({}) });
  h.w.api.getSessionContinuations = async () => ({ candidates: [], unresolved: false });
  h.w.api.getSessionLiveElsewhere = async () => null;
  h.w.api.getSessionsLiveElsewhere = async () => ({});
  h.w.api.openTerminal = async id => { opened.push(id); return { ok: true }; };
  loadAppFunctions(h.context, { functions: ['openSession', 'openSessionNow', 'indexedRowOf',
    'dormantRowIds', 'syncDormantRow', 'clearDormantRow'],
  declarations: ['openingSessions', 'restoreRunDepth', 'continuationRetryCancelled', 'dormantWorkingSet',
    'skippedWorkingSetEntries', 'restoreSavedIndex', 'restoreMode', 'restoreInFlight'] });
  h.read("dormantWorkingSet.set('B', { item: { sessionId: 'B' }, index: 0 })");
  h.render();
  h.document.getElementById('si-A').click();
  await Promise.all(h.read('[...openingSessions.values()].map(open => open.promise)'));
  assert.deepEqual(opened, ['C'], 'Open must resume the head C, never the older dormant B');
  assert.equal(h.read("dormantWorkingSet.has('B')"), false, 'opening the head clears dormant markers for the conversation');
});

test('Stop from the original part resolves its row before a stale re-keyed entry listing it', async t => {
  const h = setup(t);
  h.w.sessionMap.set('D', { ...h.row, sessionId: 'D', mergedMemberIds: ['B', 'A'] });
  h.addTab('A');
  h.addTab('C');
  await h.w.confirmAndStopSession('A');
  assert.deepEqual(h.calls.filter(call => call[0] === 'stop'), [['stop', 'A'], ['stop', 'C']]);
});
