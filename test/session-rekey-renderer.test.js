'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { loadAppFunctions } = require('./app-source');

const publicDir = path.join(__dirname, '../public');
const publicPath = file => path.join(publicDir, file);
const publicFiles = () => fs.readdirSync(publicDir).filter(name => name.endsWith('.js')).sort();

function parsePublic(file) {
  const source = fs.readFileSync(publicPath(file), 'utf8');
  try {
    return espree.parse(source, { ecmaVersion: 'latest' });
  } catch {
    return espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  }
}

function isContainer(init) {
  if (!init) return false;
  if (init.type === 'ArrayExpression' || init.type === 'ObjectExpression') return true;
  if (init.type === 'NewExpression') return ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(init.callee.name);
  return init.type === 'CallExpression' && init.callee.object?.name === 'Object' && init.callee.property?.name === 'create';
}

function containers(file) {
  return parsePublic(file).body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
    .filter(node => node?.type === 'VariableDeclaration').flatMap(node => node.declarations)
    .filter(({ id, init }) => id.type === 'Identifier' && isContainer(init))
    .map(({ id }) => id.name).sort();
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

const POLICIES = {
  constant: 'fixed configuration, never keyed by a session id',
  unkeyed: 'keyed by a path, DOM node, notice, job, group, schedule, render or listener, never by a session id',
  snapshot: 'replaced from a project, daemon or schedule snapshot that already names current ids',
  events: 'written from main or remote events that carry the id they observe',
  operation: 'held by one in-flight operation and released under the id it took',
  archiveLock: 'row, group, older rows and project archives capture the session ids before awaiting and release those ids, so a re-key mid-archive unlocks the original transcript',
  noPty: 'held only for ids without a local PTY; a re-keyed tab has one, so the PTY takeover already emptied it',
  exitRecord: 'describes the PTY that ended under that id; opening the new id forgets its own record',
  view: 'accessor object over localPtyStates with no storage of its own',
  transaction: 'source-keyed restore or exit transaction, settled under the id it started with',
  entries: 'holds entry objects, not ids',
};

const ENV = ['rekeySessionTab', 'rekeySessionEnvironment'];
const moved = (...chain) => ({ moved: chain });
const terminal = moved(...ENV, 'rekeyTerminalBuffers');
const panel = moved(...ENV, 'rekeyPanelTerminalState');
const gridMembers = moved(...ENV, 'rekeyGridCard', 'forgetGridCardMembers');
const activity = moved('rekeyActivityState');

const inventory = {
  'agents-view.js': { bgAgentSessionIds: 'snapshot', bgActivityEntries: 'snapshot', bgActivityUpdatedAt: 'snapshot', agentsRoster: 'snapshot',
    agentsCollapsedGroups: 'unkeyed', agentsPendingVerbs: 'operation', agentsInFlightVerbs: 'operation', agentsVerbErrors: 'operation',
    AGENTS_GROUP_MODES: 'constant', AGENT_STATE_META: 'constant' },
  'app-notices.js': { appNoticeEntries: 'unkeyed', transientNoticeEntries: 'unkeyed', APP_NOTICE_ICON_SHAPES: 'constant' },
  'app.js': { openSessions: moved('rekeySessionTab'), pendingSessions: moved('rekeySessionTab'), sessionMap: moved(...ENV),
    activePtyIds: moved(...ENV), lastActivityTime: moved(...ENV), sandboxedSessions: moved(...ENV), ptyGenerations: moved(...ENV),
    pendingOpens: moved(...ENV), skippedWorkingSetEntries: moved(...ENV), restoreSavedIndex: moved(...ENV), openingSessions: moved(...ENV),
    restoreInFlight: 'transaction', dormantWorkingSet: 'transaction', exitHandoffs: 'transaction', exitBackgroundAttempts: 'transaction',
    cachedProjects: 'snapshot', cachedAllProjects: 'snapshot', sortedOrder: 'snapshot', restoreAwaitingConsent: 'snapshot' },
  'codemirror-setup.js': { LANG_MAP: 'constant' },
  'dialogs.js': { BACKGROUND_PERMISSION_MODES: 'constant' },
  'file-panel.js': { filePanelState: moved(...ENV, 'rekeyFilePanelState'), CHANGES_STATE_NAMES: 'constant', CHANGES_DIFF_MODES: 'constant',
    CHANGES_DIFF_MODE_LABELS: 'constant', CHANGES_LIST_VIEWS: 'constant', CHANGES_LIST_VIEW_LABELS: 'constant', FP_ICONS: 'constant',
    COUNT_STATUS_MARKERS: 'constant', MCP_INDICATOR_STATES: 'constant' },
  'grid-view.js': { gridCards: moved(...ENV, 'rekeyGridCard'), gridCardsByMember: gridMembers, gridCardMemberKeys: gridMembers },
  'jsonl-viewer.js': { agentMatchCounters: 'unkeyed', liveSubagents: 'events', toolRenderers: 'constant' },
  'local-transcript-adapter.js': { localTranscriptDecayTimers: 'noPty', localTranscriptAgentsDecayTimers: 'noPty',
    localTranscriptStates: 'noPty', localTranscriptDescriptorLosses: 'noPty' },
  'memory-workfiles-view.js': { cachedMemoryData: 'unkeyed', memoryCollapsedState: 'unkeyed', scheduleRunFailureCounts: 'unkeyed' },
  'modal-stack.js': { modalStack: 'unkeyed', modalQuestions: 'unkeyed', modalIdleQuestions: 'unkeyed' },
  'panel-terminal.js': { panelTerminals: panel, panelSpawnsInFlight: panel, panelReopenAfterSpawn: panel },
  'process-exit.js': { sessionExits: 'exitRecord' },
  'remote-activity-ui.js': { remoteActivityDecayTimers: 'events', remoteAgentsDecayTimers: 'events', remoteSessionStates: 'events', remoteSeedFloors: 'events' },
  'remote-enrol-panel.js': { ENROL_WHERE_TEXT: 'constant' },
  'resume-guard.js': { continuationLocations: 'constant' },
  'schedules-view.js': { schedulesActions: 'unkeyed', schedulesCollapsed: 'unkeyed', SCHEDULE_ICONS: 'constant', scheduleHealthNotices: 'unkeyed' },
  'session-activity-dom.js': { headTurns: activity, localMergedMemberRows: 'snapshot' },
  'session-activity.js': { localPtyStates: activity, writtenActivityStates: moved(...ENV, 'rekeyWrittenActivity'), activitySeqBySession: activity,
    sessionBusyState: 'view', responseReadySessions: 'view', attentionSessions: 'view', idleListeners: 'unkeyed' },
  'session-state.js': { PRIORITY: 'constant', ICON_BY_RUNG: 'constant' },
  'session-status-projection.js': { sessionStatusProjection: 'constant' },
  'setting-defaults.js': { SETTING_DEFAULTS: 'constant', THEME_CHOICES: 'constant' },
  'shortcuts.js': { DEFAULT_SHORTCUTS: 'constant', FIXED_SHORTCUTS: 'constant', SHORTCUT_DEFS: 'constant' },
  'sidebar.js': { archivingSessionIds: 'archiveLock', archivingGroupIds: 'unkeyed', remappingProjectPaths: 'unkeyed', deletingWorktreePaths: 'unkeyed',
    SUBAGENT_TYPE_COLORS: 'constant', searchGroupChoices: 'unkeyed', pendingSubagentRest: 'unkeyed', deletingProjectKeys: 'unkeyed',
    projectDeletionOperations: 'unkeyed', completedProjectDeletionKeys: 'unkeyed', projectDeletionRestoreTargets: 'unkeyed',
    projectDeletionWriteKeys: 'unkeyed', sidebarScheduleRuns: 'snapshot' },
  'terminal-manager.js': { terminalWriteBuffers: terminal, lastFlushAt: terminal, renderStats: terminal, hiddenAccumulators: terminal,
    lruOrder: terminal, webglWarmOrder: 'entries', SAFE_REDRAW_MARKERS: 'constant' },
  'terminal-themes.js': { TERMINAL_THEMES: 'constant', LIGHT_TERMINAL_THEME: 'constant' },
  'touched-files-view.js': { TOUCHED_STATE_LABELS: 'constant', TOUCHED_STATE_TITLES: 'constant', TOUCHED_UNRESOLVED_REASONS: 'constant' },
  'utils.js': { remoteDisplayHosts: 'snapshot', PERMISSION_MODES: 'constant' },
  'viewer-toolbar.js': { MARKDOWN_EXTENSIONS: 'constant', mermaidPreviewStates: 'unkeyed', mermaidDocuments: 'unkeyed' },
};

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

test('every top-level container in public/*.js has an explicit rekey policy, including future containers', () => {
  const found = Object.fromEntries(publicFiles().map(file => [file, containers(file)]).filter(([, names]) => names.length));
  const declared = Object.fromEntries(Object.entries(inventory).map(([file, names]) => [file, Object.keys(names).sort()]));
  assert.deepEqual(found, declared);
  for (const names of Object.values(inventory)) {
    for (const [name, policy] of Object.entries(names)) {
      assert.ok(typeof policy === 'object' || Object.hasOwn(POLICIES, policy), `${name} has no known policy`);
    }
  }
  assert.deepEqual(terminalMaps.map(name => inventory['terminal-manager.js'][name]), terminalMaps.map(() => terminal));
});

test('every container declared as moved is reached from its re-key entry point', () => {
  const functions = new Map();
  for (const file of publicFiles()) {
    walk(parsePublic(file), node => { if (node.type === 'FunctionDeclaration') functions.set(node.id.name, node); });
  }
  const mentions = (fn, predicate) => {
    let hit = false;
    walk(fn.body, node => { if (predicate(node)) hit = true; });
    return hit;
  };
  for (const names of Object.values(inventory)) {
    for (const [name, policy] of Object.entries(names)) {
      if (typeof policy !== 'object') continue;
      for (const [i, fnName] of policy.moved.entries()) {
        const fn = functions.get(fnName);
        assert.ok(fn, `${fnName} is not declared`);
        const next = policy.moved[i + 1];
        if (next) {
          assert.ok(mentions(fn, node => node.type === 'CallExpression'
            && (node.callee.name === next || node.callee.property?.name === next)), `${fnName} does not call ${next}`);
        } else {
          assert.ok(mentions(fn, node => node.type === 'Identifier' && node.name === name), `${fnName} does not touch ${name}`);
        }
      }
    }
  }
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

for (const kind of ['detected', 'fork', 'clear', 'continuation', 'background']) for (const stage of ['settings', 'profiles']) {
  test(`a ${kind} re-key of the active session during the header ${stage} await still writes its shell label`, async t => {
    const h = fixture(t);
    const w = h.w;
    Object.assign(w, {
      terminalHeaderShell: w.document.createElement('span'), terminalHeaderSandbox: w.document.createElement('span'),
      terminalStopBtn: w.document.createElement('button'), updateTerminalHeader() {},
    });
    const { showTerminalHeader } = loadAppFunctions(h.context, { functions: ['showTerminalHeader'] });
    let finish;
    const delayed = new Promise(resolve => { finish = resolve; });
    let reached;
    const awaiting = new Promise(resolve => { reached = resolve; });
    w.api.getEffectiveSettings = () => {
      if (stage !== 'settings') return Promise.resolve({ shellProfile: 'pwsh' });
      reached();
      return delayed;
    };
    w.api.getShellProfiles = () => {
      if (stage !== 'profiles') return Promise.resolve([{ id: 'pwsh', name: 'PowerShell' }]);
      reached();
      return delayed;
    };
    w.terminalHeaderShell.textContent = 'Previous shell';
    w.activeSessionId = 'old';
    const shown = showTerminalHeader(h.entry.session);
    await awaiting;
    if (kind === 'detected') h.callbacks.Detected('old', 'new');
    else h.callbacks.Forked('old', 'new', kind);
    assert.equal(w.activeSessionId, 'new');
    finish(stage === 'settings' ? { shellProfile: 'pwsh' } : [{ id: 'pwsh', name: 'PowerShell' }]);
    await shown;
    assert.equal(w.terminalHeaderShell.textContent, 'PowerShell');
    assert.equal(w.terminalHeaderShell.style.display, '');
  });
}
