'use strict';

// The editing surface of the Changes panel is a real CodeMirror merge view, so
// these tests drive the real one: public/codemirror-setup.js is imported as the
// ES module it is, under jsdom, and the assertions are about what a keystroke
// does to it — not about a stub that always answers correctly.
//
// jsdom has no layout, so CodeMirror's measuring phase throws inside its own
// requestAnimationFrame callbacks; the stubs below give it enough of a Range to
// stay quiet, and the jsdom virtual console swallows the rest. None of that
// touches the keymap, the history or the document, which is what is asserted.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM, VirtualConsole } = require('jsdom');

const SETUP = path.join(__dirname, '..', 'public', 'codemirror-setup.js');

let cmWindow = null;

async function loadCodeMirror() {
  if (cmWindow) return cmWindow;

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true, virtualConsole });
  const { window } = dom;

  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  window.Element.prototype.getClientRects = () => [];

  global.window = window;
  global.document = window.document;
  Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
  for (const name of ['CustomEvent', 'Event', 'KeyboardEvent', 'HTMLElement', 'Element', 'Node', 'Text',
    'MutationObserver', 'DOMParser', 'Range', 'getComputedStyle']) {
    global[name] = window[name];
  }
  global.Window = window.constructor;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

  await import(pathToFileURL(SETUP).href);
  cmWindow = window;
  return window;
}

function pressCtrlS(window, element) {
  element.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true, cancelable: true,
  }));
}

test('real CodeMirror: Ctrl/Cmd+S in the side-by-side editing pane raises exactly one cm-save, and it bubbles to the panel container', async () => {
  const window = await loadCodeMirror();
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const host = window.document.createElement('div');
  container.appendChild(host);

  const view = window.createMergeViewer(host, 'old\n', 'new\n', 'a.js');
  try {
    let saves = 0;
    container.addEventListener('cm-save', () => { saves++; });

    pressCtrlS(window, view.b.contentDOM);
    assert.equal(saves, 1, 'the default editing mode must answer the documented keybinding, exactly once');

    pressCtrlS(window, view.b.contentDOM);
    assert.equal(saves, 2);
  } finally {
    view.destroy();
    container.remove();
  }
});

test('real CodeMirror: the side-by-side editing pane is editable and has undo', async () => {
  const window = await loadCodeMirror();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);

  const view = window.createMergeViewer(host, 'old\n', 'new\n', 'a.js');
  try {
    assert.equal(view.b.state.readOnly, false, 'the working-tree side is the one you type in');
    assert.equal(view.a.state.readOnly, true, 'the original side is not');

    view.b.dispatch({ changes: { from: 0, insert: 'typed ' } });
    assert.equal(view.b.state.doc.toString(), 'typed new\n');

    const { undo } = require('@codemirror/commands');
    assert.equal(undo(view.b), true, 'undo needs the history extension to be installed');
    assert.equal(view.b.state.doc.toString(), 'new\n');
  } finally {
    view.destroy();
    host.remove();
  }
});

test('real CodeMirror: the inline merge view drops the accept/reject chunk controls when asked', async () => {
  const window = await loadCodeMirror();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);

  const withControls = window.createUnifiedMergeViewer(host, 'old\n', 'new\n', 'a.js');
  const withControlsHtml = host.innerHTML;
  withControls.destroy();
  host.innerHTML = '';

  const without = window.createUnifiedMergeViewer(host, 'old\n', 'new\n', 'a.js', { mergeControls: false });
  try {
    assert.match(withControlsHtml, /cm-chunkButtons|Accept|Reject/,
      'the default carries the chunk controls, which is what the Changes panel opts out of');
    assert.doesNotMatch(host.innerHTML, /cm-chunkButtons/);
    assert.doesNotMatch(host.innerHTML, /Reject/);
  } finally {
    without.destroy();
    host.remove();
  }
});

test('real CodeMirror: Ctrl/Cmd+S also raises cm-save in the inline and plain editing modes', async () => {
  const window = await loadCodeMirror();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);

  const inline = window.createUnifiedMergeViewer(host, 'old\n', 'new\n', 'a.js', { mergeControls: false });
  try {
    let saves = 0;
    host.addEventListener('cm-save', () => { saves++; });
    pressCtrlS(window, inline.contentDOM);
    assert.ok(saves >= 1, 'inline mode saves too');
  } finally {
    inline.destroy();
  }

  const plain = window.createEditableViewer(host, 'new\n', 'a.js');
  try {
    let saves = 0;
    host.addEventListener('cm-save', () => { saves++; });
    pressCtrlS(window, plain.contentDOM);
    assert.ok(saves >= 1, 'plain mode saves too');
  } finally {
    plain.destroy();
    host.remove();
  }
});
