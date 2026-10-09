'use strict';

// A path:line link carries its line into the Touched editor, whether the file
// is unchanged (plain editor) or changed against HEAD (diff editor).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const INDEX_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="terminal-area"><div id="terminals"></div></div>
    <div id="terminal-header" style="display:none;">
      <div id="terminal-header-session"><button id="terminal-stop-btn"></button></div>
    </div>
  </body>
</html>`;

function setup({ pair } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { revealed: [], modes: [] };

  window.api = {
    onMcpOpenDiff: () => {}, onMcpOpenFile: () => {}, onMcpCloseAllDiffs: () => {}, onMcpCloseTab: () => {},
    mcpDiffResponse: () => {},
    resolveTerminalPaths: (_s, texts) => Promise.resolve(texts.map(p => ({ ok: true, path: p }))),
    sessionTouchedFiles: () => Promise.resolve({ ok: true, files: [], unresolved: [], omitted: 0, coverage: {} }),
    readFileForPanel: () => Promise.resolve(pair || { ok: true, git: false, original: 'one\ntwo\nthree\n', current: 'one\ntwo\nthree\n' }),
    watchFile: () => Promise.resolve({ ok: true }),
    unwatchFile: () => Promise.resolve({ ok: true }),
    saveFileForPanel: () => Promise.resolve({ ok: true }),
  };
  window.confirm = () => true;
  window.loadCodeMirrorBundle = () => Promise.resolve();
  window.cmRevealLine = (view, line) => calls.revealed.push({ view, line });

  const makeView = (parent, mode) => {
    calls.modes.push(mode);
    const el = window.document.createElement('div');
    parent.appendChild(el);
    return { dom: el, state: { doc: { toString: () => 'b\n' } }, destroy() { if (el.parentNode) el.parentNode.removeChild(el); } };
  };
  window.createMergeViewer = (parent) => makeView(parent, 'side-by-side');
  window.createUnifiedMergeViewer = (parent) => makeView(parent, 'inline');
  window.createEditableViewer = (parent) => makeView(parent, 'plain');
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  for (const f of ['splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'shortcuts.js', 'header-controls.js', 'tool-bar.js', 'viewer-toolbar.js', 'file-panel.js', 'touched-files-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: f });
  }
  window.openSessions = new Map();
  window.gridViewActive = false;
  window.gridCards = new Map();
  window.isMac = false;
  window.appShortcuts = {};
  window.initFilePanel();
  const switchPanel = window.switchPanel;
  window.switchPanel = id => {
    if (id) window.openSessions.set(id, { terminal: { focus() {} } });
    switchPanel(id);
  };
  const ctx = dom.getInternalVMContext();
  return { window, document: window.document, calls, stateOf: id => vm.runInContext('filePanelState', ctx).get(id), destroy: () => window.close() };
}

function flush() {
  let p = Promise.resolve();
  for (let i = 0; i < 16; i++) p = p.then(() => Promise.resolve());
  return p;
}

test('an unchanged file opens in the Touched editor and is scrolled to the line', async () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/other.js', { line: 42 });
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.returnList?.type, 'touched');
    assert.deepStrictEqual(ctx.calls.modes, ['plain']);
    assert.deepStrictEqual(ctx.calls.revealed.map(r => r.line), [42]);
  } finally { ctx.destroy(); }
});

test('no line means no jump', async () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/other.js');
    await flush();
    assert.deepStrictEqual(ctx.calls.revealed, []);
  } finally { ctx.destroy(); }
});

test('a changed file opens its diff in the Touched editor and is scrolled to the line', async () => {
  const ctx = setup({ pair: { ok: true, git: true, original: 'a\n', current: 'b\n', version: 'v1' } });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/a.js', { line: 7 });
    await flush();
    assert.notDeepStrictEqual(ctx.calls.modes, ['plain']);
    assert.strictEqual(ctx.calls.revealed.length, 1);
    assert.strictEqual(ctx.calls.revealed[0].line, 7);
  } finally { ctx.destroy(); }
});

test('a line of zero or below is ignored, not passed on', async () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/other.js', { line: 0 });
    await flush();
    assert.deepStrictEqual(ctx.calls.revealed, []);
    assert.equal(ctx.stateOf('s1').currentTab.pendingLine, null);
  } finally { ctx.destroy(); }
});
