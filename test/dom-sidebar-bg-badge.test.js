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

test('without the roster global the sidebar renders as before', (t) => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  ctx.sidebar.renderProjects([makeSampleProject()], false);
  assert.equal(ctx.document.querySelector('.bg-badge'), null);
});
