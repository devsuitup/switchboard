'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const transitions = require('../session-transitions');
const { handleTerminalInput } = require('../terminal-input');
const { createComposerState } = require('../composer-state');
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
  const context = vm.createContext({ TRACE: { on: false }, ptyGenerationCounter: 0, log: { info() {} },
    cancellationIn: require('../bg-handoff').cancellationIn,
    mainWindow: null, appendToOutputBuffer() {}, MAX_BUFFER_SIZE: 1024 });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.entry, OLD, { onData: fn => { output = fn; }, onExit() {} });
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
    sessionCache: { releaseLiveSession: () => false }, notifyRendererProjectsChanged() {}, log: { warn() {} },
    holdBackgroundExit: () => false, sessionTransitions: transitions });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.entry, OLD, { onData() {}, onExit: fn => { exit = fn; } });
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
    sessionCache: { releaseLiveSession: () => false }, notifyRendererProjectsChanged() {}, log: { warn() {} },
    holdBackgroundExit: () => false, sessionTransitions: transitions });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.entry, OLD, { onData() {}, onExit: fn => { exit = fn; } });
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
    declarations: ['lastActivityTime', 'sandboxedSessions', 'ptyGenerations', 'pendingOpens', 'skippedWorkingSetEntries', 'restoreSavedIndex', 'openingSessions'],
    functions: ['rekeySessionEnvironment', 'attachBackgroundContinuation', 'beginPtyOpen', 'settlePtyOpen', 'handleProcessExited'],
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('window.api.onSessionForked(');
  renderer.inCtx(source.slice(start, source.indexOf('\n});', start) + 4));
  const original = { sessionId: OLD, name: 'Original', projectPath: h.root, modified: new Date().toISOString() };
  w.sessionMap.set(OLD, original);
  const terminal = w.createTerminalEntry(original);
  w.activeSessionId = OLD; w.activePtyIds.add(OLD);
  let output;
  const context = vm.createContext({ TRACE: { on: false }, ptyGenerationCounter: 0, log: { info() {} },
    cancellationIn: require('../bg-handoff').cancellationIn,
    mainWindow: null, appendToOutputBuffer() {}, MAX_BUFFER_SIZE: 1024 });
  const { wireSessionPty } = loadAppFunctions(context, { functions: ['wireSessionPty'], sourcePath: path.join(__dirname, '../main.js') });
  wireSessionPty(h.entry, OLD, { onData: fn => { output = fn; }, onExit() {} });
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

for (const version of [9, 42]) test(`metadata revision index preserves db_version ${version} and cached sessions`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641d-revisions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    assert.equal(db.getSetting('db_version'), 9);
    db.setName('old', 'User rename'); db.setName('head', 'Indexed title', 'transcript');
    db.upsertCachedSessions([{ sessionId: 'cached', folder: 'project', summary: 'Keep me' }]);
    db.setFolderMeta('project', '/project', 123);
    db.setInitialScanComplete();
    db.closeDb();
    const sql = new (require('better-sqlite3'))(require('node:path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
    for (const index of sql.prepare('PRAGMA index_list(session_meta_fields)').all()) {
      if (index.origin === 'c') sql.exec('DROP INDEX "' + index.name + '"');
    }
    sql.prepare("UPDATE settings SET value = ? WHERE key = 'db_version'").run(String(${version}));
    sql.close();
    delete require.cache[require.resolve('./test/fixtures/writer-store.cjs')];
    const reopened = require('./test/fixtures/writer-store.cjs');
    assert.equal(reopened.getSetting('db_version'), ${version});
    const inspect = new (require('better-sqlite3'))(reopened.DB_PATH);
    const plan = inspect.prepare('EXPLAIN QUERY PLAN SELECT MAX(revision) FROM session_meta_fields').all();
    assert.match(plan.map(row => row.detail).join(' '), /USING COVERING INDEX idx_session_meta_fields_revision/);
    assert.equal(reopened.getCachedSession('cached').summary, 'Keep me');
    assert.equal(reopened.getFolderMeta('project').indexMtimeMs, 123);
    assert.equal(reopened.isInitialScanComplete(), true);
    reopened.setName('old', 'Newest rename');
    const revisions = inspect.prepare("SELECT sessionId, revision FROM session_meta_fields WHERE field = 'name'").all();
    assert.ok(revisions.find(row => row.sessionId === 'old').revision > revisions.find(row => row.sessionId === 'head').revision);
    reopened.rekeySessionMeta('old', 'head');
    assert.equal(reopened.getMeta('head').name, 'Newest rename');
    inspect.close(); reopened.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('SQLite continuation copies metadata, avoids title names and keeps the newest value per field', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    db.setName('old', 'original'); db.toggleStar('old'); db.setArchived('old', true);
    db.setName('new', 'newer'); db.setArchived('new', false);
    db.rekeySessionMeta('old', 'new', 'title');
    assert.equal(db.getMeta('old').name, 'original');
    assert.deepEqual(db.getMeta('new'), { sessionId: 'new', name: 'newer', starred: 1, archived: 0 });
    db.setName('old', 'latest'); db.toggleStar('new');
    db.rekeySessionMeta('old', 'new');
    assert.deepEqual(db.getMeta('new'), { sessionId: 'new', name: 'latest', starred: 0, archived: 0 });
    db.rekeySessionMeta('absent', 'title-only', 'transcript title');
    assert.equal(db.getMeta('title-only')?.name ?? null, null);
    db.setName('transcript', 'transcript title', 'transcript');
    db.rekeySessionMeta('transcript', 'no-rename');
    assert.equal(db.getMeta('no-rename').name, null);
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
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

test('a newer indexed transcript title cannot defeat a genuine Switchboard rename', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-title-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    db.setName('old', 'Switchboard rename');
    db.setName('new', 'Original (2)', 'transcript');
    db.rekeySessionMeta('old', 'new', 'Original');
    assert.equal(db.getMeta('new').name, 'Switchboard rename');
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a legacy genuine rename retains its provenance across successive background continuations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    db.closeDb();
    const sql = new (require('better-sqlite3'))(require('node:path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
    sql.prepare('INSERT INTO session_meta(sessionId, name) VALUES (?, ?)').run('legacy', 'Legacy rename');
    sql.close();
    delete require.cache[require.resolve('./test/fixtures/writer-store.cjs')];
    const reopened = require('./test/fixtures/writer-store.cjs');
    reopened.setName('next', 'Original (2)', 'transcript');
    reopened.rekeySessionMeta('legacy', 'next', 'Original');
    assert.equal(reopened.getMeta('next').name, 'Legacy rename');
    reopened.rekeySessionMeta('next', 'third', 'Original');
    assert.equal(reopened.getMeta('third').name, 'Legacy rename');
    reopened.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a newer genuine head rename selected by SQLite also appears on the merged sidebar row', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-sidebar-meta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    const { mergeLocalBackgroundSessions } = require('./sidebar-bg-sessions');
    db.setName('${OLD}', 'Older Switchboard rename');
    db.setName('${HEAD}', 'Newer Switchboard rename');
    db.rekeySessionMeta('${OLD}', '${HEAD}', 'Original title');
    const row = { sessionId: '${OLD}', folder: '-project', name: 'Older Switchboard rename', customTitle: 'Original title',
      projectPath: '/project', continuationIndex: JSON.stringify({ format: 3, complete: true, ids: ['${HEAD}'] }) };
    const projects = [{ projectPath: '/project', sessions: [row] }];
    mergeLocalBackgroundSessions(projects, [row], [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(row.name, 'Newer Switchboard rename');
    assert.equal(projects[0].sessions.length, 1);
    assert.equal(db.getMeta('${OLD}').name, 'Older Switchboard rename');
    db.setName('${HEAD}', null);
    const cleared = { ...row, sessionId: '${OLD}', name: 'Older Switchboard rename', mergedMemberIds: [] };
    mergeLocalBackgroundSessions([{ projectPath: '/project', sessions: [cleared] }], [cleared],
      [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(cleared.name, 'Original title');
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a newer original rename survives indexed titles and older head renames before a tab rekey', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-641b-sidebar-title-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(require('electron'), ['-e', `
    const assert = require('node:assert/strict'), db = require('./test/fixtures/writer-store.cjs');
    const { mergeLocalBackgroundSessions } = require('./sidebar-bg-sessions');
    db.setName('${OLD}', 'Switchboard rename'); db.setName('${HEAD}', 'Original (2)', 'transcript');
    const row = { sessionId: '${OLD}', folder: '-project', name: 'Switchboard rename', customTitle: 'Original',
      projectPath: '/project', continuationIndex: JSON.stringify({ format: 3, complete: true, ids: ['${HEAD}'] }) };
    const projects = [{ projectPath: '/project', sessions: [row] }];
    mergeLocalBackgroundSessions(projects, [row], [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(row.name, 'Switchboard rename');
    db.setName('${HEAD}', 'Older head rename'); db.setName('${OLD}', 'Newest original rename');
    const newerOriginal = { ...row, sessionId: '${OLD}', name: 'Newest original rename', mergedMemberIds: [] };
    const nextProjects = [{ projectPath: '/project', sessions: [newerOriginal] }];
    mergeLocalBackgroundSessions(nextProjects, [newerOriginal], [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(newerOriginal.name, 'Newest original rename');
    db.setName('${OLD}', null);
    const cleared = { ...newerOriginal, sessionId: '${OLD}', name: 'Original', mergedMemberIds: [] };
    mergeLocalBackgroundSessions([{ projectPath: '/project', sessions: [cleared] }], [cleared],
      [{ sessionId: '${HEAD}', kind: 'bg', jobId: '1234abcd', cwd: '/project', nameSource: 'collision' }],
      { hiddenProjects: new Set(), metaMap: db.getAllMeta(true), showArchived: true,
        jobs: new Map([['1234abcd', { state: 'working', nameSource: 'collision' }]]) });
    assert.equal(cleared.name, 'Original');
    db.closeDb();
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: root } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
