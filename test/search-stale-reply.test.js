'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { setupSidebarDom } = require('./dom-setup');
const { loadAppFunctions, readAppSource } = require('./app-source');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(t, activeTab = 'sessions') {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const { window, document } = ctx;
  const requests = [], renders = [], frames = new Map(), timers = new Map();
  let nextId = 1;
  for (const name of ['searchInput', 'searchBar', 'workFilesContent', 'sessionFilters',
    'terminalHeader', 'gridViewer', 'terminalArea', 'memoryViewer', 'settingsViewer', 'statsViewer']) {
    window[name] = document.createElement(name === 'searchInput' ? 'input' : 'div');
    document.body.append(window[name]);
  }
  for (const id of ['search-clear', 'search-titles-toggle', 'search-refresh-btn']) {
    const button = document.createElement('button');
    button.id = id;
    document.body.append(button);
  }
  for (const name of ['sessions', 'memory', 'work-files', 'stats']) {
    const button = document.createElement('button');
    button.className = 'sidebar-tab';
    button.dataset.tab = name;
    document.body.append(button);
  }
  Object.assign(window, {
    activeTab, showArchived: false, gridViewActive: false, projectsChangedWhileAway: false,
    placeholder: document.getElementById('placeholder'),
    cachedProjects: [
      { projectPath: '/alpha', sessions: [{ sessionId: 'alpha' }] },
      { projectPath: '/bravo', sessions: [{ sessionId: 'bravo' }] },
    ],
    renderProjects: projects => renders.push({ tab: 'sessions', projects }),
    renderMemories: ids => renders.push({ tab: 'memory', ids }),
    renderWorkFiles: ids => renders.push({ tab: 'work-files', ids }),
    loadMemories() {}, loadWorkFiles() {}, loadStats() {}, hideAllViewers() {}, fitAndScroll() {},
    setTimeout: cb => { const id = nextId++; timers.set(id, cb); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: cb => { const id = nextId++; frames.set(id, cb); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  window.cachedAllProjects = window.cachedProjects;
  window.api.search = (kind, query, titlesOnly) => {
    const reply = deferred();
    requests.push({ kind, query, titlesOnly, ...reply });
    return reply.promise;
  };
  window.api.getSetting = async () => false;
  window.api.setSetting = async () => {};
  const src = readAppSource();
  function section(start, end) {
    const from = src.indexOf(start);
    const to = src.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `shipped section ${start} exists`);
    vm.runInContext(src.slice(from, to), ctx.context, {
      filename: path.join(__dirname, '..', 'public', 'app.js'),
    });
  }
  section('const MIN_SEARCH_CHARS =', 'function clearSearch()');
  const fns = loadAppFunctions(ctx.context, {
    declarations: ['rebuildInFlight'],
    functions: ['clearSearch', 'resetSearchFilter', 'runSearchQuery', 'refreshSidebar', 'triggerRebuildAndSearch'],
  });
  section("searchClear.addEventListener('click'", '// Extracted so');
  section("searchInput.addEventListener('input'", 'let rebuildInFlight =');
  section("document.querySelectorAll('.sidebar-tab').forEach(tab =>", '// Grid view');
  return {
    ...ctx, ...fns, requests, renders,
    start(query) { window.searchInput.value = query; return fns.runSearchQuery(); },
    type(query) {
      window.searchInput.value = query;
      window.searchInput.dispatchEvent(new window.Event('input'));
    },
    switchTab(tab) { document.querySelector(`[data-tab="${tab}"]`).click(); },
    flushFrames() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const cb of callbacks) cb();
    },
    flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const cb of callbacks) cb();
    },
  };
}

function ids(ctx) {
  return ctx.window.searchMatchIds === null ? null : Array.from(ctx.window.searchMatchIds);
}

for (const tab of ['sessions', 'memory', 'work-files']) {
  for (const action of ['clear', 'shorten', 'reset']) {
    test(`${tab}: a late reply after ${action} leaves the filter cleared`, async t => {
      const ctx = setup(t, tab);
      const pending = ctx.start('alpha');
      if (action === 'clear') ctx.document.getElementById('search-clear').click();
      if (action === 'shorten') { ctx.window.searchInput.value = 'al'; await ctx.runSearchQuery(); }
      if (action === 'reset') ctx.resetSearchFilter();
      ctx.flushFrames();
      const count = ctx.renders.length;
      ctx.requests[0].resolve([{ id: 'alpha' }]);
      await pending;
      assert.equal(ids(ctx), null, 'late results must not revive the session filter');
      assert.equal(ctx.window.searchMatchProjectPaths, null);
      assert.equal(ctx.renders.length, count, 'late results must not repaint cleared results');
      assert.equal(ctx.window.searchInput.value, action === 'clear' ? '' : action === 'shorten' ? 'al' : 'alpha');
    });
  }

  test(`${tab}: the newer reply wins when the older reply resolves last`, async t => {
    const ctx = setup(t, tab);
    const older = ctx.start('alpha');
    const newer = ctx.start('bravo');
    ctx.requests[1].resolve([{ id: 'bravo' }]);
    await newer;
    ctx.requests[0].resolve([{ id: 'alpha' }]);
    await older;
    assert.equal(ctx.renders.length, 1, 'only the current reply may render');
    if (tab === 'sessions') {
      assert.deepEqual(ids(ctx), ['bravo']);
      assert.deepEqual(Array.from(ctx.renders[0].projects, p => p.projectPath), ['/bravo']);
    } else assert.deepEqual(Array.from(ctx.renders[0].ids), ['bravo']);
  });

  for (const text of ['bravo', 'al', '']) {
    test(`${tab}: editing to ${JSON.stringify(text)} invalidates a reply before debounce fires`, async t => {
      const ctx = setup(t, tab);
      const pending = ctx.start('alpha');
      ctx.type(text);
      ctx.requests[0].resolve([{ id: 'alpha' }]);
      await pending;
      assert.equal(ctx.renders.length, 0, 'a query no longer typed must not render during debounce');
      assert.equal(ids(ctx), null);
    });
  }

  test(`${tab}: switching away and back cannot revive the previous query`, async t => {
    const ctx = setup(t, tab);
    ctx.window.gridViewActive = true;
    const pending = ctx.start('alpha');
    ctx.switchTab('stats');
    ctx.switchTab(tab);
    ctx.requests[0].resolve([{ id: 'alpha' }]);
    await pending;
    assert.equal(ctx.window.searchInput.value, '');
    assert.equal(ids(ctx), null);
    assert.equal(ctx.renders.length, 0, 'navigation invalidates replies even when returning to the same tab');
  });
}

test('a stale rejected query cannot clear newer successful results', async t => {
  const ctx = setup(t);
  const older = ctx.start('alpha');
  const newer = ctx.start('bravo');
  ctx.requests[1].resolve([{ id: 'bravo' }]);
  await newer;
  ctx.requests[0].reject(new Error('old search failed'));
  await older;
  assert.deepEqual(ids(ctx), ['bravo']);
  assert.equal(ctx.renders.length, 1);
});

test('a rejected memory query cannot clear a successful session query after navigation', async t => {
  const ctx = setup(t, 'memory');
  const older = ctx.start('alpha');
  ctx.switchTab('sessions');
  const newer = ctx.start('bravo');
  ctx.requests[1].resolve([{ id: 'bravo' }]);
  await newer;
  ctx.requests[0].reject(new Error('old memory search failed'));
  await older;
  assert.deepEqual(ids(ctx), ['bravo']);
  assert.equal(ctx.renders.length, 1);
});

test('a current search error still clears both session filters', async t => {
  const ctx = setup(t);
  ctx.window.searchMatchIds = new Set(['bravo']);
  ctx.window.searchMatchProjectPaths = new Set(['/bravo']);
  const pending = ctx.start('alpha');
  ctx.requests[0].reject(new Error('search failed'));
  await pending;
  assert.equal(ids(ctx), null);
  assert.equal(ctx.window.searchMatchProjectPaths, null);
  assert.equal(ctx.renders.length, 1);
});

test('title-only project matches stay current and remain visible during refinement', async t => {
  const ctx = setup(t);
  ctx.read('searchTitlesOnly = true');
  const first = ctx.start('alpha');
  ctx.requests[0].resolve([]);
  await first;
  assert.deepEqual(Array.from(ctx.window.searchMatchProjectPaths), ['/alpha']);
  assert.deepEqual(Array.from(ctx.renders[0].projects, p => p.projectPath), ['/alpha']);
  assert.equal(ctx.renders[0].projects[0]._projectMatchedOnly, true);
  const older = ctx.start('alpha refined');
  const newer = ctx.start('bravo');
  assert.deepEqual(Array.from(ctx.window.searchMatchProjectPaths), ['/alpha']);
  assert.equal(ctx.renders.length, 1, 'refinement must keep completed results visible');
  ctx.requests[2].resolve([]);
  await newer;
  ctx.requests[1].resolve([]);
  await older;
  assert.deepEqual(Array.from(ctx.window.searchMatchProjectPaths || []), ['/bravo']);
  assert.deepEqual(Array.from(ctx.renders.at(-1).projects, p => p.projectPath), ['/bravo']);
  assert.equal(ctx.renders.length, 2);
});

test('changing title mode invalidates replies before the preference is saved', async t => {
  const ctx = setup(t);
  await Promise.resolve();
  const save = deferred();
  ctx.window.api.setSetting = () => save.promise;
  const pending = ctx.start('alpha');
  ctx.document.getElementById('search-titles-toggle').click();
  ctx.requests[0].resolve([{ id: 'alpha' }]);
  await pending;
  assert.equal(ids(ctx), null);
  assert.equal(ctx.renders.length, 0);
  const rerun = new Promise(resolve => ctx.window.searchInput.addEventListener('input', resolve, { once: true }));
  save.resolve();
  await rerun;
  ctx.flushTimers();
  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.requests[1].titlesOnly, true);
  ctx.requests[1].resolve([]);
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(ctx.window.searchMatchProjectPaths), ['/alpha']);
});

test('rebuild searches the current text and does not revive the query it interrupted', async t => {
  const ctx = setup(t);
  const older = ctx.start('alpha');
  const rebuild = deferred();
  ctx.window.api.rebuildCache = () => rebuild.promise;
  const refreshing = ctx.triggerRebuildAndSearch();
  ctx.document.getElementById('search-clear').click();
  ctx.flushFrames();
  rebuild.resolve();
  await refreshing;
  ctx.flushFrames();
  const count = ctx.renders.length;
  ctx.requests[0].resolve([{ id: 'alpha' }]);
  await older;
  assert.equal(ctx.requests.length, 1);
  assert.equal(ids(ctx), null);
  assert.equal(ctx.renders.length, count);
});
