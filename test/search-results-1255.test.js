'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

const PARENT = 's-top-1';
const SUB = 'sub:s-top-1:agent-1';

function withSearch(fn) {
  const ctx = setupSidebarDom();
  const { window, document } = ctx;
  const state = { rebuilds: 0, searches: [], reveals: [], loads: 0, results: [] };
  const inputEl = document.createElement('input');
  const status = document.createElement('div');
  status.id = 'search-status';
  status.hidden = true;
  document.body.appendChild(status);
  Object.assign(window, {
    searchInput: inputEl,
    searchBar: document.createElement('div'),
    activeTab: 'sessions',
    searchTitlesOnly: false,
    searchReveal: null,
    searchDebounceTimer: null,
    refreshSidebar: () => {},
    renderMemories: () => {},
    loadProjects: async () => { state.loads++; },
    requestAnimationFrame: cb => { cb(); return 1; },
    cancelAnimationFrame: () => {},
    api: {
      search: async (kind, query) => { state.searches.push(query); return state.results; },
      rebuildCache: async () => { state.rebuilds++; return { ok: true }; },
      remoteHostsRefresh: async () => {},
      searchRevealHidden: async ids => { state.reveals.push(ids); return { ok: true }; },
    },
  });
  const fns = loadAppFunctions(ctx.context, {
    declarations: ['MIN_SEARCH_CHARS', 'searchGeneration', 'clearRenderRaf', 'rebuildInFlight', 'searchRefreshBtn'],
    functions: ['clearSearch', 'resetSearchFilter', 'runSearchQuery', 'onSearchKeydown', 'triggerRebuildAndSearch',
      'endSessionSearch', 'dropSearchReveal', 'hiddenSearchHits', 'paintSearchStatus', 'revealHiddenSearchHits'],
  });
  return Promise.resolve(fn({ ...fns, ctx, window, document, state, inputEl, status })).finally(() => ctx.destroy());
}

const enter = () => ({ key: 'Enter', preventDefault() {} });

test('Enter searches the current index at once and never starts a full re-scan', () => withSearch(async ({ state, inputEl, onSearchKeydown, window }) => {
  state.results = [{ id: PARENT, snippet: 'a <mark>hit</mark>' }];
  window.cachedAllProjects = [makeSampleProject({ sessions: [{ sessionId: PARENT, summary: 'top', modified: '2026-11-01T00:00:00.000Z' }] })];
  inputEl.value = 'hit query';
  await onSearchKeydown(enter());
  assert.equal(state.rebuilds, 0, 'Enter must not call rebuildCache');
  assert.deepEqual(state.searches, ['hit query']);
  assert.deepEqual([...window.searchMatchIds], [PARENT]);
  assert.equal(window.searchSnippets.get(PARENT), 'a <mark>hit</mark>');
}));

test('the refresh button keeps the full re-scan before searching', () => withSearch(async ({ state, inputEl, triggerRebuildAndSearch }) => {
  inputEl.value = 'abc';
  await triggerRebuildAndSearch();
  assert.equal(state.rebuilds, 1);
  assert.deepEqual(state.searches, ['abc']);
}));

test('hits only in hidden sessions say so and offer a one-shot reveal', () => withSearch(async ({ state, inputEl, runSearchQuery, status, window }) => {
  window.cachedAllProjects = [makeSampleProject({ sessions: [{ sessionId: PARENT, summary: 'top', modified: '2026-11-01T00:00:00.000Z' }] })];
  state.results = [{ id: 'hidden-1', snippet: null }, { id: 'hidden-2', snippet: null }];
  inputEl.value = 'planifiées';
  await runSearchQuery();
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /2 matches in hidden sessions/);
  const show = status.querySelector('button');
  assert.ok(show, 'a Show button is offered');
  show.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(state.reveals, [['hidden-1', 'hidden-2']], 'the reveal names the hidden hits, not a setting');
  assert.equal(state.loads, 1, 'projects reload after the reveal');
  assert.equal(state.searches.length, 2, 'the search runs again over the revealed projects');
  assert.equal(status.querySelector('button'), null, 'no second Show once revealed');

  inputEl.value = 'another query';
  await runSearchQuery();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([...state.reveals.at(-1)], [], 'a new query drops the reveal');
}));

test('no hit at all shows the empty-state message; a visible hit clears it', () => withSearch(async ({ state, inputEl, runSearchQuery, status, window }) => {
  window.cachedAllProjects = [makeSampleProject({ sessions: [{ sessionId: PARENT, summary: 'top', modified: '2026-11-01T00:00:00.000Z' }] })];
  inputEl.value = 'nothing here';
  await runSearchQuery();
  assert.match(status.textContent, /No sessions match/);
  state.results = [{ id: PARENT, snippet: null }];
  await runSearchQuery();
  assert.equal(status.hidden, true);
}));

test('a subagent hit opens its group and shows the matched snippet', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({ sessions: [
      { sessionId: PARENT, summary: 'top level', modified: '2026-11-01T10:00:00.000Z', messageCount: 4 },
      { sessionId: SUB, parentSessionId: PARENT, agentId: 'agent-1', subagentType: 'explore', description: 'explore',
        modified: '2026-11-01T09:00:00.000Z', messageCount: 2 },
    ] });
    ctx.window.searchMatchIds = new Set([SUB]);
    ctx.window.searchSnippets = new Map([[SUB, 'opened PR <mark>#1243</mark> <b>raw</b>']]);
    ctx.sidebar.renderProjects([project], true);
    const container = ctx.document.getElementById('subc-' + PARENT.replace(/[^a-zA-Z0-9_-]/g, '_'));
    assert.ok(container, 'the subagent group is rendered under its parent');
    assert.notEqual(container.style.display, 'none', 'the group holding the hit is open');
    const snippet = ctx.document.getElementById('si-' + SUB).querySelector('.session-search-snippet');
    assert.ok(snippet, 'the subagent row shows its snippet');
    assert.equal(snippet.querySelector('mark').textContent, '#1243');
    assert.equal(snippet.querySelector('b'), null, 'snippet text is escaped except for the match marks');
  } finally {
    ctx.destroy();
  }
});

test('a subagent group already rendered collapsed opens for a hit through reconciliation, and closes when the search ends', () => {
  const ctx = setupSidebarDom();
  try {
    const project = () => makeSampleProject({ sessions: [
      { sessionId: PARENT, summary: 'top level', modified: '2026-11-01T10:00:00.000Z', messageCount: 4 },
      { sessionId: SUB, parentSessionId: PARENT, agentId: 'agent-1', subagentType: 'explore', description: 'explore',
        modified: '2026-11-01T09:00:00.000Z', messageCount: 2 },
    ] });
    const container = () => ctx.document.getElementById('subc-' + PARENT.replace(/[^a-zA-Z0-9_-]/g, '_'));
    ctx.sidebar.renderProjects([project()], true);
    assert.equal(container().style.display, 'none', 'starts collapsed');
    const before = container();
    ctx.window.searchMatchIds = new Set([SUB]);
    ctx.window.searchSnippets = new Map();
    ctx.sidebar.renderProjects([project()], true);
    assert.equal(container(), before, 'the same node is reconciled, not replaced');
    assert.notEqual(container().style.display, 'none', 'the search opens the existing group');
    ctx.sidebar.renderProjects([project()], true);
    assert.notEqual(container().style.display, 'none', 'it stays open across a re-render during the search');
    ctx.window.searchMatchIds = null;
    ctx.window.searchSnippets = null;
    ctx.sidebar.renderProjects([project()], true);
    assert.equal(container().style.display, 'none', 'the saved collapsed state returns when the search ends');
  } finally {
    ctx.destroy();
  }
});
