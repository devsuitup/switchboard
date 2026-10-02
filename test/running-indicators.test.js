// Tests for Q9: updateRunningIndicators() pty-set gating.
//
// updateRunningIndicators is extracted from the real public/app.js
// (test/app-source.js) and runs in the jsdom window of dom-setup.js, next to
// the real session-activity.js / sidebar.js / remote-activity-ui.js it calls
// into. Only the grid card map, which grid-view.js owns, is supplied by the
// test.
//
//   a) When activePtyIds is unchanged between calls, the two sidebar
//      querySelectorAll scans are skipped entirely.
//   b) When activePtyIds changes, the scans run and classes are updated.
//   c) The gridCards loop runs on every call (not gated) because sessionBusyState
//      can change independently of the pty-set.
//   d) Subagent rows and remote rows are exempt from the PTY-set purge.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

function addSessionItem(ctx, sessionId, { remoteAlias, subagent, withGroup } = {}) {
  const item = ctx.document.createElement('div');
  item.className = 'session-item';
  item.dataset.sessionId = sessionId;
  if (remoteAlias) item.dataset.remoteAlias = remoteAlias;
  if (subagent) item.dataset.subagent = '1';
  item.innerHTML = '<div class="session-icon"></div><span class="session-status-dot"></span>';
  const parent = withGroup || ctx.document.getElementById('sidebar-content');
  parent.appendChild(item);
  return item;
}

function addSlugGroup(ctx) {
  const group = ctx.document.createElement('div');
  group.className = 'slug-group';
  group.innerHTML = '<div class="slug-group-dot"></div>';
  ctx.document.getElementById('sidebar-content').appendChild(group);
  return group;
}

function withIndicators(fn) {
  const ctx = setupSidebarDom();
  try {
    ctx.window.gridCards = new Map();
    const { updateRunningIndicators } = loadAppFunctions(ctx.context, {
      declarations: ['_lastPtySignature'],
      functions: ['updateRunningIndicators'],
    });
    fn({ ctx, update: updateRunningIndicators });
  } finally {
    ctx.destroy();
  }
}

test('updateRunningIndicators: unchanged pty-set — sidebar querySelectorAll skipped', () => {
  withIndicators(({ ctx, update }) => {
    const group = addSlugGroup(ctx);
    const item1 = addSessionItem(ctx, 's1', { withGroup: group });
    addSessionItem(ctx, 's2', { withGroup: group });
    ctx.window.activePtyIds = new Set(['s1']);

    let qsaCallCount = 0;
    const origQsa = ctx.document.querySelectorAll.bind(ctx.document);
    ctx.document.querySelectorAll = (...args) => {
      if (args[0] === '.session-item' || args[0] === '.slug-group') qsaCallCount++;
      return origQsa(...args);
    };

    update();
    assert.equal(qsaCallCount, 2, 'first call: both .session-item and .slug-group scanned');
    assert.ok(item1.classList.contains('has-running-pty'), 's1 has-running-pty set on first call');

    qsaCallCount = 0;
    update();
    assert.equal(qsaCallCount, 0, 'second call with same pty-set: sidebar querySelectorAll NOT called');
  });
});

test('updateRunningIndicators: changed pty-set — sidebar scans run, classes updated', () => {
  withIndicators(({ ctx, update }) => {
    const group = addSlugGroup(ctx);
    const item1 = addSessionItem(ctx, 's1', { withGroup: group });
    const item2 = addSessionItem(ctx, 's2', { withGroup: group });
    ctx.window.activePtyIds = new Set(['s1']);

    update();
    assert.ok(item1.classList.contains('has-running-pty'), 's1 running after first call');
    assert.ok(!item2.classList.contains('has-running-pty'), 's2 not running');

    ctx.window.activePtyIds = new Set(['s2']);
    update();
    assert.ok(!item1.classList.contains('has-running-pty'), 's1 no longer running after set change');
    assert.ok(item2.classList.contains('has-running-pty'), 's2 now running');

    const groupDot = group.querySelector('.slug-group-dot');
    assert.ok(groupDot.classList.contains('running'), 'slug-group-dot running when s2 is running');

    ctx.window.activePtyIds = new Set();
    update();
    assert.ok(!groupDot.classList.contains('running'), 'slug-group-dot cleared once nothing runs');
  });
});

test('updateRunningIndicators: stale attention/response-ready/cli-busy cleared when pty stops', () => {
  withIndicators(({ ctx, update }) => {
    const item1 = addSessionItem(ctx, 's1');
    const clearedSubagentParents = [];
    const realClear = ctx.window.clearActiveSubagentsFor;
    ctx.window.clearActiveSubagentsFor = (id) => { clearedSubagentParents.push(id); return realClear(id); };
    ctx.window.activePtyIds = new Set(['s1']);

    ctx.setActivity('s1', true, 'onCliBusyState');
    ctx.attentionSessions.add('s1');
    ctx.responseReadySessions.add('s1');
    update();
    assert.ok(ctx.attentionSessions.has('s1'), 's1 attention preserved while running');
    assert.deepEqual(clearedSubagentParents, [], 'subagent state untouched while s1 runs');

    ctx.window.activePtyIds = new Set();
    item1.classList.add('needs-attention', 'response-ready', 'has-busy-agents');
    update();

    assert.ok(!ctx.attentionSessions.has('s1'), 'attentionSessions cleared when pty stops');
    assert.ok(!ctx.responseReadySessions.has('s1'), 'responseReadySessions cleared');
    assert.ok(!ctx.sessionBusyState.has('s1'), 'sessionBusyState cleared');
    assert.ok(!item1.classList.contains('cli-busy'), '.cli-busy removed');
    assert.ok(!item1.classList.contains('needs-attention'), '.needs-attention removed');
    assert.ok(!item1.classList.contains('response-ready'), '.response-ready removed');
    assert.ok(!item1.classList.contains('has-busy-agents'), '.has-busy-agents removed — a killed PTY never emits subagent-completed');
    assert.deepEqual(clearedSubagentParents, ['s1'], 'clearActiveSubagentsFor called so the sidebar state cannot resurrect the indicator');
  });
});

test('updateRunningIndicators: gridCards loop runs on every call, not gated by pty-set', () => {
  withIndicators(({ ctx, update }) => {
    const card = ctx.document.createElement('div');
    card.innerHTML = `
      <div class="grid-card-dot"></div>
      <div class="grid-card-footer"><span>Stopped</span></div>
      <button class="grid-card-stop-btn" style="display:none"></button>
    `;
    ctx.window.gridCards = new Map([['s1', card]]);
    ctx.window.activePtyIds = new Set(['s1']);
    ctx.sessionBusyState.set('s1', false);

    update();
    assert.equal(card.querySelector('.grid-card-dot').className, 'grid-card-dot running', 'grid card dot is running');
    assert.equal(card.querySelector('.grid-card-footer').children[0].textContent, 'Running', 'grid card footer shows Running');
    assert.equal(card.querySelector('.grid-card-stop-btn').style.display, '', 'stop button visible');

    ctx.sessionBusyState.set('s1', true);
    update();
    assert.equal(card.querySelector('.grid-card-dot').className, 'grid-card-dot busy',
      'grid card dot updated to busy on second call even though pty-set unchanged');

    ctx.window.activePtyIds = new Set();
    ctx.sessionBusyState.set('s1', false);
    update();
    assert.equal(card.querySelector('.grid-card-dot').className, 'grid-card-dot stopped');
    assert.equal(card.querySelector('.grid-card-stop-btn').style.display, 'none', 'stop button hidden once stopped');
  });
});

test('updateRunningIndicators: subagent items (dataset.subagent) are untouched by the pty-set scan (issue #129)', () => {
  // Without the guard, the scan runs `activePtyIds.has(id)` for the subagent's
  // own sessionId — always false, since subagents never own a PTY — and would
  // immediately clear the .running class that sidebar.js's subagent-spawned
  // listener just set.
  withIndicators(({ ctx, update }) => {
    const subagentItem = addSessionItem(ctx, 'sub:s-top-1:agent-1', { subagent: true });
    subagentItem.classList.add('running');
    subagentItem.querySelector('.session-icon').classList.add('running');
    ctx.window.activePtyIds = new Set(['s1']);
    update();

    ctx.window.activePtyIds = new Set(['s2']);
    update();

    assert.ok(subagentItem.classList.contains('running'), 'subagent item keeps .running across an unrelated pty-set change');
    assert.ok(subagentItem.querySelector('.session-icon').classList.contains('running'), 'subagent icon slot keeps .running');
    assert.ok(!subagentItem.classList.contains('has-running-pty'), 'subagent item never gets has-running-pty');
  });
});

test('updateRunningIndicators: empty pty-set — all sessions marked stopped', () => {
  withIndicators(({ ctx, update }) => {
    const items = [addSessionItem(ctx, 's1'), addSessionItem(ctx, 's2')];
    ctx.window.activePtyIds = new Set(['s1', 's2']);
    update();
    assert.ok(items.every((item) => item.classList.contains('has-running-pty')), 'precondition: both rows running');

    ctx.window.activePtyIds = new Set();
    update();

    for (const item of items) {
      assert.ok(!item.classList.contains('has-running-pty'),
        `${item.dataset.sessionId} must not have has-running-pty when idle`);
    }
  });
});

// ---------------------------------------------------------------------------
// F7 — remote rows are exempt from the PTY-set purge.
// ---------------------------------------------------------------------------

test('F7: a remote row busy via onRemoteActivityEvent stays .cli-busy across an unrelated local pty-set change', () => {
  withIndicators(({ ctx, update }) => {
    const localItem = addSessionItem(ctx, 'local-1');
    const remoteItem = addSessionItem(ctx, 'remote-1', { remoteAlias: 'vps' });

    ctx.window.onRemoteActivityEvent({ sessionId: 'remote-1' });
    assert.ok(remoteItem.classList.contains('cli-busy'), 'precondition: remote row busy via the real dispatcher');
    assert.equal(ctx.sessionBusyState.get('remote-1'), true);

    ctx.window.activePtyIds = new Set(['local-1']);
    update();
    assert.ok(remoteItem.classList.contains('cli-busy'), 'remote row still busy after a pass with local-1 running');

    ctx.window.activePtyIds = new Set();
    update();

    assert.ok(remoteItem.classList.contains('cli-busy'), 'remote row must NOT be purged by an unrelated local pty-set change');
    assert.equal(ctx.sessionBusyState.get('remote-1'), true, 'sessionBusyState for the remote row is untouched');
    assert.ok(!localItem.classList.contains('has-running-pty'), 'the local row is still correctly marked not running');
  });
});

test('F7: a local non-running row is still purged through purgeActivityFor', () => {
  withIndicators(({ ctx, update }) => {
    const localItem = addSessionItem(ctx, 'local-1');

    ctx.setActivity('local-1', true, 'onCliBusyState');
    ctx.window.activePtyIds = new Set(['local-1']);
    update();
    assert.ok(localItem.classList.contains('cli-busy'), 'precondition: local row busy while its pty runs');

    ctx.window.activePtyIds = new Set();
    update();

    assert.ok(!localItem.classList.contains('cli-busy'), 'a stopped local row must still be purged');
    assert.equal(ctx.sessionBusyState.has('local-1'), false, 'sessionBusyState entry dropped for the stopped local row');
  });
});
