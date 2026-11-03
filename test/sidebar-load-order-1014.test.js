'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

test('renderer scripts complete in index.html order before app.js creates its bindings', t => {
  let ctx;
  assert.doesNotThrow(() => { ctx = setupSidebarDom({ indexOrder: true }); },
    'every script before app.js must complete without app.js globals');
  t.after(() => ctx.destroy());
  ctx.window.Date.now = () => Date.parse('2026-11-03T10:00:00Z');
  assert.equal(typeof ctx.sidebar.renderProjects.unchanged, 'function');
  const projects = [makeSampleProject()];
  ctx.window.cachedAllProjects = projects;
  for (const session of projects[0].sessions) ctx.window.sessionMap.set(session.sessionId, session);
  ctx.sidebar.renderProjects(projects, true);
  assert.equal(ctx.sidebar.renderProjects.unchanged(projects), true);
  ctx.document.querySelector('.session-item').setAttribute('data-load-order-probe', 'changed');
  assert.equal(ctx.sidebar.renderProjects.unchanged(projects), false);
});

test('right-clicking a session row opens its menu after loading scripts in index.html order', t => {
  let ctx;
  assert.doesNotThrow(() => { ctx = setupSidebarDom({ indexOrder: true }); });
  t.after(() => ctx.destroy());
  const errors = [];
  ctx.window.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
  const project = makeSampleProject();
  for (const session of project.sessions) ctx.window.sessionMap.set(session.sessionId, session);
  ctx.sidebar.renderProjects([project], true);
  const row = ctx.document.querySelector('.session-item');
  row.dispatchEvent(new ctx.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
  assert.deepEqual(errors, [], 'contextmenu handler must finish without an uncaught error');
  const menu = ctx.document.querySelector('.session-context-menu[role="menu"]');
  assert.ok(menu, 'the session menu is visible');
  assert.match(menu.textContent, /Refresh screen/);
  ctx.document.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ctx.document.querySelector('.session-context-menu'), null);
});
