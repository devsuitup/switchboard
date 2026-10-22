'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSessionStop } = require('../public/stop-session-ui');
const { setupSidebarDom } = require('./dom-setup');

test('an attach tab describes a reversible detach without asking and stays local', () => {
  const plan = resolveSessionStop({ sessionId: 's' }, { attach: true });
  assert.equal(plan.remote, false);
  assert.equal(plan.attach, true);
  assert.match(plan.confirmText, /Detach/);
  assert.match(plan.confirmText, /keeps running/);
  assert.doesNotMatch(plan.confirmText, /\?/);
  assert.equal(resolveSessionStop({ sessionId: 's' }).attach, false);
  assert.equal(resolveSessionStop({ sessionId: 's', remoteAlias: 'h' }, { attach: true }).remote, true);
});

test('Detach plans only open background attach tabs and respects tabOnly and Retry', t => {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  const w = h.window;
  const row = { sessionId: 'A', mergedMemberIds: ['B', 'C', 'D', 'E'] };
  for (const id of ['A', 'B', 'C', 'D', 'E']) w.activePtyIds.add(id);
  w.openSessions.set('A', { attach: true, attachJobId: 'abcd1234' });
  w.openSessions.set('B', { attach: false });
  w.openSessions.set('C', { attach: true, closed: true });
  w.openSessions.set('D', { attach: true, session: { remoteAlias: 'host' } });
  w.openSessions.set('E', { attach: true, attachJobId: '1234abcd' });
  assert.deepEqual(Array.from(w.planSessionDetach(row).targets, target => target.sessionId), ['A', 'E']);
  assert.deepEqual(Array.from(w.planSessionDetach(row, { tabOnly: true }).targets, target => target.sessionId), ['A']);
  assert.deepEqual(Array.from(w.planSessionDetach(row, { retryTargets: [{ sessionId: 'E' }] }).targets, target => target.sessionId), ['E']);
});
