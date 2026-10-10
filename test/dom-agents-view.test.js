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
      <label id="agents-group-toggle">Group <select id="agents-group-by"><option value="none">None</option><option value="state" selected>State</option><option value="project">Project</option></select></label>
      <label id="agents-worktrees-toggle" title="Sub-group each project by worktree"><input type="checkbox" id="agents-group-worktrees" checked> Worktrees</label>
      <button id="agents-new-btn" type="button">New agent</button></div>
    <div id="agents-viewer-banner" style="display:none;"></div>
    <div id="agents-viewer-body"><div id="agents-list"></div><div id="agents-detail"></div></div>
  </div>
  <div id="sidebar-filters"><button id="resort-btn"></button></div>
</body></html>`;

function evalFile(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

function setup({ storage = { agentsGroupBy: 'none' }, settingsPanel = false } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const calls = { verbs: [], opened: [], jsonl: [], external: [], stopped: [], shown: [], sidebarRefreshes: 0, fetches: 0 };
  let changedCb = null;
  let snapshot = { roster: [], daemonReachable: true };
  window.api = {
    getBgAgents: async () => { calls.fetches++; return snapshot; },
    bgAgentVerb: async (verb, id) => { calls.verbs.push([verb, id]); return { ok: verb !== 'rm', sessionId: verb === 'transcript' ? ROSTER.find(e => e.id === id)?.sessionId : undefined, error: verb === 'rm' ? 'nope' : undefined }; },
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

test('the verbs: attach opens a tab keyed by the session id, transcript opens the viewer, stop calls the IPC, a failure shows in the detail', { timeout: 9000 }, async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  const detail = ctx.document.getElementById('agents-detail');
  detail.querySelector('[data-verb="attach"]').click();
  assert.equal(ctx.calls.opened.length, 1);
  assert.equal(ctx.calls.opened[0][0].sessionId, 's-a');
  assert.deepEqual({ ...ctx.calls.opened[0][1] }, { type: 'attach', jobId: 'aaaaaaaa', cwd: '/w/em' });
  const viewed = new Promise(resolve => {
    const show = ctx.window.showJsonlViewer;
    ctx.window.showJsonlViewer = session => { show(session); resolve(); };
  });
  detail.querySelector('[data-verb="transcript"]').click();
  await viewed;
  assert.equal(ctx.calls.jsonl[0].sessionId, 's-a');
  await ctx.window.runAgentVerb('stop', ROSTER[0]);
  assert.deepEqual(ctx.calls.verbs, [['transcript', 'aaaaaaaa'], ['stop', 'aaaaaaaa']]);
  ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]').click();
  await ctx.window.runAgentVerb('rm', ROSTER[1]);
  assert.match(ctx.document.getElementById('agents-detail').textContent, /nope/);
});

test('stop on a session attached here detaches the tab after daemon success', async (t) => {
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

test('a roster push puts only the live jobs in bgAgentSessionIds and refreshes the sidebar only when the set changes', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.emitChanged({ roster: ROSTER, daemonReachable: true });
  assert.deepEqual([...ctx.read('bgAgentSessionIds')].sort(), ['s-a']);
  assert.equal(ctx.calls.sidebarRefreshes, 1);
  ctx.emitChanged({ roster: ROSTER, daemonReachable: true });
  assert.equal(ctx.calls.sidebarRefreshes, 1);
  ctx.emitChanged({ roster: [ROSTER[0], { ...ROSTER[1], state: 'blocked' }, ROSTER[2]], daemonReachable: true });
  assert.deepEqual([...ctx.read('bgAgentSessionIds')].sort(), ['s-a', 's-b']);
  assert.equal(ctx.calls.sidebarRefreshes, 2);
  ctx.emitChanged({ roster: [{ ...ROSTER[0], state: 'done' }, ROSTER[1], ROSTER[2]], daemonReachable: true });
  assert.deepEqual([...ctx.read('bgAgentSessionIds')], []);
  assert.equal(ctx.calls.sidebarRefreshes, 3);
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

test('a failed job reads "failed", counts as finished and is hidden by the Finished filter', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const failed = { ...ROSTER[1], id: 'ffffffff', sessionId: 's-f', name: 'broke', state: 'failed' };
  ctx.setSnapshot({ roster: [...ROSTER, failed], daemonReachable: true });
  await ctx.window.showAgentsView();
  const row = ctx.document.querySelector('.agents-row[data-key="bg:ffffffff"]');
  assert.equal(row.querySelector('.agents-row-state').textContent, '❌ failed');
  assert.equal(ctx.document.getElementById('agents-viewer-count').textContent, '1 running · 2 finished');
  row.click();
  const detail = ctx.document.getElementById('agents-detail');
  assert.equal(detail.querySelector('[data-verb="rm"]').disabled, false);
  assert.equal(detail.querySelector('[data-verb="respawn"]').disabled, false);
  assert.equal(detail.querySelector('[data-verb="attach"]').disabled, true);
  const box = ctx.document.getElementById('agents-show-finished');
  box.checked = false;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  assert.equal(ctx.document.querySelector('.agents-row[data-key="bg:ffffffff"]'), null);
});

function chooseGroupBy(ctx, mode) {
  const sel = ctx.document.getElementById('agents-group-by');
  sel.value = mode;
  sel.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
}

function headText(el) {
  return el.textContent.replace(/^[▾▸] /, '');
}

function listLayout(ctx) {
  return [...ctx.document.getElementById('agents-list').children].map(el =>
    el.classList.contains('agents-group-header') ? '# ' + headText(el)
      : el.classList.contains('agents-subgroup-header') ? '## ' + headText(el)
        : el.querySelector('.agents-row-name').textContent);
}

test('group by state: a header per non-empty group with its count, each row once, no header without the mode', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const failed = { ...ROSTER[1], id: 'ffffffff', sessionId: 's-f', name: 'broke', state: 'failed' };
  ctx.setSnapshot({ roster: [...ROSTER, failed], daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.document.querySelectorAll('.agents-group-header').length, 0);
  chooseGroupBy(ctx, 'state');
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Working · 1', 'em-platform', '# ✅ Done · 1', 'spike', '# ❌ Failed · 1', 'broke', '# 🖥️ External · 1', 'lvds-1b']);
  assert.equal(ctx.document.querySelectorAll('.agents-row').length, 4);
  assert.equal(ctx.window.localStorage.getItem('agentsGroupBy'), 'state');
  chooseGroupBy(ctx, 'none');
  assert.deepEqual(listLayout(ctx), ['lvds-1b', 'em-platform', 'spike', 'broke']);
});

test('group by project: headers labelled by the last segment with the full path as title, live groups first', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const second = { ...ROSTER[0], id: 'cccccccc', sessionId: 's-c', name: 'em-two', state: 'done', startedAt: Date.now() - 120_000 };
  const homeless = { ...ROSTER[1], id: 'dddddddd', sessionId: 's-d', name: 'nowhere', cwd: null };
  ctx.setSnapshot({ roster: [...ROSTER, second, homeless], daemonReachable: true });
  await ctx.window.showAgentsView();
  chooseGroupBy(ctx, 'project');
  assert.deepEqual(listLayout(ctx), ['# em · 2', 'em-platform', 'em-two', '# l · 1', 'lvds-1b', '# f · 1', 'spike', '# No project · 1', 'nowhere']);
  const head = ctx.document.querySelector('.agents-group-header');
  assert.equal(head.getAttribute('title'), '/w/em');
  assert.equal(ctx.window.localStorage.getItem('agentsGroupBy'), 'project');
});

test('the Finished filter applies before grouping: a group left empty is not shown', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  chooseGroupBy(ctx, 'state');
  const box = ctx.document.getElementById('agents-show-finished');
  box.checked = false;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Working · 1', 'em-platform', '# 🖥️ External · 1', 'lvds-1b']);
  ctx.emitChanged({ roster: [], daemonReachable: true });
  assert.equal(ctx.document.querySelectorAll('.agents-group-header').length, 0);
  assert.match(ctx.document.getElementById('agents-list').textContent, /No background agents/);
});

test('the selected row stays selected across a regroup, and a click on a header toggles it without selecting a row', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]').click();
  chooseGroupBy(ctx, 'project');
  assert.ok(ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]').classList.contains('selected'));
  chooseGroupBy(ctx, 'state');
  assert.ok(ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]').classList.contains('selected'));
  ctx.document.querySelector('.agents-group-header').click();
  assert.equal(ctx.document.querySelector('.agents-group-header').getAttribute('aria-expanded'), 'false');
  assert.equal(ctx.read('agentsSelectedKey'), 'bg:bbbbbbbb');
  assert.equal(ctx.document.querySelectorAll('.agents-row.selected').length, 1);
  assert.match(ctx.document.getElementById('agents-detail').textContent, /spike/);
  assert.equal(ctx.calls.verbs.length, 0);
});

function header(ctx, collapseKey) {
  return [...ctx.document.querySelectorAll('[data-collapse]')].find(h => h.dataset.collapse === collapseKey);
}

function storedCollapsed(ctx) {
  return JSON.parse(ctx.window.localStorage.getItem('agentsCollapsedGroups') || '[]');
}

test('collapse: a header click folds its rows, keeps label and count, flips the chevron and aria-expanded, and is remembered', async (t) => {
  const ctx = setup({ storage: {} }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  const done = header(ctx, 'state:done');
  assert.equal(done.getAttribute('role'), 'button');
  assert.equal(done.getAttribute('tabindex'), '0');
  assert.equal(done.getAttribute('aria-expanded'), 'true');
  assert.equal(done.querySelector('.agents-group-chevron').textContent, '▾');
  assert.equal(done.querySelector('.agents-group-chevron').getAttribute('aria-hidden'), 'true');
  done.click();
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Working · 1', 'em-platform', '# ✅ Done · 1', '# 🖥️ External · 1', 'lvds-1b']);
  const folded = header(ctx, 'state:done');
  assert.equal(folded.getAttribute('aria-expanded'), 'false');
  assert.equal(folded.querySelector('.agents-group-chevron').textContent, '▸');
  assert.deepEqual(storedCollapsed(ctx), ['state:done']);
  folded.click();
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Working · 1', 'em-platform', '# ✅ Done · 1', 'spike', '# 🖥️ External · 1', 'lvds-1b']);
  assert.deepEqual(storedCollapsed(ctx), []);
});

test('collapse: Enter and Space on a focused header toggle it', async (t) => {
  const ctx = setup({ storage: {} }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  const key = (k) => {
    const ev = new ctx.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    header(ctx, 'state:working').dispatchEvent(ev);
    return ev;
  };
  const ev = key('Enter');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(header(ctx, 'state:working').getAttribute('aria-expanded'), 'false');
  key(' ');
  assert.equal(header(ctx, 'state:working').getAttribute('aria-expanded'), 'true');
  key('a');
  assert.equal(header(ctx, 'state:working').getAttribute('aria-expanded'), 'true');
});

test('collapse: restored from storage, survives a roster push, a mode switch and the Finished filter; selection kept', async (t) => {
  const ctx = setup({ storage: { agentsCollapsedGroups: '["state:done"]' } }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]'), null);
  assert.equal(header(ctx, 'state:done').textContent.includes('· 1'), true);
  ctx.emitChanged({ roster: [...ROSTER], daemonReachable: true });
  assert.equal(ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]'), null);
  chooseGroupBy(ctx, 'project');
  assert.ok(ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]'), 'state:done does not fold a project');
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  header(ctx, 'project:/w/em').click();
  assert.equal(ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]'), null);
  assert.equal(ctx.read('agentsSelectedKey'), 'bg:aaaaaaaa');
  assert.match(ctx.document.getElementById('agents-detail').textContent, /em-platform/);
  ctx.emitChanged({ roster: [{ ...ROSTER[0], detail: 'pushed' }, ROSTER[1], ROSTER[2]], daemonReachable: true });
  assert.equal(ctx.read('agentsSelectedKey'), 'bg:aaaaaaaa');
  assert.match(ctx.document.getElementById('agents-detail').textContent, /pushed/);
  chooseGroupBy(ctx, 'state');
  assert.equal(ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]'), null);
  const box = ctx.document.getElementById('agents-show-finished');
  box.checked = false;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  box.checked = true;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  assert.equal(header(ctx, 'state:done').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(storedCollapsed(ctx).sort(), ['project:/w/em', 'state:done']);
});

test('collapse: invalid stored value collapses nothing; a throwing storage still toggles', async (t) => {
  for (const bad of ['{nope', '{"a":1}', '42']) {
    const ctx = setup({ storage: { agentsCollapsedGroups: bad } }); t.after(() => ctx.destroy());
    ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
    await ctx.window.showAgentsView();
    assert.equal(ctx.document.querySelectorAll('[aria-expanded="false"]').length, 0, bad);
    assert.equal(ctx.document.querySelectorAll('.agents-row').length, 3, bad);
  }
  const ctx = setup({ storage: {} }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  Object.defineProperty(ctx.window, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  header(ctx, 'state:done').click();
  assert.equal(header(ctx, 'state:done').getAttribute('aria-expanded'), 'false');
});

test('collapse: a project folds its worktree sub-groups; a sub-group folds only its rows', async (t) => {
  const ctx = setup({ storage: { agentsGroupBy: 'project' } }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: APP_ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  const subKey = 'worktree:' + APP + '|' + APP + '/.claude/worktrees/x';
  const sub = header(ctx, subKey);
  assert.ok(sub && sub.classList.contains('agents-subgroup-header'));
  assert.equal(sub.getAttribute('role'), 'button');
  sub.click();
  assert.deepEqual(listLayout(ctx), ['# app · 2', '## main · 1', 'on-main', '## x · 1', '# other · 1', 'other-repo']);
  header(ctx, 'project:' + APP).click();
  assert.deepEqual(listLayout(ctx), ['# app · 2', '# other · 1', 'other-repo']);
  header(ctx, 'project:' + APP).click();
  assert.deepEqual(listLayout(ctx), ['# app · 2', '## main · 1', 'on-main', '## x · 1', '# other · 1', 'other-repo']);
  toggleWorktrees(ctx, false);
  assert.deepEqual(listLayout(ctx), ['# app · 2', 'on-main', 'in-wt', '# other · 1', 'other-repo']);
});

test('collapse: quotes and class= payloads in a project path used as a collapse key inject nothing and round-trip', async (t) => {
  const ctx = setup({ storage: { agentsGroupBy: 'project' } }); t.after(() => ctx.destroy());
  const payload = 'x" class="agents-row" data-key="bg:aaaaaaaa" data-verb="stop" y=\'z';
  const root = '/w/' + payload;
  ctx.setSnapshot({ roster: [{ ...ROSTER[1], id: 'cccccccc', cwd: root, projectRoot: root, worktreeRoot: root }], daemonReachable: true });
  await ctx.window.showAgentsView();
  const head = header(ctx, 'project:' + root);
  assert.ok(head);
  assert.equal(head.className, 'agents-group-header');
  assert.equal(head.hasAttribute('data-verb'), false);
  assert.equal(head.hasAttribute('data-key'), false);
  head.click();
  assert.equal(ctx.read('agentsSelectedKey'), null);
  assert.equal(ctx.calls.verbs.length, 0);
  assert.deepEqual(storedCollapsed(ctx), ['project:' + root]);
  assert.equal(ctx.document.querySelectorAll('.agents-row').length, 0);
  const again = setup({ storage: { agentsGroupBy: 'project', agentsCollapsedGroups: ctx.window.localStorage.getItem('agentsCollapsedGroups') } });
  t.after(() => again.destroy());
  again.setSnapshot({ roster: [{ ...ROSTER[1], id: 'cccccccc', cwd: root, projectRoot: root, worktreeRoot: root }], daemonReachable: true });
  await again.window.showAgentsView();
  assert.equal(header(again, 'project:' + root).getAttribute('aria-expanded'), 'false');
});

test('collapse: the header looks clickable, focusable and does not select text', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  assert.match(css, /\.agents-group-header,\s*\.agents-subgroup-header\s*\{[^}]*cursor:\s*pointer[^}]*user-select:\s*none/);
  assert.match(css, /\.agents-group-header:focus-visible/);
});

test('the grouping is restored from storage; an invalid stored value falls back to state', async (t) => {
  const ctx = setup({ storage: { agentsGroupBy: 'project' } }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.document.getElementById('agents-group-by').value, 'project');
  assert.equal(ctx.document.querySelectorAll('.agents-group-header').length, 3);
  const bad = setup({ storage: { agentsGroupBy: 'evil" onclick="x' } }); t.after(() => bad.destroy());
  bad.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await bad.window.showAgentsView();
  assert.equal(bad.document.getElementById('agents-group-by').value, 'state');
  assert.equal(bad.document.querySelectorAll('.agents-group-header').length, 3);
  assert.equal(bad.read('agentsGroupBy'), 'state');
});

test('a throwing localStorage leaves the grouping at state and choosing one still works', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  Object.defineProperty(ctx.window, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  assert.equal(ctx.window.readAgentsGroupBy(), 'state');
  chooseGroupBy(ctx, 'project');
  assert.equal(ctx.read('agentsGroupBy'), 'project');
  assert.equal(ctx.document.querySelectorAll('.agents-group-header').length, 3);
});

test('quotes and attribute payloads in a cwd used as a project group title cannot inject attributes', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const payload = 'x" class="agents-verb-btn" data-verb="stop" y=\'z';
  const evil = { ...ROSTER[1], id: 'cccccccc', cwd: '/w/' + payload };
  ctx.setSnapshot({ roster: [evil], daemonReachable: true });
  await ctx.window.showAgentsView();
  chooseGroupBy(ctx, 'project');
  const head = ctx.document.querySelector('.agents-group-header');
  assert.equal(head.getAttribute('title'), '/w/' + payload);
  assert.equal(head.className, 'agents-group-header');
  assert.equal(head.hasAttribute('data-verb'), false);
  assert.equal(head.hasAttribute('y'), false);
  assert.equal(headText(head), payload + ' · 1');
  assert.equal(ctx.document.querySelectorAll('[data-verb]').length, 0);
  head.click();
  assert.equal(ctx.calls.verbs.length, 0);
});

test('with nothing stored the list is grouped by state, headers carrying emoji, label and count', async (t) => {
  const ctx = setup({ storage: {} }); t.after(() => ctx.destroy());
  const blocked = { ...ROSTER[0], id: 'cccccccc', sessionId: 's-c', name: 'asks', state: 'blocked', startedAt: Date.now() - 5_000 };
  const stopped = { ...ROSTER[1], id: 'dddddddd', sessionId: 's-d', name: 'halted', state: 'stopped' };
  const odd = { ...ROSTER[1], id: 'eeeeeeee', sessionId: 's-e', name: 'odd', state: null };
  ctx.setSnapshot({ roster: [...ROSTER, blocked, stopped, odd], daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.read('agentsGroupBy'), 'state');
  assert.equal(ctx.document.getElementById('agents-group-by').value, 'state');
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Working · 1', 'em-platform', '# ✋ Blocked · 1', 'asks', '# ✅ Done · 1', 'spike',
    '# ⏹️ Stopped · 1', 'halted', '# 🖥️ External · 1', 'lvds-1b', '# ❓ Unknown · 1', 'odd']);
  const emoji = ctx.document.querySelector('.agents-group-header .agents-group-emoji');
  assert.equal(emoji.getAttribute('aria-hidden'), 'true');
  assert.equal(emoji.textContent, '⚙️');
  assert.equal(ctx.document.querySelector('.agents-group-header .agents-group-label').textContent, 'Working');
  assert.equal(ctx.window.localStorage.getItem('agentsGroupBy'), null, 'the default is not written back');
});

test('a stored none or project is respected over the state default', async (t) => {
  for (const mode of ['none', 'project']) {
    const ctx = setup({ storage: { agentsGroupBy: mode } }); t.after(() => ctx.destroy());
    ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
    await ctx.window.showAgentsView();
    assert.equal(ctx.document.getElementById('agents-group-by').value, mode);
    assert.equal(ctx.document.querySelectorAll('.agents-group-header').length, mode === 'none' ? 0 : 3);
    assert.equal(ctx.document.querySelectorAll('.agents-group-emoji').length, 0);
  }
});

test('every row starts its state column with its state emoji in every grouping mode', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const failed = { ...ROSTER[1], id: 'ffffffff', sessionId: 's-f', name: 'broke', state: 'failed' };
  const odd = { ...ROSTER[1], id: 'eeeeeeee', sessionId: 's-e', name: 'odd', state: null };
  ctx.setSnapshot({ roster: [...ROSTER, failed, odd], daemonReachable: true });
  await ctx.window.showAgentsView();
  const expected = { 'em-platform': '⚙️ working · idle', spike: '✅ done', 'lvds-1b': '🖥️ external · busy', broke: '❌ failed', odd: '❓ ?' };
  for (const mode of ['none', 'state', 'project']) {
    chooseGroupBy(ctx, mode);
    const got = Object.fromEntries([...ctx.document.querySelectorAll('.agents-row')].map(r =>
      [r.querySelector('.agents-row-name').textContent, r.querySelector('.agents-row-state').textContent]));
    assert.deepEqual(got, expected, mode);
    assert.equal(ctx.document.querySelectorAll('.agents-row .agents-state-emoji[aria-hidden="true"]').length, 5, mode);
    assert.equal(ctx.document.querySelectorAll('.agents-row .session-icon').length, 5, mode);
  }
});

test('the group header is styled larger and semi-bold, its count secondary', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const rule = (sel) => {
    const m = css.match(new RegExp('(^|\\n)' + sel.replace(/[.#-]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    return m ? m[2] : '';
  };
  const head = rule('.agents-group-header');
  const size = head.match(/font-size:\s*([\d.]+)em/);
  assert.ok(size && Number(size[1]) >= 1.15, 'header font-size of at least 1.15em');
  assert.match(head, /font-weight:\s*600/);
  assert.match(head, /padding:\s*\d+px/);
  assert.match(rule('.agents-group-count'), /font-weight:\s*400/);
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<option value="state" selected>/);
});

const APP = '/w/app';
const inApp = (id, name, worktreeRoot, over = {}) => ({ ...ROSTER[1], id, sessionId: 's-' + id, name, cwd: worktreeRoot, projectRoot: APP, worktreeRoot, ...over });
const APP_ROSTER = [
  inApp('a1aaaaaa', 'on-main', APP, { startedAt: Date.now() - 1000 }),
  inApp('a2aaaaaa', 'in-wt', APP + '/.claude/worktrees/x', { cwd: APP + '/.claude/worktrees/x/src', startedAt: Date.now() - 2000 }),
  { ...ROSTER[1], id: 'o1oooooo', sessionId: 's-o', name: 'other-repo', cwd: '/w/other', projectRoot: '/w/other', worktreeRoot: '/w/other' },
];

function toggleWorktrees(ctx, on) {
  const box = ctx.document.getElementById('agents-group-worktrees');
  box.checked = on;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
}

test('project mode groups the worktrees of one git project under its root; unrelated repos stay apart', async (t) => {
  const ctx = setup({ storage: { agentsGroupBy: 'project', agentsGroupWorktrees: '0' } }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: APP_ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.deepEqual(listLayout(ctx), ['# app · 2', 'on-main', 'in-wt', '# other · 1', 'other-repo']);
  assert.equal(ctx.document.querySelector('.agents-group-header').getAttribute('title'), APP);
});

test('the Worktrees option is checked by default, sub-groups a project by worktree, and is remembered', async (t) => {
  const ctx = setup({ storage: { agentsGroupBy: 'project' } }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: APP_ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  const box = ctx.document.getElementById('agents-group-worktrees');
  assert.equal(box.checked, true);
  assert.equal(box.disabled, false);
  assert.deepEqual(listLayout(ctx), ['# app · 2', '## main · 1', 'on-main', '## x · 1', 'in-wt', '# other · 1', 'other-repo']);
  const subs = [...ctx.document.querySelectorAll('.agents-subgroup-header')];
  assert.deepEqual(subs.map(h => h.getAttribute('title')), [APP, APP + '/.claude/worktrees/x']);
  assert.equal(ctx.document.querySelectorAll('.agents-row').length, 3);
  assert.equal(ctx.document.querySelectorAll('.agents-row.agents-row--nested').length, 2);
  ctx.document.querySelector('.agents-row[data-key="bg:a2aaaaaa"]').click();
  toggleWorktrees(ctx, false);
  assert.equal(ctx.window.localStorage.getItem('agentsGroupWorktrees'), '0');
  assert.deepEqual(listLayout(ctx), ['# app · 2', 'on-main', 'in-wt', '# other · 1', 'other-repo']);
  assert.ok(ctx.document.querySelector('.agents-row[data-key="bg:a2aaaaaa"]').classList.contains('selected'));
  toggleWorktrees(ctx, true);
  assert.equal(ctx.window.localStorage.getItem('agentsGroupWorktrees'), '1');
  assert.ok(ctx.document.querySelector('.agents-row[data-key="bg:a2aaaaaa"]').classList.contains('selected'));
  ctx.document.querySelector('.agents-subgroup-header').click();
  assert.equal(ctx.read('agentsSelectedKey'), 'bg:a2aaaaaa');
  const off = setup({ storage: { agentsGroupBy: 'project', agentsGroupWorktrees: '0' } }); t.after(() => off.destroy());
  assert.equal(off.document.getElementById('agents-group-worktrees').checked, false);
});

test('the Worktrees option is disabled outside project mode and changes nothing there', async (t) => {
  const ctx = setup({ storage: {} }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: APP_ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  const box = ctx.document.getElementById('agents-group-worktrees');
  assert.equal(box.checked, true);
  assert.equal(box.disabled, true);
  assert.equal(ctx.document.querySelectorAll('.agents-subgroup-header').length, 0);
  chooseGroupBy(ctx, 'none');
  assert.equal(box.disabled, true);
  chooseGroupBy(ctx, 'project');
  assert.equal(box.disabled, false);
  assert.equal(ctx.document.querySelectorAll('.agents-subgroup-header').length, 2);
});

test('quotes and attribute payloads in a worktree path cannot inject attributes into its sub-header', async (t) => {
  const ctx = setup({ storage: { agentsGroupBy: 'project' } }); t.after(() => ctx.destroy());
  const payload = 'x" class="agents-verb-btn" data-verb="stop" y=\'z';
  const evilWt = APP + '/.claude/worktrees/' + payload;
  ctx.setSnapshot({ roster: [APP_ROSTER[0], inApp('e1eeeeee', 'evil', evilWt)], daemonReachable: true });
  await ctx.window.showAgentsView();
  const head = [...ctx.document.querySelectorAll('.agents-subgroup-header')].find(h => h.getAttribute('title') === evilWt);
  assert.ok(head);
  assert.equal(head.className, 'agents-subgroup-header');
  assert.equal(head.hasAttribute('data-verb'), false);
  assert.equal(head.hasAttribute('y'), false);
  assert.equal(headText(head), payload + ' · 1');
  assert.equal(ctx.document.querySelectorAll('[data-verb]').length, 0);
});

test('the worktree sub-header is smaller than the project header and distinct from rows', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const m = css.match(/(^|\n)\.agents-subgroup-header\s*\{([^}]*)\}/);
  assert.ok(m, 'a .agents-subgroup-header rule');
  const size = m[2].match(/font-size:\s*([\d.]+)em/);
  assert.ok(size && Number(size[1]) < 1.2 && Number(size[1]) >= 1, 'between the rows and the project header');
  assert.match(m[2], /font-weight:\s*600/);
  assert.match(m[2], /padding:[^;]*\d+px/);
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /id="agents-group-worktrees" checked/);
  assert.match(html, /title="Sub-group each project by worktree"/);
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

test('quotes in a name, cwd or href cannot inject attributes into the rows or the detail', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const payload = 'x" class="agents-verb-btn" data-verb="stop" y=\'z';
  const evil = { ...ROSTER[1], id: 'cccccccc', name: payload, cwd: '/w/' + payload, children: [{ id: 'c', href: 'https://e.example/' + payload, kind: 'mr' }] };
  ctx.setSnapshot({ roster: [evil], daemonReachable: true });
  await ctx.window.showAgentsView();
  const row = ctx.document.querySelector('.agents-row[data-key="bg:cccccccc"]');
  assert.ok(row);
  const cwdEl = row.querySelector('.agents-row-cwd');
  assert.equal(cwdEl.getAttribute('title'), '/w/' + payload);
  assert.equal(cwdEl.hasAttribute('data-verb'), false);
  assert.equal(cwdEl.className, 'agents-row-cwd');
  row.click();
  const detail = ctx.document.getElementById('agents-detail');
  const link = detail.querySelector('.agents-link');
  assert.equal(link.getAttribute('data-href'), 'https://e.example/' + payload);
  assert.equal(link.hasAttribute('data-verb'), false);
  assert.equal(link.className, 'agents-link');
  assert.equal(ctx.document.querySelectorAll('[data-verb="stop"]').length, 1);
  assert.equal(ctx.document.querySelectorAll('.agents-verb-btn').length, 5);
});

test('a quote in a session id round-trips through the row key without injecting an attribute', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const sid = 'a" data-verb="stop';
  ctx.setSnapshot({ roster: [{ ...ROSTER[2], sessionId: sid }], daemonReachable: true });
  await ctx.window.showAgentsView();
  const row = ctx.document.querySelector('.agents-row');
  assert.equal(row.getAttribute('data-key'), 'int:' + sid);
  assert.equal(row.hasAttribute('data-verb'), false);
});

test('the header wraps its controls so New agent stays reachable at narrow widths', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const header = css.match(/(^|\n)#agents-viewer-header\s*\{([^}]*)\}/);
  assert.ok(header, 'a #agents-viewer-header rule');
  assert.match(header[2], /flex-wrap:\s*wrap/);
  const btn = css.match(/(^|\n)#agents-new-btn\s*\{([^}]*)\}/);
  assert.ok(btn, 'a #agents-new-btn rule of its own');
  assert.match(btn[2], /flex-shrink:\s*0/);
  const main = css.match(/(^|\n)#main\s*\{([^}]*)\}/);
  assert.ok(main, 'a #main rule');
  assert.match(main[2], /min-width:\s*0/, 'the rows\' minimum width must not push #main past the window');
});

test('the header keeps its right end out from under the window controls', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
  const rules = [...css.matchAll(/body\.window-frameless[^{]*:is\(([^)]*)\)\s*\{([^}]*)\}/g)];
  const right = rules.find(m => /strip-inset-right/.test(m[2]));
  assert.ok(right, 'the rule that pads the headers by --strip-inset-right');
  assert.match(right[1], /#agents-viewer-header/);
  const left = rules.find(m => /strip-inset-left/.test(m[2]));
  assert.ok(left, 'the rule that pads the headers by --strip-inset-left');
  assert.match(left[1], /#agents-viewer-header/);
  const noDrag = css.match(/body\.window-frameless :is\([^{]*#agents-viewer-header label[^{]*\{([^}]*)\}/);
  assert.ok(noDrag, 'a no-drag rule that covers the header labels');
  assert.match(noDrag[1], /app-region:\s*no-drag/);
});

const dblclick = (ctx, el) => el.dispatchEvent(new ctx.window.MouseEvent('dblclick', { bubbles: true }));

test('a double click on a working or blocked row attaches, with the same options as the Attach button', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const blocked = { ...ROSTER[0], id: 'dddddddd', sessionId: 's-d', name: 'waits', state: 'blocked', cwd: '/w/d' };
  ctx.setSnapshot({ roster: [...ROSTER, blocked], daemonReachable: true });
  await ctx.window.showAgentsView();
  dblclick(ctx, ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]'));
  assert.equal(ctx.calls.opened.length, 1);
  assert.equal(ctx.calls.opened[0][0].sessionId, 's-a');
  assert.deepEqual({ ...ctx.calls.opened[0][1] }, { type: 'attach', jobId: 'aaaaaaaa', cwd: '/w/em' });
  dblclick(ctx, ctx.document.querySelector('.agents-row[data-key="bg:dddddddd"] .agents-row-state'));
  assert.equal(ctx.calls.opened.length, 2, 'a double click on a cell of the row counts too');
  assert.deepEqual({ ...ctx.calls.opened[1][1] }, { type: 'attach', jobId: 'dddddddd', cwd: '/w/d' });
});

test('a double click does nothing on a finished row, an external session, a header or a button', async (t) => {
  const ctx = setup({ storage: {} }); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  dblclick(ctx, ctx.document.querySelector('.agents-row[data-key="bg:bbbbbbbb"]'));
  dblclick(ctx, ctx.document.querySelector('.agents-row[data-key="int:s-i"]'));
  dblclick(ctx, ctx.document.querySelector('.agents-group-header'));
  ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]').click();
  dblclick(ctx, ctx.document.querySelector('#agents-detail [data-verb="transcript"]'));
  assert.equal(ctx.calls.opened.length, 0);
});

test('a double click does not attach while the daemon is not answering', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: false });
  await ctx.window.showAgentsView();
  dblclick(ctx, ctx.document.querySelector('.agents-row[data-key="bg:aaaaaaaa"]'));
  assert.equal(ctx.calls.opened.length, 0);
});
