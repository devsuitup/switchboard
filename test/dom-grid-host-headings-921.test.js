const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function setup(t, { samePath = true } = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const { window, document } = ctx;
  const projects = ['host-b', undefined, 'host-a'].map((remoteAlias, i) => makeSampleProject({
    projectPath: samePath ? '/home/dev/shared' : '/home/dev/project-' + i,
    remoteAlias,
    sessions: [{ sessionId: 'session-' + i, remoteAlias, modified: new Date().toISOString() }],
  }));
  window.cachedAllProjects = projects;
  for (const project of projects) {
    for (const session of project.sessions) {
      session.projectPath = project.projectPath;
      window.sessionMap.set(session.sessionId, session);
    }
  }
  ctx.sidebar.renderProjects(projects, true);
  Object.assign(window, {
    terminalsEl: document.getElementById('terminals'),
    gridViewActive: true,
    replayHiddenBuffer() {},
    updateRunningIndicators() {},
  });
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  loadAppFunctions(ctx.context, { functions: ['getExpandedSlugs', 'saveExpandedSlugs'] });
  const ids = [...document.querySelectorAll('.session-item')].map(item => item.dataset.sessionId);
  function open(id) {
    const element = document.createElement('div');
    element.className = 'terminal-container';
    window.terminalsEl.appendChild(element);
    window.openSessions.set(id, { element, session: window.sessionMap.get(id), terminal: { focus() {} } });
  }
  function groups() {
    return [...window.terminalsEl.querySelectorAll('.grid-project-heading')].map(heading => {
      const members = [];
      for (let card = heading.nextElementSibling; card && !card.classList.contains('grid-project-heading'); card = card.nextElementSibling) {
        if (card.classList.contains('grid-card')) members.push(card.dataset.sessionId);
      }
      return { key: heading.dataset.projectKey, path: heading.dataset.projectPath, members };
    });
  }
  function expected() {
    return ids.map(id => {
      const session = window.sessionMap.get(id);
      return { key: window.projectStateKey(session), path: session.projectPath, members: [id] };
    });
  }
  return { ...ctx, ids, open, groups, expected };
}

test('grouped grid separates two remote hosts and a local project at one path in sidebar order', t => {
  const ctx = setup(t);
  ctx.ids.forEach(ctx.open);
  ctx.window.layoutGridCards(new Set(ctx.ids));
  assert.equal(ctx.groups().length, 3, 'same-path projects need three distinct headings');
  assert.deepEqual(ctx.groups(), ctx.expected());
});

test('opening same-path projects in reverse order inserts headings in the sidebar order', t => {
  const ctx = setup(t);
  for (const id of [...ctx.ids].reverse()) {
    ctx.open(id);
    ctx.window.wrapInGridCard(id);
  }
  assert.equal(ctx.groups().length, 3, 'opening a host must not reuse another host heading');
  assert.deepEqual(ctx.groups(), ctx.expected());
  const extra = { ...ctx.window.sessionMap.get(ctx.ids[0]), sessionId: 'extra' };
  ctx.window.sessionMap.set(extra.sessionId, extra);
  ctx.open(extra.sessionId);
  ctx.window.wrapInGridCard(extra.sessionId);
  const expected = ctx.expected();
  expected[0].members.push(extra.sessionId);
  assert.deepEqual(ctx.groups(), expected, 'another card on the same host reuses its heading');
});

test('local grid headings keep path keys and sidebar order on layout and incremental opening', t => {
  const ctx = setup(t, { samePath: false });
  for (const id of ctx.ids) delete ctx.window.sessionMap.get(id).remoteAlias;
  ctx.window.sortedOrder = ctx.ids.map(id => ({ projectPath: ctx.window.sessionMap.get(id).projectPath }));
  for (const id of [...ctx.ids].reverse()) {
    ctx.open(id);
    ctx.window.wrapInGridCard(id);
  }
  assert.deepEqual(ctx.groups(), ctx.expected());
  for (const group of ctx.groups()) assert.equal(group.key, group.path);
  ctx.window.unwrapGridCards();
  ctx.window.layoutGridCards(new Set(ctx.ids));
  assert.deepEqual(ctx.groups(), ctx.expected());
});
