'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { registerPanelTerminals } = require('./terminal-manager-harness');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');

const INDEX_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="terminal-area">
      <div id="terminals"></div>
    </div>
    <div id="terminal-header" style="display:none;">
      <div id="terminal-header-session">
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
  const observed = new Map();
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); }
    observe(element) { observed.set(element, this.callback); this.targets.add(element); }
    disconnect() { for (const element of this.targets) observed.delete(element); }
  };
  const calls = { touched: [], readFile: [], readOptions: [], save: [], gitFile: [], status: [], resolve: [], diffResponse: [], revealed: [], confirm: 0, openPath: [], showItem: [] };
  let mcpOpenFile = null;

  window.api = {
    openPath: (...args) => { calls.openPath.push(args); return Promise.resolve(''); },
    showItemInFolder: (...args) => { calls.showItem.push(args); return Promise.resolve({ ok: true }); },
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
      return Promise.resolve((readImpl || (() => ({ ok: true, original: 'before\n', current: 'file body', version: 'v1', git: true })))(filePath, options));
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
  window.appConfirm = async ({ message }) => { calls.confirm++; return (confirmImpl || (() => true))(message); };
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
  for (const file of ['modal-stack.js', 'viewer-toolbar.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'shortcuts.js', 'header-controls.js', 'tool-bar.js', 'file-panel.js', 'touched-files-view.js']) {
    evalInWindow(dom, path.join(PUBLIC_DIR, file));
  }
  window.openSessions = new Map();
  window.gridViewActive = false;
  window.gridCards = new Map();
  window.isMac = false;
  window.appShortcuts = {};
  window.initFilePanel();
  registerPanelTerminals(dom, ['owner', 'r1', 's1', 's2']);

  const ctx = dom.getInternalVMContext();
  return {
    window,
    document: window.document,
    calls,
    editors,
    watchCalls,
    resize: element => {
      if (element) observed.get(element)?.();
      else for (const callback of new Set(observed.values())) callback();
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

async function openLink(ctx, filePath, opts, sessionId = 's1') {
  await ctx.window.openFileInPanel(sessionId, filePath, opts);
  await flush();
}

function openedRows(ctx) {
  return rows(ctx).filter(r => r.classList.contains('touched-opened'));
}


module.exports = { setupDom, flush, openTab, rows, clickRow, openLink, openedRows, row, result };
