'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const source = name => fs.readFileSync(path.join(PUBLIC, name), 'utf8');
const css = source('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, declarations]) => ({
  selector: selector.trim(), declarations,
}));

function rule(selector, property) {
  const found = rules.find(r => r.selector === selector && (!property || r.declarations.includes(property)));
  assert.ok(found, `missing ${selector}${property ? ' with ' + property : ''}`);
  return found.declarations;
}

function assertThemedButtons(root) {
  const buttons = [...root.querySelectorAll('button')];
  assert.ok(buttons.length > 0, 'the renderer created buttons');
  for (const button of buttons) {
    const backgrounds = rules.filter(r => /(?:^|;)\s*background(?:-color)?:/.test(r.declarations)
      && !r.selector.includes('::') && !r.selector.includes(':hover')
      && button.matches(r.selector));
    assert.ok(backgrounds.length, `${button.id || button.className || button.textContent} has a background rule`);
    assert.ok(button.matches(':where(button)'), 'the shared base also covers this button');
    for (const r of backgrounds) {
      assert.doesNotMatch(r.declarations, /background(?:-color)?:\s*(?:white|#fff(?:fff)?)\s*[;}]/i);
    }
  }
  return buttons;
}

test('unclassified buttons have token-based surfaces and accessible interaction states without size changes', () => {
  const base = rule(':where(button)');
  assert.match(base, /background:\s*var\(--control-surface\)/);
  assert.match(base, /border:\s*1px solid var\(--control-border\)/);
  assert.match(base, /color:\s*var\(--text-muted\)/);
  assert.doesNotMatch(base, /(?:^|;)\s*(?:padding|margin|width|height|font(?:-size)?|line-height):/);
  assert.match(rule(':where(button:enabled:hover)'), /background:\s*var\(--hairline\)/);
  assert.match(rule(':where(button:focus-visible)'), /outline:\s*2px solid var\(--accent\)/);
  assert.match(rule(':where(button:disabled)'), /opacity:\s*0\.4/);
  assert.match(rule(':where(button:disabled)'), /cursor:\s*default/);
  assert.match(rule('#terminal-refresh-btn'), /background:\s*none/);
  assert.match(rules.find(r => r.selector.split(',').some(s => s.trim() === '.icon-btn')).declarations,
    /background:\s*transparent/);
});

test('all scrollers share theme tokens on both scrollbar APIs, including horizontal bars and corners', () => {
  const standard = rule('*', 'scrollbar-width');
  assert.match(standard, /scrollbar-width:\s*thin/);
  assert.match(standard, /scrollbar-color:\s*var\(--hairline\) transparent/);
  assert.match(rule('::-webkit-scrollbar'), /width:\s*5px/);
  assert.match(rule('::-webkit-scrollbar'), /height:\s*5px/);
  assert.match(rule('::-webkit-scrollbar-track'), /background:\s*transparent/);
  assert.match(rule('::-webkit-scrollbar-thumb'), /background:\s*var\(--hairline\)/);
  assert.match(rule('::-webkit-scrollbar-thumb:hover'), /background:\s*var\(--control-border\)/);
  assert.match(rule('::-webkit-scrollbar-corner'), /background:\s*transparent/);
  for (const r of rules.filter(r => /scrollbar/.test(r.selector + r.declarations))) {
    assert.ok(r.selector === '*' || r.selector.startsWith('::-webkit-scrollbar')
      || r.selector.startsWith('.terminal-container .xterm-viewport'), `duplicate scrollbar rule: ${r.selector}`);
  }
  assert.doesNotMatch(source('codemirror-setup.js'), /scrollbar(?:Width|Color)/);
});

test('Touched sort has a themed native menu and hover, focus and disabled states', () => {
  const base = rule('#touched-sort');
  assert.match(base, /background:\s*var\(--surface-chrome\)/);
  assert.match(base, /border:\s*1px solid var\(--control-border\)/);
  assert.match(base, /color:\s*var\(--text-muted\)/);
  assert.match(base, /color-scheme:\s*dark/);
  assert.match(rule('#touched-sort:enabled:hover'), /border-color:\s*var\(--accent-border\)/);
  assert.match(rule('#touched-sort:focus-visible'), /outline:\s*2px solid var\(--accent\)/);
  assert.match(rule('#touched-sort:disabled'), /opacity:\s*0\.4/);
});

test('every declared index button and every optional viewer toolbar button has a background rule', () => {
  const dom = new JSDOM(source('index.html'), { runScripts: 'outside-only' });
  try {
    assert.equal(assertThemedButtons(dom.window.document).length, 23);
    vm.runInContext(source('viewer-toolbar.js'), dom.getInternalVMContext());
    const toolbar = dom.window.createViewerToolbar({
      copyPath: true, copyContent: true, preview: true, wrap: true, gotoLine: true,
      format: true, delete: true, save: true, close: true, diffToggle: true,
    });
    assert.equal(assertThemedButtons(toolbar.el).length, 10);
  } finally { dom.window.close(); }
});

function setupPanel() {
  const dom = new JSDOM('<!DOCTYPE html><div id="terminal-area"><div id="terminals"></div></div>'
    + '<div id="terminal-header"><div id="terminal-header-controls"><button id="terminal-stop-btn"></button></div></div>',
  { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  const evaluate = text => vm.runInContext(text, context);
  window.api = {
    onMcpOpenDiff() {}, onMcpOpenFile() {}, onMcpCloseAllDiffs() {}, onMcpCloseTab() {},
    sessionTouchedFiles: async () => ({
      ok: true, files: [{ path: '/work/a.txt', state: 'present', openable: true, tools: ['Write'], sources: ['session'] }],
      hasOlder: true, unresolved: [], coverage: { transcripts: 1 },
    }),
    readFileForPanel: async () => ({ ok: true, content: 'file body' }),
    gitChangesStatus: async () => ({
      ok: true, kind: 'local', branch: { head: 'main' },
      files: [{ path: 'a.txt', staged: true, state: 'M', added: 1, deleted: 1 }],
      totals: { files: 1, added: 1, deleted: 1 },
    }),
    gitChangesDiff: async () => ({ ok: true, content: '@@ -1 +1 @@\n-old\n+new\n' }),
    gitChangesFile: async () => ({ ok: true, original: 'old\n', current: 'new\n', version: 'v1' }),
    gitChangesWatch: async () => ({ ok: true }), gitChangesUnwatch: async () => ({ ok: true }),
    onGitChangesFileChanged() {},
  };
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true });
  for (const file of ['viewer-toolbar.js', 'viewer-panel.js', 'splitter.js', 'session-state.js',
    'session-activity-dom.js', 'session-activity.js', 'header-controls.js', 'file-panel.js', 'touched-files-view.js']) {
    evaluate(source(file));
  }
  evaluate('loadCodeMirrorBundle = () => Promise.resolve()');
  const editor = (parent, content) => {
    const el = window.document.createElement('div');
    parent.appendChild(el);
    return { dom: el, state: { doc: { toString: () => content, length: content.length } }, destroy() { el.remove(); } };
  };
  window.createEditableViewer = editor;
  window.createUnifiedMergeViewer = (parent, _original, current) => editor(parent, current);
  window.createMergeViewer = (parent, _original, current) => {
    const view = editor(parent, current);
    view.b = { state: view.state };
    return view;
  };
  window.initFilePanel();
  return { dom, window, evaluate };
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('file panel, Touched and Changes controls are themed through their real creation paths', async () => {
  const ctx = setupPanel();
  const { window, evaluate } = ctx;
  const document = window.document;
  try {
    window.switchPanel('s1');
    document.getElementById('touched-toggle-btn').click();
    await flush();
    const more = document.getElementById('touched-more-btn');
    assert.ok(more, 'older history creates the Show 10 more days button');
    assert.ok(more.classList.contains('viewer-toolbar-btn'));
    assertThemedButtons(document.getElementById('file-panel'));
    document.querySelector('.touched-openable').click();
    await flush();
    const back = document.getElementById('file-panel-back-btn');
    assert.notEqual(back.style.display, 'none');
    assertThemedButtons(document.getElementById('file-panel'));
    back.click();
    await window.openChangesTab('s1');
    await window.openChangesDiff('s1', { path: 'a.txt', staged: true });
    await flush();
    for (const id of ['changes-refresh-btn', 'changes-diff-mode-btn', 'changes-diff-reload-btn',
      'changes-diff-save-btn', 'changes-diff-close-btn']) {
      assert.ok(document.getElementById(id)?.classList.contains('icon-btn'), id);
    }
    assertThemedButtons(document.getElementById('file-panel'));
    evaluate('renderDiffContent("s1", { type: "diff", oldContent: "old", newContent: "new" })');
    assert.ok(document.querySelector('.file-panel-accept-btn'));
    assert.ok(document.querySelector('.file-panel-reject-btn'));
    assertThemedButtons(document.getElementById('file-panel'));
    await flush();
  } finally { ctx.dom.window.close(); }
});
