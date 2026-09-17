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
    gitChangesDiff: (sessionId, filePath, staged, untracked) => {
      calls.diff.push({ sessionId, filePath, staged, untracked });
      return Promise.resolve((diffImpl || (() => ({ ok: true, content: '@@ -1 +1 @@\n-old\n+new\n context\n', truncated: false })))(sessionId, filePath, staged, untracked));
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
    assert.deepEqual(ctx.calls.diff[0], { sessionId: 's1', filePath: 'src/a.js', staged: true, untracked: false });

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

const UNTRACKED_DIFF_RESULT = {
  ok: true,
  content: 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n',
  truncated: false,
  added: 2,
  deleted: 0,
};

test('clicking an untracked file fetches its diff like any other row, flagged untracked (mutation target: the old short-circuit)', async () => {
  const ctx = setupFilePanelDom({ diffImpl: () => UNTRACKED_DIFF_RESULT });
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
  const ctx = setupFilePanelDom({ diffImpl: () => UNTRACKED_DIFF_RESULT });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    const before = ctx.document.querySelector('.changes-file-row[data-path="new.txt"] .changes-file-counts');
    assert.equal(before, null, 'status alone cannot know an untracked file\'s line count');

    ctx.document.querySelector('.changes-file-row[data-path="new.txt"]')
      .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    const backBtn = Array.from(ctx.document.querySelectorAll('#changes-diff-view button')).find(b => b.textContent === 'Back');
    backBtn.click();

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
  const ctx = setupFilePanelDom({ diffImpl: () => binary });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    ctx.document.querySelector('.changes-file-row[data-path="new.txt"]')
      .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    const body = ctx.document.querySelector('.changes-diff-body');
    assert.match(body.textContent, /Binary files .* differ/);

    const backBtn = Array.from(ctx.document.querySelectorAll('#changes-diff-view button')).find(b => b.textContent === 'Back');
    backBtn.click();

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
    statusImpl: () => (statusCall++ === 0 ? makeStatusResult() : v2),
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

    const backBtn = Array.from(ctx.document.querySelectorAll('#changes-diff-view button')).find(b => b.textContent === 'Back');
    backBtn.click();

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
  const ctx = setupFilePanelDom({ diffImpl: () => ({ ok: false, error: 'fatal: bad thing' }) });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openChangesTab('s1');
    await flush();

    ctx.document.querySelector('.changes-file-row[data-path="new.txt"]')
      .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush();

    const body = ctx.document.querySelector('.changes-diff-body');
    assert.match(body.textContent, /fatal: bad thing/);

    const backBtn = Array.from(ctx.document.querySelectorAll('#changes-diff-view button')).find(b => b.textContent === 'Back');
    backBtn.click();
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
