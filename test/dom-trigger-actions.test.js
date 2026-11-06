// see .ai/contexts/ipc-bridge.md ("Trigger session actions")
'use strict';

const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const PROJECT = '/home/dev/proj';
const A = '01234567-89ab-cdef-0123-456789abcdef';
const B = 'fedcba98-7654-3210-fedc-ba9876543210';
const SAVED = { permissionMode: 'plan', sandbox: true, worktree: true, worktreeName: 'wt', addDirs: '/x,/y', preLaunchCmd: 'env' };

function setup({ grid = false, resultFor } = {}) {
  const ctx = setupSidebarDom();
  const { window } = ctx;
  const calls = { openTerminal: [], show: [], reveal: [], focusCard: [], continuation: 0, guard: [], results: [], rename: [], persist: 0 };
  const inContext = code => vm.runInContext(code, ctx.context);
  Object.assign(window, {
    restoringWorkingSet: false, sessionOpenedOutsideRestore: false, skippedWorkingSetEntries: new Map(), restoreSavedIndex: new Map(),
    refreshSidebar: () => {},
    encodeProjectPath: value => value.replace(/[^a-zA-Z0-9]/g, '-'),
    createTerminalEntry: session => {
      const entry = { session, closed: false, terminal: { write() {}, focus() {} }, initialSize: { cols: 80, rows: 24 } };
      window.openSessions.set(session.sessionId, entry);
      return entry;
    },
    showSession: id => calls.show.push(id),
    revealWithoutActivating: id => calls.reveal.push(id),
    focusGridCard: id => calls.focusCard.push(id),
    destroySession: id => { window.openSessions.delete(id); },
    prepareBackgroundRestore: async () => ({ live: null, backgroundRestoreJobId: 'abcd1234' }),
    guardResume: async (session, options) => { calls.guard.push([session.sessionId, options.automatic, options.allowBgAttach]); return true; },
    resolveResumeSession: async session => { calls.continuation += 1; return session; },
    resolveDefaultSessionOptions: async () => ({ ...SAVED }),
    syncPtySizeAfterOpen: () => {}, setSessionMcpState: () => {}, setSessionSandboxed: () => {}, forgetSessionExit: () => {}, beginPtyOpen: () => {},
    settlePtyOpen: (id, result) => { if (result?.generation !== undefined) inContext('ptyGenerations').set(id, result.generation); },
    schedulePersistWorkingSet: () => { calls.persist += 1; }, pollActiveSessions: () => {},
    gridViewActive: grid, gridFocusedSessionId: 'other', activeSessionId: 'other',
  });
  Object.assign(window.api, {
    openTerminal: async (...args) => {
      calls.openTerminal.push(args);
      return resultFor ? resultFor(args) : { ok: true, generation: 5, sandbox: true };
    },
    triggerSessionActionResult: result => calls.results.push(result),
    renameSession: async (...args) => calls.rename.push(args),
  });
  const project = { projectPath: PROJECT, folder: 'f', sessions: [{ sessionId: A, name: 'closed one', modified: new Date().toISOString(), messageCount: 3, projectPath: PROJECT }] };
  window.cachedProjects = [project];
  window.cachedAllProjects = [project];
  window.sessionMap.set(A, project.sessions[0]);
  loadAppFunctions(ctx.context, {
    declarations: ['restoreRunDepth', 'restoreMode', 'continuationRetryCancelled', 'openingSessions', 'dormantWorkingSet', 'restoreInFlight', 'triggerDocumentEpoch', 'ptyGenerations'],
    functions: ['openSession', 'openSessionNow', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow',
      'launchNewSession', 'handleTriggerSessionAction', 'signalTriggerReady'],
  });
  inContext('triggerDocumentEpoch = 9');
  const request = (extra) => ({ requestId: 'req-1', documentEpoch: 9, mode: 'resume', requestedSessionId: A, tabKey: A, generation: null,
    session: { sessionId: A, projectPath: PROJECT }, project: PROJECT, name: null, deadline: Date.now() + 5000, ...extra });
  return { window, calls, request, inContext, generations: { set: (id, value) => inContext('ptyGenerations').set(id, value) }, destroy: () => ctx.destroy() };
}

test('a closed resume opens the exact id through the guarded lifecycle without activation and acknowledges the main generation', async () => {
  const h = setup();
  try {
        h.window.sessionMap.set(A, { ...h.window.sessionMap.get(A), headSessionId: B, mergedMemberIds: [B] });
    await h.window.handleTriggerSessionAction(h.request());
    assert.equal(h.calls.continuation, 0, 'no continuation chooser');
    assert.deepEqual(h.calls.guard, [[A, true, false]]);
    assert.equal(h.calls.openTerminal.length, 1);
    const [id, project, isNew, options, , permit] = h.calls.openTerminal[0];
    assert.deepEqual([id, project, isNew], [A, PROJECT, false]);
    assert.equal(permit, 'req-1');
    assert.equal(options.permissionMode, 'plan');
    assert.equal(options.sandbox, true);
    assert.equal(options.worktree, true);
    assert.equal(options.addDirs, '/x,/y');
    assert.deepEqual(h.calls.show, []);
    assert.deepEqual(h.calls.reveal, [A]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.results)), [{ requestId: 'req-1', documentEpoch: 9, mode: 'resume', requestedSessionId: A, tabKey: A, generation: 5, ok: true }]);
  } finally { h.destroy(); }
});

test('a dormant background record refuses the trigger open instead of attaching', async () => {
  const h = setup();
  try {
    h.window.guardResume = async () => ({ attach: 'abcd1234', cwd: PROJECT });
    h.inContext('dormantWorkingSet').set(A, { item: { sessionId: A, projectPath: PROJECT, bg: true, attachJobId: 'abcd1234' } });
    await h.window.handleTriggerSessionAction(h.request());
    assert.equal(h.calls.openTerminal.length, 0);
    assert.equal(h.calls.results[0].ok, false);
    assert.equal(h.calls.results[0].reason, 'session open failed');
  } finally { h.destroy(); }
});

test('a failed open or an undefined return can never acknowledge success', async () => {
  const h = setup({ resultFor: () => ({ ok: false, error: 'spawn failed' }) });
  try {
    await h.window.handleTriggerSessionAction(h.request());
    assert.equal(h.calls.results.length, 1);
    assert.equal(h.calls.results[0].ok, false);
    assert.equal(h.window.openSessions.has(A), false);
  } finally { h.destroy(); }
  const g = setup({ resultFor: () => undefined });
  try {
    await g.window.handleTriggerSessionAction(g.request());
    assert.equal(g.calls.results[0].ok, false);
  } finally { g.destroy(); }
});

test('a request from another document or with a bad shape is refused without any open', async () => {
  const h = setup();
  try {
    await h.window.handleTriggerSessionAction(h.request({ documentEpoch: 8 }));
    await h.window.handleTriggerSessionAction(h.request({ mode: 'fork' }));
    await h.window.handleTriggerSessionAction(h.request({ tabKey: '' }));
    assert.equal(h.calls.openTerminal.length, 0);
    assert.deepEqual(h.calls.results.map(r => r.ok), [false, false, false]);
  } finally { h.destroy(); }
});

test('reattach acknowledges an existing renderer entry under the tab key without opening', async () => {
  const h = setup();
  try {
    h.window.openSessions.set(B, { session: { sessionId: B }, closed: false });
    h.generations.set(B, 3);
    await h.window.handleTriggerSessionAction(h.request({ mode: 'reattach', requestedSessionId: A, tabKey: B, generation: 3 }));
    assert.equal(h.calls.openTerminal.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.results)), [{ requestId: 'req-1', documentEpoch: 9, mode: 'reattach', requestedSessionId: A, tabKey: B, generation: 3, ok: true }]);
  } finally { h.destroy(); }
});

test('reattach of a missing renderer entry recreates it under the tab key with reattachOnly, never under the requested id', async () => {
  const h = setup({ resultFor: () => ({ ok: true, reattached: true, generation: 3 }) });
  try {
    await h.window.handleTriggerSessionAction(h.request({ mode: 'reattach', requestedSessionId: A, tabKey: B, generation: 3, session: { sessionId: B, projectPath: PROJECT } }));
    assert.equal(h.calls.openTerminal.length, 1);
    const [id, , isNew, options, , permit] = h.calls.openTerminal[0];
    assert.equal(id, B);
    assert.equal(isNew, false);
    assert.equal(options.reattachOnly, true);
    assert.equal(permit, 'req-1');
    assert.equal(h.window.openSessions.has(A), false);
    assert.equal(h.calls.results[0].ok, true);
    assert.equal(h.calls.results[0].tabKey, B);
    assert.deepEqual(h.calls.show, []);
  } finally { h.destroy(); }
});

test('a new session uses the reserved id, the given name and the saved defaults, and is revealed without activation', async () => {
  const h = setup();
  try {
    await h.window.handleTriggerSessionAction(h.request({ mode: 'new', requestedSessionId: null, tabKey: B, name: 'Follow-up' }));
    const [id, project, isNew, options, , permit] = h.calls.openTerminal[0];
    assert.deepEqual([id, project, isNew, permit], [B, PROJECT, true, 'req-1']);
    assert.deepEqual(options, SAVED);
    assert.equal(h.window.sessionMap.get(B).name, 'Follow-up');
    assert.equal(h.window.pendingSessions.get(B).session.name, 'Follow-up');
    assert.deepEqual(h.calls.show, []);
    assert.deepEqual(h.calls.reveal, [B]);
    assert.ok(h.calls.persist >= 1);
    assert.equal(h.calls.results[0].ok, true);
    assert.equal(h.calls.results[0].requestedSessionId, null);
  } finally { h.destroy(); }
});

test('a new session whose spawn fails is not acknowledged, is not selected and keeps its card', async () => {
  const h = setup({ resultFor: () => ({ ok: false, error: 'no cwd' }) });
  try {
    await h.window.handleTriggerSessionAction(h.request({ mode: 'new', requestedSessionId: null, tabKey: B, name: 'n' }));
    assert.equal(h.calls.results[0].ok, false);
    assert.deepEqual(h.calls.show, []);
    assert.equal(h.window.openSessions.has(B), true);
  } finally { h.destroy(); }
});

test('selection, grid focus and the active session are untouched in single and grid view', async () => {
  for (const grid of [false, true]) {
    const h = setup({ grid });
    try {
      await h.window.handleTriggerSessionAction(h.request());
      await h.window.handleTriggerSessionAction(h.request({ requestId: 'req-2', mode: 'new', requestedSessionId: null, tabKey: B, name: 'n' }));
      assert.deepEqual(h.calls.show, [], `grid=${grid}`);
      assert.deepEqual(h.calls.focusCard, [], `grid=${grid}`);
      assert.equal(h.window.activeSessionId, 'other');
    } finally { h.destroy(); }
  }
});

test('an ordinary launch still selects the session it opens', async () => {
  const h = setup();
  try {
    const id = await h.window.launchNewSession(h.window.cachedProjects[0], { ...SAVED });
    assert.deepEqual(h.calls.show, [id]);
    assert.deepEqual(h.calls.reveal, []);
    assert.equal(h.calls.openTerminal[0][5], undefined);
  } finally { h.destroy(); }
});

test('an ordinary open of a closed session still selects it and keeps its user flow', async () => {
  const h = setup();
  try {
    await h.window.openSession(h.window.sessionMap.get(A));
    assert.deepEqual(h.calls.show, [A]);
    assert.equal(h.calls.openTerminal[0][5], undefined);
  } finally { h.destroy(); }
});

test('an expired request is not acknowledged', async () => {
  const h = setup();
  try {
    await h.window.handleTriggerSessionAction(h.request({ deadline: Date.now() - 1 }));
    assert.deepEqual(h.calls.results, []);
  } finally { h.destroy(); }
});

test('an archived-group project opens through the same saved defaults as the plus action', async () => {
  const h = setup();
  try {
    h.window.cachedAllProjects[0].archivedGroup = true;
    await h.window.handleTriggerSessionAction(h.request({ mode: 'new', requestedSessionId: null, tabKey: B, name: 'n' }));
    const trigger = h.calls.openTerminal[0][3];
    const plus = await h.window.resolveDefaultSessionOptions(h.window.cachedAllProjects[0]);
    assert.deepEqual(trigger, plus);
  } finally { h.destroy(); }
});
