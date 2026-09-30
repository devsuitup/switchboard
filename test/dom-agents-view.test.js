// test/dom-agents-view.test.js — the agents view rendered in jsdom. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const HTML = `<!DOCTYPE html><html><body>
  <div id="placeholder"></div>
  <div id="terminal-area"><div id="terminal-header"></div><div id="grid-viewer"></div><div id="terminals"></div></div>
  <div id="stats-viewer"></div><div id="memory-viewer"></div><div id="work-files-viewer"></div><div id="jsonl-viewer"></div>
  <div id="settings-viewer"><div id="settings-viewer-title"></div><div id="settings-viewer-body"></div></div>
  <div id="memory-content"></div><div id="work-files-content"></div>
  <div id="agents-viewer" style="display:none;">
    <div id="agents-viewer-header"><span id="agents-viewer-title">Agents</span><span id="agents-viewer-count"></span>
      <label id="agents-finished-toggle"><input type="checkbox" id="agents-show-finished" checked> Finished</label>
      <button id="agents-new-btn" type="button">New agent</button></div>
    <div id="agents-viewer-banner" style="display:none;"></div>
    <div id="agents-viewer-body"><div id="agents-list"></div><div id="agents-detail"></div></div>
  </div>
  <div id="sidebar-filters"><button id="resort-btn"></button></div>
</body></html>`;

function evalFile(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

function setup({ storage = {}, settingsPanel = false } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const calls = { verbs: [], opened: [], jsonl: [], external: [], stopped: [], shown: [], sidebarRefreshes: 0, fetches: 0 };
  let changedCb = null;
  let snapshot = { roster: [], daemonReachable: true };
  window.api = {
    getBgAgents: async () => { calls.fetches++; return snapshot; },
    bgAgentVerb: async (verb, id) => { calls.verbs.push([verb, id]); return { ok: verb !== 'rm', error: verb === 'rm' ? 'nope' : undefined }; },
    onBgAgentsChanged: (cb) => { changedCb = cb; },
    openExternal: async (href) => calls.external.push(href),
    stopSession: async (id) => { calls.stopped.push(id); return { ok: true }; },
    readMemory: async () => 'memory text',
    readWorkFile: async () => 'work file text',
    getSetting: async () => ({}),
    setSetting: async () => ({ ok: true }),
    getShellProfiles: async () => [],
    getAppVersion: async () => '0.0.0',
    onUpdaterEvent: () => {},
    platform: 'linux',
  };
  const g = {
    placeholder: window.document.getElementById('placeholder'),
    terminalArea: window.document.getElementById('terminal-area'),
    terminalHeader: window.document.getElementById('terminal-header'),
    gridViewer: window.document.getElementById('grid-viewer'),
    statsViewer: window.document.getElementById('stats-viewer'),
    memoryViewer: window.document.getElementById('memory-viewer'),
    workFilesViewer: window.document.getElementById('work-files-viewer'),
    settingsViewer: window.document.getElementById('settings-viewer'),
    jsonlViewer: window.document.getElementById('jsonl-viewer'),
    resortBtn: window.document.getElementById('resort-btn'),
    memoryContent: window.document.getElementById('memory-content'),
    workFilesContent: window.document.getElementById('work-files-content'),
    CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
    memoryPanel: { open: () => {} },
    workFilesPanel: { open: () => {} },
    openSessions: new Map(),
    sessionMap: new Map(),
    activeSessionId: null,
    gridViewActive: false,
    showSession: (id) => calls.shown.push(id),
    openSession: (session, opts) => calls.opened.push([session, opts]),
    showJsonlViewer: (session) => calls.jsonl.push(session),
    refreshSidebar: () => { calls.sidebarRefreshes++; },
    fitAndScroll: () => {},
    confirm: () => true,
  };
  for (const [k, v] of Object.entries(g)) Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.js'), 'utf8'), dom.getInternalVMContext());
  evalFile(dom, path.join(PUBLIC, 'utils.js'));
  evalFile(dom, path.join(PUBLIC, 'session-state.js'));
  evalFile(dom, path.join(PUBLIC, 'memory-workfiles-view.js'));
  evalFile(dom, path.join(PUBLIC, 'agents-view.js'));
  if (settingsPanel) {
    evalFile(dom, path.join(PUBLIC, 'setting-defaults.js'));
    evalFile(dom, path.join(PUBLIC, 'shortcuts.js'));
    evalFile(dom, path.join(PUBLIC, 'terminal-themes.js'));
    evalFile(dom, path.join(PUBLIC, 'settings-panel.js'));
  }
  window.initAgentsView();
  const read = (expr) => vm.runInContext(expr, dom.getInternalVMContext());
  return {
    window, document: window.document, calls, read,
    setSnapshot(s) { snapshot = s; },
    emitChanged(s) { snapshot = s; changedCb(s); },
    destroy() { window.close(); },
  };
}

const ROSTER = [
  { id: 'aaaaaaaa', sessionId: 's-a', name: 'em-platform', cwd: '/w/em', kind: 'background', state: 'working', status: 'idle', pid: 10, startedAt: Date.now() - 60_000, agent: 'fleet:em', model: 'sonnet', detail: 'awaiting !196', tempo: 'idle', tokens: 173000, fan: [{ id: 'f', kind: 'agent', label: 'Spawn developer', startedAt: 1, doneAt: 27_000 }], children: [{ id: '195', href: 'https://gitlab.example/mr/195', kind: 'mr' }], result: 'no action', attachedHere: false },
  { id: 'bbbbbbbb', sessionId: 's-b', name: 'spike', cwd: '/w/f', kind: 'background', state: 'done', status: null, pid: null, startedAt: Date.now() - 3_600_000, agent: null, model: null, detail: null, tempo: null, tokens: 274, fan: [], children: [], result: null, attachedHere: false },
  { id: null, sessionId: 's-i', name: 'lvds-1b', cwd: '/w/l', kind: 'interactive', state: null, status: 'busy', pid: 30, startedAt: Date.now() - 10_000, agent: null, model: null, detail: null, tempo: null, tokens: null, fan: [], children: [], result: null, attachedHere: false },
];

test('showing the view hides the terminal area, lists the roster sorted, and counts running/finished', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.window.terminalArea.style.display, 'none');
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'flex');
  assert.equal(ctx.read('agentsViewActive'), true);
  const names = [...ctx.document.querySelectorAll('.agents-row-name')].map(el => el.textContent);
  assert.deepEqual(names, ['lvds-1b', 'em-platform', 'spike']);
  assert.equal(ctx.document.getElementById('agents-viewer-count').textContent, '1 running · 1 finished');
  assert.equal(ctx.document.getElementById('agents-viewer-banner').style.display, 'none');
  assert.equal(ctx.window.localStorage.getItem('agentsViewActive'), '1');
});

test('the Finished filter hides done and stopped jobs and is remembered', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  const box = ctx.document.getElementById('agents-show-finished');
  box.checked = false;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  assert.deepEqual([...ctx.document.querySelectorAll('.agents-row-name')].map(el => el.textContent), ['lvds-1b', 'em-platform']);
  assert.equal(ctx.window.localStorage.getItem('agentsShowFinished'), '0');
});

test('selecting a row renders its detail with the verbs disabled by state, and a roster update keeps the selection', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  const detail = ctx.document.getElementById('agents-detail');
  assert.match(detail.textContent, /awaiting !196/);
  assert.match(detail.textContent, /173k tokens/);
  assert.match(detail.textContent, /Spawn developer/);
  assert.equal(detail.querySelector('[data-verb="rm"]').disabled, true);
  assert.equal(detail.querySelector('[data-verb="stop"]').disabled, false);
  assert.equal(detail.querySelector('[data-verb="attach"]').disabled, false);
  ctx.emitChanged({ roster: [{ ...ROSTER[0], detail: 'changed' }, ROSTER[1], ROSTER[2]], daemonReachable: true });
  assert.match(ctx.document.getElementById('agents-detail').textContent, /changed/);
  assert.ok(ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').classList.contains('selected'));
});

test('the verbs: attach opens a tab keyed by the session id, transcript opens the viewer, stop calls the IPC, a failure shows in the detail', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  const detail = ctx.document.getElementById('agents-detail');
  detail.querySelector('[data-verb="attach"]').click();
  assert.equal(ctx.calls.opened.length, 1);
  assert.equal(ctx.calls.opened[0][0].sessionId, 's-a');
  assert.deepEqual({ ...ctx.calls.opened[0][1] }, { type: 'attach', jobId: 'aaaaaaaa', cwd: '/w/em' });
  detail.querySelector('[data-verb="transcript"]').click();
  assert.equal(ctx.calls.jsonl[0].sessionId, 's-a');
  await ctx.window.runAgentVerb('stop', ROSTER[0]);
  assert.deepEqual(ctx.calls.verbs, [['stop', 'aaaaaaaa']]);
  ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]').click();
  await ctx.window.runAgentVerb('rm', ROSTER[1]);
  assert.match(ctx.document.getElementById('agents-detail').textContent, /nope/);
});

test('stop on a session attached here detaches the tab first', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  await ctx.window.showAgentsView();
  await ctx.window.runAgentVerb('stop', { ...ROSTER[0], attachedHere: true });
  assert.deepEqual(ctx.calls.stopped, ['s-a']);
  assert.deepEqual(ctx.calls.verbs, [['stop', 'aaaaaaaa']]);
});

test('an unreachable daemon shows the banner and disables every verb but Transcript; an empty roster shows the empty state', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: false });
  await ctx.window.showAgentsView();
  assert.notEqual(ctx.document.getElementById('agents-viewer-banner').style.display, 'none');
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  const detail = ctx.document.getElementById('agents-detail');
  assert.equal(detail.querySelector('[data-verb="stop"]').disabled, true);
  assert.equal(detail.querySelector('[data-verb="transcript"]').disabled, false);
  ctx.emitChanged({ roster: [], daemonReachable: true });
  assert.match(ctx.document.getElementById('agents-list').textContent, /No background agents/);
});

test('hideAllViewers closes the view without restoring the terminal; hideAgentsView restores it', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.window.activeSessionId = 'open-1';
  ctx.window.openSessions.set('open-1', { closed: false });
  await ctx.window.showAgentsView();
  ctx.window.hideAllViewers();
  assert.equal(ctx.read('agentsViewActive'), false);
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'none');
  assert.deepEqual(ctx.calls.shown, [], 'no restore from hideAllViewers');
  await ctx.window.showAgentsView();
  ctx.window.hideAgentsView();
  assert.deepEqual(ctx.calls.shown, ['open-1']);
  assert.equal(ctx.window.terminalArea.style.display, '');
});

test('a roster push updates bgAgentSessionIds and refreshes the sidebar only when the set changes', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.emitChanged({ roster: ROSTER, daemonReachable: true });
  assert.deepEqual([...ctx.read('bgAgentSessionIds')].sort(), ['s-a', 's-b']);
  assert.equal(ctx.calls.sidebarRefreshes, 1);
  ctx.emitChanged({ roster: ROSTER, daemonReachable: true });
  assert.equal(ctx.calls.sidebarRefreshes, 1);
});

test('no roster fetch before the view is first opened; opening it fetches', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  assert.equal(ctx.calls.fetches, 0);
  await ctx.window.showAgentsView();
  assert.equal(ctx.calls.fetches, 1);
});

test('attach from the view while the grid is shown closes the view onto the grid', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  ctx.window.gridViewActive = true;
  ctx.window.attachBgAgent(ROSTER[0]);
  assert.equal(ctx.read('agentsViewActive'), false);
  assert.equal(ctx.window.gridViewer.style.display, 'block');
  assert.equal(ctx.calls.opened.length, 1);
});

test('a blocked job counts as running, sorts with the live rows and keeps only the live verbs', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const blocked = { ...ROSTER[0], id: 'cccccccc', sessionId: 's-c', name: 'asks', state: 'blocked', status: 'waiting', startedAt: Date.now() - 5_000 };
  ctx.setSnapshot({ roster: [...ROSTER, blocked], daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.deepEqual([...ctx.document.querySelectorAll('.agents-row-name')].map(el => el.textContent), ['asks', 'lvds-1b', 'em-platform', 'spike']);
  assert.equal(ctx.document.getElementById('agents-viewer-count').textContent, '2 running · 1 finished');
  const box = ctx.document.getElementById('agents-show-finished');
  box.checked = false;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  ctx.document.querySelector('.agents-row[data-key="bg:cccccccc"]').click();
  const detail = ctx.document.getElementById('agents-detail');
  assert.equal(detail.querySelector('[data-verb="attach"]').disabled, false);
  assert.equal(detail.querySelector('[data-verb="stop"]').disabled, false);
  assert.equal(detail.querySelector('[data-verb="respawn"]').disabled, true);
  assert.equal(detail.querySelector('[data-verb="rm"]').disabled, true);
  detail.querySelector('[data-verb="attach"]').click();
  assert.deepEqual({ ...ctx.calls.opened[0][1] }, { type: 'attach', jobId: 'cccccccc', cwd: '/w/em' });
});

test('hiding a view that is not open leaves the persisted flag untouched', (t) => {
  const ctx = setup({ storage: { agentsViewActive: '1' } }); t.after(() => ctx.destroy());
  ctx.window.hideAllViewers();
  ctx.window.hideAgentsView({ restore: false });
  ctx.window.hideAgentsView();
  assert.equal(ctx.window.localStorage.getItem('agentsViewActive'), '1');
});

test('a view open at the last run is reopened after the startup restore showed a session and the grid', async (t) => {
  const ctx = setup({ storage: { agentsViewActive: '1' } }); t.after(() => ctx.destroy());
  ctx.window.hideAgentsView({ restore: false });
  ctx.window.hideAllViewers();
  ctx.window.localStorage.setItem('agentsViewActive', '0');
  await ctx.window.restoreAgentsViewAtStartup();
  assert.equal(ctx.read('agentsViewActive'), true);
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'flex');
  assert.equal(ctx.window.localStorage.getItem('agentsViewActive'), '1');
});

test('a view closed at the last run stays closed after the startup restore', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  await ctx.window.restoreAgentsViewAtStartup();
  assert.equal(ctx.read('agentsViewActive'), false);
  assert.equal(ctx.calls.fetches, 0);
});

test('opening a memory file closes the agents view', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  await ctx.window.showAgentsView();
  await ctx.window.openMemory({ filePath: '/m/a.md', filename: 'a.md' });
  assert.equal(ctx.read('agentsViewActive'), false);
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'none');
  assert.equal(ctx.window.memoryViewer.style.display, 'flex');
});

test('opening a work file closes the agents view', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  await ctx.window.showAgentsView();
  await ctx.window.openWorkFile({ filePath: '/w/.work-files/a.md', filename: 'a.md' });
  assert.equal(ctx.read('agentsViewActive'), false);
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'none');
  assert.equal(ctx.window.workFilesViewer.style.display, 'flex');
});

test('opening the settings closes the agents view', async (t) => {
  const ctx = setup({ settingsPanel: true }); t.after(() => ctx.destroy());
  await ctx.window.showAgentsView();
  await ctx.window.openSettingsViewer('global');
  assert.equal(ctx.read('agentsViewActive'), false);
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'none');
  assert.equal(ctx.window.settingsViewer.style.display, 'flex');
});
