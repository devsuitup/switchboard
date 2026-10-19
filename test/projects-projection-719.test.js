'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

test('T3 fresh projections remove omitted backend fields and preserve shared runtime references', () => {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    const { dedup } = loadAppFunctions(ctx.context, { functions: ['dedup'] });
    const row = { sessionId: 'b', bgJobId: '369b1c23', bgSessionId: 'b', identityJobId: '369b1c23',
      identitySessionId: 'b', descriptorOnly: true, headSessionId: 'b', mergedMemberIds: ['a'],
      conversationParts: [], mergedMemberStatuses: {}, status: 'shell', statusUpdatedAt: 1,
      waitingFor: 'input', remoteAttachable: true, placeholder: true };
    dedup([{ sessions: [row] }]);
    row.runtimeSentinel = 42;
    window.openSessions.set('b', { session: row, attach: true });
    const fresh = { sessionId: 'b', mergedMemberIds: [], aiTitle: null, archived: false };
    const projects = [{ sessions: [fresh] }];
    dedup(projects);
    assert.equal(projects[0].sessions[0], row);
    assert.equal(window.openSessions.get('b').session, row);
    for (const key of Object.keys(row).filter(k => !['sessionId', 'runtimeSentinel', 'mergedMemberIds', 'aiTitle', 'archived'].includes(k))) {
      assert.equal(Object.hasOwn(row, key), false, key);
    }
    assert.equal(row.runtimeSentinel, 42);
    assert.equal(row.aiTitle, null);
    dedup(projects);
    assert.deepEqual(row.mergedMemberIds, []);
    assert.equal(row.runtimeSentinel, 42);
  } finally { ctx.destroy(); }
});

for (const wrongScope of [false, true]) {
  test(`T2.5 accepted merged membership reconciles pending only in matching host/project, wrongScope=${wrongScope}`, async t => {
    const h = setupSidebarDom(); t.after(() => h.destroy()); const w = h.window;
    w.loadingStatus = w.document.createElement('div'); w.cachedProjects = []; w.cachedAllProjects = [];
    let persistence = 0; w.schedulePersistWorkingSet = () => { persistence++; };
    for (const name of ['reportActivityFocus', 'reportActivityTitles', 'refreshSidebar', 'renderDefaultStatus']) w[name] = () => {};
    w.pollActiveSessions = async () => {};
    w.api.getSetting = async () => ({}); w.api.getActiveTerminals = async () => [];
    const row = { sessionId: 'b', mergedMemberIds: ['a'], projectPath: wrongScope ? '/other' : '/p' };
    w.api.getProjects = async () => ({ defaultProjects: [{ projectPath: row.projectPath, sessions: [{ ...row }] }], allProjects: [{ projectPath: row.projectPath, sessions: [{ ...row }] }] });
    w.pendingSessions.set('a', { projectPath: '/p', folder: '-p', session: { sessionId: 'a', projectPath: '/p' } });
    w.pendingSessions.set('unrelated', { projectPath: '/p', folder: '-p', session: { sessionId: 'unrelated', projectPath: '/p' } });
    w.openSessions.set('a', { session: w.pendingSessions.get('a').session });
    const { loadProjects } = loadAppFunctions(h.context, { functions: ['dedup', 'loadProjects'] });
    await loadProjects();
    assert.equal(w.pendingSessions.has('a'), wrongScope); assert.equal(w.pendingSessions.has('unrelated'), true);
    assert.equal(persistence, wrongScope ? 0 : 1);
    assert.equal(w.cachedAllProjects.flatMap(p => p.sessions).filter(s => s.sessionId === 'a').length, wrongScope ? 1 : 0);
  });
}

test('T3 merge, split and remerge refresh member lookup without replacing live row references', t => {
  const h = setupSidebarDom(); t.after(() => h.destroy()); const w = h.window;
  const { dedup } = loadAppFunctions(h.context, { functions: ['dedup'] });
  const A = 'a', B = 'b', row = { sessionId: B, projectPath: '/p', headSessionId: B, mergedMemberIds: [A],
    bgJobId: '369b1c23', bgSessionId: B, identityJobId: '369b1c23', identitySessionId: B,
    mergedMemberStatuses: { a: { status: 'waiting', statusUpdatedAt: 2 } } };
  const initial = [{ sessions: [row] }]; dedup(initial); row.runtimeSentinel = { held: true };
  w.openSessions.set(B, { session: row }); assert.equal(w.localActivityRow(A), row);
  const split = [{ sessions: [{ sessionId: A, projectPath: '/p', aiTitle: null, archived: false },
    { sessionId: B, projectPath: '/p', mergedMemberIds: [] }] }];
  dedup(split); assert.equal(w.localActivityRow(A), split[0].sessions[0]);
  assert.equal(split[0].sessions[1], row); assert.equal(w.openSessions.get(B).session, row);
  for (const key of ['bgJobId', 'bgSessionId', 'identityJobId', 'identitySessionId', 'headSessionId', 'mergedMemberStatuses']) assert.equal(Object.hasOwn(row, key), false, key);
  const merged = [{ sessions: [{ sessionId: B, projectPath: '/p', headSessionId: B, mergedMemberIds: [A], identityJobId: 'aaaaaaaa', identitySessionId: B }] }];
  dedup(merged); assert.equal(w.localActivityRow(A), row); assert.equal(merged[0].sessions[0], row);
  assert.equal(row.identityJobId, 'aaaaaaaa'); assert.equal(row.runtimeSentinel.held, true);
  dedup(merged); assert.equal(w.localActivityRow(A), row); assert.equal(row.runtimeSentinel.held, true);
});
