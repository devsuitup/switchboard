'use strict';

// One ViewerPanel serves the file tabs of every session. Switching away and
// back must show a file tab as the user left it — unsaved edits and the base
// they agreed to — not the content first read when the tab opened (#361).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const INDEX_HTML = `<!DOCTYPE html>
<html>
  <head></head>
  <body>
    <div id="terminal-area"><div id="terminals"></div></div>
    <div id="terminal-header" style="display:none;">
      <div id="terminal-header-controls"><button id="terminal-stop-btn"></button></div>
    </div>
  </body>
</html>`;

function fakeEditor(initial) {
  let doc = initial || '';
  return {
    state: { doc: { toString: () => doc, get length() { return doc.length; } } },
    dispatch(tr) {
      if (tr && tr.changes) {
        const { from, to, insert } = tr.changes;
        doc = doc.slice(0, from) + insert + doc.slice(to);
      }
    },
    type(text) { doc += text; },
    destroy() {},
  };
}

function setup() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const disk = new Map();
  const calls = { saves: [], openFile: null, openDiff: null, closeTab: null, closeAllDiffs: null, diffResponses: [], confirms: [], confirmAnswer: false, revealed: [], changed: new Set() };
  let editor = null;

  window.api = new Proxy({
    onMcpOpenFile: (cb) => { calls.openFile = cb; },
    onMcpOpenDiff: (cb) => { calls.openDiff = cb; },
    onMcpCloseTab: (cb) => { calls.closeTab = cb; },
    onMcpCloseAllDiffs: (cb) => { calls.closeAllDiffs = cb; },
    mcpDiffResponse: (sessionId, diffId, action) => { calls.diffResponses.push({ sessionId, diffId, action }); },
    gitChangesLocate: (sessionId, p) => Promise.resolve(calls.changed.has(p)
      ? { ok: true, changed: true, relPath: path.basename(p), staged: false, untracked: false }
      : { ok: true, changed: false }),
    gitChangesStatus: () => Promise.resolve({
      ok: true, kind: 'local', branch: { head: 'main', upstream: null, ahead: 0, behind: 0 },
      files: [...calls.changed].map((p) => ({ path: path.basename(p), origPath: null, staged: false, unstaged: true, untracked: false, renamed: false, state: 'M', added: 1, deleted: 0 })),
      totals: { files: calls.changed.size, added: calls.changed.size, deleted: 0, uncounted: 0 },
    }),
    gitChangesFile: () => Promise.resolve({ ok: true, original: 'c0\n', current: 'c1\n', version: 'v1' }),
    gitChangesDiff: () => Promise.resolve({ ok: true, content: '@@ -1 +1 @@\n-c0\n+c1\n', truncated: false }),
    watchFile: () => Promise.resolve({ ok: true }),
    unwatchFile: () => Promise.resolve({ ok: true }),
    readFileForPanel: (p) => Promise.resolve(disk.has(p) ? { ok: true, content: disk.get(p) } : { ok: false, code: 'ENOENT', error: 'ENOENT' }),
    saveFileForPanel: (p, content, expected) => {
      calls.saves.push({ path: p, content, expected });
      if (typeof expected !== 'string') return Promise.resolve({ ok: false, reason: 'invalid-expected', error: 'missing' });
      if (disk.get(p) !== expected) return Promise.resolve({ ok: false, reason: 'stale', error: 'stale', disk: disk.get(p) });
      disk.set(p, content);
      return Promise.resolve({ ok: true });
    },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => {};
      return () => Promise.resolve({ ok: true });
    },
  });
  window.confirm = (msg) => { calls.confirms.push(msg); return calls.confirmAnswer; };
  window.cmRevealLine = (view, line) => calls.revealed.push(line);
  window.createEditableViewer = (parent, content) => { editor = fakeEditor(content); return editor; };
  window.createPlanEditor = () => { editor = fakeEditor(''); return editor; };
  const fakeMerge = (parent, _old, proposed) => {
    const el = window.document.createElement('div');
    parent.appendChild(el);
    const doc = { toString: () => proposed };
    return { dom: el, b: { state: { doc } }, state: { doc }, destroy() { el.remove(); } };
  };
  window.createMergeViewer = fakeMerge;
  window.createUnifiedMergeViewer = fakeMerge;
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  const realCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreate(tag, ...args);
    if (String(tag).toLowerCase() === 'script') Promise.resolve().then(() => el.onload && el.onload());
    return el;
  };

  for (const f of ['viewer-toolbar.js', 'viewer-panel.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'header-controls.js', 'file-panel.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: path.join(PUBLIC_DIR, f) });
  }
  window.initFilePanel();
  const viewer = () => vm.runInContext('fpViewerPanel', dom.getInternalVMContext());
  return { window, disk, calls, viewer, editor: () => editor, destroy: () => window.close() };
}

function flush() {
  return new Promise((r) => setTimeout(r, 5));
}

const A = '/repo/a.md';
const B = '/repo/b.md';

function content(ctx) {
  return ctx.viewer().getContent();
}

async function save(ctx) {
  ctx.window.document.getElementById('file-panel-viewer').dispatchEvent(new ctx.window.CustomEvent('cm-save'));
  await flush();
}

test('switching session and back keeps both the saved and the unsaved edit, and the agreed base', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.disk.set(B, 'b0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    ctx.editor().type('X');
    await save(ctx);
    assert.equal(ctx.disk.get(A), 'a0\nX');
    ctx.editor().type('Y');

    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    assert.equal(content(ctx), 'b0\n');

    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(content(ctx), 'a0\nXY', 'both edits survive the switch');

    await save(ctx);
    assert.deepEqual(ctx.calls.saves.at(-1), { path: A, content: 'a0\nXY', expected: 'a0\nX' },
      'the base is the one the user agreed to, not the first read');
    assert.equal(ctx.disk.get(A), 'a0\nXY');
    assert.deepEqual(ctx.calls.confirms, []);
  } finally { ctx.destroy(); }
});

test('a file written while its tab was away is re-read on return: a dirty buffer is kept and told', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.disk.set(B, 'b0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    ctx.editor().type('mine');

    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    ctx.disk.set(A, 'session\n');

    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(content(ctx), 'a0\nmine');
    const notice = ctx.window.document.querySelector('#file-panel-viewer .viewer-panel-notice-text');
    assert.match(notice.textContent, /changed on disk/);
  } finally { ctx.destroy(); }
});

test("closing another session's file tab that the viewer is not showing leaves the shown buffer alone", async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    ctx.editor().type('mine');

    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    ctx.calls.openFile('s2', { filePath: '/repo/c.md', content: 'c0\n' });
    await flush();
    assert.equal(content(ctx), 'a0\nmine');
  } finally { ctx.destroy(); }
});

test('re-rendering the tab the viewer already shows leaves a save in flight to finish', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    const realSave = ctx.window.api.saveFileForPanel;
    let finish;
    ctx.window.api.saveFileForPanel = (p, content, expected) => new Promise((resolve) => {
      finish = () => resolve(realSave(p, content, expected));
    });
    ctx.editor().type('X');
    ctx.window.document.getElementById('file-panel-viewer').dispatchEvent(new ctx.window.CustomEvent('cm-save'));
    await flush();
    ctx.window.renderPanel('s1');
    await flush();
    finish();
    await flush();
    ctx.window.api.saveFileForPanel = realSave;
    assert.equal(ctx.disk.get(A), 'a0\nX');

    ctx.editor().type('Y');
    await save(ctx);
    assert.equal(ctx.calls.saves.at(-1).expected, 'a0\nX', 'the finished save moved the base');
    assert.deepEqual(ctx.calls.confirms, []);
  } finally { ctx.destroy(); }
});

async function saveThenSwitchAway(ctx, outcome, typedDuringSave = '') {
  ctx.disk.set(A, 'a0\n');
  ctx.disk.set(B, 'b0\n');
  ctx.window.switchPanel('s1');
  ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
  await flush();
  const realSave = ctx.window.api.saveFileForPanel;
  let finish;
  ctx.window.api.saveFileForPanel = (p, content, expected) => new Promise((resolve) => {
    finish = () => resolve(outcome ? outcome : realSave(p, content, expected));
  });
  ctx.editor().type('X');
  ctx.window.document.getElementById('file-panel-viewer').dispatchEvent(new ctx.window.CustomEvent('cm-save'));
  await flush();
  if (typedDuringSave) ctx.editor().type(typedDuringSave);
  ctx.window.switchPanel('s2');
  ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
  await flush();
  finish();
  await flush();
  ctx.window.api.saveFileForPanel = realSave;
  ctx.window.switchPanel('s1');
  await flush();
}

const noticeOf = (ctx) => {
  const el = ctx.window.document.querySelector('#file-panel-viewer .viewer-panel-notice');
  return el.style.display === 'none' ? null : el.querySelector('.viewer-panel-notice-text').textContent;
};

test('a save that fails after its tab left the viewer says so when the tab returns', async () => {
  const ctx = setup();
  try {
    await saveThenSwitchAway(ctx, { ok: false, error: 'disk full' });
    assert.equal(content(ctx), 'a0\nX');
    assert.equal(noticeOf(ctx), 'Save failed: disk full');
  } finally { ctx.destroy(); }
});

test('a save that succeeds after its tab left the viewer moves that tab\'s base', async () => {
  const ctx = setup();
  try {
    await saveThenSwitchAway(ctx, null, 'Z');
    assert.equal(ctx.disk.get(A), 'a0\nX');
    assert.equal(content(ctx), 'a0\nXZ');
    assert.equal(noticeOf(ctx), null, 'our own write is not reported as a change on disk');
    ctx.editor().type('Y');
    await save(ctx);
    assert.equal(ctx.calls.saves.at(-1).expected, 'a0\nX');
    assert.equal(ctx.disk.get(A), 'a0\nXZY');
    assert.deepEqual(ctx.calls.confirms, []);
  } finally { ctx.destroy(); }
});

function holdSaves(ctx) {
  const realSave = ctx.window.api.saveFileForPanel;
  const pending = [];
  ctx.window.api.saveFileForPanel = (p, content, expected) => new Promise((resolve) => {
    pending.push((outcome) => resolve(outcome || realSave(p, content, expected)));
  });
  return { pending, release: () => { ctx.window.api.saveFileForPanel = realSave; } };
}

function pressSave(ctx) {
  ctx.window.document.getElementById('file-panel-viewer').dispatchEvent(new ctx.window.CustomEvent('cm-save'));
}

async function sameFileInTwoSessions(ctx) {
  ctx.disk.set(A, 'a0\n');
  ctx.disk.set(B, 'b0\n');
  ctx.window.switchPanel('s2');
  ctx.calls.openFile('s2', { filePath: A, content: 'a0\n' });
  await flush();
  ctx.window.switchPanel('s1');
  ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
  await flush();
  const held = holdSaves(ctx);
  ctx.editor().type('X');
  pressSave(ctx);
  await flush();
  ctx.window.switchPanel('s3');
  ctx.calls.openFile('s3', { filePath: B, content: 'b0\n' });
  await flush();
  return held;
}

test("a save finishing while away belongs to the tab that made it, not to another session's tab on the same file (success)", async () => {
  const ctx = setup();
  try {
    const held = await sameFileInTwoSessions(ctx);
    held.pending[0]();
    await flush();
    held.release();
    assert.equal(ctx.disk.get(A), 'a0\nX');

    ctx.window.switchPanel('s2');
    await flush();
    assert.equal(content(ctx), 'a0\nX', "s2's clean tab reloads s1's write rather than taking s1's base");
    ctx.editor().type('Q');
    await save(ctx);
    assert.equal(ctx.disk.get(A), 'a0\nXQ', "s1's X survives");

    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(noticeOf(ctx), null);
  } finally { ctx.destroy(); }
});

test("a save failing while away is reported to the tab that made it, and to no other (failure)", async () => {
  const ctx = setup();
  try {
    const held = await sameFileInTwoSessions(ctx);
    held.pending[0]({ ok: false, error: 'disk full' });
    await flush();
    held.release();

    ctx.window.switchPanel('s2');
    await flush();
    assert.equal(noticeOf(ctx), null, 's2 did not save anything');
    assert.equal(content(ctx), 'a0\n');

    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(noticeOf(ctx), 'Save failed: disk full');
    assert.equal(content(ctx), 'a0\nX');
  } finally { ctx.destroy(); }
});

async function saveAwayAndBack(ctx) {
  ctx.disk.set(A, 'a0\n');
  ctx.disk.set(B, 'b0\n');
  ctx.window.switchPanel('s1');
  ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
  await flush();
  const held = holdSaves(ctx);
  ctx.editor().type('X');
  pressSave(ctx);
  await flush();
  ctx.editor().type('Z');
  ctx.window.switchPanel('s2');
  ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
  await flush();
  ctx.window.switchPanel('s1');
  await flush();
  return held;
}

test('a save that fails after its tab came back shows the failure', async () => {
  const ctx = setup();
  try {
    const held = await saveAwayAndBack(ctx);
    held.pending[0]({ ok: false, error: 'disk full' });
    await flush();
    held.release();
    assert.equal(noticeOf(ctx), 'Save failed: disk full');
  } finally { ctx.destroy(); }
});

test('a save that succeeds after its tab came back moves the base, with no false change reported', async () => {
  const ctx = setup();
  try {
    const held = await saveAwayAndBack(ctx);
    held.pending[0]();
    await flush();
    held.release();
    assert.equal(ctx.disk.get(A), 'a0\nX');
    assert.equal(noticeOf(ctx), null);
    await save(ctx);
    assert.equal(ctx.calls.saves.at(-1).expected, 'a0\nX');
    assert.equal(ctx.disk.get(A), 'a0\nXZ');
    assert.deepEqual(ctx.calls.confirms, []);
  } finally { ctx.destroy(); }
});

test('a save whose IPC rejects while its tab is away is reported when the tab returns', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.disk.set(B, 'b0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    const realSave = ctx.window.api.saveFileForPanel;
    let fail;
    ctx.window.api.saveFileForPanel = () => new Promise((_resolve, reject) => { fail = () => reject(new Error('the channel is gone')); });
    ctx.editor().type('X');
    pressSave(ctx);
    await flush();
    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    fail();
    await flush();
    ctx.window.api.saveFileForPanel = realSave;
    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(noticeOf(ctx), 'Save failed: the channel is gone');
  } finally { ctx.destroy(); }
});

test('a save whose IPC rejects after its tab came back shows the failure', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.disk.set(B, 'b0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    const realSave = ctx.window.api.saveFileForPanel;
    let fail;
    ctx.window.api.saveFileForPanel = () => new Promise((_resolve, reject) => { fail = () => reject(new Error('the channel is gone')); });
    ctx.editor().type('X');
    pressSave(ctx);
    await flush();
    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    ctx.window.switchPanel('s1');
    await flush();
    fail();
    await flush();
    ctx.window.api.saveFileForPanel = realSave;
    assert.equal(noticeOf(ctx), 'Save failed: the channel is gone');
  } finally { ctx.destroy(); }
});

test('re-rendering the shown tab keeps its notice', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    const realSave = ctx.window.api.saveFileForPanel;
    ctx.window.api.saveFileForPanel = () => Promise.resolve({ ok: false, error: 'disk full' });
    ctx.editor().type('X');
    await save(ctx);
    ctx.window.api.saveFileForPanel = realSave;
    assert.equal(noticeOf(ctx), 'Save failed: disk full');
    ctx.window.renderPanel('s1');
    await flush();
    assert.equal(noticeOf(ctx), 'Save failed: disk full');
  } finally { ctx.destroy(); }
});

test('a late save result is applied once: a second trip away and back does not re-apply it', async () => {
  const ctx = setup();
  try {
    await saveThenSwitchAway(ctx, null);
    assert.equal(ctx.disk.get(A), 'a0\nX');
    ctx.editor().type('Y');
    await save(ctx);
    assert.equal(ctx.disk.get(A), 'a0\nXY');

    ctx.editor().type('Z');
    ctx.window.switchPanel('s2');
    await flush();
    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(noticeOf(ctx), null, 'no false change on disk');
    await save(ctx);
    assert.equal(ctx.calls.saves.at(-1).expected, 'a0\nXY', 'the base is the last save, not the consumed record');
    assert.equal(ctx.disk.get(A), 'a0\nXYZ');
    assert.deepEqual(ctx.calls.confirms, []);
  } finally { ctx.destroy(); }
});

// An MCP open aimed at a session's file tab (#364) — see .ai/contexts/viewer-panel.md ("An open aimed at a file tab").

const C = '/repo/c.md';

async function dirtyTabAway(ctx) {
  ctx.disk.set(A, 'a0\n');
  ctx.disk.set(B, 'b0\n');
  ctx.disk.set(C, 'c0\n');
  ctx.window.switchPanel('s1');
  ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
  await flush();
  ctx.editor().type('mine');
  ctx.window.switchPanel('s2');
  ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
  await flush();
}

async function dirtyTabShown(ctx) {
  ctx.disk.set(A, 'a0\n');
  ctx.disk.set(C, 'c0\n');
  ctx.window.switchPanel('s1');
  ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
  await flush();
  ctx.editor().type('mine');
}

const heldBar = (ctx) => {
  const el = ctx.window.document.getElementById('file-panel-held');
  return el.style.display === 'none' ? null : [...el.querySelectorAll('button')].map((b) => b.textContent);
};

const panelOpen = (ctx) => ctx.window.document.getElementById('file-panel').classList.contains('open');

const closeButton = (ctx) => ctx.window.document.querySelector('#file-panel-viewer .fp-close-btn');

test('another file opened over a dirty tab that is away holds the tab, with no question (the issue)', async () => {
  const ctx = setup();
  try {
    await dirtyTabAway(ctx);
    ctx.calls.openFile('s1', { filePath: C, content: 'c0\n' });
    await flush();
    assert.equal(content(ctx), 'b0\n', 'the shown tab of s2 is untouched');

    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(ctx.viewer().filePath, C);
    assert.deepEqual(heldBar(ctx), ['a.md']);

    ctx.window.document.querySelector('#file-panel-held button').click();
    await flush();
    assert.equal(ctx.viewer().filePath, A);
    assert.equal(content(ctx), 'a0\nmine');
    assert.equal(heldBar(ctx), null, 'the clean c.md is not held');
    await save(ctx);
    assert.deepEqual(ctx.calls.saves.at(-1), { path: A, content: 'a0\nmine', expected: 'a0\n' });
    assert.deepEqual(ctx.calls.confirms, []);
  } finally { ctx.destroy(); }
});

test('another file opened over the dirty tab the viewer shows holds it, and opening its file again brings the edits back', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.calls.openFile('s1', { filePath: C, content: 'c0\n' });
    await flush();
    assert.equal(ctx.viewer().filePath, C);
    assert.equal(content(ctx), 'c0\n');
    assert.deepEqual(heldBar(ctx), ['a.md']);

    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    assert.equal(content(ctx), 'a0\nmine');
    assert.equal(heldBar(ctx), null);
    assert.deepEqual(ctx.calls.confirms, []);
  } finally { ctx.destroy(); }
});

test('five opens in a row over dirty tabs raise no modal and hold every dirty tab', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.disk.set(B, 'b0\n');
    ctx.calls.openFile('s1', { filePath: B, content: 'b0\n' });
    await flush();
    ctx.editor().type('theirs');
    for (const name of ['c', 'd', 'e', 'f']) {
      ctx.disk.set(`/repo/${name}.md`, `${name}0\n`);
      ctx.calls.openFile('s1', { filePath: `/repo/${name}.md`, content: `${name}0\n` });
    }
    await flush();
    assert.deepEqual(ctx.calls.confirms, []);
    assert.equal(ctx.viewer().filePath, '/repo/f.md');
    assert.deepEqual(heldBar(ctx), ['a.md', 'b.md']);

    ctx.calls.openFile('s1', { filePath: B, content: 'b0\n' });
    await flush();
    assert.equal(content(ctx), 'b0\ntheirs');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    assert.equal(content(ctx), 'a0\nmine');
  } finally { ctx.destroy(); }
});

test('a diff opened over the dirty tab the viewer shows holds it, and it comes back intact once the session closes the diff', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.calls.openDiff('s1', 'd1', { oldFilePath: C, oldContent: 'c0\n', newContent: 'c1\n', tabName: 'c.md' });
    await flush();
    assert.equal(ctx.window.document.getElementById('file-panel-diff').style.display, 'flex');
    assert.deepEqual(ctx.calls.confirms, []);
    assert.equal(ctx.window.document.getElementById('file-panel-held').style.display, 'none', 'no way out of an unanswered diff');

    ctx.calls.closeTab('s1', 'd1');
    await flush();
    assert.ok(panelOpen(ctx));
    assert.equal(ctx.window.document.getElementById('file-panel-viewer').style.display, 'flex');
    assert.equal(ctx.viewer().filePath, A);
    assert.equal(content(ctx), 'a0\nmine');
    assert.equal(noticeOf(ctx), null);
    await save(ctx);
    assert.deepEqual(ctx.calls.saves.at(-1), { path: A, content: 'a0\nmine', expected: 'a0\n' });
  } finally { ctx.destroy(); }
});

test('a diff of the same file, accepted and written by the session, gives back the edits with the change reported', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.calls.openDiff('s1', 'd1', { oldFilePath: A, oldContent: 'a0\n', newContent: 'a1\n', tabName: 'a.md' });
    await flush();
    ctx.window.document.querySelector('.file-panel-accept-btn').click();
    assert.deepEqual(ctx.calls.diffResponses, [{ sessionId: 's1', diffId: 'd1', action: 'accept' }]);
    ctx.disk.set(A, 'a1\n');
    ctx.calls.closeTab('s1', 'd1');
    await flush();
    assert.equal(content(ctx), 'a0\nmine');
    assert.match(noticeOf(ctx), /changed on disk/);
    await save(ctx);
    assert.equal(ctx.disk.get(A), 'a1\n', "the session's write is not replaced without agreement");
    assert.equal(ctx.calls.confirms.length, 1, 'the refused save asks, on the user\'s own Save');
  } finally { ctx.destroy(); }
});

test('closing all diffs gives back a held tab too', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.calls.openDiff('s1', 'd1', { oldFilePath: C, oldContent: 'c0\n', newContent: 'c1\n', tabName: 'c.md' });
    await flush();
    ctx.calls.closeAllDiffs('s1');
    await flush();
    assert.equal(content(ctx), 'a0\nmine');
  } finally { ctx.destroy(); }
});

test('a diff over a clean tab holds nothing: closing the diff closes the panel as before', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    ctx.calls.openDiff('s1', 'd1', { oldFilePath: C, oldContent: 'c0\n', newContent: 'c1\n', tabName: 'c.md' });
    await flush();
    ctx.calls.closeTab('s1', 'd1');
    await flush();
    assert.equal(panelOpen(ctx), false);
  } finally { ctx.destroy(); }
});

test('a save that fails while a diff holds its tab is reported when the tab comes back', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    const held = holdSaves(ctx);
    pressSave(ctx);
    await flush();
    ctx.calls.openDiff('s1', 'd1', { oldFilePath: C, oldContent: 'c0\n', newContent: 'c1\n', tabName: 'c.md' });
    await flush();
    held.pending[0]({ ok: false, error: 'disk full' });
    await flush();
    held.release();
    ctx.calls.closeTab('s1', 'd1');
    await flush();
    assert.equal(content(ctx), 'a0\nmine');
    assert.equal(noticeOf(ctx), 'Save failed: disk full');
  } finally { ctx.destroy(); }
});

test('a path link to a changed file opens Changes over a dirty tab, which comes back when Changes is closed', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.calls.changed.add(C);
    await ctx.window.openFileInPanel('s1', C);
    await flush();
    assert.equal(ctx.window.document.getElementById('file-panel-changes').style.display, 'flex');
    assert.deepEqual(ctx.calls.confirms, []);

    ctx.window.toggleChangesTab('s1');
    await flush();
    assert.equal(ctx.viewer().filePath, A);
    assert.equal(content(ctx), 'a0\nmine');
  } finally { ctx.destroy(); }
});

test('the close button on a dirty file tab asks, and a no keeps the tab', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    closeButton(ctx).click();
    await flush();
    assert.deepEqual(ctx.calls.confirms, ['This file has unsaved edits. Discard them?']);
    assert.ok(panelOpen(ctx));
    assert.equal(content(ctx), 'a0\nmine');
  } finally { ctx.destroy(); }
});

test('closing the shown tab shows the tab held under it', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.calls.openFile('s1', { filePath: C, content: 'c0\n' });
    await flush();
    closeButton(ctx).click();
    await flush();
    assert.deepEqual(ctx.calls.confirms, [], 'the clean c.md closes without asking');
    assert.equal(ctx.viewer().filePath, A);
    assert.equal(content(ctx), 'a0\nmine');
  } finally { ctx.destroy(); }
});

test('on Windows the same file spelt with another case or separators is the same tab', async () => {
  const ctx = setup();
  try {
    ctx.window.api.platform = 'win32';
    const WIN = 'C:\\repo\\A.md';
    ctx.disk.set(WIN, 'a0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: WIN, content: 'a0\n' });
    await flush();
    ctx.editor().type('mine');
    ctx.calls.openFile('s1', { filePath: 'c:/repo/a.md', content: 'a0\n' });
    await flush();
    assert.equal(ctx.viewer().filePath, WIN);
    assert.equal(content(ctx), 'a0\nmine');
    assert.equal(heldBar(ctx), null);
  } finally { ctx.destroy(); }
});

test('on Linux a path that differs only by case is another file', async () => {
  const ctx = setup();
  try {
    ctx.window.api.platform = 'linux';
    await dirtyTabShown(ctx);
    ctx.calls.openFile('s1', { filePath: '/repo/A.md', content: 'A\n' });
    await flush();
    assert.equal(ctx.viewer().filePath, '/repo/A.md');
    assert.deepEqual(heldBar(ctx), ['a.md']);
  } finally { ctx.destroy(); }
});

test('another file opened over a clean tab replaces it without holding it, shown or away', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.disk.set(B, 'b0\n');
    ctx.disk.set(C, 'c0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    ctx.calls.openFile('s1', { filePath: C, content: 'c0\n' });
    await flush();
    assert.equal(content(ctx), 'c0\n');

    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(content(ctx), 'a0\n');
    assert.deepEqual(ctx.calls.confirms, []);
    assert.equal(heldBar(ctx), null);
  } finally { ctx.destroy(); }
});

test('a tab whose save succeeded while away is not dirty: another file replaces it without holding it', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.disk.set(B, 'b0\n');
    ctx.disk.set(C, 'c0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    const held = holdSaves(ctx);
    ctx.editor().type('X');
    pressSave(ctx);
    await flush();
    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    held.pending[0]();
    await flush();
    held.release();
    assert.equal(ctx.disk.get(A), 'a0\nX');

    ctx.calls.openFile('s1', { filePath: C, content: 'c0\n' });
    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(heldBar(ctx), null);
    assert.equal(content(ctx), 'c0\n');
  } finally { ctx.destroy(); }
});

test('the same file opened over the dirty tab the viewer shows keeps the edits and reports the session write', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.disk.set(A, 'session\n');
    ctx.calls.openFile('s1', { filePath: A, content: 'session\n' });
    await flush();
    assert.deepEqual(ctx.calls.confirms, []);
    assert.equal(content(ctx), 'a0\nmine');
    assert.match(noticeOf(ctx), /changed on disk/);

    await save(ctx);
    assert.equal(ctx.disk.get(A), 'session\n', 'the session write is not replaced without agreement');
    assert.equal(ctx.calls.confirms.length, 1);
  } finally { ctx.destroy(); }
});

test('the same file opened over the clean tab the viewer shows reloads it and moves the base', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    ctx.disk.set(A, 'session\n');
    ctx.calls.openFile('s1', { filePath: A, content: 'session\n' });
    await flush();
    assert.equal(content(ctx), 'session\n');
    assert.equal(noticeOf(ctx), null);
    ctx.editor().type('Y');
    await save(ctx);
    assert.deepEqual(ctx.calls.saves.at(-1), { path: A, content: 'session\nY', expected: 'session\n' });
  } finally { ctx.destroy(); }
});

test('the same file opened over the dirty tab while it is away keeps the edits and reports the session write on return', async () => {
  const ctx = setup();
  try {
    await dirtyTabAway(ctx);
    ctx.disk.set(A, 'session\n');
    ctx.calls.openFile('s1', { filePath: A, content: 'session\n' });
    ctx.window.switchPanel('s1');
    await flush();
    assert.deepEqual(ctx.calls.confirms, []);
    assert.equal(content(ctx), 'a0\nmine');
    assert.match(noticeOf(ctx), /changed on disk/);
  } finally { ctx.destroy(); }
});

test('the same file opened over a tab whose save failed while away keeps the failure to report', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.disk.set(B, 'b0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    const held = holdSaves(ctx);
    ctx.editor().type('X');
    pressSave(ctx);
    await flush();
    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    held.pending[0]({ ok: false, error: 'disk full' });
    await flush();
    held.release();

    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(content(ctx), 'a0\nX');
    assert.equal(noticeOf(ctx), 'Save failed: disk full');
  } finally { ctx.destroy(); }
});

test('the same file opened over a clean tab while it is away shows the file as the session left it', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.disk.set(B, 'b0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    await flush();
    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    ctx.disk.set(A, 'session\n');
    ctx.calls.openFile('s1', { filePath: A, content: 'session\n' });
    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(content(ctx), 'session\n');
    assert.equal(noticeOf(ctx), null);
    assert.deepEqual(ctx.calls.confirms, []);
  } finally { ctx.destroy(); }
});

test('the same file opened again before its tab ever reached the viewer shows the content last sent', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(B, 'b0\n');
    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: B, content: 'b0\n' });
    await flush();
    ctx.calls.openFile('s1', { filePath: A, content: 'a0\n' });
    ctx.disk.set(A, 'session\n');
    ctx.calls.openFile('s1', { filePath: A, content: 'session\n' });
    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(content(ctx), 'session\n');
    ctx.editor().type('Y');
    await save(ctx);
    assert.deepEqual(ctx.calls.saves.at(-1), { path: A, content: 'session\nY', expected: 'session\n' });
  } finally { ctx.destroy(); }
});

test('the same file opened with a line over the shown tab scrolls to it', async () => {
  const ctx = setup();
  try {
    await dirtyTabShown(ctx);
    ctx.window.openFileTab('s1', { filePath: A, content: 'a0\n', line: 3 });
    await flush();
    assert.deepEqual(ctx.calls.revealed, [3]);
    assert.equal(content(ctx), 'a0\nmine');
  } finally { ctx.destroy(); }
});

test("an open in one session leaves another session's dirty tab on the same file alone", async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'a0\n');
    ctx.window.switchPanel('s2');
    ctx.calls.openFile('s2', { filePath: A, content: 'a0\n' });
    await flush();
    ctx.editor().type('mine');

    ctx.disk.set(A, 'session\n');
    ctx.calls.openFile('s1', { filePath: A, content: 'session\n' });
    await flush();
    assert.deepEqual(ctx.calls.confirms, []);
    assert.equal(content(ctx), 'a0\nmine');
    assert.equal(noticeOf(ctx), null);

    ctx.window.switchPanel('s1');
    await flush();
    assert.equal(content(ctx), 'session\n');
    ctx.window.switchPanel('s2');
    await flush();
    assert.equal(content(ctx), 'a0\nmine');
  } finally { ctx.destroy(); }
});
