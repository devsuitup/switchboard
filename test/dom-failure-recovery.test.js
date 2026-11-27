'use strict';

// Issue #709: a failure says what happened and what to do, next to the
// control that failed, never through a blocking appAlert.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { registerPanelTerminals } = require('./terminal-manager-harness');
const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const REASON = 'EACCES: permission denied, open /private/long/path/12345678-1234-1234-1234-123456789abc/note.md';
const SAVE_MESSAGE = 'Could not save this file — your edits are kept; try Save again or copy them elsewhere.';
const READ_MESSAGE = 'Could not open this trace — try Open again, or reopen Diagnostics to refresh the list.';
const DELETE_MESSAGE = 'Could not delete this file — try Delete again, or close any program that has it open.';
const REMAP_MESSAGE = 'Could not change the project path — fix the cause below, then try Change path again.';

function load(dom, files) {
  for (const name of files) {
    const filename = path.join(PUBLIC_DIR, name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  }
}

function flush() {
  let p = Promise.resolve();
  for (let i = 0; i < 16; i++) p = p.then(() => Promise.resolve());
  return p;
}

function assertInlineFailure(el, message) {
  assert.ok(el, 'an inline failure element exists');
  assert.equal((el.querySelector('.viewer-panel-notice-text') || el).textContent, message);
  assert.notEqual(el.style.display, 'none', 'the failure is visible');
  assert.equal(el.hidden, false, 'the failure is visible');
  assert.equal(el.getAttribute('role'), 'alert');
  assert.match(el.title, /EACCES/, 'the reason stays reachable');
}

function assertCleared(el) {
  assert.ok(!el || !el.isConnected || el.hidden || el.style.display === 'none', 'the failure is cleared');
}

function diffPanel(saveImpl) {
  const dom = new JSDOM('<div id="terminal-area"><div id="terminals"></div></div><div id="terminal-header" style="display:none;"><div id="terminal-header-session"><button id="terminal-stop-btn"></button></div></div>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = { saves: [], alerts: [], openDiff: null };
  window.api = new Proxy({
    onMcpOpenDiff: (cb) => { calls.openDiff = cb; },
    saveFileForPanel: (filePath, content) => { calls.saves.push({ filePath, content }); return saveImpl(calls.saves.length); },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('on')) return () => {};
      return () => Promise.resolve({ ok: true });
    },
  });
  window.appConfirm = async () => true;
  window.appAlert = async ({ message }) => { calls.alerts.push(message); };
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
    value: function ViewerPanelStub() { return { open() {}, revealLine() {}, destroy() {}, hasUnsavedEdits: () => false }; },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });
  load(dom, ['modal-stack.js', 'viewer-toolbar.js', 'splitter.js', 'session-state.js', 'session-status-projection.js', 'session-activity-dom.js', 'session-activity.js', 'shortcuts.js', 'header-controls.js', 'tool-bar.js', 'file-panel.js']);
  window.openSessions = new Map();
  window.gridViewActive = false;
  window.gridCards = new Map();
  window.isMac = false;
  window.appShortcuts = {};
  window.initFilePanel();
  registerPanelTerminals(dom, ['s1']);
  const failureEl = () => window.document.querySelector('#file-panel-diff .diff-save-failure');
  return { window, calls, failureEl, destroy: () => window.close() };
}

for (const rejects of [false, true]) {
  test(`GIVEN a diff WHEN its Save is ${rejects ? 'rejected' : 'refused'} THEN the failure shows under the toolbar, the edits stay, and a successful retry clears it`, async t => {
    let fail = true;
    const ctx = diffPanel(() => {
      if (!fail) return Promise.resolve({ ok: true });
      return rejects ? Promise.reject(new Error(REASON)) : Promise.resolve({ ok: false, error: REASON });
    });
    t.after(() => ctx.destroy());
    ctx.window.switchPanel('s1');
    ctx.calls.openDiff('s1', 'd1', { oldFilePath: '/repo/note.md', oldContent: 'old\n', newContent: 'my edits\n' });
    await flush();
    const saveBtn = ctx.window.document.querySelector('#file-panel-diff .fp-save-btn');
    saveBtn.click();
    await flush();

    assert.deepEqual(ctx.calls.alerts, [], 'no appAlert');
    const failure = ctx.failureEl();
    assertInlineFailure(failure, SAVE_MESSAGE);
    assert.ok(failure.previousElementSibling.contains(saveBtn), 'the failure sits right under the toolbar holding Save');
    assert.equal(saveBtn.disabled, false, 'Save can be retried');

    if (rejects) {
      ctx.window.closeDiffByDiffId('s1', 'd1');
      ctx.calls.openDiff('s1', 'd2', { oldFilePath: '/repo/other.md', oldContent: 'a\n', newContent: 'b\n' });
      await flush();
      assertCleared(ctx.failureEl());
      return;
    }
    fail = false;
    saveBtn.click();
    await flush();
    assert.equal(ctx.calls.saves.at(-1).content, 'my edits\n', 'the retry writes the kept buffer');
    assertCleared(ctx.failureEl());
  });
}

function traceList(t, api) {
  const dom = new JSDOM('<div id="activity-trace-viewer" style="display:none"></div><div id="list"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const alerts = [];
  const opened = [];
  const panelOpts = [];
  window.api = api;
  window.appAlert = async ({ message }) => { alerts.push(message); };
  window.appConfirm = async () => true;
  Object.defineProperty(window, 'ViewerPanel', {
    value: class {
      constructor(_container, opts) { panelOpts.push(opts); }
      open(title, filePath, content) { opened.push({ title, filePath, content }); }
    },
    writable: true, configurable: true,
  });
  load(dom, ['activity-trace-panel.js']);
  return { window, list: window.document.getElementById('list'), alerts, opened, panelOpts };
}

const TRACE = { name: 'activity-trace-20261127-101500.jsonl', filePath: '/home/dev/.switchboard/activity-trace-20261127-101500.jsonl', size: 10, modified: '2026-11-27T10:15:00.000Z' };

test('GIVEN a trace row WHEN Open cannot read the trace THEN the failure shows in the row and a successful Open clears it', async t => {
  let read = { ok: false, error: REASON };
  const ctx = traceList(t, {
    listActivityTraceFiles: async () => [TRACE],
    readActivityTraceFile: async () => { if (read instanceof Error) throw read; return read; },
  });
  await ctx.window.renderActivityTraceFiles(ctx.list);
  const row = ctx.list.querySelector('.activity-trace-file');
  const openBtn = row.querySelector('button');
  for (const failure of [{ ok: false, error: REASON }, new Error(REASON)]) {
    read = failure;
    openBtn.click();
    await flush();
    assert.deepEqual(ctx.alerts, [], 'no appAlert');
    assertInlineFailure(row.querySelector('.activity-trace-file-error'), READ_MESSAGE);
    assert.equal(ctx.opened.length, 0, 'nothing opens');
  }
  read = { ok: true, content: 'trace data' };
  openBtn.click();
  await flush();
  assert.equal(ctx.opened.length, 1);
  assertCleared(row.querySelector('.activity-trace-file-error'));
});

test('GIVEN a trace row WHEN Delete fails THEN the failure shows in the row, Delete stays usable, and a successful Delete clears it', async t => {
  let files = [TRACE];
  let remove = { ok: false, error: REASON };
  const ctx = traceList(t, {
    listActivityTraceFiles: async () => files,
    deleteActivityTraceFile: async () => {
      if (remove instanceof Error) throw remove;
      if (remove.ok) files = [];
      return remove;
    },
  });
  await ctx.window.renderActivityTraceFiles(ctx.list);
  const row = ctx.list.querySelector('.activity-trace-file');
  const deleteBtn = row.querySelector('.activity-trace-delete-btn');
  for (const failure of [{ ok: false, error: REASON }, new Error(REASON)]) {
    remove = failure;
    deleteBtn.click();
    await flush();
    assert.deepEqual(ctx.alerts, [], 'no appAlert');
    assertInlineFailure(row.querySelector('.activity-trace-file-error'), DELETE_MESSAGE);
    assert.equal(deleteBtn.disabled, false, 'Delete can be retried');
  }
  remove = { ok: true };
  deleteBtn.click();
  await flush();
  assert.equal(ctx.list.querySelector('.activity-trace-file-error'), null, 'the row and its failure are gone');
});

function memoryViewer(t, onDelete) {
  const dom = new JSDOM('<div id="viewer"></div>', { url: 'http://localhost/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const alerts = [];
  let closed = 0;
  window.api = { watchFile() {}, unwatchFile() {} };
  window.appAlert = async ({ message }) => { alerts.push(message); };
  window.appConfirm = async () => true;
  load(dom, ['viewer-toolbar.js', 'viewer-panel.js']);
  const panel = new window.ViewerPanel(window.document.getElementById('viewer'), { onDelete, onClose: () => { closed++; } });
  return { panel, alerts, closed: () => closed };
}

for (const rejects of [false, true]) {
  test(`GIVEN the Memory viewer WHEN Delete is ${rejects ? 'rejected' : 'refused'} THEN the failure shows under the toolbar, the document stays open, and a successful Delete closes it`, async t => {
    let fail = true;
    const ctx = memoryViewer(t, async () => {
      if (!fail) return { ok: true };
      if (rejects) throw new Error(REASON);
      return { ok: false, error: REASON };
    });
    ctx.panel.open('Memory', '/repo/memory.md', 'my memory edits');
    ctx.panel.toolbar.deleteBtn.click();
    await flush();
    assert.deepEqual(ctx.alerts, [], 'no appAlert');
    const failure = ctx.panel.noticeEl;
    assertInlineFailure(failure, DELETE_MESSAGE);
    assert.ok(failure.previousElementSibling.contains(ctx.panel.toolbar.deleteBtn), 'the failure sits right under the toolbar holding Delete');
    assert.equal(ctx.panel._buffer(), 'my memory edits', 'the document stays');
    assert.equal(ctx.closed(), 0, 'the viewer stays open');
    fail = false;
    ctx.panel.toolbar.deleteBtn.click();
    await flush();
    assert.equal(ctx.closed(), 1);
    assertCleared(failure);
  });
}

test('GIVEN a missing project WHEN Change path fails THEN an app notice says what to do and a successful Change path clears it', async t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  const alerts = [];
  let remap = { error: REASON };
  ctx.window.api = {
    checkRemapProject: async () => ({ ok: true }),
    browseFolder: async () => '/replacement',
    remapProject: async () => { if (remap instanceof Error) throw remap; return remap; },
  };
  ctx.window.appAlert = async ({ message }) => { alerts.push(message); };
  ctx.window.appConfirm = async () => true;
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: '/home/dev/long/private/project', missing: true })], true);
  const click = () => ctx.document.querySelector('.project-remap-btn').onclick(new ctx.window.MouseEvent('click'));
  for (const failure of [{ error: REASON }, new Error(REASON)]) {
    remap = failure;
    await click();
    assert.deepEqual(alerts, [], 'no appAlert');
    const notices = ctx.document.querySelectorAll('#app-notices .app-notice');
    assert.equal(notices.length, 1, 'one notice, replaced on a second failure');
    const [first, ...rest] = notices[0].querySelector('.app-notice-message').textContent.split('\n');
    assert.equal(first, REMAP_MESSAGE);
    assert.match(rest.join('\n'), /EACCES/, 'the reason follows on its own line');
    assert.equal(notices[0].getAttribute('role'), 'alert');
  }
  remap = { ok: true };
  await click();
  assert.equal(ctx.document.querySelector('#app-notices .app-notice'), null, 'a successful Change path clears the notice');
});

const RECORDING_MESSAGE = 'Could not delete this trace — debug mode is still writing to it; turn debug mode off, then Delete again.';
const GONE_MESSAGE = 'Could not delete this file — it is no longer there; reopen Diagnostics to refresh the list.';

test('GIVEN a trace row WHEN main refuses Delete for a reason a retry cannot fix THEN the row says what will', async t => {
  let remove;
  const ctx = traceList(t, {
    listActivityTraceFiles: async () => [TRACE],
    deleteActivityTraceFile: async () => remove,
  });
  await ctx.window.renderActivityTraceFiles(ctx.list);
  const row = ctx.list.querySelector('.activity-trace-file');
  for (const [refusal, message] of [
    [{ ok: false, code: 'recording', error: 'the trace is writing to this file — turn debug mode off first' }, RECORDING_MESSAGE],
    [{ ok: false, code: 'not-trace', error: 'not an activity-trace file' }, GONE_MESSAGE],
    [{ ok: false, code: 'ENOENT', error: 'ENOENT: no such file' }, GONE_MESSAGE],
    [{ ok: false, code: 'EBUSY', error: 'EBUSY: resource busy' }, DELETE_MESSAGE],
  ]) {
    remove = refusal;
    row.querySelector('.activity-trace-delete-btn').click();
    await flush();
    const failure = row.querySelector('.activity-trace-file-error');
    assert.equal(failure.textContent, message, refusal.code);
    assert.equal(failure.title, refusal.error);
  }
  assert.deepEqual(ctx.alerts, []);
});

test('GIVEN the trace viewer WHEN main refuses Delete because debug mode writes the trace THEN its Delete handler hands the viewer the recording message', async t => {
  const ctx = traceList(t, {
    listActivityTraceFiles: async () => [TRACE],
    readActivityTraceFile: async () => ({ ok: true, content: 'trace' }),
    deleteActivityTraceFile: async () => ({ ok: false, code: 'recording', error: 'the trace is writing to this file — turn debug mode off first' }),
  });
  await ctx.window.openActivityTraceFile(TRACE);
  const result = await ctx.panelOpts[0].onDelete(TRACE.filePath);
  assert.equal(result.ok, false);
  assert.equal(result.message, RECORDING_MESSAGE);
});

test('GIVEN a viewer WHEN its Delete handler refuses with its own message THEN the notice shows that message', async t => {
  const ctx = memoryViewer(t, async () => ({ ok: false, error: REASON, message: RECORDING_MESSAGE }));
  ctx.panel.open('Trace', '/traces/now.jsonl', 'trace');
  ctx.panel.toolbar.deleteBtn.click();
  await flush();
  assertInlineFailure(ctx.panel.noticeEl, RECORDING_MESSAGE);
});

test('GIVEN a missing project WHEN main refuses Change path THEN the notice says what is true for that refusal', async t => {
  const ctx = setupSidebarDom();
  t.after(() => ctx.destroy());
  let answer;
  let reloads = 0;
  ctx.window.api = {
    checkRemapProject: async () => ({ ok: true }),
    browseFolder: async () => '/replacement',
    remapProject: async () => answer,
  };
  ctx.window.loadProjects = () => { reloads++; };
  ctx.window.appConfirm = async () => true;
  ctx.sidebar.renderProjects([makeSampleProject({ projectPath: '/home/dev/gone', missing: true })], true);
  const click = () => ctx.document.querySelector('.project-remap-btn').onclick(new ctx.window.MouseEvent('click'));
  const refresh = 'No change needed — the project\'s original folder is back; refresh the project list.';
  for (const [code, first, action] of [
    ['path-back', refresh, 'Refresh'],
    ['no-session-data', 'Could not change the project path — no sessions are recorded for it any more; refresh the project list.', 'Refresh'],
    ['active-sessions', 'Could not change the project path — stop this project\'s running sessions, then try Change path again.', undefined],
    ['target-missing', 'Could not change the project path — choose an existing folder, then try Change path again.', undefined],
    ['target-not-directory', 'Could not change the project path — choose an existing folder, then try Change path again.', undefined],
    ['failed', REMAP_MESSAGE, undefined],
    ['invalid-arguments', REMAP_MESSAGE, undefined],
  ]) {
    answer = { error: 'reason for ' + code, code };
    await click();
    const notice = ctx.document.querySelector('#app-notices .app-notice');
    assert.equal(notice.querySelector('.app-notice-message').textContent, first + '\nreason for ' + code, code);
    assert.equal(notice.querySelector('.app-notice-action')?.textContent, action, code);
  }
  answer = { error: 'reason for path-back', code: 'path-back' };
  await click();
  const before = reloads;
  ctx.document.querySelector('#app-notices .app-notice-action').click();
  assert.equal(reloads, before + 1, 'Refresh reloads the project list');
  assert.equal(ctx.document.querySelector('#app-notices .app-notice'), null, 'Refresh clears the notice');
});
