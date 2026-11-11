'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const transitions = require('../session-transitions');
const { handleTerminalInput } = require('../src/main/terminals/terminal-input');
const { createComposerState } = require('../src/main/terminals/composer-state');
const { loadAppFunctions } = require('./app-source');
const { encodeProjectPath } = require('../encode-project-path');
const { mergeLocalBackgroundSessions } = require('../sidebar-bg-sessions');
const { setupTerminalDom } = require('./terminal-manager-harness');
const { setupSidebarDom } = require('./dom-setup');

const OLD = '11111111-1111-4111-8111-111111111111';
const HEAD = '22222222-2222-4222-8222-222222222222';
const link = JSON.stringify({ type: 'continued-in', sessionId: OLD, continuedInSessionId: HEAD }) + '\n';

function fixture(t, { old = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-'));
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  const file = path.join(dir, OLD + '.jsonl');
  fs.writeFileSync(file, old ? link : '');
  let killed = 0;
  const entry = { projectFolder: 'project', knownJsonlFiles: new Set([OLD + '.jsonl']),
    composerState: createComposerState(), pty: { pid: 7, write() {}, kill() { killed++; } } };
  entry.continuationSnapshot = transitions.snapshotContinuations?.(file, OLD)
    || { sourceId: OLD, bytes: fs.statSync(file).size, ids: old ? [HEAD] : [] };
  const activeSessions = new Map([[OLD, entry]]), events = [], timers = [];
  let receiver;
  let jobExists = true;
  let proof = { sessionId: HEAD, jobId: '1234abcd', kind: 'bg' };
  transitions.init({ PROJECTS_DIR: root, activeSessions, log: { info() {}, debug() {}, warn() {}, error() {} }, rekeyMcpServer() {},
    clearOwner: () => 'other', getBackgroundTarget: () => proof,
    backgroundJobExists: () => jobExists,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => {
      events.push(args);
      if (args[0] === 'session-forked') receiver?.(...args.slice(1));
      if (args[0] === 'session-forked') entry.pty.kill();
    } } }), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; } });
  t.after(() => { transitions.init({ activeSessions: new Map() }); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, entry, activeSessions, events, timers, get killed() { return killed; },
    append: () => fs.appendFileSync(file, link), setProof: p => { proof = p; },
    setReceiver: fn => { receiver = fn; },
    setJobExists: value => { jobExists = value; },
    bg: () => { handleTerminalInput(activeSessions, OLD, '/bg', Date.now()); handleTerminalInput(activeSessions, OLD, '\r', Date.now()); },
    detect: () => transitions.detectSessionTransitions('project') };
}

test('explicit resume of the original id with an old running continuation keeps its PTY alive', t => {
  const h = fixture(t, { old: true });
  h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
  assert.equal(h.killed, 0);
  assert.equal(h.events.length, 0);
});

test('an open tab is not rekeyed when another process backgrounds its conversation', t => {
  const h = fixture(t);
  h.append(); h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
  assert.equal(h.killed, 0);
});

test('a bg confirmation Enter keeps the command attributed to the same tab', t => {
  const h = fixture(t);
  h.bg(); handleTerminalInput(h.activeSessions, OLD, '\r', Date.now()); h.append(); h.detect();
  assert.equal(h.activeSessions.get(HEAD), h.entry);
});

test('a cancelled typed /bg cannot authorize another process later backgrounding the conversation', t => {
  const h = fixture(t);
  h.bg(); handleTerminalInput(h.activeSessions, OLD, '\x03', Date.now()); h.append(); h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
});

test('coalesced command and cancellation are interpreted in input order', t => {
  const h = fixture(t);
  handleTerminalInput(h.activeSessions, OLD, '/bg\r\x03', Date.now()); h.append(); h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
});

test('literal Ctrl+C inside bracketed paste does not cancel a pending handoff', t => {
  const h = fixture(t);
  h.bg(); handleTerminalInput(h.activeSessions, OLD, '\x1b[200~text\x03\x1b[201~', Date.now());
  h.append(); h.detect();
  assert.equal(h.activeSessions.get(HEAD), h.entry);
});

test('a split CLI cancellation message revokes the typed background command', t => {
  const h = fixture(t);
  let output;
  const context = vm.createContext({ activeSessions: h.activeSessions, TRACE: { on: false }, ptyGenerationCounter: 0, log: { info() {} },
    cancellationIn: require('../src/main/bg-agents/bg-handoff').cancellationIn,
    mainWindow: null, appendToOutputBuffer() {}, MAX_BUFFER_SIZE: 1024 });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.entry, OLD, Object.assign(h.entry.pty, { onData: fn => { output = fn; }, onExit() {} }));
  h.bg(); output('Backgrounding can'); output('celled — stayed interactive\n');
  h.append(); h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
});

test('a transcript rewrite cannot turn a record before the spawn offset into a fresh handoff', t => {
  const h = fixture(t);
  fs.writeFileSync(h.file, JSON.stringify({ type: 'assistant', message: 'x'.repeat(500) }) + '\n');
  h.entry.continuationSnapshot = transitions.snapshotContinuations(h.file, OLD);
  h.bg(); fs.writeFileSync(h.file, link + JSON.stringify({ type: 'assistant', message: 'x'.repeat(500) }) + '\n');
  h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
});

test('same-size mtime rewrites with unchanged boundary never scan before the spawn offset', t => {
  const h = fixture(t);
  const baseline = JSON.stringify({ type: 'assistant', message: 'old' }) + ' '.repeat(1000) + '\n';
  fs.writeFileSync(h.file, baseline);
  h.entry.continuationSnapshot = transitions.snapshotContinuations(h.file, OLD);
  h.bg(); fs.writeFileSync(h.file, link + baseline.slice(link.length));
  const changed = new Date(Date.now() + 2000);
  fs.utimesSync(h.file, changed, changed);
  h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
  assert.equal(h.killed, 0);
});

test('completing a link already partial at spawn never authorizes a handoff', t => {
  const h = fixture(t);
  fs.writeFileSync(h.file, link.slice(0, -20));
  h.entry.continuationSnapshot = transitions.snapshotContinuations(h.file, OLD);
  h.bg(); fs.appendFileSync(h.file, link.slice(-20)); h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
});

test('large pre-spawn snapshots yield between chunks and retain historical ids and byte offset', async t => {
  const h = fixture(t, { old: true });
  fs.appendFileSync(h.file, (JSON.stringify({ type: 'assistant', message: 'x'.repeat(1000) }) + '\n').repeat(2200));
  const result = transitions.snapshotContinuationsBeforeSpawn
    ? transitions.snapshotContinuationsBeforeSpawn(h.file, OLD)
    : Promise.resolve(transitions.snapshotContinuations(h.file, OLD));
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const snapshot = await result;
  assert.equal(yielded, true);
  assert.equal(snapshot.bytes, fs.statSync(h.file).size);
  assert.deepEqual(snapshot.ids, [HEAD]);
});

test('an old continuation exits immediately through shipped PTY wiring', t => {
  const h = fixture(t, { old: true });
  const messages = [], ended = [], dead = [];
  let exit;
  const context = vm.createContext({ TRACE: { on: false }, ptyGenerationCounter: 0, ptyExitSignalName: () => null,
    shutdownMcpServer() {}, mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } },
    appQuitting: false, activeSessions: h.activeSessions, exitedRemoteSessionIds: new Set(),
    activityReporter: { sessionEnded: id => ended.push(id) }, taskRecords: { ownerDied: id => dead.push(id) },
    writer: { releaseLiveSession: async () => false }, notifyRendererProjectsChanged() {}, log: { warn() {} },
    holdBackgroundExit: () => false, sessionTransitions: transitions });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.entry, OLD, Object.assign(h.entry.pty, { statusTreeExit: Promise.resolve(null), onData() {}, onExit: fn => { exit = fn; } }));
  exit({ exitCode: 0 });
  assert.equal(messages[0]?.[0], 'process-exited');
  assert.equal(h.activeSessions.has(OLD), false);
  assert.deepEqual(dead, [OLD]);
  assert.ok(ended.includes(OLD));
});

test('a fresh authorized link holds the shipped PTY exit until late daemon proof rekeys the tab', t => {
  const h = fixture(t);
  h.bg(); h.append(); h.setProof(null); h.setJobExists(false);
  const messages = [], ended = [], dead = [];
  let exit;
  const context = vm.createContext({ TRACE: { on: false }, ptyGenerationCounter: 0, ptyExitSignalName: () => null,
    shutdownMcpServer() {}, mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } },
    appQuitting: false, activeSessions: h.activeSessions, exitedRemoteSessionIds: new Set(),
    activityReporter: { sessionEnded: id => ended.push(id) }, taskRecords: { ownerDied: id => dead.push(id) },
    writer: { releaseLiveSession: async () => false }, notifyRendererProjectsChanged() {}, log: { warn() {} },
    holdBackgroundExit: () => false, sessionTransitions: transitions });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.entry, OLD, Object.assign(h.entry.pty, { statusTreeExit: Promise.resolve(null), onData() {}, onExit: fn => { exit = fn; } }));
  const environment = { shell: '/saved/shell' };
  h.entry.environment = environment;
  const rekeyed = [];
  h.setReceiver((from, to) => rekeyed.push({ from, to, session: h.activeSessions.get(to), environment: h.activeSessions.get(to)?.environment }));
  exit({ exitCode: 0 });
  assert.equal(h.activeSessions.get(OLD), h.entry);
  assert.equal(messages.length, 0);
  assert.deepEqual(dead, []);
  assert.deepEqual(ended, []);
  assert.equal(h.timers.find(timer => timer.ms === 15000)?.ms, 15000);
  h.setProof({ sessionId: HEAD, kind: 'bg', jobId: '1234abcd' });
  h.detect();
  assert.equal(h.activeSessions.has(HEAD), false);
  h.setJobExists(true);
  transitions.detectPendingBackgroundContinuations();
  assert.equal(h.activeSessions.has(OLD), false);
  assert.deepEqual(rekeyed, [{ from: OLD, to: HEAD, session: h.entry, environment }]);
  assert.equal(h.entry.environment, environment);
  assert.equal(h.entry._continuationExit, undefined);
  assert.equal(messages.length, 0);
  assert.deepEqual(dead, []);
});

for (const [name, input] of [
  ['optional arguments', '/bg task-name\r'],
  ['slash menu completion and optional arguments', '/bg\t task-name\r'],
]) {
  test(`a submitted /bg with ${name} authorizes this tab's fresh continuation`, t => {
    const h = fixture(t);
    handleTerminalInput(h.activeSessions, OLD, input, Date.now());
    assert.equal(h.entry.backgroundCommandSource, OLD);
    h.append(); h.detect();
    assert.equal(h.activeSessions.get(HEAD), h.entry);
  });
}

for (const input of ['/bg-other\r', 'please run /bg\r', '/bg/other\r', '/bg\x7f\r']) {
  test(`a non-background submission ${JSON.stringify(input)} cannot authorize a handoff`, t => {
    const h = fixture(t);
    handleTerminalInput(h.activeSessions, OLD, input, Date.now());
    h.append(); h.detect();
    assert.equal(h.activeSessions.get(OLD), h.entry);
    assert.equal(h.events.length, 0);
  });
}

test('an authorized fresh link without a cached job holds for at most fifteen seconds', t => {
  const h = fixture(t);
  h.bg(); h.append(); h.setJobExists(false); h.entry.exited = true;
  const finished = [];
  assert.equal(transitions.holdContinuationExit(OLD, h.entry, suppress => finished.push(suppress)), true);
  assert.equal(h.activeSessions.has(HEAD), false);
  assert.deepEqual(finished, []);
  h.timers.find(timer => timer.ms === 15000).fn();
  assert.deepEqual(finished, [false]);
  assert.equal(h.entry._continuationExit, undefined);
});

test('a live typed background continuation waits for the job as well as the descriptor before rekeying', t => {
  const h = fixture(t);
  h.bg(); h.append(); h.setJobExists(false); h.detect();
  assert.equal(h.activeSessions.get(OLD), h.entry);
  assert.equal(h.events.length, 0);
  h.setJobExists(true);
  transitions.detectPendingBackgroundContinuations();
  assert.equal(h.activeSessions.get(HEAD), h.entry);
});

test('held partial fresh tails use bounded recheck ticks', t => {
  const h = fixture(t);
  h.bg(); h.append(); fs.appendFileSync(h.file, '{"type":"assistant"');
  h.entry.exited = true;
  assert.equal(transitions.holdContinuationExit(OLD, h.entry, () => {}), true);
  let elapsed = 0, ticks = 0;
  while (elapsed < 15000 && ticks < 100) {
    const i = h.timers.findIndex(timer => timer.ms < 15000);
    if (i < 0) break;
    const timer = h.timers.splice(i, 1)[0];
    elapsed += timer.ms; ticks++; timer.fn();
  }
  assert.ok(ticks <= 60, `recheck ticks=${ticks}`);
  assert.ok(elapsed >= 15000);
});

test('status/job notifications reconsider only fresh unresolved continuations without subagent scans', t => {
  const h = fixture(t);
  h.bg(); h.append(); h.setProof(null); h.detect();
  h.entry.knownSubagents = new Map();
  fs.mkdirSync(path.join(path.dirname(h.file), OLD, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(h.file), OLD, 'subagents', 'agent-child.jsonl'), JSON.stringify({ type: 'user', message: { content: 'child' } }) + '\n');
  h.setProof({ sessionId: HEAD, kind: 'bg', jobId: '1234abcd' });
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('bgAgents.onJobsChanged(() => {');
  const end = source.indexOf('\n});', start) + 4;
  vm.runInNewContext(source.slice(start, end), { bgAgents: { onJobsChanged: cb => cb() }, activeSessions: h.activeSessions,
    detectSessionTransitions: transitions.detectSessionTransitions, sessionTransitions: transitions });
  assert.equal(h.activeSessions.get(HEAD), h.entry);
  assert.equal(h.events.filter(e => e[0] === 'subagent-spawned').length, 0);
});

test('typed /bg, altscreen off, collision daemon fork and attach row produce one original named bg row', t => {
  const h = fixture(t);
  const renderer = setupTerminalDom();
  t.after(renderer.destroy);
  const w = renderer.window;
  w.api.onSessionForked = callback => h.setReceiver(callback);
  w.loadProjects = () => Promise.resolve(); w.pollActiveSessions = () => {};
  w.schedulePersistWorkingSet = () => {}; w.rekeyActivityState = () => {}; w.showRestoreNotice = () => {};
  w.setActiveSession = id => { w.activeSessionId = id; };
  w.terminalHeaderId = w.document.createElement('span'); w.terminalHeaderName = w.document.createElement('span');
  w.pendingSessions = new Map();
  loadAppFunctions(renderer.context, {
    declarations: ['exitHandoffs', 'lastActivityTime', 'sandboxedSessions', 'ptyGenerations', 'pendingOpens', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'openingSessions'],
    functions: ['markExitBackground', 'rekeySessionTab', 'rekeySessionEnvironment', 'attachBackgroundContinuation', 'beginPtyOpen', 'settlePtyOpen', 'handleProcessExited'],
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('window.api.onSessionForked(');
  renderer.inCtx(source.slice(start, source.indexOf('\n});', start) + 4));
  const original = { sessionId: OLD, name: 'Original', projectPath: h.root, modified: new Date().toISOString() };
  w.sessionMap.set(OLD, original);
  const terminal = w.createTerminalEntry(original);
  w.activeSessionId = OLD; w.activePtyIds.add(OLD);
  let output;
  const context = vm.createContext({ activeSessions: h.activeSessions, TRACE: { on: false }, ptyGenerationCounter: 0, log: { info() {} },
    cancellationIn: require('../src/main/bg-agents/bg-handoff').cancellationIn,
    mainWindow: null, appendToOutputBuffer() {}, MAX_BUFFER_SIZE: 1024 });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.entry, OLD, Object.assign(h.entry.pty, { onData: fn => { output = fn; }, onExit() {} }));
  h.bg(); output('\x1b[?1049l'); assert.equal(h.entry.altScreen, false);
  h.append(); h.detect();
  assert.equal(h.activeSessions.get(HEAD), h.entry);
  assert.equal(w.openSessions.get(HEAD), terminal);
  assert.equal(w.openSessions.has(OLD), false);
  assert.equal(h.events[0]?.[3], 'background');
  const row = { sessionId: OLD, folder: encodeProjectPath(h.root), name: 'Original', customTitle: 'Original', projectPath: h.root, messageCount: 1,
    continuationIndex: JSON.stringify({ format: 3, complete: true, ids: [HEAD] }) };
  const attach = { sessionId: HEAD, folder: encodeProjectPath(h.root), name: 'Original (2)', projectPath: h.root, messageCount: 0 };
  const projects = [{ projectPath: h.root, sessions: [row, attach] }];
  mergeLocalBackgroundSessions(projects, [row, attach], [{ sessionId: HEAD, kind: 'bg', jobId: '1234abcd', cwd: h.root, nameSource: 'collision' }],
    { hiddenProjects: new Set(), metaMap: new Map(), showArchived: true,
      jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
  assert.equal(projects[0].sessions.length, 1);
  assert.equal(row.sessionId, HEAD);
  assert.equal(row.bgSessionId, HEAD);
  assert.equal(row.name, 'Original');
  const sidebar = setupSidebarDom();
  t.after(sidebar.destroy);
  sidebar.sidebar.renderProjects(projects, false);
  assert.equal(sidebar.document.querySelectorAll('.session-item').length, 1);
  assert.equal(sidebar.document.querySelector(`[data-session-id="${HEAD}"] .bg-badge`)?.textContent, 'bg');
  assert.match(sidebar.document.querySelector(`[data-session-id="${HEAD}"]`).textContent, /Original/);
  assert.doesNotMatch(sidebar.document.body.textContent, /Original \(2\)/);
});





test('a named background job keeps its user name over the conversation title', () => {
  const context = vm.createContext({ sessionMap: new Map([[HEAD, { aiTitle: 'Transcript title' }]]) });
  const { agentDisplayName } = loadAppFunctions(context, { functions: ['agentDisplayName'], sourcePath: path.join(__dirname, '../public/agents-view.js') });
  assert.equal(agentDisplayName({ sessionId: HEAD, nameSource: 'user', name: 'Named job' }), 'Named job');
  assert.equal(agentDisplayName({ sessionId: HEAD, nameSource: 'collision', name: 'Named job (2)' }), 'Transcript title');
  context.sessionMap.get(HEAD).mergedMemberIds = [OLD];
  context.sessionMap.get(HEAD).bgSessionId = HEAD;
  assert.equal(agentDisplayName({ sessionId: HEAD, nameSource: 'user', name: 'Named job' }), 'Transcript title');
});
