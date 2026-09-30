// A subagent is an orphan only when its parent is absent from the project's
// session list, not when a filter or a search hides the parent.
// See .ai/contexts/subagent-observability.md ("Hidden parent is not a missing parent").

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const PROJECT_PATH = '/home/dev/myproj';

function top(sessionId, extra = {}) {
  return {
    sessionId, name: sessionId, summary: sessionId,
    modified: new Date().toISOString(), starred: false, archived: 0, messageCount: 3,
    ...extra,
  };
}

function sub(sessionId, parentSessionId) {
  return {
    sessionId, parentSessionId, agentId: sessionId, subagentType: 'explore',
    description: sessionId, modified: new Date().toISOString(), messageCount: 1,
  };
}

function projectWith(sessions) {
  return makeSampleProject({ projectPath: PROJECT_PATH, sessions });
}

function render(ctx, sessions) {
  ctx.sidebar.renderProjects([projectWith(sessions)], true);
  const doc = ctx.document;
  const group = doc.querySelector('.sidebar-orphan-subagents');
  const orphanIds = group
    ? [...group.querySelectorAll('[data-subagent]')].map(el => el.dataset.sessionId).sort()
    : [];
  return { orphanIds, rendered: (id) => !!doc.querySelector(`[data-session-id="${id}"]`) };
}

const SESSIONS = () => [
  top('starred', { starred: true }),
  top('plain', { modified: '2020-01-01T00:00:00.000Z' }),
  sub('sub:plain:a1', 'plain'),
  sub('sub:gone:a1', 'gone'),
];

function withCtx(setup, fn) {
  const ctx = setupSidebarDom();
  try {
    setup(ctx);
    fn(ctx);
  } finally {
    ctx.destroy();
  }
}

test('starred filter: the subagent of a hidden parent is hidden, a missing parent stays an orphan', () => {
  withCtx(ctx => { ctx.window.showStarredOnly = true; }, ctx => {
    const { orphanIds, rendered } = render(ctx, SESSIONS());
    assert.deepEqual(orphanIds, ['sub:gone:a1']);
    assert.equal(rendered('sub:plain:a1'), false);
  });
});

test('running filter: the subagent of a hidden parent is hidden, a missing parent stays an orphan', () => {
  withCtx(ctx => {
    ctx.window.showRunningOnly = true;
    ctx.window.activePtyIds.add('starred');
  }, ctx => {
    const { orphanIds, rendered } = render(ctx, SESSIONS());
    assert.deepEqual(orphanIds, ['sub:gone:a1']);
    assert.equal(rendered('sub:plain:a1'), false);
  });
});

test('today filter: the subagent of a hidden parent is hidden, a missing parent stays an orphan', () => {
  withCtx(ctx => { ctx.window.showTodayOnly = true; }, ctx => {
    const { orphanIds, rendered } = render(ctx, SESSIONS());
    assert.deepEqual(orphanIds, ['sub:gone:a1']);
    assert.equal(rendered('sub:plain:a1'), false);
  });
});

test('no filter: a parent with subagents nests them, a missing parent still makes an orphan', () => {
  withCtx(() => {}, ctx => {
    const { orphanIds } = render(ctx, SESSIONS());
    assert.deepEqual(orphanIds, ['sub:gone:a1']);
    assert.ok(ctx.document.getElementById('subc-plain').querySelector('[data-subagent]'));
  });
});

test('search: a matching subagent whose parent exists is shown under its parent, not as an orphan', () => {
  withCtx(ctx => { ctx.window.searchMatchIds = new Set(['sub:plain:a1']); }, ctx => {
    const all = SESSIONS();
    const narrowed = ctx.window.narrowSessionsToSearch(all, ctx.window.searchMatchIds);
    const { orphanIds } = render(ctx, narrowed);
    assert.deepEqual(orphanIds, []);
    assert.ok(ctx.document.getElementById('subc-plain').querySelector('[data-session-id="sub:plain:a1"]'));
  });
});

test('search: a matching subagent whose parent is missing stays an orphan', () => {
  withCtx(ctx => { ctx.window.searchMatchIds = new Set(['sub:gone:a1']); }, ctx => {
    const narrowed = ctx.window.narrowSessionsToSearch(SESSIONS(), ctx.window.searchMatchIds);
    const { orphanIds } = render(ctx, narrowed);
    assert.deepEqual(orphanIds, ['sub:gone:a1']);
  });
});
