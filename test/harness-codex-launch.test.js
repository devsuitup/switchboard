'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const codex = require('../harnesses/codex');
const { getHarness } = require('../harnesses');

const ID = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';
const NAME = `rollout-2026-08-26T11-55-02-${ID}.jsonl`;
const FORCED_CONFIG = /^tui\.(notifications|notification_method|notification_condition|terminal_title)=/;

function argsWithoutForcedConfig(over) {
  const args = codex.buildLaunchArgs(over);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && FORCED_CONFIG.test(args[i + 1] || '')) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

function withFixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-'));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
    return fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function rolloutHead(meta) {
  return JSON.stringify({ timestamp: '2026-08-26T10:00:00.000Z', type: 'session_meta', payload: { id: 'root', cwd: '/Users/me/proj', ...meta } }) + '\n'
    + JSON.stringify({ timestamp: '2026-08-26T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n';
}

test('codex argv: resume, fork and fresh launches, with the forced tui overrides', () => {
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: {} }), ['resume', ID]);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: 'new', isNew: true, options: { forkFrom: ID } }), ['fork', ID]);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: true, options: {} }), []);
  const forced = codex.buildLaunchArgs({ sessionId: ID, isNew: true, options: {} });
  assert.deepEqual(forced, ['-c', 'tui.notifications=true', '-c', 'tui.notification_method="osc9"',
    '-c', 'tui.notification_condition="always"', '-c', 'tui.terminal_title=["activity","project-name"]']);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: true, options: { initialPrompt: 'start here' } }), ['start here']);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: true, options: { forkFrom: ID, initialPrompt: 'ignored' } }), ['fork', ID]);
});

test('codex argv: Claude-only options are ignored, enumerated values are validated, add-dir is gated', () => {
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false,
    options: { permissionMode: 'plan', worktree: true, worktreeName: 'wt', chrome: true, appendSystemPrompt: 'hi', mcpEmulation: true, browserMode: 'claude-in-chrome' } }), ['resume', ID]);
  for (const bad of ['--dangerously-bypass-approvals-and-sandbox', 'full-access', '', null, 'x; rm -rf /']) {
    assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: { codexSandbox: bad, codexApproval: bad } }), ['resume', ID], String(bad));
  }
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: { codexSandbox: 'workspace-write', codexApproval: 'never' } }),
    ['resume', ID, '--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: { dangerouslySkipPermissions: true, codexSandbox: 'read-only', codexApproval: 'never' } }),
    ['resume', ID, '--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: { codexSandbox: 'workspace-write', addDirs: ' /one , , /two ' } }),
    ['resume', ID, '--sandbox', 'workspace-write', '--add-dir', '/one', '--add-dir', '/two']);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: { addDirs: '/one' } }), ['resume', ID]);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: { codexSandbox: 'read-only', addDirs: '/one' } }), ['resume', ID, '--sandbox', 'read-only']);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: true, options: { codexModel: 'gpt-5.5', codexEffort: 'high' } }),
    ['--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: true, options: { codexEffort: 'high" model="x' } }), []);
  const KNOWN = new Set(['--sandbox', '--ask-for-approval', '--model', '--add-dir', '--dangerously-bypass-approvals-and-sandbox']);
  for (const a of codex.buildLaunchArgs({ sessionId: ID, isNew: false, options: { codexSandbox: 'read-only', codexApproval: 'on-request', codexModel: 'gpt-5', addDirs: '/x' } })) {
    if (a.startsWith('--')) assert.ok(KNOWN.has(a), `unknown flag ${a}`);
  }
});

const TAG = () => codex.originatorTag('3f0c8a1e-1111-4222-8333-444455556666');
function signals(over = {}) {
  return { sessionId: ID, originator: TAG(), cwd: '/Users/me/proj', forkedFrom: null, startedAt: '2026-08-26T10:00:00.000Z', isSubagent: false, ...over };
}
const AT = Date.parse('2026-08-26T10:00:00.000Z');

test('the originator tag is header-safe and the launch env carries it', () => {
  assert.match(TAG(), /^switchboard_[a-z0-9]+$/);
  assert.equal(codex.launchEnv('a-b-c').CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'switchboard_abc');
  assert.equal(codex.needsIdDetection({ isNew: true }), true);
  assert.equal(codex.needsIdDetection({ isNew: false }), false);
});

test('matchesLaunch grades a match: the exact tag, or cwd+time for a fresh launch; a fork takes its own tag only; a foreign tag is refused', () => {
  const base = { tag: TAG(), projectPath: '/Users/me/proj', spawnedAt: AT };
  assert.equal(codex.matchesLaunch(signals(), { tag: TAG(), projectPath: '/elsewhere', spawnedAt: AT + 60000 }), 'tag');
  assert.equal(codex.matchesLaunch(signals({ originator: 'switchboard_someoneelse' }), base), false);
  assert.equal(codex.matchesLaunch(signals({ originator: 'codex_cli_rs' }), base), 'cwd');
  assert.equal(codex.matchesLaunch(signals({ originator: 'x', cwd: '/other' }), base), false);
  assert.equal(codex.matchesLaunch(signals({ originator: 'x', startedAt: '2026-08-26T09:00:00.000Z' }), base), false);
  assert.equal(codex.matchesLaunch(signals({ originator: 'x', startedAt: '2026-08-26T09:59:58.000Z' }), base), 'cwd');
  assert.equal(codex.matchesLaunch(signals({ isSubagent: true }), base), false);
  assert.equal(codex.matchesLaunch(null, base), false);
  assert.equal(codex.matchesLaunch(signals({ sessionId: null }), base), false);
  assert.equal(codex.matchesLaunch(signals({ originator: 'x', startedAt: null }), base), false);
  const fork = { ...base, forkFrom: 'parent-id' };
  assert.equal(codex.matchesLaunch(signals({ forkedFrom: 'parent-id', originator: 'switchboard_parentslaunch' }), fork), false, 'forked_from_id plus start time is never fork evidence');
  assert.equal(codex.matchesLaunch(signals({ forkedFrom: 'parent-id', originator: 'codex_cli_rs' }), fork), false);
  assert.equal(codex.matchesLaunch(signals({ forkedFrom: 'parent-id', originator: TAG() }), fork), 'tag');
  assert.equal(codex.matchesLaunch(signals({ forkedFrom: 'other', originator: TAG() }), fork), 'tag', 'the launch\'s own tag is authoritative');
  assert.equal(codex.matchesLaunch(signals({ forkedFrom: 'other', originator: 'switchboard_parentslaunch' }), fork), false);
  assert.equal(codex.matchesLaunch(signals({ forkedFrom: 'parent-id', originator: 'switchboard_parentslaunch', startedAt: '2026-08-26T09:00:00.000Z' }), fork), false);
});

test('readLaunchSignals reads only the rollout head and yields nothing for a half-written one', () => {
  withFixture({ [NAME]: rolloutHead({ originator: TAG(), timestamp: '2026-08-26T10:00:00.000Z', forked_from_id: 'parent' }) }, dir => {
    const s = codex.readLaunchSignals(path.join(dir, NAME));
    assert.deepEqual(s, { sessionId: ID, originator: TAG(), forkedFrom: 'parent', cwd: '/Users/me/proj', startedAt: '2026-08-26T10:00:00.000Z', isSubagent: false });
  });
  withFixture({ [NAME]: '{"type":"session_meta","payload":{"cwd":"/Users' }, dir => assert.equal(codex.readLaunchSignals(path.join(dir, NAME)), null));
  withFixture({ [NAME]: '' }, dir => assert.equal(codex.readLaunchSignals(path.join(dir, NAME)), null));
  withFixture({ [NAME]: '{"type":"event_msg","payload":{"type":"task_started"}}\n' }, dir => assert.equal(codex.readLaunchSignals(path.join(dir, NAME)), null));
  assert.equal(codex.readLaunchSignals('/definitely/not/here.jsonl'), null);
});

test('the shell command names the harness binary', () => {
  const { claudeCommand } = require('../src/main/terminals/shell-profiles');
  assert.equal(claudeCommand('/bin/bash', ['resume', ID], { windows: false, binary: 'codex' }), `codex 'resume' '${ID}'`);
  assert.equal(claudeCommand('/bin/bash', ['--resume', ID], { windows: false }), `claude '--resume' '${ID}'`);
  assert.match(claudeCommand('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['resume', ID], { windows: true, binary: 'codex' }), /codex/);
  assert.doesNotMatch(claudeCommand('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['resume', ID], { windows: true, binary: 'codex' }), /claude/);
});

function launchBlock(context) {
  const filename = path.join(__dirname, '../main.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('const claudeArgs = []', source.indexOf("ipcMain.handle('open-terminal'"));
  const end = source.indexOf('if (launchSandbox && process.platform', start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.result = { claudeArgs, launchMode };', context, { filename });
  return { claudeArgs: Array.from(context.result.claudeArgs), launchMode: context.result.launchMode };
}

test('open-terminal resumes a cached Codex row with codex argv and starts fresh when its rollout is gone', () => {
  const codexRow = { sessionId: ID, runtime: 'codex', sessionFile: path.join(os.tmpdir(), 'nowhere', NAME), projectPath: '/p' };
  const base = {
    sessionId: ID, isNew: false, sessionOptions: Object.freeze({ permissionMode: 'plan' }), spawnCwd: '/p', isAttach: false,
    PROJECTS_DIR: '/unused', sessionTranscriptExists: () => { throw new Error('Claude lookup must not run for a Codex row'); },
    triggerPermit: null, launchMode: null, isGitRepo: () => true, log: { info() {}, warn() {} }, fs,
    getHarness, launchHarness: getHarness('codex'), cachedRow: codexRow,
  };
  withFixture({ [NAME]: rolloutHead({}) }, dir => {
    const present = { ...base, cachedRow: { ...codexRow, sessionFile: path.join(dir, NAME) } };
    const result = launchBlock(present);
    assert.deepEqual(result.claudeArgs.slice(0, 2), ['resume', ID]);
    assert.equal(result.launchMode, 'resume');
  });
  const gone = launchBlock({ ...base });
  assert.equal(gone.launchMode, 'new', 'a row whose rollout vanished starts fresh');
  assert.ok(!gone.claudeArgs.includes('resume'));
  const claude = launchBlock({ ...base, launchHarness: getHarness('claude'), cachedRow: { sessionId: ID }, sessionTranscriptExists: () => true });
  assert.deepEqual(claude.claudeArgs, ['--resume', ID, '--permission-mode', 'plan']);
});

test('a pending Codex launch is re-keyed onto its rollout through the fork re-key path', async t => {
  const transitions = require('../session-transitions');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rekey-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    transitions.init({ activeSessions: new Map() });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const day = path.join(home, 'sessions', '2026', '08', '26');
  fs.mkdirSync(day, { recursive: true });
  const activeSessions = new Map(), events = [], migrated = [], metadata = [];
  transitions.init({ PROJECTS_DIR: path.join(home, 'projects'), activeSessions, log: { info() {}, warn() {}, debug() {}, error() {} },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
    rekeyMcpServer: (...args) => migrated.push(['mcp', ...args]), rekeyActivity: (...args) => migrated.push(['activity', ...args]),
    rekeyMetadata: (...args) => { metadata.push(args); }, setTimeout: () => ({ unref() {} }) });
  const tempId = '3f0c8a1e-1111-4222-8333-444455556666';
  const spawnedAt = Date.parse('2026-08-26T09:59:59.000Z');
  const session = { pty: { pid: 7 }, exited: false, runtime: 'codex', projectFolder: null, knownJsonlFiles: null,
    pendingLaunch: { tag: codex.originatorTag(tempId), forkFrom: null, projectPath: '/Users/me/proj', spawnedAt }, generation: 1 };
  activeSessions.set(tempId, session);
  const other = `rollout-2026-08-26T11-50-00-${ID.replace(/c$/, 'e')}.jsonl`;
  fs.writeFileSync(path.join(day, other), rolloutHead({ originator: 'switchboard_notus', timestamp: '2026-08-26T10:00:00.000Z' }));
  assert.equal(transitions.hasPendingLaunches(), true);
  assert.equal(transitions.resolvePendingLaunches(codex, [path.join(day, other)]), 0, 'a rollout tagged for another launch is never adopted');
  fs.writeFileSync(path.join(day, NAME), rolloutHead({ originator: codex.originatorTag(tempId), timestamp: '2026-08-26T10:00:00.000Z' }));
  assert.equal(transitions.sweepPendingLaunches(), 1);
  assert.equal(activeSessions.has(tempId), false);
  assert.equal(activeSessions.get(ID), session);
  assert.equal(session.realSessionId, ID);
  assert.equal(session.pendingLaunch, null);
  assert.deepEqual(metadata, [[tempId, ID, 'new']]);
  assert.deepEqual(events, [['session-forked', tempId, ID, 'new']]);
  assert.deepEqual(migrated.map(m => m[0]).sort(), ['activity', 'mcp']);
  assert.equal(transitions.hasPendingLaunches(), false);
  assert.equal(transitions.sweepPendingLaunches(), 0);
});

function pendingForkFixture(t) {
  const transitions = require('../session-transitions');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-forks-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    transitions.init({ activeSessions: new Map() });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const day = path.join(home, 'sessions', '2026', '08', '26');
  fs.mkdirSync(day, { recursive: true });
  const activeSessions = new Map(), events = [];
  transitions.init({ PROJECTS_DIR: path.join(home, 'projects'), activeSessions, log: { info() {}, warn() {}, debug() {}, error() {} },
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => events.push(args) } }),
    rekeyMcpServer() {}, rekeyActivity() {}, rekeyMetadata() {}, setTimeout: () => ({ unref() {} }) });
  const spawnedAt = Date.parse('2026-08-26T09:59:59.000Z');
  const pend = tempId => {
    const session = { pty: { pid: 7 }, exited: false, runtime: 'codex', projectFolder: null, knownJsonlFiles: null, generation: 1,
      pendingLaunch: { tag: codex.originatorTag(tempId), forkFrom: 'parent-id', projectPath: '/Users/me/proj', spawnedAt } };
    activeSessions.set(tempId, session);
    return session;
  };
  const rollout = (suffix, meta) => {
    const id = ID.slice(0, -1) + suffix;
    const file = path.join(day, `rollout-2026-08-26T11-55-0${suffix}-${id}.jsonl`);
    fs.writeFileSync(file, rolloutHead({ forked_from_id: 'parent-id', timestamp: '2026-08-26T10:00:00.000Z', ...meta }));
    return { id, file };
  };
  return { transitions, activeSessions, events, pend, rollout };
}

const TEMP_A = '3f0c8a1e-aaaa-4222-8333-444455556666';
const TEMP_B = '3f0c8a1e-bbbb-4222-8333-444455556666';

test('two pending forks of one parent: a rollout tagged for one fork is adopted by that fork, never by the other', t => {
  const f = pendingForkFixture(t);
  const a = f.pend(TEMP_A), b = f.pend(TEMP_B);
  const forB = f.rollout('1', { originator: codex.originatorTag(TEMP_B) });
  assert.equal(f.transitions.resolvePendingLaunches(codex, [forB.file]), 1);
  assert.equal(f.activeSessions.get(forB.id), b, 'the rollout carrying the second fork\'s tag belongs to the second fork');
  assert.equal(f.activeSessions.get(TEMP_A), a, 'the first fork is still waiting');
  assert.ok(a.pendingLaunch);
  assert.deepEqual(f.events, [['session-forked', TEMP_B, forB.id, 'fork']]);
  const inherited = f.rollout('2', { originator: 'switchboard_parentslaunch' });
  assert.equal(f.transitions.resolvePendingLaunches(codex, [forB.file, inherited.file]), 0, 'the lone remaining fork does not take the lone remaining same-parent rollout: untagged, it stays pending');
  assert.equal(f.activeSessions.get(TEMP_A), a);
  assert.equal(f.transitions.hasPendingLaunches(), true);
  const forA = f.rollout('3', { originator: codex.originatorTag(TEMP_A) });
  assert.equal(f.transitions.resolvePendingLaunches(codex, [forB.file, inherited.file, forA.file]), 1);
  assert.equal(f.activeSessions.get(forA.id), a);
  assert.equal(f.transitions.hasPendingLaunches(), false);
});

test('two pending forks of one parent and only inherited tags: nothing is re-keyed while the pairing is ambiguous', t => {
  const f = pendingForkFixture(t);
  const a = f.pend(TEMP_A), b = f.pend(TEMP_B);
  const first = f.rollout('1', { originator: 'switchboard_parentslaunch' });
  assert.equal(f.transitions.resolvePendingLaunches(codex, [first.file]), 0, 'one rollout, two candidate forks: no guess');
  const second = f.rollout('2', { originator: 'switchboard_parentslaunch' });
  assert.equal(f.transitions.resolvePendingLaunches(codex, [first.file, second.file]), 0, 'two rollouts, two forks: still no guess');
  assert.equal(f.transitions.sweepPendingLaunches(), 0);
  assert.equal(f.activeSessions.get(TEMP_A), a);
  assert.equal(f.activeSessions.get(TEMP_B), b);
  assert.deepEqual(f.events, []);
  b.exited = true;
  assert.equal(f.transitions.resolvePendingLaunches(codex, [first.file, second.file]), 0, 'one fork, two rollouts: no guess either');
  fs.rmSync(second.file);
  assert.equal(f.transitions.sweepPendingLaunches(), 0, 'a rollout once ambiguous between two forks is never re-keyed');
  assert.equal(f.activeSessions.get(TEMP_A), a);
  assert.ok(a.pendingLaunch, 'the fork stays under its temporary id');
});
