'use strict';

// Undo in a ViewerPanel must only step through the user's own edits. Content
// the panel puts in the editor itself — the file it opens, a quiet reload of a
// clean buffer — is not an edit to undo: undoing a reload would bring back
// content the disk no longer holds, and the next save would revert the file.
// Driven against the real CodeMirror, loaded from codemirror-setup.js as
// test/codemirror-merge-editing.test.js does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { JSDOM, VirtualConsole } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FILE = '/home/u/.claude/projects/p/memory/note.md';

let loaded = null;

async function load() {
  if (loaded) return loaded;
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!DOCTYPE html><head></head><body><div id="c"></div></body>', {
    url: 'http://localhost/', pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  window.Element.prototype.getClientRects = () => [];

  global.window = window;
  global.document = window.document;
  global.localStorage = window.localStorage;
  Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
  for (const name of ['CustomEvent', 'Event', 'KeyboardEvent', 'HTMLElement', 'Element', 'Node', 'Text',
    'MutationObserver', 'DOMParser', 'Range', 'getComputedStyle']) {
    global[name] = window[name];
  }
  global.Window = window.constructor;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

  await import(pathToFileURL(path.join(PUBLIC_DIR, 'codemirror-setup.js')).href);

  const state = { disk: 'A\n', fileChanged: null };
  window.api = {
    onFileChanged: (cb) => { state.fileChanged = cb; },
    watchFile: () => Promise.resolve({ ok: true }),
    unwatchFile: () => Promise.resolve({ ok: true }),
    readFileForPanel: () => Promise.resolve({ ok: true, content: state.disk }),
  };
  for (const f of ['viewer-toolbar.js', 'viewer-panel.js']) {
    const file = path.join(PUBLIC_DIR, f);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  global.loadCodeMirrorBundle = () => Promise.resolve();
  loaded = { window, state };
  return loaded;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function pressUndo(window, view) {
  view.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true,
  }));
}

async function openPanel() {
  const { window, state } = await load();
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const panel = new window.ViewerPanel(container, { onSave: async () => ({ ok: true }) });
  state.disk = 'A\n';
  panel.open('note', FILE, 'A\n');
  await tick();
  return { window, state, panel, container };
}

test('undo right after open does not empty the file', async () => {
  const { window, panel, container } = await openPanel();
  try {
    pressUndo(window, panel.editorView);
    assert.equal(panel.getContent(), 'A\n');
  } finally { panel.destroy(); container.remove(); }
});

test('undo after a quiet reload does not bring back the content the disk no longer holds', async () => {
  const { window, state, panel, container } = await openPanel();
  try {
    state.disk = 'D\n';
    state.fileChanged(FILE);
    await tick();
    assert.equal(panel.getContent(), 'D\n', 'the clean buffer was reloaded');
    pressUndo(window, panel.editorView);
    assert.equal(panel.getContent(), 'D\n', 'undo has nothing of the user\'s to revert');
  } finally { panel.destroy(); container.remove(); }
});

test("undo still reverts the user's own edit", async () => {
  const { window, panel, container } = await openPanel();
  try {
    const view = panel.editorView;
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'typed' }, userEvent: 'input.type' });
    assert.equal(panel.getContent(), 'A\ntyped');
    pressUndo(window, view);
    assert.equal(panel.getContent(), 'A\n');
  } finally { panel.destroy(); container.remove(); }
});

test('undo after opening another file in the same panel does not bring back the previous file', async () => {
  const { window, panel, container } = await openPanel();
  try {
    panel.open('other', '/home/u/.claude/projects/p/memory/other.md', 'B\n');
    await tick();
    assert.equal(panel.getContent(), 'B\n');
    pressUndo(window, panel.editorView);
    assert.equal(panel.getContent(), 'B\n');
  } finally { panel.destroy(); container.remove(); }
});
