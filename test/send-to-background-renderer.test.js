'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');
const { setupSidebarDom } = require('./dom-setup');
const path = require('node:path');
const { inventory } = require('../src/main/app/session-exit');
const { backgroundRefusal } = require('../src/main/bg-agents/bg-handoff');

for (const failure of ['refusal', 'rejection', 'missing result']) {
  test(`failed manual background attach ${failure} leaves the saved working set unchanged`, async t => {
    const h = setup(t, { a: [], z: [] }, { savedEntries: [{ sessionId: 'a', projectPath: '/a', active: true }] });
    await h.restore();
    const before = h.settings().openWorkingSet;
    h.dom.window.api.openTerminal = async () => {
      if (failure === 'rejection') throw new Error('attach unavailable');
      return failure === 'missing result' ? undefined : { ok: false, error: 'attach unavailable' };
    };
    assert.equal(await h.app.openSession(h.rows.get('z'), { type: 'attach', jobId: 'job-z' }), false);
    await h.app.persistWorkingSet();
    assert.deepEqual(h.settings().openWorkingSet, before);
    assert.equal(h.ctx.openSessions.has('z'), false);
    assert.ok(h.dom.window.document.querySelector('[data-notice-id="Attach background:local:z"]'));
  });
}

test('failed automatic background restore and failed manual retry retain the saved slot', async t => {
  const saved = [
    { sessionId: 'a', projectPath: '/a', active: true },
    { sessionId: 'z', projectPath: '/z', active: false, bg: true, attachJobId: 'job-z' },
  ];
  const h = setup(t, { a: [], z: [] }, { savedEntries: saved, live: { z: { kind: 'bg', jobId: 'job-z' } } });
  const expected = [{ ...saved[0], projectPath: h.rows.get('a').projectPath }, saved[1]];
  const open = h.dom.window.api.openTerminal;
  h.dom.window.api.openTerminal = async (...args) => args[0] === 'z' ? { ok: false, error: 'attach unavailable' } : open(...args);
  await h.restore();
  assert.deepEqual(h.settings().openWorkingSet, expected, 'successful restore uses indexed identity; failed background slot stays saved');
  await h.app.openSession(h.rows.get('z'), { type: 'attach', jobId: 'job-z' });
  await h.app.persistWorkingSet();
  assert.deepEqual(h.settings().openWorkingSet, expected, 'failed retry retains the exact background slot and order');
});

function handoff(t, { result = { ok: true, sessionId: 'new', jobId: '1234abcd', cwd: '/bg' }, answer = true, agents = 0, existing = false } = {}) {
  const h = setup(t, { old: [], new: [] });
  const calls = [], destroyed = [], notices = [], confirmations = [];
  h.dom.window.api.sendSessionToBackground = async id => { calls.push(id); return result; };
  h.dom.window.appConfirm = async options => { confirmations.push(options); return answer; };
  h.dom.window.showRestoreNotice = (items, text) => notices.push(text);
  h.dom.window.destroySession = id => { destroyed.push(id); vm.runInContext(`openSessions.delete(${JSON.stringify(id)})`, h.ctx); };
  vm.runInContext(`
    var activeSubagentsByParent = new Map(), activePtyIds = new Set(['old']);
    var sandboxedSessions = new Map();
    var lastActivityTime = new Map(), ptyGenerations = new Map(), pendingOpens = new Map();
    function rekeyActivityState() {}
    function refreshSidebar() {} function updateTerminalHeader() {}
    var droppedPty = [];
    function dropLocalPtySession(id, via) { droppedPty.push([id, via]); }
    openSessions.set('old', { session: rows.find(row => row.sessionId === 'old') });
    activeSessionId = 'old';
  `, h.ctx, { filename: __filename });
  if (agents) h.ctx.activeSubagentsByParent.set('old', new Set(Array.from({ length: agents }, (_, n) => n)));
  if (existing) vm.runInContext("openSessions.set('new', { session: rows.find(row => row.sessionId === 'new'), attach: false });", h.ctx, { filename: __filename });
  const app = loadAppFunctions(h.ctx, { functions: ['sendSessionToBackground', 'harnessBackgroundReason', 'backgroundActionReason', 'rekeySessionEnvironment'] });
  return { ...h, app: { ...h.app, ...app }, calls, destroyed, notices, confirmations };
}

test('background handoff preserves panel, activity, spawn buffers and original conversation fields', async t => {
  const h = handoff(t);
  const entry = h.ctx.openSessions.get('old');
  Object.assign(entry.session, { name: 'JB title', starred: 1, archived: 1, summary: 'original', custom: 'retained' });
  h.ctx.lastActivityTime = new Map([['old', 123]]);
  h.ctx.ptyGenerations = new Map([['old', 7]]);
  h.ctx.pendingOpens = new Map([['old', ['buffered']]]);
  h.ctx.rekeyFilePanelState = (from, to) => { h.ctx.panelRekey = [from, to]; };
  h.ctx.rekeyPanelTerminalState = (from, to) => { h.ctx.shellRekey = [from, to]; };
  h.ctx.rekeyActivityState = (from, to) => { h.ctx.activityRekey = [from, to]; };
  await h.app.sendSessionToBackground('old');
  assert.deepEqual(h.ctx.panelRekey, ['old', 'new']);
  assert.deepEqual(h.ctx.shellRekey, ['old', 'new']);
  assert.deepEqual(h.ctx.activityRekey, ['old', 'new']);
  const session = h.ctx.openSessions.get('new').session;
  assert.equal(session.name, 'JB title');
  assert.equal(session.custom, 'retained');
  assert.equal(session.starred, 1);
  assert.equal(session.archived, 1);
  assert.equal(h.ctx.lastActivityTime.get('new'), 123);
  assert.equal(h.ctx.ptyGenerations.get('old'), undefined);
  assert.equal(h.ctx.pendingOpens.has('old'), false);
});

test('R1: success replaces the old tab with attach, follows the active tab and persists bg', async t => {
  const h = handoff(t);
  await h.app.sendSessionToBackground('old');
  assert.deepEqual(h.destroyed, ['old']);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.spawned[0].options)), { type: 'attach', jobId: '1234abcd', cwd: '/bg' });
  assert.equal(h.ctx.openSessions.get('new').bgRestore, true);
  assert.equal(h.ctx.activeSessionId, 'new');
  await h.app.persistWorkingSet();
  assert.equal(h.settings().openWorkingSet.find(row => row.sessionId === 'new').bg, true);
  assert.match(h.notices[0], /now runs in the background.*Closing this tab.*keeps running/);
});

test('R2: refusal keeps the old tab and shows the error', async t => {
  const h = handoff(t, { result: { ok: false, error: 'Send or clear the unsent text, then try again.' } });
  await h.app.sendSessionToBackground('old');
  assert.deepEqual(h.destroyed, []);
  assert.deepEqual(h.spawned, []);
  const notice = h.dom.window.document.querySelector('[role="alert"]');
  assert.equal(notice.querySelector('.app-notice-title').textContent, 'Could not send this session to the background.');
  assert.equal(notice.querySelector('.app-notice-body').textContent, 'Send or clear the unsent text, then try again.');
  assert.equal(notice.querySelector('details').open, false);
  assert.ok(notice.querySelector('details').textContent.includes('old'));
  assert.ok(notice.querySelector('details').textContent.includes(h.root));
});

test('R3: running subagents confirm before IPC; cancel sends nothing', async t => {
  const h = handoff(t, { agents: 2, answer: false });
  await h.app.sendSessionToBackground('old');
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0].message, /2 subagents.*may stop/);
  assert.equal(h.confirmations[0].confirmLabel, 'Send to background');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.destroyed, []);
});

test('R3b: accepting the subagent warning sends the handoff', async t => {
  const h = handoff(t, { agents: 1 });
  await h.app.sendSessionToBackground('old');
  assert.deepEqual(h.calls, ['old']);
});

test('R4: an existing non-attach target is destroyed before attaching once', async t => {
  const h = handoff(t, { existing: true });
  await h.app.sendSessionToBackground('old');
  assert.deepEqual(h.destroyed, ['old', 'new']);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.ctx.openSessions.get('new').attach, true);
});

test('R5: an inactive tab handoff does not steal the active tab', async t => {
  const h = handoff(t);
  h.ctx.activeSessionId = 'other';
  await h.app.sendSessionToBackground('old');
  assert.equal(h.ctx.activeSessionId, 'other');
});

test('R6: attach failure explains that the job runs and where to retry', async t => {
  const h = handoff(t);
  h.dom.window.api.openTerminal = async () => ({ ok: false, error: 'attach failed' });
  await h.app.sendSessionToBackground('old');
  assert.match(h.dom.window.document.querySelector('[role="alert"]').textContent, /Attach background.*attach failed.*sidebar/i);
  await h.app.persistWorkingSet();
  assert.equal(h.settings().openWorkingSet.find(row => row.sessionId === 'new')?.bg, true);
});

test('R7: renderer eligibility names closed, attach, remote, sandbox and plain-terminal refusals', t => {
  const h = handoff(t);
  for (const [change, expected] of [[{ attach: true }, /already/i], [{ session: { type: 'terminal' } }, /plain terminal/i], [{ session: { remoteAlias: 'host' } }, /remote/i], [{ closed: true }, /running|open/i]]) {
    h.ctx.openSessions.set('old', { session: { sessionId: 'old' }, ...change });
    assert.match(h.app.backgroundActionReason('old'), expected);
  }
  h.ctx.openSessions.set('old', { session: { sessionId: 'old' } });
  h.ctx.sandboxedSessions.set('old', true);
  assert.match(h.app.backgroundActionReason('old'), /sandbox/i);
});

test('R8: sidebar menu offers the action after Refresh, with refusal reasons and one eligible invocation', () => {
  const h = setupSidebarDom();
  try {
    const calls = [];
    h.window.sendSessionToBackground = id => calls.push(id);
    const session = { sessionId: 'old', projectPath: '/project', modified: new Date().toISOString() };
    h.window.sessionMap.set('old', session);
    h.sidebar.renderProjects([{ projectPath: '/project', sessions: [session] }]);
    const showMenu = () => h.document.querySelector('[data-session-id="old"]').dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    for (const state of ['closed', 'attach', 'sandbox', 'remote', 'plain', 'moving', 'eligible']) {
      h.window.openSessions.set('old', { session: { ...session, ...(state === 'remote' ? { remoteAlias: 'host' } : {}), ...(state === 'plain' ? { type: 'terminal' } : {}) }, attach: state === 'attach', backgrounding: state === 'moving' });
      h.window.activePtyIds.clear();
      if (state !== 'closed') h.window.activePtyIds.add('old');
      h.window.sandboxedSessions.clear();
      if (state === 'sandbox') h.window.sandboxedSessions.set('old', true);
      showMenu();
      const button = h.document.querySelector('.session-bg-btn');
      assert.ok(button);
      assert.equal(button.previousElementSibling.classList.contains('session-refresh-btn'), true);
      assert.equal(button.getAttribute('role'), 'menuitem');
      assert.equal(button.disabled, state !== 'eligible');
      if (button.disabled) assert.ok(button.title);
      else button.click();
    }
    assert.deepEqual(calls, ['old']);
  } finally { h.destroy(); }
});

test('R9: the shipped header action hides ineligible tabs and disables sandboxed and moving tabs', async t => {
  const h = handoff(t);
  const doc = h.dom.window.document;
  doc.body.innerHTML = '<button id="terminal-bg-btn"></button><button id="terminal-refresh-btn"></button>';
  h.ctx.terminalHeaderStatus = doc.createElement('span');
  h.ctx.terminalStopBtn = doc.createElement('button');
  h.ctx.paintTerminalHeaderStatus = () => {};
  h.ctx.lastSessionExit = () => null;
  h.ctx.updatePtyTitle = () => {};
  const app = loadAppFunctions(h.ctx, { functions: ['initTerminalBackgroundControl', 'updateTerminalHeader'] });
  app.initTerminalBackgroundControl();
  const button = doc.getElementById('terminal-bg-btn');
  const entry = h.ctx.openSessions.get('old');
  for (const state of ['eligible', 'sandbox', 'moving', 'attach', 'remote', 'plain', 'stopped']) {
    entry.attach = state === 'attach';
    entry.backgrounding = state === 'moving';
    entry.session = { sessionId: 'old', ...(state === 'remote' ? { remoteAlias: 'host' } : {}), ...(state === 'plain' ? { type: 'terminal' } : {}) };
    h.ctx.sandboxedSessions.clear();
    if (state === 'sandbox') h.ctx.sandboxedSessions.set('old', true);
    if (state === 'stopped') h.ctx.activePtyIds.delete('old');
    app.updateTerminalHeader();
    assert.equal(button.style.display, ['attach', 'remote', 'plain', 'stopped'].includes(state) ? 'none' : '');
    assert.equal(button.disabled, state !== 'eligible');
  }
  assert.equal(button.getAttribute('aria-disabled'), 'true');
});

test('R10: a merged source row cannot redirect the proven background attachment to another open member', async t => {
  const h = handoff(t);
  const old = h.ctx.openSessions.get('old');
  old.session = { ...old.session, mergedMemberIds: ['other'] };
  h.ctx.openSessions.set('other', { session: { sessionId: 'other' }, attach: false });
  await h.app.sendSessionToBackground('old');
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].id, 'new');
  assert.equal(h.ctx.activeSessionId, 'new');
  assert.equal(h.ctx.openSessions.has('other'), true);
});

test('R11: a replacement tab during IPC keeps its liveness and active selection', async t => {
  const h = handoff(t);
  const replacement = { session: { sessionId: 'old' } };
  h.dom.window.api.sendSessionToBackground = async () => {
    h.ctx.openSessions.set('old', replacement);
    return { ok: true, sessionId: 'new', jobId: '1234abcd', cwd: '/bg' };
  };
  await h.app.sendSessionToBackground('old');
  assert.equal(h.ctx.openSessions.get('old'), replacement);
  assert.equal(h.ctx.activePtyIds.has('old'), true);
  assert.equal(h.ctx.activeSessionId, 'old');
  assert.deepEqual(h.spawned, []);
  assert.match(h.notices[0], /now runs.*sidebar/);
});

test('R12: closing the source during IPC does not reopen a tab after the handoff', async t => {
  const h = handoff(t);
  h.dom.window.api.sendSessionToBackground = async () => {
    h.ctx.openSessions.delete('old');
    h.ctx.activeSessionId = null;
    return { ok: true, sessionId: 'new', jobId: '1234abcd', cwd: '/bg' };
  };
  await h.app.sendSessionToBackground('old');
  assert.equal(h.ctx.openSessions.size, 0);
  assert.deepEqual(h.spawned, []);
  assert.equal(h.ctx.activeSessionId, null);
});

test('R13: the proven job is saved while the attach spawn is still pending', async t => {
  const h = handoff(t);
  let started, release;
  const opening = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.dom.window.api.openTerminal = async () => { started(); await gate; return { ok: true }; };
  const pending = h.app.sendSessionToBackground('old');
  let timer;
  try {
    await Promise.race([opening, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('attach was not started')), 2000); })]);
    await h.app.persistWorkingSet();
    assert.equal(h.settings().openWorkingSet.find(row => row.sessionId === 'new')?.bg, true);
  } finally { clearTimeout(timer); release(); await pending; }
});

test('R14: success drops the old local PTY state, so its busy and running marks do not stick on an unrendered row', async t => {
  const h = handoff(t);
  await h.app.sendSessionToBackground('old');
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.droppedPty)), [['old', 'backgrounded']]);
  assert.equal(h.ctx.activePtyIds.has('old'), false);
});

test('R15: the attach tab takes the original tab position in openSessions', async t => {
  const h = handoff(t);
  const old = h.ctx.openSessions.get('old');
  h.ctx.openSessions.clear();
  h.ctx.openSessions.set('a', { session: { sessionId: 'a' } });
  h.ctx.openSessions.set('old', old);
  h.ctx.openSessions.set('b', { session: { sessionId: 'b' } });
  await h.app.sendSessionToBackground('old');
  assert.deepEqual([...h.ctx.openSessions.keys()], ['a', 'new', 'b']);
});


test('R-S2 GUARD same-id handoff attaches once at original tab position', async t => {
  const h = handoff(t, { result: { ok: true, sessionId: 'old', jobId: 'aaaaaaaa', cwd: '/bg' } });
  const before = [...h.ctx.openSessions.keys()];
  await h.app.sendSessionToBackground('old');
  assert.deepEqual(h.destroyed, ['old']);
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0].id, 'old');
  assert.equal(h.spawned[0].options.type, 'attach');
  assert.equal(h.spawned[0].options.jobId, 'aaaaaaaa');
  assert.deepEqual([...h.ctx.openSessions.keys()], before);
});

function harnessHeader(t, harnesses) {
  const h = handoff(t);
  const doc = h.dom.window.document;
  doc.body.innerHTML = '<button id="terminal-bg-btn"></button><button id="terminal-refresh-btn"></button>';
  h.ctx.terminalHeaderStatus = doc.createElement('span');
  h.ctx.terminalStopBtn = doc.createElement('button');
  h.ctx.paintTerminalHeaderStatus = () => {};
  h.ctx.lastSessionExit = () => null;
  h.ctx.updatePtyTitle = () => {};
  h.dom.window.api.getHarnesses = async () => harnesses;
  const app = loadAppFunctions(h.ctx, { functions: ['initTerminalBackgroundControl', 'updateTerminalHeader'] });
  app.initTerminalBackgroundControl();
  const show = session => {
    h.ctx.openSessions.get('old').session = { sessionId: 'old', ...session };
    app.updateTerminalHeader();
    return { reason: h.app.backgroundActionReason('old'), button: doc.getElementById('terminal-bg-btn') };
  };
  return { ...h, show };
}

const CLAUDE = { id: 'claude', label: 'Claude', capabilities: { bgJobs: true } };

test('R16: a Codex tab shows Send to background disabled with a reason naming the CLI; a Claude tab is unchanged', async t => {
  const h = harnessHeader(t, [CLAUDE, { id: 'codex', label: 'Codex', capabilities: { bgJobs: false } }]);
  await new Promise(resolve => setImmediate(resolve));
  const codex = h.show({ runtime: 'codex' });
  assert.equal(codex.reason, 'Codex sessions cannot be sent to the background');
  assert.equal(codex.button.style.display, '');
  assert.equal(codex.button.disabled, true);
  assert.equal(codex.button.getAttribute('aria-disabled'), 'true');
  assert.equal(codex.button.title, 'Codex sessions cannot be sent to the background');
  for (const session of [{ runtime: 'claude' }, {}]) {
    const claude = h.show(session);
    assert.equal(claude.reason, null);
    assert.equal(claude.button.style.display, '');
    assert.equal(claude.button.disabled, false);
    assert.match(claude.button.title, /^Send to background/);
  }
});

test('R17: the renderer reads the harness capability, not the runtime name', async t => {
  const h = harnessHeader(t, [CLAUDE, { id: 'codex', label: 'Codex', capabilities: { bgJobs: true } }, { id: 'other', label: 'Other CLI', capabilities: { bgJobs: false } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.show({ runtime: 'codex' }).reason, null);
  const other = h.show({ runtime: 'other' });
  assert.equal(other.reason, 'Other CLI sessions cannot be sent to the background');
  assert.equal(other.button.disabled, true);
});

test('R18: the exit dialog names the CLI for a Codex tab main refuses as unreadable; a Claude tab keeps the reason from main', async t => {
  const h = harnessHeader(t, [CLAUDE, { id: 'codex', label: 'Codex', capabilities: { bgJobs: false } }]);
  await new Promise(resolve => setImmediate(resolve));
  const exit = loadAppFunctions(h.ctx, { sourcePath: path.join(__dirname, '..', 'public', 'file-panel.js'), functions: ['exitBackgroundRows', 'confirmSessionExit'] });
  const dialog = async runtime => {
    h.show({ runtime });
    const snapshot = inventory(new Map([['old', { kind: 'local-pty', runtime, pty: {}, cwd: '/repo' }]]), record => backgroundRefusal(record, undefined));
    assert.equal(snapshot.rows[0].background, 'refused');
    assert.match(snapshot.rows[0].reason, /cannot read this session/);
    let options;
    h.ctx.showChoiceDialog = async o => { options = o; return null; };
    await exit.confirmSessionExit({ action: 'quit', snapshot });
    assert.equal(options.secondaryAction, null);
    return options.message.join('\n');
  };
  const codex = await dialog('codex');
  assert.match(codex, /Codex sessions cannot be sent to the background/);
  assert.doesNotMatch(codex, /cannot read this session/);
  assert.match(await dialog('claude'), /cannot read this session/);
});

for (const stopError of [false, true]) {
  test('#1295 r2 user Cancel stays quiet; stop errors stay visible: ' + stopError, async t => {
    const h = handoff(t, { result: { ok: false, code: stopError ? 'cancelled' : 'declined', error: stopError ? 'Could not stop old job' : 'Cancelled', stopError } });
    await h.app.sendSessionToBackground('old');
    assert.equal(!!h.dom.window.document.querySelector('[role="alert"]'), stopError, 'only a stop failure should show an error');
    assert.deepEqual(h.destroyed, []);
    assert.deepEqual(h.spawned, []);
  });
}

function continuationDialogs(t) {
  const h = setupSidebarDom();
  t.after(() => h.destroy());
  let receive, cancel;
  const shown = [], answers = [];
  Object.assign(h.window.api, {
    onBgContinuationChoice: fn => { receive = fn; },
    onBgContinuationChoiceCancel: fn => { cancel = fn; },
    showBgContinuationChoice: token => shown.push(token),
    answerBgContinuationChoice: (...args) => answers.push(args),
  });
  h.window.openSessions = new Map([['tab', { session: { sessionId: 'tab', name: 'Harness' } }]]);
  h.window.sessionMap = new Map();
  loadAppFunctions(h.context, { functions: ['initExitBackgroundControl'] }).initExitBackgroundControl();
  const ask = token => receive(token, 'tab', [{ id: 'adb1224f', name: 'Old harness', sessionId: 'prior' }]);
  return { ...h, ask, cancel: token => cancel?.(token), shown, answers };
}

test('#1295 r2 only displayed continuation dialogs acknowledge showing', async t => {
  const h = continuationDialogs(t);
  const first = h.ask('one'), second = h.ask('two');
  assert.deepEqual(h.shown, ['one'], 'queued dialogs must not start their timeout');
  h.window.document.querySelector('.choice-dialog-cancel').click();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.shown, ['one', 'two']);
  h.window.document.querySelector('.choice-dialog-cancel').click();
  await second;
});

for (const which of ['queued', 'open']) {
  test('#1295 r2 main cancellation removes the ' + which + ' continuation dialog', async t => {
    const h = continuationDialogs(t);
    const first = h.ask('one');
    const second = which === 'queued' ? h.ask('two') : null;
    h.cancel(which === 'queued' ? 'two' : 'one');
    await new Promise(resolve => setImmediate(resolve));
    if (which === 'queued') h.window.document.querySelector('.choice-dialog-cancel').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.window.document.querySelector('.choice-dialog-overlay'), null, 'cancelled questions must never remain or reopen');
    await first;
    if (second) await second;
    assert.equal(h.answers.some(([token]) => token === (which === 'queued' ? 'two' : 'one')), false, 'main cancellation must not send a stale answer');
  });
}

test('#1295 r2 continuation dialog leads with a short plain sentence', async t => {
  const h = continuationDialogs(t);
  const pending = h.ask('one');
  const doc = h.window.document;
  assert.equal(doc.querySelector('.choice-dialog-body p').textContent, 'An older background job may still be running.');
  assert.match(doc.querySelectorAll('.choice-dialog-body p')[1].textContent, /Harness/);
  assert.match(doc.querySelectorAll('.choice-dialog-body p')[2].textContent, /Old harness.*adb1224f/);
  assert.equal(doc.querySelector('#choice-dialog-title').textContent, 'Choose what to do with the old background job.');
  for (const detail of doc.querySelectorAll('.choice-dialog-detail')) {
    assert.ok(detail.textContent.length < 110, 'option descriptions stay short');
    assert.equal(detail.textContent.split('.').filter(Boolean).length, 1, 'one sentence per option');
  }
  doc.querySelector('.choice-dialog-cancel').click();
  await pending;
});

for (const error of ['Claude cancelled it: tool still running', 'Send or clear the unsent text, then try again.', 'Background ownership could not be rechecked.']) {
  test('#1295 N1 cancellation failure remains visible: ' + error, async t => {
    const h = handoff(t, { result: { ok: false, code: 'cancelled', error } });
    await h.app.sendSessionToBackground('old');
    const alert = h.dom.window.document.querySelector('[role="alert"]');
    assert.ok(alert, 'non-declined cancellation must raise a failure notice');
    assert.ok(alert.textContent.includes(error));
    assert.deepEqual(h.destroyed, []);
    assert.deepEqual(h.spawned, []);
    const { exitBackgroundFailure } = loadAppFunctions(h.ctx, { functions: ['exitBackgroundFailure'] });
    assert.equal(exitBackgroundFailure('Session', { code: 'cancelled', error }), 'Session: ' + error);
  });
}

test('#1295 N1 exit failure describes declined like user Cancel', t => {
  const h = handoff(t);
  const { exitBackgroundFailure } = loadAppFunctions(h.ctx, { functions: ['exitBackgroundFailure'] });
  assert.equal(exitBackgroundFailure('Session', { code: 'declined' }), 'Session: Moving was cancelled.');
});

for (const answer of [false, true]) {
  test('busy handoff explains interruption and preserves the force choice: ' + answer, async t => {
    const h = handoff(t, { answer });
    const calls = [];
    h.dom.window.api.sendSessionToBackground = async (id, options) => {
      calls.push([id, options]);
      return options?.force ? { ok: false, code: 'declined' } : { ok: false, code: 'busy' };
    };
    await h.app.sendSessionToBackground('old');
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.confirmations[0].title, 'Sending now stops the running command.');
    assert.equal(h.confirmations[0].message, 'Claude ends this turn in the background. To avoid this, cancel and send again when Claude is idle.');
    assert.equal(h.confirmations[0].confirmLabel, 'Send now');
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), answer ? [['old', null], ['old', { force: true }]] : [['old', null]]);
    assert.deepEqual(h.destroyed, []);
    assert.deepEqual(h.spawned, []);
  });
}

test('awaited-answer refusal reaches the notice body without identifiers in the title', async t => {
  const error = backgroundRefusal({ kind: 'local-pty', composerState: { pending: 0 } }, 'waiting');
  const h = handoff(t, { result: { ok: false, code: 'refused', error } });
  await h.app.sendSessionToBackground('old');
  const notice = h.dom.window.document.querySelector('[role="alert"]');
  assert.equal(notice.querySelector('.app-notice-title').textContent, 'Could not send this session to the background.');
  assert.equal(notice.querySelector('.app-notice-body').textContent, 'Answer Claude in the terminal, then try again.');
  assert.deepEqual(h.destroyed, []);
  assert.deepEqual(h.spawned, []);
});
