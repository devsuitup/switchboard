'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const row = { sessionId: 'A', mergedMemberIds: ['B', 'C'], headSessionId: 'B', projectPath: '/project' };

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.evalPublic('resume-guard.js');
  const shown = [], prompts = [], checked = [];
  Object.assign(ctx.window, {
    restoringWorkingSet: false, sessionOpenedOutsideRestore: false, continuationRetryCancelled: false,
    showSession: id => shown.push(id),
    appConfirm: async ({ message }) => { prompts.push(message); return false; },
    appChoose: async question => { prompts.push(question); return null; },
  });
  ctx.window.api.getSessionContinuations = async id => {
    checked.push(id);
    return { candidates: [{ sessionId: 'D' }], unresolved: false };
  };
  const { openSession } = loadAppFunctions(ctx.context, { functions: ['openSession', 'openSessionNow', 'indexedRowOf', 'indexedSessionById', 'dormantRowIds', 'syncDormantRow', 'clearDormantRow'], declarations: ['restoreRunDepth', 'openingSessions', 'dormantWorkingSet', 'skippedWorkingSetEntries'] });
  return { ctx, openSession, shown, prompts, checked };
}

test('opening a merged row focuses its open member without a continuation prompt', async t => {
  const h = setup(t);
  h.ctx.window.openSessions.set('B', { closed: false });
  await h.openSession(row);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.checked, []);
  assert.deepEqual(h.shown, ['B']);
});

test('opening a merged row prefers its head over its representative open tab', async t => {
  const h = setup(t);
  h.ctx.window.openSessions.set('A', { closed: false });
  h.ctx.window.openSessions.set('B', { closed: false });
  await h.openSession(row);
  assert.deepEqual(h.shown, ['B']);
  assert.deepEqual(h.prompts, []);
});

test('opening a merged row prefers its representative head over open mirrors', async t => {
  const h = setup(t);
  h.ctx.window.openSessions.set('A', { closed: false });
  h.ctx.window.openSessions.set('B', { closed: false });
  await h.openSession({ ...row, headSessionId: 'A' });
  assert.deepEqual(h.shown, ['A']);
});

test('opening a merged row tries other parts before the representative when its head is closed', async t => {
  const h = setup(t);
  h.ctx.window.openSessions.set('A', { closed: false });
  h.ctx.window.openSessions.set('B', { closed: true });
  h.ctx.window.openSessions.set('C', { closed: false });
  await h.openSession(row);
  assert.deepEqual(h.shown, ['C']);
});

test('opening a merged row skips a closed member for another open member', async t => {
  const h = setup(t);
  h.ctx.window.openSessions.set('B', { closed: true });
  h.ctx.window.openSessions.set('C', { closed: false });
  await h.openSession(row);
  assert.deepEqual(h.shown, ['C']);
  assert.deepEqual(h.prompts, []);
});

test('opening a merged row with no live open member keeps the continuation prompt', async t => {
  const h = setup(t);
  h.ctx.window.openSessions.set('B', { closed: true });
  await h.openSession(row);
  assert.deepEqual(h.checked, ['A']);
  assert.equal(h.prompts[0].title, 'Open which part?');
  assert.deepEqual(Array.from(h.prompts[0].options, option => option.id), ['D', 'A']);
  assert.deepEqual(h.shown, []);
});
