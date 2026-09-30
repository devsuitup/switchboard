'use strict';

// What a ViewerPanel does with its buffer when the file it shows changes on
// disk: a clean buffer is reloaded, a dirty one is kept and the notice says
// so. The CodeMirror bundle is replaced by an editor stub whose document is a
// plain string, since the behaviour under test is the panel's, not the editor's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FILE = '/home/u/.claude/projects/p/memory/note.md';

function fakeEditor() {
  let doc = '';
  const view = {
    dispatches: 0,
    state: { doc: { toString: () => doc, get length() { return doc.length; } } },
    dispatch(tr) {
      if (tr && tr.changes) {
        const { from, to, insert } = tr.changes;
        doc = doc.slice(0, from) + insert + doc.slice(to);
        view.dispatches += 1;
      }
    },
    type(text) { doc += text; },
    destroy() {},
  };
  return view;
}

function setup({ disk }) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="c"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const state = { disk, fileChanged: null, confirms: [], confirmAnswer: true };

  window.api = {
    onFileChanged: (cb) => { state.fileChanged = cb; },
    watchFile: () => {},
    unwatchFile: () => {},
    readFileForPanel: async () => (state.disk === null
      ? { ok: false, error: 'ENOENT: no such file or directory', code: 'ENOENT' }
      : { ok: true, content: state.disk }),
  };
  window.confirm = (msg) => { state.confirms.push(msg); return state.confirmAnswer; };

  const realCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreate(tag, ...args);
    if (tag.toLowerCase() === 'script') Promise.resolve().then(() => el.onload && el.onload());
    return el;
  };

  let editor = null;
  window.createPlanEditor = () => { editor = fakeEditor(); return editor; };

  const ctx = dom.getInternalVMContext();
  for (const f of ['viewer-toolbar.js', 'viewer-panel.js']) {
    const file = path.join(PUBLIC_DIR, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }

  const container = window.document.getElementById('c');
  const panel = new window.ViewerPanel(container, { onSave: async () => ({ ok: true }) });

  return {
    window,
    state,
    panel,
    editor: () => editor,
    notice: () => container.querySelector('.viewer-panel-notice'),
    async open(content) {
      panel.open('note', FILE, content);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
    async externalWrite(content) {
      state.disk = content;
      state.fileChanged(FILE);
      await new Promise((r) => setTimeout(r, 0));
    },
    destroy: () => window.close(),
  };
}

function visible(el) {
  return !!el && el.style.display !== 'none';
}

test('a clean buffer reloads quietly on an external write', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    await t.externalWrite('two\n');
    assert.equal(t.panel.getContent(), 'two\n');
    assert.equal(visible(t.notice()), false, 'no notice for a clean buffer');
  } finally { t.destroy(); }
});

test('a dirty buffer survives an external write, and the notice says the file changed', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('my edit');
    await t.externalWrite('two\n');
    assert.equal(t.panel.getContent(), 'one\nmy edit', 'the edits must not be replaced');
    assert.equal(visible(t.notice()), true);
    assert.match(t.notice().querySelector('.viewer-panel-notice-text').textContent, /changed on disk/);
    assert.equal(visible(t.notice().querySelector('.viewer-panel-notice-reload')), true);
    assert.equal(visible(t.notice().querySelector('.viewer-panel-notice-keep')), true);
  } finally { t.destroy(); }
});

test('Keep my edits hides the notice and leaves the buffer as it is', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite('two\n');
    t.notice().querySelector('.viewer-panel-notice-keep').click();
    assert.equal(visible(t.notice()), false);
    assert.equal(t.panel.getContent(), 'one\nmine');

    await t.externalWrite('three\n');
    assert.equal(t.panel.getContent(), 'one\nmine', 'a kept buffer is still dirty against the disk');
    assert.equal(visible(t.notice()), true);
  } finally { t.destroy(); }
});

test('Reload asks, then replaces the buffer with the file on disk', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite('two\n');

    t.state.confirmAnswer = false;
    t.notice().querySelector('.viewer-panel-notice-reload').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(t.state.confirms, ['This file has unsaved edits. Discard them?']);
    assert.equal(t.panel.getContent(), 'one\nmine', 'a refused confirm keeps the edits');

    t.state.confirmAnswer = true;
    t.notice().querySelector('.viewer-panel-notice-reload').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(t.panel.getContent(), 'two\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('a deleted file keeps a dirty buffer and says the file is gone; a recreate is seen', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite(null);
    assert.equal(t.panel.getContent(), 'one\nmine');
    assert.equal(visible(t.notice()), true);
    assert.match(t.notice().querySelector('.viewer-panel-notice-text').textContent, /no longer exists on disk\. Your unsaved edits are kept/);

    await t.externalWrite('recreated\n');
    assert.equal(t.panel.getContent(), 'one\nmine');
    assert.match(t.notice().querySelector('.viewer-panel-notice-text').textContent, /changed on disk/);
  } finally { t.destroy(); }
});

test('a deleted then recreated file reloads a clean buffer', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    await t.externalWrite(null);
    assert.equal(t.panel.getContent(), 'one\n', 'a clean buffer is not emptied by a delete');
    assert.match(t.notice().querySelector('.viewer-panel-notice-text').textContent, /no longer exists on disk\.$/);

    await t.externalWrite('back\n');
    assert.equal(t.panel.getContent(), 'back\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('a saved buffer is clean again, so the next external write reloads it', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.panel._save();
    t.state.disk = 'one\nmine';
    t.panel._saving = false;
    await t.externalWrite('two\n');
    assert.equal(t.panel.getContent(), 'two\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('a CRLF file is not dirty just because the editor holds it with LF', async () => {
  const t = setup({ disk: 'a\r\nb\r\n' });
  try {
    await t.open('a\r\nb\r\n');
    t.editor().dispatch({ changes: { from: 0, to: t.editor().state.doc.length, insert: 'a\nb\n' } });
    await t.externalWrite('a\r\nc\r\n');
    assert.equal(t.panel.getContent(), 'a\nc\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});
