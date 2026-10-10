// see .ai/contexts/session-state.md ("Opening a session once")

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const PROJECT = '/home/dev/proj';

function setup() {
  const ctx = setupSidebarDom();
  const { window } = ctx;
  const openTerminalCalls = [];
  const releases = [];
  Object.assign(window, {
    restoringWorkingSet: false,
    sessionOpenedOutsideRestore: false,
    skippedWorkingSetEntries: new Map(),
    restoreSavedIndex: new Map(),
    refreshSidebar: () => window.renderProjects(window.cachedProjects, true),
    createTerminalEntry: (session) => {
      const entry = { session, closed: false, terminal: { write() {}, focus() {} }, initialSize: {} };
      window.openSessions.set(session.sessionId, entry);
      return entry;
    },
    showSession: () => {},
    destroySession: (id) => { window.openSessions.delete(id); },
    guardResume: async () => true,
    resolveResumeSession: async (session) => session,
    resolveDefaultSessionOptions: async () => ({}),
    syncPtySizeAfterOpen: () => {},
    setSessionMcpState: () => {},
    setSessionSandboxed: () => {},
    forgetSessionExit: () => {},
    beginPtyOpen: () => {},
    settlePtyOpen: () => {},
    schedulePersistWorkingSet: () => {},
    pollActiveSessions: () => {},
  });
  Object.assign(window.api, {
    openTerminal: (sessionId) => {
      openTerminalCalls.push(sessionId);
      return new Promise((resolve, reject) => releases.push({ resolve, reject }));
    },
  });
  const project = {
    projectPath: PROJECT,
    sessions: [
      { sessionId: 's1', name: 's1', modified: new Date().toISOString(), messageCount: 1 },
      { sessionId: 's2', name: 's2', modified: new Date().toISOString(), messageCount: 1 },
    ],
  };
  window.cachedProjects = [project];
  window.cachedAllProjects = [project];
  window.sessionMap.set('s1', { sessionId: 's1', projectPath: PROJECT });
  window.sessionMap.set('s2', { sessionId: 's2', projectPath: PROJECT });
  loadAppFunctions(ctx.context, {
    declarations: ['continuationRetryCancelled', 'openingSessions'],
    functions: ['openSession', 'openSessionNow'],
  });
  window.renderProjects(window.cachedProjects, true);
  const row = () => window.document.getElementById('si-s1');
  const release = (result = { ok: true }) => releases.splice(0).forEach((r) => r.resolve(result));
  const fail = (err) => releases.splice(0).forEach((r) => r.reject(err));
  return { window, row, openSession: (...args) => window.openSession(...args), openTerminalCalls, release, fail, destroy: () => ctx.destroy() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a double click on a session row opens its terminal once', async () => {
  const h = setup();
  try {
    h.row().click();
    h.row().click();
    await settle();
    h.release();
    await settle();
    assert.deepEqual(h.openTerminalCalls, ['s1']);
  } finally { h.destroy(); }
});

test('a click after the open has finished shows the session without opening it again', async () => {
  const h = setup();
  try {
    h.row().click();
    await settle();
    h.release();
    await settle();
    h.row().click();
    await settle();
    assert.deepEqual(h.openTerminalCalls, ['s1']);
  } finally { h.destroy(); }
});

test('a second open of the same session while the first runs gets the first one\'s result', async () => {
  const h = setup();
  try {
    h.window.guardResume = async () => false;
    const first = h.openSession(h.window.sessionMap.get('s1'));
    const second = h.openSession(h.window.sessionMap.get('s1'));
    assert.equal(await first, false);
    assert.equal(await second, false, 'a caller reading the result sees the refusal, not undefined');
    assert.deepEqual(h.openTerminalCalls, []);
  } finally { h.destroy(); }
});

test('once an open has failed, the session can be opened again', async () => {
  const h = setup();
  try {
    h.window.guardResume = async () => false;
    assert.equal(await h.openSession(h.window.sessionMap.get('s1')), false);
    h.window.guardResume = async () => true;
    const opening = h.openSession(h.window.sessionMap.get('s1'));
    await settle();
    h.release();
    await opening;
    assert.deepEqual(h.openTerminalCalls, ['s1']);
  } finally { h.destroy(); }
});

test('a click while an automatic open of a session live elsewhere is in flight asks, and opens it', async () => {
  const h = setup();
  try {
    h.window.guardResume = require('../public/resume-guard').guardResume;
    const lookups = [];
    h.window.api.getSessionLiveElsewhere = () => new Promise((resolve) => lookups.push(resolve));
    const confirms = [];
    h.window.confirm = (msg) => { confirms.push(msg); return true; };
    const automatic = h.openSession(h.window.sessionMap.get('s1'), undefined, { automatic: true });
    h.row().click();
    assert.equal(h.window.eval('continuationRetryCancelled'), true, 'the click cancels held retries at once');
    await settle();
    lookups.splice(0).forEach((r) => r({ pid: 42 }));
    assert.equal(await automatic, false, 'the automatic open still refuses');
    await settle();
    lookups.splice(0).forEach((r) => r({ pid: 42 }));
    await settle();
    h.release();
    await settle();
    assert.equal(confirms.length, 1, 'the click asks');
    assert.deepEqual(h.openTerminalCalls, ['s1']);
  } finally { h.destroy(); }
});

test('a double click on the row of a session live elsewhere asks once', async () => {
  const h = setup();
  try {
    h.window.guardResume = require('../public/resume-guard').guardResume;
    h.window.api.getSessionLiveElsewhere = async () => ({ pid: 42 });
    let confirms = 0;
    h.window.confirm = () => { confirms++; return false; };
    h.row().click();
    h.row().click();
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(confirms, 1);
    assert.deepEqual(h.openTerminalCalls, []);
  } finally { h.destroy(); }
});

test('a click while an automatic open runs waits for it and starts no second terminal', async () => {
  const h = setup();
  try {
    const automatic = h.openSession(h.window.sessionMap.get('s1'), undefined, { automatic: true });
    h.row().click();
    for (let i = 0; i < 3; i++) { await settle(); h.release(); }
    await automatic;
    await settle();
    assert.deepEqual(h.openTerminalCalls, ['s1']);
  } finally { h.destroy(); }
});

test('a click that resolves to a continuation already being opened opens it once', async () => {
  for (const clickFirst of [false, true]) {
    const h = setup();
    try {
      const guards = [];
      h.window.guardResume = () => new Promise((resolve) => guards.push(resolve));
      h.window.resolveResumeSession = async (session) => (session.sessionId === 's1' ? { ...session, sessionId: 's2' } : session);
      const restore = () => h.openSession(h.window.sessionMap.get('s2'), undefined, { automatic: true, continuationResolved: true });
      const click = () => h.openSession(h.window.sessionMap.get('s1'));
      const opens = clickFirst ? [click()] : [restore()];
      await settle();
      opens.push(clickFirst ? restore() : click());
      await settle();
      for (let i = 0; i < 3; i++) { guards.splice(0).forEach((r) => r(true)); await settle(); h.release(); await settle(); }
      await Promise.all(opens);
      assert.deepEqual(h.openTerminalCalls, ['s2'], clickFirst ? 'click, then the restore of its continuation' : 'restore, then a click resolving to it');
    } finally { h.destroy(); }
  }
});

test('a session whose terminal failed to open can be opened again', async () => {
  const h = setup();
  try {
    const rejected = h.openSession(h.window.sessionMap.get('s1'));
    await settle();
    h.fail(new Error('ipc gone'));
    await assert.rejects(rejected);
    await h.openSession(h.window.sessionMap.get('s1'));

    h.window.openSessions.clear();
    const failed = h.openSession(h.window.sessionMap.get('s1'));
    await settle();
    h.release({ ok: false, error: 'spawn failed' });
    await failed;
    const opened = h.openSession(h.window.sessionMap.get('s1'));
    await settle();
    h.release();
    await opened;
    assert.deepEqual(h.openTerminalCalls, ['s1', 's1', 's1']);
  } finally { h.destroy(); }
});
