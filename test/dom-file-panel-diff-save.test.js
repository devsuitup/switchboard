'use strict';

// The MCP diff tab's Save sends the content the diff was opened against, so
// main refuses it when the file moved since; a refusal asks before overwriting.

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

function setup({ saveImpl, confirmAnswer = true } = {}) {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { saves: [], confirms: [], alerts: [], openDiff: null };

  window.api = new Proxy({
    onMcpOpenDiff: (cb) => { calls.openDiff = cb; },
    saveFileForPanel: (filePath, content, expected) => {
      calls.saves.push({ filePath, content, expected });
      return Promise.resolve(saveImpl ? saveImpl(expected, calls.saves.length) : { ok: true });
    },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => {};
      return () => Promise.resolve({ ok: true });
    },
  });
  window.confirm = (msg) => { calls.confirms.push(msg); return confirmAnswer; };
  window.alert = (msg) => { calls.alerts.push(msg); };
  window.loadCodeMirrorBundle = () => Promise.resolve();
  window.localStorage.setItem('filePanelDiffMode', 'side-by-side');

  const makeView = (parent, _old, newContent) => {
    const el = window.document.createElement('div');
    parent.appendChild(el);
    return { dom: el, b: { state: { doc: { toString: () => newContent } } }, destroy() { el.remove(); } };
  };
  window.createMergeViewer = makeView;
  window.createUnifiedMergeViewer = makeView;
  window.createEditableViewer = makeView;
  Object.defineProperty(window, 'ViewerPanel', {
    value: function ViewerPanelStub() { return { open() {}, revealLine() {}, destroy() {} }; },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  for (const f of ['viewer-toolbar.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'file-panel.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: f });
  }
  window.initFilePanel();
  return { window, calls, destroy: () => window.close() };
}

function flush() {
  let p = Promise.resolve();
  for (let i = 0; i < 16; i++) p = p.then(() => Promise.resolve());
  return p;
}

async function openDiffAndSave(ctx) {
  ctx.window.switchPanel('s1');
  ctx.calls.openDiff('s1', 'd1', { oldFilePath: '/repo/a.js', oldContent: 'old\r\n', newContent: 'proposed\n' });
  await flush();
  ctx.window.document.querySelector('.fp-save-btn.fp-icon-btn').click();
  await flush();
}

test('the diff tab saves against the content it was opened with', async () => {
  const ctx = setup();
  try {
    await openDiffAndSave(ctx);
    assert.deepEqual(ctx.calls.saves.map((s) => s.expected), ['old\n']);

    ctx.window.document.querySelector('.fp-save-btn.fp-icon-btn').click();
    await flush();
    assert.equal(ctx.calls.saves[1].expected, 'proposed\n', 'after a save, the next is checked against what was written');
  } finally { ctx.destroy(); }
});

test('a stale refusal asks, and overwrites only on yes', async () => {
  const stale = (expected) => (expected === null ? { ok: true } : { ok: false, reason: 'stale', error: 'this file changed on disk since it was opened' });
  const no = setup({ saveImpl: stale, confirmAnswer: false });
  try {
    await openDiffAndSave(no);
    assert.equal(no.calls.confirms.length, 1);
    assert.equal(no.calls.saves.length, 1, 'a refused confirm writes nothing');
  } finally { no.destroy(); }

  const yes = setup({ saveImpl: stale, confirmAnswer: true });
  try {
    await openDiffAndSave(yes);
    assert.equal(yes.calls.saves.length, 2);
    assert.equal(yes.calls.saves[1].expected, null);
  } finally { yes.destroy(); }
});

test('any other refusal is reported', async () => {
  const ctx = setup({ saveImpl: () => ({ ok: false, error: 'File does not exist' }) });
  try {
    await openDiffAndSave(ctx);
    assert.deepEqual(ctx.calls.alerts, ['Save failed: File does not exist']);
  } finally { ctx.destroy(); }
});

test('a declined overwrite is not followed by a "Save failed" alert', async () => {
  const ctx = setup({ saveImpl: () => ({ ok: false, reason: 'stale', error: 'this file changed on disk since it was opened' }), confirmAnswer: false });
  try {
    await openDiffAndSave(ctx);
    assert.equal(ctx.calls.confirms.length, 1);
    assert.deepEqual(ctx.calls.alerts, []);
  } finally { ctx.destroy(); }
});

test('two quick Save clicks do not raise a false "changed on disk" confirm', async () => {
  const finishers = [];
  const ctx = setup({ saveImpl: (expected) => new Promise((resolve) => {
    finishers.push(() => resolve(expected === 'old\n' || expected === 'proposed\n' ? { ok: true } : { ok: false, reason: 'stale', error: 'stale' }));
  }) });
  try {
    ctx.window.switchPanel('s1');
    ctx.calls.openDiff('s1', 'd1', { oldFilePath: '/repo/a.js', oldContent: 'old\r\n', newContent: 'proposed\n' });
    await flush();
    const btn = ctx.window.document.querySelector('.fp-save-btn.fp-icon-btn');
    btn.click();
    btn.click();
    await flush();
    assert.equal(ctx.calls.saves.length, 1, 'the second click waits for the first');
    finishers[0]();
    await flush();
    assert.equal(ctx.calls.saves.length, 2);
    assert.equal(ctx.calls.saves[1].expected, 'proposed\n', 'checked against what the first save wrote');
    finishers[1]();
    await flush();
    assert.deepEqual(ctx.calls.confirms, []);
    assert.deepEqual(ctx.calls.alerts, []);
  } finally { ctx.destroy(); }
});

test('a queued click is dropped when the first save fails', async () => {
  const finishers = [];
  const ctx = setup({ saveImpl: () => new Promise((resolve) => { finishers.push(resolve); }) });
  try {
    ctx.window.switchPanel('s1');
    ctx.calls.openDiff('s1', 'd1', { oldFilePath: '/repo/a.js', oldContent: 'old\n', newContent: 'proposed\n' });
    await flush();
    const btn = ctx.window.document.querySelector('.fp-save-btn.fp-icon-btn');
    btn.click();
    btn.click();
    await flush();
    finishers[0]({ ok: false, error: 'disk full' });
    await flush();
    assert.equal(ctx.calls.saves.length, 1);
    assert.deepEqual(ctx.calls.alerts, ['Save failed: disk full']);
  } finally { ctx.destroy(); }
});
