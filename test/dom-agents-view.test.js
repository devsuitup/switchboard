// test/dom-agents-view.test.js — the agents view rendered in jsdom. See .ai/contexts/bg-agents.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadAppFunctions } = require('./app-source');

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

for (const [hosted, expected] of [[true, 'Idle'], [false, 'Unknown']]) {
  test(`A-T7 running hosted=${hosted} renders ${expected}`, async t => {
    const h = setup({ storage: { agentsGroupBy: 'state' } });
    t.after(() => h.destroy());
    const { mergeRoster, parseJobState } = require('../bg-agents-roster');
    const job = parseJobState('{"state":"running"}');
    const entry = { ...mergeRoster({ jobs: new Map([['aaaaaaaa', job]]), descriptors: hosted
      ? [{ kind: 'bg', jobId: 'aaaaaaaa', sessionId: 's-a', status: 'idle' }] : [] })[0] };
    assert.equal(entry.hosted, hosted);
    h.setSnapshot({ daemonReachable: true, roster: [entry] });
    await h.window.showAgentsView();
    assert.equal(h.document.querySelector('.agents-group-label').textContent, expected);
    if (!hosted) assert.equal(h.window.backgroundActivityLabel('s-a', {}, null, { entry }).text, 'Unknown');
  });
}

test('A-T7 dead running displays the CLI failed state', async t => {
  const h = setup(); t.after(() => h.destroy());
  const { mergeRoster, parseJobState } = require('../bg-agents-roster');
  const entry = mergeRoster({ jobs: new Map([['aaaaaaaa', parseJobState('{"state":"running"}')]]), descriptors: [],
    cli: [{ id: 'aaaaaaaa', sessionId: 's-a', kind: 'background', state: 'failed' }] })[0];
  assert.equal(entry.hosted, false);
  h.setSnapshot({ daemonReachable: true, roster: [entry] });
  await h.window.showAgentsView();
  assert.equal(h.window.agentStateMeta(entry).label, 'Failed');
});

test('A-T7 hosted running has the same turn projection and activity labels as hosted done', t => {
  const h = setup(); t.after(() => h.destroy());
  for (const status of ['idle', 'busy', 'waiting']) {
    for (const headTurn of ['open', 'closed', 'unknown']) {
      const snapshot = { liveness: 'alive', headTurn, agentsBusy: true, backgroundWork: true,
        busy: status === 'busy', attention: status === 'waiting' };
      const done = { ...ROSTER[0], state: 'done', hosted: true, status };
      const running = { ...done, state: 'running' };
      assert.deepEqual(h.window.projectBackgroundActivity(running, snapshot), h.window.projectBackgroundActivity(done, snapshot));
      assert.equal(h.window.backgroundActivityLabel('s-a', snapshot, null, { entry: running }).text,
        h.window.backgroundActivityLabel('s-a', snapshot, null, { entry: done }).text);
    }
  }
});

function setup({ storage = { agentsGroupBy: 'none' }, settingsPanel = false } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const calls = { verbs: [], opened: [], jsonl: [], external: [], stopped: [], shown: [], sidebarRefreshes: 0, fetches: 0 };
  let changedCb = null;
  let snapshot = { roster: [], daemonReachable: true };
  window.api = {
    getBgAgents: async () => { calls.fetches++; return snapshot; },
    checkBgAgentVerb: async () => ({ ok: true }),
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
    localMergedMemberRows: new Map(),
    activeSessionId: null,
    gridViewActive: false,
    showSession: (id) => calls.shown.push(id),
    openSession: (session, opts) => calls.opened.push([session, opts]),
    showJsonlViewer: (session) => calls.jsonl.push(session),
    refreshSidebar: () => { calls.sidebarRefreshes++; },
    fitAndScroll: () => {},
    refitOpenTerminals: () => {},
    appConfirm: async () => true,
  };
  for (const [k, v] of Object.entries(g)) Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.js'), 'utf8'), dom.getInternalVMContext(), { filename: path.join(PUBLIC, '../node_modules/morphdom/dist/morphdom-umd.js') });
  evalFile(dom, path.join(PUBLIC, 'utils.js'));
  evalFile(dom, path.join(PUBLIC, 'session-state.js'));
  evalFile(dom, path.join(PUBLIC, 'stop-session-ui.js'));
  evalFile(dom, path.join(PUBLIC, 'memory-workfiles-view.js'));
  evalFile(dom, path.join(PUBLIC, 'agents-view.js'));
  if (settingsPanel) {
    evalFile(dom, path.join(PUBLIC, 'setting-defaults.js'));
    evalFile(dom, path.join(PUBLIC, 'shortcuts.js'));
    evalFile(dom, path.join(PUBLIC, 'terminal-themes.js'));
    evalFile(dom, path.join(PUBLIC, 'settings-panel.js'));
  }
  loadAppFunctions(dom.getInternalVMContext(), { functions: ['indexedRowOf', 'indexedSessionById'] });
  loadAppFunctions(dom.getInternalVMContext(), {
    functions: ['rowHeadId'], sourcePath: path.join(PUBLIC, 'session-activity-dom.js'),
  });
  loadAppFunctions(dom.getInternalVMContext(), {
    functions: ['rowHeadSession'], sourcePath: path.join(PUBLIC, 'sidebar.js'),
  });
  window.initAgentsView();
  const read = (expr) => vm.runInContext(expr, dom.getInternalVMContext(), { filename: __filename });
  return {
    window, document: window.document, calls, read, ctx: dom.getInternalVMContext(),
    setSnapshot(s) { snapshot = s; },
    emitChanged(s) { snapshot = s; changedCb(s); },
    destroy() { window.close(); },
  };
}

const ROSTER = [
  { id: 'aaaaaaaa', sessionId: 's-a', name: 'em-platform', cwd: '/w/em', kind: 'background', state: 'working', hosted: true, status: 'idle', pid: 10, startedAt: Date.now() - 60_000, agent: 'fleet:em', model: 'sonnet', detail: 'awaiting !196', tempo: 'idle', tokens: 173000, fan: [{ id: 'f', kind: 'agent', label: 'Spawn developer', startedAt: 1, doneAt: 27_000 }], children: [{ id: '195', href: 'https://gitlab.example/mr/195', kind: 'mr' }], result: 'no action', attachedHere: false },
  { id: 'bbbbbbbb', sessionId: 's-b', name: 'spike', cwd: '/w/f', kind: 'background', state: 'done', hosted: false, status: null, pid: null, startedAt: Date.now() - 3_600_000, agent: null, model: null, detail: null, tempo: null, tokens: 274, fan: [], children: [], result: null, attachedHere: false },
  { id: null, sessionId: 's-i', name: 'lvds-1b', cwd: '/w/l', kind: 'interactive', state: null, status: 'busy', pid: 30, startedAt: Date.now() - 10_000, agent: null, model: null, detail: null, tempo: null, tokens: null, fan: [], children: [], result: null, attachedHere: false },
];

test('C1 Attach becomes Go to tab on the same button across roster renders', async t => {
  const h = setup(); t.after(() => h.destroy());
  h.setSnapshot({ roster: [ROSTER[0]], daemonReachable: true });
  await h.window.showAgentsView();
  h.document.querySelector('.agents-row').click();
  const button = h.document.querySelector('[data-verb="attach"]');
  assert.equal(button.textContent, 'Attach');
  const attached = { ...ROSTER[0], attachedHere: true };
  h.emitChanged({ roster: [attached], daemonReachable: true });
  assert.equal(h.document.querySelector('[data-verb="attach"]'), button, 'morphdom preserves the Attach button');
  assert.equal(button.textContent, 'Go to tab');
  assert.equal(button.getAttribute('aria-label'), 'Go to tab');
  assert.equal(button.title, 'Go to tab');
  h.emitChanged({ roster: [attached], daemonReachable: true });
  assert.equal(h.document.querySelector('[data-verb="attach"]'), button);
  h.emitChanged({ roster: [ROSTER[0]], daemonReachable: true });
  assert.equal(h.document.querySelector('[data-verb="attach"]'), button);
  assert.equal(button.textContent, 'Attach');
});

for (const grid of [false, true]) {
  test(`C2 Go to tab finds the job under a different tab key (grid=${grid})`, async t => {
    const h = setup(); t.after(() => h.destroy());
    const agent = { ...ROSTER[0], id: 'abcdef12', sessionId: 'new', attachedHere: true };
    h.window.gridViewActive = grid;
    h.window.openSessions.set('closed', { attach: true, attachJobId: agent.id, closed: true });
    h.window.openSessions.set('unrelated', { attach: true, attachJobId: '1234abcd', closed: false });
    h.window.openSessions.set('old', { attach: true, attachJobId: agent.id, closed: false });
    h.setSnapshot({ roster: [agent], daemonReachable: true });
    await h.window.showAgentsView();
    h.document.querySelector('.agents-row').click();
    h.document.querySelector('[data-verb="attach"]').click();
    assert.deepEqual(h.calls.shown, ['old'], 'Go to tab shows the existing job tab');
    assert.deepEqual(h.calls.opened, [], 'Go to tab never opens a second attach');
    assert.equal(h.read('agentsViewActive'), false);
    assert.equal(h.window.sessionMap.has('new'), false, 'focusing needs no synthetic session');
    if (grid) assert.equal(h.window.terminalArea.style.display, '', 'Go to tab restores the visible grid');
  });
}

for (const [state, hosted, label] of [['working', false, 'Unknown'], ['blocked', false, 'Unknown'], ['working', true, 'Active']]) {
  test(`[767] ${hosted ? 'hosted' : 'non-hosted'} ${state} job reads ${label} consistently with Finished`, async t => {
    const h = setup({ storage: { agentsGroupBy: 'state' } });
    t.after(() => h.destroy());
    const entry = { ...ROSTER[0], state, hosted };
    h.setSnapshot({ daemonReachable: true, roster: [entry] });
    await h.window.showAgentsView();
    assert.equal(h.document.querySelector('.agents-group-label').textContent, label, 'group label follows hosting');
    assert.equal(h.document.querySelector('.agents-row-state').textContent.trim().replace(/^\S+\s+/, ''), label);
    assert.equal(h.window.agentStateMeta(entry).key, hosted ? 'working' : 'unknown');
    assert.equal(h.document.getElementById('agents-viewer-count').textContent, hosted ? '1 running · 0 finished' : '0 running · 1 finished');
    if (!hosted) {
      assert.doesNotMatch(h.document.querySelector('.session-icon').title, /job (working|blocked)/);
      const detail = h.window.backgroundActivityLabel(entry.sessionId, {}, null, { entry, selection: 'unique-head' });
      assert.equal(detail.text, 'Unknown');
      assert.match(detail.title, /job unknown/);
      assert.doesNotMatch(h.window.agentRowIcon({ ...entry, sessionId: null }).title, /job (working|blocked)/);
    }
    const finished = h.document.getElementById('agents-show-finished');
    finished.checked = false;
    finished.dispatchEvent(new h.window.Event('change'));
    assert.equal(h.document.querySelectorAll('.agents-row').length, hosted ? 1 : 0);
  });
}

for (const [state, hosted, expected] of [
  ['working', false, 'Unknown'], ['blocked', false, 'Unknown'],
  ['working', true, 'working'], ['blocked', true, 'blocked'], ['done', true, 'done'],
]) {
  test(`[767b] ${hosted ? 'hosted' : 'non-hosted'} ${state} detail reads ${expected}`, async t => {
    const h = setup();
    t.after(() => h.destroy());
    const entry = { ...ROSTER[0], state, jobState: state, hosted };
    h.setSnapshot({ daemonReachable: true, roster: [entry] });
    await h.window.showAgentsView();
    h.document.querySelector('.agents-row').click();
    const meta = h.document.querySelector('.agents-detail-meta').textContent;
    assert.ok(meta.startsWith(`job ${entry.id} · ${expected} ·`), `detail state follows hosting: ${meta}`);
    if (!hosted) assert.match(h.document.querySelector('.agents-row-state').textContent, /Unknown/);
  });
}

test('#563 every AGENT_STATE_META key reads its exact Title Case word', async t => {
  const h = setup();
  t.after(() => h.destroy());
  const words = { working: 'Active', blocked: 'Blocked', idle: 'Idle', running: 'Idle', done: 'Done', stopped: 'Stopped', failed: 'Failed', external: 'External', unknown: 'Unknown' };
  assert.deepEqual(Object.keys(words).sort(), Object.keys(h.read('AGENT_STATE_META')).sort());
  const fixtures = {
    working: { state: 'working', hosted: true }, blocked: { state: 'blocked', hosted: true },
    idle: { state: 'done', hosted: true }, running: { state: 'running', hosted: true }, done: { state: 'done', hosted: false },
    stopped: { state: 'stopped', hosted: false }, failed: { state: 'failed', hosted: false },
    external: { kind: 'interactive', state: null, status: 'busy' }, unknown: { state: null, hosted: false },
  };
  for (const [key, word] of Object.entries(words)) {
    h.setSnapshot({ daemonReachable: true, roster: [{ id: key, sessionId: 's-' + key, kind: 'background', ...fixtures[key] }] });
    await h.window.showAgentsView();
    const column = h.document.querySelector('.agents-row-state');
    assert.equal(column.textContent.trim().replace(/^\S+\s+/, ''), word, key);
  }
});

test('#563 Agents status has an accessible name and a working job reads Active', async t => {
  const h = setup();
  t.after(() => h.destroy());
  h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[0], state: 'working' }] });
  await h.window.showAgentsView();
  const icon = h.document.querySelector('.agents-row .session-icon');
  assert.equal(icon.getAttribute('role'), 'img');
  assert.ok(icon.getAttribute('aria-label'));
  assert.equal(icon.getAttribute('aria-label'), icon.title.split('\n')[0]);
  assert.equal(h.document.querySelector('.agents-row-state').textContent.toLowerCase().split(/[^a-z]+/).includes('working'), false);
});

test('#563 D8 background jobs without a known state or descriptor read Liveness unknown', async t => {
  const h = setup();
  t.after(() => h.destroy());
  for (const state of [null, 'unrecognized', 'working', 'blocked']) {
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], state, hosted: false, status: null }] });
    await h.window.showAgentsView();
    const icon = h.document.querySelector('.agents-row .session-icon');
    assert.match(icon.title, /^Liveness unknown/);
    assert.match(icon.getAttribute('aria-label'), /^Liveness unknown/);
    assert.doesNotMatch(icon.title, /Not running|Stale|Idle/);
  }
});

test('#563 finished background jobs without a live descriptor read Not running', async t => {
  const h = setup();
  t.after(() => h.destroy());
  for (const state of ['done', 'stopped', 'failed']) {
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], state, hosted: false }] });
    await h.window.showAgentsView();
    const icon = h.document.querySelector('.agents-row .session-icon');
    assert.equal(icon.title, 'Not running');
    assert.equal(icon.getAttribute('aria-label'), 'Not running');
  }
  h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], state: 'done', hosted: true }] });
  await h.window.showAgentsView();
  assert.doesNotMatch(h.document.querySelector('.agents-row .session-icon').title, /Not running/);
});

for (const own of [true, false]) {
  test(`External refusal names an available recovery action (own window: ${own})`, async t => {
    const h = setup();
    t.after(() => h.destroy());
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], conversationPid: 42, conversationOwn: own }] });
    await h.window.showAgentsView();
    h.document.querySelector('.agents-row').click();
    for (const verb of ['respawn', 'rm']) {
      const button = h.document.querySelector(`[data-verb="${verb}"]`);
      assert.equal(button.disabled, true);
      assert.doesNotMatch(button.title, /close it first|; stop it first/i);
      assert.match(button.title, own ? /Stop it from its sidebar row first/ : /End that process first/);
      assert.match(button.title, /42/);
    }
  });
}

test('T6: default state grouping puts hosted done under Idle with its idle dot', async () => {
  const h = setup({ storage: {} });
  try {
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], id: 'cccccccc', sessionId: 's-c', hosted: true, status: 'idle' }, ROSTER[1]] });
    await h.window.showAgentsView();
    const idle = h.document.querySelector('[data-collapse="state:idle"]');
    assert.ok(idle);
    assert.match(idle.textContent, /💤 Idle/);
    assert.match(idle.nextElementSibling.querySelector('.agents-row-state').textContent, /💤 Idle/);
    assert.ok(idle.nextElementSibling.querySelector('.session-icon--idle'));
    const done = h.document.querySelector('[data-collapse="state:done"]');
    assert.ok(done);
    assert.equal(done.nextElementSibling.querySelector('.agents-row-state').textContent.trim(), '✅ Done');
  } finally { h.destroy(); }
});

test('hosted done job keeps badge, live row, filter visibility and Attach/Stop only', async () => {
  const h = setup({ storage: { agentsGroupBy: 'none', agentsShowFinished: '0' } });
  try {
    h.window.taskActivitySnapshot = (_id, ports) => ({ ...ports, headTurn: 'open', attention: false,
      agentsBusy: true, backgroundWork: true, responseReady: true });
    const entry = { ...ROSTER[1], hosted: true };
    h.emitChanged({ daemonReachable: true, roster: [entry] });
    assert.equal(h.read('agentsViewActive'), false);
    assert.equal(h.read("bgAgentSessionIds.has('s-b')"), true);
    await h.window.showAgentsView();
    const row = h.document.querySelector('.agents-row');
    assert.ok(row);
    assert.ok(row.querySelector('.session-icon--waiting'));
    assert.equal(row.querySelectorAll('.session-icon--busy, .session-icon--response-ready, .session-icon--agents-busy, .session-icon--attention').length, 0);
    assert.match(row.querySelector('.agents-row-state').textContent, /Idle/);
    assert.match(h.document.getElementById('agents-viewer-count').textContent, /1 running · 0 finished/);
    row.click();
    for (const verb of ['attach', 'stop']) assert.equal(h.document.querySelector(`[data-verb="${verb}"]`).disabled, false);
    for (const verb of ['rm', 'respawn']) assert.equal(h.document.querySelector(`[data-verb="${verb}"]`).disabled, true);
    h.document.querySelector('[data-verb="attach"]').click();
    assert.equal(h.calls.opened[0][1].type, 'attach');
    h.emitChanged({ daemonReachable: true, roster: [{ ...entry, hosted: false }] });
    assert.equal(h.read("bgAgentSessionIds.has('s-b')"), false);
    assert.equal(h.document.querySelector('.agents-row'), null);
  } finally { h.destroy(); }
});

test('Agents row and detail retain the original conversation name over a collision title', async () => {
  const h = setup();
  try {
    h.window.sessionMap.set('s-a', { sessionId: 's-a', name: 'JB rename' });
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[0], name: 'daemon (2)', nameSource: 'collision' }] });
    await h.window.showAgentsView();
    assert.equal(h.document.querySelector('.agents-row-name').textContent, 'JB rename');
    h.document.querySelector('.agents-row').click();
    assert.equal(h.document.querySelector('.agents-detail-name').textContent, 'JB rename');
  } finally { h.destroy(); }
});

test('Agents rows supply genuine attention, blocked waiting and finished glyphs to the shared slot CSS', { timeout: 1000 }, async () => {
  const { window, document, setSnapshot, destroy } = setup();
  try {
    setSnapshot({ daemonReachable: true, roster: [
      { id: 'waiting', sessionId: 's-waiting', kind: 'background', state: 'blocked', hosted: true, status: 'waiting' },
      { sessionId: 'permission', kind: 'interactive', status: 'waiting' },
      { id: 'idle', kind: 'background', state: 'working', hosted: true, status: 'idle' },
      { id: 'finished', kind: 'background', state: 'done', hosted: false, status: 'idle' },
    ] });
    await window.showAgentsView();
    const blocked = document.querySelector('.agents-row[data-key="bg:waiting"] .session-icon');
    assert.ok(blocked.classList.contains('session-icon--attention'));
    assert.match(blocked.title, /job blocked/);
    const { renderSessionIcon } = require('../public/session-state');
    for (const [rung, snapshot] of [['attention', { attention: true }], ['waiting', { waitingForInput: true }], ['stale', { stale: true }]]) {
      const slot = document.querySelector(`.agents-row .session-icon--${rung}`);
      assert.ok(slot, `${rung} row must have the shared slot class`);
      assert.equal(slot.dataset.glyph, renderSessionIcon(snapshot).glyph, `${rung} glyph must reach the rendered row`);
    }
  } finally {
    destroy();
  }
});

test('a blocked Agents row without a sessionId keeps job blocked in its tooltip', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ daemonReachable: true, roster: [
    { id: 'blocked-without-session', kind: 'background', state: 'blocked', hosted: true },
  ] });
  await ctx.window.showAgentsView();
  const icon = ctx.document.querySelector('.agents-row[data-key="bg:blocked-without-session"] .session-icon');
  assert.match(icon.title, /job blocked/);
});

test('Agents rows mark only live jobs as running', { timeout: 1000 }, async () => {
  const { window, document, setSnapshot, destroy } = setup();
  try {
    const roster = [
      { id: 'busy', kind: 'background', state: 'working', hosted: true, status: 'busy' },
      { id: 'waiting', kind: 'background', state: 'blocked', hosted: true, status: 'waiting' },
      { id: 'idle', kind: 'background', state: 'working', hosted: true, status: 'idle' },
      { sessionId: 'external', kind: 'interactive', status: 'idle' },
      { id: 'done', kind: 'background', state: 'done', hosted: false, status: 'idle' },
      { id: 'stopped', kind: 'background', state: 'stopped', hosted: false, status: 'idle' },
      { id: 'failed', kind: 'background', state: 'failed', hosted: false, status: 'busy' },
    ];
    setSnapshot({ daemonReachable: true, roster });
    await window.showAgentsView();
    const slots = [...document.querySelectorAll('.agents-row .session-icon')];
    assert.equal(slots.length, roster.length);
    for (const slot of slots) {
      const stale = slot.classList.contains('session-icon--stale');
      assert.equal(slot.classList.contains('running'), !stale, slot.closest('.agents-row').dataset.key);
    }
    assert.equal(slots.filter(slot => slot.classList.contains('running')).length, 4);
  } finally {
    destroy();
  }
});

test('showing the view hides the terminal area, lists the roster sorted, and counts running/finished', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.window.terminalArea.style.display, 'none');
  assert.equal(ctx.document.getElementById('agents-viewer').style.display, 'flex');
  assert.equal(ctx.read('agentsViewActive'), true);
  const names = [...ctx.document.querySelectorAll('.agents-row-name')].map(el => el.textContent);
  assert.deepEqual(names, ['lvds-1b', 'em-platform', 'spike']);
  assert.equal(ctx.document.getElementById('agents-viewer-count').textContent, '1 running · 1 finished · 1 external');
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

test('an unreachable daemon shows the banner and disables background job verbs; an empty roster shows the empty state', async (t) => {
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
  ctx.emitChanged({ roster: [ROSTER[0], { ...ROSTER[1], state: 'blocked', hosted: true }, ROSTER[2]], daemonReachable: true });
  assert.deepEqual([...ctx.read('bgAgentSessionIds')].sort(), ['s-a', 's-b']);
  assert.equal(ctx.calls.sidebarRefreshes, 2);
  ctx.emitChanged({ roster: [{ ...ROSTER[0], state: 'done', hosted: false }, ROSTER[1], ROSTER[2]], daemonReachable: true });
  assert.deepEqual([...ctx.read('bgAgentSessionIds')], []);
  assert.equal(ctx.calls.sidebarRefreshes, 3);
});

test('bootstrap fetches the shared roster before the view opens; opening reconciles it', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  assert.equal(ctx.calls.fetches, 1);
  await ctx.window.showAgentsView();
  assert.equal(ctx.calls.fetches, 2);
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
  const blocked = { ...ROSTER[0], id: 'cccccccc', sessionId: 's-c', name: 'asks', state: 'blocked', hosted: true, status: 'waiting', startedAt: Date.now() - 5_000 };
  ctx.setSnapshot({ roster: [...ROSTER, blocked], daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.deepEqual([...ctx.document.querySelectorAll('.agents-row-name')].map(el => el.textContent), ['asks', 'lvds-1b', 'em-platform', 'spike']);
  assert.equal(ctx.document.getElementById('agents-viewer-count').textContent, '2 running · 1 finished · 1 external');
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

test('a failed job reads "Failed", counts as finished and is hidden by the Finished filter', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const failed = { ...ROSTER[1], id: 'ffffffff', sessionId: 's-f', name: 'broke', state: 'failed', hosted: false };
  ctx.setSnapshot({ roster: [...ROSTER, failed], daemonReachable: true });
  await ctx.window.showAgentsView();
  const row = ctx.document.querySelector('.agents-row[data-key="bg:ffffffff"]');
  assert.equal(row.querySelector('.agents-row-state').textContent, '❌ Failed');
  assert.equal(ctx.document.getElementById('agents-viewer-count').textContent, '1 running · 2 finished · 1 external');
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
  const failed = { ...ROSTER[1], id: 'ffffffff', sessionId: 's-f', name: 'broke', state: 'failed', hosted: false };
  ctx.setSnapshot({ roster: [...ROSTER, failed], daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.document.querySelectorAll('.agents-group-header').length, 0);
  chooseGroupBy(ctx, 'state');
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Active · 1', 'em-platform', '# ✅ Done · 1', 'spike', '# ❌ Failed · 1', 'broke', '# 🖥️ External · 1', 'lvds-1b']);
  assert.equal(ctx.document.querySelectorAll('.agents-row').length, 4);
  assert.equal(ctx.window.localStorage.getItem('agentsGroupBy'), 'state');
  chooseGroupBy(ctx, 'none');
  assert.deepEqual(listLayout(ctx), ['lvds-1b', 'em-platform', 'spike', 'broke']);
});

test('group by project: headers labelled by the last segment with the full path as title, live groups first', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const second = { ...ROSTER[0], id: 'cccccccc', sessionId: 's-c', name: 'em-two', state: 'done', hosted: false, startedAt: Date.now() - 120_000 };
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
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Active · 1', 'em-platform', '# 🖥️ External · 1', 'lvds-1b']);
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
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Active · 1', 'em-platform', '# ✅ Done · 1', '# 🖥️ External · 1', 'lvds-1b']);
  const folded = header(ctx, 'state:done');
  assert.equal(folded.getAttribute('aria-expanded'), 'false');
  assert.equal(folded.querySelector('.agents-group-chevron').textContent, '▸');
  assert.deepEqual(storedCollapsed(ctx), ['state:done']);
  folded.click();
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Active · 1', 'em-platform', '# ✅ Done · 1', 'spike', '# 🖥️ External · 1', 'lvds-1b']);
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
  const blocked = { ...ROSTER[0], id: 'cccccccc', sessionId: 's-c', name: 'asks', state: 'blocked', hosted: true, startedAt: Date.now() - 5_000 };
  const stopped = { ...ROSTER[1], id: 'dddddddd', sessionId: 's-d', name: 'halted', state: 'stopped', hosted: false };
  const odd = { ...ROSTER[1], id: 'eeeeeeee', sessionId: 's-e', name: 'odd', state: null };
  ctx.setSnapshot({ roster: [...ROSTER, blocked, stopped, odd], daemonReachable: true });
  await ctx.window.showAgentsView();
  assert.equal(ctx.read('agentsGroupBy'), 'state');
  assert.equal(ctx.document.getElementById('agents-group-by').value, 'state');
  assert.deepEqual(listLayout(ctx), ['# ⚙️ Active · 1', 'em-platform', '# ✋ Blocked · 1', 'asks', '# ✅ Done · 1', 'spike',
    '# ⏹️ Stopped · 1', 'halted', '# 🖥️ External · 1', 'lvds-1b', '# ❓ Unknown · 1', 'odd']);
  const emoji = ctx.document.querySelector('.agents-group-header .agents-group-emoji');
  assert.equal(emoji.getAttribute('aria-hidden'), 'true');
  assert.equal(emoji.textContent, '⚙️');
  assert.equal(ctx.document.querySelector('.agents-group-header .agents-group-label').textContent, 'Active');
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
  const failed = { ...ROSTER[1], id: 'ffffffff', sessionId: 's-f', name: 'broke', state: 'failed', hosted: false };
  const odd = { ...ROSTER[1], id: 'eeeeeeee', sessionId: 's-e', name: 'odd', state: null };
  ctx.setSnapshot({ roster: [...ROSTER, failed, odd], daemonReachable: true });
  await ctx.window.showAgentsView();
  const expected = { 'em-platform': '⚙️ Active', spike: '✅ Done', 'lvds-1b': '🖥️ External', broke: '❌ Failed', odd: '❓ Unknown' };
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
  assert.equal(ctx.calls.fetches, 1);
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
  const blocked = { ...ROSTER[0], id: 'dddddddd', sessionId: 's-d', name: 'waits', state: 'blocked', hosted: true, cwd: '/w/d' };
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

test('the header counts the External rows it displays, and omits the segment when there are none', async (t) => {
  const ctx = setup(); t.after(() => ctx.destroy());
  const second = { ...ROSTER[2], sessionId: 's-i2', name: 'other-cli', pid: 31 };
  ctx.setSnapshot({ roster: [...ROSTER, second], daemonReachable: true });
  await ctx.window.showAgentsView();
  const count = () => ctx.document.getElementById('agents-viewer-count').textContent;
  assert.equal(count(), '1 running · 1 finished · 2 external');
  const box = ctx.document.getElementById('agents-show-finished');
  box.checked = false;
  box.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  assert.equal(count(), '1 running · 1 finished · 2 external');
  ctx.emitChanged({ roster: [ROSTER[0], ROSTER[1]], daemonReachable: true });
  assert.equal(count(), '1 running · 1 finished');
});

test('background Delete waits for its async confirmation and cancellation sends no verb', async t => {
  const ctx = setup(); t.after(() => ctx.destroy());
  ctx.setSnapshot({ roster: ROSTER, daemonReachable: true });
  await ctx.window.showAgentsView();
  let answer;
  let confirming;
  const started = new Promise(resolve => { confirming = resolve; });
  ctx.window.appConfirm = () => { confirming(); return new Promise(resolve => { answer = resolve; }); };
  const pending = ctx.window.runAgentVerb('rm', ROSTER[1]);
  await started;
  assert.deepEqual(ctx.calls.verbs, []);
  answer(false);
  await pending;
  assert.deepEqual(ctx.calls.verbs, []);
  ctx.window.appConfirm = async () => true;
  await ctx.window.runAgentVerb('rm', ROSTER[1]);
  assert.deepEqual(ctx.calls.verbs, [['rm', ROSTER[1].id]]);
});

test('PR6 Stop checks then confirms the job name, id and loss before running', async t => {
  const h = setup(); t.after(() => h.destroy());
  const events = [];
  h.window.api.checkBgAgentVerb = async (verb, id) => { events.push(['check', verb, id]); return { ok: true }; };
  h.window.appConfirm = async options => {
    events.push(['confirm']);
    assert.match(options.message, /em-platform/);
    assert.match(options.message, /aaaaaaaa/);
    assert.match(options.message, /its process ends; the conversation is kept/i);
    assert.equal(options.danger, true);
    assert.equal(options.confirmLabel, 'Stop');
    return true;
  };
  h.window.api.bgAgentVerb = async (verb, id) => { events.push(['verb', verb, id]); return { ok: true }; };
  await h.window.runAgentVerb('stop', ROSTER[0]);
  assert.deepEqual(events, [['check', 'stop', 'aaaaaaaa'], ['confirm'], ['verb', 'stop', 'aaaaaaaa']]);
});

test('PR6 declining Stop sends no verb and keeps the attached tab open', async t => {
  const h = setup(); t.after(() => h.destroy());
  let confirmations = 0;
  h.window.appConfirm = async () => { confirmations++; return false; };
  await h.window.runAgentVerb('stop', { ...ROSTER[0], attachedHere: true });
  assert.equal(confirmations, 1);
  assert.deepEqual(h.calls.verbs, []);
  assert.deepEqual(h.calls.stopped, []);
});

for (const verb of ['rm', 'stop']) {
  for (const rejected of [false, true]) {
    test(`PR6 ${verb} ${rejected ? 'rejected check' : 'refusal'} shows the detail error before any dialog`, async t => {
      const h = setup(); t.after(() => h.destroy());
      const entry = verb === 'rm' ? ROSTER[1] : ROSTER[0];
      h.setSnapshot({ roster: [entry], daemonReachable: true });
      await h.window.showAgentsView();
      h.document.querySelector('.agents-row').click();
      let confirmations = 0;
      h.window.appConfirm = async () => { confirmations++; return true; };
      h.window.api.checkBgAgentVerb = async (checkedVerb, id) => {
        assert.equal(checkedVerb, verb);
        assert.equal(id, entry.id);
        if (rejected) throw new Error('Cannot read process state');
        return { ok: false, error: 'Conversation is running elsewhere (pid 42)' };
      };
      await h.window.runAgentVerb(verb, { ...entry, attachedHere: true });
      assert.equal(confirmations, 0, 'a refusal must precede every dialog');
      assert.deepEqual(h.calls.verbs, []);
      assert.deepEqual(h.calls.stopped, []);
      assert.match(h.document.querySelector('.agents-detail-error').textContent,
        rejected ? /Cannot read process state/ : /Conversation is running elsewhere \(pid 42\)/);
    });
  }
}

test('identical roster polls preserve the selected verb buttons and focus', async t => {
  const h = setup(); t.after(() => h.destroy());
  h.setSnapshot({ roster: [ROSTER[1]], daemonReachable: true });
  await h.window.showAgentsView();
  h.document.querySelector('.agents-row').click();
  const buttons = [...h.document.querySelectorAll('#agents-detail [data-verb]')];
  const remove = h.document.querySelector('#agents-detail [data-verb="rm"]');
  remove.focus();
  h.emitChanged({ roster: [JSON.parse(JSON.stringify(ROSTER[1]))], daemonReachable: true });
  const updated = [...h.document.querySelectorAll('#agents-detail [data-verb]')];
  assert.equal(updated.length, buttons.length);
  buttons.forEach((button, index) => assert.equal(updated[index], button));
  assert.equal(h.document.activeElement, remove);
});

test('a state change keeps the same button node and updates disabled', async t => {
  const h = setup(); t.after(() => h.destroy());
  h.setSnapshot({ roster: [ROSTER[1]], daemonReachable: true });
  await h.window.showAgentsView();
  h.document.querySelector('.agents-row').click();
  const remove = h.document.querySelector('#agents-detail [data-verb="rm"]');
  assert.equal(remove.disabled, false);
  h.emitChanged({ roster: [{ ...ROSTER[1], state: 'working', hosted: true }], daemonReachable: true });
  const updated = h.document.querySelector('#agents-detail [data-verb="rm"]');
  assert.equal(updated, remove);
  assert.equal(updated.disabled, true);
  h.emitChanged({ roster: [ROSTER[1]], daemonReachable: true });
  assert.equal(h.document.querySelector('#agents-detail [data-verb="rm"]'), remove);
  assert.equal(remove.disabled, false);
});

for (const verb of ['stop', 'rm']) {
  test(`cancelled ${verb} confirmation restores focus to its opener`, async t => {
    const h = setup(); t.after(() => h.destroy());
    for (const file of ['modal-stack.js', 'choice-dialog.js', 'app-dialogs.js']) {
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, file), 'utf8'), h.ctx, { filename: file });
    }
    const entry = verb === 'stop' ? ROSTER[0] : ROSTER[1];
    h.setSnapshot({ roster: [entry], daemonReachable: true });
    await h.window.showAgentsView();
    h.document.querySelector('.agents-row').click();
    const opener = h.document.querySelector(`[data-verb="${verb}"]`);
    opener.focus();
    const pending = h.window.runAgentVerb(verb, entry);
    await new Promise(resolve => setImmediate(resolve));
    const cancel = h.document.querySelector('.choice-dialog-cancel');
    assert.ok(cancel, 'the real confirmation dialog must open');
    assert.equal(h.document.activeElement, cancel);
    cancel.click();
    await pending;
    assert.equal(h.document.activeElement, opener);
    assert.deepEqual(h.calls.verbs, []);
  });

  test(`double ${verb} clicks before the check resolves open one dialog`, async t => {
    const h = setup(); t.after(() => h.destroy());
    const entry = verb === 'stop' ? ROSTER[0] : ROSTER[1];
    h.setSnapshot({ roster: [entry], daemonReachable: true });
    await h.window.showAgentsView();
    h.document.querySelector('.agents-row').click();
    let resolveCheck, resolveConfirmation, confirmationStarted;
    let checks = 0, confirmations = 0;
    const checked = new Promise(resolve => { resolveCheck = resolve; });
    const confirming = new Promise(resolve => { confirmationStarted = resolve; });
    h.window.api.checkBgAgentVerb = () => { checks++; return checked; };
    h.window.appConfirm = () => {
      confirmations++;
      confirmationStarted();
      return new Promise(resolve => { resolveConfirmation = resolve; });
    };
    const button = h.document.querySelector(`[data-verb="${verb}"]`);
    button.click();
    button.click();
    assert.equal(checks, 1);
    assert.equal(button.disabled, false);
    resolveCheck({ ok: true });
    await confirming;
    h.emitChanged({ roster: [entry], daemonReachable: true });
    assert.equal(button.disabled, false, 'a roster render during confirmation keeps the opener enabled');
    button.click();
    await h.window.runAgentVerb(verb === 'stop' ? 'rm' : 'stop', entry);
    assert.equal(checks, 1, 'the job is held through confirmation for both destructive verbs');
    assert.equal(confirmations, 1);
    assert.deepEqual(h.calls.verbs, []);
    resolveConfirmation(false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(button.disabled, false);
    h.window.appConfirm = async () => { confirmations++; return false; };
    await h.window.runAgentVerb(verb, entry);
    assert.equal(checks, 2, 'cancellation releases the job for a retry');
    assert.equal(confirmations, 2);
  });

  for (const failure of ['refusal', 'check rejection', 'confirmation rejection', 'verb rejection', 'completion']) {
    test(`${verb} releases pending after ${failure} and permits a retry`, async t => {
      const h = setup(); t.after(() => h.destroy());
      const entry = verb === 'stop' ? ROSTER[0] : ROSTER[1];
      h.setSnapshot({ roster: [entry], daemonReachable: true });
      await h.window.showAgentsView();
      h.document.querySelector('.agents-row').click();
      let checks = 0, confirmations = 0, executions = 0;
      h.window.api.checkBgAgentVerb = async () => {
        checks++;
        if (checks === 1 && failure === 'check rejection') throw new Error('Check failed');
        if (checks === 1 && failure === 'refusal') return { ok: false, error: 'Refused' };
        return { ok: true };
      };
      h.window.appConfirm = async () => {
        confirmations++;
        if (confirmations === 1 && failure === 'confirmation rejection') throw new Error('Confirmation failed');
        return true;
      };
      h.window.api.bgAgentVerb = async () => {
        assert.equal(h.document.querySelector(`[data-verb="${verb}"]`).disabled, true);
        executions++;
        if (executions === 1 && failure === 'verb rejection') throw new Error('Execution failed');
        return { ok: true };
      };
      const pending = h.window.runAgentVerb(verb, entry);
      assert.equal(h.document.querySelector(`[data-verb="${verb}"]`).disabled, false);
      await pending;
      assert.equal(h.document.querySelector(`[data-verb="${verb}"]`).disabled, false);
      if (failure !== 'completion') {
        assert.match(h.document.querySelector('.agents-detail-error').textContent,
          /Refused|Check failed|Confirmation failed|Execution failed/);
      }
      await h.window.runAgentVerb(verb, entry);
      assert.equal(checks, 2);
      assert.equal(executions, failure === 'completion' || failure === 'verb rejection' ? 2 : 1);
      assert.equal(h.document.querySelector('.agents-detail-error'), null);
    });
  }
}

for (const daemonReachable of [true, false]) {
  test(`External row offers Resume even when daemon reachable is ${daemonReachable}`, async t => {
    const h = setup(); t.after(() => h.destroy());
    h.setSnapshot({ daemonReachable, roster: [ROSTER[2]] });
    await h.window.showAgentsView();
    h.document.querySelector('.agents-row').click();
    const resume = h.document.querySelector('[data-verb="resume"]');
    assert.ok(resume);
    assert.equal(resume.disabled, false);
    assert.equal(resume.textContent, 'Resume');
    assert.equal(resume.title, 'Resume this conversation here; it asks first, because it is running in another process');
    for (const verb of ['attach', 'stop', 'respawn', 'rm']) assert.equal(h.document.querySelector(`[data-verb="${verb}"]`).disabled, true);
  });
}

for (const indexed of [false, true]) {
  test(`External Resume opens the conversation without attach options (indexed: ${indexed})`, async t => {
    const h = setup(); t.after(() => h.destroy());
    const session = { sessionId: 'root', mergedMemberIds: ['s-i'], projectPath: '/indexed', name: 'Indexed name' };
    if (indexed) h.window.sessionMap.set('root', session);
    h.setSnapshot({ daemonReachable: true, roster: [ROSTER[2]] });
    await h.window.showAgentsView();
    h.document.querySelector('.agents-row').click();
    const opened = [];
    h.window.openSession = (...args) => opened.push(args);
    h.document.querySelector('[data-verb="resume"]')?.click();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(opened[0][0])), indexed
      ? session
      : { sessionId: 's-i', projectPath: '/w/l', name: 'lvds-1b' });
    assert.deepEqual(h.calls.verbs, []);
  });
}


for (const { merged, liveId, accept } of [
  { merged: false, liveId: 's-i' },
  { merged: true, liveId: 's-i' },
  { merged: true, liveId: 's-a' },
].flatMap(scenario => [false, true].map(accept => ({ ...scenario, accept })))) {
  test(`External Resume opens the row head with one live-elsewhere question (merged A→B→C: ${merged}, live: ${liveId}, accept: ${accept})`, async t => {
    const h = setup(); t.after(() => h.destroy());
    const w = h.window, questions = [], spawned = [];
    const live = { kind: 'interactive', pid: 30, cwd: '/w/l', startedAt: 100 };
    const row = { sessionId: 's-a', mergedMemberIds: ['s-i', 's-c'], headSessionId: 's-c', projectPath: '/w/l', name: 'lvds-1b' };
    if (merged) {
      w.sessionMap.set(row.sessionId, row);
      for (const id of row.mergedMemberIds) w.localMergedMemberRows.set(id, row);
    } else {
      w.sessionMap.set('s-i', { sessionId: 's-i', projectPath: '/w/l', name: 'lvds-1b' });
    }
    const continuationChecks = [], liveChecks = [];
    Object.assign(w, {
      restoringWorkingSet: false, pendingSessions: new Map(),
      appConfirm: async question => { questions.push(question); return question.title === 'Session running elsewhere' && accept; },
      createTerminalEntry: () => ({ initialSize: {} }), resolveDefaultSessionOptions: async () => ({}),
      forgetSessionExit() {}, beginPtyOpen() {}, settlePtyOpen() {}, destroySession() {},
    });
    Object.assign(w.api, {
      getSessionContinuations: async id => {
        continuationChecks.push(id);
        return { candidates: merged && id !== 's-c' ? [{ sessionId: 's-c', modified: 300 }] : [], unresolved: false };
      },
      getSessionLiveElsewhere: async id => { liveChecks.push(id); return id === liveId ? live : null; },
      getSessionsLiveElsewhere: async ids => { liveChecks.push(...ids); return { [liveId]: live }; },
      openTerminal: async (...args) => { spawned.push(args); return { notLive: true }; },
    });
    evalFile({ getInternalVMContext: () => h.ctx }, path.join(PUBLIC, 'resume-guard.js'));
    loadAppFunctions(h.ctx, {
      functions: ['rowSessionIds', 'rowHeadId', 'rowOpenId'], sourcePath: path.join(PUBLIC, 'session-activity-dom.js'),
    });
    const app = loadAppFunctions(h.ctx, {
      functions: ['openSession', 'openSessionNow'],
      declarations: ['restoreRunDepth', 'openingSessions', 'dormantWorkingSet', 'continuationRetryCancelled', 'skippedWorkingSetEntries'],
    });
    let finished;
    w.openSession = (...args) => { finished = app.openSession(...args); return finished; };
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[2], sessionId: liveId }] });
    await w.showAgentsView();
    h.document.querySelector('.agents-row').click();
    h.document.querySelector('[data-verb="resume"]')?.click();
    await finished;
    assert.equal(questions.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(questions[0])), JSON.parse(JSON.stringify(w.liveElsewhereQuestion(live, 'lvds-1b'))));
    assert.equal(spawned.length, accept ? 1 : 0);
    if (accept) {
      assert.equal(spawned[0][0], merged ? 's-c' : 's-i');
      assert.notEqual(spawned[0][3].type, 'attach');
    }
    assert.deepEqual(continuationChecks, [merged ? 's-c' : 's-i']);
    assert.deepEqual([...new Set(liveChecks)].sort(), merged ? ['s-a', 's-c', 's-i'] : ['s-i']);
  });
}

for (const state of ['blocked', 'done']) {
  test(`S3d ${state} busy open turn renders Working under Active`, async t => {
    const h = setup({ storage: { agentsGroupBy: 'state' } });
    t.after(() => h.destroy());
    h.window.taskActivitySnapshot = (_id, ports) => ({ ...ports, headTurn: 'open' });
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], state, hosted: true, status: 'busy' }] });
    await h.window.showAgentsView();
    const row = h.document.querySelector('.agents-row');
    const icon = row.querySelector('.session-icon--busy');
    assert.ok(icon, 'an open turn supports the live busy descriptor');
    assert.equal(icon.title, 'Working');
    assert.equal(h.document.querySelector('[data-collapse="state:working"]').nextElementSibling, row);
  });
}

for (const [state, status, headTurn] of [
  ['blocked', 'idle', 'unknown'],
  ['done', null, 'unknown'],
  ['done', 'busy', 'closed'],
]) {
  test(`S3d ${state} ${status} ${headTurn} rendered waiting ring keeps its title`, async t => {
    const h = setup();
    t.after(() => h.destroy());
    h.window.taskActivitySnapshot = (_id, ports) => ({ ...ports, headTurn });
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], state, hosted: true, status }] });
    await h.window.showAgentsView();
    const icon = h.document.querySelector('.agents-row .session-icon--waiting');
    assert.ok(icon);
    assert.ok(icon.title.startsWith('Waiting for input'), icon.title);
  });
}

test('S3b done waiting dialog blinks in the Active group', async t => {
  const h = setup({ storage: { agentsGroupBy: 'state' } });
  t.after(() => h.destroy());
  h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], hosted: true, status: 'waiting', waitingFor: 'permission dialog' }] });
  await h.window.showAgentsView();
  const row = h.document.querySelector('.agents-row');
  assert.ok(row.querySelector('.session-icon--attention'));
  const active = h.document.querySelector('[data-collapse="state:working"]');
  assert.ok(active, 'a done row with a live dialog belongs under Active');
  assert.equal(active.nextElementSibling, row);
  assert.equal(h.document.querySelector('[data-collapse="state:idle"]'), null);
});

test('S3b hosted done with genuine attention keeps the dialog visible', async t => {
  const h = setup();
  t.after(() => h.destroy());
  h.window.taskActivitySnapshot = (_id, ports) => ({ ...ports, headTurn: 'closed', attention: true,
    responseReady: true, agentsBusy: true, backgroundWork: true });
  h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], hosted: true }] });
  await h.window.showAgentsView();
  const row = h.document.querySelector('.agents-row');
  assert.ok(row.querySelector('.session-icon--attention'));
  assert.equal(row.querySelectorAll('.session-icon--busy, .session-icon--response-ready, .session-icon--agents-busy').length, 0);
});

for (const status of [null, 'busy']) {
  test('S3b done closed turn suppresses lower rungs without attention, descriptor=' + status, async t => {
    const h = setup();
    t.after(() => h.destroy());
    h.window.taskActivitySnapshot = (_id, ports) => ({ ...ports, headTurn: 'closed', attention: false,
      busy: true, responseReady: true, agentsBusy: true, backgroundWork: true });
    h.setSnapshot({ daemonReachable: true, roster: [{ ...ROSTER[1], hosted: true, status }] });
    await h.window.showAgentsView();
    const row = h.document.querySelector('.agents-row');
    assert.ok(row.querySelector('.session-icon--waiting'));
    assert.equal(row.querySelectorAll('.session-icon--busy, .session-icon--response-ready, .session-icon--agents-busy, .session-icon--attention').length, 0);
  });
}
