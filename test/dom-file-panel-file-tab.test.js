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
  const calls = { saves: [], openFile: null, confirms: [] };
  let editor = null;

  window.api = new Proxy({
    onMcpOpenFile: (cb) => { calls.openFile = cb; },
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
  window.confirm = (msg) => { calls.confirms.push(msg); return false; };
  window.createEditableViewer = (parent, content) => { editor = fakeEditor(content); return editor; };
  window.createPlanEditor = () => { editor = fakeEditor(''); return editor; };
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  const realCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreate(tag, ...args);
    if (String(tag).toLowerCase() === 'script') Promise.resolve().then(() => el.onload && el.onload());
    return el;
  };

  for (const f of ['viewer-toolbar.js', 'viewer-panel.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'header-controls.js', 'file-panel.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: f });
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
