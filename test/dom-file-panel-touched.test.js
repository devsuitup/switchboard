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

function setupDom({ touchedImpl, readImpl } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { touched: [], readFile: [], viewerOpen: [] };

  window.api = {
    onMcpOpenDiff: () => {},
    onMcpOpenFile: () => {},
    onMcpCloseAllDiffs: () => {},
    onMcpCloseTab: () => {},
    mcpDiffResponse: () => {},
    sessionTouchedFiles: (sessionId) => {
      calls.touched.push(sessionId);
      return Promise.resolve((touchedImpl || (() => result()))(sessionId));
    },
    readFileForPanel: (filePath) => {
      calls.readFile.push(filePath);
      return Promise.resolve((readImpl || (() => ({ ok: true, content: 'file body' })))(filePath));
    },
  };
  window.confirm = () => true;
  window.loadCodeMirrorBundle = () => Promise.resolve();
  Object.defineProperty(window, 'ViewerPanel', {
    value: function ViewerPanelStub() {
      return {
        open(label, filePath, content) { calls.viewerOpen.push({ label, filePath, content }); },
        destroy() {},
        hasUnsavedEdits: () => false,
        snapshot: () => null,
      };
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  for (const file of ['splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'header-controls.js', 'file-panel.js', 'touched-files-view.js']) {
    evalInWindow(dom, path.join(PUBLIC_DIR, file));
  }
  window.initFilePanel();

  const ctx = dom.getInternalVMContext();
  return {
    window,
    document: window.document,
    calls,
    stateOf: (sessionId) => vm.runInContext('filePanelState', ctx).get(sessionId),
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
    assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
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

test('a present file opens through readFileForPanel and the file viewer', async () => {
  const ctx = setupDom({ readImpl: () => ({ ok: true, content: 'hello' }) });
  try {
    await openTab(ctx);
    clickRow(ctx, '/work/a.txt');
    await flush();
    assert.deepEqual(ctx.calls.readFile, ['/work/a.txt']);
    assert.equal(ctx.stateOf('s1').currentTab.type, 'file');
    assert.deepEqual(ctx.calls.viewerOpen.map((o) => [o.filePath, o.content]), [['/work/a.txt', 'hello']]);
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
    assert.match(rows(ctx)[0].title, /no longer exists/i);
    for (const r of rows(ctx)) {
      assert.equal(r.classList.contains('touched-openable'), false);
      r.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    }
    await flush();
    assert.deepEqual(ctx.calls.readFile, []);
    assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
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
    ctx.window.openFileTab('s1', { filePath: '/work/other.txt', content: 'x' });
    release();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.filePath, '/work/other.txt');
    assert.deepEqual(ctx.calls.viewerOpen.map((o) => o.filePath), ['/work/other.txt']);
  } finally { ctx.destroy(); }
});

test('opening the tab hides whatever the panel showed before', async () => {
  const ctx = setupDom();
  try {
    ctx.window.switchPanel('s1');
    for (const id of ['file-panel-viewer', 'file-panel-diff', 'file-panel-changes']) {
      ctx.document.getElementById(id).style.display = 'flex';
    }
    ctx.document.getElementById('touched-toggle-btn').click();
    await flush();
    for (const id of ['file-panel-viewer', 'file-panel-diff', 'file-panel-changes']) {
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
    assert.equal(ctx.stateOf('s1').currentTab.type, 'touched');
    assert.match(ctx.document.getElementById('touched-summary').textContent, /access to sensitive path denied/);
    assert.deepEqual(ctx.calls.viewerOpen, []);
  } finally { ctx.destroy(); }
});

test('an omitted count, malformed lines and a truncated read are each reported', async () => {
  const ctx = setupDom({
    touchedImpl: () => result({
      omitted: 7,
      coverage: { transcripts: 3, subagents: 2, malformedLines: 4, truncated: true },
    }),
  });
  try {
    await openTab(ctx);
    const text = ctx.document.getElementById('touched-summary').textContent;
    assert.match(text, /7 more/);
    assert.match(text, /2 subagents/);
    assert.match(text, /4 unreadable lines/);
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
    ctx.window.openFileTab('s1', { filePath: '/work/other.txt', content: 'x' });
    release();
    await flush();
    assert.equal(ctx.stateOf('s1').currentTab.type, 'file');
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
