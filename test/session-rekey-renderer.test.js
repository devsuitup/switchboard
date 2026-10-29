'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { loadAppFunctions } = require('./app-source');

const publicPath = file => path.join(__dirname, '../public', file);

function containers(file) {
  const ast = espree.parse(fs.readFileSync(publicPath(file), 'utf8'), { ecmaVersion: 'latest' });
  return ast.body.filter(node => node.type === 'VariableDeclaration').flatMap(node => node.declarations)
    .filter(({ init }) => init?.type === 'ArrayExpression' || (init?.type === 'NewExpression' && ['Map', 'Set'].includes(init.callee.name)))
    .map(({ id }) => id.name).sort();
}

const terminalMaps = ['hiddenAccumulators', 'lastFlushAt', 'renderStats', 'terminalWriteBuffers'];
const environmentMaps = ['lastActivityTime', 'sandboxedSessions', 'ptyGenerations', 'pendingOpens', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'openingSessions'];

function fixture(t) {
  const h = setupTerminalDom({ filePanel: true });
  t.after(h.destroy);
  const w = h.window;
  const callbacks = {};
  for (const event of ['Detected', 'Forked']) w.api[`onSession${event}`] = fn => { callbacks[event] = fn; };
  Object.assign(w, {
    loadProjects: () => Promise.resolve(), pollActiveSessions() {}, schedulePersistWorkingSet() {},
    setActiveSession(id) { w.activeSessionId = id; w.switchPanel(id); },
    terminalHeaderId: w.document.createElement('span'), terminalHeaderName: w.document.createElement('span'),
    pendingSessions: new Map(),
  });
  loadAppFunctions(h.context, {
    declarations: ['exitHandoffs', 'lastActivityTime', 'sandboxedSessions', 'ptyGenerations', 'pendingOpens', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'openingSessions'],
    functions: ['rekeySessionTab', 'rekeySessionEnvironment'],
  });
  const source = fs.readFileSync(publicPath('app.js'), 'utf8');
  for (const event of ['Detected', 'Forked']) {
    const start = source.indexOf(`window.api.onSession${event}(`);
    vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), h.context, { filename: publicPath('app.js') });
  }
  const session = { sessionId: 'old', projectPath: '/project' };
  w.sessionMap.set('old', session);
  const entry = w.createTerminalEntry(session);
  w.activeSessionId = 'other';
  return { ...h, w, callbacks, entry };
}

test('terminal per-session containers have an explicit rekey policy, including future containers', () => {
  assert.deepEqual(containers('terminal-manager.js'), [...terminalMaps, 'lruOrder', 'webglWarmOrder', 'SAFE_REDRAW_MARKERS'].sort());
  assert.deepEqual(containers('panel-terminal.js'), ['panelReopenAfterSpawn', 'panelSpawnsInFlight', 'panelTerminals']);
});

test('app container inventory distinguishes migrated state from source-keyed restore and exit transactions', () => {
  const snapshots = ['restoreInFlight', 'dormantWorkingSet', 'exitHandoffs', 'exitBackgroundAttempts'];
  const projectLists = ['cachedProjects', 'cachedAllProjects', 'sortedOrder', 'restoreAwaitingConsent'];
  assert.deepEqual(containers('app.js'), [...environmentMaps, ...snapshots, ...projectLists,
    'openSessions', 'pendingSessions', 'sessionMap', 'activePtyIds'].sort());
});

for (const kind of ['detected', 'fork', 'clear', 'continuation', 'background']) {
  test(`${kind} moves every terminal map, LRU and hidden output intact`, t => {
    const h = fixture(t);
    h.w.handleTerminalData('old', 'hidden before rekey\r\n');
    h.inCtx("lastFlushAt.set('old', 17); renderStats.set('old', { chunks: 2 }); terminalWriteBuffers.set('old', { chunks: ['queued before rekey'], rafId: 0, timerId: 0 }); lruOrder.length = 0; lruOrder.push('other', 'old');");
    const values = terminalMaps.map(name => h.inCtx(`${name}.get('old')`));
    for (const name of environmentMaps) h.inCtx(`${name}.set('old', { marker: '${name}' })`);
    const environmentValues = environmentMaps.map(name => h.inCtx(`${name}.get('old')`));
    h.w.activePtyIds.add('old');
    h.w.pendingSessions.set('old', { session: h.entry.session });
    if (kind === 'detected') h.callbacks.Detected('old', 'new');
    else h.callbacks.Forked('old', 'new', kind);
    for (const [i, name] of terminalMaps.entries()) {
      assert.equal(h.inCtx(`${name}.has('old')`), false, `${name} retains old id`);
      assert.equal(h.inCtx(`${name}.get('new')`), values[i], `${name} lost its value`);
    }
    assert.deepEqual([...h.inCtx('lruOrder')], ['other', 'new']);
    assert.equal(h.w.openSessions.get('new'), h.entry);
    assert.equal(h.w.sessionMap.get('new'), h.entry.session);
    for (const [i, name] of environmentMaps.entries()) {
      assert.equal(h.inCtx(`${name}.has('old')`), false, `${name} retains old id`);
      assert.equal(h.inCtx(`${name}.get('new')`), environmentValues[i], `${name} lost its value`);
    }
    assert.equal(h.w.activePtyIds.has('new'), true);
    assert.equal(h.w.activePtyIds.has('old'), false);
    assert.equal(h.w.pendingSessions.has('old'), false);
    assert.equal(h.w.pendingSessions.get('new').session.sessionId, 'new');
    h.w.activeSessionId = 'new';
    h.w.replayHiddenBuffer('new');
    assert.equal(h.spies.writes.join(''), 'queued before rekeyhidden before rekey\r\n');
    assert.equal(h.inCtx("hiddenAccumulators.has('new')"), false);
  });

  test(`${kind} retains the shell PTY while moving its owner and grid actions`, async t => {
    const h = fixture(t);
    h.w.switchPanel('old');
    await h.w.openPanelTerminal('old');
    const shell = h.w.openSessions.get('panel:old');
    h.w.sortedOrder = [];
    h.w.wrapInGridCard('old');
    const card = h.inCtx("gridCards.get('old')");
    const stopped = [];
    h.w.confirmAndStopSession = id => stopped.push(id);
    h.w.activeSessionId = 'old';
    if (kind === 'detected') h.callbacks.Detected('old', 'new');
    else h.callbacks.Forked('old', 'new', kind);
    assert.equal(h.w.panelTerminalIsOpen('old'), false);
    assert.equal(h.w.panelTerminalOwnerOf('panel:old'), 'new');
    assert.equal(h.w.openSessions.get('panel:old'), shell);
    assert.equal(h.w.toolBarOwner(), 'new');
    assert.equal(h.w.activeSessionId, 'new');
    assert.equal(h.w.terminalHeaderId.textContent, 'new');
    assert.equal(h.inCtx("gridCards.has('old')"), false);
    assert.equal(h.inCtx("gridCards.get('new')"), card);
    card.querySelector('.grid-card-stop-btn').click();
    assert.deepEqual(stopped, ['new']);
    h.w.closePanelTerminal('new');
    assert.deepEqual(h.spies.stopSession, ['panel:old']);
  });
}

test('a shell spawn refused after owner rekey removes the original shell entry', async t => {
  const h = fixture(t);
  let finish;
  h.w.api.openTerminal = () => new Promise(resolve => { finish = resolve; });
  h.w.switchPanel('old');
  const pending = h.w.openPanelTerminal('old');
  h.callbacks.Forked('old', 'new', 'continuation');
  finish({ ok: false, error: 'spawn refused' });
  await pending;
  assert.equal(h.w.openSessions.has('panel:old'), false, 'refused shell entry survived under its original PTY id');
  assert.equal(h.inCtx('panelSpawnsInFlight.size'), 0);
});

for (const stage of ['settings', 'profiles', 'auto', 'error']) {
  test(`a stale header ${stage} reply cannot overwrite the newly active shell`, async t => {
    const h = fixture(t);
    const w = h.w;
    Object.assign(w, {
      terminalHeaderShell: w.document.createElement('span'), terminalHeaderSandbox: w.document.createElement('span'),
      terminalStopBtn: w.document.createElement('button'), updateTerminalHeader() {},
    });
    const { showTerminalHeader } = loadAppFunctions(h.context, { functions: ['showTerminalHeader'] });
    let finish;
    const delayed = new Promise((resolve, reject) => { finish = stage === 'error' ? () => reject(new Error('late failure')) : resolve; });
    w.api.getEffectiveSettings = project => project === '/old' && stage !== 'profiles' ? delayed : Promise.resolve({ shellProfile: 'new-shell' });
    let profileCalls = 0;
    let profilesStarted;
    const reachedProfiles = new Promise(resolve => { profilesStarted = resolve; });
    w.api.getShellProfiles = () => {
      if (stage === 'profiles' && profileCalls++ === 0) {
        profilesStarted();
        return delayed;
      }
      return Promise.resolve([{ id: 'new-shell', name: 'Current shell' }]);
    };
    w.activeSessionId = 'old';
    const old = showTerminalHeader({ sessionId: 'old', projectPath: '/old' });
    if (stage === 'profiles') await reachedProfiles;
    else await Promise.resolve();
    w.activeSessionId = 'new';
    await showTerminalHeader({ sessionId: 'new', projectPath: '/new' });
    finish(stage === 'profiles' ? [{ id: 'new-shell', name: 'Stale shell' }] : { shellProfile: stage === 'auto' ? 'auto' : 'stale-shell' });
    await old;
    assert.equal(w.terminalHeaderShell.textContent, 'Current shell');
    assert.equal(w.terminalHeaderShell.style.display, '');
  });
}
