'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');

function noticeText(document, expected, details) {
  const notice = document.querySelector('[role="alert"]');
  assert.ok(notice);
  assert.equal(notice.querySelector('.app-notice-message').textContent, expected);
  assert.equal(notice.querySelector('.app-notice-details').open, false);
  assert.equal(notice.querySelector('.app-notice-details-body').textContent, details);
  return notice;
}

for (const rejects of [false, true]) {
  test('1023 continuation attach failure keeps the reason below its short message: ' + rejects, async t => {
    const h = setupSidebarDom();
    t.after(() => h.destroy());
    const session = { sessionId: 'abcdef12-1234-5678-9012-123456789abc', name: 'Work', projectPath: '/work/project' };
    const entry = { session, initialSize: {} };
    const logs = [];
    Object.assign(h.window, {
      skippedWorkingSetEntries: new Map(), beginPtyOpen() {}, settlePtyOpen() {},
      schedulePersistWorkingSet() {}, pollActiveSessions() {},
    });
    h.window.openSessions.set(session.sessionId, entry);
    h.window.api.logUiNotice = event => logs.push(event);
    h.window.api.openTerminal = async () => {
      if (rejects) throw new Error('job 1234abcd unavailable');
      return { ok: false, error: 'job 1234abcd unavailable' };
    };
    const { attachBackgroundContinuation } = loadAppFunctions(h.context, { functions: ['attachBackgroundContinuation'] });
    await attachBackgroundContinuation(entry, { jobId: '1234abcd' });
    noticeText(h.document,
      'Could not attach to the background session.\nOpen it from the sidebar to retry attaching.\n"Work" now runs in the background.',
      '"Work" (abcdef12-1234-5678-9012-123456789abc) at /work/project\njob 1234abcd unavailable');
    assert.equal(entry.closed, true);
    assert.equal(logs.at(-1).text,
      'Attach background failed for "abcdef12" (abcdef12-1234-5678-9012-123456789abc) at /work/project: job 1234abcd unavailable. The conversation now runs in the background. Open it from the sidebar to retry attaching.');
  });
}

for (const closed of [false, true]) {
  test('1023 background attach refusal uses short text when opening a ' + (closed ? 'closed' : 'new') + ' tab', async t => {
    const h = setup(t, { old: [] });
    const session = h.rows.get('old');
    session.name = 'Work';
    if (closed) h.ctx.openSessions.set('old', { session, closed: true });
    h.ctx.api.openTerminal = async () => ({ ok: false, error: 'job 1234abcd unavailable' });
    assert.equal(await h.app.openSession(session, { type: 'attach', jobId: '1234abcd' }), false);
    noticeText(h.dom.window.document,
      'Could not attach to the background session.\nCheck it in the Agents view, then open it from the sidebar to retry attaching.\nSession: "Work".',
      '"Work" (old) at ' + h.root + '\njob 1234abcd unavailable');
    assert.equal(h.ctx.openSessions.has('old'), false);
  });
}

test('1023 failed respawn does not claim that the job restarted', async t => {
  const h = setup(t, { old: [], other: [] }, { choice: 'background' });
  const session = h.rows.get('old');
  Object.assign(session, { name: 'Work', headSessionId: 'old', mergedMemberIds: ['other'],
    identitySessionId: 'old', identityJobId: '1234abcd', refusedJobState: 'blocked' });
  h.ctx.api.bgAgentVerb = async () => ({ ok: false, error: 'job 1234abcd refused' });
  assert.equal(await h.app.openSession(session), false);
  noticeText(h.dom.window.document,
    'Respawn failed.\nCheck the job in the Agents view.\nSession: "Work".',
    '"Work" (old) at ' + h.root + '\njob 1234abcd refused');
  assert.deepEqual(h.spawned, []);
});

for (const failure of ['missing job', 'throw']) {
  test('1023 respawn refusal describes the actual outcome: ' + failure, async t => {
    const h = setup(t, { old: [], other: [] }, { choice: 'background' });
    const session = h.rows.get('old');
    Object.assign(session, { name: 'Work', headSessionId: 'old', mergedMemberIds: ['other'],
      identitySessionId: 'old', identityJobId: '1234abcd', refusedJobState: 'blocked' });
    h.ctx.api.bgAgentVerb = async () => {
      if (failure === 'throw') throw new Error('respawn unavailable');
      return { ok: true };
    };
    t.mock.method(h.ctx, 'setTimeout', callback => { queueMicrotask(callback); return 0; });
    assert.equal(await h.app.openSession(session), false);
    noticeText(h.dom.window.document,
      (failure === 'throw' ? 'Respawn failed.' : 'The respawned job did not appear.')
        + '\nCheck the job in the Agents view.\nSession: "Work".',
      '"Work" (old) at ' + h.root + '\n' + (failure === 'throw' ? 'respawn unavailable'
        : 'Job 1234abcd was respawned but has no live background descriptor'));
    assert.deepEqual(h.spawned, []);
  });
}

test('1023 continuation failure shows the short id when no name exists', async t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const session = { sessionId: 'abcdef12-1234-5678-9012-123456789abc', projectPath: '/work/project' };
  const entry = { session, initialSize: {} };
  Object.assign(h.window, { skippedWorkingSetEntries: new Map(), beginPtyOpen() {}, settlePtyOpen() {},
    schedulePersistWorkingSet() {}, pollActiveSessions() {} });
  h.window.openSessions.set(session.sessionId, entry);
  h.window.api.openTerminal = async () => ({ ok: false, error: 'attach unavailable' });
  await loadAppFunctions(h.context, { functions: ['attachBackgroundContinuation'] })
    .attachBackgroundContinuation(entry, { jobId: '1234abcd' });
  noticeText(h.document,
    'Could not attach to the background session.\nOpen it from the sidebar to retry attaching.\n"abcdef12" now runs in the background.',
    '"abcdef12-1234-5678-9012-123456789abc" at /work/project\nattach unavailable');
});
