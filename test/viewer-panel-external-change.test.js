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
  const state = { disk, fileChanged: null, confirms: [], confirmAnswer: true, saves: [], saveImpl: null, readImpl: null };

  window.api = {
    onFileChanged: (cb) => { state.fileChanged = cb; },
    watchFile: () => {},
    unwatchFile: () => {},
    readFileForPanel: async (p) => (state.readImpl ? state.readImpl(p) : state.disk === null
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
  const panel = new window.ViewerPanel(container, {
    onSave: async (filePath, content, expected) => {
      state.saves.push({ filePath, content, expected });
      if (state.saveImpl) return state.saveImpl(filePath, content, expected);
      state.disk = content;
      return { ok: true };
    },
  });

  return {
    window,
    state,
    panel,
    editor: () => editor,
    notice: () => container.querySelector('.viewer-panel-notice'),
    async open(content, file = FILE) {
      panel.open('note', file, content);
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

const tick = () => new Promise((r) => setTimeout(r, 0));
const noticeText = (t) => t.notice().querySelector('.viewer-panel-notice-text').textContent;
const button = (t, name) => t.notice().querySelector(`.viewer-panel-notice-${name}`);

test('an external write that lands just after our save is reloaded, not dropped', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.panel._save();
    await t.externalWrite('written by the session\n');
    assert.equal(t.panel.getContent(), 'written by the session\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test("our own save's echo, arriving while the save is in flight, raises no notice", async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    let finish;
    t.state.saveImpl = (fp, content) => new Promise((resolve) => { t.state.disk = content; finish = () => resolve({ ok: true }); });
    const saving = t.panel._save();
    t.editor().type(' and more');
    t.state.fileChanged(FILE);
    await tick();
    assert.equal(visible(t.notice()), false, 'the echo of our own write is not an external change');
    finish();
    await saving;
    assert.equal(t.panel.getContent(), 'one\nmine and more');
  } finally { t.destroy(); }
});

test('a save sends the disk baseline, so main can refuse a stale write', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.panel._save();
    assert.deepEqual(t.state.saves.map((x) => x.expected), ['one\n']);
  } finally { t.destroy(); }
});

test('a stale refusal keeps the edits and offers Reload and Overwrite; Overwrite saves without a baseline', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    t.state.saveImpl = (fp, content, expected) => (expected === null
      ? (t.state.disk = content, { ok: true })
      : { ok: false, reason: 'stale', error: 'this file changed on disk since it was opened' });
    await t.panel._save();
    assert.equal(t.panel.getContent(), 'one\nmine');
    assert.equal(visible(t.notice()), true);
    assert.match(noticeText(t), /changed on disk since you opened it — your edits were not saved/);
    assert.equal(visible(button(t, 'reload')), true);
    assert.equal(visible(button(t, 'overwrite')), true);
    assert.equal(visible(button(t, 'keep')), false);

    t.state.confirmAnswer = false;
    button(t, 'overwrite').click();
    await tick();
    assert.equal(t.state.saves.length, 1, 'a refused confirm writes nothing');

    t.state.confirmAnswer = true;
    button(t, 'overwrite').click();
    await tick();
    assert.equal(t.state.saves.length, 2);
    assert.equal(t.state.saves[1].expected, null);
    assert.equal(t.state.confirms.at(-1), 'Overwrite the file on disk with your edits?');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('a failed save says so in the notice', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    t.state.saveImpl = () => ({ ok: false, error: 'file does not exist' });
    await t.panel._save();
    assert.equal(visible(t.notice()), true);
    assert.equal(noticeText(t), 'Save failed: file does not exist');
  } finally { t.destroy(); }
});

test('a touch or a same-content write on a dirty buffer raises no notice', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    await t.externalWrite('one\n');
    assert.equal(visible(t.notice()), false);
    assert.equal(t.panel.getContent(), 'one\nmine');
  } finally { t.destroy(); }
});

test('a re-read of the previous file that resolves after another open leaves the new buffer alone', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    let resolveA;
    t.state.readImpl = () => new Promise((resolve) => { resolveA = resolve; });
    t.state.fileChanged(FILE);
    await tick();
    const other = '/home/u/.claude/projects/p/memory/other.md';
    await t.open('other file\n', other);
    resolveA({ ok: true, content: 'A changed on disk\n' });
    await tick();
    assert.equal(t.panel.getContent(), 'other file\n');
    assert.equal(visible(t.notice()), false);
  } finally { t.destroy(); }
});

test('the watch event that follows a stale refusal leaves the "not saved" notice and its Overwrite in place', async () => {
  const t = setup({ disk: 'one\n' });
  try {
    await t.open('one\n');
    t.editor().type('mine');
    t.state.disk = 'unseen external write\n';
    t.state.saveImpl = (fp, content, expected) => (expected === t.state.disk
      ? { ok: true }
      : { ok: false, reason: 'stale', error: 'this file changed on disk since it was opened' });
    await t.panel._save();
    t.state.fileChanged(FILE);
    await tick();
    assert.match(noticeText(t), /your edits were not saved/);
    assert.equal(visible(button(t, 'overwrite')), true);
    assert.equal(t.panel.getContent(), 'one\nmine');
  } finally { t.destroy(); }
});
