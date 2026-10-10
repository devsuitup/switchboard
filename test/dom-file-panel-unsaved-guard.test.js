'use strict';

// Quitting, reloading or closing a session with unsaved file edits asks first (#373):
// the Touched editor in the slot, and Touched edits stashed while something else shows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { registerPanelTerminals } = require('./terminal-manager-harness');
const { EventEmitter } = require('node:events');
const { createUnsavedGuard } = require('../unsaved-guard');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const INDEX_HTML = `<!DOCTYPE html>
<html>
  <head></head>
  <body>
    <div id="terminal-area"><div id="terminals"></div></div>
    <div id="terminal-header" style="display:none;">
      <div id="terminal-header-session"><button id="terminal-stop-btn"></button></div>
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
  const calls = { openFile: null, check: null, reason: null, acks: [], answers: [], saves: [], confirms: [] };
  let editor = null;

  window.api = new Proxy({
    onMcpOpenFile: (cb) => { calls.openFile = cb; },
    onUnsavedCheck: (cb) => { calls.check = cb; },
    onUnsavedCheckReason: (cb) => { calls.reason = cb; },
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
  window.confirm = (msg) => { calls.confirms.push(msg); return calls.onConfirm ? calls.onConfirm(msg) : false; };
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

  for (const f of ['viewer-toolbar.js', 'viewer-panel.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'shortcuts.js', 'header-controls.js', 'tool-bar.js', 'choice-dialog.js', 'file-panel.js', 'touched-files-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: path.join(PUBLIC_DIR, f) });
  }
  window.openSessions = new Map();
  window.gridViewActive = false;
  window.gridCards = new Map();
  window.isMac = false;
  window.appShortcuts = {};
  window.initFilePanel();
  registerPanelTerminals(dom, ['s1', 's3']);
  return { window, disk, calls, editor: () => editor, destroy: () => window.close() };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function wireGuard(ctx) {
  const ipcMain = new EventEmitter();
  const timers = [];
  const sent = [];
  const wc = new EventEmitter();
  Object.assign(wc, {
    send: (channel, ...args) => {
      sent.push({ channel, args });
      if (channel === 'unsaved-check') setTimeout(() => ctx.calls.check(...args));
    },
    isDestroyed: () => false,
    isCrashed: () => false,
  });
  const win = new EventEmitter();
  Object.assign(win, {
    webContents: wc,
    isDestroyed: () => win.destroys > 0,
    close: () => { win.closes += 1; },
    destroy: () => { win.destroys += 1; },
    closes: 0,
    destroys: 0,
  });
  const guard = createUnsavedGuard({
    ipcMain,
    probeMs: 1500,
    setTimeoutFn: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeoutFn: (t) => { t.cleared = true; },
  });
  guard.attach(win);
  Object.assign(ctx.window.api, {
    unsavedCheckAck: (id) => ipcMain.emit('unsaved-check-ack', {}, id),
    unsavedCheckResult: (id, proceed) => ipcMain.emit('unsaved-check-result', {}, id, proceed),
    unsavedDialog: (open) => ipcMain.emit('unsaved-dialog', { sender: wc }, open),
  });
  const close = () => win.emit('close', { preventDefault() {} });
  const pings = () => sent.filter((m) => m.channel === 'unsaved-ping');
  const armed = (ms) => timers.filter((x) => x.ms === ms && !x.cleared);
  const pong = (token) => ipcMain.emit('unsaved-pong', { sender: wc }, token);
  return { win, close, pings, armed, pong };
}
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

// see docs/session-restore.md ("Closing the app")
test('a confirmed close or quit answers only once the app state is written; a reload does not flush', async () => {
  const ctx = setup();
  try {
    const flushes = [];
    ctx.window.flushStateForExit = () => new Promise((resolve) => flushes.push(resolve));
    ctx.calls.check(1, 'quit');
    await flush();
    assert.equal(flushes.length, 1);
    assert.deepEqual(ctx.calls.answers, [], 'no answer while the write is in flight');
    flushes[0]();
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 1, proceed: true }]);
    ctx.calls.check(2, 'reload');
    await flush();
    assert.equal(flushes.length, 1);
    assert.deepEqual(ctx.calls.answers[1], { id: 2, proceed: true });
  } finally { ctx.destroy(); }
});

test('a reload check that a quit joins before it is answered flushes once', async () => {
  const ctx = setup();
  try {
    let flushed = 0;
    ctx.window.flushStateForExit = () => { flushed++; return Promise.resolve(); };
    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(4, 'reload');
    await flush();
    ctx.calls.reason(4, 'quit');
    button(ctx, 'unsaved-discard').click();
    await flush();
    assert.equal(flushed, 1);
    assert.deepEqual(ctx.calls.answers, [{ id: 4, proceed: true }]);
    ctx.calls.check(5, 'reload');
    await flush();
    assert.equal(flushed, 1, 'a later reload is not taken for a quit');
  } finally { ctx.destroy(); }
});

test('a quit that joins a reload check the page has already answered still writes the app state', async () => {
  const ctx = setup();
  try {
    let flushed = 0;
    ctx.window.flushStateForExit = () => { flushed++; return Promise.resolve(); };
    ctx.calls.check(6, 'reload');
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 6, proceed: true }]);
    ctx.calls.reason(6, 'quit');
    await flush();
    assert.equal(flushed, 1);
    ctx.calls.reason(6, 'quit');
    ctx.calls.reason(99, 'quit');
    await flush();
    assert.equal(flushed, 1, 'once, and only for a check this page answered yes');

    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(7, 'reload');
    await flush();
    button(ctx, 'unsaved-cancel').click();
    await flush();
    ctx.calls.reason(7, 'quit');
    await flush();
    assert.equal(flushed, 1, 'a reload answered no is not written for');
  } finally { ctx.destroy(); }
});

test('a cancelled close does not flush', async () => {
  const ctx = setup();
  try {
    let flushed = 0;
    ctx.window.flushStateForExit = () => { flushed++; return Promise.resolve(); };
    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(3, 'quit');
    await flush();
    button(ctx, 'unsaved-cancel').click();
    await flush();
    assert.equal(flushed, 0);
  } finally { ctx.destroy(); }
});

// see .ai/contexts/window-frame.md ("Closing the window")
test('a window close with nothing unsaved asks to close Switchboard; Cancel, Enter and Escape keep it open', async () => {
  const ctx = setup();
  const { document } = ctx.window;
  const closeDialog = () => document.querySelector('.choice-dialog');
  const key = (k) => document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  try {
    ctx.calls.check(1, 'close');
    await flush();
    assert.equal(closeDialog().querySelector('#choice-dialog-title').textContent, 'Close Switchboard?');
    assert.equal(document.activeElement, closeDialog().querySelector('.choice-dialog-cancel'), 'Cancel has the focus');
    key('Enter');
    await flush();
    assert.equal(closeDialog(), null);
    assert.deepEqual(ctx.calls.answers, [{ id: 1, proceed: false }], 'Enter on the focused Cancel keeps the app');

    ctx.calls.check(2, 'close');
    await flush();
    key('Escape');
    await flush();
    assert.deepEqual(ctx.calls.answers[1], { id: 2, proceed: false });

    ctx.calls.check(3, 'close');
    await flush();
    closeDialog().querySelector('.choice-dialog-confirm').click();
    await flush();
    assert.deepEqual(ctx.calls.answers[2], { id: 3, proceed: true });
    assert.deepEqual(ctx.calls.confirms, [], 'no native dialog, which blocks the page');
  } finally { ctx.destroy(); }
});

test('a window close while another choice dialog is open cancels that one and asks to close Switchboard', async () => {
  const ctx = setup();
  const { document } = ctx.window;
  try {
    const origin = document.createElement('button');
    document.body.appendChild(origin);
    origin.focus();
    let other;
    ctx.window.showChoiceDialog({ title: 'Archive folder?', confirmLabel: 'Archive', returnFocus: origin }).then((v) => { other = v; });
    await flush();
    ctx.calls.check(1, 'close');
    await flush();
    assert.equal(other, null, 'the other dialog ends as a cancel, so nothing it offered is done');
    assert.equal(document.querySelectorAll('.choice-dialog').length, 1);
    assert.equal(document.querySelector('#choice-dialog-title').textContent, 'Close Switchboard?');
    assert.deepEqual(ctx.calls.answers, [], 'the close is not answered before the user decides');
    document.querySelector('.choice-dialog-cancel').click();
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 1, proceed: false }]);
    assert.equal(document.activeElement, origin, 'Cancel gives the focus back to where it was before either dialog');
    ctx.calls.check(2, 'close');
    await flush();
    document.querySelector('.choice-dialog-confirm').click();
    await flush();
    assert.deepEqual(ctx.calls.answers[1], { id: 2, proceed: true });
  } finally { ctx.destroy(); }
});

test('a choice dialog that does not ask to replace still yields to one already open', async () => {
  const ctx = setup();
  try {
    ctx.window.showChoiceDialog({ title: 'first' });
    const second = await ctx.window.showChoiceDialog({ title: 'second' });
    assert.equal(second, null);
    assert.equal(ctx.window.document.querySelector('#choice-dialog-title').textContent, 'first');
  } finally { ctx.destroy(); }
});

test('a quit (menu, updater) is not asked about a second time', async () => {
  const ctx = setup();
  try {
    ctx.calls.check(1, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.confirms, []);
    assert.deepEqual(ctx.calls.answers, [{ id: 1, proceed: true }]);
  } finally { ctx.destroy(); }
});

test('a window close over unsaved edits asks once: Discard closes without a second question', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(3, 'close');
    await flush();
    assert.ok(dialog(ctx));
    button(ctx, 'unsaved-discard').click();
    await flush();
    assert.equal(ctx.window.document.querySelector('.choice-dialog'), null);
    assert.deepEqual(ctx.calls.answers, [{ id: 3, proceed: true }]);
  } finally { ctx.destroy(); }
});

test('a native dialog the page shows is reported around it, and the shipped guard does not end a close while it waits', async () => {
  const ctx = setup();
  const main = wireGuard(ctx);
  try {
    await dirtyTab(ctx, 's1', A);
    let during = null;
    ctx.calls.onConfirm = () => {
      main.close();
      main.close();
      main.close();
      main.win.emit('unresponsive');
      during = { pings: main.pings().length, destroys: main.win.destroys };
      return false;
    };
    ctx.window.confirm('Delete "x"?');
    assert.deepEqual(during, { pings: 0, destroys: 0 }, 'a close that arrives behind a native dialog waits for the user to answer it');
    await flush();
    assert.ok(dialog(ctx), 'the page answers once the dialog is gone');

    ctx.calls.onConfirm = () => {
      main.close();
      main.win.emit('unresponsive');
      during = { pings: main.pings().length, destroys: main.win.destroys };
      return false;
    };
    ctx.window.confirm('Discard?');
    assert.deepEqual(during, { pings: 0, destroys: 0 }, 'nor does a close while the question is up');
    button(ctx, 'unsaved-save').click();
    await flush();
    assert.equal(ctx.disk.get(A), 'x0\nmine');
    assert.equal(main.win.destroys, 0);
    assert.equal(main.win.closes, 1, 'closed by the answer, after the save');
  } finally { ctx.destroy(); }
});

test('Cancel gives the focus back to where it was, for the close question and for the unsaved-edits dialog', async () => {
  const ctx = setup();
  const { document } = ctx.window;
  try {
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    ctx.calls.check(1, 'close');
    await flush();
    assert.notEqual(document.activeElement, field);
    document.querySelector('.choice-dialog-cancel').click();
    await flush();
    assert.equal(document.activeElement, field, 'after the close question');

    await dirtyTab(ctx, 's1', A);
    field.focus();
    ctx.calls.check(2, 'quit');
    await flush();
    assert.notEqual(document.activeElement, field);
    button(ctx, 'unsaved-cancel').click();
    await flush();
    assert.equal(document.activeElement, field, 'after the unsaved-edits dialog');
    assert.deepEqual(ctx.calls.answers.map((a) => a.proceed), [false, false]);
  } finally { ctx.destroy(); }
});

test('a quit that joins the close question closes it as a yes; one before it shows skips it', async () => {
  const ctx = setup();
  const { document } = ctx.window;
  try {
    ctx.calls.check(1, 'close');
    await flush();
    assert.ok(document.querySelector('.choice-dialog'));
    ctx.calls.reason(1, 'quit');
    await flush();
    assert.equal(document.querySelector('.choice-dialog'), null, 'SIGTERM or a logout is not cancelled by the close question');
    assert.deepEqual(ctx.calls.answers, [{ id: 1, proceed: true }]);

    ctx.calls.check(3, 'close');
    ctx.calls.reason(3, 'quit');
    await flush();
    assert.equal(document.querySelector('.choice-dialog'), null, 'never shown');
    assert.deepEqual(ctx.calls.answers[1], { id: 3, proceed: true });

    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(2, 'close');
    await flush();
    ctx.calls.reason(2, 'quit');
    button(ctx, 'unsaved-discard').click();
    await flush();
    assert.equal(document.querySelector('.choice-dialog'), null);
    assert.deepEqual(ctx.calls.answers[2], { id: 2, proceed: true });

    ctx.calls.reason(9, 'quit');
    assert.equal(ctx.calls.answers.length, 3, 'a reason for a check already answered is ignored');
  } finally { ctx.destroy(); }
});

test('the close question on macOS says the app stays in the Dock', async () => {
  const ctx = setup();
  ctx.window.api.platform = 'darwin';
  try {
    ctx.calls.check(1, 'close');
    await flush();
    assert.equal(ctx.window.document.querySelector('#choice-dialog-title').textContent, 'Close the window?');
    assert.match(ctx.window.document.querySelector('.choice-dialog').textContent, /stays in the Dock/);
  } finally { ctx.destroy(); }
});
