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
    onExitAttemptInvalidated: cb => { (calls.invalidated ||= []).push(cb); },
    onExitBackgroundProgress: cb => { calls.progress = cb; },
    onBgHandoffNotice: cb => { calls.handoffNotice = cb; },
    onExitFlush: cb => { calls.exitFlush = cb; },
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
    const sourcePath = f === 'file-panel.js' && process.env.EXIT_FILE_PANEL_SOURCE || path.join(PUBLIC_DIR, f);
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), dom.getInternalVMContext(), { filename: sourcePath });
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
  rows ||= [{ id: 'session-id', type: 'session', generation: 'g1', cwd: '/repo/project', canBackground: true, background: 'ready', reason: null }];
  const counts = { sessions: 0, plain: 0, panels: 0, attached: 1 };
  for (const row of rows) counts[row.type === 'panel' ? 'panels' : row.type === 'plain' ? 'plain' : 'sessions']++;
  return { attempt: 1, version: 1, action, external: false, snapshot: { rows, counts, remote: { vps: 2 } } };
}

function exitRuntime(ctx) {
  const w = ctx.window;
  w.openSessions.clear();
  w.document.body.insertAdjacentHTML('beforeend', '<div id="app-notices"></div>');
  if (typeof w.showAppNotice !== 'function') vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, 'app-notices.js'), 'utf8'), ctx.context, { filename: path.join(PUBLIC_DIR, 'app-notices.js') });
  const functions = ['moveSessionsForExit', 'markExitBackground', 'recoverExitBackground', 'finishExitBackground', 'clearExternalExitBackground', 'showExitBackgroundProgress', 'exitBackgroundFailure', 'initExitBackgroundControl', 'rekeySessionTab', 'attachBackgroundContinuation', 'persistWorkingSet', 'pendingRestoreEntries', 'flushStateForExit', 'releaseExitState', 'beginPtyOpen', 'settlePtyOpen'];
  const declarations = ['exitHandoffs', 'exitBackgroundAttempts', 'skippedWorkingSetEntries', 'ptyGenerations', 'pendingOpens', 'restoringWorkingSet', 'persistWorkingSetTimer', '_persistChain', 'exitingApp', 'exitingAppTimer', 'persistSkippedWhileExiting', 'savedWorkingSetRead', 'EXIT_FLUSH_GRACE_MS', 'restorePlanner', 'restoreSavedIndex', 'restoreAwaitingConsent', 'restoreInFlight', 'dormantWorkingSet'];
  loadAppFunctions(ctx.context, {
    functions, declarations,
  });
  vm.runInContext('savedWorkingSetRead = true', ctx.context);
  w.sessionMap = new Map();
  w.pendingSessions = new Map();
  w.activePtyIds = new Set();
  w.terminalHeaderId = w.document.createElement('span');
  w.terminalHeaderName = w.document.createElement('span');
  w.setActiveSession = id => { w.activeSessionId = id; };
  w.rekeySessionEnvironment = () => {};
  w.rekeyActivityState = () => {};
  w.loadProjects = async () => {};
  w.pollActiveSessions = () => {};
  w.schedulePersistWorkingSet = () => {};
  w.syncPtySizeAfterOpen = () => {};
  ctx.calls.attaches = [];
  ctx.calls.stops = [];
  ctx.calls.batches = [];
  ctx.calls.cancels = [];
  ctx.calls.writes = [];
  w.api.openTerminal = async (...args) => { ctx.calls.attaches.push(args); return { ok: true, generation: 1 }; };
  w.api.stopSession = async (...args) => { ctx.calls.stops.push(args); return { ok: true }; };
  w.api.getSetting = async () => ({});
  w.api.setSetting = async (_, value) => { ctx.calls.writes.push(JSON.parse(JSON.stringify(value.openWorkingSet))); };
  w.api.exitBackgroundCancel = (...args) => ctx.calls.cancels.push(args);
  w.api.exitBackground = (...args) => {
    ctx.calls.batches.push(args);
    return new Promise(resolve => { ctx.calls.finishBatch = resolve; });
  };
  w.hasExitBackground = detail => vm.runInContext(`typeof exitBackgroundAttempts !== 'undefined' && exitBackgroundAttempts.has(${detail?.attempt || 0})`, ctx.context);
  w.initExitBackgroundControl?.();
  const source = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const exitFlush = source.split('\n').find(line => line.includes('window.api.onExitFlush'));
  vm.runInContext(exitFlush, ctx.context, { filename: path.join(PUBLIC_DIR, 'app.js') });
  w.api.onSessionForked = cb => { ctx.calls.forked = cb; };
  const callbackStart = source.indexOf('window.api.onSessionForked(');
  vm.runInContext(source.slice(callbackStart, source.indexOf('\n});', callbackStart) + 4), ctx.context, { filename: path.join(PUBLIC_DIR, 'app.js') });
  for (const id of ['one', 'two']) {
    const entry = { session: { sessionId: id, name: id, projectPath: '/repo' }, closed: false };
    w.openSessions.set(id, entry);
    w.sessionMap.set(id, entry.session);
  }
  return exitDetail('quit', ['one', 'two'].map(id => ({ id, type: 'session', background: 'ready', cwd: '/repo', generation: id })));
}

async function clickMove(ctx) {
  await flush();
  const button = ctx.window.document.querySelector('.choice-dialog-secondary');
  assert.ok(button, 'Move action must be available');
  button.click();
  await flush();
}

const moved = id => ({ id, ok: true, sessionId: id + '-bg', jobId: id + '-job', cwd: '/repo' });

for (const [from, to] of [['close', 'quit'], ['quit', 'update']]) {
  test(`H2b progress Cancel after ${from} to ${to} aborts the real busy batch`, async () => {
    const ctx = setup();
    try {
      exitRuntime(ctx);
      const { inventory, runExitHandoffs } = require('../session-exit');
      const ipcMain = new EventEmitter();
      const handlers = new Map();
      ipcMain.handle = (name, fn) => handlers.set(name, fn);
      const records = new Map(['one', 'two'].map(id => [id, { kind: 'local-pty', pty: {} }]));
      const wc = new EventEmitter();
      Object.assign(wc, { isDestroyed: () => false, isCrashed: () => false,
        send: (channel, ...args) => {
          const callback = { 'unsaved-check': ctx.calls.check, 'unsaved-check-reason': ctx.calls.reason,
            'exit-background-progress': ctx.calls.progress }[channel];
          if (callback) queueMicrotask(() => callback(...args));
        } });
      const win = new EventEmitter();
      Object.assign(win, { webContents: wc, isDestroyed: () => false, close() {} });
      let signal;
      const writes = [];
      const guard = createUnsavedGuard({ ipcMain, inventory: () => inventory(records, (_record, _id, state) => state === 'idle' ? null : 'Session is busy', () => 'busy'),
        background: (ids, opts) => {
          signal = opts.signal;
          return runExitHandoffs(ids, { ...opts, status: () => 'busy', now: () => 0,
            waitForChange: () => new Promise(() => {}), send: id => writes.push(id) });
        }, setTimeoutFn: () => ({}), clearTimeoutFn() {} });
      guard.attach(win);
      ctx.window.api.unsavedCheckAck = id => ipcMain.emit('unsaved-check-ack', { sender: wc }, id);
      ctx.window.api.unsavedCheckReasonDone = (id, token, proceed) => ipcMain.emit('unsaved-check-reason-done', { sender: wc }, id, token, proceed);
      ctx.window.api.unsavedCheckResult = (id, proceed, detail) => {
        ctx.calls.answers.push({ id, proceed });
        ipcMain.emit('unsaved-check-result', { sender: wc }, id, proceed, detail);
      };
      ctx.window.api.exitBackground = (id, detail, ids) => handlers.get('exit-background')({ sender: wc }, id, detail, ids);
      ctx.window.api.exitBackgroundCancel = (id, detail) => ipcMain.emit('exit-background-cancel', { sender: wc }, id, detail);
      if (from === 'close') win.emit('close', { preventDefault() {} });
      else guard.requestQuit(win);
      await clickMove(ctx);
      assert.ok(signal && !signal.aborted, 'the real busy batch has started');
      let upgrading;
      if (to === 'quit') upgrading = guard.requestQuit(win);
      else upgrading = guard.confirmQuit(win);
      await flush();
      ctx.window.document.querySelector('[data-notice-id="exit-background"] .app-notice-action').click();
      assert.equal(signal.aborted, true, 'the progress Cancel must abort after the upgrade');
      await flush(); await upgrading;
      assert.equal(ctx.calls.answers.at(-1).proceed, false);
      assert.deepEqual(writes, [], 'no busy row writes /bg after Cancel');
    } finally { ctx.destroy(); }
  });
}

test('H2b an all-move dialog omits Stops while a mixed dialog names what stops', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    ctx.calls.check(320, 'quit', detail); await flush();
    assert.doesNotMatch(ctx.window.document.querySelector('.choice-dialog').textContent, /Stops:/);
    ctx.window.document.querySelector('.choice-dialog-cancel').click(); await flush();
    const mixed = exitDetail('quit', [...detail.snapshot.rows, { id: 'plain', type: 'plain' }]);
    ctx.calls.check(321, 'quit', mixed); await flush();
    assert.match(ctx.window.document.querySelector('.choice-dialog').textContent, /Stops:.*Plain terminal/);
  } finally { ctx.destroy(); }
});

test('H2b a new attempt after cancelled logoff restores typed background rekey and notices', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    ctx.window.document.body.insertAdjacentHTML('beforeend', '<button id="terminal-bg-btn"></button>');
    loadAppFunctions(ctx.context, { functions: ['initTerminalBackgroundControl'] });
    const callbacks = [ctx.calls.handoffNotice];
    ctx.window.api.onBgHandoffNotice = cb => callbacks.push(cb);
    ctx.window.initTerminalBackgroundControl();
    ctx.calls.check(322, 'quit', detail); await clickMove(ctx);
    ctx.calls.progress(1, { id: 'one', phase: 'done', result: moved('one') });
    for (const cb of ctx.calls.invalidated) cb(1, { external: true });
    await flush();
    callbacks.forEach(cb => cb('two', 'Choose Background or Stay'));
    assert.equal(ctx.window.document.querySelector('[data-notice-id="background-progress:two"]'), null);
    const next = exitDetail('quit', [{ id: 'two', type: 'session', background: 'ready' }]); next.attempt = 2;
    ctx.calls.check(323, 'quit', next); await flush();
    ctx.window.document.querySelector('.choice-dialog-cancel').click(); await flush();
    callbacks.forEach(cb => cb('two', 'Choose Background or Stay'));
    assert.match(ctx.window.document.querySelector('[data-notice-id="background-progress:two"]')?.textContent || '', /Choose Background or Stay/,
      'a later typed handoff must show its confirmation notice');
    const entry = ctx.window.openSessions.get('two');
    ctx.calls.forked('two', 'two-bg', 'background', moved('two')); await flush();
    assert.equal(ctx.window.openSessions.get('two-bg'), entry, 'a later typed /bg must rekey its tab');
    assert.equal(ctx.calls.attaches.length, 1, 'the typed handoff attaches normally');
    assert.equal(ctx.window.openSessions.get('one-bg').bgRestore, true, 'confirmed external marks survive cleanup');
    ctx.calls.finishBatch([moved('one'), moved('two')]); await flush();
    assert.equal(ctx.calls.attaches.length, 1, 'the old external result cannot attach again');
  } finally { ctx.destroy(); }
});

test('H2b recovery waits for a written row and reports the settled confirmation count', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    ctx.calls.check(324, 'quit', detail); await clickMove(ctx);
    ctx.calls.progress(1, { id: 'one', phase: 'done', result: moved('one') });
    ctx.calls.progress(1, { id: 'two', phase: 'confirming' });
    for (const cb of ctx.calls.invalidated) cb(1);
    await flush();
    assert.equal(ctx.calls.attaches.length, 0, 'recovery must wait for the written row to settle');
    assert.match(ctx.window.document.querySelector('[data-notice-id="exit-background"]').textContent, /1 of 2 confirmed/);
    assert.equal(ctx.window.document.querySelector('[data-notice-id="exit-background-failure"]'), null);
    ctx.calls.finishBatch([moved('one'), moved('two')]); await flush();
    assert.equal(ctx.calls.attaches.length, 2);
    assert.match(ctx.window.document.querySelector('[data-notice-id="exit-background-failure"]').textContent, /2 of 2 sessions moved/);
    assert.equal(ctx.calls.answers.at(-1).proceed, false);
  } finally { ctx.destroy(); }
});

test('H2b re-ask then Stop requires a checked save of the earlier moves', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    ctx.calls.check(325, 'quit', detail); await clickMove(ctx);
    ctx.calls.finishBatch([moved('one'), moved('two')]); await flush();
    for (const cb of ctx.calls.invalidated) cb(1, { reask: true });
    const next = exitDetail('quit', [{ id: 'new', type: 'plain' }]); next.version = 2;
    ctx.calls.check(326, 'quit', next); await flush();
    ctx.window.api.setSetting = async () => { throw new Error('disk full after re-ask'); };
    ctx.window.document.querySelector('.choice-dialog-confirm').click(); await flush();
    assert.equal(ctx.calls.answers.at(-1).proceed, false, 'Stop must fail when the moved working set cannot be saved');
    assert.equal(ctx.calls.attaches.length, 2);
    assert.match(ctx.window.document.querySelector('[data-notice-id="exit-background-failure"]').textContent, /could not save them.*disk full after re-ask/);
  } finally { ctx.destroy(); }
});

test('C7 event then result converges once, in place, and saves bg with zero attach spawns', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    ctx.calls.check(309, 'quit', detail); await clickMove(ctx);
    const entry = ctx.window.openSessions.get('one');
    ctx.calls.forked('one', 'one-bg', 'background', moved('one'));
    ctx.calls.finishBatch([moved('one'), moved('two')]); await flush();
    assert.equal(ctx.calls.attaches.length, 0);
    assert.equal(ctx.window.openSessions.get('one-bg'), entry);
    assert.deepEqual(ctx.calls.writes.at(-1).map(row => [row.sessionId, row.bg]), [['one-bg', true], ['two-bg', true]]);
  } finally { ctx.destroy(); }
});

test('a failed recovery attach retains bg restore and offers the existing sidebar retry', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    ctx.window.api.openTerminal = async (...args) => { ctx.calls.attaches.push(args); return { ok: false, error: 'attach broke' }; };
    ctx.calls.check(310, 'quit', detail); await clickMove(ctx);
    ctx.calls.finishBatch([moved('one'), { id: 'two', ok: false, code: 'needs-answer' }]); await flush();
    assert.equal(ctx.calls.answers.at(-1).proceed, false);
    await ctx.window.persistWorkingSet();
    assert.equal(ctx.calls.writes.at(-1).find(row => row.sessionId === 'one-bg')?.bg, true);
    assert.match(ctx.window.document.getElementById('app-notices').textContent, /Open it from the sidebar to retry attaching/);
  } finally { ctx.destroy(); }
});

test('C11 repeated Restart joins one renderer batch and the checked save gates its answer', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx); detail.action = 'update';
    let save;
    ctx.window.api.setSetting = () => new Promise(resolve => { save = resolve; });
    ctx.calls.check(311, 'quit', detail); await clickMove(ctx);
    ctx.calls.check(311, 'quit', detail); await flush();
    assert.equal(ctx.calls.batches.length, 1);
    ctx.calls.finishBatch([moved('one'), moved('two')]); await flush();
    assert.equal(ctx.calls.answers.length, 0);
    assert.equal(typeof save, 'function');
    save(); await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 311, proceed: true }]);
  } finally { ctx.destroy(); }
});

test('an external upgrade during a checked save releases the hold, ignores that save failure and flushes unchecked', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    let reject;
    ctx.window.api.setSetting = () => new Promise((resolve, fail) => { reject = fail; });
    ctx.calls.check(312, 'quit', detail); await clickMove(ctx);
    ctx.calls.finishBatch([moved('one'), moved('two')]); await flush();
    ctx.calls.reason(312, 'quit', 88, { ...detail, version: 2, external: true });
    ctx.window.api.setSetting = async () => {};
    reject(new Error('disk failed after external upgrade')); await flush();
    assert.equal(ctx.calls.answers.at(-1)?.proceed, true, 'external exit must retain the unchecked path');
    assert.equal(ctx.calls.attaches.length, 0);
  } finally { ctx.destroy(); }
});

test('C6 Move lists busy, subagents, refusal and shells, counts only eligible rows, and Enter cancels', async () => {
  const ctx = setup();
  try {
    ctx.window.activeSubagentsByParent = new Map([['one', new Set(['child'])]]);
    ctx.window.backgroundActionReason = id => id === 'renderer-refused' ? 'not local' : null;
    const rows = [
      { id: 'one', type: 'session', background: 'busy' },
      { id: 'refused', type: 'session', background: 'refused', reason: 'needs permission' },
      { id: 'renderer-refused', type: 'session', background: 'ready' },
      { id: 'plain', type: 'plain' }, { id: 'panel', type: 'panel', owner: 'owner' },
    ];
    ctx.calls.check(300, 'quit', exitDetail('quit', rows)); await flush();
    const d = ctx.window.document.querySelector('.choice-dialog');
    assert.equal(d.querySelector('.choice-dialog-secondary')?.textContent, 'Move 1 session to background, stop 2 sessions, 1 plain terminal and 1 panel shell, and quit');
    assert.match(d.textContent, /waits for its turn to end \(up to 10 minutes\)/);
    assert.match(d.textContent, /1 running subagent may stop/);
    assert.match(d.textContent, /needs permission/);
    assert.match(d.textContent, /not local/);
    assert.ok(d.querySelector('.choice-dialog-secondary').classList.contains('delete-worktree-confirm-btn'));
    ctx.window.document.activeElement.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    assert.equal(ctx.calls.answers.at(-1).proceed, false);
  } finally { ctx.destroy(); }
});

test('C6 Move submits exactly K ids and C7 result without event saves only new bg ids before answering yes', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    detail.snapshot.rows.push({ id: 'plain', type: 'plain' });
    detail.snapshot.counts.plain++;
    ctx.calls.check(301, 'quit', detail); await clickMove(ctx);
    assert.deepEqual(Array.from(ctx.calls.batches[0][2]), ['one', 'two']);
    assert.equal(ctx.calls.answers.length, 0);
    ctx.calls.finishBatch([moved('one'), moved('two')]); await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 301, proceed: true }]);
    assert.equal(ctx.calls.attaches.length, 0);
    assert.deepEqual([...ctx.window.openSessions.keys()], ['one-bg', 'two-bg']);
    assert.deepEqual(ctx.calls.writes.at(-1).map(row => [row.sessionId, row.bg]), [['one-bg', true], ['two-bg', true]]);
  } finally { ctx.destroy(); }
});

for (const code of ['needs-answer', 'shell', 'busy-timeout', 'failed', 'unknown']) test(`C9 partial ${code} stays open, attaches once and names the failure`, async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    detail.snapshot.rows.push({ id: 'plain', type: 'plain' });
    detail.snapshot.counts.plain++;
    ctx.calls.check(302, 'quit', detail); await clickMove(ctx);
    ctx.calls.finishBatch([moved('one'), { id: 'two', ok: false, code, error: 'backend broke' }]); await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 302, proceed: false }]);
    assert.equal(ctx.calls.attaches.length, 1);
    assert.equal(ctx.calls.attaches[0][0], 'one-bg');
    assert.equal(vm.runInContext('exitingApp', ctx.context), false);
    const text = ctx.window.document.getElementById('app-notices').textContent;
    assert.match(text, /Switchboard stayed open. 1 of 2 sessions moved to the background; nothing was stopped/);
    assert.match(text, /two:/);
    assert.match(text, code === 'needs-answer' ? /needs an answer/ : code === 'shell' ? /shell command/ : code === 'busy-timeout' ? /still working after 10 minutes/ : /backend broke/);
    assert.equal(ctx.calls.saves.length, 0);
    assert.equal(ctx.calls.stops.length, 0, 'the Stop side must stay running on any partial failure');
  } finally { ctx.destroy(); }
});

test('C9b all-ok re-ask keeps marked tabs without recovery, and asks only about the new row', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    ctx.calls.check(303, 'quit', detail); await clickMove(ctx);
    ctx.calls.finishBatch([moved('one'), moved('two')]); await flush();
    for (const cb of ctx.calls.invalidated) cb(1, { reask: true });
    const next = exitDetail('quit', [{ id: 'new', type: 'plain' }]); next.version = 2;
    ctx.calls.check(304, 'quit', next); await flush();
    assert.equal(ctx.calls.attaches.length, 0);
    assert.equal(ctx.window.openSessions.get('one-bg').closed, true);
    const text = ctx.window.document.querySelector('.choice-dialog').textContent;
    assert.match(text, /Plain terminal/); assert.doesNotMatch(text, /one-bg|two-bg/);
    ctx.window.document.querySelector('.choice-dialog-cancel').click(); await flush();
    assert.equal(ctx.calls.attaches.length, 2, 'cancelling the new question recovers the prior confirmed rows');
  } finally { ctx.destroy(); }
});

for (const ok of [false, true]) test(`C9c upgrade during a batch ${ok ? 'renews consent after success' : 'cannot override partial failure'}`, async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx); detail.action = 'close';
    ctx.calls.check(305, 'close', detail); await clickMove(ctx);
    const next = exitDetail('quit', [{ id: 'new', type: 'plain' }]); next.version = 2;
    if (ok) {
      next.snapshot.rows.unshift(...detail.snapshot.rows);
      ctx.window.api.getExitAttemptSnapshot = async () => exitDetail('quit', [{ id: 'new', type: 'plain' }]).snapshot;
    }
    ctx.calls.reason(305, 'quit', 55, next); await flush();
    assert.equal(ctx.window.document.querySelector('.choice-dialog'), null, 'no question while rows are in flight');
    ctx.calls.finishBatch([moved('one'), ok ? moved('two') : { id: 'two', ok: false, code: 'needs-answer' }]); await flush();
    if (ok) {
      assert.ok(ctx.window.document.querySelector('.choice-dialog'));
      assert.doesNotMatch(ctx.window.document.querySelector('.choice-dialog').textContent, /"one"|"two"/);
      assert.equal(ctx.window.document.querySelector('.choice-dialog-secondary'), null, 'fresh inventory omits confirmed sources');
      assert.equal(ctx.calls.attaches.length, 0);
      ctx.window.document.querySelector('.choice-dialog-confirm').click(); await flush();
      assert.equal(ctx.calls.answers.at(-1).proceed, true);
    } else {
      assert.deepEqual(ctx.calls.answers, [{ id: 305, proceed: false }]);
      assert.equal(ctx.window.document.querySelector('.choice-dialog'), null);
      assert.equal(ctx.calls.attaches.length, 1);
    }
  } finally { ctx.destroy(); }
});

for (const error of ['disk', 'unread', 'timeout']) test(`checked save ${error} recovers immediately and releases the exit hold`, async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    if (error === 'disk') ctx.window.api.setSetting = async () => { throw new Error('disk full'); };
    if (error === 'unread') vm.runInContext('savedWorkingSetRead = false', ctx.context);
    if (error === 'timeout') {
      ctx.window.api.setSetting = () => new Promise(() => {});
      const timeout = ctx.window.setTimeout.bind(ctx.window);
      ctx.window.setTimeout = (fn, ms) => timeout(fn, ms === 2000 ? 10 : ms);
    }
    ctx.calls.check(306, 'quit', detail); await clickMove(ctx);
    ctx.calls.finishBatch([moved('one'), moved('two')]);
    await new Promise(resolve => setTimeout(resolve, error === 'timeout' ? 25 : 5));
    assert.equal(ctx.calls.answers.at(-1)?.proceed, false);
    assert.equal(ctx.calls.attaches.length, 2);
    assert.equal(vm.runInContext('exitingApp', ctx.context), false, 'recovery must release the 10 second hold');
    assert.equal(vm.runInContext('exitingAppTimer', ctx.context), null);
    assert.match(ctx.window.document.getElementById('app-notices').textContent, /could not save them for the next start/);
  } finally { ctx.destroy(); }
});

test('progress stays persistent with Cancel, reports waits and terminal confirmation, and names failures immediately', async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx);
    ctx.calls.check(307, 'quit', detail); await clickMove(ctx);
    ctx.calls.progress(1, { id: 'one', phase: 'waiting' });
    assert.match(ctx.window.document.querySelector('[data-notice-id="exit-background"]').textContent, /one waits for its turn to end/);
    ctx.calls.handoffNotice('one', 'Choose Background or Stay');
    assert.match(ctx.window.document.querySelector('[data-notice-id="exit-background"]').textContent, /one asks you to confirm in its terminal/);
    ctx.calls.progress(1, { id: 'two', phase: 'done', result: { id: 'two', ok: false, code: 'needs-answer' } });
    assert.match(ctx.window.document.querySelector('[data-notice-id="exit-background"]').textContent, /two: needs an answer/);
    assert.equal(vm.runInContext("appNoticeEntries.get('exit-background').timer", ctx.context), null);
    ctx.window.document.querySelector('[data-notice-id="exit-background"] .app-notice-action').click();
    assert.equal(ctx.calls.cancels.length, 1);
    assert.equal(ctx.calls.answers.length, 0, 'written rows still finish');
    ctx.calls.finishBatch([moved('one'), { id: 'two', ok: false, code: 'cancelled' }]); await flush();
    assert.equal(ctx.calls.answers.at(-1).proceed, false);
    assert.equal(ctx.calls.attaches.length, 1);
  } finally { ctx.destroy(); }
});

for (const kind of ['logoff', 'external', 'updater-error']) test(`C10/C11 ${kind} while moving drops late results and ${kind === 'updater-error' ? 'recovers' : 'never attaches'}`, async () => {
  const ctx = setup();
  try {
    const detail = exitRuntime(ctx); detail.action = 'update';
    ctx.calls.check(308, 'quit', detail); await clickMove(ctx);
    ctx.calls.progress(1, { id: 'one', phase: 'done', result: moved('one') });
    if (kind === 'external') {
      const next = { ...detail, external: true, version: 2 };
      ctx.calls.reason(308, 'quit', 77, next);
    } else for (const cb of ctx.calls.invalidated) cb(1, { external: kind === 'logoff' });
    if (kind === 'logoff') ctx.calls.exitFlush();
    await flush();
    if (kind === 'updater-error') assert.equal(ctx.calls.answers.length, 0, 'a user abort collects written handoffs before recovering');
    else {
      assert.equal(ctx.calls.answers.at(-1)?.proceed, kind === 'external', 'external exit settles without awaiting the in-flight IPC');
      assert.equal(ctx.calls.attaches.length, 0);
    }
    ctx.calls.finishBatch([moved('one'), { id: 'two', ok: false, code: 'pending' }]); await flush();
    if (kind !== 'updater-error') ctx.calls.forked('two', 'two-bg', 'background', moved('two'));
    assert.equal(ctx.calls.attaches.length, kind === 'updater-error' ? 1 : 0);
    assert.equal(ctx.window.openSessions.get('one-bg').bgRestore, true);
    assert.equal(ctx.window.openSessions.has('two-bg'), false);
    if (kind !== 'updater-error') assert.equal(ctx.calls.writes.at(-1)?.find(row => row.sessionId === 'one-bg')?.bg, true);
    if (kind === 'external') assert.equal(ctx.calls.answers.at(-1).proceed, true);
    else assert.equal(ctx.calls.answers.at(-1).proceed, false);
  } finally { ctx.destroy(); }
});

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
      const label = action === 'update' ? 'update' : action === 'close' ? 'close' : platform === 'win32' ? 'exit' : 'quit';
      assert.equal(d.querySelector('.choice-dialog-secondary')?.textContent, `Move 1 session to background and ${label}`);
      assert.match(d.textContent, /Moves to the background:/);
      assert.doesNotMatch(d.textContent, /Stops:/);
      assert.doesNotMatch(d.textContent, /Send to background/);
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
    assert.equal(ctx.window.document.querySelector('.choice-dialog-secondary'), null);
    ctx.window.document.querySelector('.choice-dialog-cancel').click(); await flush();
    ctx.calls.check(202, 'quit', exitDetail('quit', [])); await flush();
    assert.equal(ctx.window.document.querySelector('.choice-dialog'), null, 'only remote and attach needs no Stop choice');
    assert.equal(ctx.calls.answers.at(-1).proceed, true);
    const busy = exitDetail('quit', [{ id: 'busy', type: 'session', canBackground: false }, { id: 'sandboxed', type: 'session', canBackground: false }]);
    ctx.calls.check(203, 'quit', busy); await flush();
    assert.doesNotMatch(ctx.window.document.querySelector('.choice-dialog').textContent, /Send to background/);
    assert.equal(ctx.window.document.querySelector('.choice-dialog-secondary'), null);
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
    assert.equal(ctx.window.document.querySelector('.choice-dialog'), null, 'late reason completion does not grant Stop consent');
    ctx.calls.check(212, 'quit', exitDetail()); await flush();
    assert.ok(ctx.window.document.querySelector('.choice-dialog'), 'the renewed check asks before flushing');
    assert.equal(flushed, 0);
    ctx.window.document.querySelector('.choice-dialog-cancel').click(); await flush();
    assert.deepEqual(ctx.calls.answers.at(-1), { id: 212, proceed: false }, 'Cancel declines the renewed check');
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

test('a quit after an answered reload writes the app state only through the renewed check', async () => {
  const ctx = setup();
  try {
    let flushed = 0;
    ctx.window.flushStateForExit = () => { flushed++; return Promise.resolve(); };
    ctx.calls.check(6, 'reload');
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 6, proceed: true }]);
    ctx.calls.reason(6, 'quit');
    await flush();
    assert.equal(flushed, 0, 'an answered reload cannot start a late exit flow');
    ctx.calls.check(6, 'quit');
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
    await dirtyTab(ctx, 's1', A);
    ctx.calls.check(6, 'reload');
    await flush();
    ctx.calls.reason(6, 'close', 41);
    await flush();
    ctx.calls.reason(6, 'quit', 42);
    await flush();
    assert.deepEqual(ctx.calls.reasonDoneTokens, [41, 42], 'each upgrade is acknowledged while the edits choice stays open');
    assert.equal(finish, null, 'no flush before the edits choice');
    button(ctx, 'unsaved-discard').click();
    await flush();
    assert.deepEqual(ctx.calls.answers, [], 'the current check waits for its flush');
    finish();
    await flush();
    assert.deepEqual(ctx.calls.reasonDoneTokens, [41, 42], 'each token is reported once');
    assert.deepEqual(ctx.calls.answers, [{ id: 6, proceed: true }]);
  } finally { ctx.destroy(); }
});

test('late upgrades finish their notification immediately while renewed checks wait for writes', async () => {
  const ctx = setup();
  try {
    let finish = null;
    let fail = false;
    ctx.window.flushStateForExit = () => new Promise((resolve, reject) => { finish = () => (fail ? reject(new Error('disk')) : resolve()); });
    ctx.calls.check(6, 'reload');
    await flush();
    ctx.calls.reason(6, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.reasonDone, [6], 'the stale reload is left for main to re-check');
    assert.equal(finish, null, 'the reason notification starts no write');
    ctx.calls.check(6, 'quit');
    await flush();
    assert.deepEqual(ctx.calls.answers, [{ id: 6, proceed: true }], 'the renewed result waits for the write');
    finish();
    await flush();
    assert.deepEqual(ctx.calls.reasonDone, [6]);
    assert.deepEqual(ctx.calls.answers, [{ id: 6, proceed: true }, { id: 6, proceed: true }], 'both the reload and renewed exit have answered');

    ctx.calls.check(7, 'reload');
    await flush();
    fail = true;
    ctx.calls.reason(7, 'quit');
    await flush();
    ctx.calls.check(7, 'quit');
    await flush();
    finish();
    await flush();
    assert.deepEqual(ctx.calls.reasonDone, [6, 7], 'a failed save still lets the quit go');
    assert.equal(ctx.calls.answers.length, 4, 'the failed flush also settles its renewed exit check');
    assert.deepEqual(ctx.calls.answers.at(-1), { id: 7, proceed: true });

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
