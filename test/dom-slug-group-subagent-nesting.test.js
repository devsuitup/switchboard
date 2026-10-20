const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, answerChoiceDialog } = require('./dom-setup');

function scheduleRerunProject({ subagentParentId = 'sched-run-2', ...overrides } = {}) {
  const baseTime = Date.parse('2026-08-20T09:00:00Z');
  const t = (offsetMs) => new Date(baseTime + offsetMs).toISOString();
  // summary as read-session-file.js derives it for a createScheduleSession()
  // JSONL: the first user message is `'Scheduled Task: ' + schedule.prompt`,
  // which doesn't match the <scheduled-task name="..."> tag pattern, so it
  // falls through to text.slice(0, 120).
  const summary = 'Scheduled Task: Check Hacker News for the current top article and any posts related to AI docume';

  return {
    projectPath: '/home/dev/hn-watcher',
    sessions: [
      {
        sessionId: 'sched-run-1',
        scheduleSlug: 'hn-top-articles',
        summary,
        firstPrompt: summary,
        modified: t(-120000), // an earlier rerun
        messageCount: 1,
        starred: false,
        archived: 0,
      },
      {
        sessionId: 'sched-run-2',
        scheduleSlug: 'hn-top-articles',
        summary,
        firstPrompt: summary,
        modified: t(0), // the current (running) rerun
        messageCount: 1,
        starred: false,
        archived: 0,
      },
      {
        sessionId: `sub:${subagentParentId}:agent-1`,
        parentSessionId: subagentParentId,
        agentId: 'agent-1',
        subagentType: 'explore',
        description: 'explore subagent',
        modified: t(-1000),
        messageCount: 1,
      },
    ],
    ...overrides,
  };
}

test('a session rendered inside a slug group still gets its subagent children attached', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('sched-run-2');
    ctx.sidebar.renderProjects([scheduleRerunProject()], true);

    const group = ctx.document.querySelector('.slug-group');
    assert.ok(group, 'the two schedule reruns must be grouped by shared slug');
    assert.ok(group.classList.contains('slug-group'), 'grouped element must carry slug-group');

    const groupedSessionItems = group.querySelectorAll('.session-item:not([data-subagent])');
    assert.equal(groupedSessionItems.length, 2, 'both reruns render as session-items inside the group');

    const caret = ctx.document.getElementById('sub-caret-sched-run-2');
    assert.ok(caret, 'subagent caret for the grouped, running rerun must exist');
    assert.ok(group.contains(caret), 'the caret must be nested inside the slug group, next to its parent session-item');

    const subagentItem = ctx.document.getElementById('si-sub:sched-run-2:agent-1');
    assert.ok(subagentItem, 'the subagent item must be rendered');
    assert.ok(group.contains(subagentItem), 'the subagent item must be nested inside the slug group, not dropped to the orphan bucket');
  } finally {
    ctx.destroy();
  }
});

test('the grouped session\'s subagent is not duplicated into the project\'s orphan-subagents bucket', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('sched-run-2');
    ctx.sidebar.renderProjects([scheduleRerunProject()], true);

    const orphanGroup = ctx.document.querySelector('.sidebar-orphan-subagents');
    assert.ok(!orphanGroup, 'a subagent whose parent is a grouped session is not an orphan — no orphan bucket should render');
  } finally {
    ctx.destroy();
  }
});

test('the slug-group dot lights up while one of the grouped, nested sessions has an active PTY', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('sched-run-2');
    ctx.sidebar.renderProjects([scheduleRerunProject()], true);

    const dot = ctx.document.querySelector('.slug-group .slug-group-dot');
    assert.ok(dot, 'slug-group-dot must be rendered');
    assert.ok(dot.classList.contains('running'), 'group dot must reflect that sched-run-2 has an active PTY');
  } finally {
    ctx.destroy();
  }
});

// PR #134 review F1 — nesting the subagent's caret/children as DOM siblings
// inside the group (the fix above) means group.querySelectorAll('.session-item')
// in the "Archive all sessions in group" handler now also matches the nested
// subagent item (buildSubagentItem's className includes 'session-item' for
// shared styling), so the handler must exclude it the same way every other
// subagent-item consumer in this file does (:not([data-subagent])).
test('"Archive all sessions in group" only archives the two top-level reruns, not the nested subagent', async () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('sched-run-2');
    ctx.window.sessionMap.set('sched-run-1', { sessionId: 'sched-run-1', archived: 0 });
    ctx.window.sessionMap.set('sched-run-2', { sessionId: 'sched-run-2', archived: 0 });
    ctx.window.sessionMap.set('sub:sched-run-2:agent-1', { sessionId: 'sub:sched-run-2:agent-1', archived: 0 });

    const archiveCalls = [];
    const stopCalls = [];
    ctx.window.api.archiveSession = (sid, val) => { archiveCalls.push([sid, val]); return Promise.resolve({ ok: true }); };
    ctx.window.api.stopSession = (sid) => { stopCalls.push(sid); return Promise.resolve({ ok: true }); };

    ctx.sidebar.renderProjects([scheduleRerunProject()], true);

    const archiveBtn = ctx.document.querySelector('.slug-group .slug-group-archive-btn');
    assert.ok(archiveBtn, 'slug-group-archive-btn must be rendered');
    const pending = archiveBtn.onclick({ stopPropagation: () => {} });
    await answerChoiceDialog(ctx, { confirm: true });
    await pending;

    const archivedIds = archiveCalls.map(([sid]) => sid).sort();
    assert.deepEqual(archivedIds, ['sched-run-1', 'sched-run-2'],
      'only the two top-level reruns must be archived — the nested subagent must not reach archiveSession');
    assert.ok(!stopCalls.includes('sub:sched-run-2:agent-1'),
      'the nested subagent must not reach stopSession either');
  } finally {
    ctx.destroy();
  }
});

// Adversarial review of #134 found buildSlugGroup() calling appendSubagentChildren
// from three separate loops (promoted / rest-under-"more" / all-sessions-else) and
// only the first was exercised — see .ai/contexts/subagent-observability.md.
test('a session in the "+N more" (non-promoted) part of a slug group still gets its subagent children attached', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('sched-run-2'); // only sched-run-2 is promoted; sched-run-1 lands in "rest"
    ctx.sidebar.renderProjects([scheduleRerunProject({ subagentParentId: 'sched-run-1' })], true);

    const group = ctx.document.querySelector('.slug-group');
    assert.ok(group, 'the two schedule reruns must be grouped by shared slug');
    assert.ok(group.classList.contains('has-promoted'), 'sched-run-2 being active must promote it, pushing sched-run-1 into rest');

    const olderDiv = ctx.document.getElementById('sgo-' + group.id);
    assert.ok(olderDiv, 'the "+N more" container must be rendered since rest.length > 0');

    const caret = ctx.document.getElementById('sub-caret-sched-run-1');
    assert.ok(caret, 'subagent caret for the non-promoted rerun must exist');
    assert.ok(olderDiv.contains(caret), 'the caret must be nested inside the "+N more" container, next to its parent session-item');

    const subagentItem = ctx.document.getElementById('si-sub:sched-run-1:agent-1');
    assert.ok(subagentItem, 'the subagent item must be rendered');
    assert.ok(olderDiv.contains(subagentItem), 'the subagent item must be nested inside the "+N more" container, not dropped to the orphan bucket');
  } finally {
    ctx.destroy();
  }
});

test('a session in a slug group with no active PTY at all still gets its subagent children attached', () => {
  const ctx = setupSidebarDom();
  try {
    // No session in this group has an active PTY, so buildSlugGroup() takes
    // the plain "all sessions" branch rather than the promoted/rest split.
    ctx.sidebar.renderProjects([scheduleRerunProject({ subagentParentId: 'sched-run-2' })], true);

    const group = ctx.document.querySelector('.slug-group');
    assert.ok(group, 'the two schedule reruns must be grouped by shared slug');
    assert.ok(!group.classList.contains('has-promoted'), 'no session is active, so the group must not be in the promoted state');

    const caret = ctx.document.getElementById('sub-caret-sched-run-2');
    assert.ok(caret, 'subagent caret must exist even when no session in the group is running');
    assert.ok(group.contains(caret), 'the caret must be nested inside the slug group, next to its parent session-item');

    const subagentItem = ctx.document.getElementById('si-sub:sched-run-2:agent-1');
    assert.ok(subagentItem, 'the subagent item must be rendered');
    assert.ok(group.contains(subagentItem), 'the subagent item must be nested inside the slug group, not dropped to the orphan bucket');
  } finally {
    ctx.destroy();
  }
});
