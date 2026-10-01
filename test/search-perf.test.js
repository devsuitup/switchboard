// Tests for the two search-perf fixes in public/app.js:
//
//   Fix 1 — minimum 3 characters: queries shorter than MIN_SEARCH_CHARS must
//     NOT call window.api.search, must NOT clear the input value, but MUST
//     reset the filter state (searchMatchIds = null) and refresh.
//
//   Fix 2 (order correctness) — clearSearch() and resetSearchFilter() must pass
//     resort:true to refreshSidebar. Using resort:false is unsound: renderProjects
//     overwrites sortedOrder with only the matched-project subset during a search,
//     so clearing with resort:false would sort the full list against a stale index
//     and produce a scrambled sidebar order.
//
// clearSearch, resetSearchFilter and runSearchQuery are extracted from the real
// public/app.js (test/app-source.js) and run in the jsdom window of
// dom-setup.js. The sidebar refresh, the memory/work-file renderers, the IPC
// search and the animation-frame queue are stubbed so the tests can observe them.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions } = require('./app-source');

async function withSearch(fn) {
  const ctx = setupSidebarDom();
  try {
    const { window, document } = ctx;
    const state = {
      refreshSidebarCalls: [],
      renderMemoriesCalls: [],
      renderWorkFilesCalls: [],
      apiSearchCalls: [],
      apiResults: [],
      frames: new Map(),
      nextFrame: 1,
    };
    const inputEl = document.createElement('input');
    window.searchInput = inputEl;
    window.searchBar = document.createElement('div');
    window.activeTab = 'sessions';
    window.searchTitlesOnly = false;
    window.refreshSidebar = (opts) => state.refreshSidebarCalls.push(opts);
    window.renderMemories = (ids) => state.renderMemoriesCalls.push(ids);
    window.renderWorkFiles = (ids) => state.renderWorkFilesCalls.push(ids);
    window.requestAnimationFrame = (cb) => { const id = state.nextFrame++; state.frames.set(id, cb); return id; };
    window.cancelAnimationFrame = (id) => { state.frames.delete(id); };
    window.api = {
      search: async (kind, query, titlesOnly) => {
        state.apiSearchCalls.push({ kind, query, titlesOnly });
        return state.apiResults;
      },
    };
    const flushFrames = () => {
      const pending = [...state.frames.values()];
      state.frames.clear();
      for (const cb of pending) cb();
    };
    const fns = loadAppFunctions(ctx.context, {
      declarations: ['MIN_SEARCH_CHARS', 'searchDebounceTimer', 'clearRenderRaf'],
      functions: ['clearSearch', 'resetSearchFilter', 'runSearchQuery'],
    });
    await fn({ ...fns, state, inputEl, window, flushFrames });
  } finally {
    ctx.destroy();
  }
}

// ---------------------------------------------------------------------------
// Fix 1: minimum 3 characters
// ---------------------------------------------------------------------------

test('search: 2-char query does NOT call api.search and does NOT clear input', async () => {
  await withSearch(async ({ state, inputEl, runSearchQuery }) => {
    inputEl.value = 'ab';
    await runSearchQuery();

    assert.equal(state.apiSearchCalls.length, 0, 'api.search must not be called for a 2-char query');
    assert.equal(inputEl.value, 'ab', 'input value must be preserved (not cleared)');
  });
});

test('search: 2-char query resets filter state (searchMatchIds = null)', async () => {
  await withSearch(async ({ inputEl, window, runSearchQuery }) => {
    window.searchMatchIds = new Set(['old-session']);
    window.searchMatchProjectPaths = new Set(['/old']);
    inputEl.value = 'ab';
    await runSearchQuery();

    assert.equal(window.searchMatchIds, null, 'searchMatchIds must be reset to null');
    assert.equal(window.searchMatchProjectPaths, null, 'searchMatchProjectPaths must be reset to null');
  });
});

test('search: 2-char query calls refreshSidebar (to show unfiltered list)', async () => {
  await withSearch(async ({ state, inputEl, runSearchQuery, flushFrames }) => {
    inputEl.value = 'ab';
    await runSearchQuery();
    flushFrames();

    assert.equal(state.refreshSidebarCalls.length, 1, 'refreshSidebar must be called once');
  });
});

test('search: 1-char query behaves the same as 2-char (below threshold)', async () => {
  await withSearch(async ({ state, inputEl, runSearchQuery }) => {
    inputEl.value = 'a';
    await runSearchQuery();

    assert.equal(state.apiSearchCalls.length, 0, 'api.search must not be called for a 1-char query');
    assert.equal(inputEl.value, 'a', 'input value must be preserved');
  });
});

test('search: "  ab  " (2 trimmed chars) does NOT call api.search', async () => {
  await withSearch(async ({ state, inputEl, runSearchQuery }) => {
    inputEl.value = '  ab  ';
    await runSearchQuery();

    assert.equal(state.apiSearchCalls.length, 0, 'trim semantics: 2 trimmed chars must not trigger search');
    assert.equal(inputEl.value, '  ab  ', 'input value must be preserved');
  });
});

test('search: 3-char query DOES call api.search', async () => {
  await withSearch(async ({ state, inputEl, runSearchQuery }) => {
    inputEl.value = 'abc';
    await runSearchQuery();

    assert.equal(state.apiSearchCalls.length, 1);
    assert.equal(state.apiSearchCalls[0].query, 'abc');
    assert.equal(state.apiSearchCalls[0].kind, 'session');
  });
});

test('search: empty query calls clearSearch (wipes input value)', async () => {
  await withSearch(async ({ state, inputEl, runSearchQuery, flushFrames }) => {
    inputEl.value = '';
    await runSearchQuery();
    flushFrames();

    assert.equal(inputEl.value, '', 'empty query triggers full clearSearch');
    assert.equal(state.refreshSidebarCalls.length, 1);
    assert.equal(state.apiSearchCalls.length, 0);
  });
});

test('search: whitespace-only query is treated as empty', async () => {
  await withSearch(async ({ state, inputEl, runSearchQuery, flushFrames }) => {
    inputEl.value = '   ';
    await runSearchQuery();
    flushFrames();

    assert.equal(inputEl.value, '', 'a blank query is cleared like an empty one');
    assert.equal(state.apiSearchCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: clear-search path calls refreshSidebar with resort:true
// (resort:false was unsound — sortedOrder is overwritten with only the
//  matched subset during a search, so clearing with resort:false scrambles
//  the full project list order)
// ---------------------------------------------------------------------------

test('clearSearch: calls refreshSidebar with resort:true (not resort:false)', async () => {
  await withSearch(async ({ state, window, clearSearch, flushFrames }) => {
    window.searchMatchIds = new Set(['s1', 's2']);
    clearSearch();
    flushFrames();

    assert.equal(state.refreshSidebarCalls.length, 1, 'refreshSidebar called exactly once on clear');
    assert.equal(state.refreshSidebarCalls[0].resort, true,
      'clearSearch must pass resort:true — sortedOrder is stale after a search');
  });
});

test('clearSearch: resets searchMatchIds and searchMatchProjectPaths', async () => {
  await withSearch(async ({ window, clearSearch }) => {
    window.searchMatchIds = new Set(['s1']);
    window.searchMatchProjectPaths = new Set(['/home/dev/proj']);
    clearSearch();

    assert.equal(window.searchMatchIds, null);
    assert.equal(window.searchMatchProjectPaths, null);
  });
});

test('clearSearch: defers the rebuild to an animation frame, and rapid clears queue only one', async () => {
  await withSearch(async ({ state, clearSearch, flushFrames }) => {
    clearSearch();
    clearSearch();
    assert.equal(state.refreshSidebarCalls.length, 0, 'the heavy rebuild must wait for the next frame');

    flushFrames();

    assert.equal(state.refreshSidebarCalls.length, 1, 'two clears before a frame fires must rebuild once');
  });
});

test('resetSearchFilter: calls refreshSidebar with resort:true (not resort:false)', async () => {
  // Sequence: user types 3+ chars (search runs, searchMatchIds populated),
  // then deletes back to 2 chars — resetSearchFilter must re-sort from data
  // because sortedOrder was overwritten to contain only the matched subset.
  await withSearch(async ({ state, window, resetSearchFilter, flushFrames }) => {
    window.searchMatchIds = new Set(['session-x']);
    resetSearchFilter();
    flushFrames();

    assert.equal(state.refreshSidebarCalls.length, 1, 'refreshSidebar called once');
    assert.equal(state.refreshSidebarCalls[0].resort, true,
      'resetSearchFilter must pass resort:true — sortedOrder is stale after prior search');
  });
});

test('search: delete from 3+ chars to 2 chars resets filter (sequence scenario)', async () => {
  await withSearch(async ({ state, inputEl, window, runSearchQuery, flushFrames }) => {
    state.apiResults = [{ id: 'hit-1' }];
    inputEl.value = 'abc';
    await runSearchQuery();
    assert.deepEqual([...window.searchMatchIds], ['hit-1'], 'search must have set searchMatchIds');

    inputEl.value = 'ab';
    await runSearchQuery();
    flushFrames();

    assert.equal(window.searchMatchIds, null, 'searchMatchIds must be cleared after drop to 2 chars');
    assert.equal(window.searchMatchProjectPaths, null, 'searchMatchProjectPaths must be cleared');
    assert.equal(state.refreshSidebarCalls.length, 2, 'refreshSidebar called for the search and for the reset');
    assert.equal(state.refreshSidebarCalls[1].resort, true, 'reset call must use resort:true');
  });
});

test('search: "  a  " (1 trimmed char) does NOT call api.search and preserves input', async () => {
  await withSearch(async ({ state, inputEl, runSearchQuery }) => {
    inputEl.value = '  a  ';
    await runSearchQuery();

    assert.equal(state.apiSearchCalls.length, 0, 'trim semantics: 1 trimmed char must not trigger search');
    assert.equal(inputEl.value, '  a  ', 'input value must be preserved (not cleared)');
  });
});

// ---------------------------------------------------------------------------
// Cross-tab: non-sessions tabs route correctly under 3-char threshold
// ---------------------------------------------------------------------------

test('search: 2-char query on memory tab calls renderMemories (not api.search)', async () => {
  await withSearch(async ({ state, inputEl, window, runSearchQuery }) => {
    window.activeTab = 'memory';
    inputEl.value = 'me';
    await runSearchQuery();

    assert.equal(state.apiSearchCalls.length, 0, 'api.search not called for 2-char on memory tab');
    assert.equal(state.renderMemoriesCalls.length, 1, 'renderMemories called to show unfiltered list');
  });
});

test('search: 3-char query on the work-files tab searches work-file and renders the matches', async () => {
  await withSearch(async ({ state, inputEl, window, runSearchQuery }) => {
    window.activeTab = 'work-files';
    state.apiResults = [{ id: 'wf-1' }];
    inputEl.value = 'plan';
    await runSearchQuery();

    assert.equal(state.apiSearchCalls[0].kind, 'work-file');
    assert.deepEqual([...state.renderWorkFilesCalls[0]], ['wf-1']);
  });
});
