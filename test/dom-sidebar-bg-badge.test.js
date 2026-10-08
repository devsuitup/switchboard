'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

test('a row whose session id is in bgAgentSessionIds shows the bg badge; the others do not', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  Object.defineProperty(ctx.window, 'bgAgentSessionIds', { value: new Set(['s-top-1']), writable: true, configurable: true });
  const project = makeSampleProject();
  ctx.sidebar.renderProjects([project], false);
  const badged = ctx.document.querySelector('[data-session-id="s-top-1"] .bg-badge');
  assert.ok(badged, 'the badge is there');
  assert.equal(badged.textContent, 'bg');
  assert.equal(ctx.document.querySelector('[data-session-id="s-top-2"] .bg-badge'), null);
});

test('a roster snapshot badges only the live jobs: working and blocked, not done or stopped', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.evalPublic('agents-view.js');
  const apply = ctx.read('applyAgentsSnapshot');
  const project = makeSampleProject();
  const ids = ['s-top-1', 's-top-2'];
  const job = (id, sessionId, state) => ({ id, sessionId, kind: 'background', state });
  apply({ roster: [job('aaaaaaaa', ids[0], 'working'), job('bbbbbbbb', ids[1], 'done')], daemonReachable: true });
  ctx.sidebar.renderProjects([project], false);
  assert.ok(ctx.document.querySelector(`[data-session-id="${ids[0]}"] .bg-badge`), 'a working job is badged');
  assert.equal(ctx.document.querySelector(`[data-session-id="${ids[1]}"] .bg-badge`), null, 'a done job is not');
  apply({ roster: [job('aaaaaaaa', ids[0], 'stopped'), job('bbbbbbbb', ids[1], 'blocked')], daemonReachable: true });
  ctx.sidebar.renderProjects([project], false);
  assert.equal(ctx.document.querySelector(`[data-session-id="${ids[0]}"] .bg-badge`), null, 'a stopped job is not');
  assert.ok(ctx.document.querySelector(`[data-session-id="${ids[1]}"] .bg-badge`), 'a blocked job is badged');
});

test('without the roster global the sidebar renders as before', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.sidebar.renderProjects([makeSampleProject()], false);
  assert.equal(ctx.document.querySelector('.bg-badge'), null);
});

test('a roster job badges its session whatever the case of either id', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.evalPublic('agents-view.js');
  const project = makeSampleProject();
  ctx.read('applyAgentsSnapshot')({ roster: [{ id: 'aaaaaaaa', sessionId: 'S-TOP-1', kind: 'background', state: 'working' }], daemonReachable: true });
  ctx.sidebar.renderProjects([project], false);
  assert.ok(ctx.document.querySelector('[data-session-id="s-top-1"] .bg-badge'));
});
