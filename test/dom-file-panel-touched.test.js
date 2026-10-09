'use strict';

// Renderer tests for the touched-files tab (public/touched-files-view.js),
// driven through the real public/file-panel.js in a jsdom window — see
// .ai/contexts/touched-files.md. The list is a lower bound by construction,
// so the tests that matter pin what the tab says about itself and what a
// click is allowed to reach.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');

const INDEX_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="terminal-area">
      <div id="terminals"></div>
    </div>
    <div id="terminal-header" style="display:none;">
      <div id="terminal-header-controls">
        <button id="terminal-stop-btn"></button>
      </div>
    </div>
  </body>
</html>`;

function evalInWindow(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

function row(over = {}) {
  return { path: '/work/a.txt', state: 'present', openable: true, tools: ['Write'], count: 1, sources: ['session'], ...over };
}

function result(over = {}) {
  return {
    ok: true,
    files: [row()],
    unresolved: [],
    omitted: 0,
    coverage: { transcripts: 1, subagents: 0, malformedLines: 0, truncated: false },
    ...over,
  };
}

test('remote Touched row and Reload retain the remote session in the shared read-only editor', async () => {
  const ctx = setupDom({ touchedImpl: () => result({ kind: 'remote' }),
    readImpl: () => ({ ok: true, kind: 'remote', git: true, readOnly: true, original: 'base', current: 'remote text' }) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    const tab = ctx.stateOf('s1').currentTab;
    assert.equal(ctx.calls.readOptions[0].sessionId, 's1');
    assert.equal(tab.type, 'changes');
    assert.equal(tab.remote, true);
    assert.equal(tab.returnList.type, 'touched');
    assert.equal(tab.readOnly, true);
    assert.equal(ctx.editors.at(-1).current, 'remote text');
    assert.equal(ctx.editors.at(-1).mode, 'inline');
    assert.equal(ctx.editors.at(-1).options.readOnly, true);
    assert.deepEqual(ctx.watchCalls, []);
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /Remote session/);
    assert.doesNotMatch(ctx.document.getElementById('changes-diff-notice').textContent, /Symbolic link/);
    await ctx.window.reloadChangesFile('s1');
    assert.equal(ctx.calls.readOptions.at(-1).sessionId, 's1');
    assert.equal(ctx.calls.status.length, 0);
    assert.equal(ctx.calls.save.length, 0);
  } finally { ctx.destroy(); }
});

test('an unreachable remote Touched list shows unknown rows without reads or automatic retries', async () => {
  const ctx = setupDom({ touchedImpl: () => result({ kind: 'remote', files: [row({ state: 'unknown', openable: false, diskMtime: null })] }) });
  try {
    await openTab(ctx);
    const el = rows(ctx)[0];
    assert.equal(el.querySelector('.touched-file-state').textContent, 'unknown');
    el.click();
    await flush();
    assert.equal(ctx.calls.readFile.length, 0);
    assert.equal(ctx.calls.touched.length, 1);
    ctx.document.getElementById('touched-refresh-btn').click();
    await flush();
    assert.equal(ctx.calls.touched.length, 2);
  } finally { ctx.destroy(); }
});

function setupDom({ touchedImpl, readImpl, confirmImpl, storedRatio, storageThrows = false, resolveImpl, ownerOf, saveImpl } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  if (storedRatio != null) window.localStorage.setItem('touchedListRatio', storedRatio);
  if (storageThrows) {
    const getItem = window.Storage.prototype.getItem;
    window.Storage.prototype.getItem = function (key) {
      if (key === 'touchedListRatio' || key === 'touchedMarkdownFormatted') throw new Error('storage unavailable');
      return getItem.call(this, key);
    };
    window.Storage.prototype.setItem = () => { throw new Error('storage unavailable'); };
  }
  let resize;
  const observed = new Set();
  window.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe(element) { observed.add(element); }
  };
  const calls = { touched: [], readFile: [], readOptions: [], save: [], gitFile: [], status: [], resolve: [], diffResponse: [], revealed: [], confirm: 0 };
  let mcpOpenFile = null;

  window.api = {
    onMcpOpenDiff: () => {},
    onMcpOpenFile: (handler) => { mcpOpenFile = handler; },
    onMcpCloseAllDiffs: () => {},
    onMcpCloseTab: () => {},
    mcpDiffResponse: (...args) => { calls.diffResponse.push(args); },
    resolveTerminalPaths: (sessionId, texts) => {
      calls.resolve.push([sessionId, texts]);
      return Promise.resolve((resolveImpl || ((_id, t) => t.map(p => ({ ok: true, path: p }))))(sessionId, texts));
    },
    sessionTouchedFiles: (sessionId, options) => {
      calls.touched.push(sessionId);
      return Promise.resolve((touchedImpl || (() => result()))(sessionId, options));
    },
    readFileForPanel: (filePath, options) => {
      calls.readOptions.push(options);
      calls.readFile.push(filePath);
      return Promise.resolve((readImpl || (() => ({ ok: true, original: 'before\n', current: 'file body', version: 'v1', git: true })))(filePath));
    },
  };
  const watchCalls = [];
  const changeListeners = [];
  window.api.watchFile = filePath => { watchCalls.push(['watch', filePath]); return Promise.resolve({ ok: true }); };
  window.api.unwatchFile = filePath => { watchCalls.push(['unwatch', filePath]); return Promise.resolve({ ok: true }); };
  window.api.onFileChanged = handler => changeListeners.push(handler);
  window.api.gitChangesStatus = () => { calls.status.push('status'); return Promise.resolve({ ok: true, branch: {}, files: [], totals: {} }); };
  window.api.gitChangesFile = (id, filePath, options) => { calls.gitFile.push({ id, filePath, options }); return Promise.resolve({ ok: true, original: 'before\n', current: 'file body', version: 'v1' }); };
  window.api.saveFileForPanel = (filePath, content, expected, options) => {
    calls.save.push({ filePath, content, expected, options });
    return Promise.resolve(saveImpl ? saveImpl(calls.save.length - 1) : { ok: true, version: 'v2' });
  };
  window.confirm = (...args) => { calls.confirm++; return (confirmImpl || (() => true))(...args); };
  window.cmRevealLine = (_view, line) => calls.revealed.push(line);
  if (ownerOf) window.panelTerminalOwnerOf = ownerOf;
  const editors = [];
  const editor = (parent, original, current, mode, options) => {
    const dom = window.document.createElement('div');
    dom.className = 'cm-editor test-' + mode;
    parent.appendChild(dom);
    const view = { dom, original, current, mode, options, setText(value) { view.current = value; options.onChange(); }, destroy() { dom.remove(); } };
    const state = { doc: { toString: () => view.current } };
    if (mode === 'side-by-side') view.b = { state }; else view.state = state;
    editors.push(view);
    return view;
  };
  window.createMergeViewer = (parent, original, current, _name, options) => editor(parent, original, current, 'side-by-side', options);
  window.createUnifiedMergeViewer = (parent, original, current, _name, options) => editor(parent, original, current, 'inline', options);
  window.createEditableViewer = (parent, current, _name, options) => editor(parent, null, current, 'plain', options);
  window.createReadOnlyViewer = (parent, current) => editor(parent, null, current, 'read-only', { onChange() {} });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  evalInWindow(dom, path.join(NODE_MODULES, 'marked', 'lib', 'marked.umd.js'));
  evalInWindow(dom, path.join(NODE_MODULES, 'dompurify', 'dist', 'purify.min.js'));
  const bundledMarked = window.marked;
  delete window.marked;
  window.loadCodeMirrorBundle = () => { window.marked = bundledMarked; return Promise.resolve(); };
  for (const file of ['viewer-toolbar.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'header-controls.js', 'file-panel.js', 'touched-files-view.js']) {
    evalInWindow(dom, path.join(PUBLIC_DIR, file));
  }
  window.initFilePanel();

  const ctx = dom.getInternalVMContext();
  return {
    window,
    document: window.document,
    calls,
    editors,
    watchCalls,
    resize: element => {
      if (!element || observed.has(element)) resize();
    },
    changed: filePath => changeListeners.forEach(handler => handler(filePath)),
    mcpOpenFile: (sessionId, data) => mcpOpenFile(sessionId, data),
    stateOf: (sessionId) => vm.runInContext('filePanelState', ctx).get(sessionId),
    evalSource: source => vm.runInContext(source, ctx),
    bundledMarked,
    destroy: () => window.close(),
  };
}

function flush() {
  let p = Promise.resolve();
  for (let i = 0; i < 12; i++) p = p.then(() => Promise.resolve());
  return p;
}

async function openTab(ctx, sessionId = 's1') {
  ctx.window.switchPanel(sessionId);
  ctx.document.getElementById('touched-toggle-btn').click();
  await flush();
}

function rows(ctx) {
  return [...ctx.document.querySelectorAll('.touched-file-row')];
}

function clickRow(ctx, filePath) {
  const el = rows(ctx).find((r) => r.dataset.path === filePath);
  assert.ok(el, `a row for ${filePath}`);
  el.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
}

test('Touched uses the shared select style', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    assert.ok(ctx.document.getElementById('touched-sort').classList.contains('control-select'));
  } finally { ctx.destroy(); }
});

for (const exit of ['escape', 'outside', 'close']) {
  test(`Touched info closes by ${exit}, returns focus and keeps the editor open`, async () => {
    const ctx = setupDom();
    try {
      await openTab(ctx);
      clickRow(ctx, '/work/a.txt');
      await flush();
      const tab = ctx.stateOf('s1').currentTab;
      ctx.document.addEventListener('keydown', event => {
        if (event.key === 'Escape') ctx.window.returnToPanelList();
      });
      const btn = ctx.document.getElementById('touched-info-btn');
      assert.equal(ctx.document.getElementById('touched-coverage'), null);
      btn.click();
      const overlay = ctx.document.querySelector('.touched-info-overlay');
      assert.ok(overlay.classList.contains('modal-overlay'));
      assert.equal(overlay.parentElement, ctx.document.body);
      const dialog = overlay.querySelector('[role="dialog"]');
      assert.equal(dialog.getAttribute('aria-modal'), 'true');
      assert.match(dialog.textContent, /not the complete set/);
      dialog.click();
      assert.ok(overlay.isConnected, 'clicking inside keeps it open');
      if (exit === 'escape') dialog.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else if (exit === 'outside') overlay.click();
      else overlay.querySelector('[aria-label="Close"]').click();
      assert.equal(ctx.document.querySelector('.touched-info-overlay'), null);
      assert.equal(ctx.document.activeElement, btn);
      assert.equal(ctx.stateOf('s1').currentTab, tab);
      assert.ok(tab.editorView, 'modal Escape leaves the editor mounted');
    } finally { ctx.destroy(); }
  });
}

test('Touched keeps its list above the shared editor, persists its splitter ratio and restores full height on close', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    const container = ctx.document.getElementById('file-panel-touched');
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    const list = ctx.document.getElementById('touched-list');
    clickRow(ctx, '/work/a.txt');
    await flush();
    const editor = ctx.document.getElementById('changes-diff-view');
    const splitter = ctx.document.getElementById('changes-list-splitter');
    assert.equal(container.style.display, 'flex');
    assert.equal(editor.parentElement, container);
    assert.equal(splitter.previousElementSibling, list);
    assert.equal(splitter.nextElementSibling, editor);
    assert.equal(ctx.document.getElementById('file-panel-back-btn').style.display, 'none');
    assert.equal(container.querySelector('.viewer-toolbar-title').textContent, 'Touched files');
    assert.ok(list.classList.contains('changes-list-split'));
    const initial = parseFloat(list.style.height);
    splitter.dispatchEvent(new ctx.window.MouseEvent('mousedown', { clientY: 100, bubbles: true }));
    ctx.document.dispatchEvent(new ctx.window.MouseEvent('mousemove', { clientY: 150, bubbles: true }));
    ctx.document.dispatchEvent(new ctx.window.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(parseFloat(list.style.height), initial + 50);
    const ratio = Number(ctx.window.localStorage.getItem('touchedListRatio'));
    assert.equal(ratio, (initial + 50) / 600);
    const before = JSON.stringify(ctx.calls);
    ctx.document.getElementById('changes-diff-close-btn').click();
    assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
    assert.equal(list.style.height, '');
    assert.ok(!list.classList.contains('changes-list-split'));
    assert.equal(editor.style.display, 'none');
    assert.equal(splitter.style.display, 'none');
    assert.equal(JSON.stringify(ctx.calls), before);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.equal(parseFloat(list.style.height), 600 * ratio);
    editor.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(list.style.height, '');
  } finally { ctx.destroy(); }
});

for (const exit of ['close', 'escape', 'switch']) {
  test(`Touched dirty ${exit} asks before discarding and preserves the editor on refusal`, async () => {
    let agree = false;
    let prompts = 0;
    const ctx = setupDom({ touchedImpl: () => result({ files: [row(), row({ path: '/work/b.txt' })] }),
      confirmImpl: () => { prompts++; return agree; } });
    try {
      await openTab(ctx);
      clickRow(ctx, '/work/a.txt');
      await flush();
      const tab = ctx.stateOf('s1').currentTab;
      const view = ctx.editors.at(-1);
      view.setText('dirty');
      const act = () => {
        if (exit === 'close') ctx.document.getElementById('changes-diff-close-btn').click();
        else if (exit === 'escape') ctx.document.getElementById('changes-diff-view').dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else clickRow(ctx, '/work/b.txt');
      };
      act();
      await flush();
      assert.equal(prompts, 1);
      assert.equal(ctx.stateOf('s1').currentTab, tab);
      assert.equal(ctx.editors.at(-1), view);
      assert.equal(view.current, 'dirty');
      assert.equal(ctx.calls.readFile.length, 1);
      agree = true;
      act();
      await flush();
      assert.equal(prompts, 2);
      assert.ok(!view.dom.isConnected);
      assert.equal(ctx.stateOf('s1').touchedStashes?.size ?? 0, 0);
      if (exit === 'switch') {
        assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/b.txt');
        assert.deepEqual(rows(ctx).filter(r => r.classList.contains('selected')).map(r => r.dataset.path), ['/work/b.txt']);
      } else assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
    } finally { ctx.destroy(); }
  });
}

test('Touched rows can switch clean files and sort while the editor stays open', async () => {
  const ctx = setupDom({ touchedImpl: () => result({ files: [row({ path: '/work/z.txt', lastTouched: Date.now() }), row({ path: '/work/a.txt' })] }) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/z.txt');
    await flush();
    const view = ctx.editors.at(-1);
    const sort = ctx.document.getElementById('touched-sort');
    sort.value = 'path';
    sort.dispatchEvent(new ctx.window.Event('change'));
    assert.deepEqual(rows(ctx).map(r => r.dataset.path), ['/work/a.txt', '/work/z.txt']);
    assert.ok(rows(ctx)[1].classList.contains('selected'));
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/a.txt');
    assert.ok(!view.dom.isConnected);
    assert.equal(ctx.calls.touched.length, 1);
  } finally { ctx.destroy(); }
});

for (const [storedRatio, expected] of [['0.6', 0.6], ['broken', 0.4], ['2', 0.4], ['0', 0.4]]) {
  test(`Touched restores a valid ratio or defaults on ${storedRatio} and follows container resize`, async () => {
    const ctx = setupDom({ storedRatio });
    try {
      await openTab(ctx);
      let height = 600;
      Object.defineProperty(ctx.document.getElementById('file-panel-touched'), 'clientHeight', { get: () => height });
      clickRow(ctx, '/work/a.txt');
      await flush();
      const list = ctx.document.getElementById('touched-list');
      assert.equal(parseFloat(list.style.height), 600 * expected);
      height = 800;
      ctx.resize();
      assert.equal(parseFloat(list.style.height), 800 * expected);
    } finally { ctx.destroy(); }
  });
}

for (const type of ['touched', 'changes']) {
  test(`${type} container resize reapplies the split and preserves the editor minimum when the shell takes space`, async () => {
    const ctx = setupDom({ storedRatio: '0.6' });
    try {
      await openTab(ctx);
      if (type === 'changes') await ctx.window.openChangesTab('s1');
      let height = 600;
      const container = ctx.document.getElementById(`file-panel-${type}`);
      Object.defineProperty(container, 'clientHeight', { get: () => height });
      if (type === 'touched') clickRow(ctx, '/work/a.txt');
      else await ctx.window.openChangesDiff('s1', { path: 'a.txt', staged: true });
      await flush();
      const list = ctx.document.getElementById(type === 'touched' ? 'touched-list' : 'changes-list');
      height = 250;
      ctx.resize(container);
      assert.equal(parseFloat(list.style.height), 130);
      assert.equal(height - parseFloat(list.style.height), 120);
      height = 800;
      ctx.resize(container);
      assert.equal(parseFloat(list.style.height), type === 'touched' ? 480 : 200);
    } finally { ctx.destroy(); }
  });
}

test('Touched works and its splitter commits when localStorage refuses reads and writes', async () => {
  let ctx;
  assert.doesNotThrow(() => { ctx = setupDom({ storageThrows: true }); });
  try {
    const errors = [];
    ctx.window.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
    await openTab(ctx);
    Object.defineProperty(ctx.document.getElementById('file-panel-touched'), 'clientHeight', { value: 600 });
    clickRow(ctx, '/work/a.txt');
    await flush();
    const list = ctx.document.getElementById('touched-list');
    assert.equal(parseFloat(list.style.height), 240);
    ctx.document.getElementById('changes-list-splitter').dispatchEvent(new ctx.window.MouseEvent('mousedown', { clientY: 0, bubbles: true }));
    ctx.document.dispatchEvent(new ctx.window.MouseEvent('mousemove', { clientY: 50, bubbles: true }));
    ctx.document.dispatchEvent(new ctx.window.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(parseFloat(list.style.height), 290);
    assert.deepEqual(errors, []);
  } finally { ctx.destroy(); }
});

test('file and diff editor headers use the shared filename-preserving path structure', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    const touchedPath = ctx.document.getElementById('changes-diff-path');
    assert.equal(touchedPath.title, '/work/a.txt');
    assert.equal(touchedPath.querySelector('.viewer-path-tail').textContent, 'a.txt');
    ctx.window.openDiffTab('s1', 'diff', { oldFilePath: '/work/deep/b.txt', oldContent: 'a', newContent: 'b' });
    await flush();
    const diffPath = ctx.document.getElementById('diff-path');
    assert.equal(diffPath.title, '/work/deep/b.txt');
    assert.equal(diffPath.querySelector('.viewer-path-tail').textContent, 'b.txt');
    await ctx.window.openChangesTab('s1');
    await ctx.window.openChangesDiff('s1', { path: 'deep/c.txt', staged: true });
    await flush();
    assert.equal(touchedPath.title, 'deep/c.txt');
    assert.equal(touchedPath.querySelector('.viewer-path-tail').textContent, 'c.txt');
    assert.equal(ctx.document.getElementById('changes-diff-view').parentElement.id, 'file-panel-changes');
    assert.equal(ctx.document.getElementById('changes-list').style.display, 'block');
    assert.notEqual(ctx.document.getElementById('file-panel-back-btn').style.display, 'none');
  } finally { ctx.destroy(); }
});

test('Touched asks again if the user edits while the next row is being read', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let prompts = 0;
  const ctx = setupDom({ touchedImpl: () => result({ files: [row(), row({ path: '/work/b.txt' })] }),
    readImpl: filePath => filePath.endsWith('b.txt') ? gate : { ok: true, git: false, original: 'a', current: 'a' },
    confirmImpl: () => { prompts++; return false; } });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    const tab = ctx.stateOf('s1').currentTab;
    clickRow(ctx, '/work/b.txt');
    ctx.editors.at(-1).setText('new edits during read');
    release({ ok: true, git: false, original: 'b', current: 'b' });
    await flush();
    assert.equal(prompts, 1);
    assert.equal(ctx.stateOf('s1').currentTab, tab);
    assert.equal(ctx.editors.at(-1).current, 'new edits during read');
  } finally { ctx.destroy(); }
});

test('the header carries a Touched toggle that opens the tab for the session and lists its files', async () => {
  const ctx = setupDom({
    touchedImpl: () => result({
      files: [
        row({ path: '/work/a.txt', tools: ['Edit', 'Write'], count: 3, sources: ['session', 'subagent reviewer (abc1234)'] }),
        row({ path: '/work/gone.txt', state: 'gone', openable: false }),
      ],
    }),
  });
  try {
    const btn = ctx.document.getElementById('touched-toggle-btn');
    assert.ok(btn, 'the toggle exists');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    await openTab(ctx);
    assert.deepEqual(ctx.calls.touched, ['s1']);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'touched');
    assert.equal(rows(ctx).length, 2);
    const first = rows(ctx)[0];
    assert.match(first.textContent, /\/work\/a\.txt/);
    assert.match(first.textContent, /Edit, Write/);
    assert.match(first.textContent, /3/);
    assert.match(first.textContent, /subagent reviewer \(abc1234\)/);
    assert.equal(ctx.document.getElementById('file-panel-touched').style.display, 'flex');
  } finally { ctx.destroy(); }
});

test('the tab states its coverage while loading, when listed, and when the listing fails', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setupDom({ touchedImpl: () => gate.then(() => result()) });
  try {
    ctx.window.switchPanel('s1');
    ctx.document.getElementById('touched-toggle-btn').click();
    ctx.document.getElementById('touched-info-btn').click();
    const note = () => ctx.document.getElementById('touched-coverage');
    assert.ok(note(), 'the coverage note exists');
    const readNote = () => note().textContent;
    const pinned = (text) => {
      assert.match(text, /file tools/);
      assert.match(text, /Edit, Write, MultiEdit/);
      assert.match(text, /Bash/);
      assert.match(text, /not the complete set/i);
    };
    pinned(readNote());
    assert.notEqual(note().style.display, 'none');
    release();
    await flush();
    pinned(readNote());
    assert.equal(rows(ctx).length, 1);
  } finally { ctx.destroy(); }

  const failing = setupDom({ touchedImpl: () => ({ ok: false, error: 'nope', reason: 'no-transcript' }) });
  try {
    await openTab(failing);
    failing.document.getElementById('touched-info-btn').click();
    assert.match(failing.document.getElementById('touched-coverage').textContent, /not the complete set/i);
    assert.match(failing.document.getElementById('touched-summary').textContent, /nope/);
  } finally { failing.destroy(); }
});

test('an empty listing says the file tools touched nothing, not that nothing changed', async () => {
  const ctx = setupDom({ touchedImpl: () => result({ files: [] }) });
  try {
    await openTab(ctx);
    const summary = ctx.document.getElementById('touched-summary').textContent;
    assert.match(summary, /No files/i);
    assert.match(summary, /file tools/);
    assert.doesNotMatch(summary, /unchanged|nothing changed/i);
  } finally { ctx.destroy(); }
});

test('a present file opens through readFileForPanel and the shared Changes editor', async () => {
  const ctx = setupDom({ readImpl: () => ({ ok: true, original: 'before\n', current: 'hello', git: true, version: 'v1' }) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.deepEqual(ctx.calls.readFile, ['/work/a.txt']);
    assert.equal(ctx.stateOf('s1').currentTab.type, 'changes');
    assert.equal(ctx.editors.at(-1).current, 'hello');
    assert.equal(ctx.calls.readOptions[0].editor, true);
  } finally { ctx.destroy(); }
});

test('close and Escape restore the same Touched rows, scroll and selection without another request', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    const list = ctx.document.getElementById('touched-list');
    const first = rows(ctx)[0];
    list.scrollTop = 123;
    clickRow(ctx, '/work/a.txt');
    await flush();
    const back = ctx.document.getElementById('changes-diff-close-btn');
    assert.ok(back, 'a shared panel back button');
    back.click();
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'touched');
    assert.equal(rows(ctx)[0], first);
    assert.equal(list.scrollTop, 123);
    assert.ok(first.classList.contains('selected'));
    assert.equal(ctx.calls.touched.length, 1);
    clickRow(ctx, '/work/a.txt');
    await flush();
    ctx.document.getElementById('changes-diff-view').dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'touched');
    assert.equal(rows(ctx)[0], first);
    assert.equal(ctx.calls.touched.length, 1);
  } finally { ctx.destroy(); }
});

test('time formatting uses the injected clock and switches at the named threshold', () => {
  const ctx = setupDom();
  try {
    const now = Date.parse('2026-10-03T12:00:00Z');
    assert.equal(ctx.window.formatTouchedTime(now - 12 * 60000, now), '12 min ago');
    assert.equal(ctx.window.formatTouchedTime(now - 86400000 + 1, now), '23 hr ago');
    assert.equal(ctx.window.formatTouchedTime(now - 86400000, now), new ctx.window.Date(now - 86400000).toLocaleString());
  } finally { ctx.destroy(); }
});

for (const targetClass of ['cm-panels', 'cm-search', 'cm-tooltip', 'input', 'textarea']) {
  test(`Escape in ${targetClass} stays in the viewer`, async () => {
    const ctx = setupDom();
    try {
      await openTab(ctx);
      clickRow(ctx, '/work/a.txt');
      await flush();
      const target = ctx.document.createElement(['input', 'textarea'].includes(targetClass) ? targetClass : 'div');
      target.className = targetClass;
      ctx.document.getElementById('changes-diff-view').appendChild(target);
      target.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert.equal(ctx.stateOf('s1').currentTab.type, 'changes');
    } finally { ctx.destroy(); }
  });
}

test('Escape closes the search panel before the panel can go back', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    const source = fs.readFileSync(path.join(PUBLIC_DIR, 'codemirror-setup.js'), 'utf8');
    const built = require('esbuild').buildSync({
      stdin: { contents: source + '\nwindow.testCreateSearchBar = createCMSearchBar;', resolveDir: PUBLIC_DIR, loader: 'js' },
      bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
    });
    ctx.evalSource(built.outputFiles[0].text);
    const viewer = ctx.document.getElementById('changes-diff-view');
    const search = ctx.window.testCreateSearchBar(viewer, {
      focus() {}, dispatch() {},
      state: { doc: { toString: () => 'hello' }, sliceDoc: () => '', selection: { main: { from: 0, to: 0 } } },
    });
    search.open();
    assert.notEqual(search.bar.style.display, 'none');
    search.bar.querySelector('input').dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(search.bar.style.display, 'none');
    assert.equal(ctx.stateOf('s1').currentTab.type, 'changes');
  } finally { ctx.destroy(); }
});

for (const mode of ['consumed', 'composing', 'content']) {
  test(`Escape in editor content is ${mode}`, async () => {
    const ctx = setupDom();
    try {
      await openTab(ctx);
      clickRow(ctx, '/work/a.txt');
      await flush();
      const editor = ctx.document.createElement('textarea');
      editor.className = 'cm-content';
      ctx.document.getElementById('changes-diff-view').appendChild(editor);
      if (mode === 'consumed') editor.addEventListener('keydown', event => event.preventDefault());
      editor.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: mode === 'composing' }));
      assert.equal(ctx.stateOf('s1').currentTab.type, mode === 'content' ? 'touched' : 'changes');
    } finally { ctx.destroy(); }
  });
}

test('Touched snapshots scroll before hiding even when hidden layout reports zero', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    const list = ctx.document.getElementById('touched-list');
    const container = ctx.document.getElementById('file-panel-touched');
    let scroll = 123;
    let display = container.style.display;
    Object.defineProperty(container.style, 'display', {
      get: () => display,
      set: value => { display = value; if (value === 'none') scroll = 0; },
    });
    Object.defineProperty(list, 'scrollTop', {
      get: () => container.style.display === 'none' ? 0 : scroll,
      set: value => { scroll = value; },
    });
    clickRow(ctx, '/work/a.txt');
    await flush();
    await openTab(ctx, 's2');
    ctx.window.switchPanel('s1');
    ctx.document.getElementById('changes-diff-close-btn').click();
    assert.equal(list.scrollTop, 123);
    assert.ok(rows(ctx)[0].classList.contains('selected'));
    assert.equal(ctx.calls.touched.length, 2);
  } finally { ctx.destroy(); }
});

for (const destination of ['file', 'session']) {
  test(`a pending Touched refresh is saved while another ${destination} is visible and Close makes no IPC`, async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let requests = 0;
    const ctx = setupDom({ touchedImpl: () => ++requests === 1 ? result() : gate });
    try {
      await openTab(ctx);
      const tab = ctx.stateOf('s1').currentTab;
      ctx.document.getElementById('touched-refresh-btn').click();
      clickRow(ctx, '/work/a.txt');
      await flush();
      if (destination === 'session') await openTab(ctx, 's2');
      release(result({ files: [row({ path: '/work/new.txt' })] }));
      await flush();
      assert.equal(tab.data.files[0].path, '/work/new.txt');
      assert.equal(ctx.stateOf('s1').currentTab.type, 'changes');
      ctx.window.switchPanel('s1');
      const before = ctx.calls.touched.length;
      ctx.document.getElementById('changes-diff-close-btn').click();
      assert.deepEqual(rows(ctx).map(r => r.dataset.path), ['/work/new.txt']);
      assert.equal(ctx.calls.touched.length, before);
    } finally { release(result()); ctx.destroy(); }
  });
}

test('one extension jumps to a sixty-day mtime and removes the older button', async () => {
  const now = Date.now();
  const ctx = setupDom({ touchedImpl: (_id, options) => options.windowDays < 60
    ? result({ files: [], hasOlder: true, loadedWindowStart: now - 86400000, windowStart: now - 86400000, nextOlderTimestamp: now - 60 * 86400000 })
    : result({ files: [row({ lastTouched: now - 60 * 86400000 })], hasOlder: false }) });
  try {
    await openTab(ctx);
    ctx.document.getElementById('touched-more-btn').click();
    await flush();
    assert.equal(rows(ctx).length, 1);
    assert.equal(ctx.document.getElementById('touched-more-btn'), null);
    assert.equal(ctx.calls.touched.length, 2);
  } finally { ctx.destroy(); }
});

test('a pending Touched refresh renders on a session switch back without another IPC', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = setupDom({ touchedImpl: () => gate });
  try {
    ctx.window.switchPanel('s1');
    ctx.document.getElementById('touched-toggle-btn').click();
    ctx.window.switchPanel('s2');
    release(result({ files: [row({ path: '/work/late.txt' })] }));
    await flush();
    ctx.window.switchPanel('s1');
    assert.deepEqual(rows(ctx).map(r => r.dataset.path), ['/work/late.txt']);
    assert.equal(ctx.calls.touched.length, 1);
  } finally { release(result()); ctx.destroy(); }
});

test('one extension jumps to fractional-day activity by rounding up to a whole day', async () => {
  const now = Date.now();
  const day = 86400000;
  const ctx = setupDom({ touchedImpl: (_id, options) => options.windowDays < 60.25
    ? result({ files: [], hasOlder: true, loadedWindowStart: now - day, windowStart: now - day, nextOlderTimestamp: now - 60.25 * day })
    : result({ files: [row({ lastTouched: now - 60.25 * day })], hasOlder: false }) });
  try {
    await openTab(ctx);
    ctx.document.getElementById('touched-more-btn').click();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.windowDays, 61);
    assert.equal(rows(ctx).length, 1);
    assert.equal(ctx.document.getElementById('touched-more-btn'), null);
    assert.equal(ctx.calls.touched.length, 2);
  } finally { ctx.destroy(); }
});

test('a Touched return target survives another session using the shared list', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx, 's1');
    const first = rows(ctx)[0];
    ctx.document.getElementById('touched-list').scrollTop = 123;
    clickRow(ctx, '/work/a.txt');
    await flush();
    await openTab(ctx, 's2');
    ctx.window.switchPanel('s1');
    ctx.document.getElementById('changes-diff-close-btn').click();
    assert.equal(rows(ctx)[0], first);
    assert.equal(ctx.document.getElementById('touched-list').scrollTop, 123);
    assert.equal(ctx.calls.touched.length, 2);
  } finally { ctx.destroy(); }
});

test('Close keeps a dirty file on refusal and discards it without stashing it after confirmation', async () => {
  let agree = false;
  const ctx = setupDom({ confirmImpl: () => agree });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    ctx.editors.at(-1).setText('unsaved edit');
    const back = ctx.document.getElementById('changes-diff-close-btn');
    back.click();
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'changes');
    agree = true;
    back.click();
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'touched');
    assert.equal(ctx.stateOf('s1').touchedStashes?.size ?? 0, 0);
  } finally { ctx.destroy(); }
});

test('cached time windows extend twice locally, count hidden files, retain window on close and sort by path', async () => {
  const now = Date.now();
  const ctx = setupDom({ touchedImpl: () => result({ windowStart: now - 86400000, loadedWindowStart: now - 21 * 86400000, hasOlder: false, files: [
    row({ path: '/z', lastTouched: now, diskMtime: now - 1000 }),
    row({ path: '/a', lastTouched: now - 5 * 86400000 }),
    row({ path: '/b', lastTouched: now - 15 * 86400000 }),
  ] }) });
  try {
    await openTab(ctx);
    assert.deepEqual(rows(ctx).map(r => r.dataset.path), ['/z']);
    assert.match(ctx.document.getElementById('touched-summary').textContent, /2 older files/);
    assert.match(rows(ctx)[0].title, /Modified:/);
    ctx.document.getElementById('touched-more-btn').click();
    await flush();
    assert.deepEqual(rows(ctx).map(r => r.dataset.path), ['/z', '/a']);
    ctx.document.getElementById('touched-more-btn').click();
    await flush();
    assert.equal(rows(ctx).length, 3);
    assert.equal(ctx.document.getElementById('touched-more-btn'), null);
    assert.equal(ctx.calls.touched.length, 1);
    const sort = ctx.document.getElementById('touched-sort');
    sort.value = 'path';
    sort.dispatchEvent(new ctx.window.Event('change'));
    assert.deepEqual(rows(ctx).map(r => r.dataset.path), ['/a', '/b', '/z']);
    clickRow(ctx, '/z');
    await flush();
    ctx.document.getElementById('changes-diff-close-btn').click();
    assert.equal(rows(ctx).length, 3);
    assert.equal(ctx.stateOf('s1').currentTab.windowDays, 21);
    assert.equal(ctx.calls.touched.length, 1);
  } finally { ctx.destroy(); }
});

test('a gone, refused, unreadable or non-file row says so and a click reads nothing', async () => {
  const ctx = setupDom({
    touchedImpl: () => result({
      files: [
        row({ path: '/work/gone.txt', state: 'gone', openable: false }),
        row({ path: '/work/.ssh/id_rsa', state: 'refused', openable: false }),
        row({ path: '/work/locked.txt', state: 'unreadable', openable: false }),
        row({ path: '/work/dir', state: 'not-file', openable: false }),
      ],
    }),
  });
  try {
    await openTab(ctx);
    const labels = Object.fromEntries(rows(ctx).map((r) => [r.dataset.path, r.querySelector('.touched-file-state').textContent]));
    assert.deepEqual(labels, {
      '/work/gone.txt': 'gone',
      '/work/.ssh/id_rsa': 'refused',
      '/work/locked.txt': 'unreadable',
      '/work/dir': 'not a file',
    });
    assert.match(rows(ctx).find(r => r.dataset.path === '/work/gone.txt').title, /no longer exists/i);
    for (const r of rows(ctx)) {
      assert.equal(r.classList.contains('touched-openable'), false);
      r.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    }
    await flush();
    assert.deepEqual(ctx.calls.readFile, []);
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'touched');
  } finally { ctx.destroy(); }
});

test('a row the main process did not mark openable is not opened even if its state reads present', async () => {
  const ctx = setupDom({ touchedImpl: () => result({ files: [row({ state: 'present', openable: false })] }) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.deepEqual(ctx.calls.readFile, []);
  } finally { ctx.destroy(); }
});

test('a row whose state is not present is not opened even when flagged openable', async () => {
  const ctx = setupDom({ touchedImpl: () => result({ files: [row({ state: 'gone', openable: true })] }) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.deepEqual(ctx.calls.readFile, []);
  } finally { ctx.destroy(); }
});

test('a file read that finishes after the tab was replaced does not take the panel back', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setupDom({ readImpl: () => gate.then(() => ({ ok: true, content: 'late' })) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    ctx.window.openDiffTab('s1', 'd1', { oldFilePath: '/work/other.txt', oldContent: 'a\n', newContent: 'b\n' });
    release();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.type, 'diff');
    assert.equal(ctx.stateOf('s1').currentTab.filePath, '/work/other.txt');
  } finally { ctx.destroy(); }
});

test('opening the tab hides whatever the panel showed before', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    for (const id of ['file-panel-diff', 'file-panel-changes']) {
      ctx.document.getElementById(id).style.display = 'flex';
    }
    ctx.document.getElementById('touched-toggle-btn').click();
    await flush();
    for (const id of ['file-panel-diff', 'file-panel-changes']) {
      assert.equal(ctx.document.getElementById(id).style.display, 'none', id);
    }
    assert.equal(ctx.document.getElementById('file-panel-touched').style.display, 'flex');
  } finally { ctx.destroy(); }
});

test('unresolved paths are listed apart, with their reason, and cannot be opened', async () => {
  const ctx = setupDom({
    touchedImpl: () => result({
      files: [],
      unresolved: [{ raw: 'rel/x.txt', reason: 'relative-no-cwd', tools: ['Write'], count: 2, sources: ['session'] }],
    }),
  });
  try {
    await openTab(ctx);
    const un = [...ctx.document.querySelectorAll('.touched-unresolved-row')];
    assert.equal(un.length, 1);
    assert.match(un[0].textContent, /rel\/x\.txt/);
    assert.match(un[0].textContent, /working directory/i);
    assert.equal(un[0].dataset.path, undefined);
    un[0].dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();
    assert.deepEqual(ctx.calls.readFile, []);
  } finally { ctx.destroy(); }
});

test('a refused read stays on the tab and shows the reason', async () => {
  const ctx = setupDom({ readImpl: () => ({ ok: false, error: 'access to sensitive path denied' }) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'touched');
    assert.match(ctx.document.getElementById('touched-summary').textContent, /access to sensitive path denied/);
  } finally { ctx.destroy(); }
});

test('an omitted count, malformed lines and a truncated read are each reported', async () => {
  const ctx = setupDom({
    touchedImpl: () => result({
      omitted: 7,
      coverage: { transcripts: 3, subagents: 2, malformedLines: 4, skippedLines: 2, truncated: true },
    }),
  });
  try {
    await openTab(ctx);
    const text = ctx.document.getElementById('touched-summary').textContent;
    assert.match(text, /7 more/);
    assert.match(text, /2 subagents/);
    assert.match(text, /4 unreadable lines/);
    assert.match(text, /2 oversized lines/);
    assert.match(text, /read only part/i);
  } finally { ctx.destroy(); }
});

test('a path that looks like markup is shown as text', async () => {
  const hostile = '/work/<img src=x onerror=alert(1)>.txt';
  const ctx = setupDom({ touchedImpl: () => result({ files: [row({ path: hostile })], unresolved: [{ raw: '<b>raw</b>', reason: 'invalid', tools: ['Edit'], count: 1, sources: ['<i>x</i>'] }] }) });
  try {
    await openTab(ctx);
    assert.equal(ctx.document.querySelector('#touched-list img'), null);
    assert.equal(ctx.document.querySelector('#touched-list b'), null);
    assert.equal(ctx.document.querySelector('#touched-list i'), null);
    assert.ok(rows(ctx)[0].textContent.includes(hostile));
  } finally { ctx.destroy(); }
});

test('a response that arrives after the tab was replaced is dropped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = setupDom({ touchedImpl: () => gate.then(() => result()) });
  try {
    ctx.window.switchPanel('s1');
    ctx.document.getElementById('touched-toggle-btn').click();
    ctx.window.openDiffTab('s1', 'd1', { oldFilePath: '/work/other.txt', oldContent: 'a\n', newContent: 'b\n' });
    release();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.type, 'diff');
    assert.equal(rows(ctx).length, 0);
  } finally { ctx.destroy(); }
});

test('the toggle closes the tab, and the refresh button asks again', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    ctx.document.getElementById('touched-refresh-btn').click();
    await flush();
    assert.deepEqual(ctx.calls.touched, ['s1', 's1']);
    const btn = ctx.document.getElementById('touched-toggle-btn');
    btn.click();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab, null);
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(ctx.document.getElementById('file-panel-touched').style.display, 'none');
  } finally { ctx.destroy(); }
});

test('the touched toggle sits after Changes and before Stop in the header', () => {
  const ctx = setupDom();
  try {
    const ids = [...ctx.document.getElementById('terminal-header-controls').children].map((e) => e.id);
    assert.deepEqual(ids, ['ide-emulation-indicator', 'changes-toggle-btn', 'touched-toggle-btn', 'terminal-stop-btn']);
  } finally { ctx.destroy(); }
});

test('round 3: the Touched header toggles its dirty editor with the Changes discard guard', async () => {
  let agree = false;
  let prompts = 0;
  const ctx = setupDom({ confirmImpl: () => { prompts++; return agree; } });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    const tab = ctx.stateOf('s1').currentTab;
    const view = ctx.editors.at(-1);
    view.setText('unsaved');
    const btn = ctx.document.getElementById('touched-toggle-btn');
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    btn.click();
    await flush();
    assert.equal(prompts, 1);
    assert.equal(ctx.stateOf('s1').currentTab, tab);
    assert.equal(ctx.editors.at(-1), view);
    assert.equal(view.current, 'unsaved');
    agree = true;
    btn.click();
    await flush();
    assert.equal(prompts, 2);
    assert.equal(ctx.stateOf('s1').currentTab, null);
    assert.equal(ctx.stateOf('s1').touchedStashes?.size ?? 0, 0);
    assert.deepEqual(ctx.watchCalls.at(-1), ['unwatch', '/work/a.txt']);
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(ctx.calls.touched.length, 1);
    assert.equal(ctx.calls.readFile.length, 1);
  } finally { ctx.destroy(); }
});

test('round 3: a symlink Touched pair uses the shared chrome read-only and cannot save', async () => {
  const ctx = setupDom({ readImpl: () => ({ ok: true, git: false, readOnly: true, original: 'target', current: 'target' }) });
  try {
    await openTab(ctx);
    const list = ctx.stateOf('s1').currentTab;
    const row = rows(ctx)[0];
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.equal(ctx.editors.at(-1).mode, 'read-only');
    assert.equal(ctx.document.getElementById('changes-diff-save-btn').style.display, 'none');
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /read-only/);
    ctx.editors.at(-1).setText('injected edit');
    ctx.window.updateChangesSaveButton('s1', ctx.stateOf('s1').currentTab);
    assert.equal(ctx.document.getElementById('changes-diff-save-btn').disabled, true);
    await ctx.window.handleChangesSave('s1');
    assert.equal(ctx.calls.save.length, 0);
    ctx.document.getElementById('changes-diff-close-btn').click();
    assert.equal(ctx.stateOf('s1').currentTab, list);
    assert.equal(rows(ctx)[0], row);
    assert.equal(ctx.calls.touched.length, 1);
  } finally { ctx.destroy(); }
});

function editorChrome(ctx) {
  const view = ctx.document.getElementById('changes-diff-view');
  return [...view.querySelectorAll('.viewer-toolbar, .viewer-toolbar-controls button')].map(el => [el.id, el.className, el.style.display]);
}

test('Touched and Changes build the same editor chrome and diff for a modified file', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await ctx.window.openChangesDiff('s1', { path: 'a.txt', staged: true });
    await flush();
    const chrome = editorChrome(ctx);
    const changesEditor = ctx.editors.at(-1);
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.equal(ctx.document.getElementById('changes-diff-view').style.display, 'flex');
    assert.deepEqual(editorChrome(ctx), chrome);
    const touchedEditor = ctx.editors.at(-1);
    assert.notEqual(touchedEditor, changesEditor);
    assert.equal(touchedEditor.mode, changesEditor.mode);
    assert.equal(touchedEditor.original, changesEditor.original);
    assert.equal(touchedEditor.current, changesEditor.current);
  } finally { ctx.destroy(); }
});

for (const [name, pair, expectedMode] of [
  ['untracked', { original: '', current: 'new file', git: true, version: 'v1' }, 'inline'],
  ['clean', { original: 'unchanged', current: 'unchanged', git: true, version: 'v1' }, 'plain'],
  ['non-git', { original: 'plain', current: 'plain', git: false }, 'plain'],
]) {
  test(name + ' Touched file uses shared chrome and Close preserves the list without any IPC', async () => {
    const ctx = setupDom({ readImpl: () => ({ ok: true, ...pair }) });
    try {
      await openTab(ctx);
      const tab = ctx.stateOf('s1').currentTab;
      tab.sort = 'path';
      tab.windowDays = 11;
      tab.windowStart -= 10 * 86400000;
      ctx.window.renderPanel('s1');
      const list = ctx.document.getElementById('touched-list');
      const first = rows(ctx)[0];
      list.scrollTop = 173;
      clickRow(ctx, '/work/a.txt');
      await flush();
      assert.equal(ctx.document.getElementById('changes-diff-view').style.display, 'flex');
      assert.equal(ctx.editors.at(-1).mode, expectedMode);
      assert.equal(ctx.document.getElementById('changes-diff-save-btn').style.display, '');
      const before = JSON.stringify(ctx.calls);
      ctx.document.getElementById('changes-diff-close-btn').click();
      assert.equal(ctx.stateOf('s1').currentTab, tab);
      assert.equal(rows(ctx)[0], first);
      assert.equal(list.scrollTop, 173);
      assert.equal(tab.sort, 'path');
      assert.equal(tab.windowDays, 11);
      assert.ok(first.classList.contains('selected'));
      assert.equal(JSON.stringify(ctx.calls), before);
    } finally { ctx.destroy(); }
  });
}

for (const git of [true, false]) {
  test('Touched save and reload keep the absolute target and agreed base (git=' + git + ')', async () => {
    let reads = 0;
    const ctx = setupDom({ readImpl: () => ({ ok: true, git, version: reads++ ? 'v2' : 'v1', original: git ? 'base' : 'file body', current: reads > 1 ? 'saved edit' : 'file body' }) });
    try {
      await openTab(ctx);
      clickRow(ctx, '/work/a.txt');
      await flush();
      ctx.editors.at(-1).setText('saved edit');
      ctx.document.getElementById('changes-diff-save-btn').click();
      await flush();
      assert.equal(ctx.calls.save.length, 1);
      assert.equal(ctx.calls.save[0].filePath, '/work/a.txt');
      assert.equal(ctx.calls.save[0].content, 'saved edit');
      assert.equal(ctx.calls.save[0].expected, 'file body');
      assert.equal(ctx.calls.save[0].options.git, git);
      assert.equal(ctx.calls.save[0].options.version, 'v1');
      assert.equal(ctx.calls.touched.length, 1);
      assert.equal(ctx.calls.status.length, 0);
      assert.equal(ctx.calls.gitFile.length, 0);
      ctx.document.getElementById('changes-diff-reload-btn').click();
      await flush();
      assert.equal(ctx.calls.readFile.at(-1), '/work/a.txt');
      ctx.document.getElementById('changes-diff-close-btn').click();
      assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
    } finally { ctx.destroy(); }
  });
}

test('Touched dirty edits survive a diff the session opens and closes, with their return list and save target', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    const listTab = ctx.stateOf('s1').currentTab;
    clickRow(ctx, '/work/a.txt');
    await flush();
    ctx.editors.at(-1).setText('unsaved');
    ctx.window.openDiffTab('s1', 'd1', { oldFilePath: '/work/other.txt', oldContent: 'a\n', newContent: 'b\n' });
    ctx.window.closeDiffByDiffId('s1', 'd1');
    await flush();
    assert.equal(ctx.editors.at(-1).current, 'unsaved');
    assert.equal(ctx.stateOf('s1').currentTab.returnList, listTab);
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/a.txt');
    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();
    assert.equal(ctx.calls.save.length, 1, 'the restored Save control is enabled');
    assert.equal(ctx.calls.save[0].filePath, '/work/a.txt');
    ctx.document.getElementById('changes-diff-close-btn').click();
    assert.equal(ctx.stateOf('s1').currentTab, listTab);
  } finally { ctx.destroy(); }
});

test('Touched edits participate in the existing unsaved-file close prompt', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    ctx.editors.at(-1).setText('unsaved');
    const pending = ctx.window.askAboutUnsavedEdits();
    const dialog = ctx.document.getElementById('unsaved-save');
    assert.ok(dialog, 'the unsaved-file prompt includes the Touched editor');
    dialog.click();
    await flush();
    assert.equal(await pending, true);
    assert.equal(ctx.calls.save[0].filePath, '/work/a.txt');
  } finally { ctx.destroy(); }
});

for (const [dirty, git] of [[true, true], [false, true], [true, false], [false, false]]) {
  test('Touched file watcher rereads its absolute path and protects dirty text (dirty=' + dirty + ', git=' + git + ')', async () => {
    let reads = 0;
    const ctx = setupDom({ readImpl: () => ({ ok: true, git, original: git ? 'base' : 'current', current: reads++ ? 'external' : 'current', version: git ? (reads > 1 ? 'v2' : 'v1') : undefined }) });
    try {
      await openTab(ctx);
      clickRow(ctx, '/work/a.txt');
      await flush();
      assert.deepEqual(ctx.watchCalls, [['watch', '/work/a.txt']]);
      if (dirty) ctx.editors.at(-1).setText('typing');
      ctx.changed('/work/other.txt');
      await flush();
      assert.equal(ctx.calls.readFile.length, 1);
      ctx.changed('/work/a.txt');
      await flush();
      assert.equal(ctx.calls.readFile.length, 2);
      assert.equal(ctx.editors.at(-1).current, dirty ? 'typing' : 'external');
      assert.equal(ctx.stateOf('s1').currentTab.externalChange, dirty);
      ctx.document.getElementById('changes-diff-close-btn').click();
      assert.deepEqual(ctx.watchCalls.at(-1), ['unwatch', '/work/a.txt']);
      assert.equal(ctx.calls.touched.length, 1);
    } finally { ctx.destroy(); }
  });
}

test('round 2: Changes and Touched retain separate unsaved files through the toggles', async () => {
  const ctx = setupDom({ touchedImpl: () => result({ files: [row({ path: '/work/b.txt' })] }) });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await ctx.window.openChangesDiff('s1', { path: 'a.txt', staged: true });
    await flush();
    ctx.editors.at(-1).setText('unsaved A');
    await openTab(ctx);
    clickRow(ctx, '/work/b.txt');
    await flush();
    ctx.editors.at(-1).setText('unsaved B');
    ctx.document.getElementById('changes-toggle-btn').click();
    await flush();
    assert.ok(ctx.stateOf('s1').currentTab, 'Changes opens a tab');
    assert.equal(ctx.stateOf('s1').currentTab.selectedFile.path, 'a.txt');
    assert.equal(ctx.editors.at(-1).current, 'unsaved A');
    assert.equal(ctx.stateOf('s1').currentTab.returnList, undefined);
    ctx.document.getElementById('touched-toggle-btn').click();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/b.txt');
    assert.equal(ctx.editors.at(-1).current, 'unsaved B');
  } finally { ctx.destroy(); }
});

test('round 2: Touched editor does not activate Changes and its toggle opens Changes', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.equal(ctx.document.getElementById('changes-toggle-btn').getAttribute('aria-pressed'), 'false');
    ctx.document.getElementById('changes-toggle-btn').click();
    await flush();
    assert.ok(ctx.stateOf('s1').currentTab, 'the Changes toggle opens its list');
    assert.equal(ctx.stateOf('s1').currentTab.type, 'changes');
    assert.equal(ctx.stateOf('s1').currentTab.returnList, undefined);
    assert.equal(ctx.calls.status.length, 1);
  } finally { ctx.destroy(); }
});

test('round 2: unchanged Touched editor makes no file or git call on session idle', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    const before = JSON.stringify(ctx.calls);
    ctx.window.notifySessionIdle('s1');
    await flush();
    assert.equal(JSON.stringify(ctx.calls), before);
    ctx.document.getElementById('changes-diff-reload-btn').click();
    await flush();
    assert.equal(ctx.calls.readFile.length, 2);
  } finally { ctx.destroy(); }
});

test('round 3: watcher switches identical Touched text between a file and a read-only symlink', async () => {
  let readOnly = false;
  const ctx = setupDom({ readImpl: () => ({ ok: true, git: false, readOnly, original: 'same', current: 'same' }) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.equal(ctx.editors.at(-1).mode, 'plain');
    readOnly = true;
    ctx.changed('/work/a.txt');
    await flush();
    assert.equal(ctx.editors.at(-1).mode, 'read-only');
    assert.equal(ctx.document.getElementById('changes-diff-save-btn').style.display, 'none');
    readOnly = false;
    ctx.changed('/work/a.txt');
    await flush();
    assert.equal(ctx.editors.at(-1).mode, 'plain');
    assert.equal(ctx.document.getElementById('changes-diff-save-btn').style.display, '');
    assert.equal(ctx.calls.touched.length, 1);
  } finally { ctx.destroy(); }
});

function markdownDom(paths, { content = '# Title\n', original = content, ...over } = {}) {
  return setupDom({
    touchedImpl: () => result({ files: paths.map(p => row({ path: p })) }),
    readImpl: () => ({ ok: true, original, current: content, version: 'v1', git: true }),
    ...over,
  });
}

function markdownChrome(ctx) {
  const byId = id => ctx.document.getElementById(id);
  return { format: byId('changes-diff-format-btn'), preview: byId('changes-diff-preview'), host: byId('changes-diff-host'), mode: byId('changes-diff-mode-btn'), save: byId('changes-diff-save-btn') };
}

async function openRow(ctx, filePath) {
  clickRow(ctx, filePath);
  await flush();
}

function assertFormatted(ctx, heading) {
  const { format, preview, host } = markdownChrome(ctx);
  assert.equal(preview?.querySelector('h1')?.textContent, heading);
  assert.equal(preview.style.display, '');
  assert.equal(host.style.display, 'none');
  assert.equal(format.getAttribute('aria-pressed'), 'true');
}

function assertSource(ctx) {
  const { format, preview, host } = markdownChrome(ctx);
  assert.equal(format?.getAttribute('aria-pressed'), 'false');
  assert.equal(preview.style.display, 'none');
  assert.equal(host.style.display, '');
}

test('markdown: a Touched markdown file opens formatted, its diff mode hidden', async () => {
  const ctx = markdownDom(['/work/README.md'], { original: '# Old\n' });
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    assert.equal(markdownChrome(ctx).mode.style.display, 'none');
  } finally { ctx.destroy(); }
});

test('markdown: a stored value other than false opens formatted', async () => {
  const ctx = markdownDom(['/work/README.md']);
  try {
    ctx.window.localStorage.setItem('touchedMarkdownFormatted', 'x');
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
  } finally { ctx.destroy(); }
});

test('markdown: a watcher reload re-renders the formatted view', async () => {
  let content = '# One\n';
  const ctx = markdownDom(['/work/README.md'], {
    readImpl: () => ({ ok: true, original: content, current: content, version: content, git: true }),
  });
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'One');
    content = '# Two\n';
    ctx.changed('/work/README.md');
    await flush();
    assertFormatted(ctx, 'Two');
  } finally { ctx.destroy(); }
});

test('markdown: opening another file shows the formatted view from its top', async () => {
  const ctx = markdownDom(['/work/a.md', '/work/b.md']);
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/a.md');
    const { preview } = markdownChrome(ctx);
    let scrollTop = 0;
    Object.defineProperty(preview, 'scrollTop', { get: () => scrollTop, set: (value) => { scrollTop = value; }, configurable: true });
    scrollTop = 500;
    ctx.changed('/work/a.md');
    await flush();
    assert.equal(scrollTop, 500, 'a re-render of the same file keeps its position');
    await openRow(ctx, '/work/b.md');
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/b.md');
    assert.equal(scrollTop, 0);
  } finally { ctx.destroy(); }
});

test('markdown: the same file in another session shows the formatted view from its top', async () => {
  const ctx = markdownDom(['/work/README.md']);
  try {
    await openTab(ctx, 's1');
    await openRow(ctx, '/work/README.md');
    const { preview } = markdownChrome(ctx);
    let scrollTop = 0;
    Object.defineProperty(preview, 'scrollTop', { get: () => scrollTop, set: (value) => { scrollTop = value; }, configurable: true });
    scrollTop = 500;
    await openTab(ctx, 's2');
    await openRow(ctx, '/work/README.md');
    assert.equal(ctx.stateOf('s2').currentTab.absolutePath, '/work/README.md');
    assertFormatted(ctx, 'Title');
    assert.equal(scrollTop, 0);
  } finally { ctx.destroy(); }
});

test('markdown: a file that is not markdown has no format toggle and no preview', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/a.txt');
    const { format, preview, host } = markdownChrome(ctx);
    assert.equal(format?.style.display, 'none');
    assert.equal(preview.style.display, 'none');
    assert.equal(host.style.display, '');
  } finally { ctx.destroy(); }
});

test('markdown: .markdown and upper-case .MDX open formatted', async () => {
  const ctx = markdownDom(['/work/README.markdown', '/work/x.MDX']);
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.markdown');
    assertFormatted(ctx, 'Title');
    await openRow(ctx, '/work/x.MDX');
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/x.MDX');
    assertFormatted(ctx, 'Title');
  } finally { ctx.destroy(); }
});

test('markdown: the source toggle is remembered for the next markdown file', async () => {
  const ctx = markdownDom(['/work/README.md', '/work/b.md']);
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    markdownChrome(ctx).format.click();
    await flush();
    assertSource(ctx);
    assert.equal(ctx.window.localStorage.getItem('touchedMarkdownFormatted'), 'false');
    await openRow(ctx, '/work/b.md');
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/b.md');
    assertSource(ctx);
  } finally { ctx.destroy(); }
});

test('markdown: formatted shows the unsaved buffer, and Save stays available', async () => {
  const ctx = markdownDom(['/work/README.md']);
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    markdownChrome(ctx).format.click();
    await flush();
    ctx.editors.at(-1).setText('# Edited\n');
    markdownChrome(ctx).format.click();
    await flush();
    assertFormatted(ctx, 'Edited');
    const { save } = markdownChrome(ctx);
    assert.equal(save.style.display, '');
    assert.equal(save.disabled, false);
  } finally { ctx.destroy(); }
});

test('markdown: the formatted view is sanitised', async () => {
  const ctx = markdownDom(['/work/README.md'], { content: '[x](javascript:alert(1)) <img src=x onerror=alert(1)>\n' });
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    const { preview } = markdownChrome(ctx);
    assert.ok(preview?.querySelector('p'), 'the document is rendered');
    assert.equal(preview.querySelector('a[href^="javascript:"]'), null);
    assert.equal(preview.querySelector('[onerror]'), null);
  } finally { ctx.destroy(); }
});

test('markdown: a throwing storage opens formatted and the toggle still works', async () => {
  const ctx = markdownDom(['/work/README.md'], { storageThrows: true });
  const errors = [];
  ctx.window.addEventListener('error', event => errors.push(event.error));
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    markdownChrome(ctx).format.click();
    await flush();
    assertSource(ctx);
    assert.deepEqual(errors, []);
  } finally { ctx.destroy(); }
});

test('markdown: toggling keeps the same editor and its buffer', async () => {
  const ctx = markdownDom(['/work/README.md'], { original: '# Old\n' });
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    const tab = ctx.stateOf('s1').currentTab;
    const editor = tab.editorView;
    assert.ok(editor, 'the editor exists while formatted');
    editor.setText('# Kept\n');
    const count = ctx.editors.length;
    markdownChrome(ctx).format.click();
    await flush();
    assert.equal(markdownChrome(ctx).mode.style.display, '');
    markdownChrome(ctx).format.click();
    await flush();
    assert.equal(tab.editorView, editor);
    assert.equal(ctx.editors.length, count);
    assert.equal(editor.current, '# Kept\n');
    assert.ok(editor.dom.isConnected);
  } finally { ctx.destroy(); }
});

test('markdown: a Changes list editor on a markdown file has no format toggle', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await ctx.window.openChangesDiff('s1', { path: 'README.md', staged: true });
    await flush();
    const { format, preview, host } = markdownChrome(ctx);
    assert.equal(ctx.stateOf('s1').currentTab.selectedFile.path, 'README.md');
    assert.equal(format?.style.display, 'none');
    assert.equal(preview.style.display, 'none');
    assert.equal(host.style.display, '');
  } finally { ctx.destroy(); }
});

test('markdown: Escape from the formatted view closes the editor', async () => {
  const ctx = markdownDom(['/work/README.md']);
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    markdownChrome(ctx).format.click();
    await flush();
    markdownChrome(ctx).format.click();
    await flush();
    assertFormatted(ctx, 'Title');
    ctx.document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
  } finally { ctx.destroy(); }
});

test('markdown: a formatted render that resolves late does not replace the file now open', async () => {
  const ctx = markdownDom(['/work/a.md', '/work/b.md'], {
    readImpl: filePath => ({ ok: true, original: '', current: filePath === '/work/a.md' ? '# A\n' : '# B\n', version: 'v1', git: false }),
  });
  try {
    await openTab(ctx);
    const pending = [];
    ctx.window.loadCodeMirrorBundle = () => new Promise(resolve => pending.push(() => { ctx.window.marked = ctx.bundledMarked; resolve(); }));
    await openRow(ctx, '/work/a.md');
    await openRow(ctx, '/work/b.md');
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/b.md');
    pending.reverse().forEach(resolve => resolve());
    await flush();
    assertFormatted(ctx, 'B');
  } finally { ctx.destroy(); }
});

test('markdown: a restored Touched stash recomputes formatted from the preference', async () => {
  const ctx = markdownDom(['/work/README.md']);
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    markdownChrome(ctx).format.click();
    await flush();
    ctx.editors.at(-1).setText('# Unsaved\n');
    ctx.window.localStorage.setItem('touchedMarkdownFormatted', 'true');
    ctx.window.openDiffTab('s1', 'd1', { oldFilePath: '/work/other.js', oldContent: 'a\n', newContent: 'b\n' });
    ctx.window.closeDiffByDiffId('s1', 'd1');
    await flush();
    const tab = ctx.stateOf('s1').currentTab;
    assert.equal(tab.absolutePath, '/work/README.md');
    assert.equal(tab.restoredEdits, true);
    assertFormatted(ctx, 'Unsaved');
  } finally { ctx.destroy(); }
});

// --- Every clicked file opens in Touched — see .ai/contexts/touched-files.md ("Opened rows")

async function openLink(ctx, filePath, opts, sessionId = 's1') {
  await ctx.window.openFileInPanel(sessionId, filePath, opts);
  await flush();
}

function openedRows(ctx) {
  return rows(ctx).filter(r => r.classList.contains('touched-opened'));
}

function summaryText(ctx) {
  return ctx.document.getElementById('touched-summary').textContent;
}

test('a link opens the file in Touched, listed first as opened and selected', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/notes.txt');
    const tab = ctx.stateOf('s1').currentTab;
    assert.equal(tab.returnList?.type, 'touched');
    assert.equal(tab.absolutePath, '/work/notes.txt');
    const first = rows(ctx)[0];
    assert.equal(first.dataset.path, '/work/notes.txt');
    assert.ok(first.classList.contains('touched-opened'));
    assert.ok(first.classList.contains('selected'));
    assert.equal(first.querySelector('.touched-file-state').textContent, 'opened');
    assert.ok(ctx.document.getElementById('file-panel').classList.contains('open'));
  } finally { ctx.destroy(); }
});

test('an opened row is not counted as touched', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/notes.txt');
    assert.match(summaryText(ctx), /^1 file touched/);
  } finally { ctx.destroy(); }
});

test('a link to a touched file selects its touched row and adds no opened row', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/a.txt');
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/a.txt');
    assert.deepEqual(rows(ctx).map(r => r.dataset.path), ['/work/a.txt']);
    assert.equal(openedRows(ctx).length, 0);
    assert.ok(rows(ctx)[0].classList.contains('selected'));
  } finally { ctx.destroy(); }
});

for (const [name, link] of [['another case', String.raw`c:\w\a.js`], ['mixed separators', 'c:/w\\a.js']]) {
  test(`on Windows a link spelt with ${name} selects the touched row`, async () => {
    const ctx = setupDom({ touchedImpl: () => result({ files: [row({ path: String.raw`C:\w\a.js` })] }) });
    try {
      ctx.window.api.platform = 'win32';
      ctx.window.switchPanel('s1');
      await openLink(ctx, link);
      assert.equal(ctx.stateOf('s1').currentTab.absolutePath, link);
      assert.equal(openedRows(ctx).length, 0);
      assert.equal(rows(ctx).length, 1);
      assert.ok(rows(ctx)[0].classList.contains('selected'));
    } finally { ctx.destroy(); }
  });
}

test('opened rows survive Refresh and closing and reopening Touched', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/notes.txt');
    ctx.document.getElementById('touched-refresh-btn').click();
    await flush();
    const toggle = ctx.document.getElementById('touched-toggle-btn');
    toggle.click();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab, null);
    toggle.click();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
    assert.equal(rows(ctx)[0].dataset.path, '/work/notes.txt');
    assert.ok(rows(ctx)[0].classList.contains('touched-opened'));
  } finally { ctx.destroy(); }
});

test('opened rows belong to the session they were opened in', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/notes.txt');
    assert.equal(openedRows(ctx).length, 1);
    await openTab(ctx, 's2');
    assert.equal(ctx.stateOf('s2').currentTab.type, 'touched');
    assert.equal(openedRows(ctx).length, 0);
  } finally { ctx.destroy(); }
});

test('a refused read adds no row, opens no editor and shows the reason without the path', async () => {
  const ctx = setupDom({ readImpl: () => ({ ok: false, error: 'access to sensitive path denied' }) });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/home/u/.ssh/id_rsa');
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'touched');
    assert.equal(openedRows(ctx).length, 0);
    const err = ctx.document.querySelector('#touched-summary .changes-error');
    assert.match(err.textContent, /access to sensitive path denied/);
    assert.doesNotMatch(err.textContent, /id_rsa/);
  } finally { ctx.destroy(); }
});

test('a list that cannot be read does not stop the open, and the opened row is drawn', async () => {
  const ctx = setupDom({ touchedImpl: () => ({ ok: false, reason: 'no-transcript', error: 'this session has no transcript on disk' }) });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/notes.txt');
    assert.equal(ctx.stateOf('s1').currentTab.absolutePath, '/work/notes.txt');
    assert.deepEqual(openedRows(ctx).map(r => r.dataset.path), ['/work/notes.txt']);
    assert.match(summaryText(ctx), /no transcript on disk/);
  } finally { ctx.destroy(); }
});

test('a link to another file over a dirty editor asks, and No keeps everything and reads nothing', async () => {
  const ctx = setupDom({ confirmImpl: () => false });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    const tab = ctx.stateOf('s1').currentTab;
    ctx.editors.at(-1).setText('dirty');
    await openLink(ctx, '/work/b.txt');
    assert.equal(ctx.calls.confirm, 1);
    assert.equal(ctx.stateOf('s1').currentTab, tab);
    assert.equal(ctx.editors.at(-1).current, 'dirty');
    assert.deepEqual(ctx.calls.readFile, ['/work/a.txt']);
  } finally { ctx.destroy(); }
});

for (const [name, rowPath, link, platform] of [
  ['the same spelling', '/work/a.txt', '/work/a.txt', null],
  ['another spelling on Windows', String.raw`C:\w\a.js`, String.raw`c:\w\a.js`, 'win32'],
  ['a formatted markdown file', '/work/README.md', '/work/README.md', null],
]) {
  test(`a link with a line to the file already open reveals the line in the source, without asking or reading (${name})`, async () => {
    const ctx = markdownDom([rowPath]);
    try {
      if (platform) ctx.window.api.platform = platform;
      await openTab(ctx);
      clickRow(ctx, rowPath);
      await flush();
      const tab = ctx.stateOf('s1').currentTab;
      const view = ctx.editors.at(-1);
      view.setText('# Dirty\n');
      await openLink(ctx, link, { line: 7 });
      assert.equal(ctx.calls.confirm, 0);
      assert.equal(ctx.stateOf('s1').currentTab, tab);
      assert.equal(ctx.editors.at(-1), view);
      assert.deepEqual(ctx.calls.readFile, [rowPath]);
      assert.deepEqual(ctx.calls.revealed, [7]);
      assert.equal(tab.formatted, false);
      assert.equal(markdownChrome(ctx).host.style.display, '');
    } finally { ctx.destroy(); }
  });
}

test('a link or a row click on the formatted file already open keeps it formatted and reads nothing', async () => {
  const ctx = markdownDom(['/work/README.md']);
  try {
    await openTab(ctx);
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    await openLink(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    await openRow(ctx, '/work/README.md');
    assertFormatted(ctx, 'Title');
    assert.deepEqual(ctx.calls.readFile, ['/work/README.md']);
  } finally { ctx.destroy(); }
});

test('a path:line link to a markdown file opens the source at that line and leaves the preference alone', async () => {
  const ctx = markdownDom(['/work/README.md']);
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/README.md', { line: 12 });
    assertSource(ctx);
    assert.deepEqual(ctx.calls.revealed, [12]);
    assert.equal(ctx.window.localStorage.getItem('touchedMarkdownFormatted'), null);
  } finally { ctx.destroy(); }
});

test('a link to a file the working tree reports changed opens in Touched with its diff, not in Changes', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/notes.txt');
    assert.deepEqual(ctx.calls.gitFile, []);
    assert.equal(ctx.stateOf('s1').currentTab.returnList?.type, 'touched');
    assert.equal(ctx.document.getElementById('changes-diff-mode-btn').style.display, '');
  } finally { ctx.destroy(); }
});

test('a link clicked in a panel shell opens in the panel of the session that owns the shell', async () => {
  const ctx = setupDom({ ownerOf: id => (id === 'shell-1' ? 'owner' : null) });
  try {
    ctx.window.switchPanel('owner');
    await openLink(ctx, '/work/notes.txt', undefined, 'shell-1');
    assert.equal(ctx.stateOf('owner').currentTab?.absolutePath, '/work/notes.txt');
    assert.deepEqual(ctx.calls.touched, ['owner']);
    assert.equal(ctx.stateOf('shell-1')?.currentTab ?? null, null);
    assert.ok(ctx.document.getElementById('file-panel').classList.contains('open'));
  } finally { ctx.destroy(); }
});

test('opened rows keep the fifty newest, and opening one again moves it to the top', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    for (let i = 0; i < 51; i++) await openLink(ctx, `/work/n${i}.txt`);
    assert.equal(openedRows(ctx).length, 50);
    assert.equal(openedRows(ctx)[0].dataset.path, '/work/n50.txt');
    assert.equal(openedRows(ctx).at(-1).dataset.path, '/work/n1.txt');
    await openLink(ctx, '/work/n10.txt');
    assert.equal(new Set(openedRows(ctx).map(r => r.dataset.path)).size, 50);
    assert.equal(openedRows(ctx)[0].dataset.path, '/work/n10.txt');
    assert.equal(openedRows(ctx).at(-1).dataset.path, '/work/n1.txt');
  } finally { ctx.destroy(); }
});

test('a link in a remote session opens nothing and reads nothing, decided main-side', async () => {
  const ctx = setupDom({ resolveImpl: (_id, texts) => texts.map(() => ({ ok: false, reason: 'remote' })) });
  try {
    ctx.window.switchPanel('r1');
    assert.equal(ctx.document.querySelector('.session-item'), null);
    await openLink(ctx, '/x/a.txt', undefined, 'r1');
    assert.deepEqual(ctx.calls.resolve.map(([id, texts]) => [id, [...texts]]), [['r1', ['/x/a.txt']]]);
    assert.deepEqual(ctx.calls.readFile, []);
    assert.deepEqual(ctx.calls.touched, []);
    assert.equal(ctx.stateOf('r1').currentTab, null);
    assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), false);
  } finally { ctx.destroy(); }
});

test('a link the path check refuses for another reason still goes to the guarded read', async () => {
  const ctx = setupDom({ resolveImpl: (_id, texts) => texts.map(() => ({ ok: false, reason: 'missing' })) });
  try {
    ctx.window.switchPanel('s1');
    await openLink(ctx, '/work/notes.txt');
    assert.deepEqual(ctx.calls.readFile, ['/work/notes.txt']);
  } finally { ctx.destroy(); }
});

test('a link in a remote session with no known working directory opens nothing, through the real resolution', async () => {
  const { resolveTerminalPathsCwd } = require('../terminal-path-target');
  const ctx = setupDom({
    resolveImpl: (id, texts) => {
      const where = resolveTerminalPathsCwd(id, {
        getSession: () => undefined,
        resolveTarget: () => ({ ok: false, kind: 'remote', error: 'remote session has no known working directory' }),
        resolvePanelCwd: () => ({ ok: false }),
      });
      return texts.map(() => ({ ok: false, reason: where.reason }));
    },
  });
  try {
    ctx.window.switchPanel('r1');
    await openLink(ctx, '/x/a.txt', undefined, 'r1');
    assert.deepEqual(ctx.calls.readFile, []);
    assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), false);
  } finally { ctx.destroy(); }
});

const DIFF = { oldFilePath: '/work/x.js', oldContent: 'a\n', newContent: 'b\n' };

function stashes(ctx, sessionId = 's1') {
  return ctx.stateOf(sessionId).touchedStashes || new Map();
}

async function dirtyTouched(ctx, filePath, text) {
  clickRow(ctx, filePath);
  await flush();
  ctx.editors.at(-1).setText(text);
}

function twoFiles() {
  return result({ files: [row({ path: '/work/a.txt' }), row({ path: '/work/b.txt' })] });
}

const CLOSE_ROUTES = [
  ['close_tab', ctx => ctx.window.closeDiffByDiffId('s1', 'd1')],
  ['closeAllDiffTabs', ctx => ctx.window.closeAllDiffs('s1')],
];

for (const [route, closeDiff] of CLOSE_ROUTES) {
test(`a link over an unanswered diff keeps the diff, answers nothing, and opens once the session closes it (${route})`, async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await openLink(ctx, '/work/notes.txt');
    assert.equal(ctx.stateOf('s1').currentTab.type, 'diff');
    assert.deepEqual(ctx.calls.diffResponse, []);
    assert.deepEqual(ctx.calls.readFile, []);
    closeDiff(ctx);
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab?.absolutePath, '/work/notes.txt');
    assert.equal(ctx.stateOf('s1').currentTab?.returnList?.type, 'touched');
  } finally { ctx.destroy(); }
});
}

test('a deferred open is dropped when another route takes the diff out of the slot', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await openLink(ctx, '/work/notes.txt');
    const toggle = ctx.document.getElementById('touched-toggle-btn');
    toggle.click();
    await flush();
    toggle.click();
    await flush();
    assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), false);
    ctx.window.openDiffTab('s1', 'd2', DIFF);
    ctx.window.closeDiffByDiffId('s1', 'd2');
    await flush();
    assert.deepEqual(ctx.calls.readFile, []);
    assert.notEqual(ctx.stateOf('s1').currentTab?.absolutePath, '/work/notes.txt');
  } finally { ctx.destroy(); }
});

test('a replayed open never asks, and the stash it passes over stays stashed', async () => {
  const ctx = setupDom({ touchedImpl: twoFiles });
  try {
    await openTab(ctx);
    await dirtyTouched(ctx, '/work/a.txt', 'unsaved A');
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await openLink(ctx, '/work/b.txt');
    ctx.window.closeDiffByDiffId('s1', 'd1');
    await flush();
    assert.equal(ctx.calls.confirm, 0);
    assert.equal(ctx.stateOf('s1').currentTab?.absolutePath, '/work/b.txt');
    assert.deepEqual([...stashes(ctx).keys()], ['/work/a.txt']);
    assert.equal(stashes(ctx).get('/work/a.txt').content, 'unsaved A');
  } finally { ctx.destroy(); }
});

for (const [route, closeDiff] of CLOSE_ROUTES) {
test(`Touched edits stashed by a diff come back when the session closes the diff (${route})`, async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    await dirtyTouched(ctx, '/work/a.txt', 'unsaved');
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    closeDiff(ctx);
    await flush();
    const tab = ctx.stateOf('s1').currentTab;
    assert.equal(tab?.absolutePath, '/work/a.txt');
    assert.equal(ctx.editors.at(-1).current, 'unsaved');
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /Unsaved edits kept/);
    assert.equal(stashes(ctx).size, 0);
  } finally { ctx.destroy(); }
});
}

test('a link while a stash exists opens the clicked file, and the stashed file comes back from its row without a read', async () => {
  const ctx = setupDom({ touchedImpl: twoFiles });
  try {
    await openTab(ctx);
    await dirtyTouched(ctx, '/work/a.txt', 'unsaved A');
    ctx.document.getElementById('changes-toggle-btn').click();
    await flush();
    await openLink(ctx, '/work/b.txt');
    assert.equal(ctx.calls.confirm, 0);
    assert.equal(ctx.stateOf('s1').currentTab?.absolutePath, '/work/b.txt');
    assert.deepEqual([...stashes(ctx).keys()], ['/work/a.txt']);
    await openRow(ctx, '/work/a.txt');
    assert.equal(ctx.stateOf('s1').currentTab?.absolutePath, '/work/a.txt');
    assert.equal(ctx.editors.at(-1).current, 'unsaved A');
    assert.equal(ctx.stateOf('s1').currentTab.restoredEdits, true);
    assert.deepEqual(ctx.calls.readFile, ['/work/a.txt', '/work/b.txt']);
    assert.equal(stashes(ctx).size, 0);
  } finally { ctx.destroy(); }
});

test('two Touched stashes are kept side by side, each with its text', async () => {
  const ctx = setupDom({ touchedImpl: twoFiles });
  try {
    await openTab(ctx);
    await dirtyTouched(ctx, '/work/a.txt', 'unsaved A');
    const changes = ctx.document.getElementById('changes-toggle-btn');
    changes.click();
    await flush();
    await openLink(ctx, '/work/b.txt');
    ctx.editors.at(-1).setText('unsaved B');
    changes.click();
    await flush();
    assert.deepEqual([...stashes(ctx)].map(([key, entry]) => [key, entry.content]), [['/work/a.txt', 'unsaved A'], ['/work/b.txt', 'unsaved B']]);
    ctx.document.getElementById('touched-toggle-btn').click();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab?.absolutePath, '/work/b.txt', 'the toggle restores the newest stash');
    assert.equal(ctx.editors.at(-1).current, 'unsaved B');
    assert.deepEqual([...stashes(ctx).keys()], ['/work/a.txt']);
  } finally { ctx.destroy(); }
});

test('the quit check lists a stashed Touched file and Save writes it with its version, then forgets it', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    await dirtyTouched(ctx, '/work/a.txt', 'unsaved');
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    const pending = ctx.window.askAboutUnsavedEdits();
    const items = [...ctx.document.querySelectorAll('#unsaved-edits-dialog li')];
    assert.deepEqual(items.map(li => [li.textContent, li.title]), [['a.txt', '/work/a.txt']]);
    ctx.document.getElementById('unsaved-save').click();
    await flush();
    assert.equal(await pending, true);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls.save)), [{ filePath: '/work/a.txt', content: 'unsaved', expected: 'file body', options: { git: true, version: 'v1' } }]);
    assert.equal(stashes(ctx).size, 0);
  } finally { ctx.destroy(); }
});

for (const route of ['Changes toggle', 'panel close', 'Touched toggle']) {
  test(`closing the panel by the ${route} keeps both stashes and restores neither`, async () => {
    const ctx = setupDom({ touchedImpl: twoFiles });
    try {
      await openTab(ctx);
      await dirtyTouched(ctx, '/work/a.txt', 'unsaved A');
      const changes = ctx.document.getElementById('changes-toggle-btn');
      changes.click();
      await flush();
      await openLink(ctx, '/work/b.txt');
      ctx.editors.at(-1).setText('unsaved B');
      changes.click();
      await flush();
      const editors = ctx.editors.length;
      if (route === 'Changes toggle') changes.click();
      else if (route === 'panel close') ctx.document.querySelector('#file-panel-changes .fp-close-btn').click();
      else {
        await openLink(ctx, '/work/c.txt');
        ctx.document.getElementById('changes-diff-close-btn').click();
        assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
        ctx.document.getElementById('touched-toggle-btn').click();
      }
      await flush();
      assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), false);
      assert.equal(ctx.stateOf('s1').currentTab, null);
      assert.equal(stashes(ctx).size, 2);
      assert.equal(ctx.editors.length, editors + (route === 'Touched toggle' ? 1 : 0));
    } finally { ctx.destroy(); }
  });
}

test('a stash restored from its row returns to the list now in the slot', async () => {
  const ctx = setupDom({ touchedImpl: twoFiles });
  try {
    await openTab(ctx);
    const first = ctx.stateOf('s1').currentTab;
    await dirtyTouched(ctx, '/work/a.txt', 'unsaved A');
    ctx.document.getElementById('changes-toggle-btn').click();
    await flush();
    await openLink(ctx, '/work/b.txt');
    const second = ctx.stateOf('s1').currentTab?.returnList;
    assert.notEqual(second, first);
    await openRow(ctx, '/work/a.txt');
    assert.equal(ctx.stateOf('s1').currentTab?.returnList, second);
    assert.equal(ctx.editors.at(-1).current, 'unsaved A');
  } finally { ctx.destroy(); }
});

test('Accept on a diff with a deferred open answers once and opens the file; the later close changes nothing', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await flush();
    await openLink(ctx, '/work/notes.txt');
    assert.equal(ctx.stateOf('s1').currentTab.type, 'diff');
    ctx.document.querySelector('.file-panel-accept-btn').click();
    await flush();
    assert.deepEqual(ctx.calls.diffResponse.map(args => args[2]), ['accept']);
    const tab = ctx.stateOf('s1').currentTab;
    assert.equal(tab?.absolutePath, '/work/notes.txt');
    ctx.window.closeDiffByDiffId('s1', 'd1');
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab, tab);
    assert.deepEqual(ctx.calls.readFile, ['/work/notes.txt']);
  } finally { ctx.destroy(); }
});

test('Accept with no deferred open keeps the answered diff in the slot', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await flush();
    ctx.document.querySelector('.file-panel-accept-btn').click();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.type, 'diff');
    assert.equal(ctx.stateOf('s1').currentTab.resolved, true);
  } finally { ctx.destroy(); }
});

for (const deferred of [false, true]) {
  test(`the panel close on an unanswered diff rejects it and never restores a stash (deferred open: ${deferred})`, async () => {
    const ctx = setupDom();
    try {
      await openTab(ctx);
      await dirtyTouched(ctx, '/work/a.txt', 'unsaved A');
      ctx.document.getElementById('changes-toggle-btn').click();
      await flush();
      ctx.window.openDiffTab('s1', 'd1', DIFF);
      if (deferred) await openLink(ctx, '/work/notes.txt');
      ctx.document.querySelector('#file-panel-diff .fp-close-btn').click();
      await flush();
      assert.deepEqual(ctx.calls.diffResponse.map(args => args[2]), ['reject']);
      assert.deepEqual([...stashes(ctx).keys()], ['/work/a.txt']);
      assert.equal(ctx.calls.confirm, 0);
      if (deferred) {
        assert.equal(ctx.stateOf('s1').currentTab?.absolutePath, '/work/notes.txt');
        ctx.window.openDiffTab('s1', 'd2', DIFF);
        ctx.window.closeDiffByDiffId('s1', 'd2');
        await flush();
        assert.deepEqual(ctx.calls.readFile.filter(p => p === '/work/notes.txt'), ['/work/notes.txt'], 'the open is replayed once');
        assert.equal(ctx.stateOf('s1').currentTab?.absolutePath, '/work/a.txt');
      } else {
        assert.equal(ctx.stateOf('s1').currentTab, null);
        assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), false);
      }
    } finally { ctx.destroy(); }
  });
}

test('the quit check keeps a stash whose save is refused, and forgets only the stash it saved', async () => {
  const ctx = setupDom({ saveImpl: call => (call === 0 ? { ok: true, version: 'v2' } : { ok: false, reason: 'stale', error: 'stale' }) });
  try {
    await openTab(ctx, 's1');
    await dirtyTouched(ctx, '/work/a.txt', 'one');
    ctx.window.openDiffTab('s1', 'd1', DIFF);
    await openTab(ctx, 's2');
    await dirtyTouched(ctx, '/work/a.txt', 'two');
    ctx.window.openDiffTab('s2', 'd2', DIFF);
    const pending = ctx.window.askAboutUnsavedEdits();
    ctx.document.getElementById('unsaved-save').click();
    await flush();
    assert.equal(ctx.calls.save.length, 2);
    assert.equal(stashes(ctx, 's1').size, 0);
    assert.equal(stashes(ctx, 's2').get('/work/a.txt')?.content, 'two');
    assert.match(ctx.document.getElementById('unsaved-edits-dialog').textContent, /changed on disk/);
    ctx.document.getElementById('unsaved-cancel').click();
    assert.equal(await pending, false);
  } finally { ctx.destroy(); }
});

test('a file the session opens over a dirty editor never asks, keeps the editor and lists the file', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    await dirtyTouched(ctx, '/work/a.txt', 'dirty');
    const tab = ctx.stateOf('s1').currentTab;
    ctx.mcpOpenFile('s1', { filePath: '/work/b.txt' });
    await flush();
    assert.equal(ctx.calls.confirm, 0);
    assert.equal(ctx.stateOf('s1').currentTab, tab);
    assert.equal(ctx.editors.at(-1).current, 'dirty');
    assert.deepEqual(openedRows(ctx).map(r => r.dataset.path), ['/work/b.txt']);
    assert.deepEqual(ctx.calls.resolve, []);
  } finally { ctx.destroy(); }
});

test('a file the session opens over a clean editor replaces it without asking', async () => {
  const ctx = setupDom();
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    ctx.mcpOpenFile('s1', { filePath: '/work/b.txt' });
    await flush();
    assert.equal(ctx.calls.confirm, 0);
    assert.equal(ctx.stateOf('s1').currentTab?.absolutePath, '/work/b.txt');
    assert.deepEqual({ ...ctx.calls.readOptions.at(-1) }, { editor: true });
  } finally { ctx.destroy(); }
});

test('a file the session opens that the panel refuses shows nothing of it', async () => {
  const ctx = setupDom({ readImpl: () => ({ ok: false, error: 'access to sensitive path denied' }) });
  try {
    ctx.window.switchPanel('s1');
    ctx.mcpOpenFile('s1', { filePath: '/home/u/.ssh/id_rsa', content: 'SECRET' });
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab?.type, 'touched');
    assert.equal(openedRows(ctx).length, 0);
    assert.doesNotMatch(ctx.document.body.innerHTML, /SECRET/);
    assert.match(ctx.document.querySelector('#touched-summary .changes-error').textContent, /Could not open the file: access to sensitive path denied/);
  } finally { ctx.destroy(); }
});

test('a file the session opens over a dirty editor never restores its stash, and only lists it', async () => {
  const ctx = setupDom({ touchedImpl: twoFiles });
  try {
    await openTab(ctx);
    await dirtyTouched(ctx, '/work/b.txt', 'unsaved B');
    ctx.document.getElementById('changes-toggle-btn').click();
    await flush();
    await openLink(ctx, '/work/a.txt');
    ctx.editors.at(-1).setText('unsaved A');
    const tab = ctx.stateOf('s1').currentTab;
    ctx.mcpOpenFile('s1', { filePath: '/work/b.txt' });
    await flush();
    assert.equal(ctx.calls.confirm, 0);
    assert.equal(ctx.stateOf('s1').currentTab, tab);
    assert.equal(ctx.editors.at(-1).current, 'unsaved A');
    assert.equal(stashes(ctx).get('/work/b.txt')?.content, 'unsaved B');
    assert.equal(ctx.stateOf('s1').touchedOpened[0], '/work/b.txt');
    assert.deepEqual(ctx.calls.readFile, ['/work/b.txt', '/work/a.txt']);
  } finally { ctx.destroy(); }
});

for (const [name, filePath] of [['a text file', '/work/a.txt'], ['a markdown file', '/work/README.md']]) {
  test(`a path:line link to a file with stashed edits restores them in the source at that line (${name})`, async () => {
    const ctx = markdownDom([filePath]);
    try {
      await openTab(ctx);
      await dirtyTouched(ctx, filePath, '# Unsaved\n');
      ctx.document.getElementById('changes-toggle-btn').click();
      await flush();
      await openLink(ctx, filePath, { line: 7 });
      const tab = ctx.stateOf('s1').currentTab;
      assert.equal(tab?.absolutePath, filePath);
      assert.equal(tab.restoredEdits, true);
      assert.equal(ctx.editors.at(-1).current, '# Unsaved\n');
      assert.deepEqual(ctx.calls.revealed, [7]);
      assert.equal(tab.formatted, false);
      assert.equal(markdownChrome(ctx).host.style.display, '');
    } finally { ctx.destroy(); }
  });
}
