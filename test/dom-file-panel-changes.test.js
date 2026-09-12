'use strict';

// Renderer tests for the Changes mode in public/file-panel.js (issue #251).
// Strategy mirrors test/dom-work-files-view.test.js: evaluate the real
// renderer files in a jsdom window, stub window.api and ViewerPanel, drive
// the public tab functions, and assert on the resulting DOM plus call counts.
//
// session-state.js + session-activity-dom.js + session-activity.js load
// alongside file-panel.js (same order as index.html) because the no-polling
// refresh hooks into session-activity.js's onSessionIdle — the very thing the
// zero-invocation test below is proving.

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

function makeStatusResult(overrides = {}) {
  return {
    ok: true,
    branch: { head: 'main', upstream: 'origin/main', ahead: 1, behind: 0 },
    files: [
      { path: 'src/a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M', added: 3, deleted: 1 },
      { path: 'new.txt', origPath: null, staged: false, unstaged: false, untracked: true, renamed: false, state: '?', added: null, deleted: null },
    ],
    totals: { files: 2, added: 3, deleted: 1 },
    ...overrides,
  };
}

function setupFilePanelDom({ statusImpl, diffImpl } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  const calls = { status: [], diff: [] };

  window.api = {
    onMcpOpenDiff: () => {},
    onMcpOpenFile: () => {},
    onMcpCloseAllDiffs: () => {},
    onMcpCloseTab: () => {},
    gitChangesStatus: (sessionId) => {
      calls.status.push(sessionId);
      return Promise.resolve((statusImpl || (() => makeStatusResult()))(sessionId));
    },
    gitChangesDiff: (sessionId, filePath, staged) => {
      calls.diff.push({ sessionId, filePath, staged });
      return Promise.resolve((diffImpl || (() => ({ ok: true, content: '@@ -1 +1 @@\n-old\n+new\n context\n', truncated: false })))(sessionId, filePath, staged));
    },
  };

  Object.defineProperty(window, 'ViewerPanel', {
    value: function ViewerPanelStub() { return { open() {}, destroy() {} }; },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  evalInWindow(dom, path.join(PUBLIC_DIR, 'session-state.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'session-activity-dom.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'session-activity.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'file-panel.js'));

  window.initFilePanel();

  const ctx = dom.getInternalVMContext();
  const read = (expr) => vm.runInContext(expr, ctx);

  return {
    window,
    document: window.document,
    calls,
    setActivity: read('setActivity'),
    destroy: () => window.close(),
  };
}

function flush() {
  // Two microtask turns: one for the IPC promise, one for whatever chains off it.
  return Promise.resolve().then(() => Promise.resolve());
}

// --- Rendering ---------------------------------------------------------

test('openChangesTab loads status and renders the summary, branch info, and one row per file', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const summary = ctx.document.getElementById('changes-summary');
    assert.match(summary.textContent, /2 files changed \+3/);
    assert.match(summary.textContent, /−1/, 'unicode minus for deleted count');

    const branchInfo = ctx.document.getElementById('changes-branch-info');
    assert.match(branchInfo.textContent, /main/);
    assert.match(branchInfo.textContent, /↑1/, 'ahead-by-one arrow');

    const rows = ctx.document.querySelectorAll('.changes-file-row');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.path, 'src/a.js');
    assert.equal(rows[1].dataset.path, 'new.txt');
    assert.equal(ctx.calls.status.length, 1);
    assert.deepEqual(ctx.calls.status, ['s1']);
  } finally { ctx.destroy(); }
});

test('an error from gitChangesStatus renders as an error message, not a crash', async () => {
  const ctx = setupFilePanelDom({ statusImpl: () => ({ ok: false, error: 'not a git repository' }) });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const err = ctx.document.querySelector('.changes-error');
    assert.ok(err, 'an error element must be rendered');
    assert.match(err.textContent, /not a git repository/);
  } finally { ctx.destroy(); }
});

test('clicking a file row opens a read-only diff colored by line prefix', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const row = ctx.document.querySelector('.changes-file-row[data-path="src/a.js"]');
    row.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    assert.equal(ctx.calls.diff.length, 1);
    assert.deepEqual(ctx.calls.diff[0], { sessionId: 's1', filePath: 'src/a.js', staged: true });

    const addLine = ctx.document.querySelector('.changes-diff-add');
    const delLine = ctx.document.querySelector('.changes-diff-del');
    const hunkLine = ctx.document.querySelector('.changes-diff-hunk');
    assert.ok(addLine && addLine.textContent === '+new');
    assert.ok(delLine && delLine.textContent === '-old');
    assert.ok(hunkLine && hunkLine.textContent.startsWith('@@'));

    // Back returns to the file list without another status call.
    const backBtn = Array.from(ctx.document.querySelectorAll('#changes-diff-view button')).find(b => b.textContent === 'Back');
    backBtn.click();
    assert.equal(ctx.document.getElementById('changes-list').style.display, 'block');
    assert.equal(ctx.calls.status.length, 1, 'returning to the list must not re-fetch status');
  } finally { ctx.destroy(); }
});

test('clicking an untracked file shows a note instead of calling gitChangesDiff', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const row = ctx.document.querySelector('.changes-file-row[data-path="new.txt"]');
    row.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    assert.equal(ctx.calls.diff.length, 0, 'an untracked file has no git diff to fetch');
    const body = ctx.document.querySelector('.changes-diff-body');
    assert.match(body.textContent, /Untracked file/);
  } finally { ctx.destroy(); }
});

test('the Refresh button re-invokes gitChangesStatus', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();
    assert.equal(ctx.calls.status.length, 1);

    const refreshBtn = Array.from(ctx.document.querySelectorAll('#file-panel-changes button')).find(b => b.textContent === 'Refresh');
    refreshBtn.click();
    await flush();

    assert.equal(ctx.calls.status.length, 2);
  } finally { ctx.destroy(); }
});

// --- No-polling refresh trigger + zero-invocation proof -----------------

test('setActivity(id, false) refreshes an open Changes tab for that session only', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();
    assert.equal(ctx.calls.status.length, 1, 'the initial open');

    // A different, unrelated session going idle must not trigger a fetch for s1's tab.
    ctx.setActivity('s2', true);
    ctx.setActivity('s2', false);
    await flush();
    assert.equal(ctx.calls.status.length, 1, 'an unrelated session\'s idle transition must not refresh s1');

    // s1 itself finishing a turn (busy -> idle) must refresh its own open tab.
    ctx.setActivity('s1', true);
    await flush();
    assert.equal(ctx.calls.status.length, 1, 'going busy must never trigger a git invocation');

    ctx.setActivity('s1', false);
    await flush();
    assert.equal(ctx.calls.status.length, 2, 'going idle must refresh the open Changes tab exactly once');
  } finally { ctx.destroy(); }
});

test('zero git invocations while a session stays busy, or idle with no new event', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();
    const baseline = ctx.calls.status.length;
    assert.equal(baseline, 1);

    ctx.setActivity('s1', true);
    await flush();
    ctx.setActivity('s1', true); // duplicate busy signal — no transition
    await flush();
    assert.equal(ctx.calls.status.length, baseline, 'no invocation while busy');

    ctx.setActivity('s1', false);
    await flush();
    const afterFirstIdle = ctx.calls.status.length;
    assert.equal(afterFirstIdle, baseline + 1);

    // Idle again with no new busy->idle transition in between: setActivity's
    // own response-ready lock swallows the duplicate, so no second refresh.
    ctx.setActivity('s1', false);
    await flush();
    assert.equal(ctx.calls.status.length, afterFirstIdle, 'a duplicate idle signal with no new event must not re-invoke git');
  } finally { ctx.destroy(); }
});

test('a session with no Changes tab open never calls gitChangesStatus, however often it goes idle', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.setActivity('s9', true);
    ctx.setActivity('s9', false);
    ctx.setActivity('s9', true);
    ctx.setActivity('s9', false);
    await flush();
    assert.equal(ctx.calls.status.length, 0);
  } finally { ctx.destroy(); }
});

// --- Toggle button -------------------------------------------------------

test('the Changes header button opens and closes the tab for the active session', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    const btn = ctx.document.getElementById('changes-toggle-btn');
    assert.ok(btn, 'the Changes toggle button must be created in the terminal header');

    btn.click();
    await flush();
    assert.equal(ctx.calls.status.length, 1);
    assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), true);

    btn.click();
    assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), false);
  } finally { ctx.destroy(); }
});
