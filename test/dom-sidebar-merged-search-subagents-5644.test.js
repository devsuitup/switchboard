'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const row = {
  sessionId: 'a', headSessionId: 'c', mergedMemberIds: ['b', 'c'],
  summary: 'Compacted conversation', modified: '2026-10-19T06:00:00Z', messageCount: 3,
};

function setup(t) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  return ctx;
}

function child(parentSessionId) {
  return {
    sessionId: `sub:${parentSessionId}:1`, parentSessionId, agentId: '1',
    subagentType: 'explore', description: 'Part child',
    modified: row.modified, messageCount: 1,
  };
}

for (const hit of ['a', 'b', 'c', 'head-only']) {
  test(`17: narrowing keeps a merged row for a hit on ${hit}`, t => {
    const ctx = setup(t);
    const session = { ...row, headSessionId: 'head-only' };
    const sessions = ctx.window.narrowSessionsToSearch([session, { sessionId: 'unrelated' }], new Set([hit]));
    assert.deepEqual(Array.from(sessions, s => s.sessionId), ['a']);
  });
}

test('17: narrowing excludes rows when none of their parts match', t => {
  const ctx = setup(t);
  assert.equal(ctx.window.narrowSessionsToSearch([row], new Set(['unrelated'])).length, 0);
  assert.equal(ctx.window.narrowSessionsToSearch([row], new Set()).length, 0);
});

for (const parent of ['b', 'head-only']) {
  test(`18: a subagent of ${parent} renders in row a's child container`, t => {
    const ctx = setup(t);
    const session = { ...row, headSessionId: 'head-only' };
    const subagent = child(parent);
    ctx.sidebar.renderProjects([makeSampleProject({ sessions: [subagent, session] })], true);

    assert.equal(ctx.document.querySelector('.sidebar-orphan-subagents'), null);
    const item = ctx.document.getElementById('si-a');
    const container = ctx.document.getElementById('subc-a');
    assert.ok(item);
    assert.ok(container, 'row a must have a child container');
    assert.equal(item.nextElementSibling.nextElementSibling, container);
    assert.ok(container.contains(ctx.document.getElementById(`si-sub:${parent}:1`)), 'the child must be present under row a');
    assert.equal(subagent.parentSessionId, parent);
    assert.equal(ctx.document.querySelectorAll(`[data-session-id="sub:${parent}:1"]`).length, 1);
  });
}

test('a row keeps its own subagents when another row lists its id as a member', t => {
  const ctx = setup(t);
  const x = { ...row, sessionId: 'x', headSessionId: 'x', mergedMemberIds: [] };
  const y = { ...row, sessionId: 'y', headSessionId: 'y', mergedMemberIds: ['x'], modified: '2026-10-18T06:00:00Z' };
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [x, y, child('x')] })], true);

  const container = ctx.document.getElementById('subc-x');
  assert.ok(container, 'row x keeps its child container');
  assert.ok(container.contains(ctx.document.getElementById('si-sub:x:1')));
});

for (const hit of ['c', 'head-only']) {
  test(`20: refreshSidebar keeps the project whose only hit is ${hit}`, t => {
    const ctx = setup(t);
    const project = makeSampleProject({ sessions: [{ ...row, headSessionId: 'head-only' }] });
    ctx.window.cachedAllProjects = [project, makeSampleProject({ projectPath: '/unrelated', sessions: [{ ...row, sessionId: 'other', mergedMemberIds: [], headSessionId: 'other' }] })];
    ctx.window.searchMatchIds = new Set([hit]);
    const { refreshSidebar } = loadAppFunctions(ctx.context, { functions: ['refreshSidebar'] });

    refreshSidebar({ resort: true });

    assert.ok(ctx.document.getElementById(ctx.sidebar.folderId(project.projectPath)), 'member hit must keep its project');
    assert.ok(ctx.document.getElementById('si-a'), 'member hit must keep the conversation row');
    assert.equal(ctx.document.getElementById(ctx.sidebar.folderId('/unrelated')), null);
  });
}

test('a search hit on a merged member subagent keeps the child under the conversation', t => {
  const ctx = setup(t);
  const subagent = child('b');
  ctx.window.cachedAllProjects = [makeSampleProject({ sessions: [row, subagent] })];
  ctx.window.searchMatchIds = new Set([subagent.sessionId]);
  const { refreshSidebar } = loadAppFunctions(ctx.context, { functions: ['refreshSidebar'] });

  refreshSidebar({ resort: true });

  assert.ok(ctx.document.getElementById('si-a'), 'the matching child keeps its merged parent');
  assert.ok(ctx.document.getElementById('subc-a').contains(ctx.document.getElementById('si-sub:b:1')));
  assert.equal(ctx.document.querySelector('.sidebar-orphan-subagents'), null);
});
