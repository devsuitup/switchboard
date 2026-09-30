'use strict';

// Until the CodeMirror bundle has loaded, the document open() was given is not
// in the editor. Nothing the toolbar does may act on the empty editor in its
// place: a Save would write '' over the file, a Copy would copy nothing.
// See .ai/contexts/viewer-panel.md ("A document not yet in the editor").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const FILE = '/repo/a.md';

function setup() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="c"></div></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const state = { disk: 'a0\n', saves: [], copied: [], scripts: [] };

  window.api = {
    onFileChanged: () => {},
    watchFile: () => Promise.resolve({ ok: true }),
    unwatchFile: () => Promise.resolve({ ok: true }),
    readFileForPanel: () => Promise.resolve({ ok: true, content: state.disk }),
  };
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: (text) => { state.copied.push(text); return Promise.resolve(); } },
    configurable: true,
  });
  const realCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreate(tag, ...args);
    if (String(tag).toLowerCase() === 'script') state.scripts.push(el);
    return el;
  };
  window.createPlanEditor = () => {
    let doc = '';
    return {
      state: { doc: { toString: () => doc, get length() { return doc.length; } } },
      dispatch(tr) { if (tr && tr.changes) doc = doc.slice(0, tr.changes.from) + tr.changes.insert + doc.slice(tr.changes.to); },
      destroy() {},
    };
  };

  const ctx = dom.getInternalVMContext();
  for (const f of ['viewer-toolbar.js', 'viewer-panel.js']) {
    const file = path.join(PUBLIC_DIR, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  const container = window.document.getElementById('c');
  const panel = new window.ViewerPanel(container, {
    copyContent: true,
    onSave: (p, content, expected) => {
      state.saves.push({ content, expected });
      if (state.disk !== expected) return Promise.resolve({ ok: false, reason: 'stale', disk: state.disk });
      state.disk = content;
      return Promise.resolve({ ok: true });
    },
  });
  return { window, state, panel, container, destroy: () => window.close() };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

async function openPending(ctx, { failLoad = false } = {}) {
  ctx.panel.open('a.md', FILE, 'a0\n');
  await flush();
  if (failLoad) {
    ctx.state.scripts[0].onerror(new Error('no bundle'));
    await flush();
  }
}

function pressSaveButton(ctx) {
  ctx.panel.toolbar.saveBtn.click();
}

function pressCtrlS(ctx) {
  ctx.container.dispatchEvent(new ctx.window.CustomEvent('cm-save'));
}

for (const [label, failLoad] of [['while the bundle loads', false], ['after the bundle failed to load', true]]) {
  test(`Save ${label} writes nothing and leaves the file as it is`, async () => {
    const ctx = setup();
    try {
      await openPending(ctx, { failLoad });
      pressSaveButton(ctx);
      pressCtrlS(ctx);
      await flush();
      assert.deepEqual(ctx.state.saves, []);
      assert.equal(ctx.state.disk, 'a0\n');
    } finally { ctx.destroy(); }
  });

  test(`the Save button is disabled ${label}`, async () => {
    const ctx = setup();
    try {
      await openPending(ctx, { failLoad });
      assert.equal(ctx.panel.toolbar.saveBtn.disabled, true);
    } finally { ctx.destroy(); }
  });

  test(`Copy ${label} copies the file's text, not the empty editor`, async () => {
    const ctx = setup();
    try {
      await openPending(ctx, { failLoad });
      ctx.panel.toolbar.copyContentBtn.click();
      assert.deepEqual(ctx.state.copied, ['a0\n']);
    } finally { ctx.destroy(); }
  });
}

test('once the document is in the editor, Save is enabled and writes it', async () => {
  const ctx = setup();
  try {
    await openPending(ctx);
    ctx.state.scripts[0].onload();
    await flush();
    assert.equal(ctx.panel.toolbar.saveBtn.disabled, false);
    const doc = ctx.panel.editorView.state.doc;
    ctx.panel.editorView.dispatch({ changes: { from: doc.length, to: doc.length, insert: 'Y' } });
    pressSaveButton(ctx);
    await flush();
    assert.deepEqual(ctx.state.saves, [{ content: 'a0\nY', expected: 'a0\n' }]);
    assert.equal(ctx.state.disk, 'a0\nY');
  } finally { ctx.destroy(); }
});
