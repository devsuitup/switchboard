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
    kind: 'local',
    branch: { head: 'main', upstream: 'origin/main', ahead: 1, behind: 0 },
    files: [
      { path: 'src/a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M', added: 3, deleted: 1 },
      { path: 'new.txt', origPath: null, staged: false, unstaged: false, untracked: true, renamed: false, state: '?', added: null, deleted: null },
    ],
    totals: { files: 2, added: 3, deleted: 1 },
    ...overrides,
  };
}

const DEFAULT_PAIR = { ok: true, original: 'old\n', current: 'new\n', version: 'v1', binary: false, truncated: false };

// A stand-in for a CodeMirror view: it owns a DOM node, reports a document
// the test can rewrite (typing), and records its own destruction — enough for
// the reuse, dirty-buffer and save paths, none of the bundle.
function makeEditorStub(window, mode, doc, created) {
  const dom = window.document.createElement('div');
  dom.className = 'fake-editor fake-editor-' + mode;
  const box = { text: doc, destroyed: false, mode };
  const docSide = { state: { doc: { toString: () => box.text } } };
  const view = {
    dom,
    box,
    destroy() {
      box.destroyed = true;
      if (dom.parentNode) dom.parentNode.removeChild(dom);
    },
  };
  if (mode === 'side-by-side') view.b = docSide;
  else view.state = docSide.state;
  created.push(view);
  return view;
}

function setupFilePanelDom({ statusImpl, diffImpl, fileImpl, saveImpl, confirmImpl, locateImpl } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  const calls = { status: [], diff: [], file: [], save: [], watch: [], unwatch: [], confirm: [], locate: [], readFile: [] };
  const editors = [];
  const fileChangedListeners = [];

  window.api = {
    onMcpOpenDiff: () => {},
    onMcpOpenFile: () => {},
    onMcpCloseAllDiffs: () => {},
    onMcpCloseTab: () => {},
    mcpDiffResponse: () => {},
    gitChangesStatus: (sessionId) => {
      calls.status.push(sessionId);
      return Promise.resolve((statusImpl || (() => makeStatusResult()))(sessionId));
    },
    gitChangesDiff: (sessionId, filePath, staged, untracked) => {
      calls.diff.push({ sessionId, filePath, staged, untracked });
      return Promise.resolve((diffImpl || (() => ({ ok: true, content: '@@ -1 +1 @@\n-old\n+new\n context\n', truncated: false })))(sessionId, filePath, staged, untracked));
    },
    gitChangesFile: (sessionId, filePath, opts) => {
      calls.file.push({ sessionId, filePath, staged: !!(opts && opts.staged) });
      return Promise.resolve((fileImpl || (() => DEFAULT_PAIR))(sessionId, filePath, opts));
    },
    gitChangesSave: (sessionId, filePath, content, version) => {
      calls.save.push({ sessionId, filePath, content, version });
      return Promise.resolve((saveImpl || (() => ({ ok: true, version: 'v2' })))(sessionId, filePath, content, version));
    },
    gitChangesWatch: (sessionId, filePath) => {
      calls.watch.push({ sessionId, filePath });
      return Promise.resolve({ ok: true });
    },
    gitChangesUnwatch: (sessionId, filePath) => {
      calls.unwatch.push({ sessionId, filePath });
      return Promise.resolve({ ok: true });
    },
    onGitChangesFileChanged: (cb) => { fileChangedListeners.push(cb); },
    gitChangesLocate: (sessionId, filePath) => {
      calls.locate.push({ sessionId, filePath });
      return Promise.resolve((locateImpl || (() => ({ ok: false, reason: 'outside' })))(sessionId, filePath));
    },
    readFileForPanel: (filePath) => {
      calls.readFile.push(filePath);
      return Promise.resolve({ ok: true, content: 'plain content' });
    },
  };

  // jsdom's own window.confirm throws "not implemented"; the panel asks before
  // discarding unsaved edits, so the suite answers for the user.
  window.confirm = (message) => {
    calls.confirm.push(message);
    return confirmImpl ? confirmImpl(message) : true;
  };

  // file-panel.js defers every editor to the lazy bundle loader; the suite
  // stands in for both the loader and the factories it would provide.
  window.loadCodeMirrorBundle = () => Promise.resolve();
  window.createMergeViewer = (parent, original, modified, filename) => {
    const view = makeEditorStub(window, 'side-by-side', modified, editors);
    view.opened = { original, modified, filename };
    parent.appendChild(view.dom);
    return view;
  };
  window.createUnifiedMergeViewer = (parent, original, modified, filename, opts) => {
    const view = makeEditorStub(window, 'inline', modified, editors);
    view.opened = { original, modified, filename };
    view.opts = opts;
    parent.appendChild(view.dom);
    return view;
  };
  window.createEditableViewer = (parent, content, filename) => {
    const view = makeEditorStub(window, 'plain', content, editors);
    view.opened = { original: null, modified: content, filename };
    parent.appendChild(view.dom);
    return view;
  };

  Object.defineProperty(window, 'ViewerPanel', {
    value: function ViewerPanelStub() { return { open() {}, destroy() {} }; },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  evalInWindow(dom, path.join(PUBLIC_DIR, 'splitter.js'));
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
    editors,
    fireFileChanged: (sessionId, filePath) => {
      for (const cb of fileChangedListeners) cb(sessionId, filePath);
    },
    setActivity: read('setActivity'),
    clampListHeight: read('clampChangesListHeight'),
    stashOf: (sessionId) => {
      const state = read('filePanelState').get(sessionId);
      return state ? state.changesStash : undefined;
    },
    destroy: () => window.close(),
  };
}

function flush() {
  // The chains run several IPC round trips deep (save -> status -> content pair
  // -> bundle loader), so drain a generous number of microtask turns.
  let p = Promise.resolve();
  for (let i = 0; i < 12; i++) p = p.then(() => Promise.resolve());
  return p;
}

function clickRow(ctx, filePath) {
  ctx.document.querySelector(`.changes-file-row[data-path="${filePath}"]`)
    .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
}

function closeEditorBtn(ctx) {
  return ctx.document.getElementById('changes-diff-close-btn');
}

async function openFile(ctx, sessionId, filePath) {
  ctx.window.switchPanel(sessionId);
  await ctx.window.openChangesTab(sessionId);
  await flush();
  clickRow(ctx, filePath);
  await flush();
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

const REMOTE_STATUS = () => makeStatusResult({ kind: 'remote' });

test('clicking a file row on a remote session opens a read-only diff colored by line prefix', async () => {
  const ctx = setupFilePanelDom({ statusImpl: REMOTE_STATUS });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const row = ctx.document.querySelector('.changes-file-row[data-path="src/a.js"]');
    row.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    assert.equal(ctx.calls.file.length, 0, 'a remote session never asks for an editable content pair');
    assert.equal(ctx.calls.diff.length, 1);
    assert.deepEqual(ctx.calls.diff[0], { sessionId: 's1', filePath: 'src/a.js', staged: true, untracked: false });

    const addLine = ctx.document.querySelector('.changes-diff-add');
    const delLine = ctx.document.querySelector('.changes-diff-del');
    const hunkLine = ctx.document.querySelector('.changes-diff-hunk');
    assert.ok(addLine && addLine.textContent === '+new');
    assert.ok(delLine && delLine.textContent === '-old');
    assert.ok(hunkLine && hunkLine.textContent.startsWith('@@'));

    // Back returns to the file list without another status call.
    closeEditorBtn(ctx).click();
    assert.equal(ctx.document.getElementById('changes-list').style.display, 'block');
    assert.equal(ctx.calls.status.length, 1, 'returning to the list must not re-fetch status');
  } finally { ctx.destroy(); }
});

const UNTRACKED_DIFF_RESULT = {
  ok: true,
  content: 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n',
  truncated: false,
  added: 2,
  deleted: 0,
};

test('clicking an untracked file fetches its diff like any other row, flagged untracked (mutation target: the old short-circuit)', async () => {
  const ctx = setupFilePanelDom({ statusImpl: REMOTE_STATUS, diffImpl: () => UNTRACKED_DIFF_RESULT });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const row = ctx.document.querySelector('.changes-file-row[data-path="new.txt"]');
    row.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    assert.equal(ctx.calls.diff.length, 1, 'an untracked file is fetched, not short-circuited');
    assert.deepEqual(ctx.calls.diff[0], { sessionId: 's1', filePath: 'new.txt', staged: false, untracked: true });

    const body = ctx.document.querySelector('.changes-diff-body');
    assert.ok(!/nothing to diff/.test(body.textContent), 'the old placeholder note is gone');
    const addLines = Array.from(ctx.document.querySelectorAll('.changes-diff-add')).map((el) => el.textContent);
    assert.deepEqual(addLines, ['+first', '+second']);
    const headerLines = Array.from(ctx.document.querySelectorAll('.changes-diff-file-header')).map((el) => el.textContent);
    assert.deepEqual(headerLines, ['--- /dev/null', '+++ b/new.txt'], '--no-index header paths are classified as headers, not as a deletion and an addition');
  } finally { ctx.destroy(); }
});

test('an untracked file\'s counts and the header totals pick up the additions its diff reported', async () => {
  const ctx = setupFilePanelDom({ statusImpl: REMOTE_STATUS, diffImpl: () => UNTRACKED_DIFF_RESULT });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const before = ctx.document.querySelector('.changes-file-row[data-path="new.txt"] .changes-file-counts');
    assert.equal(before, null, 'status alone cannot know an untracked file\'s line count');

    ctx.document.querySelector('.changes-file-row[data-path="new.txt"]')
      .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    closeEditorBtn(ctx).click();

    const counts = ctx.document.querySelector('.changes-file-row[data-path="new.txt"] .changes-file-counts');
    assert.ok(counts, 'the row now renders counts like any other row');
    assert.equal(counts.textContent, '+2−0');

    const summary = ctx.document.getElementById('changes-summary');
    assert.match(summary.textContent, /2 files changed \+5 −1/, 'the untracked additions (2) join the tracked ones (3) in the header total');
    assert.equal(ctx.calls.status.length, 1, 'no extra status fetch — the counts came with the diff');
  } finally { ctx.destroy(); }
});

test('an untracked binary file keeps null counts — the row stays countless and the totals do not move', async () => {
  const binary = { ok: true, content: 'diff --git a/new.txt b/new.txt\nBinary files /dev/null and b/new.txt differ\n', truncated: false, added: null, deleted: null };
  const ctx = setupFilePanelDom({
    fileImpl: () => ({ ok: false, error: 'binary file', reason: 'binary' }),
    diffImpl: () => binary,
  });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    ctx.document.querySelector('.changes-file-row[data-path="new.txt"]')
      .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    const body = ctx.document.querySelector('.changes-diff-body');
    assert.match(body.textContent, /Binary files .* differ/);

    closeEditorBtn(ctx).click();

    assert.equal(ctx.document.querySelector('.changes-file-row[data-path="new.txt"] .changes-file-counts'), null);
    assert.match(ctx.document.getElementById('changes-summary').textContent, /\+3 −1/, 'unknown counts must not be folded in as zero');
  } finally { ctx.destroy(); }
});

test('a count computed against one status result is never applied to a later one (mutation target: dropping the identity check)', async () => {
  // v2 is what git says after the user staged and trimmed new.txt while the
  // untracked diff of v1 was still in flight: the file is tracked now, with
  // authoritative numstat counts that must not be overwritten.
  const v2 = {
    ok: true,
    branch: { head: 'main', upstream: 'origin/main', ahead: 1, behind: 0 },
    files: [
      { path: 'src/a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M', added: 3, deleted: 1 },
      { path: 'new.txt', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'A', added: 2, deleted: 7 },
    ],
    totals: { files: 2, added: 5, deleted: 8 },
  };
  let statusCall = 0;
  let releaseDiff;
  const ctx = setupFilePanelDom({
    statusImpl: () => (statusCall++ === 0 ? makeStatusResult({ kind: 'remote' }) : { ...v2, kind: 'remote' }),
    diffImpl: () => new Promise((resolve) => { releaseDiff = () => resolve(UNTRACKED_DIFF_RESULT); }),
  });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    ctx.document.querySelector('.changes-file-row[data-path="new.txt"]')
      .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    // A busy→idle edge lands while the diff is still in flight.
    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();
    assert.equal(ctx.calls.status.length, 2, 'the refresh happened');

    releaseDiff();
    await flush();

    closeEditorBtn(ctx).click();

    const counts = ctx.document.querySelector('.changes-file-row[data-path="new.txt"] .changes-file-counts');
    assert.equal(counts.textContent, '+2−7', 'git\'s own counts must survive the stale diff');
    assert.match(ctx.document.getElementById('changes-summary').textContent, /2 files changed \+5 −8/);
  } finally { ctx.destroy(); }
});

test('an overrun -uall listing degrades instead of blanking the panel: tracked rows render, with a note', async () => {
  const collapsed = {
    ok: true,
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0 },
    files: [
      { path: 'src/a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M', added: 3, deleted: 1 },
      { path: 'vendor/', origPath: null, staged: false, unstaged: false, untracked: true, renamed: false, state: '?', added: null, deleted: null },
    ],
    totals: { files: 2, added: 3, deleted: 1 },
    untrackedCollapsed: true,
  };
  const ctx = setupFilePanelDom({ statusImpl: () => collapsed });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    assert.equal(ctx.document.querySelectorAll('.changes-file-row').length, 2, 'tracked changes still render');
    const note = ctx.document.querySelector('.changes-degraded-note');
    assert.ok(note, 'the panel says why the untracked listing is coarse');
    assert.match(note.textContent, /collapsed/);
    assert.equal(ctx.document.querySelector('.changes-error'), null, 'this is a degraded listing, not an error');
  } finally { ctx.destroy(); }
});

test('the row list is capped, with a note for the remainder (mutation target: rendering one node per file unbounded)', async () => {
  const many = {
    ok: true,
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0 },
    files: Array.from({ length: 1200 }, (_, i) => ({
      path: `f${i}.txt`, origPath: null, staged: false, unstaged: false, untracked: true, renamed: false, state: '?', added: null, deleted: null,
    })),
    totals: { files: 1200, added: 0, deleted: 0 },
  };
  const ctx = setupFilePanelDom({ statusImpl: () => many });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const rows = ctx.document.querySelectorAll('.changes-file-row');
    assert.ok(rows.length < 1200, 'the list must not build one node per file without a bound');
    assert.equal(rows.length, 500);
    const more = ctx.document.querySelector('.changes-more-note');
    assert.ok(more, 'the user must be told rows are missing');
    assert.equal(more.textContent, '+700 more files not shown');
    assert.match(ctx.document.getElementById('changes-summary').textContent, /1200 files changed/, 'the header still counts every file');
  } finally { ctx.destroy(); }
});

test('a failed untracked diff surfaces the error and leaves the counts alone', async () => {
  const ctx = setupFilePanelDom({
    fileImpl: () => ({ ok: false, error: 'fatal: bad thing', reason: 'repo' }),
    diffImpl: () => ({ ok: false, error: 'fatal: bad thing' }),
  });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    ctx.document.querySelector('.changes-file-row[data-path="new.txt"]')
      .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    const body = ctx.document.querySelector('.changes-diff-body');
    assert.match(body.textContent, /fatal: bad thing/);

    closeEditorBtn(ctx).click();
    assert.equal(ctx.document.querySelector('.changes-file-row[data-path="new.txt"] .changes-file-counts'), null);
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

test('a count computed from the content pair is never applied to a later status either (mutation target: dropping the identity check on the editable path)', async () => {
  const v2 = {
    ok: true,
    kind: 'local',
    branch: { head: 'main', upstream: 'origin/main', ahead: 1, behind: 0 },
    files: [
      { path: 'src/a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M', added: 3, deleted: 1 },
      { path: 'new.txt', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'A', added: 2, deleted: 7 },
    ],
    totals: { files: 2, added: 5, deleted: 8 },
  };
  let statusCall = 0;
  let releasePair;
  const ctx = setupFilePanelDom({
    statusImpl: () => (statusCall++ === 0 ? makeStatusResult() : v2),
    fileImpl: () => new Promise((resolve) => {
      releasePair = () => resolve({ ok: true, original: '', current: 'first\nsecond\n', version: 'v1' });
    }),
  });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    clickRow(ctx, 'new.txt');
    await flush();

    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();
    assert.equal(ctx.calls.status.length, 2, 'the refresh happened while the pair was in flight');

    releasePair();
    await flush();

    closeEditorBtn(ctx).click();
    const counts = ctx.document.querySelector('.changes-file-row[data-path="new.txt"] .changes-file-counts');
    assert.equal(counts.textContent, '+2−7', 'git\'s own counts must survive the stale pair');
    assert.match(ctx.document.getElementById('changes-summary').textContent, /2 files changed \+5 −8/);
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

// --- armReady:false duplicate idle (adversarial review, MINOR finding 5) ---
// A remote row's decay/detach path calls setActivity(id, false, ..., {armReady:false})
// (see .ai/contexts/session-cache.md, "Remote hosts — busy spinner") — that
// opt-out means the response-ready lock never arms, so two such idle calls in
// a row with no busy in between must not double-fire the refresh on their own.

test('two consecutive setActivity(id, false, ..., {armReady:false}) idles refresh only once (mutation target: firing notifySessionIdle on every !active call)', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();
    assert.equal(ctx.calls.status.length, 1, 'the initial open');

    ctx.setActivity('s1', true, 'remote-seed');
    await flush();
    ctx.setActivity('s1', false, 'remote-decay', { armReady: false });
    await flush();
    assert.equal(ctx.calls.status.length, 2, 'the busy->idle edge must refresh once');

    ctx.setActivity('s1', false, 'remote-decay', { armReady: false });
    await flush();
    assert.equal(ctx.calls.status.length, 2, 'a second armReady:false idle with no new busy edge must not refresh again');
  } finally { ctx.destroy(); }
});

test('busy, then idle, then busy again, then idle again: two edges, two refreshes — not swallowed by the armReady:false dedup', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();
    assert.equal(ctx.calls.status.length, 1);

    ctx.setActivity('s1', true, 'remote-seed');
    ctx.setActivity('s1', false, 'remote-decay', { armReady: false });
    await flush();
    assert.equal(ctx.calls.status.length, 2, 'first busy->idle edge');

    ctx.setActivity('s1', true, 'remote-seed');
    ctx.setActivity('s1', false, 'remote-decay', { armReady: false });
    await flush();
    assert.equal(ctx.calls.status.length, 3, 'second busy->idle edge must still refresh');
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

// --- Editing in place ----------------------------------------------------

test('a local changed file opens in an editable diff over the content pair, with Save and the mode toggle', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');

    assert.deepEqual(ctx.calls.file, [{ sessionId: 's1', filePath: 'src/a.js', staged: true }]);
    assert.equal(ctx.calls.diff.length, 0, 'the editable path does not also fetch a unified diff');

    assert.equal(ctx.editors.length, 1);
    assert.deepEqual(ctx.editors[0].opened, { original: 'old\n', modified: 'new\n', filename: 'src/a.js' });
    assert.equal(ctx.editors[0].box.mode, 'side-by-side', 'the default mode');
    assert.ok(ctx.document.querySelector('#changes-diff-host .fake-editor'), 'the editor is mounted in the diff host');
    assert.equal(ctx.document.querySelector('.changes-diff-body'), null, 'no inert diff text alongside the editor');

    assert.equal(ctx.document.getElementById('changes-diff-save-btn').style.display, '');
    assert.equal(ctx.document.getElementById('changes-diff-mode-btn').style.display, '');
    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'src/a.js');
  } finally { ctx.destroy(); }
});

test('a remote session keeps the read-only renderer and offers no Save button (mutation target: the remote-write refusal)', async () => {
  const ctx = setupFilePanelDom({ statusImpl: REMOTE_STATUS });
  try {
    await openFile(ctx, 's1', 'src/a.js');

    assert.equal(ctx.editors.length, 0, 'a remote session never builds an editor');
    assert.equal(ctx.document.getElementById('changes-diff-save-btn').style.display, 'none');
    assert.equal(ctx.document.getElementById('changes-diff-mode-btn').style.display, 'none');
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /Remote session — read-only/);

    ctx.document.getElementById('changes-diff-save-btn').click();
    ctx.document.getElementById('changes-diff-view').dispatchEvent(new ctx.window.CustomEvent('cm-save', { bubbles: true }));
    await flush();
    assert.deepEqual(ctx.calls.save, [], 'neither the button nor Ctrl+S may write to a remote host');
  } finally { ctx.destroy(); }
});

test('a file the main process refuses to open for editing falls back to the read-only diff and says which limit it hit', async () => {
  const ctx = setupFilePanelDom({ fileImpl: () => ({ ok: false, error: 'file too large to edit', reason: 'too-large' }) });
  try {
    await openFile(ctx, 's1', 'src/a.js');

    assert.equal(ctx.editors.length, 0);
    assert.equal(ctx.calls.diff.length, 1, 'the read-only diff is the fallback');
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /file too large to edit/);
    assert.ok(ctx.document.querySelector('.changes-diff-add'), 'the unified diff still renders');
    assert.equal(ctx.document.getElementById('changes-diff-save-btn').style.display, 'none');
  } finally { ctx.destroy(); }
});

test('an idle refresh with the same file open reuses the editor instead of rebuilding it (mutation target: tearing the render down every time)', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    const editor = ctx.editors[0];

    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();

    assert.equal(ctx.calls.status.length, 2, 'the file list still refreshes');
    assert.equal(ctx.editors.length, 1, 'no second editor was built');
    assert.equal(editor.box.destroyed, false, 'the editor under the cursor survives the refresh');
    assert.equal(ctx.document.querySelector('#changes-diff-host .fake-editor'), editor.dom, 'and stays mounted');
  } finally { ctx.destroy(); }
});

test('an idle refresh does not detach the editor from the DOM either (mutation target: clearing the host on every render)', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    const host = ctx.document.getElementById('changes-diff-host');

    const records = [];
    const observer = new ctx.window.MutationObserver((list) => records.push(...list));
    observer.observe(host, { childList: true });

    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();
    await flush();

    observer.disconnect();
    assert.deepEqual(records, [], 'the editor node is neither removed nor re-inserted — a detach loses focus and scroll');
  } finally { ctx.destroy(); }
});

test('an idle refresh never replaces a dirty buffer, and says the file moved under it (mutation target: the dirty-buffer guard)', async () => {
  let current = 'new\n';
  let version = 'v1';
  const ctx = setupFilePanelDom({ fileImpl: () => ({ ok: true, original: 'old\n', current, version }) });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    const editor = ctx.editors[0];

    editor.box.text = 'typed by the user\n';
    current = 'written by the session\n';
    version = 'v2';

    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();

    assert.equal(ctx.editors.length, 1, 'no second editor');
    assert.equal(editor.box.destroyed, false);
    assert.equal(editor.box.text, 'typed by the user\n', 'the unsaved edit survives');
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /changed on disk/);
  } finally { ctx.destroy(); }
});

test('a dirty buffer over an unchanged file says nothing at all (mutation target: claiming staleness the code never checked)', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'typed by the user\n';

    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();

    assert.equal(ctx.editors[0].box.text, 'typed by the user\n');
    assert.equal(ctx.document.getElementById('changes-diff-notice').style.display, 'none',
      'nothing changed on disk, so there is nothing to warn about');
  } finally { ctx.destroy(); }
});

test('an idle refresh does reload a clean buffer when the file changed underneath', async () => {
  let current = 'new\n';
  const ctx = setupFilePanelDom({ fileImpl: () => ({ ok: true, original: 'old\n', current }) });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    const first = ctx.editors[0];

    current = 'written by the session\n';
    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();

    assert.equal(ctx.calls.file.length, 2);
    assert.equal(ctx.editors.length, 2, 'a clean buffer picks up the new content');
    assert.equal(first.box.destroyed, true);
    assert.equal(ctx.editors[1].opened.modified, 'written by the session\n');
  } finally { ctx.destroy(); }
});

test('Save writes the edited buffer through git-changes-save and refreshes the status so the counts follow', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'edited\n';

    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();

    assert.deepEqual(ctx.calls.save, [{ sessionId: 's1', filePath: 'src/a.js', content: 'edited\n', version: 'v1' }]);
    assert.equal(ctx.calls.status.length, 2, 'the row counts are re-read after a save');
    assert.equal(ctx.document.getElementById('changes-diff-notice').style.display, 'none');
  } finally { ctx.destroy(); }
});

test('Ctrl/Cmd+S from the editor saves the same way the button does', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'edited by keyboard\n';

    ctx.editors[0].dom.dispatchEvent(new ctx.window.CustomEvent('cm-save', { bubbles: true }));
    await flush();

    assert.deepEqual(ctx.calls.save, [{ sessionId: 's1', filePath: 'src/a.js', content: 'edited by keyboard\n', version: 'v1' }]);
  } finally { ctx.destroy(); }
});

test('a refused save surfaces the reason and keeps the buffer', async () => {
  const ctx = setupFilePanelDom({ saveImpl: () => ({ ok: false, error: 'path resolves outside the repository', reason: 'outside' }) });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'edited\n';

    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();

    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /Save failed: path resolves outside the repository/);
    assert.equal(ctx.editors.length, 1);
    assert.equal(ctx.editors[0].box.text, 'edited\n');
    assert.equal(ctx.calls.status.length, 1, 'a failed save must not claim the tree changed');
  } finally { ctx.destroy(); }
});

test('the mode toggle cycles side-by-side → inline → plain, persists under its own key, and carries unsaved edits over', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'edited\n';

    const modeBtn = ctx.document.getElementById('changes-diff-mode-btn');
    assert.equal(modeBtn.textContent, 'Side-by-side');

    modeBtn.click();
    await flush();
    assert.equal(ctx.window.localStorage.getItem('changesDiffMode'), 'inline');
    assert.equal(ctx.window.localStorage.getItem('filePanelDiffMode'), null, 'the MCP diff tab keeps its own key');
    assert.equal(ctx.editors[1].box.mode, 'inline');
    assert.equal(ctx.editors[1].opened.modified, 'edited\n', 'an unsaved edit is carried into the new view');

    modeBtn.click();
    await flush();
    assert.equal(ctx.editors[2].box.mode, 'plain');
    assert.equal(ctx.editors[2].opened.original, null, 'plain mode is the file, with no diff decoration');

    modeBtn.click();
    await flush();
    assert.equal(ctx.editors[3].box.mode, 'side-by-side');
    assert.equal(ctx.window.localStorage.getItem('changesDiffMode'), 'side-by-side');
  } finally { ctx.destroy(); }
});

test('an inline editor is read back from the view itself, a side-by-side one from its right-hand side', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');

    const sideBySide = ctx.editors[0];
    assert.ok(sideBySide.b, 'the side-by-side view edits its b side');
    sideBySide.box.text = 'from the b side\n';
    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();
    assert.equal(ctx.calls.save[0].content, 'from the b side\n');

    ctx.document.getElementById('changes-diff-mode-btn').click();
    await flush();
    const inline = ctx.editors[ctx.editors.length - 1];
    assert.equal(inline.b, undefined, 'the inline view has no b side');
    inline.box.text = 'from the single view\n';
    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();
    assert.equal(ctx.calls.save[1].content, 'from the single view\n');
  } finally { ctx.destroy(); }
});

test('an untracked local file opens with an empty original and its own lines as the added count', async () => {
  const ctx = setupFilePanelDom({ fileImpl: () => ({ ok: true, original: '', current: 'first\nsecond\n' }) });
  try {
    await openFile(ctx, 's1', 'new.txt');

    assert.deepEqual(ctx.calls.file, [{ sessionId: 's1', filePath: 'new.txt', staged: false }]);
    assert.equal(ctx.editors[0].opened.original, '');

    closeEditorBtn(ctx).click();
    const counts = ctx.document.querySelector('.changes-file-row[data-path="new.txt"] .changes-file-counts');
    assert.equal(counts.textContent, '+2−0');
    assert.match(ctx.document.getElementById('changes-summary').textContent, /2 files changed \+5 −1/);
  } finally { ctx.destroy(); }
});

test('closing the panel and going back to the list both destroy the editor (mutation target: a leaked view)', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    closeEditorBtn(ctx).click();
    assert.equal(ctx.editors[0].box.destroyed, true, 'Back destroys the editor');
    assert.equal(ctx.document.querySelector('#changes-diff-host .fake-editor'), null);

    clickRow(ctx, 'src/a.js');
    await flush();
    assert.equal(ctx.editors.length, 2);

    ctx.document.getElementById('changes-toggle-btn').click();
    assert.equal(ctx.editors[1].box.destroyed, true, 'closing the tab destroys the editor');
  } finally { ctx.destroy(); }
});

// --- The list and the editor together ------------------------------------

test('opening a file leaves the list on screen, with its row marked (mutation target: hiding the list)', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');

    assert.equal(ctx.document.getElementById('changes-list').style.display, 'block',
      'the list is the point: reviewing a set of files must not be a round trip');
    assert.equal(ctx.document.getElementById('changes-summary').style.display, 'block');
    assert.equal(ctx.document.getElementById('changes-diff-view').style.display, 'flex');
    assert.equal(ctx.document.querySelectorAll('.changes-file-row').length, 2, 'every row is still there');

    const selected = ctx.document.querySelectorAll('.changes-file-row.selected');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].dataset.path, 'src/a.js');
  } finally { ctx.destroy(); }
});

test('clicking another row swaps the editor\'s file without leaving the list', async () => {
  const ctx = setupFilePanelDom({
    fileImpl: (_s, filePath) => ({ ok: true, original: '', current: 'content of ' + filePath + '\n', version: 'v1' }),
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    assert.equal(ctx.editors[0].opened.modified, 'content of src/a.js\n');

    clickRow(ctx, 'new.txt');
    await flush();

    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'new.txt');
    assert.equal(ctx.editors[ctx.editors.length - 1].opened.modified, 'content of new.txt\n');
    assert.equal(ctx.document.getElementById('changes-list').style.display, 'block');
    const selected = ctx.document.querySelectorAll('.changes-file-row.selected');
    assert.equal(selected.length, 1, 'exactly one row is current');
    assert.equal(selected[0].dataset.path, 'new.txt');
  } finally { ctx.destroy(); }
});

test('switching rows with unsaved edits asks first, and a refusal stays on the file (mutation target: the row-switch guard)', async () => {
  const ctx = setupFilePanelDom({ confirmImpl: () => false });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    clickRow(ctx, 'new.txt');
    await flush();

    assert.equal(ctx.calls.confirm.length, 1, 'the same question the other exits ask');
    assert.equal(ctx.calls.file.length, 1, 'the refused switch fetched nothing');
    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'src/a.js');
    assert.equal(ctx.editors[0].box.destroyed, false);
    assert.equal(ctx.editors[0].box.text, 'my edit\n');
    assert.equal(ctx.document.querySelector('.changes-file-row.selected').dataset.path, 'src/a.js');
  } finally { ctx.destroy(); }
});

test('switching rows with unsaved edits proceeds once the user confirms', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    clickRow(ctx, 'new.txt');
    await flush();

    assert.equal(ctx.calls.confirm.length, 1);
    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'new.txt');
    assert.equal(ctx.editors[0].box.destroyed, true, 'the discarded buffer is gone');
  } finally { ctx.destroy(); }
});

test('clicking the row that is already open re-reads it without asking anything', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    clickRow(ctx, 'src/a.js');
    await flush();

    assert.equal(ctx.calls.confirm.length, 0, 'the current file is not another file');
  } finally { ctx.destroy(); }
});

test('a row switch confirmed by the user leaves no stash to resurrect (mutation target: the row-switch exit)', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'I ASKED TO DISCARD THIS\n';

    // A live stash, the way the other exits are pinned.
    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();
    assert.ok(ctx.stashOf('s1'), 'the stash is live before the switch');
    await ctx.window.openChangesTab('s1');
    await flush();

    clickRow(ctx, 'new.txt');
    await flush();
    assert.equal(ctx.calls.confirm.length, 1);
    assert.equal(ctx.stashOf('s1'), null, 'switching away from a discarded buffer must not stash it');

    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();
    await ctx.window.openChangesTab('s1');
    await flush();
    assert.equal(ctx.stashOf('s1'), null);
    assert.equal(ctx.document.getElementById('changes-diff-view').style.display, 'none',
      'and nothing from before the switch comes back — the editor region is closed');
  } finally { ctx.destroy(); }
});

test('an idle refresh rebuilds the list without disturbing the open editor', async () => {
  let files = null;
  const ctx = setupFilePanelDom({
    statusImpl: () => (files ? makeStatusResult({ files, totals: { files: files.length, added: 9, deleted: 0 } }) : makeStatusResult()),
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    const editor = ctx.editors[0];
    const host = ctx.document.getElementById('changes-diff-host');

    const records = [];
    const observer = new ctx.window.MutationObserver((list) => records.push(...list));
    observer.observe(host, { childList: true });

    files = [
      { path: 'src/a.js', origPath: null, staged: true, unstaged: false, untracked: false, renamed: false, state: 'M', added: 9, deleted: 0 },
      { path: 'new.txt', origPath: null, staged: false, unstaged: false, untracked: true, renamed: false, state: '?', added: null, deleted: null },
      { path: 'third.js', origPath: null, staged: false, unstaged: true, untracked: false, renamed: false, state: 'M', added: 1, deleted: 1 },
    ];
    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();
    await flush();
    observer.disconnect();

    assert.equal(ctx.document.querySelectorAll('.changes-file-row').length, 3, 'the list followed the session');
    assert.deepEqual(records, [], 'and the editor was not touched');
    assert.equal(editor.box.destroyed, false);
    assert.equal(ctx.document.querySelector('.changes-file-row.selected').dataset.path, 'src/a.js',
      'the open file is still marked after the rebuild');
  } finally { ctx.destroy(); }
});

test('the list keeps an explicit height only while the editor is open, and the drag persists it', async () => {
  const ctx = setupFilePanelDom();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const list = ctx.document.getElementById('changes-list');
    const splitter = ctx.document.getElementById('changes-list-splitter');
    assert.equal(list.style.height, '', 'with no editor the list takes the panel');
    assert.equal(splitter.style.display, 'none');

    clickRow(ctx, 'src/a.js');
    await flush();
    assert.equal(splitter.style.display, 'block');
    assert.notEqual(list.style.height, '', 'the split gives the list a bounded height');

    // Drag the handle down: the list grows by the delta.
    const before = parseInt(list.style.height, 10);
    splitter.dispatchEvent(new ctx.window.MouseEvent('mousedown', { clientY: 100, bubbles: true }));
    ctx.document.dispatchEvent(new ctx.window.MouseEvent('mousemove', { clientY: 160, bubbles: true }));
    ctx.document.dispatchEvent(new ctx.window.MouseEvent('mouseup', { bubbles: true }));

    const after = parseInt(list.style.height, 10);
    assert.ok(after > before, `the drag grew the list: ${before} -> ${after}`);
    assert.equal(ctx.window.localStorage.getItem('changesListHeight'), String(after),
      'and what the drag asked for is what is stored');

    closeEditorBtn(ctx).click();
    await flush();
    assert.equal(list.style.height, '', 'closing the editor gives the list the panel back');
  } finally { ctx.destroy(); }
});

// --- Staleness: the file moving under the editor -------------------------

test('a save carries the version token from the read, and a refused stale save keeps the buffer and says so (mutation target: the staleness refusal)', async () => {
  const ctx = setupFilePanelDom({
    saveImpl: () => ({ ok: false, error: 'this file changed on disk since it was opened', reason: 'stale' }),
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();

    assert.equal(ctx.calls.save[0].version, 'v1', 'the token the read handed out goes back with the write');
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /changed on disk/);
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /Save failed/);
    assert.equal(ctx.editors[0].box.text, 'my edit\n', 'the refusal costs the user nothing');
    assert.equal(ctx.calls.status.length, 1, 'a refused save must not claim the tree changed');
  } finally { ctx.destroy(); }
});

test('the open file is watched while it is editable, and unwatched on the way out', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    assert.deepEqual(ctx.calls.watch, [{ sessionId: 's1', filePath: 'src/a.js' }]);

    closeEditorBtn(ctx).click();
    await flush();
    assert.deepEqual(ctx.calls.unwatch, [{ sessionId: 's1', filePath: 'src/a.js' }]);
  } finally { ctx.destroy(); }
});

test('a watcher event reloads a clean buffer without waiting for the session to go idle', async () => {
  let current = 'new\n';
  let version = 'v1';
  const ctx = setupFilePanelDom({ fileImpl: () => ({ ok: true, original: 'old\n', current, version }) });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    assert.equal(ctx.editors.length, 1);

    current = 'written by the session\n';
    version = 'v2';
    ctx.fireFileChanged('s1', 'src/a.js');
    await flush();

    assert.equal(ctx.editors.length, 2, 'the editor picked up the session\'s write');
    assert.equal(ctx.editors[1].opened.modified, 'written by the session\n');
  } finally { ctx.destroy(); }
});

test('a watcher event on a dirty buffer warns instead of reloading (mutation target: the watcher clobbering the buffer)', async () => {
  let current = 'new\n';
  let version = 'v1';
  const ctx = setupFilePanelDom({ fileImpl: () => ({ ok: true, original: 'old\n', current, version }) });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    current = 'written by the session\n';
    version = 'v2';
    ctx.fireFileChanged('s1', 'src/a.js');
    await flush();

    assert.equal(ctx.editors.length, 1);
    assert.equal(ctx.editors[0].box.text, 'my edit\n');
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /changed on disk/);
  } finally { ctx.destroy(); }
});

test('Reload asks before discarding unsaved edits and re-reads the file when allowed', async () => {
  let current = 'new\n';
  let allow = false;
  const ctx = setupFilePanelDom({
    fileImpl: () => ({ ok: true, original: 'old\n', current, version: 'v1' }),
    confirmImpl: () => allow,
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';
    current = 'session content\n';

    ctx.document.getElementById('changes-diff-reload-btn').click();
    await flush();
    assert.equal(ctx.editors.length, 1, 'a declined confirm keeps the buffer');
    assert.equal(ctx.editors[0].box.text, 'my edit\n');

    allow = true;
    ctx.document.getElementById('changes-diff-reload-btn').click();
    await flush();
    assert.equal(ctx.editors.length, 2);
    assert.equal(ctx.editors[1].opened.modified, 'session content\n');
  } finally { ctx.destroy(); }
});

test('Reload re-arms the watch, since a replaced file is exactly what makes a watch go deaf', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    assert.equal(ctx.calls.watch.length, 1);

    ctx.document.getElementById('changes-diff-reload-btn').click();
    await flush();

    assert.equal(ctx.calls.watch.length, 2, 'the reload arms a fresh watch');
    assert.equal(ctx.calls.unwatch.length, 1, 'and drops the old one first');
  } finally { ctx.destroy(); }
});

test('a save whose IPC rejects is reported and leaves the button usable (mutation target: the rejected-save path)', async () => {
  const rejections = [];
  const ctx = setupFilePanelDom({ saveImpl: () => { throw new Error('ipc blew up'); } });
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();

    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /ipc blew up/);
    assert.equal(ctx.document.getElementById('changes-diff-save-btn').disabled, false,
      'the next click must do something');
    assert.equal(ctx.editors[0].box.text, 'my edit\n');
    assert.deepEqual(rejections, [], 'and nothing escapes as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onRejection);
    ctx.destroy();
  }
});

// --- Losing work by accident ---------------------------------------------

test('a session opening its own file keeps the unsaved buffer and restores it (mutation target: the stash)', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'work in progress\n';

    // The session — not the user — takes the panel over.
    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();
    assert.equal(ctx.calls.confirm.length, 0, 'an IPC-driven swap cannot stop to ask');

    await ctx.window.openChangesTab('s1');
    await flush();

    const restored = ctx.editors[ctx.editors.length - 1];
    assert.equal(restored.opened.modified, 'work in progress\n', 'the buffer comes back as it was');
    const notice = ctx.document.getElementById('changes-diff-notice').textContent;
    assert.match(notice, /restored/i);
    assert.match(notice, /the session opened something else/i, 'the notice must name the real reason');
    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'src/a.js');
  } finally { ctx.destroy(); }
});

// Each exit is given its own live stash, so none of them can pass on the back
// of another having already cleared it.
for (const exit of ['toggle', 'panel-close', 'back']) {
  test(`the ${exit} exit clears the stash once the user confirms the discard (mutation target: the discard call on that path)`, async () => {
    const ctx = setupFilePanelDom();
    try {
      await openFile(ctx, 's1', 'src/a.js');
      ctx.editors[0].box.text = 'I ASKED TO DISCARD THIS\n';

      // A takeover puts the buffer in the stash; reopening restores it, so the
      // tab is dirty again and this exit is the one that must drop it.
      ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
      await flush();
      assert.ok(ctx.stashOf('s1'), 'the stash is live before the exit');
      await ctx.window.openChangesTab('s1');
      await flush();

      if (exit === 'toggle') ctx.document.getElementById('changes-toggle-btn').click();
      else if (exit === 'panel-close') ctx.document.querySelector('#file-panel-changes .fp-close-btn').click();
      else closeEditorBtn(ctx).click();
      await flush();

      assert.equal(ctx.calls.confirm.length, 1, 'the user was asked');
      assert.equal(ctx.stashOf('s1'), null, 'a confirmed discard must leave nothing to resurrect');

      await ctx.window.openChangesTab('s1');
      await flush();
      assert.equal(ctx.document.getElementById('changes-list').style.display, 'block',
        'reopening shows the file list, not the buffer the user threw away');
      assert.equal(ctx.document.getElementById('changes-diff-view').style.display, 'none',
        'and the diff view, where the restore notice lives, is off screen');
      assert.equal(ctx.editors[ctx.editors.length - 1].box.destroyed, true,
        'the discarded editor is gone, not merely hidden');
    } finally { ctx.destroy(); }
  });
}

test('a confirmed discard also drops a buffer stashed by an earlier takeover', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'stashed by the session\n';

    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();
    assert.ok(ctx.stashOf('s1'), 'the takeover stashed it');

    await ctx.window.openChangesTab('s1');
    await flush();
    ctx.document.getElementById('changes-toggle-btn').click();
    assert.equal(ctx.stashOf('s1'), null, 'the restored buffer was discarded on purpose');

    await ctx.window.openChangesTab('s1');
    await flush();
    assert.equal(ctx.document.getElementById('changes-list').style.display, 'block');
  } finally { ctx.destroy(); }
});

test('a declined discard keeps both the buffer and the tab', async () => {
  const ctx = setupFilePanelDom({ confirmImpl: () => false });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'keep me\n';

    ctx.document.getElementById('changes-toggle-btn').click();
    assert.equal(ctx.editors[0].box.destroyed, false);
    assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), true);
  } finally { ctx.destroy(); }
});

// The pair of questions this feature turns on: a buffer may only be dropped
// when the user was asked about it, and must be dropped when they said yes.
test('closing the panel over the session\'s own tab keeps the stash, because nothing was asked (mutation target: clearing without asking)', async () => {
  for (const takeover of ['file', 'diff']) {
    const ctx = setupFilePanelDom();
    try {
      await openFile(ctx, 's1', 'src/a.js');
      ctx.editors[0].box.text = 'work the user never abandoned\n';

      if (takeover === 'file') {
        ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
      } else {
        ctx.window.openDiffTab('s1', 'd1', { oldFilePath: '/repo/other.js', oldContent: 'a\n', newContent: 'b\n' });
      }
      await flush();
      assert.ok(ctx.stashOf('s1'), `the ${takeover} takeover stashed the buffer`);

      // The panel now shows the session's tab. Closing it asks nothing about
      // edits that are not in front of the user.
      ctx.window.handleClose();
      assert.equal(ctx.calls.confirm.length, 0, 'no question was put');
      assert.ok(ctx.stashOf('s1'), 'so the answer cannot be "discard"');

      await ctx.window.openChangesTab('s1');
      await flush();
      const restored = ctx.editors[ctx.editors.length - 1];
      assert.equal(restored.opened.modified, 'work the user never abandoned\n');
    } finally { ctx.destroy(); }
  }
});

test('an exit that asks nothing never drops a stash, even from the Changes tab itself', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'stashed\n';
    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();

    // Back in Changes, the restored buffer is saved, so the tab is clean: an
    // exit from here asks nothing, and a clean tab is not an instruction.
    await ctx.window.openChangesTab('s1');
    await flush();
    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();
    assert.equal(ctx.calls.confirm.length, 0);

    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();
    closeEditorBtn(ctx).click();
    assert.equal(ctx.calls.confirm.length, 0, 'a clean buffer is never asked about');
  } finally { ctx.destroy(); }
});

test('a clean buffer is not stashed, so reopening the tab shows the file list', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');

    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();
    await ctx.window.openChangesTab('s1');
    await flush();

    assert.equal(ctx.document.getElementById('changes-list').style.display, 'block');
    assert.equal(ctx.document.getElementById('changes-diff-notice').style.display, 'none');
  } finally { ctx.destroy(); }
});

test('a restored buffer still refuses to save against a file that moved', async () => {
  const ctx = setupFilePanelDom({
    saveImpl: () => ({ ok: false, error: 'this file changed on disk since it was opened', reason: 'stale' }),
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'work in progress\n';
    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();
    await ctx.window.openChangesTab('s1');
    await flush();

    ctx.document.getElementById('changes-diff-save-btn').click();
    await flush();

    assert.equal(ctx.calls.save[0].version, 'v1', 'the token travelled with the stash');
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /changed on disk/);
  } finally { ctx.destroy(); }
});

test('Back asks before discarding unsaved edits, and a refusal keeps the editor (mutation target: the confirm)', async () => {
  const ctx = setupFilePanelDom({ confirmImpl: () => false });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    closeEditorBtn(ctx).click();
    await flush();

    assert.equal(ctx.calls.confirm.length, 1);
    assert.equal(ctx.editors[0].box.destroyed, false, 'the buffer is still there');
    assert.equal(ctx.document.getElementById('changes-diff-view').style.display, 'flex');
  } finally { ctx.destroy(); }
});

test('closing the tab and closing the panel both ask before discarding unsaved edits', async () => {
  const ctx = setupFilePanelDom({ confirmImpl: () => false });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    ctx.document.getElementById('changes-toggle-btn').click();
    assert.equal(ctx.editors[0].box.destroyed, false, 'the Changes button must not drop the buffer silently');

    ctx.document.querySelector('#file-panel-changes .fp-close-btn').click();
    assert.equal(ctx.editors[0].box.destroyed, false, 'neither must the panel close button');
    assert.equal(ctx.calls.confirm.length, 2);
  } finally { ctx.destroy(); }
});

test('two saves in a row issue one write (mutation target: the in-flight guard)', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    // Ctrl+S twice: the keyboard path does not consult the button's disabled
    // state, so only the in-flight guard itself can stop the second write.
    ctx.editors[0].dom.dispatchEvent(new ctx.window.CustomEvent('cm-save', { bubbles: true }));
    ctx.editors[0].dom.dispatchEvent(new ctx.window.CustomEvent('cm-save', { bubbles: true }));
    await flush();

    assert.equal(ctx.calls.save.length, 1, 'the second save lands while the first write is in flight');

    const saveBtn = ctx.document.getElementById('changes-diff-save-btn');
    saveBtn.click();
    saveBtn.click();
    await flush();
    assert.equal(ctx.calls.save.length, 2, 'and the button is disabled for the duration too');
  } finally { ctx.destroy(); }
});

// --- One host, one editor -------------------------------------------------

test('another session\'s editor never stacks in the shared host (mutation target: mounting without clearing)', async () => {
  const ctx = setupFilePanelDom({
    fileImpl: (sessionId) => ({ ok: true, original: 'old\n', current: 'content of ' + sessionId + '\n', version: 'v1' }),
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    await openFile(ctx, 's2', 'src/a.js');

    ctx.window.switchPanel('s1');
    await flush();

    const host = ctx.document.getElementById('changes-diff-host');
    assert.equal(host.children.length, 1, 'exactly one editor on screen');
    assert.equal(host.children[0], ctx.editors[0].dom, 's1\'s own editor, not s2\'s');

    ctx.window.switchPanel('s2');
    await flush();
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0], ctx.editors[1].dom);
  } finally { ctx.destroy(); }
});

// --- Things going wrong while a file is open ------------------------------

test('a file that disappears under the editor says so instead of showing a phantom', async () => {
  let gone = false;
  const ctx = setupFilePanelDom({
    fileImpl: () => (gone
      ? { ok: false, error: 'file is not in the working tree', reason: 'missing' }
      : { ok: true, original: 'old\n', current: 'new\n', version: 'v1' }),
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    gone = true;

    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();

    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /can no longer be read/);
    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /not in the working tree/);
  } finally { ctx.destroy(); }
});

test('a status refresh that fails while a file is open is visible in the diff view', async () => {
  let broken = false;
  const ctx = setupFilePanelDom({
    statusImpl: () => (broken ? { ok: false, error: 'fatal: not a git repository' } : makeStatusResult()),
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    broken = true;

    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();

    assert.match(ctx.document.getElementById('changes-diff-notice').textContent, /not a git repository/);
  } finally { ctx.destroy(); }
});

test('staging the open file mid-turn re-points the selection at its refreshed row', async () => {
  let staged = false;
  const statusImpl = () => makeStatusResult({
    files: [{ path: 'src/a.js', origPath: null, staged, unstaged: !staged, untracked: false, renamed: false, state: 'M', added: 3, deleted: 1 }],
    totals: { files: 1, added: 3, deleted: 1 },
  });
  const ctx = setupFilePanelDom({ statusImpl });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    assert.equal(ctx.calls.file[0].staged, false);

    staged = true;
    ctx.setActivity('s1', true);
    ctx.setActivity('s1', false);
    await flush();

    assert.equal(ctx.calls.file[ctx.calls.file.length - 1].staged, true,
      'the pair is re-read against HEAD once the file is staged');
  } finally { ctx.destroy(); }
});

test('inline mode asks for a merge view with no accept/reject controls — this panel is not a git client', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.document.getElementById('changes-diff-mode-btn').click();
    await flush();

    const inline = ctx.editors[ctx.editors.length - 1];
    assert.equal(inline.box.mode, 'inline');
    assert.equal(inline.opts.mergeControls, false, 'accept/reject chunk controls would revert working-tree changes');
  } finally { ctx.destroy(); }
});

test('the panel close button destroys the editor too', async () => {
  const ctx = setupFilePanelDom();
  try {
    await openFile(ctx, 's1', 'src/a.js');

    ctx.document.querySelector('#file-panel-changes .fp-close-btn').click();
    assert.equal(ctx.editors[0].box.destroyed, true);
    assert.equal(ctx.document.getElementById('file-panel').classList.contains('open'), false);
  } finally { ctx.destroy(); }
});

// --- A file link from the terminal ----------------------------------------

test('a link to a changed file opens the Changes editor on its row (mutation target: the link routing)', async () => {
  const ctx = setupFilePanelDom({
    locateImpl: () => ({ ok: true, relPath: 'src/a.js', changed: true, staged: true, untracked: false }),
    fileImpl: () => ({ ok: true, original: 'old\n', current: 'new\n', version: 'v1' }),
  });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/a.js');
    await flush();

    assert.deepEqual(ctx.calls.locate, [{ sessionId: 's1', filePath: '/repo/src/a.js' }],
      'the absolute path goes to main, which answers with a row');
    assert.deepEqual(ctx.calls.readFile, [], 'the plain viewer is not involved');
    assert.equal(ctx.document.getElementById('file-panel-changes').style.display, 'flex');
    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'src/a.js');
    assert.deepEqual(ctx.calls.file[0], { sessionId: 's1', filePath: 'src/a.js', staged: true },
      'and the row it names is opened against the side the row says');
    assert.equal(ctx.document.querySelector('.changes-file-row.selected').dataset.path, 'src/a.js');
  } finally { ctx.destroy(); }
});

test('a link to an untracked file opens there too', async () => {
  const ctx = setupFilePanelDom({
    locateImpl: () => ({ ok: true, relPath: 'new.txt', changed: true, staged: false, untracked: true }),
    fileImpl: () => ({ ok: true, original: '', current: 'brand new\n', version: 'v1' }),
  });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/new.txt');
    await flush();

    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'new.txt');
    assert.equal(ctx.calls.file[0].staged, false);
    assert.deepEqual(ctx.calls.readFile, []);
  } finally { ctx.destroy(); }
});

test('a link to an unmodified file, or one outside the repo, keeps the plain viewer (mutation target: the changed check)', async () => {
  for (const answer of [
    { ok: true, relPath: 'clean.txt', changed: false },
    { ok: false, reason: 'outside', error: 'path is outside this session\'s repository' },
    { ok: false, reason: 'remote', error: 'editing is not available for a remote session' },
  ]) {
    const ctx = setupFilePanelDom({ locateImpl: () => answer });
    try {
      ctx.window.switchPanel('s1');
      await ctx.window.openFileInPanel('s1', '/somewhere/clean.txt');
      await flush();

      assert.deepEqual(ctx.calls.readFile, ['/somewhere/clean.txt'],
        `${answer.reason || 'unmodified'} must fall back to the plain editor`);
      assert.equal(ctx.calls.file.length, 0, 'and must not open a Changes editor');
      assert.equal(ctx.document.getElementById('file-panel-viewer').style.display, 'flex');
    } finally { ctx.destroy(); }
  }
});

test('a link falls back to the plain viewer when the main process cannot answer at all', async () => {
  const ctx = setupFilePanelDom({ locateImpl: () => { throw new Error('channel closed'); } });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/a.js');
    await flush();

    assert.deepEqual(ctx.calls.readFile, ['/repo/src/a.js'], 'a link still opens something');
    assert.equal(ctx.calls.file.length, 0);
  } finally { ctx.destroy(); }
});

test('a link while another file is open with unsaved edits asks before switching', async () => {
  const ctx = setupFilePanelDom({
    confirmImpl: () => false,
    locateImpl: () => ({ ok: true, relPath: 'new.txt', changed: true, staged: false, untracked: true }),
  });
  try {
    await openFile(ctx, 's1', 'src/a.js');
    ctx.editors[0].box.text = 'my edit\n';

    await ctx.window.openFileInPanel('s1', '/repo/new.txt');
    await flush();

    assert.equal(ctx.calls.confirm.length, 1);
    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'src/a.js',
      'a refused switch stays where it was, link or row click alike');
    assert.equal(ctx.editors[0].box.text, 'my edit\n');
  } finally { ctx.destroy(); }
});

test('a link is still honoured when the panel is closed or showing something else', async () => {
  const ctx = setupFilePanelDom({
    locateImpl: () => ({ ok: true, relPath: 'src/a.js', changed: true, staged: true, untracked: false }),
  });
  try {
    ctx.window.switchPanel('s1');
    ctx.window.openFileTab('s1', { filePath: '/repo/other.js', content: 'other' });
    await flush();

    await ctx.window.openFileInPanel('s1', '/repo/src/a.js');
    await flush();

    assert.equal(ctx.document.getElementById('file-panel-changes').style.display, 'flex');
    assert.equal(ctx.document.getElementById('changes-diff-path').textContent, 'src/a.js');
    assert.equal(ctx.calls.status.length, 1, 'the tab it opened loaded its list');
  } finally { ctx.destroy(); }
});

test('the list height is clamped for display only, and never ratcheted down (mutation target: the clamp)', () => {
  const ctx = setupFilePanelDom();
  try {
    const clamp = ctx.clampListHeight;

    // Room for both: the drag gets what it asked for.
    assert.equal(clamp(200, 600), 200);

    // A short panel: the editor keeps its floor, the list gives way.
    assert.equal(clamp(500, 300), 180, 'available minus the editor floor');

    // Shorter than both floors: the list keeps its own and the region scrolls
    // rather than the list vanishing.
    assert.equal(clamp(500, 150), 96);
    assert.equal(clamp(10, 600), 96, 'a drag cannot take the list below its floor');

    // No layout to measure yet: keep what was asked for rather than guessing.
    assert.equal(clamp(250, 0), 250);
  } finally { ctx.destroy(); }
});
