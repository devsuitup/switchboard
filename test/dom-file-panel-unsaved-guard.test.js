'use strict';

// Quitting, reloading or closing a session with unsaved file edits asks first (#373):
// the Touched editor in the slot, and Touched edits stashed while something else shows.

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
  const calls = { openFile: null, check: null, acks: [], answers: [], saves: [], confirms: [] };
  let editor = null;

  window.api = new Proxy({
    onMcpOpenFile: (cb) => { calls.openFile = cb; },
    onUnsavedCheck: (cb) => { calls.check = cb; },
    unsavedCheckAck: (id) => { calls.acks.push({ id, at: calls.answers.length, dialog: !!window.document.getElementById('unsaved-edits-dialog') }); },
    unsavedCheckResult: (id, proceed) => { calls.answers.push({ id, proceed }); },
    watchFile: () => Promise.resolve({ ok: true }),
    unwatchFile: () => Promise.resolve({ ok: true }),
    readFileForPanel: (p) => Promise.resolve(disk.has(p) ? { ok: true, git: false, original: disk.get(p), current: disk.get(p) } : { ok: false, code: 'ENOENT', error: 'ENOENT' }),
    saveFileForPanel: (p, content, expected) => {
      calls.saves.push({ path: p, content, expected });
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
  window.createEditableViewer = (parent, content) => {
    editor = fakeEditor(content);
    editor.dom = window.document.createElement('div');
    parent.appendChild(editor.dom);
    return editor;
  };
  window.createPlanEditor = () => { editor = fakeEditor(''); return editor; };
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  const realCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreate(tag, ...args);
    if (String(tag).toLowerCase() === 'script') Promise.resolve().then(() => el.onload && el.onload());
    return el;
  };

  for (const f of ['viewer-toolbar.js', 'viewer-panel.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'header-controls.js', 'file-panel.js', 'touched-files-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: path.join(PUBLIC_DIR, f) });
  }
  window.initFilePanel();
  return { window, disk, calls, editor: () => editor, destroy: () => window.close() };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const A = '/repo/a.md';
const B = '/repo/b.md';
const C = '/repo/c.md';

async function dirtyTab(ctx, sessionId, file, text = 'mine') {
  ctx.disk.set(file, 'x0\n');
  ctx.window.switchPanel(sessionId);
  ctx.calls.openFile(sessionId, { filePath: file });
  await flush();
  ctx.editor().type(text);
}

const dialog = (ctx) => ctx.window.document.getElementById('unsaved-edits-dialog');
const button = (ctx, id) => ctx.window.document.getElementById(id);

function beforeUnload(ctx) {
  const event = new ctx.window.Event('beforeunload', { cancelable: true });
  ctx.window.dispatchEvent(event);
  return event;
}

test('with nothing unsaved the check is answered at once and no dialog shows', async () => {
  const ctx = setup();
  try {
    ctx.disk.set(A, 'x0\n');
    ctx.window.switchPanel('s1');
    ctx.calls.openFile('s1', { filePath: A });
    await flush();
    ctx.calls.check(1, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 1, proceed: true }]);
    assert.equal(dialog(ctx), null);
    assert.equal(beforeUnload(ctx).defaultPrevented, false);
  } finally { ctx.destroy(); }
});

test('a dirty Touched editor holds the answer behind a dialog naming the file; Cancel answers no', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(7, 'quit');
    await flush();
    assert.ok(dialog(ctx), 'the dialog is shown');
    assert.match(dialog(ctx).textContent, /a\.md/);
    assert.deepEqual(ctx.calls.answers, []);
    button(ctx, 'unsaved-cancel').click();
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 7, proceed: false }]);
    assert.equal(dialog(ctx), null);
    assert.equal(ctx.disk.get(A), 'x0\n');
  } finally { ctx.destroy(); }
});

test('Discard answers yes, writes nothing, and lets the window unload', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    assert.equal(beforeUnload(ctx).defaultPrevented, true, 'a dirty tab blocks an unload nobody approved');
    ctx.calls.check(2, 'reload');
    await flush();
    button(ctx, 'unsaved-discard').click();
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 2, proceed: true }]);
    assert.deepEqual(ctx.calls.saves, []);
    assert.equal(beforeUnload(ctx).defaultPrevented, false, 'the approved unload goes through');
  } finally { ctx.destroy(); }
});

test('Save writes the edits against the agreed base, then answers yes', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(3, 'quit');
    await flush();
    button(ctx, 'unsaved-save').click();
    await flush();
    assert.equal(ctx.disk.get(A), 'x0\nmine');
    assert.deepEqual(ctx.calls.answers, [{ id: 3, proceed: true }]);
  } finally { ctx.destroy(); }
});

test('a save the disk refuses keeps the dialog open and answers nothing', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    ctx.disk.set(A, 'written by someone else\n');
    ctx.calls.check(4, 'quit');
    await flush();
    button(ctx, 'unsaved-save').click();
    await flush();
    assert.ok(dialog(ctx), 'the dialog stays');
    assert.match(dialog(ctx).textContent, /changed on disk/);
    assert.equal(ctx.disk.get(A), 'written by someone else\n');
    assert.deepEqual(ctx.calls.answers, []);
    button(ctx, 'unsaved-cancel').click();
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 4, proceed: false }]);
  } finally { ctx.destroy(); }
});

test('edits stashed in one session and a dirty editor in another both count, and Save writes all of them', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A, 'one');
    ctx.window.openDiffTab('s1', 'd1', { oldFilePath: '/repo/x.md', oldContent: 'a\n', newContent: 'b\n' });
    ctx.disk.set(B, 'x0\n');
    ctx.window.switchPanel('s3');
    ctx.calls.openFile('s3', { filePath: B });
    await flush();
    await dirtyTab(ctx, 's2', C, 'three');

    ctx.calls.check(5, 'quit');
    await flush();
    const text = dialog(ctx).textContent;
    assert.match(text, /a\.md/);
    assert.match(text, /c\.md/);
    assert.doesNotMatch(text, /b\.md/, 'a clean tab is not listed');
    button(ctx, 'unsaved-save').click();
    await flush();
    assert.equal(ctx.disk.get(A), 'x0\none');
    assert.equal(ctx.disk.get(C), 'x0\nthree');
    assert.deepEqual(ctx.calls.answers, [{ id: 5, proceed: true }]);
  } finally { ctx.destroy(); }
});

test('beforeunload blocks while an editor is dirty and lets go once it is saved', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    assert.equal(beforeUnload(ctx).defaultPrevented, true);
    ctx.window.document.getElementById('changes-diff-view').dispatchEvent(new ctx.window.CustomEvent('cm-save'));
    await flush();
    assert.equal(beforeUnload(ctx).defaultPrevented, false);
  } finally { ctx.destroy(); }
});

test('the check is acknowledged on receipt, before any dialog is shown', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(9, 'quit');
    assert.deepEqual(ctx.calls.acks, [{ id: 9, at: 0, dialog: false }]);
    await flush();
    button(ctx, 'unsaved-cancel').click();
    await flush();
  } finally { ctx.destroy(); }
});
