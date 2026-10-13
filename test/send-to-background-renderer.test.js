'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { setup } = require('./continuations-harness');
const { loadAppFunctions } = require('./app-source');
const { setupSidebarDom } = require('./dom-setup');

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
    function refreshSidebar() {} function updateTerminalHeader() {}
    openSessions.set('old', { session: rows.find(row => row.sessionId === 'old') });
    activeSessionId = 'old';
  `, h.ctx, { filename: __filename });
  if (agents) h.ctx.activeSubagentsByParent.set('old', new Set(Array.from({ length: agents }, (_, n) => n)));
  if (existing) vm.runInContext("openSessions.set('new', { session: rows.find(row => row.sessionId === 'new'), attach: false });", h.ctx, { filename: __filename });
  const app = loadAppFunctions(h.ctx, { functions: ['sendSessionToBackground', 'backgroundActionReason'] });
  return { ...h, app: { ...h.app, ...app }, calls, destroyed, notices, confirmations };
}

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
  const h = handoff(t, { result: { ok: false, error: 'The prompt holds text you have not sent.' } });
  await h.app.sendSessionToBackground('old');
  assert.deepEqual(h.destroyed, []);
  assert.deepEqual(h.spawned, []);
  assert.match(h.notices[0], /not sent/i);
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
  assert.match(h.notices[0], /background.*attaching failed.*sidebar/i);
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
  h.ctx.terminalStatusLabel = () => 'Running';
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
