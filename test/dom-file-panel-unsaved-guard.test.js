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
const { loadAppFunctions } = require('./app-source');

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
  const calls = { openFile: null, check: null, reason: null, acks: [], answers: [], saves: [], confirms: [], reasonDone: [], reasonDoneTokens: [] };
  let editor = null;

  window.api = new Proxy({
    onMcpOpenFile: (cb) => { calls.openFile = cb; },
    onUnsavedCheck: (cb) => { calls.check = cb; },
    onUnsavedCheckReason: (cb) => { calls.reason = cb; },
    unsavedCheckAck: (id) => { calls.acks.push({ id, at: calls.answers.length, dialog: !!window.document.getElementById('unsaved-edits-dialog') }); },
    unsavedCheckResult: (id, proceed) => { calls.answers.push({ id, proceed }); },
    unsavedCheckReasonDone: (id, token, proceed = true) => { calls.reasonDone.push(id); calls.reasonDoneTokens.push(token); (calls.reasonProceeds ||= []).push(proceed); },
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
  window.appConfirm = async ({ message: msg }) => { calls.confirms.push(msg); return false; };
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

  for (const f of ['modal-stack.js', 'viewer-toolbar.js', 'viewer-panel.js', 'splitter.js', 'session-state.js', 'session-activity-dom.js', 'session-activity.js', 'shortcuts.js', 'header-controls.js', 'tool-bar.js', 'choice-dialog.js', 'file-panel.js', 'touched-files-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), dom.getInternalVMContext(), { filename: path.join(PUBLIC_DIR, f) });
  }
  window.openSessions = new Map();
  window.gridViewActive = false;
  window.gridCards = new Map();
  window.isMac = false;
  window.appShortcuts = {};
  window.initFilePanel();
  const rawCheck = calls.check;
  calls.check = (id, reason, detail) => rawCheck(id, reason, detail === undefined && reason === 'close' ? exitDetail('close') : detail);
  registerPanelTerminals(dom, ['s1', 's3']);
  return { window, context: dom.getInternalVMContext(), disk, calls, editor: () => editor, destroy: () => window.close() };
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
    unsavedCheckAck: (id) => ipcMain.emit('unsaved-check-ack', { sender: wc }, id),
    unsavedCheckResult: (id, proceed, detail) => ipcMain.emit('unsaved-check-result', { sender: wc }, id, proceed, detail),
    unsavedCheckReasonDone: (id, token) => ipcMain.emit('unsaved-check-reason-done', { sender: wc }, id, token),
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

function exitDetail(action = 'quit', rows = null) {
  rows ||= [{ id: 'session-id', type: 'session', generation: 'g1', cwd: '/repo/project', canBackground: true }];
  const counts = { sessions: 0, plain: 0, panels: 0, attached: 1 };
  for (const row of rows) counts[row.type === 'panel' ? 'panels' : row.type === 'plain' ? 'plain' : 'sessions']++;
  return { attempt: 1, version: 1, action, external: false, snapshot: { rows, counts, remote: { vps: 2 } } };
}

for (const n of [1, 2]) {
  test(`B4 exit wording agrees for ${n} attached and remote sessions`, async () => {
    const ctx = setup();
    try {
      const detail = exitDetail();
      detail.snapshot.counts.attached = n;
      detail.snapshot.remote = { vps: n };
      ctx.calls.check(210, 'quit', detail); await flush();
      const text = ctx.window.document.querySelector('.choice-dialog').textContent;
      assert.ok(text.includes(`${n} session${n === 1 ? '' : 's'} attached here ${n === 1 ? 'is' : 'are'} detached and ${n === 1 ? 'keeps' : 'keep'} running in the background.`));
      assert.ok(text.includes(`${n} session${n === 1 ? '' : 's'} from vps ${n === 1 ? 'keeps' : 'keep'} running on vps.`));
    } finally { ctx.destroy(); }
  });
}

test('A2 named exit question covers each intent and platform, identities and honest loss wording', async () => {
  for (const platform of ['win32', 'linux', 'darwin']) for (const action of ['quit', 'close', 'update']) {
    const ctx = setup(); ctx.window.api.platform = platform;
    ctx.window.openSessions.set('session-id', { session: { name: '<img src=x>', projectPath: '/repo/project' } });
    try {
      ctx.calls.check(200, 'quit', exitDetail(action)); await flush();
      const d = ctx.window.document.querySelector('.choice-dialog');
      assert.ok(d, 'local work must be named before approving the exit');
      const verb = action === 'update' ? 'restart to update' : action === 'close' ? platform === 'darwin' ? 'close the window' : 'close Switchboard' : platform === 'win32' ? 'exit' : 'quit';
      assert.equal(d.querySelector('h2').textContent, `Stop 1 session and ${verb}?`);
      assert.match(d.textContent, /<img src=x>.*project.*session/);
      assert.equal(d.querySelector('img'), null, 'names are text');
      assert.match(d.textContent, /Their processes end, idle or working/);
      assert.match(d.textContent, /1 session attached here is detached/);
      assert.match(d.textContent, /2 sessions from vps keep running on vps/);
      assert.match(d.textContent, /Send to background/);
      assert.doesNotMatch(d.textContent, /open here|Every session running in it stops/);
      assert.equal(ctx.window.document.activeElement, d.querySelector('.choice-dialog-cancel'));
      if (platform === 'darwin' && action === 'close') assert.match(d.textContent, /stays in the Dock/);
    } finally { ctx.destroy(); }
  }
  const ctx = setup();
  try {
    const detail = exitDetail('close', [{ id: 'plain', type: 'plain', cwd: '/repo' }, { id: 'panel', type: 'panel', owner: 'owner-id', cwd: '/repo' }]);
    detail.snapshot.counts.attached = 0;
    ctx.calls.check(201, 'close', detail); await flush();
    const text = ctx.window.document.querySelector('.choice-dialog')?.textContent || '';
    assert.match(text, /1 plain terminal and 1 panel shell/);
    assert.match(text, /Panel shell of "owner-id"/);
    assert.match(text, /Their shells end/);
    assert.doesNotMatch(text, /Their processes end|Send to background|attached here/);
    ctx.window.document.querySelector('.choice-dialog-cancel').click(); await flush();
    ctx.calls.check(202, 'quit', exitDetail('quit', [])); await flush();
    assert.equal(ctx.window.document.querySelector('.choice-dialog'), null, 'only remote and attach needs no Stop choice');
    assert.equal(ctx.calls.answers.at(-1).proceed, true);
    const busy = exitDetail('quit', [{ id: 'busy', type: 'session', canBackground: false }, { id: 'sandboxed', type: 'session', canBackground: false }]);
    ctx.calls.check(203, 'quit', busy); await flush();
    assert.doesNotMatch(ctx.window.document.querySelector('.choice-dialog').textContent, /Send to background/);
    ctx.window.document.querySelector('.choice-dialog-cancel').click(); await flush();
    const unknown = exitDetail('quit', []); unknown.snapshot.unknown = true;
    ctx.calls.check(204, 'quit', unknown); await flush();
    assert.match(ctx.window.document.querySelector('.choice-dialog').textContent, /could not list/);
    assert.doesNotMatch(ctx.window.document.querySelector('.choice-dialog').textContent, /nothing will stop/);
  } finally { ctx.destroy(); }
});

test('A3 edits precede Stop consent, Cancel releases unload approval and never flushes', async () => {
  for (const choice of ['save', 'discard']) {
    const ctx = setup(); let flushed = 0; ctx.window.flushStateForExit = async () => { flushed++; };
    try {
      await dirtyTab(ctx, 's1', A);
      ctx.calls.check(210, 'quit', exitDetail()); await flush();
      button(ctx, 'unsaved-' + choice).click(); await flush();
      const d = ctx.window.document.querySelector('.choice-dialog');
      assert.ok(d, 'Save or Discard is not Stop consent');
      if (choice === 'discard') assert.equal(beforeUnload(ctx).defaultPrevented, true, 'Discard cannot unload while Stop is undecided');
      assert.equal(flushed, 0, 'no flush before the session choice');
      d.querySelector('.choice-dialog-cancel').click(); await flush();
      assert.equal(flushed, 0); assert.equal(ctx.calls.answers.at(-1).proceed, false);
      await dirtyTab(ctx, 's1', B);
      assert.equal(beforeUnload(ctx).defaultPrevented, true, 'Cancel clears unload approval');
      ctx.calls.check(211, 'quit', exitDetail()); await flush(); assert.ok(dialog(ctx));
      button(ctx, 'unsaved-discard').click(); await flush();
      ctx.window.document.querySelector('.choice-dialog-confirm').click(); await flush();
      assert.equal(flushed, 1); assert.equal(ctx.calls.answers.at(-1).proceed, true);
    } finally { ctx.destroy(); }
  }
  const ctx = setup(); let flushed = 0; ctx.window.flushStateForExit = async () => { flushed++; };
  try {
    ctx.calls.check(212, 'reload'); await flush();
    ctx.calls.reason(212, 'quit', 44, exitDetail()); await flush();
    assert.ok(ctx.window.document.querySelector('.choice-dialog'), 'late reload upgrade asks before flushing');
    assert.equal(flushed, 0);
    ctx.window.document.querySelector('.choice-dialog-cancel').click(); await flush();
    assert.equal(ctx.calls.reasonProceeds.at(-1), false, 'late Cancel also declines the main continuation');
    assert.equal(flushed, 0);
    await dirtyTab(ctx, 's1', A);
    ctx.window.api.saveFileForPanel = async () => ({ ok: false, error: 'read only' });
    ctx.calls.check(213, 'quit', exitDetail()); await flush();
    button(ctx, 'unsaved-save').click(); await flush();
    assert.ok(dialog(ctx), 'failed Save keeps the edits question open');
    assert.equal(ctx.window.document.querySelector('.choice-dialog'), null);
    assert.equal(flushed, 0);
    button(ctx, 'unsaved-cancel').click(); await flush();
  } finally { ctx.destroy(); }
});

test('the unsaved guard keeps its explicit opener restoration to one focus call', async () => {
  const ctx = setup();
  try {
    const opener = ctx.window.document.createElement('button');
    ctx.window.document.body.append(opener);
    opener.focus();
    let restored = 0;
    const focus = opener.focus.bind(opener);
    opener.focus = () => { restored++; focus(); };
    const pending = ctx.window.showUnsavedEditsDialog([]);
    ctx.window.document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    assert.equal(await pending, false);
    assert.equal(ctx.window.document.activeElement, opener);
    assert.equal(restored, 1);
  } finally { ctx.destroy(); }
});

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

test('quit focuses Save so Enter saves the edits before approving quit', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    const checking = ctx.calls.check(60, 'quit');
    await flush();
    const save = button(ctx, 'unsaved-save');
    assert.equal(ctx.window.document.activeElement, save);
    dialogKey(ctx, 'Enter');
    await flush();
    assert.equal(ctx.disk.get(A), 'x0\nmine', 'Enter itself must save');
    await checking;
    assert.equal(ctx.disk.get(A), 'x0\nmine');
    assert.deepEqual(ctx.calls.answers, [{ id: 60, proceed: true }]);
  } finally { ctx.destroy(); }
});

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

test('the page reports each upgrade with the token it came with', async () => {
  const ctx = setup();
  try {
    let finish = null;
    ctx.window.flushStateForExit = () => new Promise((resolve) => { finish = resolve; });
    ctx.calls.check(6, 'reload');
    await flush();
    ctx.calls.reason(6, 'close', 41);
    await flush();
    ctx.calls.reason(6, 'quit', 42);
    await flush();
    assert.deepEqual(ctx.calls.reasonDoneTokens, [42], 'the second upgrade has no save of its own to wait for');
    finish();
    await flush();
    assert.deepEqual(ctx.calls.reasonDoneTokens, [42, 41], 'the first is reported once its save lands');
  } finally { ctx.destroy(); }
});

test('the page tells main when the save a late upgrade asked for is done, and at once when it has none to do', async () => {
  const ctx = setup();
  try {
    let finish = null;
    let fail = false;
    ctx.window.flushStateForExit = () => new Promise((resolve, reject) => { finish = () => (fail ? reject(new Error('disk')) : resolve()); });
    ctx.calls.check(6, 'reload');
    await flush();
    ctx.calls.reason(6, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.reasonDone, [], 'not before the save lands');
    finish();
    await flush();
    assert.deepEqual(ctx.calls.reasonDone, [6]);

    ctx.calls.check(7, 'reload');
    await flush();
    fail = true;
    ctx.calls.reason(7, 'quit');
    await flush();
    finish();
    await flush();
    assert.deepEqual(ctx.calls.reasonDone, [6, 7], 'a failed save still lets the quit go');

    ctx.calls.reason(99, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.reasonDone, [6, 7, 99], 'an unknown check has nothing to wait for');

    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(8, 'reload');
    await flush();
    ctx.calls.reason(8, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.reasonDone, [6, 7, 99, 8], 'a check still asking saves before it answers, so main need not wait');
  } finally { ctx.destroy(); }
});

test('a check sent again while the page writes the app state for it is not asked or written a second time', async () => {
  const ctx = setup();
  try {
    let flushes = 0;
    let finish = null;
    ctx.window.flushStateForExit = () => { flushes++; return new Promise((resolve) => { finish = resolve; }); };
    ctx.calls.check(10, 'quit');
    await flush();
    assert.equal(flushes, 1);
    ctx.calls.check(10, 'quit');
    await flush();
    assert.equal(flushes, 1, 'one write for one check');
    assert.equal(ctx.calls.acks.length, 1);
    finish();
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 10, proceed: true }]);
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
    assert.equal(closeDialog().querySelector('#choice-dialog-title').textContent, 'Stop 1 session and close Switchboard?');
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
    assert.equal(document.querySelector('#choice-dialog-title').textContent, 'Stop 1 session and close Switchboard?');
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

test('a choice dialog that does not ask to replace waits behind the open one, and shows once it closes', async () => {
  const ctx = setup();
  try {
    const { document } = ctx.window;
    const first = ctx.window.showChoiceDialog({ title: 'first' });
    let second;
    ctx.window.showChoiceDialog({ title: 'second' }).then((v) => { second = v; });
    await flush();
    assert.equal(second, undefined, 'the second question is not answered as a silent Cancel');
    assert.equal(document.querySelector('#choice-dialog-title').textContent, 'first');
    document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(await first, null);
    await flush();
    assert.equal(document.querySelector('#choice-dialog-title').textContent, 'second');
    document.querySelector('.choice-dialog-cancel').click();
    await flush();
    assert.equal(second, null);
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

test('a window close over unsaved edits asks Discard and then Stop', async () => {
  const ctx = setup();
  try {
    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(3, 'close');
    await flush();
    assert.ok(dialog(ctx));
    button(ctx, 'unsaved-discard').click();
    await flush();
    assert.ok(ctx.window.document.querySelector('.choice-dialog'));
    ctx.window.document.querySelector('.choice-dialog-confirm').click();
    await flush();
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
    for (let i = 0; i < 40 && !dialog(ctx); i++) await flush();
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
    assert.equal(ctx.window.document.querySelector('#choice-dialog-title').textContent, 'Stop 1 session and close the window?');
    assert.match(ctx.window.document.querySelector('.choice-dialog').textContent, /stays in the Dock/);
  } finally { ctx.destroy(); }
});

test('a check delivered twice, before and after the page said it is ready, is answered once', async () => {
  const ctx = setup();
  try {
    ctx.calls.check(9, 'quit');
    ctx.calls.check(9, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.acks.map((a) => a.id), [9]);
    assert.deepEqual(ctx.calls.answers, [{ id: 9, proceed: true }]);
  } finally { ctx.destroy(); }
});
function loadAppDialogs(ctx) {
  for (const f of ['app-dialogs.js']) {
    const filename = path.join(PUBLIC_DIR, f);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
  }
}
function dialogKey(ctx, key, init = {}) {
  ctx.window.document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

for (const reason of ['quit', 'close', 'reload']) {
  test(`${reason} opens the unsaved guard on top of New Session without closing it first`, async () => {
    const ctx = setup();
    try {
      loadAppDialogs(ctx);
      for (const f of ['setting-defaults.js', 'dialogs.js']) {
        const filename = path.join(PUBLIC_DIR, f);
        vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
      }
      await dirtyTab(ctx, 's1', A);
      ctx.window.api.getEffectiveSettings = async () => ({});
      await ctx.window.showNewSessionDialog({ projectPath: '/repo' });
      const underneath = ctx.window.document.querySelector('.new-session-overlay');
      const checking = ctx.calls.check(73, reason);
      assert.deepEqual(ctx.calls.acks.map(x => x.id), [73]);
      await flush();
      assert.ok(dialog(ctx), 'a configuration modal must not delay the unsaved guard');
      assert.equal(underneath.isConnected, true);
      assert.ok(Number(dialog(ctx).parentElement.style.zIndex) > Number(underneath.style.zIndex));
      assert.equal(ctx.window.document.activeElement, button(ctx, 'unsaved-save'));
      dialogKey(ctx, 'Escape');
      await checking;
      assert.deepEqual(ctx.calls.answers, [{ id: 73, proceed: false }]);
      assert.equal(underneath.isConnected, true);
      dialogKey(ctx, 'Escape');
      assert.equal(underneath.isConnected, false);
    } finally { ctx.destroy(); }
  });
}

test('a session deletion question waits for the unsaved guard to close', async () => {
  const ctx = setup();
  try {
    ctx.window.api.deleteSessionPreview = async id => ({ ok: true, partIds: [id], parts: 1, transcripts: 1, subagents: 0 });
    loadAppDialogs(ctx);
    ctx.window.cleanDisplayName = value => value;
    ctx.window.escapeHtml = value => value;
    const { showDeleteSessionDialog } = loadAppFunctions(ctx.context, {
      sourcePath: path.join(PUBLIC_DIR, 'sidebar.js'), functions: ['showDeleteSessionDialog'],
    });
    await dirtyTab(ctx, 's1', A);
    const checking = ctx.calls.check(72, 'quit');
    await flush();
    const deleting = showDeleteSessionDialog({ sessionId: 's1' });
    assert.equal(ctx.window.document.querySelector('.new-session-overlay'), null);
    dialogKey(ctx, 'Escape');
    await checking;
    assert.equal(dialog(ctx), null);
    assert.ok(ctx.window.document.querySelector('#dss-cancel'));
    dialogKey(ctx, 'Escape');
    assert.equal(await deleting, false);
  } finally { ctx.destroy(); }
});
test('N2: unsaved guard traps Tab and cancels Escape from the body', async () => {
  const ctx = setup();
  try {
    loadAppDialogs(ctx);
    await dirtyTab(ctx, 's1', A);
    const checking = ctx.calls.check(71, 'quit');
    await flush();
    ctx.window.document.activeElement.blur();
    dialogKey(ctx, 'Tab');
    assert.equal(ctx.window.document.activeElement, button(ctx, 'unsaved-cancel'));
    ctx.window.document.activeElement.blur();
    dialogKey(ctx, 'Escape');
    await flush();
    assert.equal(dialog(ctx), null);
    await checking;
    assert.deepEqual(ctx.calls.answers, [{ id: 71, proceed: false }]);
  } finally { ctx.destroy(); }
});
test('N4: unsaved guard waits for the single continuation chooser', async () => {
  const ctx = setup();
  try {
    loadAppDialogs(ctx);
    const filename = path.join(PUBLIC_DIR, 'resume-guard.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), ctx.context, { filename });
    await dirtyTab(ctx, 's1', A);
    const chain = ctx.window.resolveResumeSession({ sessionId: 'original' }, {
      api: { getSessionContinuations: async () => ({ candidates: [{ sessionId: 'first' }, { sessionId: 'second' }] }) },
      choose: question => ctx.window.appChoose(question),
    });
    await flush();
    const checking = ctx.calls.check(70, 'quit');
    await flush();
    assert.equal(dialog(ctx), null, 'guard must wait for the chooser');
    assert.equal(ctx.window.document.querySelectorAll('.choice-dialog-overlay').length, 1);
    assert.equal(ctx.window.document.querySelectorAll('input[type=radio]').length, 3);
    dialogKey(ctx, 'Escape');
    assert.equal(await chain, null);
    await flush();
    assert.ok(dialog(ctx));
    assert.equal(ctx.window.document.querySelector('.choice-dialog-overlay'), null);
    dialogKey(ctx, 'Escape');
    await checking;
    assert.deepEqual(ctx.calls.answers, [{ id: 70, proceed: false }]);
  } finally { ctx.destroy(); }
});
test('reload ACK is immediate while confirmations queue; quit upgrade waits for one focused unsaved guard', async () => {
  const ctx = setup();
  try {
    loadAppDialogs(ctx);
    await dirtyTab(ctx, 's1', A);
    const opener = ctx.window.document.createElement('button');
    ctx.window.document.body.append(opener);
    opener.focus();
    let flushed = 0;
    ctx.window.flushStateForExit = async () => { flushed++; };
    const confirming = ctx.window.appConfirm({ title: 'Delete?', danger: true });
    const alerting = ctx.window.appAlert({ message: 'Queued message' });
    const checking = ctx.calls.check(44, 'reload');
    ctx.calls.reason(44, 'quit');
    assert.deepEqual(ctx.calls.acks.map(x => x.id), [44]);
    await flush();
    assert.equal(dialog(ctx), null, 'the unsaved guard must wait for the dialog queue');
    dialogKey(ctx, 'Escape');
    assert.equal(await confirming, false);
    dialogKey(ctx, 'Enter');
    await alerting;
    await flush();
    assert.ok(dialog(ctx));
    assert.equal(ctx.window.document.querySelector('.choice-dialog-overlay'), null);
    assert.equal(ctx.window.document.activeElement, button(ctx, 'unsaved-save'));
    dialogKey(ctx, 'Tab', { shiftKey: true });
    assert.equal(ctx.window.document.activeElement, button(ctx, 'unsaved-discard'));
    dialogKey(ctx, 'Tab');
    assert.equal(ctx.window.document.activeElement, button(ctx, 'unsaved-save'));
    button(ctx, 'unsaved-discard').click();
    await checking;
    assert.deepEqual(ctx.calls.answers, [{ id: 44, proceed: true }]);
    assert.equal(flushed, 1);
    assert.equal(ctx.window.document.activeElement, opener);
  } finally { ctx.destroy(); }
});
test('an alert waits for the unsaved guard, then owns focus and Escape', async () => {
  const ctx = setup();
  try {
    loadAppDialogs(ctx);
    await dirtyTab(ctx, 's1', A);
    const checking = ctx.calls.check(45, 'reload');
    await flush();
    const alerting = ctx.window.appAlert({ message: 'Foreground' });
    dialogKey(ctx, 'Tab');
    assert.ok(dialog(ctx).contains(ctx.window.document.activeElement));
    assert.equal(ctx.window.document.querySelector('.choice-dialog-overlay'), null);
    assert.deepEqual(ctx.calls.answers, []);
    dialogKey(ctx, 'Escape');
    await checking;
    assert.deepEqual(ctx.calls.answers, [{ id: 45, proceed: false }]);
    assert.equal(dialog(ctx), null);
    assert.ok(ctx.window.document.activeElement.closest('.choice-dialog-overlay'));
    dialogKey(ctx, 'Escape');
    await alerting;
  } finally { ctx.destroy(); }
});

function openOtherQuestion(ctx) {
  const { document } = ctx.window;
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  const ok = document.createElement('button');
  ok.textContent = 'Delete';
  dialog.append(ok);
  overlay.append(dialog);
  return ctx.window.enqueueModalQuestion(() => new Promise((resolve) => {
    document.body.append(overlay);
    const unregister = ctx.window.registerModal({ overlay, cancel: () => { overlay.remove(); unregister(); resolve(false); }, restoreFocus: false });
  }));
}

test('a quit that arrives while the close question waits behind another question answers yes without that question', async () => {
  const ctx = setup();
  const { document } = ctx.window;
  try {
    let answered = null;
    openOtherQuestion(ctx).then((v) => { answered = v; });
    await flush();
    ctx.calls.check(1, 'close');
    await flush();
    ctx.calls.reason(1, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 1, proceed: true }]);
    assert.equal(answered, null, 'the other question is still the user\'s to answer');
    assert.ok(document.querySelector('.new-session-overlay'));
  } finally { ctx.destroy(); }
});

test('the close question opens on top of another question and Escape returns to it', async () => {
  const ctx = setup();
  const { document } = ctx.window;
  try {
    let answered = null;
    openOtherQuestion(ctx).then((v) => { answered = v; });
    await flush();
    const underneath = document.querySelector('.new-session-overlay');
    ctx.calls.check(1, 'close');
    await flush();
    assert.equal(document.querySelectorAll('.choice-dialog').length, 1, 'the close question is shown, not held behind');
    assert.ok(document.querySelector('.new-session-overlay'), 'the other question is not cancelled');
    document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 1, proceed: false }]);
    assert.equal(answered, null);
    assert.equal(document.querySelector('.choice-dialog'), null);
    assert.ok(underneath.isConnected);
    assert.ok(underneath.contains(document.activeElement), 'focus returns to the other question');
    document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
    assert.equal(answered, false, 'Escape now reaches the other question');
  } finally { ctx.destroy(); }
});
