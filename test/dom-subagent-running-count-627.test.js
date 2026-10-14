'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { createTaskRegistry } = require('../public/task-registry');

const PARENT = 'parent-627';
const AT = Date.parse('2026-10-14T10:00:00Z');

function setup(t, overrides = {}) {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const parent = { sessionId: PARENT, name: 'Counted conversation', modified: new Date(AT).toISOString(), ...overrides };
  ctx.window.sessionMap.set(PARENT, parent);
  return { ctx, parent, registry: ctx.window.taskRegistry };
}

function snapshot(registry, parentId, tasks, revision = 1, known = true) {
  registry.applySnapshot({ parentSessionId: parentId, revision, known, tasks: tasks.map(t => ({ at: AT, terminal: false, kind: 'agent', ...t })) });
}

function render(ctx, parent, children = []) {
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: [parent, ...children] })], true);
  return ctx.document.getElementById('si-' + PARENT);
}

function label(row, text) {
  const count = row.querySelector('.session-subagent-count');
  if (text === null) {
    assert.equal(count, null, 'zero and unknown add no text');
    return;
  }
  assert.ok(count, 'running count is present');
  assert.equal(count.textContent, text);
  assert.equal(count.getAttribute('aria-label'), text);
  assert.ok(row.querySelector('.session-info').contains(count));
  assert.equal(count.closest('.session-info').querySelector('.session-summary').compareDocumentPosition(count) & 4, 4, 'count follows title');
  assert.equal(row.querySelectorAll('.session-icon').length, 1, 'one status glyph');
  assert.equal(count.querySelector('svg, .session-icon, .badge'), null);
}

test('#627 sidebar counts agents A/B before child metadata and excludes shell/Monitor/cron', t => {
  const { ctx, parent, registry } = setup(t);
  ctx.window.activePtyIds.add(PARENT);
  ctx.emitHeadTurn(PARENT, 'closed');
  const row = render(ctx, parent);
  snapshot(registry, PARENT, [{ id: 'A' }, { id: 'B' }, { id: 'shell', kind: 'bash' }, { id: 'watch', kind: 'monitor' }, { id: 'schedule', kind: 'cron' }]);
  label(row, '2 subagents running');
  assert.equal(row.querySelector('.session-icon').title, 'Background work running');
  assert.ok(row.querySelector('.session-icon').classList.contains('session-icon--agents-busy'));
  assert.equal(ctx.document.querySelector('[data-subagent]'), null);
  label(ctx.sidebar.buildSessionItem(parent), '2 subagents running');
  snapshot(registry, PARENT, [{ id: 'A', terminal: true }, { id: 'B', terminal: true }, { id: 'shell', kind: 'bash' }, { id: 'watch', kind: 'monitor' }, { id: 'schedule', kind: 'cron' }], 2);
  label(row, null);
  assert.equal(row.querySelector('.session-icon').title, 'Background work running');
  assert.equal(row.querySelectorAll('.session-icon').length, 1);
});

test('#627 completion and replay update two to one to no count without a rebuild', t => {
  const { ctx, parent, registry } = setup(t);
  const row = render(ctx, parent);
  const tasks = [{ id: 'A' }, { id: 'B' }];
  snapshot(registry, PARENT, tasks);
  label(row, '2 subagents running');
  tasks[0].terminal = true;
  snapshot(registry, PARENT, tasks, 2);
  label(row, '1 subagent running');
  snapshot(registry, PARENT, tasks, 2);
  label(row, '1 subagent running');
  snapshot(registry, PARENT, tasks, 3);
  label(row, '1 subagent running');
  tasks[1].terminal = true;
  snapshot(registry, PARENT, tasks, 4);
  label(row, null);
});

test('#627 unknown, inferred activity, and known zero show no row count', t => {
  const { ctx, parent, registry } = setup(t);
  const row = render(ctx, parent);
  assert.equal(registry.known(PARENT), false);
  label(row, null);
  ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: 'fallback' });
  ctx.emitSessionTranscriptActivity({ parentSessionId: PARENT, agentId: 'fallback', at: AT, kind: 'subagent' });
  assert.equal(registry.agents(PARENT).length, 1);
  label(row, null);
  snapshot(registry, PARENT, []);
  assert.equal(registry.known(PARENT), true);
  label(row, null);
  label(ctx.sidebar.buildSessionItem(parent), null);
});

test('#627 duplicate adapters do not multiply a primary task and ten-minute silence retains its count', t => {
  const { ctx, parent, registry } = setup(t);
  snapshot(registry, PARENT, [{ id: 'A' }]);
  const row = render(ctx, parent);
  for (const source of ['local-ipc', 'attached-ipc', 'remote-watch', 'local-transcript']) registry.note(PARENT, 'A', source);
  label(row, '1 subagent running');
  const now = ctx.window.Date.now();
  ctx.window.Date.now = () => now + 600001;
  ctx.window.runSubagentTtlTick();
  label(row, '1 subagent running');
  label(render(ctx, parent), '1 subagent running');
});

test('#627 collapsed, expanded, capped, filtered and rebuilt children keep the full count', t => {
  const { ctx, parent, registry } = setup(t);
  snapshot(registry, PARENT, [{ id: 'A' }, { id: 'B' }]);
  const children = Array.from({ length: 25 }, (_, i) => ({ sessionId: `sub:${PARENT}:history-${i}`, parentSessionId: PARENT, agentId: `history-${i}`, modified: new Date(AT + i).toISOString() }));
  let row = render(ctx, parent, children);
  label(row, '2 subagents running');
  assert.equal(ctx.document.querySelectorAll('[data-subagent]').length, 10);
  const caret = ctx.document.getElementById(ctx.window.caretIdFor(PARENT));
  caret.click();
  label(row, '2 subagents running');
  ctx.document.querySelector('.subagents-more-toggle').click();
  assert.equal(ctx.document.querySelectorAll('[data-subagent]').length, 25);
  label(row, '2 subagents running');
  caret.click();
  row = render(ctx, parent, children);
  label(row, '2 subagents running');
  ctx.window.searchMatchIds = new Set([children[0].sessionId]);
  const filtered = ctx.window.narrowSessionsToSearch([parent, ...children], ctx.window.searchMatchIds);
  ctx.sidebar.renderProjects([makeSampleProject({ sessions: filtered })], true);
  label(ctx.document.getElementById('si-' + PARENT), '2 subagents running');
  assert.equal(ctx.document.querySelectorAll('[data-subagent]').length, 1);
});

test('#627 merged continuation members deduplicate tasks and refresh on a member-only snapshot', t => {
  const { ctx, parent, registry } = setup(t, { mergedMemberIds: [PARENT, 'continued-627'], headSessionId: 'continued-627' });
  snapshot(registry, PARENT, [{ id: 'A' }]);
  snapshot(registry, 'continued-627', [{ id: 'A' }, { id: 'B' }]);
  const row = render(ctx, parent);
  label(row, '2 subagents running');
  snapshot(registry, 'continued-627', [{ id: 'A' }, { id: 'B', terminal: true }], 2);
  label(row, '1 subagent running');
  registry.rekey(PARENT, 'continued-627', { continued: true });
  label(ctx.sidebar.buildSessionItem(parent), '1 subagent running');
});

test('#627 registry ingestion launches, correlates and completes the displayed task exactly once', t => {
  const { ctx, parent } = setup(t);
  const row = render(ctx, parent);
  const registry = createTaskRegistry({ onChange: s => ctx.emitTaskSnapshot(s) });
  const entry = (type, content, extra = {}) => ({ type, timestamp: new Date(AT).toISOString(), message: { role: type, content }, ...extra });
  registry.ingest(PARENT, entry('assistant', [{ type: 'tool_use', id: 'call-A', name: 'Agent', input: { run_in_background: true } }]));
  label(row, '1 subagent running');
  registry.ingest(PARENT, entry('user', [{ type: 'tool_result', tool_use_id: 'call-A' }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'A' } }));
  label(row, '1 subagent running');
  registry.ingest(PARENT, entry('user', '<task-notification><task-id>A</task-id><tool-use-id>call-A</tool-use-id><status>completed</status><output-file>/tmp/tasks/A.output</output-file></task-notification>', { origin: { kind: 'task-notification' } }));
  label(row, null);
});

test('#627 child and caret have no green running dot and host reachability remains', t => {
  const { ctx, parent, registry } = setup(t);
  snapshot(registry, PARENT, [{ id: 'A' }]);
  const child = { sessionId: `sub:${PARENT}:A`, parentSessionId: PARENT, agentId: 'A', modified: new Date(AT).toISOString() };
  const row = render(ctx, parent, [child]);
  label(row, '1 subagent running');
  assert.equal(ctx.document.querySelector('.caret-running-dot, .sidebar-subagent .session-icon.running'), null);
  ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: 'A' });
  assert.equal(ctx.document.querySelector('.caret-running-dot, .sidebar-subagent .session-icon.running'), null);
  assert.equal(ctx.document.querySelector('.sidebar-subagent.running, .has-running-child'), null);
  ctx.sidebar.renderProjects([makeSampleProject({ remoteAlias: 'vps', remoteStatus: 'connected', sessions: [parent, child] })], true);
  assert.ok(ctx.document.querySelector('.remote-host-dot'), 'host reachability indicator remains');
});

for (const visible of [true, false]) {
  test(`#627 head-keyed grid counts a sibling member with sidebar visible=${visible}`, t => {
    const head = 'head-627';
    const { ctx, parent, registry } = setup(t, { mergedMemberIds: [PARENT, head], headSessionId: head });
    if (!visible) ctx.window.indexLocalMergedMemberRows([makeSampleProject({ sessions: [parent] })]);
    render(ctx, parent);
    ctx.window.sessionMap.set(head, { sessionId: head, mergedMemberIds: [] });
    ctx.window.openSessions.set(head, { session: { sessionId: head, mergedMemberIds: [] } });
    if (!visible) ctx.document.getElementById('si-' + PARENT).remove();
    ctx.evalPublic('shortcuts.js');
    ctx.evalPublic('grid-view.js');
    const card = ctx.document.createElement('div');
    card.innerHTML = '<div class="grid-card-header"></div>';
    ctx.window.testCountCard = card;
    ctx.read(`gridCards.set('${head}', window.testCountCard)`);
    snapshot(registry, PARENT, [{ id: 'sibling-agent' }]);
    assert.equal(card.querySelector('.grid-subagent-count')?.textContent, '1 subagent running');
    if (visible) label(ctx.document.getElementById('si-' + PARENT), '1 subagent running');
    snapshot(registry, PARENT, [], 2);
    assert.equal(card.querySelector('.grid-subagent-count'), null);
  });
}

test('#627 TTL refresh visits each grid card once', t => {
  const { ctx, registry } = setup(t);
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  const reads = [];
  for (const id of [PARENT, 'another-627', 'third-627']) {
    const card = ctx.document.createElement('div');
    card.innerHTML = '<div class="grid-card-header"></div>';
    ctx.window.testCountCard = card;
    ctx.read(`gridCards.set('${id}', window.testCountCard)`);
    snapshot(registry, id, [{ id: 'agent-' + id }]);
    const query = card.querySelector.bind(card);
    card.querySelector = selector => {
      if (selector === '.grid-subagent-count') reads.push(id);
      return query(selector);
    };
  }
  const lookups = [];
  const getSession = ctx.window.sessionMap.get.bind(ctx.window.sessionMap);
  ctx.window.sessionMap.get = id => {
    lookups.push(id);
    return getSession(id);
  };
  ctx.window.runGridSubagentTtlTick();
  assert.deepEqual(reads, [PARENT, 'another-627', 'third-627']);
  assert.deepEqual(lookups, [PARENT, 'another-627', 'third-627']);
});

test('#627 grid replaces pills with a pluralized count under its header and follows merged members', t => {
  const { ctx, registry } = setup(t, { mergedMemberIds: ['continued-627'] });
  ctx.evalPublic('shortcuts.js');
  ctx.evalPublic('grid-view.js');
  const card = ctx.document.createElement('div');
  card.innerHTML = '<div class="grid-card-header"><span class="grid-card-dot"></span><span class="grid-card-name">Counted conversation</span></div><div class="grid-card-footer"></div>';
  ctx.window.testCountCard = card;
  ctx.read(`gridCards.set('${PARENT}', window.testCountCard)`);
  snapshot(registry, PARENT, [{ id: 'A' }]);
  snapshot(registry, 'continued-627', [{ id: 'A' }, { id: 'B' }, { id: 'shell', kind: 'bash' }]);
  const count = card.querySelector('.grid-subagent-count');
  assert.ok(count, 'grid count present');
  assert.equal(count.textContent, '2 subagents running');
  assert.equal(count.getAttribute('aria-label'), '2 subagents running');
  assert.equal(card.querySelector('.grid-card-header').nextElementSibling, count);
  assert.equal(card.querySelector('.grid-subagent-pill, .grid-subagent-pills'), null);
  assert.equal(card.querySelectorAll('.grid-card-dot').length, 1);
  snapshot(registry, 'continued-627', [{ id: 'A' }], 2);
  assert.equal(count.textContent, '1 subagent running');
  snapshot(registry, PARENT, [], 2);
  snapshot(registry, 'continued-627', [], 3);
  assert.equal(card.querySelector('.grid-subagent-count'), null);
  ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: 'fallback' });
  assert.equal(card.querySelector('.grid-subagent-count'), null);
});
