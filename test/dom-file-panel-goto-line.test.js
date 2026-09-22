'use strict';

// A path:line link carries its line into the panel, on both routes into it:
// the plain viewer for an unchanged file, and the diff for a changed one.
// When the diff is read-only there is no line to jump to, and the panel says
// so instead of dropping the line silently.

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
      <div id="terminal-header-controls"><button id="terminal-stop-btn"></button></div>
    </div>
  </body>
</html>`;

const STATUS = {
  ok: true,
  kind: 'local',
  branch: { head: 'main', upstream: null, ahead: 0, behind: 0 },
  files: [{ path: 'src/a.js', origPath: null, staged: false, unstaged: true, untracked: false, renamed: false, state: 'M', added: 1, deleted: 0 }],
  totals: { files: 1, added: 1, deleted: 0 },
};

function setup({ locateImpl, fileImpl } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { revealed: [], viewerOpened: [], viewerRevealed: [] };

  window.api = {
    onMcpOpenDiff: () => {}, onMcpOpenFile: () => {}, onMcpCloseAllDiffs: () => {}, onMcpCloseTab: () => {},
    mcpDiffResponse: () => {},
    gitChangesStatus: () => Promise.resolve(STATUS),
    gitChangesDiff: () => Promise.resolve({ ok: true, content: '@@ -1 +1 @@\n-old\n+new\n', truncated: false }),
    gitChangesFile: () => Promise.resolve((fileImpl || (() => ({ ok: true, original: 'a\n', current: 'b\n', version: 'v1' })))()),
    gitChangesSave: () => Promise.resolve({ ok: true, version: 'v2' }),
    gitChangesWatch: () => Promise.resolve({ ok: true }),
    gitChangesUnwatch: () => Promise.resolve({ ok: true }),
    onGitChangesFileChanged: () => {},
    gitChangesLocate: (_s, filePath) => Promise.resolve((locateImpl || (() => ({ ok: false, reason: 'outside' })))(filePath)),
    readFileForPanel: () => Promise.resolve({ ok: true, content: 'one\ntwo\nthree\n' }),
    saveFileForPanel: () => Promise.resolve({ ok: true }),
  };
  window.confirm = () => true;
  window.loadCodeMirrorBundle = () => Promise.resolve();
  window.cmRevealLine = (view, line) => calls.revealed.push({ view, line });

  const makeView = (parent) => {
    const el = window.document.createElement('div');
    parent.appendChild(el);
    return { dom: el, state: { doc: { toString: () => 'b\n' } }, destroy() { if (el.parentNode) el.parentNode.removeChild(el); } };
  };
  window.createMergeViewer = (parent) => makeView(parent);
  window.createUnifiedMergeViewer = (parent) => makeView(parent);
  window.createEditableViewer = (parent) => makeView(parent);

  Object.defineProperty(window, 'ViewerPanel', {
    value: function ViewerPanelStub() {
      return {
        open: (title, filePath) => calls.viewerOpened.push(filePath),
        revealLine: (line) => calls.viewerRevealed.push(line),
        destroy() {},
      };
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  for (const f of ['splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'file-panel.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: f });
  }
  window.initFilePanel();
  return { window, document: window.document, calls, destroy: () => window.close() };
}

function flush() {
  let p = Promise.resolve();
  for (let i = 0; i < 16; i++) p = p.then(() => Promise.resolve());
  return p;
}

test('an unchanged file opens in the viewer and is scrolled to the line', async () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/other.js', { line: 42 });
    await flush();
    assert.deepStrictEqual(ctx.calls.viewerOpened, ['/repo/src/other.js']);
    assert.deepStrictEqual(ctx.calls.viewerRevealed, [42]);
  } finally { ctx.destroy(); }
});

test('no line means no jump', async () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/other.js');
    await flush();
    assert.deepStrictEqual(ctx.calls.viewerRevealed, []);
  } finally { ctx.destroy(); }
});

test('a changed file opens its diff and the editor is scrolled to the line', async () => {
  const ctx = setup({ locateImpl: () => ({ ok: true, changed: true, relPath: 'src/a.js', staged: false, untracked: false }) });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/a.js', { line: 7 });
    await flush();
    assert.strictEqual(ctx.calls.revealed.length, 1);
    assert.strictEqual(ctx.calls.revealed[0].line, 7);
    assert.deepStrictEqual(ctx.calls.viewerRevealed, []);
  } finally { ctx.destroy(); }
});

test('a read-only diff says the line was not reached rather than dropping it', async () => {
  const ctx = setup({
    locateImpl: () => ({ ok: true, changed: true, relPath: 'src/a.js', staged: false, untracked: false }),
    fileImpl: () => ({ ok: false, reason: 'binary' }),
  });
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/a.js', { line: 7 });
    await flush();
    assert.strictEqual(ctx.calls.revealed.length, 0);
    const notice = ctx.document.querySelector('#changes-diff-notice');
    assert.match(notice.textContent, /Line 7 was not reached/);
  } finally { ctx.destroy(); }
});

test('a line of zero or below is ignored, not passed on', async () => {
  const ctx = setup();
  try {
    ctx.window.switchPanel('s1');
    await ctx.window.openFileInPanel('s1', '/repo/src/other.js', { line: 0 });
    await flush();
    assert.deepStrictEqual(ctx.calls.viewerRevealed, []);
  } finally { ctx.destroy(); }
});
